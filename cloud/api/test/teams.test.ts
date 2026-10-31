import { describe, expect, it } from "vitest";
import { makeWorld, signIn } from "./helpers";
const json = async (r: Response): Promise<any> => r.json();

async function fixture(seats = 3) {
	const w = await makeWorld();
	const owner = await signIn(w);
	const org = (await json(await w.call("/orgs", { token: owner.accessToken }))).orgs[0];
	await w.env.DB.prepare("INSERT INTO billing(org_id,status,plan,seats,current_period_end) VALUES(?,'active','teams',?,?)").bind(org.id, seats, w.clock.t + 30 * 86400000).run();
	const call = (path = "members", init: any = {}) => w.call(`/orgs/${org.id}/${path}`, { token: owner.accessToken, ...init });
	const invite = async (email: string, role = "member") => {
		const response = await call("invites", { json: { email, role } });
		const token = w.mail.sent.at(-1)?.text.match(/\/invites\/([A-Za-z0-9_-]+)/)?.[1];
		return { response, token };
	};
	return { w, owner, org, call, invite };
}

describe("teams", () => {
	it("exposes only configured web origin", async () => {
		const w = await makeWorld();
		expect(await json(await w.call("/client-config"))).toEqual({ webOrigin: w.env.ULS_WEB_ORIGIN });
	});
	it("delivers recipient-bound invitations and rejects replay, wrong account and expiry", async () => {
		const { w, org, invite, call } = await fixture();
		const recipient = await signIn(w, "b@example.com");
		const stranger = await signIn(w, "c@example.com");
		const { response, token } = await invite("b@example.com");
		expect(response.status).toBe(201);
		expect(JSON.stringify(await json(response))).not.toContain(token);
		expect((await w.call(`/invites/${token}/accept`, { json: {}, token: stranger.accessToken })).status).toBe(400);
		expect((await w.call(`/invites/${token}/accept`, { json: {}, token: recipient.accessToken })).status).toBe(200);
		expect((await w.call(`/invites/${token}/accept`, { json: {}, token: recipient.accessToken })).status).toBe(400);
		const state = await json(await call());
		expect(state.members).toHaveLength(2);
		expect(state.invitations).toHaveLength(0);
		expect((await w.call(`/orgs/${org.id}/members`, { token: recipient.accessToken })).status).toBe(200);
		const expired = await invite("c@example.com");
		await w.env.DB.prepare("UPDATE invitations SET expires_at=? WHERE used_at IS NULL").bind(w.clock.t - 1).run();
		expect((await w.call(`/invites/${expired.token}/accept`, { json: {}, token: stranger.accessToken })).status).toBe(400);
	});
	it("reserves seats atomically and handles concurrent accepts", async () => {
		const { w, invite, call } = await fixture(2);
		const recipient = await signIn(w, "b@example.com");
		const invited = await invite("b@example.com");
		expect((await invite("c@example.com")).response.status).toBe(409);
		const responses = await Promise.all([1, 2].map(() => w.call(`/invites/${invited.token}/accept`, { json: {}, token: recipient.accessToken })));
		expect(responses.filter(r => r.status === 200)).toHaveLength(1);
		expect((await json(await call())).members).toHaveLength(2);
	});
	it("protects the final owner and limits admin/member authority", async () => {
		const { w, owner, org, call } = await fixture();
		const admin = await signIn(w, "admin@example.com");
		const member = await signIn(w, "member@example.com");
		for (const [user, role] of [[admin, "admin"], [member, "member"]] as const) await w.env.DB.prepare("INSERT INTO memberships VALUES(?,?,?,?)").bind(org.id, user.user.id, role, w.clock.t).run();
		expect((await call(`members/${owner.user.id}`, { method: "DELETE" })).status).toBe(409);
		expect((await call(`members/${owner.user.id}`, { method: "PATCH", json: { role: "viewer" } })).status).toBe(409);
		expect((await call(`members/${owner.user.id}`, { token: admin.accessToken, method: "PATCH", json: { role: "viewer" } })).status).toBe(409);
		expect((await call(`members/${member.user.id}`, { token: admin.accessToken, method: "PATCH", json: { role: "admin" } })).status).toBe(409);
		expect((await call(`members/${member.user.id}`, { token: admin.accessToken, method: "PATCH", json: { role: "viewer" } })).status).toBe(200);
		expect((await call(`members/${admin.user.id}`, { token: member.accessToken, method: "DELETE" })).status).toBe(403);
		expect((await call(`members/${admin.user.id}`, { method: "PATCH", json: { role: "owner" } })).status).toBe(200);
		expect((await call(`members/${owner.user.id}`, { method: "DELETE" })).status).toBe(200);
	});
	it("keeps an owner when owners remove one another concurrently", async () => {
		const { w, owner, org } = await fixture();
		const second = await signIn(w, "owner2@example.com");
		await w.env.DB.prepare("INSERT INTO memberships VALUES(?,?,'owner',?)").bind(org.id, second.user.id, w.clock.t).run();
		const responses = await Promise.all([
			w.call(`/orgs/${org.id}/members/${second.user.id}`, { token: owner.accessToken, method: "DELETE" }),
			w.call(`/orgs/${org.id}/members/${owner.user.id}`, { token: second.accessToken, method: "DELETE" }),
		]);
		expect(responses.filter(r => r.status === 200)).toHaveLength(1);
		const remaining = await w.env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id=? AND role='owner'").bind(org.id).first<{ n: number }>();
		expect(remaining?.n).toBe(1);
	});
	it("requires a team plan and rejects nonmembers and unauthenticated users", async () => {
		const { w, call } = await fixture();
		const outsider = await signIn(w, "outsider@example.com");
		expect((await call("members", { token: null })).status).toBe(401);
		expect((await call("members", { token: outsider.accessToken })).status).toBe(404);
		await w.env.DB.prepare("UPDATE billing SET plan='individual'").run();
		expect((await call("invites", { json: { email: "b@example.com" } })).status).toBe(403);
	});
	it("revokes invitations, fails closed on delivery errors and stale inviter roles", async () => {
		const { w, owner, org, call, invite } = await fixture();
		const recipient = await signIn(w, "b@example.com");
		const first = await invite("b@example.com");
		const id = (await json(first.response)).id;
		expect((await call(`invites/${id}`, { method: "DELETE" })).status).toBe(200);
		expect((await w.call(`/invites/${first.token}/accept`, { json: {}, token: recipient.accessToken })).status).toBe(400);
		const second = await invite("b@example.com");
		await w.env.DB.prepare("UPDATE memberships SET role='viewer' WHERE org_id=? AND user_id=?").bind(org.id, owner.user.id).run();
		expect((await w.call(`/invites/${second.token}/accept`, { json: {}, token: recipient.accessToken })).status).toBe(409);
		await w.env.DB.prepare("UPDATE memberships SET role='owner' WHERE org_id=? AND user_id=?").bind(org.id, owner.user.id).run();
		w.mail.send = async () => { throw new Error("unavailable"); };
		expect((await invite("c@example.com")).response.status).toBe(503);
		expect((await json(await call())).invitations).toHaveLength(1);
	});
});
