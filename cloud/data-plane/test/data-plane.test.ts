import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, bytes, commit, newDrive, putFile, selfFetch, sha256Hex, TOKEN, upload } from "./helpers";

const ULID_RE = /^v_[0-9A-HJKMNP-TV-Z]{26}$/;

describe("auth", () => {
	it("401 without a token, with a wrong token; healthz is exempt", async () => {
		const r = await api("/v0/drives/abc", { token: null });
		expect(r.status).toBe(401);
		expect(await r.json()).toEqual({ error: "unauthorized" });
		expect((await api("/v0/drives/abc", { token: "nope" })).status).toBe(401);
		expect((await api("/healthz", { token: null })).status).toBe(200);
	});
});

describe("drives", () => {
	it("create, conflict, get, 404", async () => {
		const id = await newDrive("weur");
		const dup = await api(`/v0/drives/${id}`, { method: "PUT", json: {} });
		expect(dup.status).toBe(409);
		expect(await dup.json()).toEqual({ error: "drive_exists" });
		const g = await api(`/v0/drives/${id}`);
		expect(g.status).toBe(200);
		expect(await g.json()).toMatchObject({ driveId: id, placement: "weur", headSeq: 0, fileCount: 0, bytes: 0 });
		const missing = await api("/v0/drives/no-such-drive-xyz");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "no_such_drive" });
	});

	it("rejects bad driveId and bad placement", async () => {
		expect((await api("/v0/drives/AB", { method: "PUT", json: {} })).status).toBe(400);
		expect((await api("/v0/drives/valid-id", { method: "PUT", json: { placement: "mars" } })).status).toBe(400);
	});
});

describe("shards", () => {
	it("PUT happy path then duplicate, then GET with headers and ranges", async () => {
		const d = await newDrive();
		const data = bytes("hello shard world");
		const h = await sha256Hex(data);
		const r1 = await api(`/v0/drives/${d}/shards/${h}`, { method: "PUT", body: data });
		expect(r1.status).toBe(201);
		expect(await r1.json()).toEqual({ hash: h, size: data.byteLength, stored: true });
		const r2 = await api(`/v0/drives/${d}/shards/${h}`, { method: "PUT", body: data });
		expect(r2.status).toBe(200);
		expect(await r2.json()).toEqual({ hash: h, size: data.byteLength, stored: false });

		const g = await api(`/v0/drives/${d}/shards/${h}`);
		expect(g.status).toBe(200);
		expect(g.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect(g.headers.get("ETag")).toBe(`"${h}"`);
		expect(new Uint8Array(await g.arrayBuffer())).toEqual(data);

		const rg = await api(`/v0/drives/${d}/shards/${h}`, { headers: { Range: "bytes=6-10" } });
		expect(rg.status).toBe(206);
		expect(rg.headers.get("Content-Range")).toBe(`bytes 6-10/${data.byteLength}`);
		expect(await rg.text()).toBe("shard");

		const missing = await api(`/v0/drives/${d}/shards/${"0".repeat(64)}`);
		expect(missing.status).toBe(404);
	});

	it("hash mismatch returns 400 and leaves nothing stored", async () => {
		const d = await newDrive();
		const wrong = "a".repeat(64);
		const r = await api(`/v0/drives/${d}/shards/${wrong}`, { method: "PUT", body: bytes("not that hash") });
		expect(r.status).toBe(400);
		expect(await r.json()).toEqual({ error: "hash_mismatch" });
		expect(await env.SHARDS.head(`shards/${d}/${wrong}`)).toBeNull();
	});

	it("hash mismatch does not delete a pre-existing object under that key", async () => {
		const d = await newDrive();
		const good = bytes("the real shard");
		const h = await sha256Hex(good);
		await upload(d, good);
		const r = await api(`/v0/drives/${d}/shards/${h}`, { method: "PUT", body: bytes("different bytes") });
		expect(r.status).toBe(400);
		expect(await env.SHARDS.head(`shards/${d}/${h}`)).not.toBeNull();
	});

	it("too large: Content-Length over 16 MiB gets 413", async () => {
		const d = await newDrive();
		const big = new Uint8Array(16 * 1024 * 1024 + 1);
		const r = await api(`/v0/drives/${d}/shards/${"b".repeat(64)}`, { method: "PUT", body: big });
		expect(r.status).toBe(413);
		expect(await r.json()).toEqual({ error: "too_large" });
	});

	it("accepts a shard of exactly 16 MiB", async () => {
		const d = await newDrive();
		const data = new Uint8Array(16 * 1024 * 1024).fill(7);
		const s = await upload(d, data);
		expect(s.n).toBe(16 * 1024 * 1024);
	});

	it("PUT to a drive that does not exist is 404", async () => {
		const h = await sha256Hex(bytes("x"));
		const r = await api(`/v0/drives/ghost-drive/shards/${h}`, { method: "PUT", body: bytes("x") });
		expect(r.status).toBe(404);
	});

	it("/missing reports unknown hashes, and finds shards present in R2 only", async () => {
		const d = await newDrive();
		const a = await upload(d, bytes("alpha"));
		const unknownHash = "c".repeat(64);
		const r = await api(`/v0/drives/${d}/shards/missing`, { json: { hashes: [a.h, unknownHash] } });
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ missing: [unknownHash] });

		// present in R2 but never recorded in shards_known (e.g. written before the DO learned of it)
		const raw = bytes("written straight to r2");
		const h = await sha256Hex(raw);
		await env.SHARDS.put(`shards/${d}/${h}`, raw);
		const r2 = await api(`/v0/drives/${d}/shards/missing`, { json: { hashes: [h] } });
		expect(await r2.json()).toEqual({ missing: [] });

		const tooMany = Array.from({ length: 1001 }, (_, i) => i.toString(16).padStart(64, "0"));
		expect((await api(`/v0/drives/${d}/shards/missing`, { json: { hashes: tooMany } })).status).toBe(400);
	});
});

describe("commit", () => {
	it("put creates parents, returns seq/results, and stat/list/manifest agree", async () => {
		const d = await newDrive();
		const r = await putFile(d, "cuts/day1/a.txt", "AAAA");
		expect(r.status).toBe(200);
		const body = (await r.json()) as { seq: number; results: { path: string; versionId: string; size: number }[] };
		expect(body.seq).toBe(1);
		expect(body.results).toHaveLength(1);
		expect(body.results[0]!.path).toBe("cuts/day1/a.txt");
		expect(body.results[0]!.versionId).toMatch(ULID_RE);
		expect(body.results[0]!.size).toBe(4);

		const st = await (await api(`/v0/drives/${d}/stat?path=cuts/day1/a.txt`)).json();
		expect(st).toEqual({ path: "cuts/day1/a.txt", type: "file", versionId: body.results[0]!.versionId, size: 4, contentType: "text/plain", mtimeMs: 1700000000000, seq: 1 });
		const folder = (await (await api(`/v0/drives/${d}/stat?path=cuts/`)).json()) as { type: string; path: string };
		expect(folder).toMatchObject({ type: "folder", path: "cuts/" });
		expect((await api(`/v0/drives/${d}/stat?path=nope`)).status).toBe(404);

		const root = (await (await api(`/v0/drives/${d}/list?path=`)).json()) as { entries: { name: string; type: string }[]; cursor: string | null };
		expect(root.entries.map((e) => [e.name, e.type])).toEqual([["cuts", "folder"]]);
		expect(root.cursor).toBeNull();

		const g = (await (await api(`/v0/drives/${d}`)).json()) as { headSeq: number; fileCount: number; bytes: number };
		expect(g).toMatchObject({ headSeq: 1, fileCount: 1, bytes: 4 });
	});

	it("empty file has shards: [] and size 0", async () => {
		const d = await newDrive();
		const r = await commit(d, [{ op: "put", path: "empty", size: 0, shards: [] }]);
		expect(r.status).toBe(200);
		const m = await (await api(`/v0/drives/${d}/manifest?path=empty`)).json();
		expect(m).toMatchObject({ path: "empty", size: 0, shards: [] });
	});

	it("mkdir, delete, rename of a file in one commit; one seq, one version per op", async () => {
		const d = await newDrive();
		await putFile(d, "old.txt", "old");
		await putFile(d, "gone.txt", "gone");
		const r = await commit(d, [
			{ op: "mkdir", path: "docs/" },
			{ op: "delete", path: "gone.txt" },
			{ op: "rename", from: "old.txt", to: "docs/new.txt" },
		]);
		expect(r.status).toBe(200);
		const body = (await r.json()) as { seq: number; results: { path: string; versionId: string }[] };
		expect(body.seq).toBe(3);
		expect(body.results.map((x) => x.path)).toEqual(["docs/", "gone.txt", "docs/new.txt"]);
		expect(new Set(body.results.map((x) => x.versionId)).size).toBe(3);
		expect((await api(`/v0/drives/${d}/stat?path=gone.txt`)).status).toBe(404);
		expect((await api(`/v0/drives/${d}/stat?path=old.txt`)).status).toBe(404);
		const moved = await (await api(`/v0/drives/${d}/manifest?path=docs/new.txt`)).json();
		expect(moved).toMatchObject({ size: 3, shards: [{ n: 3 }] });
	});

	it("renames a folder with children (nested) and deletes a folder subtree", async () => {
		const d = await newDrive();
		await putFile(d, "cuts/a.txt", "aaa");
		await putFile(d, "cuts/deep/b.txt", "bbbb");
		await putFile(d, "cuts-other/keep.txt", "k"); // sibling sharing a name prefix must not move
		const r = await commit(d, [{ op: "rename", from: "cuts/", to: "archive/cuts/" }]);
		expect(r.status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=cuts/a.txt`)).status).toBe(404);
		expect((await api(`/v0/drives/${d}/stat?path=cuts/`)).status).toBe(404);
		expect(((await (await api(`/v0/drives/${d}/stat?path=archive/cuts/deep/b.txt`)).json()) as { size: number }).size).toBe(4);
		expect((await api(`/v0/drives/${d}/stat?path=archive/cuts/a.txt`)).status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=cuts-other/keep.txt`)).status).toBe(200);
		const list = (await (await api(`/v0/drives/${d}/list?path=archive/cuts/`)).json()) as { entries: { name: string }[] };
		expect(list.entries.map((e) => e.name)).toEqual(["a.txt", "deep"]);

		const del = await commit(d, [{ op: "delete", path: "archive/" }]);
		expect(del.status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=archive/cuts/deep/b.txt`)).status).toBe(404);
		expect(((await (await api(`/v0/drives/${d}`)).json()) as { fileCount: number }).fileCount).toBe(1);
	});

	it("rename onto an existing destination is a path_conflict", async () => {
		const d = await newDrive();
		await putFile(d, "a", "1");
		await putFile(d, "b", "2");
		const r = await commit(d, [{ op: "rename", from: "a", to: "b" }]);
		expect(r.status).toBe(409);
		expect(await r.json()).toMatchObject({ error: "path_conflict" });
	});

	it("is all-or-nothing: a failing op rolls back the whole commit", async () => {
		const d = await newDrive();
		await putFile(d, "keep.txt", "keep");
		const before = (await (await api(`/v0/drives/${d}`)).json()) as { headSeq: number };
		const s = await upload(d, bytes("second"));
		const r = await commit(d, [
			{ op: "put", path: "new1.txt", size: s.n, shards: [s] },
			{ op: "mkdir", path: "newdir/" },
			{ op: "delete", path: "keep.txt" },
			{ op: "delete", path: "does-not-exist.txt" }, // fails
		]);
		expect(r.status).toBe(404);
		expect((await api(`/v0/drives/${d}/stat?path=new1.txt`)).status).toBe(404);
		expect((await api(`/v0/drives/${d}/stat?path=newdir/`)).status).toBe(404);
		expect((await api(`/v0/drives/${d}/stat?path=keep.txt`)).status).toBe(200);
		const after = (await (await api(`/v0/drives/${d}`)).json()) as { headSeq: number };
		expect(after.headSeq).toBe(before.headSeq);
		const ch = (await (await api(`/v0/drives/${d}/changes?since=0`)).json()) as { changes: unknown[] };
		expect(ch.changes.every((c) => (c as { seq: number }).seq <= before.headSeq)).toBe(true);
		const vs = (await (await api(`/v0/drives/${d}/versions?path=new1.txt`)).json()) as { versions: unknown[] };
		expect(vs.versions).toEqual([]);
	});

	it("ifVersion mismatch gives 412 with currentVersionId; match succeeds", async () => {
		const d = await newDrive();
		const first = (await (await putFile(d, "f.txt", "one")).json()) as { results: { versionId: string }[] };
		const v1 = first.results[0]!.versionId;
		const s = await upload(d, bytes("two"));
		const ok = await commit(d, [{ op: "put", path: "f.txt", ifVersion: v1, size: s.n, shards: [s] }]);
		expect(ok.status).toBe(200);
		const v2 = ((await ok.json()) as { results: { versionId: string }[] }).results[0]!.versionId;

		const stale = await commit(d, [{ op: "put", path: "f.txt", ifVersion: v1, size: s.n, shards: [s] }]);
		expect(stale.status).toBe(412);
		expect(await stale.json()).toEqual({ error: "precondition_failed", path: "f.txt", currentVersionId: v2 });

		// ifVersion on a path that doesn't exist: currentVersionId is null
		const ghost = await commit(d, [{ op: "delete", path: "ghost.txt", ifVersion: v1 }]);
		expect(ghost.status).toBe(412);
		expect(await ghost.json()).toEqual({ error: "precondition_failed", path: "ghost.txt", currentVersionId: null });
	});

	it("two concurrent commits with the same ifVersion: exactly one wins", async () => {
		const d = await newDrive();
		const v = ((await (await putFile(d, "race.txt", "base")).json()) as { results: { versionId: string }[] }).results[0]!.versionId;
		const a = await upload(d, bytes("from A"));
		const b = await upload(d, bytes("from B"));
		const rs = await Promise.all([
			commit(d, [{ op: "put", path: "race.txt", ifVersion: v, size: a.n, shards: [a] }]),
			commit(d, [{ op: "put", path: "race.txt", ifVersion: v, size: b.n, shards: [b] }]),
		]);
		expect(rs.map((r) => r.status).sort()).toEqual([200, 412]);
	});

	it("ifAbsent: creates when absent, 412 when present", async () => {
		const d = await newDrive();
		const s = await upload(d, bytes("x"));
		const op = { op: "put", path: "once.txt", ifAbsent: true, size: s.n, shards: [s] };
		expect((await commit(d, [op])).status).toBe(200);
		const again = await commit(d, [op]);
		expect(again.status).toBe(412);
		expect(await again.json()).toMatchObject({ error: "precondition_failed", path: "once.txt", currentVersionId: expect.stringMatching(ULID_RE) });
	});

	it("path_conflict: file vs folder in both directions, and via a file parent", async () => {
		const d = await newDrive();
		await putFile(d, "thing", "file");
		const s = await upload(d, bytes("y"));
		const underFile = await commit(d, [{ op: "put", path: "thing/child.txt", size: s.n, shards: [s] }]);
		expect(underFile.status).toBe(409);
		expect(await underFile.json()).toMatchObject({ error: "path_conflict" });
		expect((await commit(d, [{ op: "mkdir", path: "thing/" }])).status).toBe(409);

		await putFile(d, "dir/inner.txt", "i");
		const overFolder = await commit(d, [{ op: "put", path: "dir", size: s.n, shards: [s] }]);
		expect(overFolder.status).toBe(409);
		expect(await overFolder.json()).toMatchObject({ error: "path_conflict" });
	});

	it("missing_shards lists every hash that is neither known nor in R2", async () => {
		const d = await newDrive();
		const h1 = "1".repeat(64);
		const h2 = "2".repeat(64);
		const r = await commit(d, [{ op: "put", path: "x", size: 20, shards: [{ h: h1, n: 10 }, { h: h2, n: 10 }] }]);
		expect(r.status).toBe(409);
		const body = (await r.json()) as { error: string; hashes: string[] };
		expect(body.error).toBe("missing_shards");
		expect(body.hashes.sort()).toEqual([h1, h2]);
		expect((await api(`/v0/drives/${d}/stat?path=x`)).status).toBe(404);
	});

	it("accepts shards found in R2 by HEAD but not yet in shards_known", async () => {
		const d = await newDrive();
		const raw = bytes("only in r2");
		const h = await sha256Hex(raw);
		await env.SHARDS.put(`shards/${d}/${h}`, raw);
		const r = await commit(d, [{ op: "put", path: "viaR2", size: raw.byteLength, shards: [{ h, n: raw.byteLength }] }]);
		expect(r.status).toBe(200);
		const missing = await (await api(`/v0/drives/${d}/shards/missing`, { json: { hashes: [h] } })).json();
		expect(missing).toEqual({ missing: [] });
	});

	it("bad_manifest when sum(shards.n) != size", async () => {
		const d = await newDrive();
		const s = await upload(d, bytes("abc"));
		const r = await commit(d, [{ op: "put", path: "bad", size: 99, shards: [s] }]);
		expect(r.status).toBe(400);
		expect(await r.json()).toMatchObject({ error: "bad_manifest" });
	});

	it("validates paths, op count and body size", async () => {
		const d = await newDrive();
		for (const path of ["/abs", "a//b", "a/./b", "a/../b", "a\u0000b", "x".repeat(1025), ""]) {
			const r = await commit(d, [{ op: "mkdir", path }]);
			expect(r.status, JSON.stringify(path.slice(0, 20))).toBe(400);
		}
		expect((await commit(d, [])).status).toBe(400);
		expect((await commit(d, Array.from({ length: 1001 }, (_, i) => ({ op: "mkdir", path: `d${i}/` })))).status).toBe(400);
		const huge = await api(`/v0/drives/${d}/commit`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
		expect(huge.status).toBe(413);
	});

	it("commit on a missing drive is 404", async () => {
		const r = await commit("ghost-drive", [{ op: "mkdir", path: "a/" }]);
		expect(r.status).toBe(404);
	});
});

describe("reads", () => {
	it("list paginates with cursors, sorted bytewise, no dupes or gaps", async () => {
		const d = await newDrive();
		const names = ["b", "a", "B", "é", "a-b", "a.b", "z", "dir/x"];
		const s = await upload(d, bytes("p"));
		await commit(d, names.map((n) => ({ op: "put", path: n, size: s.n, shards: [s] })));
		const expected = ["B", "a", "a-b", "a.b", "b", "dir", "z", "é"]; // bytewise UTF-8
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const q: string = `/v0/drives/${d}/list?path=&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
			const page = (await (await api(q)).json()) as { entries: { name: string }[]; cursor: string | null };
			expect(page.entries.length).toBeLessThanOrEqual(3);
			seen.push(...page.entries.map((e) => e.name));
			cursor = page.cursor;
			pages++;
		} while (cursor && pages < 10);
		expect(seen).toEqual(expected);
		expect(pages).toBe(3);
	});

	it("list of a large directory pages through all entries", async () => {
		const d = await newDrive();
		const s = await upload(d, bytes("p"));
		const ops = Array.from({ length: 1000 }, (_, i) => ({ op: "put", path: `big/f${String(i).padStart(4, "0")}`, size: s.n, shards: [s] }));
		expect((await commit(d, ops)).status).toBe(200);
		expect((await commit(d, [{ op: "put", path: "big/f1000", size: s.n, shards: [s] }])).status).toBe(200);
		const p1 = (await (await api(`/v0/drives/${d}/list?path=big/&limit=1000`)).json()) as { entries: unknown[]; cursor: string | null };
		expect(p1.entries).toHaveLength(1000);
		expect(p1.cursor).not.toBeNull();
		const p2 = (await (await api(`/v0/drives/${d}/list?path=big/&limit=1000&cursor=${encodeURIComponent(p1.cursor!)}`)).json()) as { entries: unknown[]; cursor: string | null };
		expect(p2.entries).toHaveLength(1);
		expect(p2.cursor).toBeNull();
	});

	it("list errors: 404 for missing folder or a file", async () => {
		const d = await newDrive();
		await putFile(d, "f.txt", "f");
		expect((await api(`/v0/drives/${d}/list?path=nope/`)).status).toBe(404);
		expect((await api(`/v0/drives/${d}/list?path=f.txt`)).status).toBe(404);
		expect((await api(`/v0/drives/${d}/list?path=&cursor=!!!`)).status).toBe(400);
	});

	it("manifest by versionId returns the old content after an overwrite", async () => {
		const d = await newDrive();
		const v1 = ((await (await putFile(d, "m.txt", "first")).json()) as { results: { versionId: string }[] }).results[0]!.versionId;
		const v2 = ((await (await putFile(d, "m.txt", "second-longer")).json()) as { results: { versionId: string }[] }).results[0]!.versionId;
		const head = (await (await api(`/v0/drives/${d}/manifest?path=m.txt`)).json()) as { versionId: string; size: number };
		expect(head).toMatchObject({ versionId: v2, size: 13 });
		const old = (await (await api(`/v0/drives/${d}/manifest?path=m.txt&versionId=${v1}`)).json()) as { versionId: string; size: number; shards: { h: string; n: number }[]; contentType: string; mtimeMs: number };
		expect(old).toMatchObject({ path: "m.txt", versionId: v1, size: 5, contentType: "text/plain", mtimeMs: 1700000000000 });
		expect(old.shards).toEqual([{ h: await sha256Hex(bytes("first")), n: 5 }]);
		expect((await api(`/v0/drives/${d}/manifest?path=m.txt&versionId=v_${"0".repeat(26)}`)).status).toBe(404);
		expect((await api(`/v0/drives/${d}/manifest?path=missing.txt`)).status).toBe(404);
	});

	it("versions are oldest first; restore creates a new head with the old manifest", async () => {
		const d = await newDrive();
		const v1 = ((await (await putFile(d, "r.txt", "v-one")).json()) as { results: { versionId: string }[] }).results[0]!.versionId;
		const v2 = ((await (await putFile(d, "r.txt", "v-two!!", { ifVersion: v1 })).json()) as { results: { versionId: string }[] }).results[0]!.versionId;
		const vs = (await (await api(`/v0/drives/${d}/versions?path=r.txt`)).json()) as { versions: { versionId: string; op: string; size: number; seq: number; ts: number; actor: string }[] };
		expect(vs.versions.map((v) => v.versionId)).toEqual([v1, v2]);
		expect(vs.versions.map((v) => v.seq)).toEqual([1, 2]);
		expect(vs.versions[0]).toMatchObject({ op: "put", size: 5 });
		expect(typeof vs.versions[0]!.ts).toBe("number");
		expect(typeof vs.versions[0]!.actor).toBe("string");

		// stale ifVersion on restore -> 412
		const stale = await api(`/v0/drives/${d}/restore`, { json: { path: "r.txt", versionId: v1, ifVersion: v1 } });
		expect(stale.status).toBe(412);

		const rr = await api(`/v0/drives/${d}/restore`, { json: { path: "r.txt", versionId: v1, ifVersion: v2 } });
		expect(rr.status).toBe(200);
		const body = (await rr.json()) as { seq: number; results: { path: string; versionId: string; size: number }[] };
		expect(body.seq).toBe(3);
		expect(body.results[0]).toMatchObject({ path: "r.txt", size: 5 });
		expect(body.results[0]!.versionId).not.toBe(v1);
		const head = (await (await api(`/v0/drives/${d}/manifest?path=r.txt`)).json()) as { versionId: string; shards: { h: string }[] };
		expect(head.versionId).toBe(body.results[0]!.versionId);
		expect(head.shards[0]!.h).toBe(await sha256Hex(bytes("v-one")));
		const after = (await (await api(`/v0/drives/${d}/versions?path=r.txt`)).json()) as { versions: { op: string }[] };
		expect(after.versions.map((v) => v.op)).toEqual(["put", "put", "restore"]);

		expect((await api(`/v0/drives/${d}/restore`, { json: { path: "r.txt", versionId: `v_${"0".repeat(26)}` } })).status).toBe(404);
	});

	it("restore brings back a deleted file", async () => {
		const d = await newDrive();
		const v1 = ((await (await putFile(d, "del.txt", "bring me back")).json()) as { results: { versionId: string }[] }).results[0]!.versionId;
		expect((await commit(d, [{ op: "delete", path: "del.txt" }])).status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=del.txt`)).status).toBe(404);
		expect((await api(`/v0/drives/${d}/restore`, { json: { path: "del.txt", versionId: v1, ifVersion: null } })).status).toBe(200);
		expect(((await (await api(`/v0/drives/${d}/stat?path=del.txt`)).json()) as { size: number }).size).toBe(13);
	});

	it("changes since seq with limit and more", async () => {
		const d = await newDrive();
		await putFile(d, "a/1.txt", "1"); // seq1: mkdir a/ + put
		await putFile(d, "a/2.txt", "2"); // seq2
		await commit(d, [{ op: "delete", path: "a/1.txt" }]); // seq3
		const all = (await (await api(`/v0/drives/${d}/changes?since=0`)).json()) as { changes: { seq: number; path: string; op: string; versionId: string | null }[]; headSeq: number; more: boolean };
		expect(all.headSeq).toBe(3);
		expect(all.more).toBe(false);
		expect(all.changes.map((c) => [c.seq, c.op, c.path])).toEqual([
			[1, "mkdir", "a/"],
			[1, "put", "a/1.txt"],
			[2, "put", "a/2.txt"],
			[3, "delete", "a/1.txt"],
		]);
		expect(all.changes[0]!.versionId).toMatch(ULID_RE);
		const since2 = (await (await api(`/v0/drives/${d}/changes?since=2`)).json()) as { changes: { seq: number }[] };
		expect(since2.changes.map((c) => c.seq)).toEqual([3]);
		const page = (await (await api(`/v0/drives/${d}/changes?since=0&limit=2`)).json()) as { changes: unknown[]; more: boolean };
		expect(page.changes).toHaveLength(2);
		expect(page.more).toBe(true);
	});
});

async function openWatch(drive: string, since: number, via: "query" | "header" = "query") {
	const url = `/v0/drives/${drive}/watch?since=${since}${via === "query" ? `&token=${TOKEN}` : ""}`;
	const headers: Record<string, string> = { Upgrade: "websocket" };
	if (via === "header") headers.Authorization = `Bearer ${TOKEN}`;
	const res = await selfFetch(new Request("http://example.com" + url, { headers }));
	const ws = res.webSocket;
	if (!ws) throw new Error(`no websocket: ${res.status} ${await res.text()}`);
	ws.accept();
	const queue: Record<string, unknown>[] = [];
	const waiters: ((m: Record<string, unknown>) => void)[] = [];
	ws.addEventListener("message", (e: MessageEvent) => {
		const m = JSON.parse(e.data as string) as Record<string, unknown>;
		const w = waiters.shift();
		if (w) w(m);
		else queue.push(m);
	});
	const next = (timeoutMs = 5000) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const q = queue.shift();
			if (q) return resolve(q);
			const t = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
			waiters.push((m) => {
				clearTimeout(t);
				resolve(m);
			});
		});
	return { ws, next, res };
}

describe("watch", () => {
	it("401 without a token; 426 without an Upgrade header", async () => {
		const d = await newDrive();
		const noTok = await selfFetch(new Request(`http://example.com/v0/drives/${d}/watch?since=0`, { headers: { Upgrade: "websocket" } }));
		expect(noTok.status).toBe(401);
		expect((await api(`/v0/drives/${d}/watch?since=0`)).status).toBe(426);
	});

	it("replays changes after `since`, then pushes a new change after a commit", async () => {
		const d = await newDrive();
		await putFile(d, "before.txt", "b"); // seq 1
		const { ws, next } = await openWatch(d, 0);
		expect(await next()).toMatchObject({ type: "change", seq: 1, path: "before.txt", op: "put" });

		const r = await putFile(d, "live/new.txt", "n"); // seq 2
		const vid = ((await r.json()) as { results: { versionId: string }[] }).results[0]!.versionId;
		const events: Record<string, unknown>[] = [await next(), await next()];
		expect(events.map((e) => e.path)).toEqual(["live/", "live/new.txt"]);
		expect(events[1]).toMatchObject({ type: "change", seq: 2, path: "live/new.txt", op: "put", versionId: vid });
		ws.close(1000, "done");
	});

	it("resumes from the last seen seq and accepts header auth", async () => {
		const d = await newDrive();
		await putFile(d, "one", "1"); // seq 1
		await putFile(d, "two", "2"); // seq 2
		const { ws, next } = await openWatch(d, 1, "header");
		expect(await next()).toMatchObject({ type: "change", seq: 2, path: "two" });
		ws.close(1000, "done");
	});

	it("rejects a bad `since`", async () => {
		const d = await newDrive();
		const r = await selfFetch(new Request(`http://example.com/v0/drives/${d}/watch?since=abc&token=${TOKEN}`, { headers: { Upgrade: "websocket" } }));
		expect(r.status).toBe(400);
	});
});
