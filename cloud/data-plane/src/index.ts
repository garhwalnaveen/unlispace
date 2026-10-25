import { DriveAuthority } from "./drive";
import { PLACEMENTS, type Fail, type Placement } from "./types";
import {
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

function timingSafeEqual(a: string, b: string): boolean {
	const ea = new TextEncoder().encode(a);
	const eb = new TextEncoder().encode(b);
	// Constant-time compare that does not leak length through an early return.
	let diff = ea.length ^ eb.length;
	for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
	return diff === 0;
}

function authorized(request: Request, url: URL, env: Env): boolean {
	const expected = env.ULS_DEV_TOKEN;
	if (!expected) return false;
	const header = request.headers.get("Authorization");
	let token: string | null = null;
	if (header?.startsWith("Bearer ")) token = header.slice(7);
	else if (url.pathname.endsWith("/watch")) token = url.searchParams.get("token"); // browsers can't set WS headers
	return token !== null && timingSafeEqual(token, expected);
}

const shardKey = (driveId: string, hash: string): string => `shards/${driveId}/${hash}`; // lineage = driveId (M0)

function stubFor(env: Env, driveId: string, hint?: Placement | null) {
	// `wrangler types` leaves the namespace untyped; narrow it so RPC methods type-check.
	const ns = env.DRIVE_AUTHORITY as unknown as DurableObjectNamespace<DriveAuthority>;
	const id = ns.idFromName(driveId);
	return hint ? ns.get(id, { locationHint: hint }) : ns.get(id);
}

async function readJson(request: Request, maxBytes: number): Promise<unknown | Response> {
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > maxBytes) return err(413, "too_large");
	const buf = await request.arrayBuffer();
	if (buf.byteLength > maxBytes) return err(413, "too_large");
	if (buf.byteLength === 0) return {};
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

async function putShard(request: Request, env: Env, driveId: string, hash: string): Promise<Response> {
	const stub = stubFor(env, driveId);
	const d = await stub.describe();
	if (!d.ok) return failResponse(d);

	const lenHeader = request.headers.get("Content-Length");
	if (lenHeader !== null && Number(lenHeader) > MAX_SHARD_BYTES) return err(413, "too_large");
	if (!request.body) return err(400, "bad_request", "empty body");
	if (lenHeader === null) return err(411, "length_required", "Content-Length is required");
	const declared = Number(lenHeader);
	if (!Number.isInteger(declared) || declared < 0) return err(400, "bad_request", "bad Content-Length");

	const key = shardKey(driveId, hash);
	const digest = new crypto.DigestStream("SHA-256");
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
	const [toDigest, toR2] = request.body.pipeThrough(counter).tee();

	let created = false;
	try {
		const digestDone = toDigest.pipeTo(digest);
		// R2 needs a known length for a stream: FixedLengthStream gives it.
		const fixed = new FixedLengthStream(declared);
		const pipeDone = toR2.pipeTo(fixed.writable);
		const [putResult] = await Promise.all([
			env.SHARDS.put(key, fixed.readable, { onlyIf: { etagDoesNotMatch: "*" } }),
			digestDone,
			pipeDone,
		]);
		created = putResult !== null;
	} catch (e) {
		if (tooLarge) return err(413, "too_large");
		return err(400, "bad_request", `upload failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	const computed = [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	if (computed !== hash) {
		// Only remove what this request created; a pre-existing object under this key is the real shard.
		if (created) await env.SHARDS.delete(key);
		return err(400, "hash_mismatch");
	}
	await stub.markShards([[hash, seen]]);
	return json({ hash, size: seen, stored: created }, created ? 201 : 200);
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
	if (!authorized(request, url, env)) return err(401, "unauthorized");

	const m = /^\/v0\/drives\/([^/]+)(?:\/(.*))?$/.exec(path);
	if (!m) return err(404, "not_found");
	const driveId = m[1]!;
	const rest = m[2] ?? "";
	if (!DRIVE_ID_RE.test(driveId)) return err(400, "bad_request", "invalid driveId");
	const method = request.method;

	// drives
	if (rest === "") {
		if (method === "PUT") {
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
		if (method === "GET") {
			const r = await stubFor(env, driveId).describe();
			return r.ok ? json(r.data) : failResponse(r);
		}
		return err(405, "method_not_allowed");
	}

	// watch: forward the upgrade to the DO via fetch (the only non-RPC call)
	if (rest === "watch" && method === "GET") {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return err(426, "upgrade_required");
		return stubFor(env, driveId).fetch(request);
	}

	const stub = stubFor(env, driveId);

	// shards
	if (rest === "shards/missing" && method === "POST") {
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
		if (method === "PUT") return putShard(request, env, driveId, hash);
		if (method === "GET") {
			const d = await stub.describe();
			if (!d.ok) return failResponse(d);
			return getShard(request, env, driveId, hash);
		}
		return err(405, "method_not_allowed");
	}

	// commit / restore
	if (rest === "commit" && method === "POST") {
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
		const r = await stub.commit(ops, confirmed);
		return r.ok ? json(r.data) : failResponse(r);
	}
	if (rest === "restore" && method === "POST") {
		const body = await readJson(request, MAX_COMMIT_BYTES);
		if (body instanceof Response) return body;
		const p = parseRestore(body);
		if ("ok" in p) return failResponse(p);
		const r = await stub.restore(p.key, p.versionId, p.ifVersion);
		return r.ok ? json(r.data) : failResponse(r);
	}

	// reads
	if (method === "GET") {
		if (rest === "stat" || rest === "manifest" || rest === "versions" || rest === "list") {
			const p = parsePath(url.searchParams.get("path") ?? "", rest === "stat" || rest === "list");
			if (typeof p === "string") return err(400, "bad_request", p);
			if (rest === "stat") {
				const r = await stub.stat(p.key);
				return r.ok ? json(r.data) : failResponse(r);
			}
			if (rest === "manifest") {
				const r = await stub.manifest(p.key, url.searchParams.get("versionId"));
				return r.ok ? json(r.data) : failResponse(r);
			}
			if (rest === "versions") {
				const r = await stub.versions(p.key);
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
			const r = await stub.list(p.key, after, limit);
			if (!r.ok) return failResponse(r);
			const next = r.data.next === null ? null : btoa(String.fromCharCode(...new TextEncoder().encode(r.data.next))).replace(/\+/g, "-").replace(/\//g, "_");
			return json({ entries: r.data.entries, cursor: next });
		}
		if (rest === "changes") {
			const since = intParam(url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
			const limit = intParam(url, "limit", 1000, 1, 1000);
			if (since === null || limit === null) return err(400, "bad_request", "since and limit must be non-negative integers");
			const r = await stub.changes(since, limit);
			return r.ok ? json(r.data) : failResponse(r);
		}
	}
	return err(404, "not_found");
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

