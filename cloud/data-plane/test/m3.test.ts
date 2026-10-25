import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriveAuthority } from "../src/drive";
import type { DataPlaneAdmin } from "../src/index";
import { signBlocks } from "../src/blocks";
import { GC_GRACE_MS, LineageGC } from "../src/gc";
import { parseOps } from "../src/validate";
import { api, bytes, commit, newDrive, putFile, selfFetch, TOKEN, upload } from "./helpers";

const admin = (exports as unknown as {DataPlaneAdmin: Pick<DataPlaneAdmin, "forkDrive" | "restoreSnapshot" | "driveStats" | "deleteDrive">}).DataPlaneAdmin;
const stubFor = (id: string) => {
	const ns = env.DRIVE_AUTHORITY as DurableObjectNamespace<DriveAuthority>;
	return ns.get(ns.idFromName(id));
};
let counter = 0;
const childId = () => `fork-${Date.now().toString(36)}-${counter++}`;
const get = async (drive: string, route: string) => {
	const response = await api(`/v0/drives/${drive}/${route}`);
	expect(response.status).toBe(200);
	return response.json() as Promise<Record<string, any>>;
};
afterEach(() => vi.restoreAllMocks());

async function sweep(drive: string, now: number) {
	return runInDurableObject(stubFor(drive), async (_instance, ctx) => {
		const sql = ctx.storage.sql;
		const gc = new LineageGC(sql, env.SHARDS, drive);
		const seq = Number(sql.exec<{v: string}>("SELECT v FROM meta WHERE k='head_seq'").one().v);
		for (let i = 0; i < 20; i++) { const r = await gc.step(seq, now, false); if (r.done) return r; }
		throw new Error("sweep did not finish");
	});
}

async function snapshot(drive: string) {
	return runInDurableObject(stubFor(drive), async (instance, ctx) => {
		ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES('snapshot_at','0')");
		return instance.snapshot();
	});
}

describe("M3 forks", () => {
	it("copies paged metadata and retained history without copying R2 bytes, bills only divergent shards, and survives eviction", async () => {
		const source = await newDrive("apac");
		await putFile(source, "f", "old");
		const first = await get(source, "manifest?path=f");
		await putFile(source, "f", "current");
		await commit(source, Array.from({length: 120}, (_, i) => ({op: "put", path: `empty-${i}`, size: 0, shards: []})));
		const before = (await env.SHARDS.list({prefix: `shards/${source}/`})).objects.map(o => o.key);
		const child = childId();
		const fork = await admin.forkDrive(source, child);
		expect(fork).toMatchObject({sourceId: source, driveId: child, lineage: source, forkSeq: 3, placement: "apac"});
		expect((await env.SHARDS.list({prefix: `shards/${source}/`})).objects.map(o => o.key)).toEqual(before);
		expect((await env.SHARDS.list({prefix: `shards/${child}/`})).objects).toEqual([]);
		expect(await admin.driveStats(child)).toMatchObject({headSeq: 3, fileCount: 121, bytes: 7, ownBytes: 0, depth: 1, lineage: source, forkOf: {driveId: source, forkPoint: fork.forkPoint}});
		expect((await get(child, `manifest?path=f&versionId=${first.versionId}`)).shards).toEqual(first.shards);
		expect(await get(child, "versions?path=f")).toEqual(await get(source, "versions?path=f"));
		expect((await get(child, "changes?since=0")).changes).toMatchObject([{seq: 3, op: "resync"}]);
		await putFile(source, "parent-only", "parent");
		await putFile(child, "child-only", "child");
		expect((await api(`/v0/drives/${child}/stat?path=parent-only`)).status).toBe(404);
		expect((await api(`/v0/drives/${source}/stat?path=child-only`)).status).toBe(404);
		expect(await admin.driveStats(child)).toMatchObject({ownBytes: 5, bytes: 12, headSeq: 4});
		expect(await admin.driveStats(source)).toMatchObject({ownBytes: 16});
		await evictDurableObject(stubFor(child));
		expect(await admin.driveStats(child)).toMatchObject({ownBytes: 5, lineage: source, depth: 1});
		const m = await get(child, "manifest?path=f");
		const url = m.blockUrls[m.shards[0].h];
		expect(new URL(url).pathname).toContain(`/_blocks/${source}/`);
		expect(new URL(url).searchParams.get("d")).toBe(child);
		expect(await (await selfFetch(new Request(url))).text()).toBe("current");
		const other = await newDrive();
		const forged = await signBlocks("http://example.com", other, m.shards, env.ULS_BLOCK_KEY, source);
		expect((await selfFetch(new Request(forged.blockUrls[m.shards[0].h]!))).status).toBe(401);
	});

	it("freezes export pages behind queued commits while subsequent parent writes remain independent", async () => {
		const source = await newDrive();
		const shard = await upload(source, bytes("queued"));
		const ops = parseOps({ops: [{op: "put", path: "queued", size: shard.n, shards: [shard]}]});
		if (!Array.isArray(ops)) throw new Error("fixture");
		await runInDurableObject(stubFor(source), async (instance) => {
			const commit = instance.commit(ops, [], "test");
			const exported = instance.beginExport();
			expect((await commit).ok).toBe(true);
			const result = await exported;
			if (!result.ok) throw new Error("export failed");
			expect(result.data.seq).toBe(1);
			const pages = instance.exportPage(result.data.token);
			expect(pages.rows.some(r => r.payload.includes('"name":"queued"'))).toBe(true);
			instance.endExport(result.data.token);
		});
		const frozen = await stubFor(source).beginExport();
		if (!frozen.ok) throw new Error("export failed");
		await putFile(source, "later", "later");
		const rows = await stubFor(source).exportPage(frozen.data.token);
		expect(rows.rows.some(r => r.payload.includes('"name":"later"'))).toBe(false);
		await stubFor(source).endExport(frozen.data.token);
	});

	it("rejects missing sources, duplicates and depth 9", async () => {
		await expect(admin.forkDrive("no-such-drive", childId())).rejects.toThrow("no_such_drive");
		const source = await newDrive();
		await expect(admin.forkDrive(source, source)).rejects.toThrow("drive_exists");
		let parent = source;
		for (let depth = 1; depth <= 8; depth++) {
			const child = childId(); await admin.forkDrive(parent, child);
			expect(await admin.driveStats(child)).toMatchObject({depth, lineage: source});
			parent = child;
		}
		await expect(admin.forkDrive(parent, childId())).rejects.toThrow("fork_depth_exceeded");
	});

	it("returns slow_down at 60 seconds without exporting stale state", async () => {
		const source = await newDrive();
		await runInDurableObject(stubFor(source), async instance => {
			vi.useFakeTimers();
			const state = instance as unknown as {pendingIO: Promise<unknown>};
			let release!: () => void;
			state.pendingIO = new Promise<void>(resolve => { release = resolve; });
			try {
				const pending = instance.beginExport();
				const membership = instance.member("expired-child", false, Date.now() + 60_000);
				await vi.advanceTimersByTimeAsync(60_000);
				expect(await pending).toMatchObject({ok: false, status: 503, body: {error: "slow_down"}});
				expect(await membership).toBe(false);
				release();
				await state.pendingIO;
			} finally { release(); vi.useRealTimers(); }
		});
	});

	it("soft deletes access, hard drops metadata, and records removed membership without touching shared bytes", async () => {
		const source = await newDrive(); await putFile(source, "f", "shared");
		const child = childId(); await admin.forkDrive(source, child);
		await admin.deleteDrive(child);
		expect(await admin.driveStats(child)).toBeNull();
		await admin.deleteDrive(child, {hard: true});
		expect(await get(source, "stat?path=f")).toMatchObject({size: 6});
		await runInDurableObject(stubFor(child), (_instance, ctx) => {
			expect(ctx.storage.sql.exec("SELECT 1 FROM versions").toArray()).toEqual([]);
			expect(ctx.storage.sql.exec("SELECT 1 FROM nodes").toArray()).toEqual([]);
		});
		await runInDurableObject(stubFor(source), (_instance, ctx) => {
			expect(ctx.storage.sql.exec<{removed_at: number}>("SELECT removed_at FROM lineage_members WHERE drive_id=?", child).one().removed_at).toBeGreaterThan(0);
		});
	});
});

describe("M3 lineage sweep races", () => {
	it("abandons a sweep already in progress when a fork joins", async () => {
		const source = await newDrive(); const orphan = await upload(source, bytes("orphan"));
		const future = Date.now() + GC_GRACE_MS + 60_000;
		await runInDurableObject(stubFor(source), async (_instance, ctx) => {
			expect(await new LineageGC(ctx.storage.sql, env.SHARDS, source).step(0, future, false)).toMatchObject({done: false});
		});
		await admin.forkDrive(source, childId());
		expect(await sweep(source, future)).toMatchObject({done: true, dryRun: true, deleted: 0});
		expect(await env.SHARDS.head(`shards/${source}/${orphan.h}`)).not.toBeNull();
	});

	it("protects a child write during a parent sweep and refuses local child sweeping", async () => {
		const source = await newDrive(); const child = childId(); await admin.forkDrive(source, child);
		const orphan = await upload(child, bytes("child-reference"));
		const future = Date.now() + GC_GRACE_MS + 60_000;
		const sweeping = sweep(source, future);
		expect((await commit(child, [{op: "put", path: "f", size: orphan.n, shards: [orphan]}])).status).toBe(200);
		expect(await sweeping).toMatchObject({deleted: 0});
		expect(await stubFor(child).gcStep()).toMatchObject({deleted: 0, dryRun: true});
		expect(await env.SHARDS.head(`shards/${source}/${orphan.h}`)).not.toBeNull();
	});
});

describe("M3 snapshots", () => {
	it("rebuilds list/stat/manifest/versions and the log from gzip into an empty DO", async () => {
		const source = await newDrive("weur");
		await putFile(source, "dir/f", "old"); await putFile(source, "dir/f", "new");
		const routes = ["list?path=", "list?path=dir/", "stat?path=dir/f", "manifest?path=dir/f", "versions?path=dir/f", "changes?since=0"];
		const before = await Promise.all(routes.map(route => get(source, route)));
		const key = await snapshot(source);
		expect(key).toBe(`snapshots/${source}/2.ndjson.gz`);
		const object = await env.SHARDS.get(key!);
		const text = await new Response(object!.body.pipeThrough(new DecompressionStream("gzip"))).text();
		expect(JSON.parse(text.split("\n")[0]!)).toMatchObject({format: 1, driveId: source, seq: 2});
		await expect(admin.restoreSnapshot(source, key!)).rejects.toThrow("drive_exists");
		await admin.deleteDrive(source, {hard: true});
		expect(await admin.driveStats(source)).toBeNull();
		expect(await admin.restoreSnapshot(source, key!)).toEqual({ok: true});
		const after = await Promise.all(routes.map(route => get(source, route)));
		// Signed URL expiries are transport metadata; compare the retained manifest itself.
		for (const rows of [before, after]) for (const row of rows) { delete row.blockUrls; delete row.blockUrlsExpireAt; }
		expect(after).toEqual(before);
		expect(await admin.driveStats(source)).toMatchObject({ownBytes: 6, bytes: 3, headSeq: 2, lineage: source});
	});

	it("writes from the alarm only after six hours and sequence advancement, keeping newest seven", async () => {
		const source = await newDrive(); await putFile(source, "f", "v1");
		expect(await stubFor(source).snapshot()).toBeNull();
		await runInDurableObject(stubFor(source), async (instance, ctx) => {
			ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES('snapshot_at','0')");
			await instance.alarm();
		});
		expect((await env.SHARDS.list({prefix: `snapshots/${source}/`})).objects).toHaveLength(1);
		expect(await stubFor(source).snapshot()).toBeNull();
		await putFile(source, "f", "v2");
		expect(await stubFor(source).snapshot()).toBeNull();
		await snapshot(source);
		expect(await snapshot(source)).toBeNull();
		for (let n = 3; n <= 9; n++) { await putFile(source, "f", `v${n}`); await snapshot(source); }
		const keys = (await env.SHARDS.list({prefix: `snapshots/${source}/`})).objects.map(o => o.key);
		expect(keys).toHaveLength(7);
		expect(keys).not.toContain(`snapshots/${source}/1.ndjson.gz`);
		expect(keys).not.toContain(`snapshots/${source}/2.ndjson.gz`);
		expect(keys).toContain(`snapshots/${source}/9.ndjson.gz`);
	});
});

describe("M3 CORS", () => {
	it("allows exact origins on preflights, successes, authentication errors and signed-block errors", async () => {
		const source = await newDrive();
		for (const path of [`/v0/drives/${source}`, "/_blocks/invalid/path"]) {
			const preflight = await api(path, {method: "OPTIONS", token: null, headers: {Origin: "http://localhost:5173"}});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
			expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, PUT");
			expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Content-Type");
			expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBeNull();
			for (const token of [TOKEN, null]) {
				const response = await api(path, {token, headers: {Origin: "http://localhost:5173"}});
				expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
				expect(response.headers.get("Vary")).toContain("Origin");
			}
			for (const origin of ["https://evil.test", "http://localhost:5173.evil.test"]) {
				const response = await api(path, {headers: {Origin: origin}});
				expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
				expect(response.headers.get("Vary")).toContain("Origin");
			}
		}
	});
});

describe("M3 compatibility and historical manifests", () => {
	it("defaults old DO metadata to its existing R2 namespace and migrates inherited flags", async () => {
		const source = await newDrive(); await putFile(source, "f", "old-layout");
		await runInDurableObject(stubFor(source), (_instance, ctx) => {
			const sql = ctx.storage.sql;
			sql.exec("DELETE FROM meta WHERE k IN ('lineage','depth')");
			sql.exec("ALTER TABLE shards_known RENAME TO old_shards");
			sql.exec("CREATE TABLE shards_known(h TEXT PRIMARY KEY,n INTEGER NOT NULL)");
			sql.exec("INSERT INTO shards_known SELECT h,n FROM old_shards");
			sql.exec("DROP TABLE old_shards");
		});
		await evictDurableObject(stubFor(source));
		expect(await admin.driveStats(source)).toMatchObject({lineage: source, depth: 0, ownBytes: 10});
		const m = await get(source, "manifest?path=f");
		expect(await (await api(`/v0/drives/${source}/shards/${m.shards[0].h}`)).text()).toBe("old-layout");
	});

	it("reads inherited spilled manifests and resumes a child watcher at the fork boundary", async () => {
		const source = await newDrive(); const shard = await upload(source, bytes("x"));
		expect((await commit(source, [{op: "put", path: "large", size: 4000, shards: Array.from({length: 4000}, () => shard)}])).status).toBe(200);
		const original = await get(source, "manifest?path=large");
		const child = childId(); await admin.forkDrive(source, child);
		expect((await env.SHARDS.list({prefix: `manifests/${source}/`})).objects).toHaveLength(1);
		expect((await env.SHARDS.list({prefix: `manifests/${child}/`})).objects).toHaveLength(0);
		expect((await get(child, "manifest?path=large")).shards).toEqual(original.shards);
		await putFile(source, "large", "parent-update");
		expect((await get(child, `manifest?path=large&versionId=${original.versionId}`)).shards).toEqual(original.shards);
		const response = await api(`/v0/drives/${child}/watch?since=1`, {headers: {Upgrade: "websocket"}});
		expect(response.status).toBe(101);
		const ws = response.webSocket!; ws.accept();
		const messages: Record<string, unknown>[] = [];
		ws.addEventListener("message", e => { messages.push(JSON.parse(String(e.data))); });
		try {
			await putFile(source, "parent-only", "parent");
			await putFile(child, "child-only", "child");
			await vi.waitFor(() => expect(messages.some(m => m.path === "child-only")).toBe(true));
			expect(messages.every(m => m.path !== "parent-only")).toBe(true);
			expect(messages.filter(m => m.type === "change")).toMatchObject([{seq: 2, path: "child-only"}]);
		} finally { ws.close(); }
		const key = await snapshot(child);
		await admin.deleteDrive(child, {hard: true});
		await admin.restoreSnapshot(child, key!);
		expect((await get(child, "manifest?path=large")).shards).toEqual(original.shards);
		expect(await admin.driveStats(child)).toMatchObject({lineage: source, ownBytes: 5, depth: 1});
	});
});


describe("M3 export and alarm cleanup", () => {
	it("keeps frozen pages valid across source hard deletion", async () => {
		const source = await newDrive(); await putFile(source, "retained", "data");
		const result = await stubFor(source).beginExport();
		if (!result.ok) throw new Error("export failed");
		await admin.deleteDrive(source, {hard: true});
		const page = await stubFor(source).exportPage(result.data.token);
		expect(page.rows.some(r => r.payload.includes('"name":"retained"'))).toBe(true);
		await stubFor(source).endExport(result.data.token);
		expect((await stubFor(source).exportPage(result.data.token)).rows).toEqual([]);
	});

	it("advances an idle snapshot alarm without a tight retry loop", async () => {
		const source = await newDrive();
		await runInDurableObject(stubFor(source), async (instance, ctx) => {
			ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES('created_at','0')");
			ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES('snapshot_next_at','0')");
			await ctx.storage.deleteAlarm();
			await instance.alarm();
			expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);
		});
	});

	it("rejects malformed snapshot rows and removes the empty import reservation", async () => {
		const drive = childId();
		const key = `snapshots/${drive}/1.ndjson.gz`;
		const text = JSON.stringify({format: 1, driveId: drive, lineage: drive, depth: 0, seq: 1, ts: Date.now(), placement: null}) + "\n" +
			JSON.stringify({table: "invalid_table", row: {}}) + "\n";
		const compressed = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
		await env.SHARDS.put(key, compressed);
		await expect(admin.restoreSnapshot(drive, key)).rejects.toThrow("invalid snapshot row");
		expect(await admin.driveStats(drive)).toBeNull();
		const token = "retry-token";
		expect(await stubFor(drive).reserveImport(token)).toMatchObject({ok: true});
		await stubFor(drive).cancelImport(token);
	});
});
