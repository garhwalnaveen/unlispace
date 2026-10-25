import type { StateStore } from "./state";
import type { Access, KeyRecord } from "./auth";
import type { Shard } from "./chunker";
import { base64url, digest, utf8 } from "./crypto";
import { S3Error } from "./errors";

export interface InternalTokenMinter { mint(key: KeyRecord, drive: string, access: Access): Promise<string> }
export class Ed25519TokenMinter implements InternalTokenMinter {
  constructor(private readonly jwk: JsonWebKey & { kid?: string }, private readonly issuer: string, private readonly now: () => number = Date.now) {}
  async mint(principal: KeyRecord, drive: string, access: Access): Promise<string> {
    if (!this.jwk.kid) throw new S3Error(503, "ServiceUnavailable", "Signing key has no kid");
    const iat = Math.floor(this.now() / 1000);
    const header = base64url(utf8.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: this.jwk.kid })));
    const payload = base64url(utf8.encode(JSON.stringify({ iss: this.issuer, sub: principal.subject, typ: "drive", sid: `s3:${principal.keyId}`, org: principal.orgId, drives: [{ id: drive, access }], iat, exp: iat + 300, jti: crypto.randomUUID() })));
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
}
export interface Stat { path: string; type: "file" | "folder"; versionId: string; size: number; contentType: string | null; mtimeMs: number; seq: number }
export interface Version { versionId: string; op: string; size: number | null; seq: number; ts: number; actor: string; operation?: string; restoredFrom?: string | null }
export interface DriveInfo { driveId: string; placement: string | null; createdAt: number; headSeq: number; fileCount: number; bytes: number }
export interface Entry { name: string; type: "file" | "folder"; versionId: string; size: number; mtimeMs: number }
export interface CommitResult { seq: number; results: { path: string; versionId: string; size: number }[] }
export type CommitOp =
  | { op: "put"; path: string; ifVersion?: string | null; ifAbsent?: boolean; size: number; contentType: string; mtimeMs: number; shards: Shard[] }
  | { op: "delete" | "mkdir"; path: string; ifVersion?: string | null }
  | { op: "rename"; from: string; to: string; ifVersion?: string | null };

export class DataPlane {
  private readonly tokenCache = new Map<Access, string>();
  constructor(private readonly binding: FetchBinding, private readonly tokens: InternalTokenMinter, private readonly principal: KeyRecord, readonly drive: string, private readonly state?: StateStore) {}
  private async token(access: Access): Promise<string> {
    let token = this.tokenCache.get(access);
    if (!token) { token = await this.tokens.mint(this.principal, this.drive, access); this.tokenCache.set(access, token); }
    return token;
  }
  private async request(rest: string, method = "GET", body?: BodyInit, params: Record<string, string> = {}): Promise<Response> {
    const url = new URL(`https://data-plane.internal/v0/drives/${encodeURIComponent(this.drive)}${rest ? `/${rest}` : ""}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers = new Headers({ authorization: `Bearer ${await this.token(method === "GET" ? "read" : "write")}` });
    if (typeof body === "string") headers.set("content-type", "application/json");
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
    try { return await this.json("manifest", {path, ...(versionId ? {versionId} : {})}); }
    catch (e) {
      if (!(e instanceof S3Error) || e.code !== "NoSuchVersion" || !versionId) throw e;
      const archived = await this.state?.get<Manifest>(`archive:${this.drive}:${path}:${versionId}`);
      if (!archived) throw e;
      return archived;
    }
  }
  async versions(path: string): Promise<Version[]> {
    const versions: Version[] = [];
    let cursor: string | null = null;
    do {
      const page: { versions: Version[]; cursor: string | null } = await this.json("versions", { path, limit: "1000", ...(cursor ? { cursor } : {}) });
      versions.push(...page.versions); cursor = page.cursor;
    } while (cursor);
    const archived = await this.state?.get<Version[]>(`history:${this.drive}:${path}`) ?? [];
    return [...new Map([...archived, ...versions].map(v => [v.versionId, v])).values()].sort((a,b) => a.ts-b.ts || a.seq-b.seq);
  }
  async *children(path: string): AsyncGenerator<Entry> {
    let cursor: string | null = null;
    do {
      const page: { entries: Entry[]; cursor: string | null } = await this.json("list", { path, limit: "1000", ...(cursor ? { cursor } : {}) });
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
  async commit(ops: CommitOp[]): Promise<CommitResult> {
    return (await this.request("commit", "POST", JSON.stringify({ ops }))).json() as Promise<CommitResult>;
  }
  async restore(path: string, versionId: string, ifVersion?: string): Promise<CommitResult> {
    return (await this.request("restore", "POST", JSON.stringify({ path, versionId, ...(ifVersion ? { ifVersion } : {}) }))).json() as Promise<CommitResult>;
  }
  async *bytes(manifest: Manifest, start = 0, end = manifest.size): AsyncGenerator<Uint8Array> {
    let offset = 0;
    for (const shard of manifest.shards) {
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

/** A manifest-derived validator survives metadata-only renames and forks. */
export async function etag(manifest: Pick<Manifest, "versionId"> & Partial<Pick<Manifest, "shards">>): Promise<string> {
  return `"${(await digest(utf8.encode(manifest.shards ? JSON.stringify(manifest.shards) : manifest.versionId))).slice(0, 32)}"`;
}
