import { etag, type Entry } from "./data-plane";
import { integer, S3Error, tag, xml, xmlEscape } from "./errors";
import type { ObjectContext } from "./objects";

const enc = new TextEncoder();
/** UTF-8 byte order, which is S3's key order (JS string comparison is UTF-16 order and differs for astral characters). */
export function compareKeys(a: string, b: string): number {
  const x = enc.encode(a), y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
const b64 = (s: string): string => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string): string => {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))); }
  catch { throw new S3Error(400, "InvalidArgument", "Invalid continuation token"); }
};

type Cursor = { key: string; prefix: boolean } | null;
export interface Listed { key: string; prefix: boolean; entry?: Entry }

/** Ordered walk of the drive tree. Common prefixes are collapsed in place; resuming skips what was already returned. */
export async function* walkKeys(c: ObjectContext, prefix: string, delimiter: string, after: Cursor): AsyncGenerator<Listed> {
  const dp = c.dp;
  let lastPrefix: string | null = null;
  const skipped = (candidate: string): boolean => !!after && (compareKeys(candidate, after.key) <= 0 || (after.prefix && candidate.startsWith(after.key)));
  const pruned = (folder: string): boolean => !!after && ((!after.key.startsWith(folder) && compareKeys(folder, after.key) < 0) || (after.prefix && folder.startsWith(after.key)));
  async function* visit(folder: string): AsyncGenerator<Listed> {
    let children: Entry[];
    try { children = []; for await (const e of dp.children(folder)) children.push(e); }
    catch (e) { if (e instanceof S3Error && e.code === "NoSuchKey" && folder !== "") return; throw e; }
    const items = children.map(e => ({ e, key: folder + e.name.replace(/\/$/, "") + (e.type === "folder" ? "/" : "") })).sort((a, b) => compareKeys(a.key, b.key));
    for (const { e, key } of items) {
      const matches = key.startsWith(prefix);
      if (!matches && !(e.type === "folder" && prefix.startsWith(key))) continue;
      const rest = key.slice(prefix.length);
      const cut = matches && delimiter ? rest.indexOf(delimiter) : -1;
      if (cut >= 0) {
        const common = prefix + rest.slice(0, cut + delimiter.length);
        if (common !== lastPrefix && !skipped(common)) { lastPrefix = common; yield { key: common, prefix: true }; }
        else lastPrefix = common;
        if (e.type !== "folder" || delimiter === "/") continue;
      }
      if (e.type === "folder") {
        if (pruned(key)) continue;
        const before = cut < 0 && matches && !skipped(key);
        // An empty folder is reported as a "dir/" key, like S3 console folders. Others appear only through their children.
        let any = false;
        for await (const item of visit(key)) { any = true; yield item; }
        if (before && !any) yield { key, prefix: false, entry: e };
      } else if (cut < 0 && matches && !skipped(key)) yield { key, prefix: false, entry: e };
    }
  }
  const start = prefix.slice(0, prefix.lastIndexOf("/") + 1);
  yield* visit(start);
}

function listParams(url: URL): { prefix: string; delimiter: string; max: number; encode: boolean } {
  const maxRaw = url.searchParams.get("max-keys");
  const max = Math.min(maxRaw === null ? 1000 : integer(maxRaw), 1000);
  const encoding = url.searchParams.get("encoding-type");
  if (encoding && encoding !== "url") throw new S3Error(400, "InvalidArgument", "Invalid Encoding Method specified in Request");
  return { prefix: url.searchParams.get("prefix") ?? "", delimiter: url.searchParams.get("delimiter") ?? "", max, encode: encoding === "url" };
}
const keyText = (encode: boolean) => (s: string): string => encode ? encodeURIComponent(s).replace(/%2F/g, "/") : s;
const iso = (ms: number): string => new Date(ms).toISOString();

export async function listObjects(c: ObjectContext, bucket: string): Promise<Response> {
  const q = c.url.searchParams, { prefix, delimiter, max, encode } = listParams(c.url);
  const v2 = q.get("list-type") === "2";
  if (q.has("list-type") && !v2) throw new S3Error(400, "InvalidArgument", "Invalid list-type");
  const token = v2 ? q.get("continuation-token") : null;
  const marker = v2 ? q.get("start-after") ?? "" : q.get("marker") ?? "";
  let after: Cursor = null;
  if (token) { const t = unb64(token); after = { prefix: t.startsWith("p:"), key: t.slice(2) }; }
  else if (marker) after = { prefix: false, key: marker };
  await c.dp.describe();
  const k = keyText(encode);
  let body = tag("Name", bucket) + tag("Prefix", k(prefix));
  const contents: string[] = [], common: string[] = [];
  let count = 0, truncated = false, last: Listed | null = null;
  if (max > 0) {
    for await (const item of walkKeys(c, prefix, delimiter, after)) {
      if (count === max) { truncated = true; break; }
      count++; last = item;
      if (item.prefix) common.push(`<CommonPrefixes>${tag("Prefix", k(item.key))}</CommonPrefixes>`);
      else {
        const e = item.entry!;
        contents.push(`<Contents>${tag("Key", k(item.key))}${tag("LastModified", iso(e.mtimeMs))}${tag("ETag", await etag(e.type === "folder" ? {...e, shards:[]} : await c.dp.manifest(item.key)))}${tag("Size", e.type === "folder" ? 0 : e.size)}${tag("StorageClass", "STANDARD")}</Contents>`);
      }
    }
  }
  const next = truncated && last ? b64(`${last.prefix ? "p" : "k"}:${last.key}`) : null;
  if (delimiter) body += tag("Delimiter", delimiter);
  body += tag("MaxKeys", max);
  if (encode) body += tag("EncodingType", "url");
  body += tag("IsTruncated", truncated);
  if (v2) {
    body += tag("KeyCount", count);
    if (token) body += tag("ContinuationToken", token);
    if (marker) body += tag("StartAfter", k(marker));
    if (next) body += tag("NextContinuationToken", next);
  } else {
    body += tag("Marker", k(marker));
    if (next && delimiter) body += tag("NextMarker", k(last!.key));
  }
  // A v1 caller resumes by marker: pass the last key through the same token path.
  return xml("ListBucketResult", body + contents.join("") + common.join(""));
}

export async function listVersions(c: ObjectContext, bucket: string): Promise<Response> {
  const q = c.url.searchParams, { prefix, delimiter, max, encode } = listParams(c.url);
  const keyMarker = q.get("key-marker") ?? "", versionMarker = q.get("version-id-marker") ?? "";
  if (versionMarker && !keyMarker) throw new S3Error(400, "InvalidArgument", "version-id-marker requires key-marker");
  // Universe of keys: the live tree plus every file path the change log has ever seen (deleted keys keep their markers).
  const keys = new Set<string>();
  for await (const item of walkKeys(c, prefix, "", null)) if (!item.prefix && !item.key.endsWith("/")) keys.add(item.key);
  for (const change of await c.dp.changes()) if (!change.path.endsWith("/") && change.path.startsWith(prefix)) keys.add(change.path);
  const sorted = [...keys].sort(compareKeys);
  const k = keyText(encode);
  const out: string[] = [], seenPrefixes = new Set<string>();
  let count = 0, truncated = false, nextKey = "", nextVersion = "";
  outer:
  for (const key of sorted) {
    if (keyMarker && compareKeys(key, keyMarker) < 0) continue;
    const rest = key.slice(prefix.length);
    const cut = delimiter ? rest.indexOf(delimiter) : -1;
    if (cut >= 0) {
      const cp = prefix + rest.slice(0, cut + delimiter.length);
      if (seenPrefixes.has(cp) || (keyMarker && compareKeys(cp, keyMarker) <= 0 && !keyMarker.startsWith(cp))) continue;
      if (keyMarker.startsWith(cp) && keyMarker !== cp) continue;
      seenPrefixes.add(cp);
      if (count === max) { truncated = true; break; }
      count++; nextKey = cp; nextVersion = "";
      out.push(`<CommonPrefixes>${tag("Prefix", k(cp))}</CommonPrefixes>`);
      continue;
    }
    const versions = (await c.dp.versions(key)).filter(v => v.op !== "mkdir").reverse();
    let skip = key === keyMarker && versionMarker !== "";
    for (const [i, v] of versions.entries()) {
      if (skip) { if (v.versionId === versionMarker) skip = false; continue; }
      if (key === keyMarker && !versionMarker) break;
      if (count === max) { truncated = true; break outer; }
      count++; nextKey = key; nextVersion = v.versionId;
      const common = tag("Key", k(key)) + tag("VersionId", v.versionId) + tag("IsLatest", i === 0) + tag("LastModified", iso(v.ts));
      out.push(v.op === "delete"
        ? `<DeleteMarker>${common}</DeleteMarker>`
        : `<Version>${common}${tag("ETag", await etag(await c.dp.manifest(key, v.versionId)))}${tag("Size", v.size ?? 0)}${tag("StorageClass", "STANDARD")}</Version>`);
    }
  }
  let body = tag("Name", bucket) + tag("Prefix", k(prefix)) + tag("KeyMarker", k(keyMarker)) + tag("VersionIdMarker", versionMarker);
  if (truncated) body += tag("NextKeyMarker", k(nextKey)) + (nextVersion ? tag("NextVersionIdMarker", nextVersion) : "");
  body += tag("MaxKeys", max);
  if (delimiter) body += tag("Delimiter", delimiter);
  if (encode) body += tag("EncodingType", "url");
  body += tag("IsTruncated", truncated);
  void xmlEscape;
  return xml("ListVersionsResult", body + out.join(""));
}
