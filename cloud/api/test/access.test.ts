import { describe, expect, it } from "vitest";
import { makeWorld, signIn, type World } from "./helpers";
import { DAY } from "../src/ctx";
import { TB, INDIVIDUAL_BYTES } from "../src/billing-catalog";

const json = async (r: Response): Promise<any> => r.json();

async function setup() {
	const w = await makeWorld();
	const s = await signIn(w);
	const access = async () => json(await w.call("/me/access", { token: s.accessToken }));
	const billing = async (id: string) => json(await w.call(`/orgs/${id}/billing`, { token: s.accessToken }));
	const orgs = async () => (await json(await w.call("/orgs", { token: s.accessToken }))).orgs;
	return { w, s, access, billing, orgs };
}

async function addOrg(w: World, userId: string, id: string, tier: string, trialEndsAt: number | null, pending: number, driveStatus: string | null) {
	await w.env.DB.batch([
		w.env.DB.prepare("INSERT INTO orgs(id,name,tier,trial_ends_at,created_at,trial_pending) VALUES(?,?,?,?,?,?)").bind(id, `Org ${id}`, tier, trialEndsAt, w.clock.t + 1, pending),
		w.env.DB.prepare("INSERT INTO memberships VALUES(?,?,?,?)").bind(id, userId, "member", w.clock.t),
		...(driveStatus ? [w.env.DB.prepare("INSERT INTO drives(id,org_id,name,placement,status,created_at) VALUES(?,?,?,?,?,?)").bind(`d-${id}`, id, "D", null, driveStatus, w.clock.t)] : []),
	]);
}

describe("GET /me/access", () => {
	it("uses staged/retained quota bytes instead of stale drive measurements in every account view and write grant", async () => {
		const {w,s,access,billing,orgs} = await setup();
		const org = (await orgs())[0];
		w.dp.quotaUsage = async (_org, lineages) => {
			expect(_org).toBe(org.id); expect(lineages).toContain(org.drives[0].id);
			return {usedBytes:INDIVIDUAL_BYTES+1};
		};
		expect((await access()).workspaces[0]).toMatchObject({usedBytes:INDIVIDUAL_BYTES+1,writable:false});
		expect(await billing(org.id)).toMatchObject({usedBytes:INDIVIDUAL_BYTES+1,writable:false});
		expect((await orgs())[0].usedBytes).toBe(INDIVIDUAL_BYTES+1);
		expect((await w.call(`/drives/${org.drives[0].id}/token`,{token:s.accessToken,json:{access:"write"}})).status).toBe(403);
		expect((await w.call(`/drives/${org.drives[0].id}/token`,{token:s.accessToken,json:{access:"read"}})).status).toBe(200);
		w.dp.quotaUsage = async () => {throw new Error("quota_initializing");};
		expect((await w.call("/me/access",{token:s.accessToken})).status).toBe(503);
		expect((await w.call(`/orgs/${org.id}/billing`,{token:s.accessToken})).status).toBe(503);
	});
	it("requires authentication", async () => {
		const { w } = await setup();
		expect((await w.call("/me/access")).status).toBe(401);
		expect((await w.call("/me/access", { method: "POST" })).status).toBe(401);
	});

	it("trial active", async () => {
		const { s, access, billing, orgs } = await setup();
		const a = await access();
		expect(a.user).toEqual({ id: s.user.id, email: "a@example.com" });
		const ws = a.workspaces[0];
		expect(ws).toMatchObject({ role: "owner", tier: "individual", state: "trial_active", trialPending: false, writable: true, storageReady: true, quotaBytes: INDIVIDUAL_BYTES, usedBytes: 0 });
		const b = await billing(ws.id);
		expect(ws).toMatchObject({ state: b.state, writable: b.writable, quotaBytes: b.quotaBytes, trialEndsAt: b.trialEndsAt, usedBytes: b.usedBytes });
		expect((await orgs())[0]).toMatchObject({ quotaBytes: ws.quotaBytes, usedBytes: ws.usedBytes });
	});

	it("trial pending when provisioning failed, not storage ready", async () => {
		const w = await makeWorld(); w.dp.failCreate = true;
		const s = await signIn(w);
		const a = await json(await w.call("/me/access", { token: s.accessToken }));
		expect(a.workspaces[0]).toMatchObject({ state: "provisioning", trialPending: true, trialEndsAt: null, writable: false, storageReady: false });
		const b = await json(await w.call(`/orgs/${a.workspaces[0].id}/billing`, { token: s.accessToken }));
		expect(b).toMatchObject({ state: "provisioning", writable: false });
	});

	it("paid uses billing seats and add-ons and authoritative retained usage including deleted drives", async () => {
		const { w, s, access, billing, orgs } = await setup();
		const id = (await access()).workspaces[0].id;
		const drive = (await orgs())[0].drives[0].id;
		await w.env.DB.batch([
			w.env.DB.prepare("INSERT INTO billing(org_id,customer_id,subscription_id,status,plan,cadence,seats,storage_addons,current_period_end,cancel_at_period_end,event_at,event_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, "c", "s", "active", "teams", "monthly", 3, 2, w.clock.t + 10 * DAY, 0, 1, "e"),
			w.env.DB.prepare("INSERT INTO drive_usage VALUES(?,?,?,?)").bind(drive, 900, 700, w.clock.t),
			w.env.DB.prepare("INSERT INTO drives(id,org_id,name,placement,status,created_at) VALUES('d-gone',?,?,?,?,?)").bind(id, "G", null, "deleted", w.clock.t),
			w.env.DB.prepare("INSERT INTO drive_usage VALUES('d-gone',50,50,?)").bind(w.clock.t),
		]);
		w.dp.stats.set(drive, 700);
		w.dp.stats.set("d-gone", 50);
		const ws = (await access()).workspaces[0];
		expect(ws).toMatchObject({ state: "paid", tier: "teams", writable: true, quotaBytes: 3 * TB + 2 * 500_000_000_000, usedBytes: 750 });
		const b = await billing(id);
		expect(ws).toMatchObject({ quotaBytes: b.quotaBytes, usedBytes: b.usedBytes, state: b.state, tier: b.plan });
		expect((await orgs())[0]).toMatchObject({ quotaBytes: ws.quotaBytes, usedBytes: 750 });
	});

	it("paid individual includes 500 GB plus purchased storage", async () => {
		const { w, access, billing } = await setup();
		const id = (await access()).workspaces[0].id;
		await w.env.DB.prepare("INSERT INTO billing(org_id,customer_id,subscription_id,status,plan,cadence,seats,storage_addons,current_period_end,cancel_at_period_end,event_at,event_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
			.bind(id, "c", "s", "active", "individual", "monthly", 1, 1, w.clock.t + DAY, 0, 1, "e").run();
		expect(await billing(id)).toMatchObject({ plan: "individual", quotaBytes: TB, state: "paid" });
	});

	it("expired", async () => {
		const { w, access, billing } = await setup();
		// Moving the clock would also expire the access token; end the trial in the past instead.
		await w.env.DB.prepare("UPDATE orgs SET trial_ends_at = ?").bind(w.clock.t - DAY).run();
		const ws = (await access()).workspaces[0];
		expect(ws).toMatchObject({ state: "expired", writable: false, trialPending: false, quotaBytes: INDIVIDUAL_BYTES });
		expect(ws.trialEndsAt).toBeLessThan(w.clock.t);
		expect(await billing(ws.id)).toMatchObject({ state: "expired", writable: false, quotaBytes: ws.quotaBytes, trialEndsAt: ws.trialEndsAt });
	});

	it("an over-quota trial is not writable, matching billing", async () => {
		const { w, access, billing, orgs } = await setup();
		const drive = (await orgs())[0].drives[0].id;
		await w.env.DB.prepare("INSERT INTO drive_usage VALUES(?,?,?,?)").bind(drive, 2 * TB, 2 * TB, w.clock.t).run();
		w.dp.stats.set(drive, 2 * TB);
		const ws = (await access()).workspaces[0];
		expect(ws).toMatchObject({ state: "trial_active", writable: false, overQuota: true, usedBytes: 2 * TB, quotaBytes: INDIVIDUAL_BYTES });
		expect(await billing(ws.id)).toMatchObject({ writable: false, overQuota: true, usedBytes: 2 * TB });
	});

	it("multiple orgs agree with entitlements, ignore other users, and storageReady is per org", async () => {
		const { w, s, access, billing } = await setup();
		const now = w.clock.t;
		await addOrg(w, s.user.id, "o-exp", "teams", now - DAY, 0, "provisioning_failed");
		await addOrg(w, s.user.id, "o-prov", "teams", null, 1, null);
		await addOrg(w, s.user.id, "o-paid", "teams", null, 0, "ready");
		await w.env.DB.prepare("INSERT INTO billing(org_id,customer_id,subscription_id,status,plan,cadence,seats,storage_addons,current_period_end,cancel_at_period_end,event_at,event_id) VALUES('o-paid','c','s','active','teams','annual',5,0,?,0,1,'e')").bind(now + DAY).run();
		const other = await signIn(w, "other@example.com");
		const a = await access();
		expect(a.workspaces.map((x: any) => x.id)).toHaveLength(4);
		const otherId = (await json(await w.call("/me/access", { token: other.accessToken }))).workspaces[0].id;
		expect(a.workspaces.some((x: any) => x.id === otherId)).toBe(false);
		const by = Object.fromEntries(a.workspaces.map((x: any) => [x.id, x]));
		expect(by["o-exp"]).toMatchObject({ state: "expired", storageReady: false, writable: false });
		expect(by["o-prov"]).toMatchObject({ state: "provisioning", storageReady: false, trialPending: true });
		expect(by["o-paid"]).toMatchObject({ state: "paid", storageReady: true, quotaBytes: 5 * TB });
		for (const ws of a.workspaces) {
			const b = await billing(ws.id);
			expect(ws).toMatchObject({ state: b.state, quotaBytes: b.quotaBytes, trialEndsAt: b.trialEndsAt, writable: b.writable });
		}
	});
});
