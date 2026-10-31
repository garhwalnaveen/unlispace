import { WorkerEntrypoint } from "cloudflare:workers";
import { getShard, signBlocks, serveBlock } from "./blocks";
import { readStreamCommit } from "./stream-commit";
import { DriveAuthority, EXP_HEADER } from "./drive";
import type { ExportHeader } from "./exports";
import { ACCESS_RANK, verifyDriveToken, type Access } from "./jwt";
import { PLACEMENTS, type Fail, type Placement } from "./types";
import {
	BAD_UNICODE,
	DRIVE_ID_RE,
	HASH_RE,
	MAX_COMMIT_BYTES,
	MAX_HASHES,
	MAX_SHARD_BYTES,
	parseOps,
	parsePath,
	parseRestore,
} from "./validate";

import { quotaFor } from "./quota";
export { StorageQuota } from "./quota";
export { DriveAuthority };

const json = (body: unknown, status = 200, headers?: HeadersInit): Response => Response.json(body, { status, headers });
// RPC stubs wrap results in a mapped type that loses `ok` discriminant narrowing in the else branch,
// so the failure branch is cast here. Callers only invoke this after checking `!r.ok`.
const failResponse = (f: unknown): Response => {
	const x = f as Fail;
	return json(x.body, x.status);
};
const err = (status: number, error: string, message?: string): Response => json(message ? { error, message } : { error }, status);

/** Compares SHA-256 digests (equal length, so no length leak) with the runtime's native constant-time compare. */
async function tokensEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
	return crypto.subtle.timingSafeEqual(da, db);
}

interface Principal {
	org: string | null;
	actor: string;
	/** null = dev token: admin on every drive */
	drives: Map<string, Access> | null;
	/** token expiry, epoch seconds; null = never */
	exp: number | null;
	upload?: {hash: string; length: number};
}

/** Extracts the bearer. The query token is honoured only when `allowQuery` (GET .../watch with a WebSocket Upgrade). */
function bearer(request: Request, url: URL, allowQuery: boolean): string | null {
	const header = request.headers.get("Authorization");
	if (header?.startsWith("Bearer ")) return header.slice(7);
	return allowQuery ? url.searchParams.get("token") : null;
}

/** Returns the principal for a valid token, or null (-> 401). */
async function authenticate(token: string | null, env: Env): Promise<Principal | null> {
	if (!token) return null;
	if (env.ULS_ALLOW_DEV_TOKEN === "1" && env.ULS_DEV_TOKEN && (await tokensEqual(token, env.ULS_DEV_TOKEN))) {
		return { actor: "dev", org: null, drives: null, exp: null };
	}
	const claims = await verifyDriveToken(token, { jwks: env.ULS_JWT_PUBLIC_JWKS, issuer: env.ULS_ISSUER });
	if (!claims) return null;
	const drives = new Map<string, Access>();
	for (const g of claims.drives) if ((drives.get(g.id) ? ACCESS_RANK[drives.get(g.id)!] : 0) < ACCESS_RANK[g.access]) drives.set(g.id, g.access);
	return { actor: claims.sub, org: claims.org, drives, exp: claims.exp, ...(claims.upload ? {upload: claims.upload} : {}) };
}

/** Contract M1 §3: read for GET stat/list/manifest/versions/changes/watch, shard GET, shards/missing; write for shard PUT, commit, restore. */
function requiredAccess(method: string, rest: string): Access | null {
	if (rest === "") return method === "GET" ? "read" : null;
	if (rest === "watch") return method === "GET" ? "read" : null;
	if (rest === "shards/missing") return method === "POST" ? "read" : null;
	if (/^shards\/[^/]+$/.test(rest)) return method === "GET" ? "read" : method === "PUT" ? "write" : null;
	if (rest === "commit" || rest === "restore" || rest === "commit-cancel" || rest === "manifest-pages") return method === "POST" ? "write" : null;
	if (method === "GET" && ["stat", "list", "search", "manifest", "versions", "tree-at", "changes"].includes(rest)) return "read";
	return null;
}

const shardKey = (driveId: string, hash: string): string => `shards/${driveId}/${hash}`; // Roots retain their existing namespace.

type DriveStub = ReturnType<typeof stubFor>;
function stubFor(env: Env, driveId: string, hint?: Placement | null) {
	// `wrangler types` leaves the namespace untyped; narrow it so RPC methods type-check.
	const ns = env.DRIVE_AUTHORITY as unknown as DurableObjectNamespace<DriveAuthority>;
	const id = ns.idFromName(driveId);
	return hint ? ns.get(id, { locationHint: hint }) : ns.get(id);
}

async function readJson(request: Request, maxBytes: number): Promise<unknown | Response> {
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > maxBytes) return err(413, "too_large");
	// Read incrementally and stop as soon as the cap is passed; never buffer more than maxBytes + one chunk.
	const chunks: Uint8Array[] = [];
	let total = 0;
	if (request.body) {
		const reader = request.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return err(413, "too_large");
			}
			chunks.push(value);
		}
	}
	if (total === 0) return {};
	const buf = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		buf.set(c, off);
		off += c.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(buf));
	} catch {
		return err(400, "bad_request", "invalid JSON");
	}
}

function intParam(url: URL, name: string, def: number, min: number, max: number): number | null {
	const raw = url.searchParams.get(name);
	if (raw === null || raw === "") return def;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min) return null;
	return Math.min(n, max);
}

// ---------- shards ----------

async function putShard(request: Request, env: Env, stub: DriveStub, driveId: string, hash: string, org: string | null): Promise<Response> {
	const d = await stub.locate();
	if (!d.ok) return failResponse(d);

	const lenHeader = request.headers.get("Content-Length");
	if (lenHeader !== null && Number(lenHeader) > MAX_SHARD_BYTES) return err(413, "too_large");
	if (!request.body) return err(400, "bad_request", "empty body");
	if (lenHeader === null) return err(411, "length_required", "Content-Length is required");
	const declared = Number(lenHeader);
	if (!Number.isInteger(declared) || declared < 0) return err(400, "bad_request", "bad Content-Length");

	const key = shardKey(d.data.lineage, hash);
	// Count bytes so a lying Content-Length (or chunked body) can't exceed the cap; the cap is
	// enforced by aborting the stream, which makes the R2 put reject.
	let seen = 0;
	let tooLarge = false;
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			seen += chunk.byteLength;
			if (seen > MAX_SHARD_BYTES) {
				tooLarge = true;
				controller.error(new Error("too_large"));
				return;
			}
			controller.enqueue(chunk);
		},
	});

	const quota = org ? quotaFor(env, org) : null;
	if (quota && !await quota.reserve(key, declared)) return err(403, "over_quota");
	let stored = false;
	let created = false;
	try {
		// Verify every upload, including duplicates: a conditional put may skip checksum validation
        // when the key exists, which would grant a sibling drive access without proving possession.
		const fixed = new FixedLengthStream(declared);
		const pipeDone = request.body.pipeThrough(counter).pipeTo(fixed.writable);
		const existed = await env.SHARDS.head(key);
		await Promise.all([
			env.SHARDS.put(key, fixed.readable, { sha256: hash }),
			pipeDone,
		]);
		created = existed === null;
		stored = true;
	} catch (e) {
		// A storage timeout may follow a successful write; retain its reservation until reconciled.
		if (quota) stored = await env.SHARDS.head(key).then(Boolean).catch(() => true);
		if (tooLarge) return err(413, "too_large");
		const msg = e instanceof Error ? e.message : String(e);
		if (/sha-?256|checksum|digest/i.test(msg)) return err(400, "hash_mismatch");
		return err(400, "bad_request", `upload failed: ${msg}`);
	}
	finally { if (quota) await quota.finish(key, stored); }
	// If the object already existed, trust its recorded size (the conditional put skipped our bytes entirely).
	const size = created ? declared : ((await env.SHARDS.head(key))?.size ?? declared);
	await stub.markShards([[hash, size]]);
	return json({ hash, size, stored: created }, created ? 201 : 200);
}

// ---------- routing ----------

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const started = Date.now();
	const url = new URL(request.url);
	const path = url.pathname;
	if (path === "/healthz") return json({ ok: true });
	if (path.startsWith("/_blocks/")) return serveBlock(request, env, ctx, (drive, hash) => stubFor(env, drive).authorizeShard(hash));

	// Route first, so auth knows what is being asked for (and the query token is limited to the watch upgrade).
	const m = /^\/v0\/drives\/([^/]+)(?:\/(.*))?$/.exec(path);
	const method = request.method;
	const isWatchUpgrade = !!m && m[2] === "watch" && method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket";
	const directUpload = !!m && method === "PUT" && /^shards\/[a-f0-9]{64}$/.test(m[2] ?? "") && url.searchParams.getAll("uploadToken").length === 1;
	const principal = await authenticate(directUpload ? url.searchParams.get("uploadToken") : bearer(request, url, isWatchUpgrade), env);
	if (!principal) return err(401, "unauthorized");
	if (url.searchParams.has("uploadToken") && (!directUpload || !principal.upload)) return err(403, "access_denied");
	if (principal.upload && (!directUpload || m?.[2] !== `shards/${principal.upload.hash}` || request.headers.get("content-length") !== String(principal.upload.length))) return err(403, "access_denied");
	if (!m) return err(404, "not_found");
	const driveId = m[1]!;
	const rest = m[2] ?? "";
	if (!DRIVE_ID_RE.test(driveId)) return err(400, "bad_request", "invalid driveId");

	// drive creation over HTTP is dev-only; drives are otherwise provisioned through DataPlaneAdmin
	if (rest === "" && method === "PUT") {
		if (!principal.drives && env.ULS_ALLOW_DEV_TOKEN === "1") {
			const body = await readJson(request, MAX_COMMIT_BYTES);
			if (body instanceof Response) return body;
			const p = (body as { placement?: unknown }).placement;
			if (p !== undefined && p !== null && !(PLACEMENTS as readonly unknown[]).includes(p)) {
				return err(400, "bad_request", `placement must be one of ${PLACEMENTS.join(", ")}`);
			}
			const placement = (p ?? null) as Placement | null;
			const r = await stubFor(env, driveId, placement).create(driveId, placement);
			if (!r.ok) return failResponse(r);
			return json(r.data, 201);
		}
		return err(404, "no_such_drive");
	}

	const need = requiredAccess(method, rest);
	if (need === null) return rest === "" || /^(watch|commit|restore|shards\/.*|stat|list|manifest|versions|tree-at|changes)$/.test(rest) ? err(405, "method_not_allowed") : err(404, "not_found");
	// Not in the claim, or not enough access: indistinguishable from an absent drive.
	if (principal.drives) {
		const have = principal.drives.get(driveId);
		if (!have || ACCESS_RANK[have] < ACCESS_RANK[need]) return err(404, "no_such_drive");
	}
	const actor = principal.actor;

	if (rest === "") {
		const r = await stubFor(env, driveId).describe();
		return r.ok ? json(r.data) : failResponse(r);
	}

	// watch: forward the upgrade to the DO via fetch (the only non-RPC call)
	if (rest === "watch") {
		if (!isWatchUpgrade) return err(426, "upgrade_required");
		const fwd = new Request(request);
		fwd.headers.set("x-uls-authority-branch",driveId);
		fwd.headers.delete(EXP_HEADER); // never trust a client-supplied value
		if (principal.exp !== null) fwd.headers.set(EXP_HEADER, String(principal.exp));
		return stubFor(env, driveId).fetch(fwd);
	}

	const stub = stubFor(env, driveId);

	// shards
	if (rest === "shards/missing") {
		const body = await readJson(request, MAX_COMMIT_BYTES);
		if (body instanceof Response) return body;
		const hashes = (body as { hashes?: unknown }).hashes;
		if (!Array.isArray(hashes) || hashes.length > MAX_HASHES || !hashes.every((h) => typeof h === "string" && HASH_RE.test(h))) {
			return err(400, "bad_request", `hashes must be an array of <= ${MAX_HASHES} lowercase sha256 hex strings`);
		}
		const unique = [...new Set(hashes as string[])];
		const unknown = await stub.filterUnknown(unique);
		if (!unknown.ok) return failResponse(unknown);
		return json({ missing: unknown.data });
	}
	const sm = /^shards\/([^/]+)$/.exec(rest);
	if (sm) {
		const hash = sm[1]!;
		if (!HASH_RE.test(hash)) return err(400, "bad_request", "hash must be 64 lowercase hex chars");
		if (method === "PUT") return putShard(request, env, stub, driveId, hash, principal.org);
		// Server-Timing splits auth/DO lookup from R2 time-to-first-byte for client-side diagnosis.
		// Durations only: no identifiers or secrets.
		const tLocate = Date.now();
		const d = await stub.authorizeShard(hash);
		if (!d.ok) return failResponse(d);
		const tR2 = Date.now();
		const res = await getShard(request, env, d.data.lineage, hash);
		const timed = new Response(res.body, res);
		timed.headers.set("Server-Timing", `auth;dur=${tLocate - started}, do;dur=${tR2 - tLocate}, r2;dur=${Date.now() - tR2}`);
		return timed;
	}

	if (rest === "manifest-pages") {
        const body = await readJson(request,256 * 1024);
        if (body instanceof Response) return body;
        const result = await stub.storeManifestPage(body,principal.org ?? undefined);
        return result.ok ? json(result.data) : failResponse(result);
    }
	// commit / restore
	if (rest === "commit") {
		const streamed = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() === "application/x-ndjson";
		const body = streamed ? null : await readJson(request, MAX_COMMIT_BYTES);
		if (body instanceof Response) return body;
		const ops = streamed ? await readStreamCommit(request) : parseOps(body);
		if (!Array.isArray(ops)) return failResponse(ops);
		// Physical presence in a shared lineage is not authority to reference another drive's bytes.
        const requestId = request.headers.get("x-uls-request-id") ?? (streamed ? undefined : (body as {requestId?: unknown}).requestId);
		if (requestId !== undefined && (typeof requestId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(requestId))) return err(400, "bad_request");
		const r = await stub.commit(ops, [], actor, requestId as string | undefined, principal.org ?? undefined);
		return r.ok ? json(r.data) : failResponse(r);
	}
	if (rest === "commit-cancel") {
		const body = await readJson(request, MAX_COMMIT_BYTES);
		if (body instanceof Response) return body;
		const id = (body as {requestId?: unknown})?.requestId;
		if (typeof id !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(id)) return err(400, "bad_request");
		const result = await stub.cancelCommit(id, actor);
		return result.ok ? json(result.data) : failResponse(result);
	}
	if (rest === "restore") {
		const body = await readJson(request, MAX_COMMIT_BYTES);
		if (body instanceof Response) return body;
		const p = parseRestore(body);
		if ("ok" in p) return failResponse(p);
		const r = await stub.restore(p.key, p.versionId, p.ifVersion, actor, p.ifAbsent);
		return r.ok ? json(r.data) : failResponse(r);
	}

    if (rest === "search") {
        const query = (url.searchParams.get("q") ?? "").trim();
        const cursor = url.searchParams.get("cursor");
        const limit = intParam(url,"limit",50,1,100);
        if ([...query].length<3 || query.length>256 || /[\u0000-\u001f\ud800-\udfff]/u.test(query) || limit === null)
            return err(400,"bad_request","search needs 3–256 characters");
        if (cursor !== null && (!/^(0|[1-9][0-9]{0,15})$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))
            return err(400,"bad_request","invalid cursor");
        const result = await stub.search(query,cursor,limit);
        return result.ok ? json(result.data) : failResponse(result);
    }
	// reads (method already checked by requiredAccess)
	if (rest === "stat" || rest === "manifest" || rest === "versions" || rest === "tree-at" || rest === "list") {
		const p = parsePath(url.searchParams.get("path") ?? "", rest === "stat" || rest === "tree-at" || rest === "list");
		if (typeof p === "string") return p === BAD_UNICODE ? err(400, "bad_path", p) : err(400, "bad_request", p);
		if (rest === "stat") {
			const r = await stub.stat(p.key);
			return r.ok ? json(r.data) : failResponse(r);
		}
		if (rest === "manifest") {
            const rawShardCursor = url.searchParams.get("shardCursor");
            const shardCursor = rawShardCursor === null ? null : Number(rawShardCursor);
            if (rawShardCursor !== null && (!/^(0|[1-9][0-9]*)$/.test(rawShardCursor) || !Number.isSafeInteger(shardCursor) || shardCursor! > 1_000_000)) return err(400,"bad_request","invalid shard cursor");
			const r = await stub.manifest(p.key, url.searchParams.get("versionId"),shardCursor);
			if (!r.ok) return failResponse(r);
			if (!env.ULS_BLOCK_KEY) return err(503, "block_signing_unavailable");
			const info = await stub.locate();
			if (!info.ok) return failResponse(info);
			return json({ ...r.data, ...await signBlocks(url.origin, driveId, r.data.shards, env.ULS_BLOCK_KEY, info.data.lineage) });
		}
		const limit = intParam(url, "limit", 1000, 1, 1000);
		if (limit === null) return err(400, "bad_request", "limit must be a positive integer");
		const rawCursor = url.searchParams.get("cursor");
		let after: string | null = null;
		if (rawCursor) {
			try {
				after = new TextDecoder().decode(Uint8Array.from(atob(rawCursor.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
			} catch {
				return err(400, "bad_request", "invalid cursor");
			}
		}
		if (rest === "versions") {
			// cursor is an opaque base64url of the last returned version row id
			const r = await stub.versions(p.key, after, limit, url.searchParams.get("includeRenames") === "1");
			if (!r.ok) return failResponse(r);
			return json({ versions: r.data.versions, cursor: r.data.cursor === null ? null : btoa(r.data.cursor).replace(/\+/g, "-").replace(/\//g, "_") });
		}
		if (rest === "tree-at") {
			const ts = intParam(url,"ts",-1,0,Number.MAX_SAFE_INTEGER);
			if (ts === null || ts < 0 || (p.key !== "" && !p.isFolder)) return err(400,"bad_request","folder path and ts in milliseconds required");
			const r = await stub.treeAt(p.key,ts,after,limit);
			if (!r.ok) return failResponse(r);
			return json({...r.data,cursor:r.data.cursor === null ? null : btoa(String.fromCharCode(...new TextEncoder().encode(r.data.cursor))).replace(/\+/g,"-").replace(/\//g,"_")});
		}
		const r = await stub.list(p.key, after, limit);
		if (!r.ok) return failResponse(r);
		const next = r.data.next === null ? null : btoa(String.fromCharCode(...new TextEncoder().encode(r.data.next))).replace(/\+/g, "-").replace(/\//g, "_");
		return json({ entries: r.data.entries, cursor: next });
	}
	// changes
	const limit = intParam(url, "limit", 1000, 1, 1000);
	const afterEv = url.searchParams.has("after") ? intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
	const since = intParam(url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
	if (since === null || limit === null || afterEv === null) return err(400, "bad_request", "since, after and limit must be non-negative integers");
	const r = await stub.changes(afterEv !== undefined ? { after: afterEv } : { since }, limit);
	return r.ok ? json(r.data) : failResponse(r);
}

// ---------- DataPlaneAdmin (service binding from cloud/api; contract M1 §4) ----------

/** Thrown by DataPlaneAdmin.createDrive when the drive id is taken. Cross-binding RPC preserves `name` and `message`. */
export class DriveExistsError extends Error {
	override name = "DriveExistsError";
	readonly code = "drive_exists";
	readonly status = 409;
	constructor(driveId: string) {
		super(`drive_exists: ${driveId}`);
	}
}

function adminError(code: string, status: number): Error & {code: string; status: number} {
	return Object.assign(new Error(code), {code, status});
}

export class DataPlaneAdmin extends WorkerEntrypoint<Env> {
	async configureQuota(org: string, limit: number, lineages: string[]): Promise<{usedBytes: number}> {
		if (typeof org !== "string" || !org || org.length > 128 || !Number.isSafeInteger(limit) || limit < 0 || !Array.isArray(lineages) || !lineages.every(id => DRIVE_ID_RE.test(id))) throw new TypeError("invalid quota");
		const result = await quotaFor(this.env, org).configure(limit, lineages);
        for (const lineage of new Set(lineages)) await stubFor(this.env, lineage).bindQuotaOrg(org);
        return result;
	}
    async quotaUsage(org: string, lineages: string[]): Promise<{usedBytes: number}> {
        if (typeof org !== "string" || !org || org.length > 128 || !Array.isArray(lineages) || !lineages.every(id => DRIVE_ID_RE.test(id))) throw new TypeError("invalid quota");
        return quotaFor(this.env, org).usage(lineages);
    }
    async reconcileQuota(org: string, lineages: string[]) {
        if (typeof org !== "string" || !org || org.length > 128 || !Array.isArray(lineages) || !lineages.every(id => DRIVE_ID_RE.test(id))) throw new TypeError("invalid quota");
        return quotaFor(this.env, org).reconcile(lineages);
    }
	async createDrive(driveId: string, placement?: Placement): Promise<{ driveId: string; placement: string; createdAt: number }> {
		if (typeof driveId !== "string" || !DRIVE_ID_RE.test(driveId)) throw new TypeError("invalid driveId");
		if (placement != null && !(PLACEMENTS as readonly unknown[]).includes(placement)) throw new TypeError("invalid placement");
		const p = placement ?? null;
		const r = await stubFor(this.env, driveId, p).create(driveId, p);
		if (!r.ok) {
			const f = r as unknown as Fail;
			if (f.status === 409) throw new DriveExistsError(driveId);
			throw new Error(String(f.body.error));
		}
		return { driveId, placement: r.data.placement ?? "", createdAt: r.data.createdAt };
	}

	async forkDrive(sourceId: string, newId: string) {
		const requested=Date.now();
		if (typeof sourceId!=="string" || typeof newId!=="string" || !DRIVE_ID_RE.test(sourceId) || !DRIVE_ID_RE.test(newId)) throw new TypeError("invalid driveId");
		const source=stubFor(this.env,sourceId), info=await source.forkInfo();
		if (!info.ok) throw adminError("no_such_drive",404);
		if (info.data.depth>=8) throw adminError("fork_depth_exceeded",400);
		const child=stubFor(this.env,newId,info.data.placement),token=crypto.randomUUID();
		const reserved=await child.reserveImport(token);
		if (!reserved.ok) throw new DriveExistsError(newId);
		try {
			if (!await stubFor(this.env,info.data.lineage).member(newId,false,requested+60_000)) throw adminError("slow_down",503);
			const result=await source.forkMetadata(newId,requested);
			if (!result.ok) throw adminError(String((result as unknown as Fail).body.error),(result as unknown as Fail).status);
			const header=result.data;
			await child.installFork(token,await source.metadataAuthority(),newId);
			return {driveId:newId,sourceId,lineage:header.lineage,forkSeq:header.seq,forkPoint:header.ts,placement:header.placement ?? ""};
		} catch(error) {
			// A timed-out installation can have succeeded. Retain any branch and its bytes conservatively.
			await child.cancelImport(token).catch(()=>undefined);
			throw error;
		}
	}

	async restoreSnapshot(driveId: string, key: string): Promise<{ok: true}> {
		if (!DRIVE_ID_RE.test(driveId)) throw new TypeError("invalid driveId");
		if (!key.startsWith(`snapshots/${driveId}/`) || !/^snapshots\/[^/]+\/\d+\.ndjson\.gz$/.test(key)) throw new TypeError("invalid snapshot key");
		const stub = stubFor(this.env, driveId);
		const token = crypto.randomUUID();
		const reserved = await stub.reserveImport(token);
		if (!reserved.ok) throw new DriveExistsError(driveId);
		try {
			const object = await this.env.SHARDS.get(key);
			if (!object) throw new Error("snapshot missing");
			const reader = object.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
			let pending = "";
			let header: ExportHeader | undefined;
			let rows: {id: number; payload: string}[] = [];
			let id = 0;
			let pageBytes = 0;
			try {
				for (;;) {
					const {value, done} = await reader.read();
					pending += value ?? "";
					let end: number;
					while ((end = pending.indexOf("\n")) >= 0) {
						const line = pending.slice(0, end); pending = pending.slice(end + 1);
						if (line.length > 1024 * 1024) throw new Error("snapshot row too large");
						if (!header) {
							const parsed = JSON.parse(line) as ExportHeader & {format: number};
							if (parsed.format !== 1 || parsed.driveId !== driveId || !DRIVE_ID_RE.test(parsed.lineage) ||
								!Number.isSafeInteger(parsed.seq) || parsed.seq < 0 || !Number.isInteger(parsed.depth) || parsed.depth < 0 || parsed.depth > 8) throw new Error("invalid snapshot header");
							header = parsed;
						} else {
							if (rows.length && pageBytes + line.length > 512 * 1024) {
								await stub.importPage(token, rows); rows = []; pageBytes = 0;
							}
							rows.push({id: ++id, payload: line}); pageBytes += line.length;
						}
						if (rows.length >= 100) { await stub.importPage(token, rows); rows = []; pageBytes = 0; }
					}
					if (pending.length > 1024 * 1024) throw new Error("snapshot row too large");
					if (done) break;
				}
			} finally { await reader.cancel().catch(() => undefined); }
			if (!header || pending) throw new Error("truncated snapshot");
			if (rows.length) await stub.importPage(token, rows);
			await stubFor(this.env, header.lineage).member(driveId);
			await stub.finishImport(token, driveId, header, false);
			return {ok: true};
		} catch (e) { await stub.cancelImport(token); throw e; }
	}

	async deleteDrive(driveId: string, opts?: {hard?: boolean}): Promise<{ ok: true }> {
		if (typeof driveId !== "string" || !DRIVE_ID_RE.test(driveId)) throw new TypeError("invalid driveId");
		const stub = stubFor(this.env, driveId);
		const info = await stub.lineageInfo();
		await stub.delete(opts?.hard === true);
		if (opts?.hard && info) await stubFor(this.env, info.lineage).member(driveId, true);
		return { ok: true };
	}

	async driveStats(driveId: string) {
		if (typeof driveId !== "string" || !DRIVE_ID_RE.test(driveId)) return null;
		const r = await stubFor(this.env, driveId).stats();
		if (!r.ok) return null;
		const {headSeq, fileCount, bytes, ownBytes, lineage, depth, forkOf} = r.data;
		return {headSeq, fileCount, bytes, ownBytes, lineage, depth, forkOf};
	}

	async restoreDrive(driveId: string): Promise<{ ok: true }> {
		if (typeof driveId !== "string" || !DRIVE_ID_RE.test(driveId)) throw new TypeError("invalid driveId");
		const restored = await stubFor(this.env, driveId).restoreDrive();
		if (!restored.ok) throw adminError(String((restored as unknown as Fail).body.error), (restored as unknown as Fail).status);
		return { ok: true };
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const path = new URL(request.url).pathname;
		const cors = path === "/_blocks" || path === "/v0" || path.startsWith("/v0/") || path.startsWith("/_blocks/");
		let response: Response;
		try { response = cors && request.method === "OPTIONS" ? new Response(null, {status: 204}) : await handle(request, env, ctx); }
		catch (e) {
			console.error("unhandled", e);
			response = err(500, "internal", e instanceof Error ? e.message : "unknown");
		}
		if (cors) {
			// Preserve the WebSocket response while adding headers to its mutable wrapper.
			response = new Response(response.body, response);
			response.headers.append("Vary", "Origin");
			const origin = request.headers.get("Origin");
			if (origin && (env.ULS_WEB_ORIGINS ?? "").split(",").map(s => s.trim()).includes(origin)) {
				response.headers.set("Access-Control-Allow-Origin", origin);
				response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT");
				response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Uls-Request-Id");
			}
		}
		return response;
	},
} satisfies ExportedHandler<Env>;

