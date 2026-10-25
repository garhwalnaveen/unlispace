import { DRIVE_ID_RE, HASH_RE } from "./validate";
import type { Result } from "./types";
const err = (status: number, error: string): Response => Response.json({ error }, { status });
const shardKey = (lineage: string, hash: string): string => `shards/${lineage}/${hash}`;

export async function getShard(request: Request, env: Env, driveId: string, hash: string): Promise<Response> {
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

const enc = new TextEncoder();
const BLOCK_TTL_SECONDS = 15 * 60;
const payload = (lineage: string, hash: string, drive: string, exp: number) => enc.encode(`v1\n${lineage}\n${hash}\n${drive}\n${exp}`);
const keyFor = (secret: string) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function signBlocks(origin: string, drive: string, shards: { h: string }[], secret: string) {
	const exp = Math.floor(Date.now() / 1000) + BLOCK_TTL_SECONDS;
	const key = await keyFor(secret);
	const blockUrls: Record<string, string> = {};
	for (const { h } of shards) {
		if (blockUrls[h]) continue;
		const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, payload(drive, h, drive, exp)))].map((b) => b.toString(16).padStart(2, "0")).join("");
		blockUrls[h] = `${origin}/_blocks/${drive}/${h}?d=${drive}&exp=${exp}&sig=${sig}`;
	}
	return { blockUrls, blockUrlsExpireAt: exp };
}

export async function serveBlock(
	request: Request, env: Env, ctx: ExecutionContext,
	describe: (drive: string) => Promise<Result<unknown>>,
): Promise<Response> {
	if (request.method !== "GET") return err(405, "method_not_allowed");
	const url = new URL(request.url);
	const parts = /^\/_blocks\/([^/]+)\/([^/]+)$/.exec(url.pathname);
	const drive = url.searchParams.get("d") ?? "";
	const rawExp = url.searchParams.get("exp") ?? "";
	const exp = Number(rawExp);
	const sig = url.searchParams.get("sig") ?? "";
	if (!parts || !DRIVE_ID_RE.test(parts[1]!) || !HASH_RE.test(parts[2]!) || drive !== parts[1] ||
		!/^\d+$/.test(rawExp) || !Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000) || !HASH_RE.test(sig)) return err(401, "unauthorized");
	if (!env.ULS_BLOCK_KEY) return err(503, "block_signing_unavailable");
	const signature = Uint8Array.from(sig.match(/../g)!, (s) => parseInt(s, 16));
	if (!await crypto.subtle.verify("HMAC", await keyFor(env.ULS_BLOCK_KEY), signature, payload(parts[1]!, parts[2]!, drive, exp))) return err(401, "unauthorized");
	const info = await describe(drive);
	if (!info.ok) return Response.json(info.body, { status: info.status });
	// Authenticate every hit. The cached bytes are independent of URL expiry and bearer identity.
	const cacheUrl = new URL(url.origin + url.pathname);
	const lookup = new Request(cacheUrl, { headers: request.headers.has("Range") ? { Range: request.headers.get("Range")! } : {} });
	const hit = await caches.default.match(lookup);
	if (hit) return hit;
	const response = await getShard(request, env, drive, parts[2]!);
	// Never cache partial responses or errors; Cache.match can slice a cached complete object for ranges.
	if (response.status === 200) ctx.waitUntil(caches.default.put(new Request(cacheUrl), response.clone()));
	return response;
}
