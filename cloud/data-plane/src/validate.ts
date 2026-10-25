import { fail, type Fail, type NormOp } from "./types";

export const MAX_SHARD_BYTES = 16 * 1024 * 1024;
export const MAX_COMMIT_BYTES = 1024 * 1024;
export const MAX_OPS = 1000;
export const MAX_HASHES = 1000;

export const DRIVE_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^v_[0-9A-HJKMNP-TV-Z]{26}$/;

const enc = new TextEncoder();
/** Marker message: the Worker maps it to `400 bad_path` (lone surrogates). */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const BAD_UNICODE = "path is not well-formed Unicode (lone surrogate)";

export interface ParsedPath {
	/** path without trailing slash; "" is the root */
	key: string;
	isFolder: boolean;
}

/** Validates a path per contract §3.3. `allowRoot` accepts "" (stat/list only). */
export function parsePath(p: unknown, allowRoot = false): ParsedPath | string {
	if (typeof p !== "string") return "path must be a string";
	if (p === "") return allowRoot ? { key: "", isFolder: true } : "path must not be empty";
	if (p.includes("\0")) return "path contains NUL";
	if (LONE_SURROGATE_RE.test(p)) return BAD_UNICODE;
	if (p.startsWith("/")) return "path must not start with '/'";
	if (enc.encode(p).length > 1024) return "path longer than 1024 bytes";
	const isFolder = p.endsWith("/");
	const key = isFolder ? p.slice(0, -1) : p;
	for (const seg of key.split("/")) {
		if (seg === "") return "path has an empty segment";
		if (seg === "." || seg === "..") return "path has a '.' or '..' segment";
	}
	return { key, isFolder };
}

/** External path form: folders end with "/", root is "". */
export const extPath = (key: string, isFolder: boolean): string => (isFolder && key !== "" ? key + "/" : key);

const bad = (message: string): Fail => (message.includes(BAD_UNICODE) ? fail(400, "bad_path", { message }) : fail(400, "bad_request", { message }));

function parseIfVersion(v: unknown): string | null | Fail {
	if (v === undefined || v === null) return null;
	if (typeof v !== "string" || !VERSION_RE.test(v)) return bad("ifVersion must be a version id or null");
	return v;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates the commit body and normalizes ops. */
export function parseOps(body: unknown): NormOp[] | Fail {
	if (!isObj(body) || !Array.isArray(body.ops)) return bad("body must be {ops:[...]}");
	const ops = body.ops as unknown[];
	if (ops.length < 1 || ops.length > MAX_OPS) return bad(`ops must have 1..${MAX_OPS} entries`);
	const out: NormOp[] = [];
	for (const [i, raw] of ops.entries()) {
		if (!isObj(raw)) return bad(`ops[${i}] must be an object`);
		const ifVersion = parseIfVersion(raw.ifVersion);
		if (typeof ifVersion === "object" && ifVersion !== null) return ifVersion;
		const ifAbsent = raw.ifAbsent === true;
		switch (raw.op) {
			case "put": {
				const p = parsePath(raw.path);
				if (typeof p === "string") return bad(`ops[${i}]: ${p}`);
				if (p.isFolder) return bad(`ops[${i}]: put path must not end with '/'`);
				const size = raw.size;
				if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return bad(`ops[${i}]: size must be a non-negative integer`);
				if (!Array.isArray(raw.shards)) return bad(`ops[${i}]: shards must be an array`);
				const shards: [string, number][] = [];
				let sum = 0;
				for (const s of raw.shards as unknown[]) {
					if (!isObj(s) || typeof s.h !== "string" || !HASH_RE.test(s.h) || typeof s.n !== "number" || !Number.isSafeInteger(s.n) || s.n < 1) {
						return bad(`ops[${i}]: each shard must be {h:<64 hex>, n:<positive integer>}`);
					}
					shards.push([s.h, s.n]);
					sum += s.n;
				}
				if (sum !== size) return fail(400, "bad_manifest", { message: `ops[${i}]: sum(shards.n)=${sum} != size=${size}`, path: raw.path });
				const ctype = raw.contentType === undefined || raw.contentType === null ? "application/octet-stream" : raw.contentType;
				if (typeof ctype !== "string") return bad(`ops[${i}]: contentType must be a string`);
				const mtimeMs = raw.mtimeMs === undefined || raw.mtimeMs === null ? Date.now() : raw.mtimeMs;
				if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return bad(`ops[${i}]: mtimeMs must be a number`);
				out.push({ op: "put", key: p.key, ifVersion, ifAbsent, size, ctype, mtimeMs: Math.trunc(mtimeMs), manifest: JSON.stringify(shards), shards });
				break;
			}
			case "mkdir": {
				const p = parsePath(raw.path);
				if (typeof p === "string") return bad(`ops[${i}]: ${p}`);
				out.push({ op: "mkdir", key: p.key, ifVersion, ifAbsent });
				break;
			}
			case "delete": {
				const p = parsePath(raw.path);
				if (typeof p === "string") return bad(`ops[${i}]: ${p}`);
				out.push({ op: "delete", key: p.key, isFolder: p.isFolder, ifVersion });
				break;
			}
			case "rename": {
				const f = parsePath(raw.from);
				const t = parsePath(raw.to);
				if (typeof f === "string") return bad(`ops[${i}]: from: ${f}`);
				if (typeof t === "string") return bad(`ops[${i}]: to: ${t}`);
				if (f.isFolder !== t.isFolder) return bad(`ops[${i}]: from and to must both be folders (trailing '/') or both files`);
				if (f.key === t.key) return bad(`ops[${i}]: from and to are the same`);
				if (t.key.startsWith(f.key + "/")) return bad(`ops[${i}]: cannot rename a folder into itself`);
				out.push({ op: "rename", from: f.key, to: t.key, isFolder: f.isFolder, ifVersion });
				break;
			}
			default:
				return bad(`ops[${i}]: unknown op`);
		}
	}
	return out;
}

export function parseRestore(body: unknown): { key: string; versionId: string; ifVersion: string | null } | Fail {
	if (!isObj(body)) return bad("body must be an object");
	const p = parsePath(body.path);
	if (typeof p === "string") return bad(p);
	if (p.isFolder) return bad("restore applies to files");
	if (typeof body.versionId !== "string" || !VERSION_RE.test(body.versionId)) return bad("versionId must be a version id");
	const ifVersion = parseIfVersion(body.ifVersion);
	if (typeof ifVersion === "object" && ifVersion !== null) return ifVersion;
	return { key: p.key, versionId: body.versionId, ifVersion };
}
