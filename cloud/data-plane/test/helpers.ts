import { exports } from "cloudflare:workers";

// `exports` is typed loosely by the plugin; the main Worker's default handler is a Fetcher.
export const selfFetch = (req: Request): Promise<Response> => (exports as unknown as { default: Fetcher }).default.fetch(req);

export const TOKEN = "uls-dev-local-token";
const BASE = "http://example.com";

export async function sha256Hex(data: Uint8Array): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function api(path: string, init: RequestInit & { json?: unknown; token?: string | null } = {}): Promise<Response> {
	const { json, token = TOKEN, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token !== null) headers.set("Authorization", `Bearer ${token}`);
	if (json !== undefined) {
		headers.set("Content-Type", "application/json");
		rest.body = JSON.stringify(json);
		rest.method ??= "POST";
	}
	return selfFetch(new Request(BASE + path, { ...rest, headers }));
}

let counter = 0;
export async function newDrive(placement?: string): Promise<string> {
	const id = `t-${Date.now().toString(36)}-${(counter++).toString(36)}`;
	const r = await api(`/v0/drives/${id}`, { method: "PUT", json: placement ? { placement } : {} });
	if (r.status !== 201) throw new Error(`create drive failed: ${r.status} ${await r.text()}`);
	return id;
}

export async function upload(drive: string, data: Uint8Array): Promise<{ h: string; n: number }> {
	const h = await sha256Hex(data);
	const r = await api(`/v0/drives/${drive}/shards/${h}`, { method: "PUT", body: data });
	if (r.status !== 201 && r.status !== 200) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
	return { h, n: data.byteLength };
}

export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

export async function putFile(drive: string, path: string, content: string, extra: Record<string, unknown> = {}) {
	const shard = await upload(drive, bytes(content));
	return api(`/v0/drives/${drive}/commit`, {
		json: { ops: [{ op: "put", path, size: shard.n, contentType: "text/plain", mtimeMs: 1700000000000, shards: [shard], ...extra }] },
	});
}

export const commit = (drive: string, ops: unknown[]) => api(`/v0/drives/${drive}/commit`, { json: { ops } });
