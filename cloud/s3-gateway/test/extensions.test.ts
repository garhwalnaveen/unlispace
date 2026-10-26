import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { client, harness, makeBucket, rawSigned, readText, text, type Harness } from "./helpers";

const body = async (res: Response): Promise<string> => res.text();

/** Signed raw call to an extension route. x-uls-* headers are signed by rawSigned (they are part of `headers`). */
async function ext(h: Harness, method: string, b: string, key: string, query: string, opts: { headers?: Record<string, string>; body?: BodyInit | null } = {}): Promise<Response> {
	return handle(await rawSigned(h, method, `/${b}/${key}?${query}`, opts), h.deps);
}
const content = async (h: Harness, b: string, key: string, versionId?: string): Promise<string> => {
	const s3 = await client(h.deps);
	return readText((await s3.send(new GetObjectCommand({ Bucket: b, Key: key, VersionId: versionId }))).Body);
};

/** S3SP patch body: "S3SP" 01 00 00 00, u32 count, then per edit u64 offset + u64 length + bytes (big-endian). */
function patch(edits: { offset: number; data: string }[]): Uint8Array {
	const parts = edits.map((e) => ({ o: e.offset, d: text(e.data) }));
	const size = 12 + parts.reduce((n, p) => n + 16 + p.d.length, 0);
	const out = new Uint8Array(size), v = new DataView(out.buffer);
	out.set([83, 51, 83, 80, 1, 0, 0, 0]);
	v.setUint32(8, parts.length);
	let at = 12;
	for (const p of parts) { v.setBigUint64(at, BigInt(p.o)); v.setBigUint64(at + 8, BigInt(p.d.length)); out.set(p.d, at + 16); at += 16 + p.d.length; }
	return out;
}

describe("Drive extensions", () => {
	it("?x-uls-write overwrites at an offset, creates files, zero-fills gaps, and truncates", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "f.txt", Body: "0123456789" }));
		let res = await ext(h, "PUT", b, "f.txt", "x-uls-write", { headers: { "x-uls-offset": "3" }, body: "ABC" });
		expect(res.status).toBe(200);
		expect(res.headers.get("x-amz-version-id")).toMatch(/^v_/);
		expect(await content(h, b, "f.txt")).toBe("012ABC6789");

		res = await ext(h, "PUT", b, "f.txt", "x-uls-write", { headers: { "x-uls-offset": "8" }, body: "XYZ" });
		expect(await content(h, b, "f.txt")).toBe("012ABC67XYZ");

		// offset past the end zero-fills
		await ext(h, "PUT", b, "f.txt", "x-uls-write", { headers: { "x-uls-offset": "13" }, body: "!" });
		expect(await content(h, b, "f.txt")).toBe("012ABC67XYZ\0\0!");

		// truncate via x-uls-size with an empty write
		res = await ext(h, "PUT", b, "f.txt", "x-uls-write", { headers: { "x-uls-offset": "0", "x-uls-size": "4" } });
		expect(res.status).toBe(200);
		expect(await content(h, b, "f.txt")).toBe("012A");
		expect(res.headers.get("x-uls-size")).toBe("4");

		// extend by size
		await ext(h, "PUT", b, "f.txt", "x-uls-write", { headers: { "x-uls-offset": "0", "x-uls-size": "6" } });
		expect(await content(h, b, "f.txt")).toBe("012A\0\0");

		// create a new file by writing
		res = await ext(h, "PUT", b, "created.txt", "x-uls-write", { headers: { "x-uls-offset": "0" }, body: "fresh" });
		expect(res.status).toBe(200);
		expect(await content(h, b, "created.txt")).toBe("fresh");
	});

	it("?x-uls-write reuses untouched shards by reference", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const big = new Uint8Array(40_000_000); // zeros: two 16 MiB shards plus a tail, all chunk boundaries at MAX
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "z.bin", Body: big }));
		const before = h.dp.drives.get(b)!.versions.at(-1)!.shards!;
		expect(before.length).toBe(3);
		const puts = h.dp.shardPuts;
		await ext(h, "PUT", b, "z.bin", "x-uls-write", { headers: { "x-uls-offset": "38000000" }, body: "tail edit" });
		const after = h.dp.drives.get(b)!.versions.at(-1)!.shards!;
		expect(after[0]).toEqual(before[0]);
		expect(after[1]).toEqual(before[1]);
		expect(after[2]).not.toEqual(before[2]);
		expect(h.dp.shardPuts - puts).toBeLessThanOrEqual(2);
		const head = await s3.send(new HeadObjectCommand({ Bucket: b, Key: "z.bin" }));
		expect(head.ContentLength).toBe(40_000_000);
	});

	it("?x-uls-write is compare-and-swap with If-Match and validates headers", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const put = await s3.send(new PutObjectCommand({ Bucket: b, Key: "cas", Body: "base" }));
		await ext(h, "PUT", b, "cas", "x-uls-write", { headers: { "x-uls-offset": "0" }, body: "B" });
		const stale = await ext(h, "PUT", b, "cas", "x-uls-write", { headers: { "x-uls-offset": "0", "if-match": put.ETag! }, body: "X" });
		expect(stale.status).toBe(412);
		expect(await body(stale)).toContain("PreconditionFailed");
		const bad = await ext(h, "PUT", b, "cas", "x-uls-write", { headers: { "x-uls-offset": "-1" }, body: "X" });
		expect(bad.status).toBe(400);
		expect(await content(h, b, "cas")).toBe("Base");
	});

	it("?x-uls-patch applies a batch of S3SP edits atomically", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "p.txt", Body: "aaaaaaaaaa" }));
		const res = await ext(h, "POST", b, "p.txt", "x-uls-patch", { headers: { "content-type": "application/vnd.s3sdk.patch" }, body: patch([{ offset: 0, data: "XX" }, { offset: 4, data: "YY" }, { offset: 12, data: "ZZ" }]) });
		expect(res.status).toBe(200);
		expect(await content(h, b, "p.txt")).toBe("XXaaYYaaaa\0\0ZZ");

		// invalid bodies are rejected and change nothing
		const garbage = await ext(h, "POST", b, "p.txt", "x-uls-patch", { headers: { "content-type": "application/vnd.s3sdk.patch" }, body: "not a patch at all" });
		expect(garbage.status).toBe(400);
		expect(await body(garbage)).toContain("InvalidPatch");
		const truncated = patch([{ offset: 0, data: "abcdef" }]).slice(0, -2);
		expect((await ext(h, "POST", b, "p.txt", "x-uls-patch", { headers: { "content-type": "application/vnd.s3sdk.patch" }, body: truncated })).status).toBe(400);
		const wrongType = await ext(h, "POST", b, "p.txt", "x-uls-patch", { headers: { "content-type": "application/octet-stream" }, body: patch([{ offset: 0, data: "a" }]) });
		expect(wrongType.status).toBe(400);
		expect(await content(h, b, "p.txt")).toBe("XXaaYYaaaa\0\0ZZ");
	});

	it("?x-uls-splice inserts and removes bytes", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "s.txt", Body: "hello world" }));
		await ext(h, "PUT", b, "s.txt", "x-uls-splice", { headers: { "x-uls-offset": "5", "x-uls-remove": "0" }, body: ", cruel" });
		expect(await content(h, b, "s.txt")).toBe("hello, cruel world");
		await ext(h, "PUT", b, "s.txt", "x-uls-splice", { headers: { "x-uls-offset": "5", "x-uls-remove": "7" } });
		expect(await content(h, b, "s.txt")).toBe("hello world");
		await ext(h, "PUT", b, "s.txt", "x-uls-splice", { headers: { "x-uls-offset": "0", "x-uls-remove": "5" }, body: "HOWDY" });
		expect(await content(h, b, "s.txt")).toBe("HOWDY world");

		const beyond = await ext(h, "PUT", b, "s.txt", "x-uls-splice", { headers: { "x-uls-offset": "8", "x-uls-remove": "99" } });
		expect(beyond.status).toBe(400);
		const noop = await ext(h, "PUT", b, "s.txt", "x-uls-splice", { headers: { "x-uls-offset": "1", "x-uls-remove": "0" } });
		expect(noop.status).toBe(400);
		const missing = await ext(h, "PUT", b, "nope.txt", "x-uls-splice", { headers: { "x-uls-offset": "0", "x-uls-remove": "0" }, body: "a" });
		expect(missing.status).toBe(404);
		expect(await content(h, b, "s.txt")).toBe("HOWDY world");
	});

	it("?x-uls-rename moves files and folders, and refuses to overwrite", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "old/a.txt", Body: "A" }));
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "old/deep/b.txt", Body: "B" }));
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "file.txt", Body: "F" }));

		let res = await ext(h, "PUT", b, "renamed.txt", "x-uls-rename", { headers: { "x-uls-source": "file.txt" } });
		expect(res.status).toBe(200);
		expect(await content(h, b, "renamed.txt")).toBe("F");
		expect((await s3.send(new GetObjectCommand({ Bucket: b, Key: "file.txt" })).catch((e) => e)).name).toBe("NoSuchKey");

		res = await ext(h, "PUT", b, "new/", "x-uls-rename", { headers: { "x-uls-source": "old/" } });
		expect(res.status).toBe(200);
		const keys = (await s3.send(new ListObjectsV2Command({ Bucket: b }))).Contents?.map((c) => c.Key);
		expect(keys).toEqual(["new/a.txt", "new/deep/b.txt", "renamed.txt"]);
		expect(await content(h, b, "new/deep/b.txt")).toBe("B");

		await s3.send(new PutObjectCommand({ Bucket: b, Key: "occupied.txt", Body: "O" }));
		const clash = await ext(h, "PUT", b, "occupied.txt", "x-uls-rename", { headers: { "x-uls-source": "renamed.txt" } });
		expect(clash.status).toBe(409);
		expect((await ext(h, "PUT", b, "x.txt", "x-uls-rename", { headers: { "x-uls-source": "ghost.txt" } })).status).toBe(404);
		expect((await ext(h, "PUT", b, "dir/", "x-uls-rename", { headers: { "x-uls-source": "renamed.txt" } })).status).toBe(400);
	});

	it("?x-uls-versions lists history oldest first, and x-uls-as-of reads a past state", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const v1 = await s3.send(new PutObjectCommand({ Bucket: b, Key: "h.txt", Body: "one" }));
		const t1 = h.dp.now + 500;
		const v2 = await s3.send(new PutObjectCommand({ Bucket: b, Key: "h.txt", Body: "two" }));
		const res = await ext(h, "GET", b, "h.txt", "x-uls-versions");
		expect(res.status).toBe(200);
		const doc = await res.json() as { key: string; versions: { versionId: string; op: string; size: number }[] };
		expect(doc.versions.map((v) => v.versionId)).toEqual([v1.VersionId, v2.VersionId]);
		expect(doc.versions.map((v) => v.size)).toEqual([3, 3]);
		expect((await ext(h, "GET", b, "nothing", "x-uls-versions")).status).toBe(404);

		const past = await s3.send(new GetObjectCommand({ Bucket: b, Key: "h.txt", ...({} as object) }));
		expect(await readText(past.Body)).toBe("two");
		const asOf = await handle(await rawSigned(h, "GET", `/${b}/h.txt`, { headers: { "x-uls-as-of": new Date(t1).toISOString() } }), h.deps);
		expect(asOf.status).toBe(200);
		expect(await asOf.text()).toBe("one");
		const before = await handle(await rawSigned(h, "GET", `/${b}/h.txt`, { headers: { "x-uls-as-of": new Date(1000).toISOString() } }), h.deps);
		expect(before.status).toBe(404);
		const both = await handle(await rawSigned(h, "GET", `/${b}/h.txt?versionId=${v1.VersionId}`, { headers: { "x-uls-as-of": new Date(t1).toISOString() } }), h.deps);
		expect(both.status).toBe(400);
	});

	it("?x-uls-restore brings back an older version as a new head", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const v1 = await s3.send(new PutObjectCommand({ Bucket: b, Key: "r.txt", Body: "original" }));
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "r.txt", Body: "clobbered" }));
		const res = await ext(h, "POST", b, "r.txt", `x-uls-restore&versionId=${v1.VersionId}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-uls-restored-from")).toBe(v1.VersionId);
		const newest = res.headers.get("x-amz-version-id")!;
		expect(newest).not.toBe(v1.VersionId);
		expect(await content(h, b, "r.txt")).toBe("original");
		expect(await content(h, b, "r.txt", v1.VersionId)).toBe("original");
		// history keeps everything, restore included
		const versions = (await (await ext(h, "GET", b, "r.txt", "x-uls-versions")).json() as { versions: { operation: string }[] }).versions;
		expect(versions.map((v) => v.operation)).toEqual(["put", "put", "restore"]);

		expect((await ext(h, "POST", b, "r.txt", "x-uls-restore")).status).toBe(400);
		expect((await ext(h, "POST", b, "r.txt", "x-uls-restore&versionId=v_00000000000000000000000000")).status).toBe(404);
		// restoring a deleted file works
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "d.txt", Body: "bye" })).then(async (put) => {
			await handle(await rawSigned(h, "DELETE", `/${b}/d.txt`), h.deps);
			expect((await ext(h, "POST", b, "d.txt", `x-uls-restore&versionId=${put.VersionId}`)).status).toBe(200);
			expect(await content(h, b, "d.txt")).toBe("bye");
		});
	});

	it("extension routes require write scope and a signed query", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "ro", Body: "x" }));
		const res = await handle(await rawSigned(h, "PUT", `/${b}/ro?x-uls-write`, { keyId: "ULS1READONLYREADONLY", headers: { "x-uls-offset": "0" }, body: "y" }), h.deps);
		expect(res.status).toBe(403);
		expect(await body(res)).toContain("AccessDenied");
		expect((await ext(h, "DELETE", b, "ro", "x-uls-write")).status).toBe(405);
	});
});

it("uses data-plane identity after a native rename for history, old-version reads, as-of and restore", async () => {
 const h=await harness(), b=makeBucket(h), s3=await client(h.deps);
 const first=await s3.send(new PutObjectCommand({Bucket:b,Key:"old/f",Body:"first"}));
 const ts=new Date(h.dp.now+500).toISOString();
 await s3.send(new PutObjectCommand({Bucket:b,Key:"old/f",Body:"second"}));
 const native=await h.dp.fetch(new Request(`https://native/v0/drives/${b}/commit`,{method:"POST",headers:{authorization:"Bearer native"},body:JSON.stringify({ops:[{op:"rename",from:"old/",to:"new/"}]})}));
 expect(native.status).toBe(200);
 const history=await ext(h,"GET",b,"new/f","x-uls-versions");
 expect(history.status).toBe(200);
 expect(await history.json()).toMatchObject({versions:[{versionId:first.VersionId},{operation:"put"}]});
 expect(await content(h,b,"new/f",first.VersionId)).toBe("first");
 const asOf=await ext(h,"GET",b,"new/f","",{headers:{"x-uls-as-of":ts}});
 expect(await asOf.text()).toBe("first");
 const restore=await ext(h,"POST",b,"new/f",`x-uls-restore&versionId=${first.VersionId}`);
 expect(restore.status).toBe(200);
 expect(await content(h,b,"new/f")).toBe("first");
 expect(await h.deps.state.get(`history:${b}:new/f`)).toBeUndefined();
 expect(await h.deps.state.get(`archive:${b}:new/f:${first.VersionId}`)).toBeUndefined();
});
