import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { type DriveAuthority } from "../src/drive";
import { GC_GRACE_MS, LineageGC } from "../src/gc";
import { INLINE_MANIFEST_BYTES, MAX_STREAM_COMMIT_BYTES, storeManifest } from "../src/manifests";
import { LIVE_TREE } from "../src/nodes";
import { parseOps } from "../src/validate";
import { api, bytes, commit, newDrive, putFile, selfFetch, sha256Hex, TOKEN, upload } from "./helpers";

const stubFor = (drive: string) => {
	const ns = env.DRIVE_AUTHORITY as DurableObjectNamespace<DriveAuthority>;
	return ns.get(ns.idFromName(drive));
};
const manifest = async (drive: string, path: string, version = "") => {
	const response = await api(`/v0/drives/${drive}/manifest?path=${path}${version ? `&versionId=${version}` : ""}`);
	expect(response.status).toBe(200);
	return response.json() as Promise<{ versionId: string; shards: { h: string; n: number }[]; blockUrls: Record<string, string>; blockUrlsExpireAt: number }>;
};
const nodes = (drive: string) => runInDurableObject(stubFor(drive), (_instance, ctx) => ctx.storage.sql.exec("SELECT * FROM nodes ORDER BY id").toArray());

function streamRequest(drive: string, text: string) {
	const data = bytes(text);
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({ pull(controller) {
		if (offset === data.length) return controller.close();
		const end = Math.min(offset + 4093, data.length);
		controller.enqueue(data.slice(offset, end));
		offset = end;
	} });
	return new Request(`http://example.com/v0/drives/${drive}/commit`, {
		method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/x-ndjson" }, body,
	});
}

describe("M2 stable node tree", () => {
	it("changes only the folder root on rename/delete, keeps child IDs and heads, and isolates recreated roots", async () => {
		const drive = await newDrive();
		await putFile(drive, "a/deep/f", "hello");
		const before = await nodes(drive);
		const root = before.find((n) => n.name === "a")!;
		const descendants = before.filter((n) => n.id !== root.id);
		expect((await commit(drive, [{ op: "rename", from: "a/", to: "b/" }])).status).toBe(200);
		const renamed = await nodes(drive);
		expect(renamed.filter((n) => n.id !== root.id)).toEqual(descendants);
		expect(renamed.find((n) => n.name === "b")?.id).toBe(root.id);
		expect((await manifest(drive, "b/deep/f")).shards).toHaveLength(1);
		expect((await commit(drive, [{ op: "delete", path: "b/" }])).status).toBe(200);
		const deleted = await nodes(drive);
		expect(deleted.filter((n) => n.id !== root.id)).toEqual(descendants);
		expect(deleted.find((n) => n.id === root.id)?.parent_id).toBeNull();
		expect((await api(`/v0/drives/${drive}/stat?path=b/deep/f`)).status).toBe(404);
		expect((await commit(drive, [{ op: "mkdir", path: "b/" }])).status).toBe(200);
		expect(await (await api(`/v0/drives/${drive}/list?path=b/`)).json()).toMatchObject({ entries: [] });
		expect(await (await api(`/v0/drives/${drive}`)).json()).toMatchObject({ fileCount: 0, bytes: 0 });
	});

	it("migrates an existing M0 DO transactionally and survives eviction", async () => {
		const drive = await newDrive();
		await putFile(drive, "old/child", "retained");
		const original = await manifest(drive, "old/child");
		await runInDurableObject(stubFor(drive), (_instance, ctx) => {
			const sql = ctx.storage.sql;
			const rows = sql.exec(LIVE_TREE + " SELECT * FROM tree").toArray();
			sql.exec("DROP TABLE nodes");
			sql.exec("CREATE TABLE nodes(path TEXT PRIMARY KEY,type TEXT NOT NULL,head TEXT,size INTEGER,ctype TEXT,mtime INTEGER,seq INTEGER,parent TEXT NOT NULL)");
			sql.exec("CREATE INDEX nodes_parent ON nodes(parent,path)");
			for (const r of rows) {
				const path = String(r.path);
				const at = path.lastIndexOf("/");
				sql.exec("INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?)", path, r.type!, r.head!, r.size!, r.ctype!, r.mtime!, r.seq!, at < 0 ? "" : path.slice(0, at));
			}
		});
		await evictDurableObject(stubFor(drive));
		expect((await manifest(drive, "old/child")).versionId).toBe(original.versionId);
		expect((await nodes(drive)).every((n) => typeof n.id === "string" && !("path" in n))).toBe(true);
		expect((await commit(drive, [{ op: "rename", from: "old/", to: "new/" }])).status).toBe(200);
		await evictDurableObject(stubFor(drive));
		expect((await manifest(drive, "new/child")).shards).toEqual(original.shards);
		expect(await (await api(`/v0/drives/${drive}`)).json()).toMatchObject({ fileCount: 1, bytes: 8 });
	});
});

describe("M2 R2 manifests and streamed commits", () => {
	it("keeps the threshold inline and stores content-addressed bytes strictly above 256 KiB", async () => {
		const drive = await newDrive();
		const inline = " ".repeat(INLINE_MANIFEST_BYTES);
		expect(await storeManifest(env.SHARDS, drive, inline)).toBe(inline);
		const large = inline + " ";
		const hash = await sha256Hex(bytes(large));
		expect(await storeManifest(env.SHARDS, drive, large)).toBe(`r2:${hash}`);
		expect(await (await env.SHARDS.get(`manifests/${drive}/${hash}`))!.text()).toBe(large);
	});

	it("streams a >1 MiB operation without Content-Length, spills it, and supports historical reads/rename/restore", async () => {
		const drive = await newDrive();
		const shard = await upload(drive, bytes("x"));
		const shards = Array.from({ length: 16000 }, () => shard);
		const op = { op: "put", path: "big", size: shards.length, shards };
		const text = JSON.stringify(op) + "\n";
		expect(bytes(text).length).toBeGreaterThan(1024 * 1024);
		const response = await selfFetch(streamRequest(drive, text));
		expect(response.status).toBe(200);
		const first = await manifest(drive, "big");
		expect(first.shards).toEqual(shards);
		const ref = await runInDurableObject(stubFor(drive), (_instance, ctx) => ctx.storage.sql.exec<{ manifest: string }>("SELECT manifest FROM versions WHERE path='big'").one().manifest);
		const hash = await sha256Hex(bytes(JSON.stringify(shards.map(({ h, n }) => [h, n]))));
		expect(ref).toBe(`r2:${hash}`);
		expect((await env.SHARDS.head(`manifests/${drive}/${hash}`))?.size).toBeGreaterThan(INLINE_MANIFEST_BYTES);
		await putFile(drive, "big", "small");
		expect((await manifest(drive, "big", first.versionId)).shards).toEqual(shards);
		expect((await api(`/v0/drives/${drive}/restore`, { json: { path: "big", versionId: first.versionId } })).status).toBe(200);
		expect((await commit(drive, [{ op: "rename", from: "big", to: "moved" }])).status).toBe(200);
		expect((await manifest(drive, "moved")).shards).toEqual(shards);
	});

	it("rolls back a stream with a malformed final line and caps an unbounded stream", async () => {
		const drive = await newDrive();
		expect((await selfFetch(streamRequest(drive, '{"op":"mkdir","path":"never/"}\n{broken'))).status).toBe(400);
		expect((await api(`/v0/drives/${drive}/stat?path=never/`)).status).toBe(404);
		let pulled = 0;
		const chunk = new Uint8Array(64 * 1024).fill(32);
		const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled += chunk.length; controller.enqueue(chunk); } });
		const response = await selfFetch(new Request(`http://example.com/v0/drives/${drive}/commit`, {
			method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/x-ndjson" }, body,
		}));
		expect(response.status).toBe(413);
		expect(pulled).toBeLessThan(MAX_STREAM_COMMIT_BYTES + 256 * 1024);
	});
});

describe("M2 signed zone-cache block delivery", () => {
	it("signs URLs, serves complete/ranged data, caches misses, rejects tampering and expiry before cache hits", async () => {
		const drive = await newDrive();
		await putFile(drive, "file", "abcdef");
		const m = await manifest(drive, "file");
		const url = m.blockUrls[m.shards[0]!.h]!;
		const response = await selfFetch(new Request(url));
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toContain("immutable");
		expect(await response.text()).toBe("abcdef");
		const canonical = new URL(url); canonical.search = "";
		// waitUntil is drained by the test runner request context.
		await vi.waitFor(async () => expect(await caches.default.match(canonical.toString())).toBeDefined());
		const ranged = await selfFetch(new Request(url, { headers: { Range: "bytes=1-3" } }));
		expect(ranged.status).toBe(206);
		expect(await ranged.text()).toBe("bcd");
		for (const [name, value] of [["d", "another-drive"], ["exp", String(m.blockUrlsExpireAt + 1)], ["exp", "1"], ["sig", "0".repeat(64)]]) {
			const invalid = new URL(url); invalid.searchParams.set(name!, value!);
			expect((await selfFetch(new Request(invalid))).status).toBe(401);
		}
		expect((await selfFetch(new Request(canonical))).status).toBe(401);
		const changedPath = new URL(url); changedPath.pathname = changedPath.pathname.replace(m.shards[0]!.h, "0".repeat(64));
		expect((await selfFetch(new Request(changedPath))).status).toBe(401);
		await stubFor(drive).delete();
		expect((await selfFetch(new Request(url))).status).toBe(404);
	});
});

async function gcUntilDone(drive: string, now: number, dryRun = true) {
	return runInDurableObject(stubFor(drive), async (_instance, ctx) => {
		const gc = new LineageGC(ctx.storage.sql, env.SHARDS, drive);
		const gen = Number(ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k='head_seq'").one().v);
		for (let i = 0; i < 20; i++) {
			const result = await gc.step(gen, now, dryRun);
			if (result.done) return result;
		}
		throw new Error("GC did not finish");
	});
}

describe("M2 lineage GC", () => {
	it("defaults to dry-run, then deletes only old orphans; keeps current/history/deleted-file references and other lineages", async () => {
		const drive = await newDrive();
		const other = await newDrive();
		const orphan = await upload(drive, bytes("orphan"));
		await env.SHARDS.put(`shards/${other}/${orphan.h}`, bytes("orphan"));
		await putFile(drive, "f", "history");
		await putFile(drive, "f", "head");
		await putFile(drive, "deleted", "retained");
		await commit(drive, [{ op: "delete", path: "deleted" }]);
		const future = Date.now() + GC_GRACE_MS + 60_000;
		expect(await gcUntilDone(drive, future)).toMatchObject({ done: true, dryRun: true, candidates: 1, deleted: 0 });
		expect(await env.SHARDS.head(`shards/${drive}/${orphan.h}`)).not.toBeNull();
		expect(await gcUntilDone(drive, future, false)).toMatchObject({ done: true, dryRun: false, candidates: 1, deleted: 1 });
		expect(await env.SHARDS.head(`shards/${drive}/${orphan.h}`)).toBeNull();
		expect(await stubFor(drive).filterUnknown([orphan.h])).toMatchObject({ data: [orphan.h] });
		expect(await env.SHARDS.head(`shards/${other}/${orphan.h}`)).not.toBeNull();
		for (const content of ["history", "head", "retained"]) expect(await env.SHARDS.head(`shards/${drive}/${await sha256Hex(bytes(content))}`)).not.toBeNull();
	});

	it("keeps young orphans and retained R2 manifests even on a soft-deleted drive", async () => {
		const drive = await newDrive();
		const shard = await upload(drive, bytes("retained-large"));
		expect((await commit(drive, [{ op: "put", path: "big", size: shard.n * 4000, shards: Array.from({ length: 4000 }, () => shard) }])).status).toBe(200);
		const orphan = await upload(drive, bytes("young"));
		await stubFor(drive).delete();
		expect(await gcUntilDone(drive, Date.now(), false)).toMatchObject({ candidates: 0, deleted: 0 });
		expect(await env.SHARDS.head(`shards/${drive}/${orphan.h}`)).not.toBeNull();
		expect(await gcUntilDone(drive, Date.now() + GC_GRACE_MS + 60_000, false)).toMatchObject({ candidates: 1, deleted: 1 });
		expect(await env.SHARDS.head(`shards/${drive}/${shard.h}`)).not.toBeNull();
	});

	it("restarts a stale mark snapshot when a new commit references an orphan", async () => {
		const drive = await newDrive();
		const shard = await upload(drive, bytes("newly-referenced"));
		const future = Date.now() + GC_GRACE_MS + 60_000;
		await runInDurableObject(stubFor(drive), async (_instance, ctx) => {
			const result = await new LineageGC(ctx.storage.sql, env.SHARDS, drive).step(0, future, false);
			expect(result.done).toBe(false);
		});
		expect((await commit(drive, [{ op: "put", path: "f", size: shard.n, shards: [shard] }])).status).toBe(200);
		expect(await gcUntilDone(drive, future, false)).toMatchObject({ candidates: 0, deleted: 0 });
		expect(await env.SHARDS.head(`shards/${drive}/${shard.h}`)).not.toBeNull();
	});

	it("rechecks stale Worker confirmations and shares/reschedules the alarm without sockets", async () => {
		const drive = await newDrive();
		const shard = await upload(drive, bytes("gone"));
		await gcUntilDone(drive, Date.now() + GC_GRACE_MS + 60_000, false);
		const ops = parseOps({ ops: [{ op: "put", path: "no", size: shard.n, shards: [shard] }] });
		if (!Array.isArray(ops)) throw new Error("invalid fixture");
		expect(await stubFor(drive).commit(ops, [[shard.h, shard.n]], "test")).toMatchObject({ ok: false, status: 409 });
		// Make GC due now and invoke the alarm handler directly: runDurableObjectAlarm only fires an
		// alarm that is still scheduled, and the commit above may have rescheduled it.
		await runInDurableObject(stubFor(drive), async (instance, ctx) => {
			ctx.storage.sql.exec("UPDATE meta SET v='0' WHERE k='gc_next_at'");
			await (instance as unknown as { alarm(): Promise<void> }).alarm();
		});
		await runInDurableObject(stubFor(drive), async (_instance, ctx) => {
			expect(await ctx.storage.getAlarm()).not.toBeNull();
			expect(ctx.storage.sql.exec("SELECT 1 FROM gc_state").toArray()).toHaveLength(1);
		});
	});
});
