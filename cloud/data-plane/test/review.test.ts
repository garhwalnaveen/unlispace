// Regression tests for the Codex review of the data plane (findings #1-#12).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, bytes, commit, newDrive, putFile, selfFetch, sha256Hex, TOKEN, upload } from "./helpers";

const wsUrl = (d: string, qs: string) => `http://example.com/v0/drives/${d}/watch?${qs}&token=${TOKEN}`;

async function collect(d: string, qs: string, until: (m: Record<string, unknown>[]) => boolean, ms = 15000) {
	const res = await selfFetch(new Request(wsUrl(d, qs), { headers: { Upgrade: "websocket" } }));
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	const msgs: Record<string, unknown>[] = [];
	let closeCode: number | null = null;
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timeout; got ${msgs.length} msgs`)), ms);
		const check = () => {
			if (until(msgs) || closeCode !== null) {
				clearTimeout(t);
				resolve();
			}
		};
		ws.addEventListener("message", (e: MessageEvent) => {
			msgs.push(JSON.parse(e.data as string));
			check();
		});
		ws.addEventListener("close", (e: CloseEvent) => {
			closeCode = e.code;
			check();
		});
		check();
	});
	return { ws, msgs, closeCode };
}

describe("review #1: R2 verifies the hash before publishing", () => {
	it("a wrong upload is rejected as hash_mismatch, never becomes visible, and a later correct upload works", async () => {
		const d = await newDrive();
		const good = bytes("the real content");
		const h = await sha256Hex(good);
		const bad = await api(`/v0/drives/${d}/shards/${h}`, { method: "PUT", body: bytes("the wrong content") }); // same length
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: "hash_mismatch" });
		expect(await env.SHARDS.head(`shards/${d}/${h}`)).toBeNull();
		const missing = (await (await api(`/v0/drives/${d}/shards/missing`, { json: { hashes: [h] } })).json()) as { missing: string[] };
		expect(missing.missing).toEqual([h]);
		const c = await commit(d, [{ op: "put", path: "x", size: good.length, shards: [{ h, n: good.length }] }]);
		expect(c.status).toBe(409);
		const ok = await api(`/v0/drives/${d}/shards/${h}`, { method: "PUT", body: good });
		expect(ok.status).toBe(201);
		expect(await ok.json()).toEqual({ hash: h, size: good.length, stored: true });
	});
});

describe("review #2: event-id pagination and replay", () => {
	it("/changes pages by ev so a commit's events are never skipped; since=<seq> still means whole commits", async () => {
		const d = await newDrive();
		await putFile(d, "a/x", "1"); // seq1: mkdir a/ + put (2 events)
		await putFile(d, "b", "2"); // seq2
		const p1 = (await (await api(`/v0/drives/${d}/changes?after=0&limit=1`)).json()) as { changes: { ev: number; path: string }[]; more: boolean; lastEv: number };
		expect(p1.changes.map((c) => c.path)).toEqual(["a/"]);
		expect(p1.more).toBe(true);
		const p2 = (await (await api(`/v0/drives/${d}/changes?after=${p1.changes[0]!.ev}&limit=1`)).json()) as { changes: { ev: number; path: string }[] };
		expect(p2.changes.map((c) => c.path)).toEqual(["a/x"]);
		const all = (await (await api(`/v0/drives/${d}/changes?after=0`)).json()) as { changes: { ev: number; seq: number }[]; lastEv: number };
		expect(all.changes.map((c) => c.ev)).toEqual([1, 2, 3]);
		expect(all.lastEv).toBe(3);
		const since = (await (await api(`/v0/drives/${d}/changes?since=1`)).json()) as { changes: { path: string }[] };
		expect(since.changes.map((c) => c.path)).toEqual(["b"]);
	});

	it("watch replays a >1000-event commit completely, in order, then goes live without gaps or duplicates", async () => {
		const d = await newDrive();
		const ops = Array.from({ length: 600 }, (_, i) => ({ op: "mkdir", path: `d${i}/sub/` })); // 1200 events, one seq
		expect((await commit(d, ops)).status).toBe(200);
		const { ws, msgs } = await collect(d, "after=0", (m) => m.length >= 1200);
		expect(msgs).toHaveLength(1200);
		expect(msgs.map((m) => m.ev)).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
		// live event after catch-up
		await putFile(d, "live.txt", "l");
		const live = await collect(d, "after=1199", (m) => m.length >= 2);
		expect(live.msgs.map((m) => m.ev)).toEqual([1200, 1201]);
		ws.close(1000, "done");
		live.ws.close(1000, "done");
	}, 30000);

	it("a socket resuming mid-commit with after=<ev> receives the rest of that commit", async () => {
		const d = await newDrive();
		await putFile(d, "a/x", "1");
		const { ws, msgs } = await collect(d, "after=1", (m) => m.length >= 1);
		expect(msgs[0]).toMatchObject({ path: "a/x", ev: 2 });
		ws.close(1000, "done");
	});

	it("101 comes back promptly and a backlog over 100k events gets `resync` then close", async () => {
		const d = await newDrive();
		const h = (await upload(d, bytes("s"))).h;
		const ops = Array.from({ length: 1000 }, (_, i) => ({ op: "put", path: `f${i}/g`, size: 1, shards: [{ h, n: 1 }] })); // 2000 events
		for (let i = 0; i < 51; i++) {
			const o = ops.map((op) => ({ ...op, path: `c${i}/${op.path}` }));
			expect((await commit(d, o)).status).toBe(200);
		}
		const t0 = Date.now();
		const res = await selfFetch(new Request(wsUrl(d, "after=0"), { headers: { Upgrade: "websocket" } }));
		expect(res.status).toBe(101);
		expect(Date.now() - t0).toBeLessThan(3000);
		const ws = res.webSocket!;
		ws.accept();
		const first = await new Promise<Record<string, unknown>>((resolve) => ws.addEventListener("message", (e: MessageEvent) => resolve(JSON.parse(e.data as string))));
		expect(first).toMatchObject({ type: "resync" });
		expect(typeof first.lastEv).toBe("number");
		expect(first.lastEv as number).toBeGreaterThan(100_000);
	}, 120000);
});

describe("review #3: bounded JSON body reads", () => {
	it("a chunked body over the cap is rejected with 413 after reading only about the cap", async () => {
		const d = await newDrive();
		let pulled = 0;
		const chunk = new Uint8Array(64 * 1024).fill(32);
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				if (pulled >= 8 * 1024 * 1024) return c.close();
				pulled += chunk.byteLength;
				c.enqueue(chunk);
			},
		});
		const r = await selfFetch(
			new Request(`http://example.com/v0/drives/${d}/commit`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
				body,
				// @ts-expect-error duplex is required for streaming request bodies
				duplex: "half",
			}),
		);
		expect(r.status).toBe(413);
		expect(await r.json()).toEqual({ error: "too_large" });
		expect(pulled).toBeLessThan(4 * 1024 * 1024);
	});
});

describe("review #4: /versions pagination", () => {
	it("pages oldest-first with cursor and never truncates", async () => {
		const d = await newDrive();
		for (let i = 0; i < 5; i++) await putFile(d, "f", `v${i}`);
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const r = (await (await api(`/v0/drives/${d}/versions?path=f&limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json()) as { versions: { versionId: string }[]; cursor: string | null };
			seen.push(...r.versions.map((v) => v.versionId));
			cursor = r.cursor;
			pages++;
		} while (cursor);
		expect(pages).toBe(3);
		expect(new Set(seen).size).toBe(5);
		expect(seen).toEqual([...seen].sort()); // ULIDs: oldest first
		expect((await api(`/v0/drives/${d}/versions?path=f&limit=0`)).status).toBe(400);
	});
});

describe("review #5: subtree limits", () => {
	it("delete and rename of a subtree over 100,000 nodes -> 400 subtree_too_large, nothing changes", async () => {
		const d = await newDrive();
		for (let i = 0; i < 101; i++) {
			const ops = Array.from({ length: 1000 }, (_, j) => ({ op: "mkdir", path: `big/n${i * 1000 + j}/` }));
			expect((await commit(d, ops)).status).toBe(200);
		}
		const del = await commit(d, [{ op: "delete", path: "big/" }]);
		expect(del.status).toBe(400);
		expect(await del.json()).toMatchObject({ error: "subtree_too_large", limit: 100000 });
		const ren = await commit(d, [{ op: "rename", from: "big/", to: "huge/" }]);
		expect(ren.status).toBe(400);
		expect(await ren.json()).toMatchObject({ error: "subtree_too_large" });
		expect((await api(`/v0/drives/${d}/stat?path=big/`)).status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=huge/`)).status).toBe(404);
	}, 240000);

	it("moderately large subtrees (> one internal page) still rename and delete correctly", async () => {
		const d = await newDrive();
		for (const [lo, hi] of [[0, 600], [600, 1200]] as const) {
			const ops = Array.from({ length: hi - lo }, (_, k) => ({ op: "mkdir", path: `t/n${String(lo + k).padStart(4, "0")}/` }));
			expect((await commit(d, ops)).status).toBe(200);
		}
		expect((await commit(d, [{ op: "rename", from: "t/", to: "u/" }])).status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=u/n1199/`)).status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=t/n0000/`)).status).toBe(404);
		expect((await commit(d, [{ op: "delete", path: "u/" }])).status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=u/n0000/`)).status).toBe(404);
	}, 60000);
});

describe("review #7: renamed descendants stay within the path limit", () => {
	it("folder rename that would push a descendant past 1024 bytes -> 400 path_too_long, atomically", async () => {
		const d = await newDrive();
		const seg = "x".repeat(100);
		const deep = "a/" + Array.from({ length: 9 }, () => seg).join("/") + "/" + "y".repeat(1024 - 2 - 9 * 101); // exactly 1024 bytes
		expect(new TextEncoder().encode(deep).length).toBe(1024);
		expect((await commit(d, [{ op: "put", path: deep, size: 0, shards: [] }])).status).toBe(200);
		const r = await commit(d, [{ op: "rename", from: "a/", to: "long/" }]);
		expect(r.status).toBe(400);
		expect(await r.json()).toMatchObject({ error: "path_too_long" });
		expect((await api(`/v0/drives/${d}/stat?path=a/`)).status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=long/`)).status).toBe(404);
		// a shorter destination is fine
		expect((await commit(d, [{ op: "rename", from: "a/", to: "b/" }])).status).toBe(200);
	});
});

describe("review #8: lone surrogates", () => {
	it("are rejected as bad_path in commit and query paths; valid surrogate pairs are fine", async () => {
		const d = await newDrive();
		for (const p of ["\ud800", "x\udc00y", "dir/\ud801"]) {
			const r = await commit(d, [{ op: "mkdir", path: p + "/" }]);
			expect(r.status, p).toBe(400);
			expect(((await r.json()) as { error: string }).error).toBe("bad_path");
		}
		expect((await commit(d, [{ op: "mkdir", path: "emoji-\u{1F600}/" }])).status).toBe(200);
	});
});

describe("review #9: failed commits leave no shard registrations", () => {
	it("a commit that fails a precondition does not record confirmed shards", async () => {
		const d = await newDrive();
		const data = bytes("orphan");
		const h = await sha256Hex(data);
		await env.SHARDS.put(`shards/${d}/${h}`, data); // present in R2, unknown to the DO
		await putFile(d, "exists", "e");
		const r = await commit(d, [
			{ op: "put", path: "p", size: data.length, shards: [{ h, n: data.length }], ifAbsent: false },
			{ op: "put", path: "exists", size: data.length, shards: [{ h, n: data.length }], ifAbsent: true },
		]);
		expect(r.status).toBe(412);
		const ns = env.DRIVE_AUTHORITY as unknown as DurableObjectNamespace<import("../src/drive").DriveAuthority>;
		const unknown = await ns.get(ns.idFromName(d)).filterUnknown([h]);
		expect(unknown.ok && unknown.data).toEqual([h]);
		const head = ((await (await api(`/v0/drives/${d}`)).json()) as { headSeq: number }).headSeq;
		expect(head).toBe(1);
		// and a successful commit does register it
		expect((await commit(d, [{ op: "put", path: "p", size: data.length, shards: [{ h, n: data.length }] }])).status).toBe(200);
		const after = await ns.get(ns.idFromName(d)).filterUnknown([h]);
		expect(after.ok && after.data).toEqual([]);
	});
});

describe("review #10 / #11: token handling", () => {
	it("PUT /v0/drives/watch?token=... without Authorization is 401", async () => {
		const r = await selfFetch(new Request(`http://example.com/v0/drives/watch?token=${TOKEN}`, { method: "PUT", body: "{}" }));
		expect(r.status).toBe(401);
	});
	it("dev-token comparison rejects prefixes, extensions and different lengths, accepts the exact token", async () => {
		const d = await newDrive();
		for (const t of [TOKEN.slice(0, -1), TOKEN + "x", "", "x".repeat(5000), TOKEN.toUpperCase()]) {
			expect((await api(`/v0/drives/${d}`, { token: t || null })).status, t.slice(0, 10)).toBe(401);
		}
		expect((await api(`/v0/drives/${d}`)).status).toBe(200);
	});
});

describe("review #12: mkdir on an existing folder is idempotent", () => {
	it("returns the existing version id, adds no version, no log entry, keeps children", async () => {
		const d = await newDrive();
		await putFile(d, "dir/child.txt", "c");
		const first = (await (await commit(d, [{ op: "mkdir", path: "other/" }])).json()) as { results: { versionId: string }[] };
		const again = (await (await commit(d, [{ op: "mkdir", path: "other/" }])).json()) as { results: { versionId: string }[] };
		expect(again.results[0]!.versionId).toBe(first.results[0]!.versionId);
		const vs = (await (await api(`/v0/drives/${d}/versions?path=other`)).json()) as { versions: unknown[] };
		expect(vs.versions).toHaveLength(1);
		const ch = (await (await api(`/v0/drives/${d}/changes?after=0`)).json()) as { changes: { path: string }[] };
		expect(ch.changes.filter((c) => c.path === "other/")).toHaveLength(1);
		const m = await commit(d, [{ op: "mkdir", path: "dir/" }]);
		expect(m.status).toBe(200);
		expect((await api(`/v0/drives/${d}/stat?path=dir/child.txt`)).status).toBe(200);
	});
});
