import { CreateBucketCommand, DeleteBucketCommand, GetObjectCommand, HeadBucketCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { bucketName, client, harness, makeBucket, readText, text } from "./helpers";
import type { HttpRequest, MiddlewareStack, MetadataBearer } from "@smithy/types";
// All extension traffic uses the real S3 client's serializer, SigV4 signer and response parser.
function extend<T extends PutObjectCommand | GetObjectCommand | CreateBucketCommand | DeleteBucketCommand>(command: T, query = "", headers: Record<string, string> = {}, method?: string): T {
    (command.middlewareStack as unknown as MiddlewareStack<object, MetadataBearer>).add((next) => async (args) => {
        const request = args.request as HttpRequest;
        request.query = { ...request.query, ...Object.fromEntries(new URLSearchParams(query)) };
        Object.assign(request.headers, headers);
        if (method)
            request.method = method;
        return next(args);
    }, { step: "build", name: "ulsExtension", priority: "low" });
    return command;
}
async function setup() {
    const h = await harness(), b = makeBucket(h), s = await client(h.deps);
    return { h, b, s };
}
const put = (s: S3Client, b: string, k: string, body = "abcdef") => s.send(new PutObjectCommand({ Bucket: b, Key: k, Body: body }));
const get = async (s: S3Client, b: string, k: string) => readText((await s.send(new GetObjectCommand({ Bucket: b, Key: k }))).Body);
const edit = (s: S3Client, b: string, k: string, q: string, headers: Record<string, string>, body: string | Uint8Array = "", method = "PUT") => s.send(extend(new PutObjectCommand({ Bucket: b, Key: k, Body: body, ContentLength: typeof body === "string" ? text(body).length : body.length }), q, headers, method));
const history = async (s: S3Client, b: string, k: string) => JSON.parse(await readText((await s.send(extend(new GetObjectCommand({ Bucket: b, Key: k }), "x-uls-versions"))).Body)) as {
    versions: {
        versionId: string;
        operation: string;
        restoredFrom: string | null;
        isLatest: boolean;
    }[];
};
function patch(): Uint8Array {
    const out = new Uint8Array(30), v = new DataView(out.buffer);
    out.set([83, 51, 83, 80, 1, 0, 0, 0]);
    v.setUint32(8, 1);
    v.setBigUint64(12, 2n);
    v.setBigUint64(20, 2n);
    out.set(text("XY"), 28);
    return out;
}
describe("put-get-range", () => {
    it("roundtrips a file and a single byte range", async () => {
        const { s, b } = await setup();
        const p = await put(s, b, "f");
        const r = await s.send(new GetObjectCommand({ Bucket: b, Key: "f", Range: "bytes=1-3" }));
        expect(await readText(r.Body)).toBe("bcd");
        expect(r.ETag).toBe(p.ETag);
        expect(r.VersionId).toBe(p.VersionId);
    });
});
describe("write-at-offset", () => {
    it("overwrites and creates zero-filled files", async () => {
        const { s, b } = await setup();
        await edit(s, b, "f", "x-uls-write", { "x-uls-offset": "2" }, "XY");
        expect(await get(s, b, "f")).toBe("\0\0XY");
        await edit(s, b, "f", "x-uls-write", { "x-uls-offset": "3" }, "!");
        expect(await get(s, b, "f")).toBe("\0\0X!");
    });
});
describe("write-at-preconditions", () => {
    it("rejects a stale version and missing conditional target", async () => {
        const { s, b } = await setup();
        const p = await put(s, b, "f");
        await edit(s, b, "f", "x-uls-write", { "x-uls-offset": "0" }, "!");
        await expect(edit(s, b, "f", "x-uls-write", { "x-uls-offset": "0", "x-uls-if-version": p.VersionId! }, "X")).rejects.toMatchObject({ name: "PreconditionFailed" });
        await expect(edit(s, b, "missing", "x-uls-write", { "x-uls-offset": "0", "if-match": p.ETag! }, "X")).rejects.toMatchObject({ name: "PreconditionFailed" });
    });
});
describe("truncate-and-extend", () => {
    it("shrinks and grows atomically", async () => {
        const { s, b } = await setup();
        await put(s, b, "f");
        await edit(s, b, "f", "x-uls-write", { "x-uls-offset": "0", "x-uls-size": "2" });
        expect(await get(s, b, "f")).toBe("ab");
        await edit(s, b, "f", "x-uls-write", { "x-uls-offset": "0", "x-uls-size": "4" });
        expect(await get(s, b, "f")).toBe("ab\0\0");
    });
});
describe("batched-patch", () => {
    it("makes one content version", async () => {
        const { s, b } = await setup();
        await put(s, b, "f");
        await edit(s, b, "f", "x-uls-patch", { "content-type": "application/vnd.s3sdk.patch" }, patch(), "POST");
        expect(await get(s, b, "f")).toBe("abXYef");
        expect((await history(s, b, "f")).versions.map(v => v.operation)).toEqual(["put", "write"]);
    });
});
describe("version-history-and-restore", () => {
    it("orders content versions and records restore provenance", async () => {
        const { s, b } = await setup();
        const p = await put(s, b, "f");
        await put(s, b, "f", "other");
        const r = await edit(s, b, "f", `x-uls-restore&versionId=${p.VersionId}`, {}, "", "POST");
        expect(r.VersionId).not.toBe(p.VersionId);
        expect(await get(s, b, "f")).toBe("abcdef");
        const vs = (await history(s, b, "f")).versions;
        expect(vs.map(v => v.operation)).toEqual(["put", "put", "restore"]);
        expect(vs.at(-1)).toMatchObject({ restoredFrom: p.VersionId, isLatest: true });
    });
});
describe("read-as-of", () => {
    it("selects the head at a timestamp", async () => {
        const { s, b, h } = await setup();
        await put(s, b, "f", "one");
        const ts = new Date(h.dp.now + 500).toISOString();
        await put(s, b, "f", "two");
        const r = await s.send(extend(new GetObjectCommand({ Bucket: b, Key: "f" }), "", { "x-uls-as-of": ts }));
        expect(await readText(r.Body)).toBe("one");
    });
});
describe("consistent-read", () => {
    it("accepts the consistency header on reads", async () => {
        const { s, b } = await setup();
        const p = await put(s, b, "f");
        const r = await s.send(extend(new GetObjectCommand({ Bucket: b, Key: "f" }), "", { "x-uls-consistent": "true" }));
        expect(r.VersionId).toBe(p.VersionId);
        expect(await readText(r.Body)).toBe("abcdef");
    });
});
describe("listing-and-folders", () => {
    it("lists empty folders and rejects conflicting paths", async () => {
        const { s, b } = await setup();
        await put(s, b, "empty/", "");
        await put(s, b, "dir/f");
        expect((await s.send(new ListObjectsV2Command({ Bucket: b }))).Contents?.map(v => v.Key)).toEqual(["dir/f", "empty/"]);
        expect((await s.send(new ListObjectsV2Command({ Bucket: b, Delimiter: "/" }))).CommonPrefixes?.map(v => v.Prefix)).toEqual(["dir/", "empty/"]);
        await expect(put(s, b, "dir")).rejects.toMatchObject({ name: "PathConflict" });
    });
});
describe("special-character-keys", () => {
    it("roundtrips Unicode and escaped characters", async () => {
        const { s, b } = await setup();
        for (const k of ["a b/+%?#.txt", "日本語/é.txt"]) {
            await put(s, b, k, k);
            expect(await get(s, b, k)).toBe(k);
        }
    });
});
describe("fork-copy-on-write", () => {
    it("inherits history, then isolates writes in both directions", async () => {
        const { s, b } = await setup();
        const p = await put(s, b, "f", "before");
        const child = bucketName("fork");
        await s.send(extend(new CreateBucketCommand({ Bucket: child }), "", { "x-uls-fork-source": b }));
        expect(await get(s, child, "f")).toBe("before");
        expect((await history(s, child, "f")).versions[0]?.versionId).toBe(p.VersionId);
        await put(s, b, "f", "parent");
        await put(s, child, "f", "child");
        expect(await get(s, b, "f")).toBe("parent");
        expect(await get(s, child, "f")).toBe("child");
    });
});
describe("drive-lifecycle", () => {
    it("creates, resolves id and alias, describes, mounts and deletes nonempty drives", async () => {
        const { s, h } = await setup();
        const b = bucketName();
        await s.send(new CreateBucketCommand({ Bucket: b }));
        const info = await h.deps.controlPlane.resolveBucket("ULS1ABCDEFGHJKLMNPQR", b);
        await s.send(new HeadBucketCommand({ Bucket: info.driveId }));
        expect((await s.send(new ListBucketsCommand({}))).Buckets?.some(v => v.Name === b)).toBe(true);
        const d = await s.send(extend(new GetObjectCommand({ Bucket: b, Key: "" }), "x-uls-drive"));
        expect(JSON.parse(await readText(d.Body)).driveId).toBe(info.driveId);
        const m = await s.send(extend(new GetObjectCommand({ Bucket: b, Key: "" }), "x-uls-mount"));
        expect(JSON.parse(await readText(m.Body)).canWrite).toBe(true);
        await put(s, b, "f");
        await s.send(new DeleteBucketCommand({ Bucket: b }));
        await expect(s.send(new HeadBucketCommand({ Bucket: b }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    });
});
describe("drive-placement", () => {
    it("maps supported hints and rejects unknown placement", async () => {
        const { s, h } = await setup();
        for (const [hint, region] of [["sam", "enam"], ["afr", "weur"], ["me", "eeur"], ["apac", "apac"]]) {
            const b = bucketName();
            await s.send(extend(new CreateBucketCommand({ Bucket: b }), "", { "x-uls-placement": hint! }));
            expect((await h.deps.controlPlane.resolveBucket("ULS1ABCDEFGHJKLMNPQR", b)).placement).toBe(region);
        }
        await expect(s.send(extend(new CreateBucketCommand({ Bucket: bucketName() }), "", { "x-uls-placement": "mars" }))).rejects.toMatchObject({ name: "InvalidArgument" });
    });
});
describe("malformed-patch-rejected", () => {
    it("rejects truncated and trailing bytes without mutation", async () => {
        const { s, b } = await setup();
        await put(s, b, "f");
        for (const body of [patch().slice(0, -1), new Uint8Array([...patch(), 0])])
            await expect(edit(s, b, "f", "x-uls-patch", { "content-type": "application/vnd.s3sdk.patch" }, body, "POST")).rejects.toMatchObject({ name: "InvalidPatch" });
        expect(await get(s, b, "f")).toBe("abcdef");
        expect((await history(s, b, "f")).versions).toHaveLength(1);
    });
});
describe("splice-insert-remove", () => {
    it("inserts, removes, and refuses an overrun or no-op", async () => {
        const { s, b } = await setup();
        await put(s, b, "f");
        await edit(s, b, "f", "x-uls-splice", { "x-uls-offset": "2" }, "XY");
        expect(await get(s, b, "f")).toBe("abXYcdef");
        await edit(s, b, "f", "x-uls-splice", { "x-uls-offset": "2", "x-uls-remove": "2" });
        expect(await get(s, b, "f")).toBe("abcdef");
        for (const remove of ["0", "100"])
            await expect(edit(s, b, "f", "x-uls-splice", { "x-uls-offset": "1", "x-uls-remove": remove })).rejects.toMatchObject({ name: "InvalidArgument" });
    });
});
describe("rename-file-and-folder", () => {
    it("preserves ETags and content history, moves subtrees, and rejects self-moves", async () => {
        const { s, b } = await setup();
        const p = await put(s, b, "old/f");
        await edit(s, b, "new/f", "x-uls-rename", { "x-uls-source": "old/f" });
        const r = await s.send(new GetObjectCommand({ Bucket: b, Key: "new/f" }));
        expect(r.ETag).toBe(p.ETag);
        expect(await readText(r.Body)).toBe("abcdef");
        expect((await history(s, b, "new/f")).versions.map(v => v.versionId)).toEqual([p.VersionId]);
        await edit(s, b, "moved/", "x-uls-rename", { "x-uls-source": "new/" });
        expect(await get(s, b, "moved/f")).toBe("abcdef");
        expect((await history(s, b, "moved/f")).versions.map(v => v.versionId)).toEqual([p.VersionId]);
        await expect(edit(s, b, "moved/sub/", "x-uls-rename", { "x-uls-source": "moved/" })).rejects.toMatchObject({ name: "InvalidArgument" });
    });
});
