import type { Access, KeyRecord } from "./auth";
import type { Shard } from "./chunker";
import { base64url, digest, utf8 } from "./crypto";
import { S3Error } from "./errors";

export interface InternalTokenMinter {
  mint(key: KeyRecord, drive: string, access: Access): Promise<string>;
  mintUpload?(key: KeyRecord, drive: string, hash: string, length: number): Promise<string>;
}
export class Ed25519TokenMinter implements InternalTokenMinter {
  constructor(private readonly jwk: JsonWebKey & { kid?: string }, private readonly issuer: string, private readonly now: () => number = Date.now) {}
  async mint(principal: KeyRecord, drive: string, access: Access): Promise<string> {
    return this.sign(principal, drive, access);
  }
  async mintUpload(principal: KeyRecord, drive: string, hash: string, length: number): Promise<string> {
    return this.sign(principal, drive, "write", {hash, length});
  }
  private async sign(principal: KeyRecord, drive: string, access: Access, upload?: {hash: string; length: number}): Promise<string> {
    if (!this.jwk.kid) throw new S3Error(503, "ServiceUnavailable", "Signing key has no kid");
    const iat = Math.floor(this.now() / 1000);
    const header = base64url(utf8.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: this.jwk.kid })));
    const payload = base64url(utf8.encode(JSON.stringify({ iss: this.issuer, sub: principal.subject, typ: "drive", sid: `s3:${principal.keyId}`, org: principal.orgId, drives: [{ id: drive, access }], iat, exp: iat + 300, jti: crypto.randomUUID(), ...(upload ? {upload} : {}) })));
    const key = await crypto.subtle.importKey("jwk", this.jwk, { name: "Ed25519" }, false, ["sign"]);
    return `${header}.${payload}.${base64url(new Uint8Array(await crypto.subtle.sign("Ed25519", key, utf8.encode(`${header}.${payload}`))))}`;
  }
}
export interface FetchBinding { fetch(request: Request): Promise<Response> }
export interface DriveAdmin {
  createDrive(drive: string, placement?: string): Promise<{ driveId: string; placement: string; createdAt: number }>;
  deleteDrive(drive: string): Promise<{ ok: true }>;
}
export interface Manifest {
  path: string; versionId: string; size: number; contentType: string | null; mtimeMs: number | null; shards: Shard[];
  xattrs?: Record<string, Shard[]>;
  manifestRef?: string;
  nextShardCursor?: number | null;
}
export interface Stat { path: string; type: "file" | "folder"; versionId: string; size: number; contentType: string | null; mtimeMs: number; seq: number }
export interface Version { versionId: string; op: string; size: number | null; seq: number; ts: number; actor: string; operation?: string; restoredFrom?: string | null }
export interface DriveInfo { driveId: string; placement: string | null; createdAt: number; headSeq: number; fileCount: number; bytes: number }
export interface Entry { name: string; type: "file" | "folder"; versionId: string; size: number; mtimeMs: number }
export interface CommitResult { seq: number; results: { path: string; versionId: string; size: number }[] }
export type CommitOp =
  | { op: "put"; path: string; ifVersion?: string | null; ifAbsent?: boolean; size: number; contentType: string; mtimeMs: number; shards: Shard[]; manifestRef?: string; xattrs?: Record<string, Shard[]> }
  | { op: "delete" | "mkdir"; path: string; ifVersion?: string | null }
  | { op: "rename"; from: string; to: string; ifVersion?: string | null };

export class DataPlane {
  private readonly tokenCache = new Map<Access, {value: string; until: number}>();
  constructor(private readonly binding: FetchBinding, private readonly tokens: InternalTokenMinter, private readonly principal: KeyRecord, readonly drive: string) {}
  private async token(access: Access): Promise<string> {
    let token = this.tokenCache.get(access);
    if (!token || token.until <= Date.now()) { token = {value: await this.tokens.mint(this.principal, this.drive, access), until: Date.now() + 240_000}; this.tokenCache.set(access, token); }
    return token.value;
  }
  private async request(rest: string, method = "GET", body?: BodyInit, params: Record<string, string> = {}, extraHeaders: Record<string,string> = {}): Promise<Response> {
    const url = new URL(`https://data-plane.internal/v0/drives/${encodeURIComponent(this.drive)}${rest ? `/${rest}` : ""}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers = new Headers({ authorization: `Bearer ${await this.token(method === "GET" ? "read" : "write")}` });
    if (typeof body === "string") headers.set("content-type", "application/json");
    if (typeof body === "string" || body instanceof Uint8Array) headers.set("content-length", String(typeof body === "string" ? utf8.encode(body).length : body.byteLength));
    for (const [name,value] of Object.entries(extraHeaders)) headers.set(name,value);
    const response = await this.binding.fetch(new Request(url, { method, headers, body }));
    if (!response.ok) {
      let details: { error?: string; currentVersionId?: string } = {};
      try { details = await response.json() as typeof details; } catch { /* non-JSON upstream failure */ }
      const codes: Record<string, string> = { no_such_drive: "NoSuchBucket", no_such_path: "NoSuchKey", not_a_file: "NoSuchKey", no_such_version: "NoSuchVersion", precondition_failed: "PreconditionFailed", path_conflict: "PathConflict", too_large: "EntityTooLarge", unauthorized: "AccessDenied", hash_mismatch: "BadDigest", bad_path: "InvalidArgument" };
      const status = response.status === 401 ? 403 : details.error === "not_a_file" ? 404 : response.status;
      throw new S3Error(status, codes[details.error ?? ""] ?? (status >= 500 ? "ServiceUnavailable" : "InvalidArgument"), undefined, details.currentVersionId ? { "x-amz-version-id": details.currentVersionId } : {});
    }
    return response;
  }
  private async json<T>(rest: string, params: Record<string, string> = {}): Promise<T> {
    return (await this.request(rest, "GET", undefined, params)).json() as Promise<T>;
  }
  describe(): Promise<DriveInfo> { return this.json(""); }
  stat(path: string): Promise<Stat> { return this.json("stat", { path }); }
  async manifest(path: string, versionId?: string): Promise<Manifest> {
    const manifest = await this.json<Manifest>("manifest", {path, shardCursor: "0", ...(versionId ? {versionId} : {})});
    // Legacy flat manifests keep their established whole-manifest ETag.
    if (!manifest.manifestRef && manifest.nextShardCursor !== undefined && manifest.nextShardCursor !== null) {
      const shards: Shard[] = [];
      for await (const shard of this.refs(manifest)) shards.push(shard);
      return {...manifest,shards,nextShardCursor:null};
    }
    return manifest;
  }

  async *refs(manifest: Manifest): AsyncGenerator<Shard> {
    yield* manifest.shards;
    let cursor = manifest.nextShardCursor;
    while (cursor !== undefined && cursor !== null) {
      const page = await this.json<Manifest>("manifest", {path:manifest.path,versionId:manifest.versionId,shardCursor:String(cursor)});
      yield* page.shards;
      cursor = page.nextShardCursor;
    }
  }

  async buildManifest(refs: AsyncIterable<Shard>): Promise<{size: number; shards: Shard[]; manifestRef?: string}> {
    const pages: {h:string;size:number;count:number}[] = [];
    const indexes:{h:string;size:number;pages:number}[]=[];
    let shards: Shard[] = [], size = 0;
    const metadata=async(value:unknown):Promise<string>=>{
      const response=await this.request("manifest-pages","POST",JSON.stringify(value));
      return (await response.json() as {hash:string}).hash;
    };
    const flushIndex=async()=>{
      if(indexes.length===1000)throw new S3Error(413,"EntityTooLarge","Too many manifest indexes");
      const indexSize=pages.reduce((n,page)=>n+page.size,0);
      indexes.push({h:await metadata({format:"uls-manifest-v1",size:indexSize,pages}),size:indexSize,pages:pages.length});
      pages.length=0;
    };
    const flush = async () => {
      pages.push({h:await metadata(shards.map(s=>[s.h,s.n])),size:shards.reduce((n,s)=>n+s.n,0),count:shards.length});
      shards = [];
      if(pages.length===1000)await flushIndex();
    };
    for await (const shard of refs) {
      if (shards.length === 1000) await flush();
      size += shard.n;
      if (size > 5 * 1024 ** 4) throw new S3Error(413,"EntityTooLarge");
      shards.push(shard);
    }
    if (!pages.length && !indexes.length) return {size,shards};
    if (shards.length) await flush();
    let hash:string;
    if(indexes.length){if(pages.length)await flushIndex();hash=await metadata({format:"uls-manifest-v2",size,indexes});}
    else hash=await metadata({format:"uls-manifest-v1",size,pages});
    return {size,shards:[],manifestRef:`tree:${hash}`};
  }

  async versions(path: string): Promise<Version[]> {
    const versions: Version[] = [];
    let cursor: string | null = null;
    do {
      const page: { versions: Version[]; cursor: string | null } = await this.json("versions", { path, includeRenames: "1", limit: "1000", ...(cursor ? { cursor } : {}) });
      versions.push(...page.versions); cursor = page.cursor;
    } while (cursor);
    return versions;
  }

  async *children(path: string): AsyncGenerator<Entry> {
    let cursor: string | null = null;
    do {
      const page: { entries: Entry[]; cursor: string | null } = await this.json("list", { path, includeRenames: "1", limit: "1000", ...(cursor ? { cursor } : {}) });
      yield* page.entries; cursor = page.cursor;
    } while (cursor);
  }
  async *walk(path = ""): AsyncGenerator<Stat> {
    const folders = [path];
    while (folders.length) {
      const parent = folders.pop()!;
      const prefix = parent && !parent.endsWith("/") ? `${parent}/` : parent;
      for await (const entry of this.children(parent)) {
        const key = prefix + entry.name.replace(/\/$/, "") + (entry.type === "folder" ? "/" : "");
        yield { ...entry, path: key, contentType: null, seq: 0 };
        if (entry.type === "folder") folders.push(key);
      }
    }
  }
  async changes(): Promise<{ path: string; op: string }[]> {
    const out: { path: string; op: string }[] = [];
    let after = 0;
    for (;;) {
      const page = await this.json<{ changes: { ev: number; path: string; op: string }[]; more: boolean }>("changes", { after: String(after), limit: "1000" });
      out.push(...page.changes);
      if (!page.more || page.changes.length === 0) return out;
      after = page.changes.at(-1)!.ev;
    }
  }
  async putShard(shard: Shard, bytes: Uint8Array): Promise<void> {
    await this.request(`shards/${shard.h}`, "PUT", bytes);
  }
  async missing(hashes: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (let offset = 0; offset < hashes.length; offset += 1000) {
      const result = await (await this.request("shards/missing", "POST", JSON.stringify({hashes: hashes.slice(offset, offset + 1000)}))).json() as {missing: string[]};
      missing.push(...result.missing);
    }
    return missing;
  }
  readShard(hash: string): Promise<Response> { return this.request(`shards/${hash}`); }
  async directUploadUrl(endpoint: string, shard: Shard): Promise<string> {
    if (!this.tokens.mintUpload) throw new S3Error(501, "NotImplemented", "Direct uploads are not configured");
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new S3Error(503, "ServiceUnavailable", "Invalid public data endpoint");
    url.pathname = `/v0/drives/${encodeURIComponent(this.drive)}/shards/${shard.h}`;
    url.searchParams.set("uploadToken", await this.tokens.mintUpload(this.principal, this.drive, shard.h, shard.n));
    return url.toString();
  }
  async commit(ops: CommitOp[], requestId?: string): Promise<CommitResult> {
    const json = JSON.stringify({ops,...(requestId ? {requestId} : {})});
    if (utf8.encode(json).byteLength <= 1024 * 1024)
      return (await this.request("commit","POST",json)).json() as Promise<CommitResult>;
    const body = ops.map(op => JSON.stringify(op)).join("\n")+"\n";
    if (utf8.encode(body).byteLength > MAX_COMMIT_BYTES) throw new S3Error(413,"EntityTooLarge","The file manifest exceeds the supported size");
    return (await this.request("commit","POST",body,{}, {"content-type":"application/x-ndjson",...(requestId ? {"x-uls-request-id":requestId} : {})})).json() as Promise<CommitResult>;
  }
  async cancelCommit(requestId: string): Promise<{committed: CommitResult | null}> {
    return (await this.request("commit-cancel", "POST", JSON.stringify({requestId}))).json() as Promise<{committed: CommitResult | null}>;
  }
  async restore(path: string, versionId: string, ifVersion?: string, ifAbsent?: boolean): Promise<CommitResult> {
    return (await this.request("restore", "POST", JSON.stringify({ path, versionId, ...(ifVersion ? { ifVersion } : {}), ...(ifAbsent ? { ifAbsent } : {}) }))).json() as Promise<CommitResult>;
  }
  async *bytes(manifest: Manifest, start = 0, end = manifest.size): AsyncGenerator<Uint8Array> {
    let offset = 0;
    for await (const shard of this.refs(manifest)) {
      if (offset >= end) break;
      const a = Math.max(0, start - offset), b = Math.min(shard.n, end - offset);
      offset += shard.n;
      if (a >= b) continue;
      const response = await this.request(`shards/${shard.h}`);
      const reader = response.body!.getReader();
      let position = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const x = Math.max(0, a - position), y = Math.min(next.value.length, b - position);
          position += next.value.length;
          if (x < y) yield next.value.subarray(x, y);
          if (position >= b) break;
        }
        if (position < b) throw new S3Error(500, "InternalError", "Truncated shard");
      } finally { await reader.cancel(); reader.releaseLock(); }
    }
  }
}

export const MAX_COMMIT_BYTES = 8 * 1024 * 1024;

/** A manifest-derived validator survives metadata-only renames and forks. */
export async function etag(manifest: Pick<Manifest, "versionId"> & Partial<Pick<Manifest, "shards" | "manifestRef">>): Promise<string> {
  return `"${(await digest(utf8.encode(manifest.manifestRef ?? (manifest.shards ? JSON.stringify(manifest.shards) : manifest.versionId)))).slice(0, 32)}"`;
}
