import type { Ctx } from "./ctx";
import type { AppEnv } from "./env";
import { HttpError, json, readJson, str } from "./http";
import type { Authed } from "./session";

type Access = "read" | "write" | "admin";
const rank: Record<Access, number> = { read: 0, write: 1, admin: 2 };
const roleAccess = (role: string): Access => role === "owner" || role === "admin" ? "admin" : role === "member" ? "write" : "read";

interface KeyRow {
	id: string;
	org_id: string;
	user_id: string;
	access: Access;
	drives: string | null;
	label: string | null;
	parent: string | null;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

const keyJson = (k: KeyRow) => ({ accessKeyId: k.id, workspaceId: k.org_id, access: k.access, drives: k.drives === null ? null : JSON.parse(k.drives) as string[], label: k.label, parent: k.parent, createdAt: k.created_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at });

async function membership(ctx: Ctx, userId: string, orgId: string): Promise<Access> {
	const m = await ctx.env.DB.prepare("SELECT role FROM memberships WHERE user_id = ? AND org_id = ?").bind(userId, orgId).first<{ role: string }>();
	if (!m) throw new HttpError(404, "no_such_org");
	return roleAccess(m.role);
}

/** Internal verifier helper; never expose the derived secret on a public lookup endpoint. */
export async function deriveAccessKeySecret(env: AppEnv, id: string): Promise<string> {
	if (!/^ULS[A-Z0-9]{17}$/.test(id)) throw new HttpError(401, "invalid_key");
	let master: Uint8Array;
	try {
		const encoded = (JSON.parse(env.ULS_ACCESS_KEY_MASTERS ?? "{}") as Record<string, string>)[id[3]!];
		master = Uint8Array.from(atob(encoded ?? ""), c => c.charCodeAt(0));
		if (master.length < 32) throw new Error("missing master");
	} catch {
		throw new HttpError(503, "keys_not_configured");
	}
	const key = await crypto.subtle.importKey("raw", master, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id)));
	return btoa(String.fromCharCode(...mac)).slice(0, 40);
}

/** Looks up live ancestry and current membership on every use; usage is recorded after SigV4 verifies. */
export async function resolveAccessKey(ctx: Ctx, id: string) {
	const k = await ctx.env.DB.prepare("SELECT * FROM access_keys WHERE id = ? AND revoked_at IS NULL").bind(id).first<KeyRow>();
	if (!k) throw new HttpError(401, "invalid_key");
	const ancestors = (await ctx.env.DB.prepare(`WITH RECURSIVE chain AS (
		SELECT * FROM access_keys WHERE id = ? UNION ALL SELECT p.* FROM access_keys p JOIN chain c ON p.id = c.parent
	) SELECT c.revoked_at, m.role FROM chain c LEFT JOIN memberships m ON m.org_id = c.org_id AND m.user_id = c.user_id`).bind(id).all<{ revoked_at: number | null; role: string | null }>()).results;
	if (ancestors.some(p => p.revoked_at !== null || p.role === null)) throw new HttpError(401, "invalid_key");
	let access = k.access;
	for (const p of ancestors) if (rank[roleAccess(p.role!)] < rank[access]) access = roleAccess(p.role!);
	return { ...keyJson(k), access, userId: k.user_id, secretAccessKey: await deriveAccessKeySecret(ctx.env, id) };
}

export async function recordAccessKeyUse(ctx: Ctx, id: string): Promise<void> {
	await ctx.env.DB.prepare("UPDATE access_keys SET last_used_at = MAX(COALESCE(last_used_at, 0), ?) WHERE id = ? AND revoked_at IS NULL").bind(ctx.now, id).run();
}

export async function listKeys(ctx: Ctx, a: Authed): Promise<Response> {
	const workspaceId = ctx.url.searchParams.get("workspaceId");
	if (workspaceId) await membership(ctx, a.userId, workspaceId);
	const rows = (await ctx.env.DB.prepare(`SELECT k.* FROM access_keys k JOIN memberships m ON m.org_id = k.org_id AND m.user_id = ?
		WHERE (? IS NULL OR k.org_id = ?) AND (k.user_id = ? OR m.role IN ('owner','admin')) ORDER BY k.created_at, k.id`)
		.bind(a.userId, workspaceId, workspaceId, a.userId).all<KeyRow>()).results;
	return json({ keys: rows.map(keyJson) });
}

export async function createKey(ctx: Ctx, a: Authed): Promise<Response> {
	const b = await readJson(ctx.req);
	const orgId = str(b.workspaceId, 100);
	if (!orgId || typeof b.access !== "string" || !Object.hasOwn(rank, b.access)) throw new HttpError(400, "bad_request", "workspaceId and access (read/write/admin) required");
	const access = b.access as Access;
	const max = await membership(ctx, a.userId, orgId);
	if (rank[access] > rank[max]) throw new HttpError(403, "forbidden");
	const drives = b.drives === undefined || b.drives === null ? null : b.drives;
	if (drives !== null && (!Array.isArray(drives) || drives.length > 100 || drives.some(d => !str(d, 100)) || new Set(drives).size !== drives.length)) throw new HttpError(400, "bad_request", "drives must be null or a unique drive ID array");
	for (const id of (drives ?? []) as string[]) {
		if (!await ctx.env.DB.prepare("SELECT 1 FROM drives WHERE id = ? AND org_id = ? AND status != 'deleted'").bind(id, orgId).first()) throw new HttpError(404, "no_such_drive");
	}
	const label = b.label === undefined || b.label === null ? null : str(b.label, 100);
	if (b.label !== undefined && b.label !== null && !label) throw new HttpError(400, "bad_request");
	const parent = b.parent === undefined || b.parent === null ? null : str(b.parent, 20);
	if (b.parent !== undefined && b.parent !== null && !parent) throw new HttpError(400, "bad_request");
	if (parent) {
		const p = await resolveAccessKey(ctx, parent);
		if (p.workspaceId !== orgId || (p.userId !== a.userId && max !== "admin") || rank[access] > rank[p.access] || (p.drives !== null && (drives === null || (drives as string[]).some(d => !p.drives!.includes(d))))) throw new HttpError(403, "forbidden", "child scope must be contained by parent");
	}
	const version = ctx.env.ULS_ACCESS_KEY_VERSION ?? "1";
	if (!/^[A-Z0-9]$/.test(version)) throw new HttpError(503, "keys_not_configured");
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const id = "ULS" + version + [...crypto.getRandomValues(new Uint8Array(16))].map(n => alphabet[n & 31]).join("");
	const secretAccessKey = await deriveAccessKeySecret(ctx.env, id);
	const row: KeyRow = { id, org_id: orgId, user_id: a.userId, access, drives: drives === null ? null : JSON.stringify(drives), label, parent, created_at: ctx.now, last_used_at: null, revoked_at: null };
	// Insertion and the live-parent check share a statement to serialize with revocation.
	const inserted = await ctx.env.DB.prepare(`INSERT INTO access_keys(id,org_id,user_id,access,drives,label,parent,created_at)
		SELECT ?,?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM access_keys WHERE id = ? AND revoked_at IS NULL)`)
		.bind(id, orgId, a.userId, access, row.drives, label, parent, ctx.now, parent, parent).run();
	if (inserted.meta.changes !== 1) throw new HttpError(401, "invalid_key");
	return json({ ...keyJson(row), secretAccessKey }, 201);
}

export async function revokeKey(ctx: Ctx, a: Authed, id: string): Promise<Response> {
	const k = await ctx.env.DB.prepare("SELECT * FROM access_keys WHERE id = ?").bind(id).first<KeyRow>();
	if (!k) throw new HttpError(404, "no_such_key");
	const access = await membership(ctx, a.userId, k.org_id);
	if (k.user_id !== a.userId && access !== "admin") throw new HttpError(404, "no_such_key");
	await ctx.env.DB.prepare(`WITH RECURSIVE descendants(id) AS (
		SELECT id FROM access_keys WHERE id = ? UNION ALL SELECT k.id FROM access_keys k JOIN descendants d ON k.parent = d.id
	) UPDATE access_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id IN (SELECT id FROM descendants)`).bind(id, ctx.now).run();
	return json({ ok: true });
}
