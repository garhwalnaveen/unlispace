import { WorkerEntrypoint } from "cloudflare:workers";
import { DriveAuthority, EXP_HEADER } from "./drive";
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
	actor: string;
	/** null = dev token: admin on every drive */
	drives: Map<string, Access> | null;
	/** token expiry, epoch seconds; null = never */
	exp: number | null;
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
		return { actor: "dev", drives: null, exp: null };
	}
	const claims = await verifyDriveToken(token, { jwks: env.ULS_JWT_PUBLIC_JWKS, issuer: env.ULS_ISSUER });
	if (!claims) return null;
	const drives = new Map<string, Access>();
	for (const g of claims.drives) if ((drives.get(g.id) ? ACCESS_RANK[drives.get(g.id)!] : 0) < ACCESS_RANK[g.access]) drives.set(g.id, g.access);
	return { actor: claims.sub, drives, exp: claims.exp };
}

/** Contract M1 §3: read for GET stat/list/manifest/versions/changes/watch, shard GET, shards/missing; write for shard PUT, commit, restore. */
function requiredAccess(method: string, rest: string): Access | null {
	if (rest === "") return method === "GET" ? "read" : null;
	if (rest === "watch") return method === "GET" ? "read" : null;
	if (rest === "shards/missing") return method === "POST" ? "read" : null;
	if (/^shards\/[^/]+$/.test(rest)) return method === "GET" ? "read" : method === "PUT" ? "write" : null;
	if (rest === "commit" || rest === "restore") return method === "POST" ? "write" : null;
	if (method === "GET" && ["stat", "list", "manifest", "versions", "changes"].includes(rest)) return "read";
	return null;
}

const shardKey = (driveId: string, hash: string): string => `shards/${driveId}/${hash}`; // lineage = driveId (M0)

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

async function putShard(request: Request, env: Env, stub: DriveStub, driveId: string, hash: string): Promise<Response> {
	const d = await stub.describe();
	if (!d.ok) return failResponse(d);

	const lenHeader = request.headers.get("Content-Length");
	if (lenHeader !== null && Number(lenHeader) > MAX_SHARD_BYTES) return err(413, "too_large");
	if (!request.body) return err(400, "bad_request", "empty body");
	if (lenHeader === null) return err(411, "length_required", "Content-Length is required");
	const declared = Number(lenHeader);
	if (!Number.isInteger(declared) || declared < 0) return err(400, "bad_request", "bad Content-Length");

	const key = shardKey(driveId, hash);
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

	let created = false;
	try {
		// R2 verifies the SHA-256 itself before publishing the object: a wrong upload is never visible under `key`,
		// so there is nothing to clean up (and no window where a bad object can be committed against).
		const fixed = new FixedLengthStream(declared);
		const pipeDone = request.body.pipeThrough(counter).pipeTo(fixed.writable);
		const [putResult] = await Promise.all([
			env.SHARDS.put(key, fixed.readable, { sha256: hash, onlyIf: { etagDoesNotMatch: "*" } }),
			pipeDone,
		]);
		created = putResult !== null;
	} catch (e) {
		if (tooLarge) return err(413, "too_large");
		const msg = e instanceof Error ? e.message : String(e);
		if (/sha-?256|checksum|digest/i.test(msg)) return err(400, "hash_mismatch");
		return err(400, "bad_request", `upload failed: ${msg}`);
	}
	// If the object already existed, trust its recorded size (the conditional put skipped our bytes entirely).
	const size = created ? declared : ((await env.SHARDS.head(key))?.size ?? declared);
	await stub.markShards([[hash, size]]);
	return json({ hash, size, stored: created }, created ? 201 : 200);
}

async function getShard(request: Request, env: Env, driveId: string, hash: string): Promise<Response> {
	const rangeHeader = request.headers.get("Range");
	const key = shardKey(driveId, hash);
	const headers = new Headers({
		"Cache-Control": "public, max-age=31536000, immutable",
		ETag: `"${hash}"`,
		"Accept-Ranges": "bytes",
		"Content-Type": "application/octet-stream",
	});
	if (!rangeHeader) {
		const obj = await env.SHARDS.get(key);
		if (!obj) return err(404, "no_such_shard");
		headers.set("Content-Length", String(obj.size));
		return new Response(obj.body, { status: 200, headers });
	}
	const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
	if (!m || (m[1] === "" && m[2] === "")) return err(416, "bad_range");
	const head = await env.SHARDS.head(key);
	if (!head) return err(404, "no_such_shard");
	const size = head.size;
	let start: number;
	let end: number;
	if (m[1] === "") {
		const suffix = Number(m[2]);
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(m[1]);
		end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
	}
	if (start >= size || start > end) {
		return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
	}
	const obj = await env.SHARDS.get(key, { range: { offset: start, length: end - start + 1 } });
	if (!obj) return err(404, "no_such_shard");
	headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
	headers.set("Content-Length", String(end - start + 1));
	return new Response(obj.body, { status: 206, headers });
}

/** Returns hashes confirmed present in R2 (by HEAD, in parallel) among `hashes`, with sizes. */
async function headAll(env: Env, driveId: string, hashes: string[]): Promise<[string, number][]> {
	const out: [string, number][] = [];
	for (let i = 0; i < hashes.length; i += 50) {
		const batch = hashes.slice(i, i + 50);
		const heads = await Promise.all(batch.map((h) => env.SHARDS.head(shardKey(driveId, h))));
		heads.forEach((o, j) => {
			if (o) out.push([batch[j]!, o.size]);
		});
	}
	return out;
}

// ---------- routing ----------

async function handle(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path === "/healthz") return json({ ok: true });

	// Route first, so auth knows what is being asked for (and the query token is limited to the watch upgrade).
	const m = /^\/v0\/drives\/([^/]+)(?:\/(.*))?$/.exec(path);
	const method = request.method;
	const isWatchUpgrade = !!m && m[2] === "watch" && method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket";
	const principal = await authenticate(bearer(request, url, isWatchUpgrade), env);
	if (!principal) return err(401, "unauthorized");
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
	if (need === null) return rest === "" || /^(watch|commit|restore|shards\/.*|stat|list|manifest|versions|changes)$/.test(rest) ? err(405, "method_not_allowed") : err(404, "not_found");
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
		const present = await headAll(env, driveId, unknown.data);
		if (present.length) await stub.markShards(present);
		const have = new Set(present.map(([h]) => h));
		return json({ missing: unknown.data.filter((h) => !have.has(h)) });
	}
	const sm = /^shards\/([^/]+)$/.exec(rest);
	if (sm) {
		const hash = sm[1]!;
		if (!HASH_RE.test(hash)) return err(400, "bad_request", "hash must be 64 lowercase hex chars");
		if (method === "PUT") return putShard(request, env, stub, driveId, hash);
		const d = await stub.describe();
		if (!d.ok) return failResponse(d);
		return getShard(request, env, driveId, hash);
	}

	// commit / restore
	if (rest === "commit") {
		const body = await readJson(request, MAX_COMMIT_BYTES);
		if (body instanceof Response) return body;
		const ops = parseOps(body);
		if (!Array.isArray(ops)) return failResponse(ops);
		const wanted = new Set<string>();
		for (const op of ops) if (op.op === "put") for (const [h] of op.shards) wanted.add(h);
		let confirmed: [string, number][] = [];
		if (wanted.size) {
			const unknown = await stub.filterUnknown([...wanted]);
			if (!unknown.ok) return failResponse(unknown);
			confirmed = await headAll(env, driveId, unknown.data);
		}
		const r = await stub.commit(ops, confirmed, actor);
		return r.ok ? json(r.data) : failResponse(r);
	}
	if (rest === "restore") {
		const body = await readJson(request, MAX_COMMIT_BYTES);
		if (body instanceof Response) return body;
		const p = parseRestore(body);
		if ("ok" in p) return failResponse(p);
		const r = await stub.restore(p.key, p.versionId, p.ifVersion, actor);
		return r.ok ? json(r.data) : failResponse(r);
	}

	// reads (method already checked by requiredAccess)
	if (rest === "stat" || rest === "manifest" || rest === "versions" || rest === "list") {
		const p = parsePath(url.searchParams.get("path") ?? "", rest === "stat" || rest === "list");
		if (typeof p === "string") return p === BAD_UNICODE ? err(400, "bad_path", p) : err(400, "bad_request", p);
		if (rest === "stat") {
			const r = await stub.stat(p.key);
			return r.ok ? json(r.data) : failResponse(r);
		}
		if (rest === "manifest") {
			const r = await stub.manifest(p.key, url.searchParams.get("versionId"));
			return r.ok ? json(r.data) : failResponse(r);
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
			const r = await stub.versions(p.key, after, limit);
			if (!r.ok) return failResponse(r);
			return json({ versions: r.data.versions, cursor: r.data.cursor === null ? null : btoa(r.data.cursor).replace(/\+/g, "-").replace(/\//g, "_") });
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

export class DataPlaneAdmin extends WorkerEntrypoint<Env> {
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

	async deleteDrive(driveId: string): Promise<{ ok: true }> {
		if (typeof driveId !== "string" || !DRIVE_ID_RE.test(driveId)) throw new TypeError("invalid driveId");
		await stubFor(this.env, driveId).delete();
		return { ok: true };
	}

	async driveStats(driveId: string): Promise<{ headSeq: number; fileCount: number; bytes: number } | null> {
		if (typeof driveId !== "string" || !DRIVE_ID_RE.test(driveId)) return null;
		const r = await stubFor(this.env, driveId).describe();
		if (!r.ok) return null;
		return { headSeq: r.data.headSeq, fileCount: r.data.fileCount, bytes: r.data.bytes };
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await handle(request, env);
		} catch (e) {
			console.error("unhandled", e);
			return err(500, "internal", e instanceof Error ? e.message : "unknown");
		}
	},
} satisfies ExportedHandler<Env>;

