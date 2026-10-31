import { describe, expect, it } from "vitest";
import { makeWorld, signIn } from "./helpers";

describe("access-key defaults", () => {
	it("defaults session keys to write, retains scope checks, and never lists secrets", async () => {
		const w = await makeWorld({ ULS_ACCESS_KEY_MASTERS: JSON.stringify({ "1": btoa("test master key for access keys!!") }) });
		const s = await signIn(w);
		const token = s.accessToken;
		const { orgs } = await (await w.call("/orgs", { token })).json() as { orgs: { id: string }[] };
		const workspaceId = orgs[0]!.id;
		const created = await w.call("/keys", { token, json: { workspaceId } });
		expect(created.status).toBe(201);
		const key = await created.json() as { accessKeyId: string; access: string; secretAccessKey: string };
		expect(key.access).toBe("write");
		expect(key.secretAccessKey).toHaveLength(40);
		const listed = await (await w.call("/keys", { token })).json() as { keys: Record<string, unknown>[] };
		expect(listed.keys.find(k => k.accessKeyId === key.accessKeyId)).toMatchObject({ access: "write" });
		expect(listed.keys.every(k => !Object.hasOwn(k, "secretAccessKey"))).toBe(true);
		for (const access of [null, "owner", 0]) {
			expect((await w.call("/keys", { token, json: { workspaceId, access } })).status).toBe(400);
		}
		await w.env.DB.prepare("UPDATE memberships SET role='viewer' WHERE org_id=? AND user_id=?").bind(workspaceId, s.user.id).run();
		expect((await w.call("/keys", { token, json: { workspaceId } })).status).toBe(403);
		expect((await w.call("/keys", { token, json: { workspaceId, access: "read" } })).status).toBe(201);
	});
});
