import { exports } from "cloudflare:workers";

// `exports` is typed loosely by the plugin; the main Worker's default handler is a Fetcher.
export const selfFetch = (req: Request): Promise<Response> => (exports as unknown as { default: Fetcher }).default.fetch(req);

export const TOKEN = "uls-dev-local-token";
const BASE = "http://example.com";

// Recreate the pre-branch tables so migration tests start from a real legacy schema.
export function legacyTables(sql: SqlStorage): void {
	const keys: Record<string, string> = { nodes: "id", versions: "id", meta: "k", shards_known: "h", retained_shards: "h", drive_shards: "h", commit_receipts: "actor,id", gc_marks: "h", gc_manifest_marks: "h", gc_pending: "k", gc_state: "id" };
	for (const { name, columns } of sql.exec<{ name: string; columns: string }>("SELECT * FROM mv_columns").toArray()) {
		const cols = (JSON.parse(columns) as string[]).map(c => `"${c}"`).join(",");
		sql.exec(`CREATE TABLE legacy_${name} AS SELECT ${cols} FROM ${name}`);
		sql.exec(`DROP VIEW ${name}`);
		sql.exec(`ALTER TABLE legacy_${name} RENAME TO ${name}`);
		if (keys[name]) sql.exec(`CREATE UNIQUE INDEX legacy_${name}_key ON ${name}(${keys[name]})`);
	}
	sql.exec("DROP TABLE node_search");
	for (const { name } of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mv_%'").toArray()) sql.exec(`DROP TABLE ${name}`);
}

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
