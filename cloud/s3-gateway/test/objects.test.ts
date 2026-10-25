import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { client, harness, makeBucket, rawSigned, randomBytes, readAll, readText } from "./helpers";

const status = (e: unknown): number => (e as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode;
const code = (e: unknown): string => (e as { name: string }).name;

describe("objects", () => {
	it("puts, heads and gets an object with metadata", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const put = await s3.send(new PutObjectCommand({ Bucket: b, Key: "docs/a.txt", Body: "hello world", ContentType: "text/plain" }));
		expect(put.ETag).toMatch(/^"[0-9a-f]{32}"$/);
		expect(put.VersionId).toMatch(/^v_/);
		const head = await s3.send(new HeadObjectCommand({ Bucket: b, Key: "docs/a.txt" }));
		expect(head).toMatchObject({ ContentLength: 11, ContentType: "text/plain", VersionId: put.VersionId, ETag: put.ETag, AcceptRanges: "bytes" });
		const get = await s3.send(new GetObjectCommand({ Bucket: b, Key: "docs/a.txt" }));
		expect(await readText(get.Body)).toBe("hello world");
		expect(get.ETag).toBe(put.ETag);
	});

	it("returns NoSuchKey XML for missing keys and an empty body for HEAD", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const err = await s3.send(new GetObjectCommand({ Bucket: b, Key: "nope" })).catch((e) => e);
		expect(code(err)).toBe("NoSuchKey");
		expect(status(err)).toBe(404);
		const res = await handle(await rawSigned(h, "HEAD", `/${b}/nope`), h.deps);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("");
		const xml = await (await handle(await rawSigned(h, "GET", `/${b}/nope`), h.deps)).text();
		expect(xml).toMatch(/<Error xmlns="[^"]+"><Code>NoSuchKey<\/Code><Message>[^<]+<\/Message><Resource>\/[^<]*<\/Resource><RequestId>[^<]+<\/RequestId><\/Error>/);
	});

	it("serves single byte ranges (start-end, open-ended, suffix) and rejects unsatisfiable ones", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "r", Body: "0123456789" }));
		const get = async (Range: string) => s3.send(new GetObjectCommand({ Bucket: b, Key: "r", Range }));
		const mid = await get("bytes=2-5");
		expect(await readText(mid.Body)).toBe("2345");
		expect(mid.ContentRange).toBe("bytes 2-5/10");
		expect(mid.$metadata.httpStatusCode).toBe(206);
		expect(await readText((await get("bytes=7-")).Body)).toBe("789");
		expect(await readText((await get("bytes=-3")).Body)).toBe("789");
		expect(await readText((await get("bytes=8-100")).Body)).toBe("89");
		const bad = await get("bytes=50-60").catch((e) => e);
		expect(status(bad)).toBe(416);
		expect(code(bad)).toBe("InvalidRange");
	});

	it("honours If-Match / If-None-Match on GET and PUT", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const first = await s3.send(new PutObjectCommand({ Bucket: b, Key: "c", Body: "v1" }));

		// reads
		expect(status(await s3.send(new GetObjectCommand({ Bucket: b, Key: "c", IfNoneMatch: first.ETag })).catch((e) => e))).toBe(304);
		expect(await readText((await s3.send(new GetObjectCommand({ Bucket: b, Key: "c", IfMatch: first.ETag }))).Body)).toBe("v1");
		const mismatch = await s3.send(new GetObjectCommand({ Bucket: b, Key: "c", IfMatch: '"deadbeef"' })).catch((e) => e);
		expect([status(mismatch), code(mismatch)]).toEqual([412, "PreconditionFailed"]);

		// writes
		const create = await s3.send(new PutObjectCommand({ Bucket: b, Key: "new", Body: "x", IfNoneMatch: "*" }));
		expect(create.VersionId).toBeTruthy();
		const dup = await s3.send(new PutObjectCommand({ Bucket: b, Key: "new", Body: "y", IfNoneMatch: "*" })).catch((e) => e);
		expect([status(dup), code(dup)]).toEqual([412, "PreconditionFailed"]);
		const ok = await s3.send(new PutObjectCommand({ Bucket: b, Key: "c", Body: "v2", IfMatch: first.ETag }));
		expect(ok.ETag).not.toBe(first.ETag);
		const stale = await s3.send(new PutObjectCommand({ Bucket: b, Key: "c", Body: "v3", IfMatch: first.ETag })).catch((e) => e);
		expect(status(stale)).toBe(412);
		expect(await readText((await s3.send(new GetObjectCommand({ Bucket: b, Key: "c" }))).Body)).toBe("v2");
		// If-Match on a missing key
		expect(status(await s3.send(new PutObjectCommand({ Bucket: b, Key: "ghost", Body: "g", IfMatch: first.ETag })).catch((e) => e))).toBe(412);
	});

	it("chunks a multi-shard object and reads it back across shard boundaries", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const data = randomBytes(5_000_000, 42);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "big.bin", Body: data }));
		const manifest = h.dp.drives.get(b)!.versions.at(-1)!;
		expect(manifest.shards!.length).toBeGreaterThan(1);
		expect(manifest.shards!.reduce((n, s) => n + s.n, 0)).toBe(5_000_000);
		const got = await readAll((await s3.send(new GetObjectCommand({ Bucket: b, Key: "big.bin" }))).Body);
		expect(createHash("sha256").update(got).digest("hex")).toBe(createHash("sha256").update(data).digest("hex"));
		const ranged = await readAll((await s3.send(new GetObjectCommand({ Bucket: b, Key: "big.bin", Range: "bytes=2000000-3999999" }))).Body);
		expect(Buffer.from(ranged).equals(Buffer.from(data.subarray(2_000_000, 4_000_000)))).toBe(true);
	});

	it("dedupes identical content across keys", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "one", Body: "same content" }));
		const hashes = new Set(h.dp.shards.keys());
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "two", Body: "same content" }));
		expect(new Set(h.dp.shards.keys())).toEqual(hashes);
	});

	it("rejects bodies that fail Content-MD5 / checksum headers with BadDigest", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const bad = await handle(await rawSigned(h, "PUT", `/${b}/md5`, { body: "abc", headers: { "content-md5": createHash("md5").update("zzz").digest("base64") } }), h.deps);
		expect(bad.status).toBe(400);
		expect(await bad.text()).toContain("BadDigest");
		const good = await handle(await rawSigned(h, "PUT", `/${b}/md5`, { body: "abc", headers: { "content-md5": createHash("md5").update("abc").digest("base64") } }), h.deps);
		expect(good.status).toBe(200);
	});

	it("copies an object on the same drive by reference, with REPLACE directive and versionId source", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const src = await s3.send(new PutObjectCommand({ Bucket: b, Key: "src dir/orig.txt", Body: "copy me", ContentType: "text/plain" }));
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "src dir/orig.txt", Body: "second version" }));
		const shardsBefore = h.dp.shardPuts;
		const copy = await s3.send(new CopyObjectCommand({ Bucket: b, Key: "dst/copy.txt", CopySource: `${b}/${encodeURIComponent("src dir/orig.txt")}?versionId=${src.VersionId}` }));
		expect(copy.CopyObjectResult?.ETag).toBeTruthy();
		expect(copy.VersionId).toBeTruthy();
		expect(h.dp.shardPuts).toBe(shardsBefore); // by reference: no new shard bytes
		expect(await readText((await s3.send(new GetObjectCommand({ Bucket: b, Key: "dst/copy.txt" }))).Body)).toBe("copy me");
		expect((await s3.send(new HeadObjectCommand({ Bucket: b, Key: "dst/copy.txt" }))).ContentType).toBe("text/plain");

		await s3.send(new CopyObjectCommand({ Bucket: b, Key: "dst/replaced.txt", CopySource: `${b}/${encodeURIComponent("src dir/orig.txt")}`, MetadataDirective: "REPLACE", ContentType: "application/json" }));
		const head = await s3.send(new HeadObjectCommand({ Bucket: b, Key: "dst/replaced.txt" }));
		expect(head.ContentType).toBe("application/json");
		expect(await readText((await s3.send(new GetObjectCommand({ Bucket: b, Key: "dst/replaced.txt" }))).Body)).toBe("second version");

		const missing = await s3.send(new CopyObjectCommand({ Bucket: b, Key: "x", CopySource: `${b}/absent` })).catch((e) => e);
		expect(code(missing)).toBe("NoSuchKey");
		const cross = await s3.send(new CopyObjectCommand({ Bucket: b, Key: "x", CopySource: `other-drive/src` })).catch((e) => e);
		expect(status(cross)).toBe(404);
	});

	it("deletes objects (idempotent) and many at once, reporting per-key results", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		for (const k of ["d/1", "d/2", "d/3"]) await s3.send(new PutObjectCommand({ Bucket: b, Key: k, Body: k }));
		expect((await s3.send(new DeleteObjectCommand({ Bucket: b, Key: "d/1" }))).$metadata.httpStatusCode).toBe(204);
		expect((await s3.send(new DeleteObjectCommand({ Bucket: b, Key: "d/1" }))).$metadata.httpStatusCode).toBe(204);
		expect(status(await s3.send(new GetObjectCommand({ Bucket: b, Key: "d/1" })).catch((e) => e))).toBe(404);

		const out = await s3.send(new DeleteObjectsCommand({ Bucket: b, Delete: { Objects: [{ Key: "d/2" }, { Key: "d/3" }, { Key: "d/never-existed" }] } }));
		expect(out.Deleted?.map((d) => d.Key).sort()).toEqual(["d/2", "d/3", "d/never-existed"]);
		expect(out.Errors ?? []).toEqual([]);
		const quiet = await s3.send(new DeleteObjectsCommand({ Bucket: b, Delete: { Quiet: true, Objects: [{ Key: "zzz" }] } }));
		expect(quiet.Deleted ?? []).toEqual([]);
		// Deleting the last file leaves its (now empty) folder, which lists as a "d/" directory key.
		expect((await s3.send(new ListObjectsV2Command({ Bucket: b }))).Contents?.map((c) => c.Key)).toEqual(["d/"]);
	});

	it("maps XML-special and unicode keys correctly", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const key = "weird/ünï & <tag> 日本.txt";
		await s3.send(new PutObjectCommand({ Bucket: b, Key: key, Body: "u" }));
		const list = await s3.send(new ListObjectsV2Command({ Bucket: b }));
		expect(list.Contents?.map((c) => c.Key)).toEqual([key]);
		expect(await readText((await s3.send(new GetObjectCommand({ Bucket: b, Key: key }))).Body)).toBe("u");
	});

	it("rejects unsupported operations with 501 NotImplemented XML", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const res = await handle(await rawSigned(h, "PUT", `/${b}?acl`), h.deps);
		expect(res.status).toBe(501);
		expect(await res.text()).toContain("<Code>NotImplemented</Code>");
	});
});

describe("listing", () => {
	async function seeded() {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		for (const k of ["a.txt", "docs/b.txt", "docs/c.txt", "docs/sub/d.txt", "docs/sub/e.txt", "img/1.png", "z.txt"]) await s3.send(new PutObjectCommand({ Bucket: b, Key: k, Body: k }));
		return { h, b, s3 };
	}

	it("ListObjectsV2 lists everything in key order, with sizes and etags", async () => {
		const { b, s3 } = await seeded();
		const out = await s3.send(new ListObjectsV2Command({ Bucket: b }));
		expect(out.Contents?.map((c) => c.Key)).toEqual(["a.txt", "docs/b.txt", "docs/c.txt", "docs/sub/d.txt", "docs/sub/e.txt", "img/1.png", "z.txt"]);
		expect(out.KeyCount).toBe(7);
		expect(out.IsTruncated).toBe(false);
		expect(out.Contents![0]).toMatchObject({ Size: 5, StorageClass: "STANDARD" });
		const head = await s3.send(new HeadObjectCommand({ Bucket: b, Key: "a.txt" }));
		expect(out.Contents![0]!.ETag).toBe(head.ETag);
	});

	it("filters by prefix and groups by delimiter", async () => {
		const { b, s3 } = await seeded();
		const prefixed = await s3.send(new ListObjectsV2Command({ Bucket: b, Prefix: "docs/" }));
		expect(prefixed.Contents?.map((c) => c.Key)).toEqual(["docs/b.txt", "docs/c.txt", "docs/sub/d.txt", "docs/sub/e.txt"]);
		const root = await s3.send(new ListObjectsV2Command({ Bucket: b, Delimiter: "/" }));
		expect(root.Contents?.map((c) => c.Key)).toEqual(["a.txt", "z.txt"]);
		expect(root.CommonPrefixes?.map((c) => c.Prefix)).toEqual(["docs/", "img/"]);
		const nested = await s3.send(new ListObjectsV2Command({ Bucket: b, Prefix: "docs/", Delimiter: "/" }));
		expect(nested.Contents?.map((c) => c.Key)).toEqual(["docs/b.txt", "docs/c.txt"]);
		expect(nested.CommonPrefixes?.map((c) => c.Prefix)).toEqual(["docs/sub/"]);
		const partial = await s3.send(new ListObjectsV2Command({ Bucket: b, Prefix: "docs/s", Delimiter: "/" }));
		expect(partial.CommonPrefixes?.map((c) => c.Prefix)).toEqual(["docs/sub/"]);
		const partialKey = await s3.send(new ListObjectsV2Command({ Bucket: b, Prefix: "do" }));
		expect(partialKey.KeyCount).toBe(4);
	});

	it("paginates with max-keys and continuation tokens, with no duplicates or gaps", async () => {
		const { b, s3 } = await seeded();
		const seen: string[] = [];
		let token: string | undefined, pages = 0;
		do {
			const out = await s3.send(new ListObjectsV2Command({ Bucket: b, MaxKeys: 2, ContinuationToken: token }));
			seen.push(...(out.Contents ?? []).map((c) => c.Key!));
			expect(out.KeyCount).toBeLessThanOrEqual(2);
			token = out.NextContinuationToken; pages++;
			expect(out.IsTruncated).toBe(Boolean(token));
		} while (token);
		expect(pages).toBe(4);
		expect(seen).toEqual(["a.txt", "docs/b.txt", "docs/c.txt", "docs/sub/d.txt", "docs/sub/e.txt", "img/1.png", "z.txt"]);
	});

	it("paginates through common prefixes without repeating them", async () => {
		const { b, s3 } = await seeded();
		const items: string[] = [];
		let token: string | undefined;
		do {
			const out = await s3.send(new ListObjectsV2Command({ Bucket: b, Delimiter: "/", MaxKeys: 1, ContinuationToken: token }));
			items.push(...(out.Contents ?? []).map((c) => c.Key!), ...(out.CommonPrefixes ?? []).map((c) => c.Prefix!));
			token = out.NextContinuationToken;
		} while (token);
		expect(items).toEqual(["a.txt", "docs/", "img/", "z.txt"]);
	});

	it("honours StartAfter and rejects bad continuation tokens", async () => {
		const { b, s3 } = await seeded();
		const out = await s3.send(new ListObjectsV2Command({ Bucket: b, StartAfter: "docs/c.txt", MaxKeys: 2 }));
		expect(out.Contents?.map((c) => c.Key)).toEqual(["docs/sub/d.txt", "docs/sub/e.txt"]);
		const bad = await s3.send(new ListObjectsV2Command({ Bucket: b, ContinuationToken: "!!not-base64!!" })).catch((e) => e);
		expect(status(bad)).toBe(400);
	});

	it("lists legacy v1 pages and url-encodes keys on request", async () => {
		const { h, b } = await seeded();
		const res = await handle(await rawSigned(h, "GET", `/${b}?prefix=docs/&delimiter=/&max-keys=1&encoding-type=url`), h.deps);
		const xml = await res.text();
		expect(xml).toContain("<IsTruncated>true</IsTruncated>");
		expect(xml).toContain("<Marker></Marker>");
		expect(xml).toContain("<EncodingType>url</EncodingType>");
	});

	it("ListObjectVersions returns every version newest-first plus delete markers", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const v1 = await s3.send(new PutObjectCommand({ Bucket: b, Key: "k", Body: "one" }));
		const v2 = await s3.send(new PutObjectCommand({ Bucket: b, Key: "k", Body: "twotwo" }));
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "live", Body: "x" }));
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "gone", Body: "y" }));
		await s3.send(new DeleteObjectCommand({ Bucket: b, Key: "gone" }));

		const out = await s3.send(new ListObjectVersionsCommand({ Bucket: b }));
		const k = out.Versions!.filter((v) => v.Key === "k");
		expect(k.map((v) => v.VersionId)).toEqual([v2.VersionId, v1.VersionId]);
		expect(k.map((v) => v.IsLatest)).toEqual([true, false]);
		expect(k.map((v) => v.Size)).toEqual([6, 3]);
		expect(k[0]!.ETag).toBe(v2.ETag);
		expect(out.DeleteMarkers?.map((d) => [d.Key, d.IsLatest])).toEqual([["gone", true]]);
		expect(out.Versions!.filter((v) => v.Key === "gone").length).toBe(1); // the pre-delete content version
		expect(out.IsTruncated).toBe(false);

		// pagination across versions
		const seen: string[] = [];
		let km: string | undefined, vm: string | undefined;
		for (let i = 0; i < 10; i++) {
			const page = await s3.send(new ListObjectVersionsCommand({ Bucket: b, MaxKeys: 2, KeyMarker: km, VersionIdMarker: vm }));
			seen.push(...(page.Versions ?? []).map((v) => v.VersionId!), ...(page.DeleteMarkers ?? []).map((v) => v.VersionId!));
			if (!page.IsTruncated) break;
			km = page.NextKeyMarker; vm = page.NextVersionIdMarker;
		}
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen.length).toBe(5);

		const prefixed = await s3.send(new ListObjectVersionsCommand({ Bucket: b, Prefix: "li" }));
		expect(prefixed.Versions?.map((v) => v.Key)).toEqual(["live"]);
		// historic version still readable by id
		expect(await readText((await s3.send(new GetObjectCommand({ Bucket: b, Key: "k", VersionId: v1.VersionId }))).Body)).toBe("one");
	});
});
