import type { Ctx } from "./ctx";
import { DAY, ulid } from "./ctx";
import { HttpError, json, readJson } from "./http";
import { enforce, clientIp } from "./ratelimit";
import { loadDrive } from "./resources";
import { entitledDriveAccess } from "./entitlements";
import { mintDriveToken, type Authed } from "./session";
import { randomB64url, sha256Hex, TOKEN43_RE } from "./util";
import { parsePath } from "../../data-plane/src/validate";

const MAX_UPLOAD = 16 * 1024 * 1024;
const MAX_DOWNLOAD = 512 * 1024 * 1024;
type LinkRow = { id: string; drive_id: string; user_id: string; path: string; kind: "upload" | "download"; version_id: string | null; expires_at: number; revoked_at: number | null; consumed_at: number | null };
type Manifest = { path: string; versionId: string; size: number; contentType: string; shards: {h: string; n: number}[]; nextShardCursor?: number | null };

async function grant(ctx: Ctx, row: LinkRow) {
 const drive = await loadDrive(ctx, { userId: row.user_id, email: "", sid: row.id }, row.drive_id);
 if (drive.status !== "ready" || (row.kind === "upload" && drive.role === "viewer")) throw new HttpError(404, "link_unavailable");
 const access = await entitledDriveAccess(ctx, drive.org_id, row.kind === "upload" ? "write" : "read");
 return (await mintDriveToken(ctx, { sub: row.user_id, sid: row.id, org: drive.org_id, drives: [{ id: row.drive_id, access }] })).token;
}
async function data(ctx: Ctx, row: LinkRow, path: string, init: RequestInit = {}) {
 const token = await grant(ctx, row);
 const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${token}`);
 return ctx.fetch(`${ctx.env.ULS_DATA_ENDPOINT.replace(/\/$/, "")}/v0/drives/${encodeURIComponent(row.drive_id)}/${path}`, { ...init, headers, redirect: "manual" });
}
export function bearer(ctx: Ctx): string { return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(ctx.req.headers.get("authorization") ?? "")?.[1] ?? ""; }
async function active(ctx: Ctx, token: string, kind?: LinkRow["kind"]): Promise<LinkRow> {
 if (!TOKEN43_RE.test(token)) throw new HttpError(404, "link_unavailable");
 const row = await ctx.env.DB.prepare("SELECT * FROM public_links WHERE token_hash=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?").bind(await sha256Hex(token), (ctx.clock?.() ?? ctx.now)).first<LinkRow>();
 if (!row || (kind && row.kind !== kind)) throw new HttpError(404, "link_unavailable");
 return row;
}
async function recipient(ctx: Ctx, token: string, kind?: LinkRow["kind"]) {
 try { return await active(ctx, token, kind); }
 catch (error) { await enforce(ctx, `links:invalid:${clientIp(ctx)}`, 600, DAY); throw error; }
}
async function manifest(ctx: Ctx, row: LinkRow): Promise<Manifest> {
 const response = await data(ctx, row, `manifest?${new URLSearchParams({path: row.path, versionId: row.version_id!})}`);
 if (!response.ok) throw new HttpError(404, "link_unavailable");
 const result = await response.json() as Manifest;
 // Public downloads support ordinary manifests only; never silently omit paged shards.
 if (result.path !== row.path || result.versionId !== row.version_id || result.nextShardCursor) throw new HttpError(409, "unsupported_manifest");
 return { path: result.path, versionId: result.versionId, size: result.size, contentType: "application/octet-stream", shards: result.shards };
}
export async function create(ctx: Ctx, a: Authed, driveId: string) {
 const body = await readJson(ctx.req), path = body.path, kind = body.kind;
 const parsed = parsePath(path);
 if (typeof parsed === "string" || parsed.isFolder || (kind !== "download" && kind !== "upload")) throw new HttpError(400, "bad_request");
 const expiresAt = body.expiresAt;
 if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= ctx.now || expiresAt > ctx.now + 30 * DAY) throw new HttpError(400, "bad_request", "Expiry must be within 30 days.");
 const drive = await loadDrive(ctx, a, driveId);
 if (drive.status !== "ready" || drive.tier !== "individual" || (kind === "upload" && drive.role === "viewer")) throw new HttpError(403, "forbidden");
 await enforce(ctx, `links:create:${a.userId}`, 100, DAY);
 const row: LinkRow = { id: `pl_${ulid()}`, drive_id: driveId, user_id: a.userId, path: path as string, kind, version_id: null, expires_at: expiresAt, revoked_at: null, consumed_at: null };
 if (kind === "download") {
  const response = await data(ctx, row, `manifest?${new URLSearchParams({path: row.path})}`);
  if (!response.ok) throw new HttpError(404, "no_such_path");
  const m = await response.json() as Manifest;
  if (m.path !== path || !m.versionId || m.nextShardCursor) throw new HttpError(409, "unsupported_manifest");
  if (!Number.isSafeInteger(m.size) || m.size < 0 || m.size > MAX_DOWNLOAD) throw new HttpError(400, "too_large", "Public downloads support files up to 512 MB.");
  row.version_id = m.versionId;
 } else await grant(ctx, row);
 const token = randomB64url(32);
 await ctx.env.DB.prepare("INSERT INTO public_links(id,token_hash,drive_id,user_id,path,kind,version_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(row.id, await sha256Hex(token), driveId, a.userId, path, kind, row.version_id, ctx.now, expiresAt).run();
 return json({ id: row.id, token, expiresAt, kind, path }, 201);
}
export async function list(ctx: Ctx, a: Authed, driveId: string) {
 await loadDrive(ctx, a, driveId);
 const rows = await ctx.env.DB.prepare("SELECT id,path,kind,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt,consumed_at AS consumedAt FROM public_links WHERE drive_id=? AND user_id=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>? ORDER BY created_at DESC").bind(driveId, a.userId, ctx.now).all();
 return json({ links: rows.results });
}
export async function revoke(ctx: Ctx, a: Authed, driveId: string, id: string) {
 await loadDrive(ctx, a, driveId);
 const result = await ctx.env.DB.prepare("UPDATE public_links SET revoked_at=? WHERE id=? AND drive_id=? AND user_id=? AND revoked_at IS NULL").bind(ctx.now,id,driveId,a.userId).run();
 if (!result.meta.changes) throw new HttpError(404, "link_unavailable");
 return json({ok:true});
}
export async function info(ctx: Ctx, token: string) {
 const row = await recipient(ctx, token); await grant(ctx, row);
 return json({ kind: row.kind, name: row.path.split("/").pop(), expiresAt: row.expires_at, ...(row.kind === "download" ? { manifest: { ...(await manifest(ctx, row)), path: row.path.split("/").pop() } } : { maxBytes: MAX_UPLOAD }) });
}
export async function shard(ctx: Ctx, token: string, hash: string) {
 const row = await recipient(ctx, token, "download");
 if (!/^[a-f0-9]{64}$/.test(hash) || !(await manifest(ctx, row)).shards.some(s => s.h === hash)) throw new HttpError(404, "link_unavailable");
 await active(ctx, token, "download");
 const response = await data(ctx, row, `shards/${hash}`);
 if (!response.ok) throw new HttpError(404, "link_unavailable");
 return new Response(response.body, { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment", "x-content-type-options": "nosniff", "cache-control": "no-store" } });
}
async function bytes(req: Request) {
 const declared = Number(req.headers.get("content-length") ?? "0");
 if (declared > MAX_UPLOAD) throw new HttpError(413, "too_large");
 const reader = req.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
 if (reader) for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > MAX_UPLOAD) { await reader.cancel(); throw new HttpError(413, "too_large"); } chunks.push(part.value); }
 const out = new Uint8Array(length); let offset = 0; for (const c of chunks) { out.set(c, offset); offset += c.length; } return out;
}
export async function upload(ctx: Ctx, token: string) {
 await enforce(ctx, `links:upload:${clientIp(ctx)}`, 50, DAY);
 const row = await recipient(ctx, token, "upload");
 await enforce(ctx, `links:upload-token:${row.id}`, 20, DAY);
 const lock = randomB64url(16);
 const claim = await ctx.env.DB.prepare("UPDATE public_links SET upload_lock=?, locked_at=? WHERE id=? AND (upload_lock IS NULL OR locked_at<?) AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?").bind(lock,(ctx.clock?.() ?? ctx.now),row.id,(ctx.clock?.() ?? ctx.now)-10*60_000,(ctx.clock?.() ?? ctx.now)).run();
 if (!claim.meta.changes) throw new HttpError(409, "upload_in_progress");
 try {
  const body = await bytes(ctx.req); const shards: {h:string;n:number}[] = [];
  if (body.length) {
   const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), b => b.toString(16).padStart(2,"0")).join("");
   await active(ctx, token, "upload");
   const put = await data(ctx, row, `shards/${h}`, { method:"PUT", headers: { "content-length": String(body.length), "content-type":"application/octet-stream" }, body });
   if (!put.ok) throw new HttpError(put.status, "upload_failed");
   shards.push({h,n:body.length});
  }
  await active(ctx, token, "upload");
  const commit = await data(ctx, row, "commit", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ops:[{op:"put",path:row.path,ifAbsent:true,size:body.length,contentType:"application/octet-stream",mtimeMs:(ctx.clock?.() ?? ctx.now),shards}]})});
  if (!commit.ok) throw new HttpError(commit.status, "upload_failed");
  await ctx.env.DB.prepare("UPDATE public_links SET consumed_at=?,upload_lock=NULL,locked_at=NULL WHERE id=? AND upload_lock=?").bind((ctx.clock?.() ?? ctx.now),row.id,lock).run();
  return json({ok:true});
 } finally { await ctx.env.DB.prepare("UPDATE public_links SET upload_lock=NULL,locked_at=NULL WHERE id=? AND upload_lock=?").bind(row.id,lock).run(); }
}
