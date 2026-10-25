import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { collectBody, PUT_LIMIT, verifiedBody } from "./body";
import { chunkManifest, type Shard } from "./chunker";
import { base64url } from "./crypto";
import { integer, S3Error, tag, xml } from "./errors";
import { annotate, optionalHead, preconditions, type ObjectContext } from "./objects";
import type { Part, Upload } from "./state";

const PART_LIMIT = 10_000;
const parser = new XMLParser({ isArray: name => name === "Part", parseTagValue: false, processEntities: true });

async function openUpload(c: ObjectContext, id: string | null): Promise<Upload> {
  if (!id) throw new S3Error(400, "InvalidArgument", "uploadId is required");
  const upload = await c.state.get<Upload>(`upload:${id}`);
  if (!upload || upload.drive !== c.dp.drive || upload.key !== c.key) throw new S3Error(404, "NoSuchUpload");
  return upload;
}

export async function createUpload(c: ObjectContext): Promise<Response> {
  await collectBody(verifiedBody(c.request, c.auth, 1024 * 1024), 1024 * 1024);
  if (c.key.endsWith("/")) throw new S3Error(400, "InvalidArgument");
  await c.dp.describe();
  const id = base64url(crypto.getRandomValues(new Uint8Array(18)));
  const upload: Upload = { id, drive: c.dp.drive, key: c.key, contentType: c.request.headers.get("content-type") ?? "application/octet-stream", createdAt: c.now(), status: "open" };
  await c.state.put(`upload:${id}`, upload);
  return xml("InitiateMultipartUploadResult", tag("Bucket", c.dp.drive) + tag("Key", c.key) + tag("UploadId", id));
}

export async function uploadPart(c: ObjectContext): Promise<Response> {
  const number = integer(c.url.searchParams.get("partNumber"));
  if (number < 1 || number > PART_LIMIT) throw new S3Error(400, "InvalidArgument", "Part number must be an integer between 1 and 10000");
  if (c.request.headers.has("x-amz-copy-source")) throw new S3Error(501, "NotImplemented", "UploadPartCopy is not supported");
  const upload = await openUpload(c, c.url.searchParams.get("uploadId"));
  if (upload.status !== "open") throw new S3Error(409, "OperationAborted");
  const md5 = createHash("md5");
  const source = verifiedBody(c.request, c.auth, PUT_LIMIT);
  async function* tap(): AsyncGenerator<Uint8Array> { for await (const bytes of source) { md5.update(bytes); yield bytes; } }
  const shards: Shard[] = await chunkManifest(tap(), (s, bytes) => c.dp.putShard(s, bytes));
  const etag = `"${md5.digest("hex")}"`;
  const part: Part = { number, etag, size: shards.reduce((n, s) => n + s.n, 0), shards, modified: c.now() };
  await c.state.multipart(upload.id, "part", part);
  return new Response(null, { headers: { etag } });
}

export async function completeUpload(c: ObjectContext): Promise<Response> {
  const upload = await openUpload(c, c.url.searchParams.get("uploadId"));
  const text = new TextDecoder().decode(await collectBody(verifiedBody(c.request, c.auth, 1024 * 1024), 1024 * 1024));
  let requested: { number: number; etag: string }[];
  try {
    const doc = parser.parse(text) as { CompleteMultipartUpload?: { Part?: { PartNumber: string; ETag: string }[] } };
    requested = (doc.CompleteMultipartUpload?.Part ?? []).map(p => ({ number: integer(String(p.PartNumber)), etag: String(p.ETag).replace(/^W\//, "") }));
  } catch (e) { if (e instanceof S3Error) throw e; throw new S3Error(400, "MalformedXML"); }
  if (!requested.length) throw new S3Error(400, "MalformedXML", "At least one part is required");
  const done = (u: Upload): Response => xml("CompleteMultipartUploadResult", tag("Location", `/${u.drive}/${u.key}`) + tag("Bucket", u.drive) + tag("Key", u.key) + tag("ETag", u.etag), 200, { "x-amz-version-id": u.versionId! });
  if (upload.status === "complete") return done(upload);
  const locked = await c.state.multipart(upload.id, "lock");
  if (locked.status === "complete") return done(locked);
  try {
    for (let i = 1; i < requested.length; i++) if (requested[i]!.number <= requested[i - 1]!.number) throw new S3Error(400, "InvalidPartOrder");
    const stored = new Map((await c.state.list<Part>(`part:${upload.id}:`)).map(([, p]) => [p.number, p]));
    const shards: Shard[] = [], md5s: Buffer[] = [];
    for (const r of requested) {
      const part = stored.get(r.number);
      if (!part || part.etag !== r.etag) throw new S3Error(400, "InvalidPart", `Part ${r.number} not found or ETag mismatch`);
      shards.push(...part.shards);
      md5s.push(Buffer.from(part.etag.replaceAll('"', ""), "hex"));
    }
    const current = await optionalHead(c.dp, c.key);
    const conditions = await preconditions(c.request, current);
    const size = shards.reduce((n, s) => n + s.n, 0);
    const result = await c.dp.commit([{ op: "put", path: c.key, size, contentType: upload.contentType, mtimeMs: c.now(), shards, ...conditions }]);
    const manifest = await annotate(c, result, { path: c.key, size, shards, contentType: upload.contentType, mtimeMs: c.now() }, "multipart");
    const etag = `"${createHash("md5").update(Buffer.concat(md5s)).digest("hex")}-${requested.length}"`;
    const finished = await c.state.multipart(upload.id, "finish", { versionId: manifest.versionId, etag, size });
    for (const [k] of await c.state.list(`part:${upload.id}:`)) await c.state.delete(k);
    return done(finished);
  } catch (e) {
    await c.state.multipart(upload.id, "unlock").catch(() => undefined);
    throw e;
  }
}

export async function abortUpload(c: ObjectContext): Promise<Response> {
  const upload = await openUpload(c, c.url.searchParams.get("uploadId"));
  if (upload.status === "complete") throw new S3Error(404, "NoSuchUpload");
  await c.state.multipart(upload.id, "abort");
  return new Response(null, { status: 204 });
}

export async function listParts(c: ObjectContext): Promise<Response> {
  const upload = await openUpload(c, c.url.searchParams.get("uploadId"));
  const max = Math.min(integer(c.url.searchParams.get("max-parts"), 1000), 1000);
  const marker = integer(c.url.searchParams.get("part-number-marker"), 0);
  const parts = (await c.state.list<Part>(`part:${upload.id}:`)).map(([, p]) => p).filter(p => p.number > marker).sort((a, b) => a.number - b.number);
  const page = parts.slice(0, max), truncated = parts.length > max;
  return xml("ListPartsResult", tag("Bucket", upload.drive) + tag("Key", upload.key) + tag("UploadId", upload.id) + tag("PartNumberMarker", marker) + (truncated ? tag("NextPartNumberMarker", page.at(-1)!.number) : "") + tag("MaxParts", max) + tag("IsTruncated", truncated)
    + page.map(p => `<Part>${tag("PartNumber", p.number)}${tag("LastModified", new Date(p.modified).toISOString())}${tag("ETag", p.etag)}${tag("Size", p.size)}</Part>`).join(""));
}

export async function listUploads(c: ObjectContext): Promise<Response> {
  const prefix = c.url.searchParams.get("prefix") ?? "";
  const uploads = (await c.state.list<Upload>("upload:")).map(([, u]) => u).filter(u => u.drive === c.dp.drive && u.status !== "complete" && u.key.startsWith(prefix)).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.createdAt - b.createdAt);
  return xml("ListMultipartUploadsResult", tag("Bucket", c.dp.drive) + tag("Prefix", prefix) + tag("MaxUploads", 1000) + tag("IsTruncated", false)
    + uploads.map(u => `<Upload>${tag("Key", u.key)}${tag("UploadId", u.id)}${tag("StorageClass", "STANDARD")}${tag("Initiated", new Date(u.createdAt).toISOString())}</Upload>`).join(""));
}
