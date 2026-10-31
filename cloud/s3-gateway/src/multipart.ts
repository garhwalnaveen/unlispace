import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { collectBody, OBJECT_LIMIT, PUT_LIMIT, verifiedBody } from "./body";
import { chunkManifest, type Shard } from "./chunker";
import { base64url } from "./crypto";
import { integer, S3Error, tag, xml } from "./errors";
import { annotate, optionalHead, preconditions, type ObjectContext } from "./objects";
import type { Part, Upload } from "./state";
import { partShards, stateRows } from "./state";

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
  // Fixed chunks bound a maximum-size multipart object's manifest independently of content.
  const shards: Shard[] = await chunkManifest(tap(), (s, bytes) => c.dp.putShard(s, bytes), true);
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
  if (!requested.length || requested.length > PART_LIMIT) throw new S3Error(400, "MalformedXML", "Between 1 and 10000 parts are required");
  const done = (u: Upload): Response => xml("CompleteMultipartUploadResult", tag("Location", `/${u.drive}/${u.key}`) + tag("Bucket", u.drive) + tag("Key", u.key) + tag("ETag", u.etag), 200, { "x-amz-version-id": u.versionId! });
  if (upload.status === "complete") return done(upload);
  const lease = crypto.randomUUID();
  const locked = await c.state.multipart(upload.id, "lock", {lease});
  if (locked.status === "complete") return done(locked);
  try {
    for (let i = 1; i < requested.length; i++) if (requested[i]!.number <= requested[i - 1]!.number) throw new S3Error(400, "InvalidPartOrder");
    const stored = new Map<number,Part>();
    const wanted=new Set(requested.map(r=>r.number));
    for await (const [,part] of stateRows<Part>(c.state,`part:${upload.id}:`)) if (wanted.has(part.number)) {
      stored.set(part.number,part);
      if (stored.size===wanted.size) break;
    }
    const md5s: Buffer[] = [];
    let totalSize = 0;
    for (const r of requested) {
      const part = stored.get(r.number);
      if (!part || part.etag !== r.etag) throw new S3Error(400, "InvalidPart", `Part ${r.number} not found or ETag mismatch`);
      totalSize += part.size;
      if (!Number.isSafeInteger(totalSize) || totalSize > OBJECT_LIMIT) throw new S3Error(413,"EntityTooLarge");
      md5s.push(Buffer.from(part.etag.replaceAll('"', ""), "hex"));
    }
    const parts = createHash("sha256").update(JSON.stringify(requested)).digest("hex");
    if (locked.completion && locked.completion.parts !== parts && locked.completion.parts !== JSON.stringify(requested)) throw new S3Error(400, "InvalidPart");
    let completion = locked.completion;
    if (!completion) {
      const current = await optionalHead(c.dp, c.key);
      const conditions = await preconditions(c.request, current);
      const refs = await c.dp.buildManifest((async function* () {
        for (const requestedPart of requested) yield* partShards(c.state,upload.id,stored.get(requestedPart.number)!);
      })());
      if (refs.size !== totalSize) throw new S3Error(400,"InvalidPart","Multipart shard lengths do not match the parts");
      // Persist the exact operation before committing, so crash retries cannot make a second version.
      completion = {parts, operation:{op:"put",path:c.key,...refs,contentType:upload.contentType,mtimeMs:c.now(),...conditions},
        etag:`"${createHash("md5").update(Buffer.concat(md5s)).digest("hex")}-${requested.length}"`};
      await c.state.multipart(upload.id, "prepare", {lease,completion});
    }
    const result = await c.dp.commit([completion.operation], `multipart:${upload.id}`);
    const op = completion.operation as Extract<typeof completion.operation,{op:"put"}>;
    const manifest = await annotate(c, result, {path:c.key,size:op.size,shards:op.shards,...(op.manifestRef ? {manifestRef:op.manifestRef} : {}),contentType:upload.contentType,mtimeMs:op.mtimeMs}, "multipart");
    const finished = await c.state.multipart(upload.id,"finish",{lease,versionId:manifest.versionId,etag:completion.etag,size:op.size});
    for (const prefix of [`part:${upload.id}:`,`part-shards:${upload.id}:`,`completion:${upload.id}:`])
      for await (const [k] of stateRows(c.state,prefix)) await c.state.delete(k);
    return done(finished);
  } catch (e) {
    await c.state.multipart(upload.id, "unlock", {lease}).catch(() => undefined);
    throw e;
  }
}

export async function abortUpload(c: ObjectContext): Promise<Response> {
  const upload = await openUpload(c, c.url.searchParams.get("uploadId"));
  if (upload.status === "complete") throw new S3Error(404, "NoSuchUpload");
  if (upload.status === "completing") {
    const lease = crypto.randomUUID();
    const locked = await c.state.multipart(upload.id,"lock",{lease});
    if (locked.status === "complete") throw new S3Error(404,"NoSuchUpload");
    const {committed} = await c.dp.cancelCommit(`multipart:${upload.id}`);
    if (committed) {
      await c.state.multipart(upload.id,"finish",{lease,versionId:committed.results[0]!.versionId,etag:locked.completion?.etag,size:locked.completion?.operation.op === "put" ? locked.completion.operation.size : undefined});
      throw new S3Error(404,"NoSuchUpload");
    }
    await c.state.multipart(upload.id,"abort",{lease});
  } else await c.state.multipart(upload.id, "abort");
  return new Response(null, { status: 204 });
}

export async function listParts(c: ObjectContext): Promise<Response> {
  const upload = await openUpload(c, c.url.searchParams.get("uploadId"));
  const max = Math.min(integer(c.url.searchParams.get("max-parts"), 1000), 1000);
  const marker = integer(c.url.searchParams.get("part-number-marker"), 0);
  const prefix=`part:${upload.id}:`;
  const records = max ? await c.state.list<Part>(prefix,`${prefix}${String(marker).padStart(5,"0")}`,Math.min(max+1,1000)) : [];
  if (max===1000 && records.length===1000) records.push(...await c.state.list<Part>(prefix,records.at(-1)![0],1));
  const parts = records.map(([, p]) => p);
  const page = parts.slice(0, max), truncated = parts.length > max;
  return xml("ListPartsResult", tag("Bucket", upload.drive) + tag("Key", upload.key) + tag("UploadId", upload.id) + tag("PartNumberMarker", marker) + (truncated ? tag("NextPartNumberMarker", page.at(-1)!.number) : "") + tag("MaxParts", max) + tag("IsTruncated", truncated)
    + page.map(p => `<Part>${tag("PartNumber", p.number)}${tag("LastModified", new Date(p.modified).toISOString())}${tag("ETag", p.etag)}${tag("Size", p.size)}</Part>`).join(""));
}

export async function listUploads(c: ObjectContext): Promise<Response> {
  const prefix = c.url.searchParams.get("prefix") ?? "";
  const max=Math.min(integer(c.url.searchParams.get("max-uploads"),1000),1000);
  const marker=c.url.searchParams.get("key-marker") ?? "", uploadMarker=c.url.searchParams.get("upload-id-marker") ?? "";
  const compare=(a:Upload,b:Upload)=>a.key<b.key?-1:a.key>b.key?1:a.id<b.id?-1:a.id>b.id?1:0;
  const uploads: Upload[]=[];
  if (max) for await (const [,u] of stateRows<Upload>(c.state,"upload:")) {
    if (u.drive!==c.dp.drive || u.status==="complete" || !u.key.startsWith(prefix) || u.key<marker || (u.key===marker && (!uploadMarker || u.id<=uploadMarker))) continue;
    uploads.push(u); uploads.sort(compare); if (uploads.length>max+1) uploads.pop();
  }
  const truncated=uploads.length>max, page=uploads.slice(0,max), last=page.at(-1);
  return xml("ListMultipartUploadsResult", tag("Bucket", c.dp.drive) + tag("Prefix", prefix) + tag("MaxUploads", max) + tag("IsTruncated", truncated)
    + (truncated && last ? tag("NextKeyMarker",last.key)+tag("NextUploadIdMarker",last.id) : "")
    + page.map(u => `<Upload>${tag("Key", u.key)}${tag("UploadId", u.id)}${tag("StorageClass", "STANDARD")}${tag("Initiated", new Date(u.createdAt).toISOString())}</Upload>`).join(""));
}
