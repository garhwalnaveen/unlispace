import { describe, expect, it } from "vitest";
import { verifyJwt } from "../src/jwt";
import { makeWorld, signIn, ORIGIN, type World } from "./helpers";

const json = async <T = any>(r: Response) => (await r.json()) as T;

describe("me", () => {
	it("GET and PATCH", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		const me = await json(await w.call("/me", { token: s.accessToken }));
		expect(me).toMatchObject({ id: s.user.id, email: "a@example.com", displayName: null });
		const p = await json(await w.call("/me", { method: "PATCH", json: { displayName: "Ada" }, token: s.accessToken }));
		expect(p.displayName).toBe("Ada");
		expect((await w.call("/me", { method: "PATCH", json: { displayName: 5 }, token: s.accessToken })).status).toBe(400);
	});
});

describe("401s", () => {
	it("missing, malformed, tampered, wrong-typ and expired tokens", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		expect((await w.call("/me")).status).toBe(401);
		expect((await w.call("/me", { headers: { authorization: "Basic abc" } })).status).toBe(401);
		expect((await w.call("/me", { token: "x.y.z" })).status).toBe(401);
		expect((await w.call("/me", { token: s.accessToken.slice(0, -3) + "AAA" })).status).toBe(401);
		expect(await json(await w.call("/orgs"))).toEqual({ error: "unauthorized" });
		w.clock.t += 16 * 60_000;
		expect((await w.call("/me", { token: s.accessToken })).status).toBe(401);
	});

	it("a drive token is not accepted as an access token", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		const org = (await json(await w.call("/orgs", { token: s.accessToken }))).orgs[0];
		const t = await json(await w.call(`/drives/${org.drives[0].id}/token`, { json: {}, token: s.accessToken }));
		expect((await w.call("/me", { token: t.token })).status).toBe(401);
	});

	it("unknown routes are 404, wrong methods 405", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		expect((await w.call("/nope", { token: s.accessToken })).status).toBe(404);
		expect((await w.call("/orgs", { method: "DELETE", token: s.accessToken })).status).toBe(405);
	});
});

describe("drive tokens", () => {
	it("mints a data-plane token with role-capped access", async () => {
		const w = await makeWorld();
		const owner = await signIn(w, "owner@example.com");
		const org = (await json(await w.call("/orgs", { token: owner.accessToken }))).orgs[0];
		const driveId = org.drives[0].id;

		const res = await w.call(`/drives/${driveId}/token`, { json: {}, token: owner.accessToken });
		expect(res.status).toBe(200);
		const t = await json(res);
		expect(t).toMatchObject({ endpoint: "http://127.0.0.1:8787", driveId });
		const c = await verifyJwt(t.token, w.env.ULS_JWT_PUBLIC_JWKS, { issuer: w.env.ULS_ISSUER, typ: "drive", now: w.clock.t });
		expect(c).toMatchObject({ sub: owner.user.id, org: org.id, drives: [{ id: driveId, access: "write" }] });
		expect(typeof c.jti).toBe("string");
		expect(typeof c.sid).toBe("string");
		expect(t.expiresAt).toBe((c.exp as number) * 1000);
		expect(c.exp - c.iat).toBeLessThanOrEqual(900);

		// explicit read request
		const r = await json(await w.call(`/drives/${driveId}/token`, { json: { access: "read" }, token: owner.accessToken }));
		const rc = await verifyJwt(r.token, w.env.ULS_JWT_PUBLIC_JWKS, { issuer: w.env.ULS_ISSUER, typ: "drive", now: w.clock.t });
		expect((rc.drives as any)[0].access).toBe("read");
		expect((await w.call(`/drives/${driveId}/token`, { json: { access: "admin" }, token: owner.accessToken })).status).toBe(400);

		// viewer is capped at read even when asking for write
		const viewer = await signIn(w, "viewer@example.com");
		await w.env.DB.prepare("INSERT INTO memberships(org_id, user_id, role, created_at) VALUES(?,?,?,?)").bind(org.id, viewer.user.id, "viewer", Date.now()).run();
		const v = await json(await w.call(`/drives/${driveId}/token`, { json: { access: "write" }, token: viewer.accessToken }));
		const vc = await verifyJwt(v.token, w.env.ULS_JWT_PUBLIC_JWKS, { issuer: w.env.ULS_ISSUER, typ: "drive", now: w.clock.t });
		expect((vc.drives as any)[0].access).toBe("read");
		const v2 = await json(await w.call(`/drives/${driveId}/token`, { json: {}, token: viewer.accessToken }));
		const vc2 = await verifyJwt(v2.token, w.env.ULS_JWT_PUBLIC_JWKS, { issuer: w.env.ULS_ISSUER, typ: "drive", now: w.clock.t });
		expect((vc2.drives as any)[0].access).toBe("read");

		// /orgs emits role "viewer" and the drive access is read; viewers cannot manage drives
		const orgs = await json(await w.call("/orgs", { token: viewer.accessToken }));
		const shared = orgs.orgs.find((o: any) => o.id === org.id);
		expect(shared.role).toBe("viewer");
		expect(shared.drives[0].access).toBe("read");
		expect((await json(await w.call(`/drives/${driveId}`, { token: viewer.accessToken }))).access).toBe("read");
		expect((await w.call(`/orgs/${org.id}/drives`, { json: { name: "x" }, token: viewer.accessToken })).status).toBe(403);
		expect((await w.call(`/drives/${driveId}`, { method: "PATCH", json: { name: "x" }, token: viewer.accessToken })).status).toBe(403);
		expect((await w.call(`/drives/${driveId}`, { method: "DELETE", token: viewer.accessToken })).status).toBe(403);
	});

	it("member gets write; a non-member gets 404", async () => {
		const w = await makeWorld();
		const owner = await signIn(w, "owner@example.com");
		const org = (await json(await w.call("/orgs", { token: owner.accessToken }))).orgs[0];
		const driveId = org.drives[0].id;
		const outsider = await signIn(w, "outsider@example.com");
		const miss = await w.call(`/drives/${driveId}/token`, { json: {}, token: outsider.accessToken });
		expect(miss.status).toBe(404);
		expect(await json(miss)).toEqual({ error: "no_such_drive" });
		expect((await w.call(`/drives/${driveId}`, { token: outsider.accessToken })).status).toBe(404);
		expect((await w.call(`/drives/d-doesnotexist00000000000000/token`, { json: {}, token: outsider.accessToken })).status).toBe(404);

		const m = await signIn(w, "member@example.com");
		await w.env.DB.prepare("INSERT INTO memberships(org_id, user_id, role, created_at) VALUES(?,?,?,?)").bind(org.id, m.user.id, "member", Date.now()).run();
		const mt = await json(await w.call(`/drives/${driveId}/token`, { json: {}, token: m.accessToken }));
		const mc = await verifyJwt(mt.token, w.env.ULS_JWT_PUBLIC_JWKS, { issuer: w.env.ULS_ISSUER, typ: "drive", now: w.clock.t });
		expect((mc.drives as any)[0].access).toBe("write");
		// member sees the drive with write access and cannot rename or delete it
		expect((await json(await w.call(`/drives/${driveId}`, { token: m.accessToken }))).access).toBe("write");
		expect((await w.call(`/drives/${driveId}`, { method: "PATCH", json: { name: "x" }, token: m.accessToken })).status).toBe(403);
		expect((await w.call(`/drives/${driveId}`, { method: "DELETE", token: m.accessToken })).status).toBe(403);
	});
});

describe("drives CRUD and plan limit", () => {
	it("individual tier allows one drive; teams allows more; delete frees the slot", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		const org = (await json(await w.call("/orgs", { token: s.accessToken }))).orgs[0];
		const over = await w.call(`/orgs/${org.id}/drives`, { json: { name: "Second" }, token: s.accessToken });
		expect(over.status).toBe(403);
		expect(await json(over)).toEqual({ error: "plan_limit" });

		// deleting the existing drive frees the slot
		expect((await json(await w.call(`/drives/${org.drives[0].id}`, { method: "DELETE", token: s.accessToken }))).ok).toBe(true);
		expect(w.dp.deleted).toEqual([org.drives[0].id]);
		expect((await w.call(`/drives/${org.drives[0].id}`, { token: s.accessToken })).status).toBe(404);
		const again = await w.call(`/orgs/${org.id}/drives`, { json: { name: "Fresh", placement: "weur" }, token: s.accessToken });
		expect(again.status).toBe(201);
		expect(await json(again)).toMatchObject({ name: "Fresh", placement: "weur", status: "ready", access: "admin", orgId: org.id });

		// teams tier
		await w.env.DB.prepare("UPDATE orgs SET tier = 'teams' WHERE id = ?").bind(org.id).run();
		expect((await w.call(`/orgs/${org.id}/drives`, { json: { name: "Third" }, token: s.accessToken })).status).toBe(201);
		expect((await w.call(`/orgs/${org.id}/drives`, { json: { name: "Fourth" }, token: s.accessToken })).status).toBe(201);
		const list = await json(await w.call("/orgs", { token: s.accessToken }));
		expect(list.orgs[0].drives).toHaveLength(3);
	});

	it("validates input, rename works, deleted drives disappear from /orgs", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		const org = (await json(await w.call("/orgs", { token: s.accessToken }))).orgs[0];
		const id = org.drives[0].id;
		const ren = await json(await w.call(`/drives/${id}`, { method: "PATCH", json: { name: "Renamed" }, token: s.accessToken }));
		expect(ren.name).toBe("Renamed");
		expect((await w.call(`/drives/${id}`, { method: "PATCH", json: {}, token: s.accessToken })).status).toBe(400);
		await w.env.DB.prepare("UPDATE orgs SET tier = 'teams' WHERE id = ?").bind(org.id).run();
		expect((await w.call(`/orgs/${org.id}/drives`, { json: { name: "x", placement: "mars" }, token: s.accessToken })).status).toBe(400);
		expect((await w.call(`/orgs/${org.id}/drives`, { json: {}, token: s.accessToken })).status).toBe(400);
		expect((await w.call(`/orgs/o_unknown/drives`, { json: { name: "x" }, token: s.accessToken })).status).toBe(404);
		await w.call(`/drives/${id}`, { method: "DELETE", token: s.accessToken });
		expect((await json(await w.call("/orgs", { token: s.accessToken }))).orgs[0].drives).toHaveLength(0);
	});

	it("a failed createDrive on POST returns the drive as provisioning_failed", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		const org = (await json(await w.call("/orgs", { token: s.accessToken }))).orgs[0];
		await w.env.DB.prepare("UPDATE orgs SET tier = 'teams' WHERE id = ?").bind(org.id).run();
		w.dp.failCreate = true;
		const r = await w.call(`/orgs/${org.id}/drives`, { json: { name: "Broken" }, token: s.accessToken });
		expect(r.status).toBe(201);
		expect((await json(r)).status).toBe("provisioning_failed");
	});
});

describe("CORS", () => {
	it("answers preflight for the web origin only", async () => {
		const w = await makeWorld();
		const ok = await w.call("/orgs", { method: "OPTIONS", origin: ORIGIN, headers: { "access-control-request-method": "GET" } });
		expect(ok.status).toBe(204);
		expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
		expect(ok.headers.get("access-control-allow-methods")).toBe("GET, POST, PATCH, DELETE, OPTIONS");
		expect(ok.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
		const bad = await w.call("/orgs", { method: "OPTIONS", origin: "https://evil.example" });
		expect(bad.status).toBe(204);
		expect(bad.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("adds the allow-origin header to normal and error responses", async () => {
		const w = await makeWorld();
		const r = await w.call("/me", { origin: ORIGIN });
		expect(r.status).toBe(401);
		expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
		expect((await w.call("/healthz", { origin: "https://evil.example" })).headers.get("access-control-allow-origin")).toBeNull();
	});
});
