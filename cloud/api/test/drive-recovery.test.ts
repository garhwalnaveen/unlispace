import { describe, expect, it } from "vitest";
import { DRIVE_RECOVERY_MS } from "../src/resources";
import { makeWorld, signIn } from "./helpers";

const json = async (response: Response): Promise<any> => response.json();
async function fixture() {
	const w = await makeWorld(), session = await signIn(w);
	const org = (await json(await w.call("/orgs", { token: session.accessToken }))).orgs[0];
	const drive = org.drives[0].id as string;
	const call = (path: string, body: unknown = {}, method = "POST") => w.call(path, { token: session.accessToken, method, ...(method === "GET" ? {} : { json: body }) });
	return { w, session, org, drive, call };
}

describe("deleted-drive recovery", () => {
	it("lists and restores a soft-deleted drive with the same identity and retained usage", async () => {
		const { w, org, drive, call } = await fixture();
		w.dp.stats.set(drive, 123);
		await call(`/drives/${drive}`, {}, "DELETE");
		expect((await call(`/drives/${drive}`, {}, "GET")).status).toBe(404);
		expect(await json(await call(`/orgs/${org.id}/deleted-drives`, {}, "GET"))).toMatchObject({ drives: [{ id: drive, recoverableUntil: w.clock.t + DRIVE_RECOVERY_MS }] });
		const response = await call(`/drives/${drive}/restore`);
		expect(response.status).toBe(200);
		expect(await json(response)).toMatchObject({ id: drive, status: "ready" });
		expect((await json(await call(`/orgs/${org.id}/deleted-drives`, {}, "GET"))).drives).toEqual([]);
		expect((await json(await call(`/orgs/${org.id}/billing`, {}, "GET"))).usedBytes).toBe(123);
	});

	it("requires management permission, hides outsiders and refuses expired or permanently deleted drives", async () => {
		const { w, org, drive, call } = await fixture();
		await call(`/drives/${drive}`, {}, "DELETE");
		const outsider = await signIn(w, "outsider@example.com");
		expect((await w.call(`/drives/${drive}/restore`, { token: outsider.accessToken, json: {} })).status).toBe(404);
		expect((await w.call(`/orgs/${org.id}/deleted-drives`, { token: outsider.accessToken })).status).toBe(404);
		await w.env.DB.prepare("INSERT INTO memberships VALUES(?,?,?,?)").bind(org.id, outsider.user.id, "viewer", w.clock.t).run();
		expect((await w.call(`/drives/${drive}/restore`, { token: outsider.accessToken, json: {} })).status).toBe(403);
		expect((await w.call(`/orgs/${org.id}/deleted-drives`, { token: outsider.accessToken })).status).toBe(403);
		await w.env.DB.prepare("UPDATE drives SET deleted_at=? WHERE id=?").bind(w.clock.t - DRIVE_RECOVERY_MS, drive).run();
		expect((await call(`/drives/${drive}/restore`)).status).toBe(410);
		await w.env.DB.prepare("UPDATE drives SET deleted_at=?,purged_at=? WHERE id=?").bind(w.clock.t, w.clock.t, drive).run();
		expect((await call(`/drives/${drive}/restore`)).status).toBe(410);
		expect((await json(await call(`/orgs/${org.id}/deleted-drives`, {}, "GET"))).drives).toEqual([]);
	});

	it("reserves plan slots and requires an explicit replacement alias when the old alias was reused", async () => {
		const { w, org, drive, call } = await fixture();
		await call(`/drives/${drive}`, { alias: "old-drive" }, "PATCH");
		await call(`/drives/${drive}`, {}, "DELETE");
		const replacement = await json(await call(`/orgs/${org.id}/drives`, { name: "Replacement", alias: "old-drive" }));
		expect((await call(`/drives/${drive}/restore`, { alias: "restored-drive" })).status).toBe(403);
		await w.env.DB.prepare("UPDATE orgs SET tier='teams' WHERE id=?").bind(org.id).run();
		expect((await call(`/drives/${drive}/restore`)).status).toBe(409);
		expect((await call(`/drives/${drive}/restore`, { alias: "INVALID" })).status).toBe(400);
		expect(await json(await call(`/drives/${drive}/restore`, { alias: "restored-drive" }))).toMatchObject({ id: drive, alias: "restored-drive" });
		expect(await json(await call(`/drives/${replacement.id}`, {}, "GET"))).toMatchObject({ alias: "old-drive", status: "ready" });
	});

	it("keeps an ambiguous restoration reserved and completes it safely on retry", async () => {
		const { w, org, drive, call } = await fixture();
		await call(`/drives/${drive}`, {}, "DELETE");
		const restore = w.dp.restoreDrive;
		w.dp.restoreDrive = async () => { throw new Error("connection lost"); };
		expect((await call(`/drives/${drive}/restore`)).status).toBe(503);
		expect(await w.env.DB.prepare("SELECT status FROM drives WHERE id=?").bind(drive).first()).toEqual({ status: "restoring" });
		expect((await call(`/drives/${drive}`, {}, "DELETE")).status).toBe(409);
		expect((await call(`/orgs/${org.id}/drives`, { name: "Second" })).status).toBe(403);
		w.dp.restoreDrive = restore;
		expect((await call(`/drives/${drive}/restore`)).status).toBe(200);
	});
});
