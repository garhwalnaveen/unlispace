import type { Ctx } from "./ctx";
import { HttpError, json, readJson, str } from "./http";
import { PLACEMENTS } from "./env";
import { mintDriveToken, type Authed } from "./session";
import { newDriveId, provisionDrive } from "./users";
import { entitledDriveAccess } from "./entitlements";

export type Role = "owner" | "admin" | "member" | "viewer";
type Access = "read" | "write" | "admin";

export interface DriveRow {
	alias: string | null;
	forked_from: string | null;
	fork_point: number | null;
	lineage: string | null;
	id: string;
	org_id: string;
	name: string;
	placement: string | null;
	status: string;
	created_at: number;
	role: Role;
	tier: string;
}

const roleAccess = (role: Role): Access => (role === "owner" || role === "admin" ? "admin" : role === "member" ? "write" : "read");
const canManage = (role: Role) => role === "owner" || role === "admin";

export async function driveJson(ctx: Ctx, d: DriveRow) {
	const forks = (await ctx.env.DB.prepare("SELECT id FROM drives WHERE forked_from = ? AND status != 'deleted' ORDER BY created_at,id").bind(d.id).all<{ id: string }>()).results.map(r => r.id);
	const usage = await ctx.env.DB.prepare("SELECT own_bytes FROM drive_usage WHERE drive_id = ?").bind(d.id).first<{ own_bytes: number }>();
	return { id: d.id, orgId: d.org_id, name: d.name, alias: d.alias, forkOf: d.forked_from ? { driveId: d.forked_from, forkPoint: d.fork_point } : null, forks, usageBytes: usage?.own_bytes ?? 0, placement: d.placement, status: d.status, createdAt: d.created_at, access: roleAccess(d.role) };
}

export function validateAlias(alias: unknown): string {
	if (typeof alias !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(alias) || /^d-[0-9a-z]{26}$/.test(alias)) throw new HttpError(400, "invalid_argument");
	return alias;
}

async function chooseAlias(ctx: Ctx, org: string, name: string, id: string, alias: unknown): Promise<string> {
	if (alias !== undefined) return validateAlias(alias);
	let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 63).replace(/^-+|-+$/g, "");
	// The specified fallback is an ID, even though explicit ID-shaped aliases are reserved.
	if (base.length < 3 || /^d-[0-9a-z]{26}$/.test(base)) base = id;
	let candidate = base;
	for (let n = 2;await ctx.env.DB.prepare("SELECT 1 FROM drives WHERE org_id=? AND alias=? AND status!='deleted'").bind(org, candidate).first();n++) {
		const suffix = `-${n}`;
		candidate = base.slice(0, 63 - suffix.length).replace(/-+$/g, "") + suffix;
	}
	return candidate;
}

async function aliasWrite(run: () => Promise<unknown>) {
	try { await run(); } catch (e) {
		if (String(e).includes("UNIQUE constraint failed: drives.org_id, drives.alias")) throw new HttpError(409, "alias_taken");
		throw e;
	}
}

/** The drive, only if the caller is a member of its org and it isn't deleted; else a 404. */
export async function loadDrive(ctx: Ctx, a: Authed, driveId: string): Promise<DriveRow> {
	const d = await ctx.env.DB.prepare(
		`SELECT d.*, m.role AS role, o.tier AS tier
		 FROM drives d JOIN memberships m ON m.org_id = d.org_id AND m.user_id = ?
		 JOIN orgs o ON o.id = d.org_id WHERE d.id = ? AND d.status != 'deleted'`,
	)
		.bind(a.userId, driveId)
		.first<DriveRow>();
	if (!d) throw new HttpError(404, "no_such_drive");
	return d;
}

const userJson = (u: { id: string; email: string; display_name: string | null; created_at: number }) => ({ id: u.id, email: u.email, displayName: u.display_name, createdAt: u.created_at });

export async function getMe(ctx: Ctx, a: Authed): Promise<Response> {
	const u = await ctx.env.DB.prepare("SELECT id, email, display_name, created_at FROM users WHERE id = ?").bind(a.userId).first<{ id: string; email: string; display_name: string | null; created_at: number }>();
	if (!u) throw new HttpError(401, "unauthorized");
	return json(userJson(u));
}

export async function patchMe(ctx: Ctx, a: Authed): Promise<Response> {
	const body = await readJson(ctx.req);
	const name = body.displayName === null ? null : str(body.displayName, 100);
	if (body.displayName !== null && name === null) throw new HttpError(400, "bad_request", "displayName must be 1-100 characters or null");
	await ctx.env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(name, a.userId).run();
	return getMe(ctx, a);
}

export async function listOrgs(ctx: Ctx, a: Authed): Promise<Response> {
	const db = ctx.env.DB;
	const orgs = (await db.prepare("SELECT o.id, o.name, o.tier, o.trial_ends_at, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at, o.id").bind(a.userId).all<{ id: string; name: string; tier: string; trial_ends_at: number | null; role: Role }>()).results;
	const out = [];
	for (const o of orgs) {
		let drives = (await db.prepare("SELECT * FROM drives WHERE org_id = ? AND status != 'deleted' ORDER BY created_at, id").bind(o.id).all<Omit<DriveRow, "role" | "tier">>()).results;
		// Lazy retry of failed provisioning.
		for (const d of drives) {
			if (d.status === "provisioning_failed" && (await provisionDrive(ctx, d.id, d.placement))) d.status = "ready";
		}
		drives = drives.filter((d) => d.status !== "deleted");
		out.push({ id: o.id, name: o.name, role: o.role, tier: o.tier, trialEndsAt: o.trial_ends_at, drives: await Promise.all(drives.map((d) => driveJson(ctx, { ...d, role: o.role, tier: o.tier }))) });
	}
	return json({ orgs: out });
}

export async function createDrive(ctx: Ctx, a: Authed, orgId: string): Promise<Response> {
	const db = ctx.env.DB;
	const m = await db.prepare("SELECT m.role AS role, o.tier AS tier FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.org_id = ? AND m.user_id = ?").bind(orgId, a.userId).first<{ role: Role; tier: string }>();
	if (!m) throw new HttpError(404, "no_such_org");
	if (!canManage(m.role)) throw new HttpError(403, "forbidden");
	const body = await readJson(ctx.req);
	const name = str(body.name, 100);
	if (!name) throw new HttpError(400, "bad_request", "name is required (1-100 characters)");
	const placement = body.placement ?? null;
	if (placement !== null && !(PLACEMENTS as readonly unknown[]).includes(placement)) throw new HttpError(400, "bad_request", `placement must be one of ${PLACEMENTS.join(", ")}`);

	const id = newDriveId();
	const alias = await chooseAlias(ctx, orgId, name, id, body.alias);
	await aliasWrite(async () => {
		const r = await db.prepare(`INSERT INTO drives(id,org_id,name,placement,status,created_at,alias,lineage)
 SELECT ?,?,?,?,'provisioning_failed',?,?,? WHERE ? != 'individual' OR (SELECT COUNT(*) FROM drives WHERE org_id=? AND status!='deleted' AND forked_from IS NULL)<1`)
			.bind(id, orgId, name, placement, ctx.now, alias, id, m.tier, orgId).run();
		if (r.meta.changes !== 1) throw new HttpError(403, "plan_limit");
	});
	await provisionDrive(ctx, id, placement as string | null);
	return json(await driveJson(ctx, await loadDrive(ctx, a, id)), 201);
}

export async function getDrive(ctx: Ctx, a: Authed, driveId: string): Promise<Response> {
	return json(await driveJson(ctx, await loadDrive(ctx, a, driveId)));
}

export async function patchDrive(ctx: Ctx, a: Authed, driveId: string): Promise<Response> {
	const d = await loadDrive(ctx, a, driveId);
	if (!canManage(d.role)) throw new HttpError(403, "forbidden");
	const body = await readJson(ctx.req);
	const name = body.name === undefined ? d.name : str(body.name, 100);
	if (!name || (body.name === undefined && body.alias === undefined)) throw new HttpError(400, "bad_request");
	const alias = body.alias === undefined ? (d.alias ?? await chooseAlias(ctx, d.org_id, name, d.id, undefined)) : validateAlias(body.alias);
	await aliasWrite(() => ctx.env.DB.prepare("UPDATE drives SET name=?,alias=? WHERE id=?").bind(name, alias, driveId).run());
	return json(await driveJson(ctx, { ...d, name, alias }));
}

export async function deleteDrive(ctx: Ctx, a: Authed, driveId: string): Promise<Response> {
	const d = await loadDrive(ctx, a, driveId);
	if (!canManage(d.role)) throw new HttpError(403, "forbidden");
	const hard = ctx.url.searchParams.get("hard") === "1";
	if (hard && await ctx.env.DB.prepare("SELECT 1 FROM drives WHERE forked_from=? AND status!='deleted'").bind(driveId).first()) throw new HttpError(409, "drive_has_forks");
	if (hard) await ctx.env.DATA_PLANE.deleteDrive(driveId, { hard: true });
	await ctx.env.DB.prepare("UPDATE drives SET status='deleted',deleted_at=? WHERE id=?").bind(ctx.now, driveId).run();
	if (!hard) {
		try { await ctx.env.DATA_PLANE.deleteDrive(driveId, { hard: false }); }
		catch (e) { console.error("deleteDrive failed", driveId, String((e as Error)?.message ?? e)); }
	}
	return json({ ok: true });
}

export async function forkDrive(ctx: Ctx, a: Authed, driveId: string): Promise<Response> {
	const d = await loadDrive(ctx, a, driveId);
	if (!canManage(d.role)) throw new HttpError(403, "forbidden");
	if (d.status !== "ready") throw new HttpError(409, "drive_not_ready");
	const body = await readJson(ctx.req);
	const name = body.name === undefined ? d.name : str(body.name, 100);
	if (!name) throw new HttpError(400, "bad_request");
	const id = newDriveId();
	const alias = await chooseAlias(ctx, d.org_id, name, id, body.alias);
	await aliasWrite(async () => {
		const r = await ctx.env.DB.prepare(`INSERT INTO drives(id,org_id,name,placement,status,created_at,alias,forked_from,lineage)
 SELECT ?,?,?,?,'forking',?,?,?,? WHERE (SELECT COUNT(*) FROM drives WHERE org_id=? AND status!='deleted' AND forked_from IS NOT NULL)<50`)
			.bind(id, d.org_id, name, d.placement, ctx.now, alias, d.id, d.lineage ?? d.id, d.org_id).run();
		if (r.meta.changes !== 1) throw new HttpError(403, "plan_limit");
	});
	try {
		const result = await ctx.env.DATA_PLANE.forkDrive(d.id, id);
		await ctx.env.DB.prepare("UPDATE drives SET status='ready',lineage=?,fork_point=?,placement=? WHERE id=?").bind(result.lineage, result.forkPoint, result.placement, id).run();
	} catch (e) {
		await ctx.env.DB.prepare("DELETE FROM drives WHERE id=?").bind(id).run();
		const code = (e as { code?: string }).code;
		const status = code === "fork_depth_exceeded" ? 400 : code === "slow_down" ? 503 : code === "no_such_drive" ? 404 : 502;
		throw new HttpError(status, code ?? "data_plane_unavailable");
	}
	return json(await driveJson(ctx, await loadDrive(ctx, a, id)), 201);
}

export async function driveToken(ctx: Ctx, a: Authed, driveId: string): Promise<Response> {
	const d = await loadDrive(ctx, a, driveId);
	if (d.status !== "ready") throw new HttpError(409, "drive_not_ready");
	const body = await readJson(ctx.req);
	const want = body.access ?? "write";
	if (want !== "read" && want !== "write") throw new HttpError(400, "bad_request", "access must be read or write");
	// Cap at the caller's role: viewer = read, everyone else = write (admin is reserved).
	const access = await entitledDriveAccess(ctx, d.org_id, d.role === "viewer" ? "read" : want);
	const { token, expiresAt } = await mintDriveToken(ctx, { sub: a.userId, sid: a.sid, org: d.org_id, drives: [{ id: d.id, access }] });
	return json({ token, expiresAt, endpoint: ctx.env.ULS_DATA_ENDPOINT, driveId: d.id });
}
