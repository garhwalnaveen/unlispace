import type { AppEnv } from "./env";

export class HttpError extends Error {
	constructor(public status: number, public code: string, message?: string) {
		super(message ?? code);
	}
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});
}

export function errBody(code: string, message?: string): { error: string; message?: string } {
	return message ? { error: code, message } : { error: code };
}

export function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

const MAX_BODY = 64 * 1024;

export async function readJson(req: Request): Promise<Record<string, unknown>> {
	const len = Number(req.headers.get("content-length") ?? "0");
	if (len > MAX_BODY) throw new HttpError(413, "too_large");
	const text = await req.text();
	if (text.length > MAX_BODY) throw new HttpError(413, "too_large");
	let v: unknown;
	try {
		v = JSON.parse(text || "{}");
	} catch {
		throw new HttpError(400, "bad_request", "invalid JSON");
	}
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HttpError(400, "bad_request", "body must be an object");
	return v as Record<string, unknown>;
}

export function str(v: unknown, max = 512): string | null {
	return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

export function corsHeaders(env: AppEnv, req: Request): Record<string, string> {
	const origin = req.headers.get("origin");
	if (!origin || origin !== env.ULS_WEB_ORIGIN) return {};
	return { "access-control-allow-origin": origin, vary: "Origin" };
}

export function preflight(env: AppEnv, req: Request): Response {
	const h = corsHeaders(env, req);
	if (!h["access-control-allow-origin"]) return new Response(null, { status: 204 });
	return new Response(null, {
		status: 204,
		headers: {
			...h,
			"access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
			"access-control-allow-headers": "authorization, content-type",
			"access-control-max-age": "600",
		},
	});
}
