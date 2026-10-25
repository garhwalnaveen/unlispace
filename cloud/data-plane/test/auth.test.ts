import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { genKey, installJwks, ISS, setAllowDev, signToken, type TestKey } from "./auth-helpers";
import { api, newDrive, putFile, selfFetch, TOKEN } from "./helpers";

let key: TestKey;
let other: TestKey;
beforeAll(async () => {
	key = await genKey("k1");
	other = await genKey("k2");
	installJwks(key);
});
afterEach(() => setAllowDev("1"));

const tok = (drive: string, access: string, extra: Parameters<typeof signToken>[1] = {}) => signToken(key, { drives: [{ id: drive, access }], ...extra });

describe("drive token auth", () => {
	it("read token can stat/list but a commit gets 404 no_such_drive; write token can commit", async () => {
		const d = await newDrive();
		await putFile(d, "a.txt", "hi");
		const read = await tok(d, "read");
		expect((await api(`/v0/drives/${d}/stat?path=a.txt`, { token: read })).status).toBe(200);
		expect((await api(`/v0/drives/${d}/list?path=`, { token: read })).status).toBe(200);
		expect((await api(`/v0/drives/${d}`, { token: read })).status).toBe(200);
		const c = await api(`/v0/drives/${d}/commit`, { token: read, json: { ops: [{ op: "mkdir", path: "x/" }] } });
		expect(c.status).toBe(404);
		expect(await c.json()).toEqual({ error: "no_such_drive" });
		const up = await api(`/v0/drives/${d}/shards/${"0".repeat(64)}`, { token: read, method: "PUT", body: "x" });
		expect(up.status).toBe(404);
		const rs = await api(`/v0/drives/${d}/restore`, { token: read, json: { path: "a.txt", versionId: "v_" + "0".repeat(26) } });
		expect(rs.status).toBe(404);
		const write = await tok(d, "write");
		expect((await api(`/v0/drives/${d}/commit`, { token: write, json: { ops: [{ op: "mkdir", path: "x/" }] } })).status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=a.txt`, { token: write })).status).toBe(200); // write implies read
		const admin = await tok(d, "admin");
		expect((await api(`/v0/drives/${d}/commit`, { token: admin, json: { ops: [{ op: "mkdir", path: "y/" }] } })).status).toBe(200);
	});

	it("a token for drive A used on drive B gets 404", async () => {
		const a = await newDrive();
		const b = await newDrive();
		const t = await tok(a, "write");
		expect((await api(`/v0/drives/${a}/stat?path=`, { token: t })).status).toBe(200);
		const r = await api(`/v0/drives/${b}/stat?path=`, { token: t });
		expect(r.status).toBe(404);
		expect(await r.json()).toEqual({ error: "no_such_drive" });
		expect((await api(`/v0/drives/${b}/watch?since=0`, { token: t })).status).toBe(404);
		const n = await api(`/v0/drives/never-created-xx/stat?path=`, { token: t });
		expect(n.status).toBe(404); // same answer as a real-but-forbidden drive
	});

	it("401 for expired, wrong kid, wrong issuer, wrong typ, wrong alg, tampered and garbage tokens", async () => {
		const d = await newDrive();
		const now = Math.floor(Date.now() / 1000);
		const bad: Record<string, string> = {
			expired: await tok(d, "write", { exp: now - 120 }),
			wrongKid: await tok(d, "write", { kid: "nope" }),
			signedByUnlistedKey: await signToken(other, { kid: "k1", drives: [{ id: d, access: "write" }] }),
			wrongIssuer: await tok(d, "write", { iss: "https://evil.example" }),
			wrongTyp: await tok(d, "write", { typ: "access" }),
			wrongAlg: await tok(d, "write", { alg: "HS256" }),
			garbage: "not.a.jwt",
			empty: "",
		};
		const good = await tok(d, "write");
		const [h, p, s] = good.split(".") as [string, string, string];
		const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
		claims.sub = "u_ATTACKER";
		bad.tamperedPayload = `${h}.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${s}`;
		bad.tamperedSig = `${h}.${p}.${s.slice(0, -2)}${s.endsWith("AA") ? "BB" : "AA"}`;
		for (const [name, t] of Object.entries(bad)) {
			const r = await api(`/v0/drives/${d}/stat?path=`, { token: t || null });
			expect(r.status, name).toBe(401);
			expect(await r.json(), name).toEqual({ error: "unauthorized" });
		}
		expect((await api(`/v0/drives/${d}/stat?path=`, { token: good })).status).toBe(200);
	});

	it("accepts an expired token inside the 30 s leeway, and any key in a multi-key JWKS", async () => {
		const d = await newDrive();
		const now = Math.floor(Date.now() / 1000);
		expect((await api(`/v0/drives/${d}/stat?path=`, { token: await tok(d, "read", { exp: now - 10 }) })).status).toBe(200);
		installJwks(key, other);
		try {
			const t2 = await signToken(other, { drives: [{ id: d, access: "read" }] });
			expect((await api(`/v0/drives/${d}/stat?path=`, { token: t2 })).status).toBe(200);
			const t1 = await tok(d, "read");
			expect((await api(`/v0/drives/${d}/stat?path=`, { token: t1 })).status).toBe(200);
		} finally {
			installJwks(key);
		}
	});

	it("dev token: accepted only when ULS_ALLOW_DEV_TOKEN is \"1\"; public PUT /drives is dev-only", async () => {
		const d = await newDrive();
		setAllowDev("0");
		expect((await api(`/v0/drives/${d}/stat?path=`, { token: TOKEN })).status).toBe(401);
		setAllowDev(undefined);
		expect((await api(`/v0/drives/${d}/stat?path=`, { token: TOKEN })).status).toBe(401);
		// a drive token cannot create drives over HTTP
		const t = await tok("some-new-drive", "admin");
		const put = await api(`/v0/drives/some-new-drive`, { token: t, method: "PUT", json: {} });
		expect(put.status).toBe(404);
		setAllowDev("1");
		expect((await api(`/v0/drives/${d}/stat?path=`, { token: TOKEN })).status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=`, { token: TOKEN + "x" })).status).toBe(401);
	});

	it("records the token's sub as actor (dev token records \"dev\"), on commit and restore", async () => {
		const d = await newDrive();
		const r1 = await putFile(d, "f.txt", "one"); // dev
		const v1 = ((await r1.json()) as { results: { versionId: string }[] }).results[0]!.versionId;
		const alice = await tok(d, "write", { sub: "u_ALICE" });
		const bob = await tok(d, "write", { sub: "u_BOB" });
		expect((await api(`/v0/drives/${d}/commit`, { token: alice, json: { ops: [{ op: "mkdir", path: "dir/" }] } })).status).toBe(200);
		expect((await api(`/v0/drives/${d}/restore`, { token: bob, json: { path: "f.txt", versionId: v1 } })).status).toBe(200);
		const vs = (await (await api(`/v0/drives/${d}/versions?path=f.txt`)).json()) as { versions: { actor: string }[] };
		expect(vs.versions.map((v) => v.actor)).toEqual(["dev", "u_BOB"]);
		const dirs = (await (await api(`/v0/drives/${d}/versions?path=dir`)).json()) as { versions: { actor: string }[] };
		expect(dirs.versions.map((v) => v.actor)).toEqual(["u_ALICE"]);
	});

	it("query-token auth only on a GET .../watch WebSocket upgrade (including a drive literally named \"watch\")", async () => {
		const q = (path: string, init: RequestInit = {}) => selfFetch(new Request(`http://example.com${path}?token=${TOKEN}`, init));
		expect((await q("/v0/drives/watch", { method: "PUT", body: "{}" })).status).toBe(401);
		expect((await q("/v0/drives/some-drive-id/stat")).status).toBe(401);
		const d = await newDrive();
		expect((await q(`/v0/drives/${d}/watch`)).status).toBe(401); // no Upgrade header: query token not accepted
		const ws = await q(`/v0/drives/${d}/watch`, { headers: { Upgrade: "websocket" } });
		expect(ws.status).toBe(101);
		ws.webSocket?.accept();
		ws.webSocket?.close(1000, "done");
	});
});

describe("watch token expiry", () => {
	it("closes the socket with 4401 once the token expires", async () => {
		const d = await newDrive();
		const exp = Math.floor(Date.now() / 1000) + 2;
		const t = await tok(d, "read", { exp });
		const res = await selfFetch(new Request(`http://example.com/v0/drives/${d}/watch?token=${t}`, { headers: { Upgrade: "websocket" } }));
		expect(res.status).toBe(101);
		const ws = res.webSocket!;
		ws.accept();
		const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
			ws.addEventListener("close", (e: CloseEvent) => resolve({ code: e.code, reason: e.reason }));
			setTimeout(() => reject(new Error("socket not closed in time")), 8000);
		});
		expect(await closed).toEqual({ code: 4401, reason: "token_expired" });
	}, 15000);

	it("a dev-token socket is not closed by expiry logic", async () => {
		const d = await newDrive();
		const res = await selfFetch(new Request(`http://example.com/v0/drives/${d}/watch?token=${TOKEN}`, { headers: { Upgrade: "websocket" } }));
		const ws = res.webSocket!;
		ws.accept();
		let closed = false;
		ws.addEventListener("close", () => (closed = true));
		await new Promise((r) => setTimeout(r, 300));
		expect(closed).toBe(false);
		ws.close(1000, "done");
	});
});

interface Admin {
	createDrive(id: string, placement?: string): Promise<{ driveId: string; placement: string; createdAt: number }>;
	deleteDrive(id: string): Promise<{ ok: true }>;
	driveStats(id: string): Promise<{ headSeq: number; fileCount: number; bytes: number } | null>;
}
const admin = (): Admin => (exports as unknown as { DataPlaneAdmin: Admin }).DataPlaneAdmin;

describe("DataPlaneAdmin", () => {
	it("createDrive, driveStats, duplicate -> typed drive_exists error, absent -> null", async () => {
		const id = `adm-${Date.now().toString(36)}`;
		expect(await admin().driveStats(id)).toBeNull();
		const created = await admin().createDrive(id, "weur");
		expect(created).toMatchObject({ driveId: id, placement: "weur" });
		expect(created.createdAt).toBeGreaterThan(0);
		expect(await admin().driveStats(id)).toEqual({ headSeq: 0, fileCount: 0, bytes: 0 });
		await expect(admin().createDrive(id)).rejects.toMatchObject({ name: "DriveExistsError", message: expect.stringContaining("drive_exists") });
		await expect(admin().createDrive("AB")).rejects.toThrow();
		await expect(admin().createDrive(`${id}-x`, "mars")).rejects.toThrow();
		await putFile(id, "a.txt", "hello");
		expect(await admin().driveStats(id)).toEqual({ headSeq: 1, fileCount: 1, bytes: 5 });
		// a drive token minted for it works end to end
		expect((await api(`/v0/drives/${id}/stat?path=a.txt`, { token: await tok(id, "read") })).status).toBe(200);
	});

	it("deleteDrive is a soft delete: everything 404s, sockets close, stats null, id can't be reused", async () => {
		const id = `del-${Date.now().toString(36)}`;
		await admin().createDrive(id);
		await putFile(id, "a.txt", "x");
		const res = await selfFetch(new Request(`http://example.com/v0/drives/${id}/watch?token=${TOKEN}`, { headers: { Upgrade: "websocket" } }));
		const ws = res.webSocket!;
		ws.accept();
		const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e: CloseEvent) => resolve(e.code)));
		expect(await admin().deleteDrive(id)).toEqual({ ok: true });
		expect(await closed).toBe(4404);
		expect(await admin().driveStats(id)).toBeNull();
		for (const p of [`/v0/drives/${id}`, `/v0/drives/${id}/stat?path=a.txt`, `/v0/drives/${id}/list?path=`, `/v0/drives/${id}/changes?since=0`, `/v0/drives/${id}/versions?path=a.txt`]) {
			const r = await api(p);
			expect(r.status, p).toBe(404);
			expect(await r.json(), p).toEqual({ error: "no_such_drive" });
		}
		expect((await api(`/v0/drives/${id}/commit`, { json: { ops: [{ op: "mkdir", path: "z/" }] } })).status).toBe(404);
		expect((await api(`/v0/drives/${id}/shards/${"a".repeat(64)}`)).status).toBe(404);
		expect((await api(`/v0/drives/${id}/watch?since=0`, { headers: { Upgrade: "websocket" } })).status).toBe(404);
		await expect(admin().createDrive(id)).rejects.toMatchObject({ name: "DriveExistsError" });
		expect((await admin().deleteDrive(id)).ok).toBe(true); // idempotent
		expect((await admin().deleteDrive(`${id}-never`)).ok).toBe(true);
	});

	it("is not reachable over HTTP", async () => {
		const r = await api("/admin/createDrive", { json: {} });
		expect(r.status).toBe(404);
		void env;
	});
});

describe("drive existence", () => {
	it("shard and commit calls on a never-created drive are 404 (token and dev)", async () => {
		const t = await tok("ghost-drive-1", "admin");
		expect((await api(`/v0/drives/ghost-drive-1/commit`, { token: t, json: { ops: [{ op: "mkdir", path: "a/" }] } })).status).toBe(404);
		expect((await api(`/v0/drives/ghost-drive-1/shards/${"b".repeat(64)}`, { token: t, method: "PUT", body: "x" })).status).toBe(404);
		expect((await api(`/v0/drives/ghost-drive-1/shards/${"b".repeat(64)}`, { token: t, method: "GET" })).status).toBe(404);
		expect((await api(`/v0/drives/ghost-drive-1/commit`, { json: { ops: [{ op: "mkdir", path: "a/" }] } })).status).toBe(404);
		void ISS;
	});
});
