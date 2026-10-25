import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ControlPlane, rpcContext } from "../src/control-plane";
import worker from "../src/index";
import { meterUsage } from "../src/entitlements";
import { makeWorld, signIn } from "./helpers";
import { verifyJwt } from "../src/jwt";
const json = async (r: Response): Promise<any> => r.json();
async function fixture() {
	const w = await makeWorld({ ULS_ACCESS_KEY_MASTERS: JSON.stringify({ "1": btoa("test master key for access keys!!") }) });
	const s = await signIn(w);
	const org = (await json(await w.call("/orgs", { token: s.accessToken }))).orgs[0];
	const root = org.drives[0].id as string;
	const call = (p: string, b: unknown = {}, method = "POST") => w.call(p, { token: s.accessToken, json: method === "GET" ? undefined : b, method });
	const key = await json(await call("/keys", { workspaceId: org.id, access: "admin" }));
	const cp = new ControlPlane(createExecutionContext(), w.env);
	return { w, s, org, root, call, cp, id: key.accessKeyId as string };
}
describe("M3 drive routes", () => {
	it("validates and derives aliases, resolves collisions, exposes live forks and usage", async () => {
		const { w, org, root, call } = await fixture();
		expect(org.drives[0]).toMatchObject({ alias: null, forkOf: null, forks: [], usageBytes: 0 });
		await w.env.DB.prepare("UPDATE orgs SET tier='teams' WHERE id=?").bind(org.id).run();
		const first = await json(await call(`/orgs/${org.id}/drives`, { name: "Hello World!" }));
		const second = await json(await call(`/orgs/${org.id}/drives`, { name: "Hello World!" }));
		expect([first.alias, second.alias]).toEqual(["hello-world", "hello-world-2"]);
		for (const alias of ["x", "UPPER", "-abc", "abc-", "a.b", root, null, "a".repeat(64)]) expect((await call(`/drives/${root}`, { alias }, "PATCH")).status).toBe(400);
		expect((await call(`/drives/${root}`, { alias: first.alias }, "PATCH")).status).toBe(409);
		expect((await json(await call(`/drives/${root}`, { alias: "root-bucket" }, "PATCH"))).alias).toBe("root-bucket");
		expect((await call(`/orgs/${org.id}/drives`, { name: "collision", alias: first.alias })).status).toBe(409);
		const fallback = await json(await call(`/orgs/${org.id}/drives`, { name: "!!!" }));
		expect(fallback.alias).toBe(fallback.id);
		const fork = await json(await call(`/drives/${root}/fork`, { alias: "fork-bucket" }));
		expect(fork).toMatchObject({ alias: "fork-bucket", forkOf: { driveId: root }, usageBytes: 0 });
		expect((await json(await call(`/drives/${root}`, {}, "GET"))).forks).toEqual([fork.id]);
		expect((await call(`/drives/${root}?hard=1`, {}, "DELETE")).status).toBe(409);
		expect((await call(`/drives/${fork.id}?hard=1`, {}, "DELETE")).status).toBe(200);
		expect(w.dp.deleteOptions).toContainEqual({ driveId: fork.id, hard: true });
		expect((await call(`/drives/${root}?hard=1`, {}, "DELETE")).status).toBe(200);
		expect((await call(`/orgs/${org.id}/drives`, { name: "Reused", alias: "root-bucket" })).status).toBe(201);
	});
	it("counts roots separately, caps forks at 50, and propagates depth and slow-down errors", async () => {
		const { w, org, root, call } = await fixture();
		let source = root;
		for (let n = 1;n <= 8;n++) {
			const r = await call(`/drives/${source}/fork`, { alias: `fork-${n}` });
			expect(r.status).toBe(201); source = (await json(r)).id;
		}
		expect(await json(await call(`/drives/${source}/fork`, { alias: "depth-nine" }))).toEqual({ error: "fork_depth_exceeded" });
		expect((await call(`/orgs/${org.id}/drives`, { name: "Another root" })).status).toBe(403);
		for (let n = 8;n < 50;n++) expect((await call(`/drives/${root}/fork`, { alias: `more-${n}` })).status).toBe(201);
		expect(await json(await call(`/drives/${root}/fork`, { alias: "too-many" }))).toEqual({ error: "plan_limit" });
		await w.env.DB.prepare("UPDATE drives SET status='deleted' WHERE forked_from IS NOT NULL AND org_id=?").bind(org.id).run();
		w.dp.forkDrive = async () => { throw Object.assign(new Error("slow_down"), { code: "slow_down" }); };
		expect((await call(`/drives/${root}/fork`, { alias: "slow-fork" })).status).toBe(503);
		expect(await w.env.DB.prepare("SELECT 1 FROM drives WHERE alias='slow-fork'").first()).toBeNull();
	});
	it("preserves soft deletion on upstream failure and propagates hard-delete failure", async () => {
		const { w, root, call } = await fixture();
		w.dp.failDelete = true;
		expect((await call(`/drives/${root}?hard=1`, {}, "DELETE")).status).toBe(500);
		expect((await call(`/drives/${root}`, {}, "GET")).status).toBe(200);
		expect((await call(`/drives/${root}`, {}, "DELETE")).status).toBe(200);
		expect((await call(`/drives/${root}`, {}, "GET")).status).toBe(404);
	});
	it("hides other orgs and denies viewers fork and alias management", async () => {
		const { w, org, root } = await fixture();
		const other = await signIn(w, "other@example.com");
		for (const [path, method, body] of [[`/drives/${root}/fork`, "POST", { alias: "hidden" }], [`/drives/${root}?hard=1`, "DELETE", {}], [`/drives/${root}`, "PATCH", { alias: "hidden" }]] as const) {
			expect((await w.call(path, { token: other.accessToken, method, json: body })).status).toBe(404);
		}
		await w.env.DB.prepare("INSERT INTO memberships VALUES(?,?,?,?)").bind(org.id, other.user.id, "viewer", Date.now()).run();
		expect((await w.call(`/drives/${root}/fork`, { token: other.accessToken, json: { alias: "hidden" } })).status).toBe(403);
	});
});
describe("ControlPlane RPC", () => {
 it("exposes only authenticated entrypoint methods on its prototype", () => {
  expect(Object.getOwnPropertyNames(ControlPlane.prototype).sort()).toEqual([
   "constructor","resolveKey","recordKeyUse","listDrives","resolveBucket","createDrive","forkDrive","deleteDrive","describeDrive","mintChildKey","mintMountToken"
  ].sort());
 });
	it("implements bucket lifecycle, describe, mount tokens, usage recording and aliases", async () => {
		const { w, root, org, cp, id } = await fixture();
		expect(await cp.resolveKey(id)).toMatchObject({ orgId: org.id, access: "admin", drives: null, parent: null });
		expect(await cp.resolveKey("missing")).toBeNull();
		expect((await cp.listDrives(id)).map(d => d.driveId)).toEqual([root]);
		expect(await cp.resolveBucket(id, root)).toMatchObject({ driveId: root, writable: true });
		await w.env.DB.prepare("UPDATE orgs SET tier='teams' WHERE id=?").bind(org.id).run();
		const created = await cp.createDrive(id, { alias: "rpc-root", displayName: "RPC", placement: "apac" });
		expect(await cp.resolveBucket(id, "rpc-root")).toEqual(created);
		await expect(cp.createDrive(id, { alias: "rpc-root" })).rejects.toMatchObject({ code: "bucket_exists" });
		await expect(cp.createDrive(id, { alias: "Invalid" })).rejects.toMatchObject({ code: "invalid_argument" });
		const fork = await cp.forkDrive(id, { source: "rpc-root", alias: "rpc-fork" });
		expect(fork.forkPoint).toBeGreaterThan(0);
		expect(await cp.describeDrive(id, "rpc-fork")).toMatchObject({ driveId: fork.driveId, forkOf: { driveId: created.driveId, forkPoint: new Date(fork.forkPoint).toISOString() }, usageBytes: 0 });
		expect((await cp.describeDrive(id, "rpc-root")).forks).toEqual([fork.driveId]);
		const mount = await cp.mintMountToken(id, "rpc-fork");
		expect(mount).toMatchObject({ canWrite: true, workspaceId: org.id, driveId: fork.driveId });
		const claims = await verifyJwt(mount.token, w.env.ULS_JWT_PUBLIC_JWKS, { issuer: w.env.ULS_ISSUER, typ: "drive", now: Date.now() });
		expect(claims.drives).toEqual([{ id: fork.driveId, access: "write" }]);
		await cp.recordKeyUse(id);
		expect((await w.env.DB.prepare("SELECT last_used_at FROM access_keys WHERE id=?").bind(id).first<{ last_used_at: number }>())!.last_used_at).toBeGreaterThan(0);
		await expect(cp.deleteDrive(id, "rpc-root", { hard: true })).rejects.toMatchObject({ code: "drive_has_forks" });
		await cp.deleteDrive(id, "rpc-fork", { hard: true });
		await cp.deleteDrive(id, "rpc-root", { hard: false });
		await expect(cp.resolveBucket(id, "rpc-root")).rejects.toMatchObject({ code: "no_such_bucket" });
	});
	it("enforces child-key scope, workspace, access, ancestry and current membership", async () => {
		const { w, s, org, root, call, cp, id } = await fixture();
		for (const opts of [{ drives: [] }, { drives: null }, { drives: [root, root] }]) await expect(cp.mintChildKey(id, opts as any)).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(cp.mintChildKey(id, { drives: [root], workspaceId: "other" })).rejects.toMatchObject({ code: "access_denied" });
  await expect(cp.mintChildKey(id,{drives:[root],orgId:"other"})).rejects.toMatchObject({code:"access_denied"});
  await expect(cp.mintChildKey(id,{drives:[root],access:null} as any)).rejects.toMatchObject({code:"invalid_argument"});
		const child = await cp.mintChildKey(id, { drives: [root], access: "read", label: "Job" });
		const kid = child.key.accessKeyId as string;
		expect(child.key.parent).toBe(id);
		expect(child.secretAccessKey).toHaveLength(40);
		expect((await json(await w.call("/keys", { token: s.accessToken }))).keys.find((k: any) => k.accessKeyId === kid).parent).toBe(id);
		await expect(cp.mintChildKey(kid, { drives: [root], access: "write" })).rejects.toMatchObject({ code: "access_denied" });
		await expect(cp.createDrive(kid, { alias: "no-admin" })).rejects.toMatchObject({ code: "access_denied" });
		await expect(cp.forkDrive(kid, { source: root, alias: "no-admin" })).rejects.toMatchObject({ code: "access_denied" });
		await expect(cp.deleteDrive(kid, root, { hard: false })).rejects.toMatchObject({ code: "access_denied" });
		expect((await cp.mintMountToken(kid, root)).canWrite).toBe(false);
		const outsider = await signIn(w, "outsider@example.com");
		const otherOrg = (await json(await w.call("/orgs", { token: outsider.accessToken }))).orgs[0];
		await expect(cp.mintChildKey(kid, { drives: [otherOrg.drives[0].id] })).rejects.toMatchObject({ code: "no_such_bucket" });
		await expect(cp.resolveBucket(id, otherOrg.drives[0].id)).rejects.toMatchObject({ code: "no_such_bucket" });
		await call(`/keys/${id}`, {}, "DELETE");
		const operations = [() => cp.recordKeyUse(kid), () => cp.listDrives(kid), () => cp.resolveBucket(kid, root), () => cp.describeDrive(kid, root), () => cp.createDrive(kid, { alias: "revoked" }), () => cp.forkDrive(kid, { source: root, alias: "revoked" }), () => cp.deleteDrive(kid, root, { hard: false }), () => cp.mintChildKey(kid, { drives: [root] }), () => cp.mintMountToken(kid, root)];
		for (const op of operations) await expect(op()).rejects.toMatchObject({ code: "access_denied" });
		expect(await cp.resolveKey(kid)).toBeNull();
		const fresh = await json(await call("/keys", { workspaceId: org.id, access: "admin" }));
		await w.env.DB.prepare("UPDATE memberships SET role='viewer' WHERE org_id=? AND user_id=?").bind(org.id, s.user.id).run();
		expect((await cp.resolveKey(fresh.accessKeyId))!.access).toBe("read");
		await expect(cp.forkDrive(fresh.accessKeyId, { source: root, alias: "viewer" })).rejects.toMatchObject({ code: "access_denied" });
		await w.env.DB.prepare("DELETE FROM memberships WHERE org_id=? AND user_id=?").bind(org.id, s.user.id).run();
		expect(await cp.resolveKey(fresh.accessKeyId)).toBeNull();
	});
	it("intersects ancestors' drive and access caps and hides unreachable buckets", async () => {
		const { w, cp, id, root, org } = await fixture();
		const child = await cp.mintChildKey(id, { drives: [root] });
		const kid = child.key.accessKeyId as string;
		await w.env.DB.prepare("UPDATE access_keys SET access='read', drives='[]' WHERE id=?").bind(id).run();
		expect(await cp.resolveKey(kid)).toMatchObject({ access: "read", drives: [] });
		expect(await cp.listDrives(kid)).toEqual([]);
		await expect(cp.resolveBucket(kid, root)).rejects.toMatchObject({ code: "no_such_bucket" });
		await expect(cp.mintChildKey(kid, { drives: [root] })).rejects.toMatchObject({ code: "no_such_bucket" });
		await w.env.DB.prepare("UPDATE access_keys SET access='admin', drives=? WHERE id=?").bind(JSON.stringify([root]), id).run();
		await expect(cp.createDrive(id, { alias: "scoped" })).rejects.toMatchObject({ code: "access_denied" });
		expect((await cp.listDrives(id))[0]!.driveId).toBe(root);
		expect((await cp.resolveKey(id))!.orgId).toBe(org.id);
		await expect(cp.forkDrive(id, { source: "missing-bucket", alias: "denied" })).rejects.toMatchObject({ code: "no_such_bucket" });
		await expect(cp.describeDrive(id, "missing-bucket")).rejects.toMatchObject({ code: "no_such_bucket" });
		await expect(cp.mintMountToken(id, "missing-bucket")).rejects.toMatchObject({ code: "no_such_bucket" });
	});
});
describe("M3 metering", () => {
	it("uses own bytes, ignores deleted drives, handles quota and expiry, and wires scheduled", async () => {
		const { w, cp, id, org, root, call } = await fixture();
		w.dp.driveStats = async driveId => ({ headSeq: 0, fileCount: 1, bytes: 9_000_000_000_000, ownBytes: 123, lineage: driveId, depth: 0, forkOf: null });
		await worker.scheduled({} as ScheduledController, w.env);
		expect(await json(await call(`/orgs/${org.id}/billing`, {}, "GET"))).toMatchObject({ usedBytes: 123, writable: true });
		expect((await cp.describeDrive(id, root)).usageBytes).toBe(123);
		await w.env.DB.prepare("UPDATE drive_usage SET own_bytes=1000000000001 WHERE drive_id=?").bind(root).run();
		expect((await cp.resolveBucket(id, root)).writable).toBe(false);
		expect((await cp.mintMountToken(id, root)).canWrite).toBe(false);
		expect(await json(await call(`/drives/${root}/token`, { access: "write" }))).toEqual({ error: "over_quota" });
		expect((await call(`/drives/${root}/token`, { access: "read" })).status).toBe(200);
		await w.env.DB.prepare("UPDATE drive_usage SET own_bytes=1000000000000 WHERE drive_id=?").bind(root).run();
		expect((await cp.resolveBucket(id, root)).writable).toBe(true);
		await w.env.DB.prepare("UPDATE orgs SET trial_ends_at=0 WHERE id=?").bind(org.id).run();
		expect((await cp.resolveBucket(id, root)).writable).toBe(false);
		expect((await call(`/drives/${root}/token`, { access: "write" })).status).toBe(403);
		await cp.deleteDrive(id, root, { hard: false });
		expect(await json(await call(`/orgs/${org.id}/billing`, {}, "GET"))).toMatchObject({ usedBytes: 0 });
	});
	it("limits each run to 500 oldest live drives", async () => {
		const { w, org } = await fixture();
		for (let start = 0;start < 502;start += 50) await w.env.DB.batch(Array.from({ length: Math.min(50, 502 - start) }, (_, i) => w.env.DB.prepare("INSERT INTO drives(id,org_id,name,status,created_at) VALUES(?,?,?,'ready',0)").bind(`meter-${start + i}`, org.id, "Meter")));
		await meterUsage(rpcContext(w.env));
		expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM drive_usage").first()).toEqual({ n: 500 });
		await meterUsage(rpcContext(w.env));
		expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM drive_usage").first()).toEqual({ n: 503 });
	});
});
