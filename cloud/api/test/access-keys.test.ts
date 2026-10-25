import { describe, expect, it } from "vitest";
import { deriveAccessKeySecret, recordAccessKeyUse, resolveAccessKey } from "../src/access-keys";
import type { Ctx } from "../src/ctx";
import { makeWorld, signIn, type World } from "./helpers";

const master = btoa("test master key for access keys!!");
const body = async (r: Response): Promise<any> => r.json();
const context = (w: World): Ctx => ({ env: w.env, now: w.clock.t, req: new Request("https://api.test/keys"), url: new URL("https://api.test/keys"), fetch: w.fetchImpl.fn, email: w.mail });

async function fixture() {
	const w = await makeWorld({ ULS_ACCESS_KEY_MASTERS: JSON.stringify({ "1": master, "2": btoa("other master key for access keys!") }) });
	const s = await signIn(w);
	const org = (await body(await w.call("/orgs", { token: s.accessToken }))).orgs[0];
	const create = (value: Record<string, unknown> = {}, token = s.accessToken) => w.call("/keys", { token, json: { workspaceId: org.id, access: "admin", ...value } });
	return { w, s, org, create };
}

describe("S3 access keys", () => {
	it("creates a versioned ID and deterministic 40-character secret, shown only on creation", async () => {
		const { w, s, org, create } = await fixture();
		const res = await create({ label: "Agent", drives: [org.drives[0].id] });
		expect(res.status).toBe(201);
		const k = await body(res);
		expect(k.accessKeyId).toMatch(/^ULS1[A-Z2-7]{16}$/);
		expect(k.secretAccessKey).toHaveLength(40);
		expect(k.secretAccessKey).toBe(await deriveAccessKeySecret(w.env, k.accessKeyId));
		expect(await deriveAccessKeySecret(w.env, "ULS1AAAAAAAAAAAAAAAA")).toBe("d+XYEkpRubOrVz6k7mElSX7LpuXhKxV0pwkMtOgk");
		expect(k).toMatchObject({ workspaceId: org.id, access: "admin", label: "Agent", parent: null, lastUsedAt: null, revokedAt: null });
		const list = await body(await w.call(`/keys?workspaceId=${org.id}`, { token: s.accessToken }));
		expect(list.keys).toHaveLength(1);
		expect(list.keys[0]).not.toHaveProperty("secretAccessKey");
		const row = await w.env.DB.prepare("SELECT * FROM access_keys WHERE id = ?").bind(k.accessKeyId).first();
		expect(JSON.stringify(row)).not.toContain(k.secretAccessKey);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const resolved = await resolveAccessKey(context(w), k.accessKeyId);
		expect(resolved.secretAccessKey).toBe(k.secretAccessKey);
		expect(resolved.lastUsedAt).toBeNull();
		await recordAccessKeyUse(context(w), k.accessKeyId);
		w.clock.t -= 1;
		await recordAccessKeyUse(context(w), k.accessKeyId);
		expect((await resolveAccessKey(context(w), k.accessKeyId)).lastUsedAt).toBe(k.createdAt);
	});

	it("retains old masters during rotation and rejects unknown versions and malformed IDs", async () => {
		const { w, create } = await fixture();
		const first = await body(await create());
		w.env.ULS_ACCESS_KEY_VERSION = "2";
		const second = await body(await create());
		expect(second.accessKeyId).toMatch(/^ULS2/);
		expect(await deriveAccessKeySecret(w.env, first.accessKeyId)).toBe(first.secretAccessKey);
		expect(await deriveAccessKeySecret(w.env, second.accessKeyId)).toBe(second.secretAccessKey);
		await expect(deriveAccessKeySecret(w.env, "bad")).rejects.toMatchObject({ status: 401 });
		delete w.env.ULS_ACCESS_KEY_MASTERS;
		await expect(deriveAccessKeySecret(w.env, first.accessKeyId)).rejects.toMatchObject({ status: 503 });
		expect((await create()).status).toBe(503);
	});

	it("narrows child scopes and revokes three generations atomically and idempotently", async () => {
		const { w, s, org, create } = await fixture();
		const root = await body(await create({ drives: [org.drives[0].id] }));
		const child = await body(await create({ parent: root.accessKeyId, access: "write", drives: [org.drives[0].id] }));
		const leaf = await body(await create({ parent: child.accessKeyId, access: "read", drives: [] }));
		expect(leaf.parent).toBe(child.accessKeyId);
		expect((await create({ parent: child.accessKeyId, access: "admin", drives: [] })).status).toBe(403);
		expect((await create({ parent: child.accessKeyId, access: "read", drives: null })).status).toBe(403);
		const unrelated = await body(await create());
		expect((await w.call(`/keys/${root.accessKeyId}`, { method: "DELETE", token: s.accessToken })).status).toBe(200);
		for (const k of [root, child, leaf]) await expect(resolveAccessKey(context(w), k.accessKeyId)).rejects.toMatchObject({ status: 401 });
		expect((await create({ parent: leaf.accessKeyId, access: "read", drives: [] })).status).toBe(401);
		expect((await w.call(`/keys/${root.accessKeyId}`, { method: "DELETE", token: s.accessToken })).status).toBe(200);
		expect((await resolveAccessKey(context(w), unrelated.accessKeyId)).access).toBe("admin");
		const list = await body(await w.call("/keys", { token: s.accessToken }));
		expect(list.keys.filter((k: any) => k.revokedAt !== null)).toHaveLength(3);
	});

	it("rejects foreign drives, foreign parents, nonmembers, and malformed scopes", async () => {
		const { w, s, org, create } = await fixture();
		const outsider = await signIn(w, "outside@example.com");
		expect((await create({}, outsider.accessToken)).status).toBe(404);
		expect((await w.call(`/keys?workspaceId=${org.id}`, { token: outsider.accessToken })).status).toBe(404);
		const k = await body(await create());
		expect((await w.call(`/keys/${k.accessKeyId}`, { method: "DELETE", token: outsider.accessToken })).status).toBe(404);
		const otherOrg = (await body(await w.call("/orgs", { token: outsider.accessToken }))).orgs[0];
		const other = await body(await w.call("/keys", { token: outsider.accessToken, json: { workspaceId: otherOrg.id, access: "admin" } }));
		expect((await create({ parent: other.accessKeyId })).status).toBe(403);
		expect((await create({ drives: [otherOrg.drives[0].id] })).status).toBe(404);
		for (const value of [{ access: ["read"] }, { access: "owner" }, { drives: "all" }, { drives: [org.drives[0].id, org.drives[0].id] }, { label: "" }, { parent: 1 }, { workspaceId: "" }]) expect((await create(value)).status).toBe(400);
		expect((await w.call("/keys")).status).toBe(401);
		expect((await w.call("/keys", { method: "PATCH", token: s.accessToken })).status).toBe(405);
	});

	it("caps member/viewer keys, hides others' keys, and rechecks membership and parent roles", async () => {
		const { w, s, org, create } = await fixture();
		const member = await signIn(w, "member@example.com");
		await w.env.DB.prepare("INSERT INTO memberships VALUES(?,?,?,?)").bind(org.id, member.user.id, "member", w.clock.t).run();
		const root = await body(await create());
		expect((await create({}, member.accessToken)).status).toBe(403);
		expect((await create({ access: "read", parent: root.accessKeyId }, member.accessToken)).status).toBe(403);
		const k = await body(await create({ access: "write" }, member.accessToken));
		expect((await body(await w.call(`/keys?workspaceId=${org.id}`, { token: member.accessToken }))).keys).toHaveLength(1);
		const child = await body(await create({ access: "write", parent: k.accessKeyId }));
		await w.env.DB.prepare("UPDATE memberships SET role = 'viewer' WHERE org_id = ? AND user_id = ?").bind(org.id, member.user.id).run();
		expect((await resolveAccessKey(context(w), k.accessKeyId)).access).toBe("read");
		expect((await resolveAccessKey(context(w), child.accessKeyId)).access).toBe("read");
		expect((await create({ access: "write" }, member.accessToken)).status).toBe(403);
		expect((await create({ access: "read" }, member.accessToken)).status).toBe(201);
		await w.env.DB.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").bind(org.id, member.user.id).run();
		await expect(resolveAccessKey(context(w), child.accessKeyId)).rejects.toMatchObject({ status: 401 });
		expect((await w.call(`/keys/${k.accessKeyId}`, { method: "DELETE", token: s.accessToken })).status).toBe(200);
	});
});
