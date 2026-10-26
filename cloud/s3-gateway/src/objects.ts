import type { Auth } from "./auth";
import { collectBody, EDIT_LIMIT, PUT_LIMIT, verifiedBody } from "./body";
import { chunkManifest } from "./chunker";
import { DataPlane, etag, type CommitResult, type Manifest, type Stat } from "./data-plane";
import { editManifest, parsePatch } from "./edits";
import { integer, S3Error, tag, xml } from "./errors";
import type { StateStore, VersionAnnotation } from "./state";

export interface ObjectContext { request: Request; url: URL; auth: Auth; dp: DataPlane; state: StateStore; key: string; now: () => number; resolveSource?: (bucket: string) => Promise<DataPlane> }
export const notFound = (e: unknown, code = "NoSuchKey"): boolean => e instanceof S3Error && e.code === code;
export async function optionalHead(dp: DataPlane, key: string): Promise<Manifest | null> {
  try { return await head(dp, key); }
  catch (e) { if (notFound(e)) return null; throw e; }
}
export async function head(dp: DataPlane, key: string): Promise<Manifest> {
  if (key.endsWith("/")) {
    const stat = await dp.stat(key);
    if (stat.type !== "folder") throw new S3Error(404, "NoSuchKey");
    return { ...stat, shards: [] };
  }
  return dp.manifest(key);
}
const matches = (header: string, value: string): boolean => header.trim() === "*" || header.split(",").map(s => s.trim()).includes(value);
export async function preconditions(request: Request, manifest: Manifest | null, read = false): Promise<{ ifVersion?: string; ifAbsent?: boolean }> {
  const fail = (): never => { throw new S3Error(412, "PreconditionFailed", undefined, manifest ? { "x-amz-version-id": manifest.versionId } : {}); };
  const explicit = request.headers.get("x-uls-if-version");
  const match = request.headers.get("if-match"), none = request.headers.get("if-none-match");
  const value = manifest ? await etag(manifest) : "";
  if (explicit && (!manifest || manifest.versionId !== explicit)) fail();
  if (match && (!manifest || !matches(match, value))) fail();
  if (none && manifest && matches(none, value)) {
    if (read) throw new S3Error(304, "NotModified", undefined, { etag: value, "x-amz-version-id": manifest.versionId });
    fail();
  }
  if (!read && none && none.trim() !== "*") throw new S3Error(400, "InvalidArgument", "Writes support only If-None-Match: *");
  if (read && manifest) {
    const modified = Math.floor((manifest.mtimeMs ?? 0) / 1000) * 1000;
    const unmodifiedSince = Date.parse(request.headers.get("if-unmodified-since") ?? "");
    const modifiedSince = Date.parse(request.headers.get("if-modified-since") ?? "");
    if (!match && Number.isFinite(unmodifiedSince) && modified > unmodifiedSince) fail();
    if (!none && Number.isFinite(modifiedSince) && modified <= modifiedSince) throw new S3Error(304, "NotModified", undefined, { etag: value, "x-amz-version-id": manifest.versionId });
  }
  return { ...(manifest && (match || explicit) ? { ifVersion: manifest.versionId } : {}), ...(none ? { ifAbsent: true } : {}) };
}
export async function mutationHeaders(manifest: Manifest): Promise<Record<string, string>> {
  return { etag: await etag(manifest), "x-amz-version-id": manifest.versionId, "x-uls-size": String(manifest.size), "x-amz-object-size": String(manifest.size) };
}
export async function annotate(c: ObjectContext, result: CommitResult, manifest: Omit<Manifest, "versionId">, operation: string, restoredFrom?: string): Promise<Manifest> {
  const versionId = result.results[0]!.versionId;
  const saved = { ...manifest, versionId };
  await c.state.put<VersionAnnotation>(`version:${c.dp.drive}:${versionId}`, { operation, manifest: saved, ...(restoredFrom ? { restoredFrom } : {}) });
  return saved;
}
export async function commitManifest(c: ObjectContext, manifest: Omit<Manifest, "versionId">, conditions: { ifVersion?: string; ifAbsent?: boolean }, operation = "put"): Promise<Manifest> {
  const result = await c.dp.commit([{ op: "put", path: c.key, size: manifest.size, contentType: manifest.contentType ?? "application/octet-stream", mtimeMs: manifest.mtimeMs ?? c.now(), shards: manifest.shards, ...conditions }]);
  return annotate(c, result, manifest, operation);
}
export async function getObject(c: ObjectContext): Promise<Response> {
  if (c.url.searchParams.has("partNumber")) throw new S3Error(501, "NotImplemented");
  const version = c.url.searchParams.get("versionId"), asOf = c.request.headers.get("x-uls-as-of");
  if (version && asOf) throw new S3Error(400, "InvalidArgument", "versionId and as-of are mutually exclusive");
  let versionId = version ?? undefined;
  if (asOf) {
    const epoch = Date.parse(asOf);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(asOf) || !Number.isFinite(epoch)) throw new S3Error(400, "InvalidArgument");
    const versions = await c.dp.versions(c.key);
    const selected = versions.filter(v => v.ts <= epoch).at(-1);
    if (!selected || selected.op === "delete") throw new S3Error(404, "NoSuchVersion");
    versionId = selected.versionId;
  }
  const manifest = versionId ? await c.dp.manifest(c.key, versionId) : await head(c.dp, c.key);
  await preconditions(c.request, manifest, true);
  let start = 0, end = manifest.size, status = 200;
  const headers = new Headers(await mutationHeaders(manifest));
  headers.set("content-type", manifest.contentType ?? "application/octet-stream");
  headers.set("last-modified", new Date(manifest.mtimeMs ?? 0).toUTCString());
  headers.set("accept-ranges", "bytes");
  const range = c.request.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2]) || manifest.size === 0) throw new S3Error(416, "InvalidRange", undefined, { "content-range": `bytes */${manifest.size}` });
    if (!m[1]) {
      const suffix = integer(m[2]!);
      if (!suffix) throw new S3Error(416, "InvalidRange");
      start = Math.max(0, manifest.size - suffix);
    } else {
      start = integer(m[1]);
      if (m[2]) end = Math.min(manifest.size, integer(m[2]) + 1);
    }
    if (start >= end || start >= manifest.size) throw new S3Error(416, "InvalidRange", undefined, { "content-range": `bytes */${manifest.size}` });
    status = 206; headers.set("content-range", `bytes ${start}-${end - 1}/${manifest.size}`);
  }
  headers.set("content-length", String(end - start));
  for (const [query, header] of [["response-content-type", "content-type"], ["response-content-disposition", "content-disposition"], ["response-cache-control", "cache-control"], ["response-content-language", "content-language"], ["response-expires", "expires"]]) {
    const value = c.url.searchParams.get(query!);
    if (value) headers.set(header!, value);
  }
  if (c.request.method === "HEAD") return new Response(null, { status, headers });
  const iterator = c.dp.bytes(manifest, start, end);
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); } catch (e) { controller.error(e); } },
    async cancel() { await iterator.return(undefined); },
  }), { status, headers });
}
export async function putObject(c: ObjectContext): Promise<Response> {
  const current = await optionalHead(c.dp, c.key);
  const conditions = await preconditions(c.request, current);
  const source = verifiedBody(c.request, c.auth, PUT_LIMIT);
  if (c.key.endsWith("/")) {
    try { await collectBody(source, 0); }
    catch (error) { if (error instanceof S3Error && error.code === "EntityTooLarge") throw new S3Error(400, "InvalidArgument", "Folder bodies must be empty"); throw error; }
    if (conditions.ifAbsent && current) throw new S3Error(412, "PreconditionFailed");
    const result = await c.dp.commit([{ op: "mkdir", path: c.key, ...conditions }]);
    const manifest = await annotate(c, result, { path: c.key, size: 0, shards: [], contentType: "application/x-directory", mtimeMs: c.now() }, "put");
    return new Response(null, { headers: await mutationHeaders(manifest) });
  }
  const shards = await chunkManifest(source, (s, bytes) => c.dp.putShard(s, bytes));
  const manifest = await commitManifest(c, { path: c.key, size: shards.reduce((n, s) => n + s.n, 0), shards, contentType: c.request.headers.get("content-type") ?? "application/octet-stream", mtimeMs: c.now() }, conditions);
  return new Response(null, { headers: await mutationHeaders(manifest) });
}
export async function copyObject(c: ObjectContext): Promise<Response> {
  await collectBody(verifiedBody(c.request, c.auth, 1024 * 1024), 1024 * 1024);
  const rawSource = (c.request.headers.get("x-amz-copy-source") ?? "").replace(/^\//, "");
  const split = rawSource.indexOf("?");
  let source: string;
  try { source = decodeURIComponent(split < 0 ? rawSource : rawSource.slice(0, split)); }
  catch { throw new S3Error(400, "InvalidArgument"); }
  const slash = source.indexOf("/");
  if (slash < 0) throw new S3Error(400, "InvalidArgument", "Invalid copy source");
  const drive = source.slice(0, slash), key = source.slice(slash + 1);
  const sourcePlane = c.resolveSource ? await c.resolveSource(drive) : c.dp;
  if (!c.resolveSource && drive !== c.dp.drive) throw new S3Error(501, "NotImplemented");
  const version = split < 0 ? undefined : new URLSearchParams(rawSource.slice(split + 1)).get("versionId") ?? undefined;
  const base = await sourcePlane.manifest(key, version);
  const h = new Headers();
  for (const name of ["if-match", "if-none-match", "if-modified-since", "if-unmodified-since"]) {
    const value = c.request.headers.get(`x-amz-copy-source-${name}`); if (value) h.set(name, value);
  }
  await preconditions(new Request(c.request.url, { headers: h }), base, true);
  const current = await optionalHead(c.dp, c.key);
  const conditions = await preconditions(c.request, current);
  const directive = c.request.headers.get("x-amz-metadata-directive") ?? "COPY";
  if (directive !== "COPY" && directive !== "REPLACE") throw new S3Error(400, "InvalidArgument");
  const shards = sourcePlane.drive === c.dp.drive ? base.shards : await chunkManifest(sourcePlane.bytes(base), (shard, bytes) => c.dp.putShard(shard, bytes));
  const manifest = await commitManifest(c, { ...base, shards, path: c.key, contentType: directive === "REPLACE" ? c.request.headers.get("content-type") ?? "application/octet-stream" : base.contentType, mtimeMs: c.now() }, conditions, "copy");
  return xml("CopyObjectResult", tag("ETag", await etag(manifest)) + tag("LastModified", new Date(manifest.mtimeMs!).toISOString()), 200, await mutationHeaders(manifest));
}
export async function deleteKey(c: ObjectContext, key: string, request: Request): Promise<void> {
  const current = await optionalHead(c.dp, key);
  if (!current) { await preconditions(request, null); return; }
  const conditions = await preconditions(request, current);
  if (key.endsWith("/")) { for await (const _entry of c.dp.children(key)) return; }
  await c.dp.commit([{ op: "delete", path: key, ...conditions }]);
}
export async function deleteObject(c: ObjectContext): Promise<Response> {
  if (c.url.searchParams.has("versionId")) throw new S3Error(501, "NotImplemented", "Version history is immutable");
  await collectBody(verifiedBody(c.request, c.auth, 1024 * 1024), 1024 * 1024);
  await deleteKey(c, c.key, c.request);
  return new Response(null, { status: 204 });
}
export async function editObject(c: ObjectContext, extension: string): Promise<Response> {
  if (c.key.endsWith("/")) throw new S3Error(400, "InvalidArgument");
  if (extension !== "patch" && !c.request.headers.has("content-length")) throw new S3Error(400, "InvalidArgument", "Content-Length is required");
  const body = await collectBody(verifiedBody(c.request, c.auth, EDIT_LIMIT), EDIT_LIMIT);
  const base = await optionalHead(c.dp, c.key);
  if (extension === "splice" && !base) throw new S3Error(404, "NoSuchKey");
  const conditions = await preconditions(c.request, base);
  // Partial mutations always compare-and-swap, including create, to prevent concurrent lost edits.
  const cas = base ? { ...conditions, ifVersion: base.versionId } : { ...conditions, ifAbsent: true };
  const offset = extension === "patch" ? 0 : integer(c.request.headers.get("x-uls-offset"));
  const sizeHeader = c.request.headers.get("x-uls-size");
  const size = sizeHeader === null ? undefined : integer(sizeHeader);
  if (extension === "splice" && size !== undefined) throw new S3Error(400, "InvalidArgument");
  if (extension === "patch" && c.request.headers.get("content-type")?.split(";")[0] !== "application/vnd.s3sdk.patch") throw new S3Error(400, "InvalidPatch");
  const edits = extension === "patch" ? parsePatch(body) : [{ offset, bytes: body }];
  const remove = extension === "splice" ? integer(c.request.headers.get("x-uls-remove"), 0) : undefined;
  const original = base ?? { path: c.key, versionId: "", size: 0, shards: [], contentType: c.request.headers.get("content-type") ?? "application/octet-stream", mtimeMs: c.now() };
  const updated = await editManifest(c.dp, original, edits, size, remove);
  const manifest = await commitManifest(c, { ...original, ...updated, mtimeMs: c.now() }, cas, "write");
  return new Response(null, { headers: await mutationHeaders(manifest) });
}
export async function renameObject(c: ObjectContext): Promise<Response> {
  await collectBody(verifiedBody(c.request, c.auth, 0), 0);
  let from: string;
  try { from = decodeURIComponent(c.request.headers.get("x-uls-source") ?? ""); }
  catch { throw new S3Error(400, "InvalidArgument"); }
  if (!from || from.startsWith("/") || new TextEncoder().encode(from).length > 1024 || (from.endsWith("/") && c.key.startsWith(from)) || from === c.key || from.endsWith("/") !== c.key.endsWith("/")) throw new S3Error(400, "InvalidArgument");
  const original = await head(c.dp, from);
  const conditions = await preconditions(c.request, original);
  const result = await c.dp.commit([{ op: "rename", from, to: c.key, ifVersion: conditions.ifVersion ?? original.versionId }]);
  const manifest = await annotate(c, result, { ...original, path: c.key }, "rename");
  return new Response(null, { headers: await mutationHeaders(manifest) });
}
export async function restoreObject(c: ObjectContext): Promise<Response> {
  await collectBody(verifiedBody(c.request, c.auth, 0), 0);
  const versionId = c.url.searchParams.get("versionId");
  if (!versionId) throw new S3Error(400, "InvalidArgument");
  const current = await optionalHead(c.dp, c.key);
  const conditions = await preconditions(c.request, current);
  const base = await c.dp.manifest(c.key, versionId);
  const result = await c.dp.restore(c.key, versionId, conditions.ifVersion);
  const manifest = await annotate(c, result, { ...base, mtimeMs: c.now() }, "restore", versionId);
  return new Response(null, { headers: { ...await mutationHeaders(manifest), "x-uls-restored-from": versionId } });
}
