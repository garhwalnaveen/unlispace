import type { Ctx } from "./ctx";
import { HttpError, json, readJson, str } from "./http";
import { PLACEMENTS } from "./env";
import { mintDriveToken, type Authed } from "./session";
import { newDriveId, provisionDrive } from "./users";
import { accessSummaries, computeEntitlements, entitledDriveAccess, storageUsage, type BillingRow } from "./entitlements";

export type Role = "owner" | "admin" | "member" | "viewer";
type Access = "read" | "write" | "admin";
export const DRIVE_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000;

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
	deleted_at: number | null;
	purged_at: number | null;
	created_at: number;
	role: Role;
	tier: string;
}

const roleAccess = (role: Role): Access => (role === "owner" || role === "admin" ? "admin" : role === "member" ? "write" : "read");
const canManage = (role: Role) => role === "owner" || role === "admin";

export async function driveJson(ctx: Ctx, d: DriveRow) {
	const forks = (await ctx.env.DB.prepare("SELECT id FROM drives WHERE forked_from = ? AND status != 'deleted' ORDER BY created_at,id").bind(d.id).all<{ id: string }>()).results.map(r => r.id);
	const usage = await ctx.env.DB.prepare("SELECT own_bytes FROM drive_usage WHERE drive_id = ?").bind(d.id).first<{ own_bytes: number }>();
	return driveJsonFrom(d, forks, usage?.own_bytes ?? 0);
}

function driveJsonFrom(d: DriveRow, forks: string[], usageBytes: number) {
	return { id: d.id, orgId: d.org_id, name: d.name, alias: d.alias, forkOf: d.forked_from ? { driveId: d.forked_from, forkPoint: d.fork_point } : null, forks, usageBytes, placement: d.placement, status: d.status, createdAt: d.created_at, access: roleAccess(d.role) };
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

export async function getMeAccess(ctx: Ctx, a: Authed): Promise<Response> {
	const u = await ctx.env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(a.userId).first<{ id: string; email: string }>();
	if (!u) throw new HttpError(401, "unauthorized");
	return json({ user: { id: u.id, email: u.email }, workspaces: await accessSummaries(ctx, a.userId) });
}

export async function listOrgs(ctx: Ctx, a: Authed): Promise<Response> {
	const db = ctx.env.DB;
	// One batch (a single D1 round trip) instead of per-org and per-drive queries. Every desktop
	// drive lookup starts here, so each extra sequential query was user-visible latency.
	const [orgRows, driveRows, forkRows, usageRows, billingRows] = await db.batch([
		db.prepare("SELECT o.id, o.name, o.tier, o.trial_ends_at, o.trial_pending, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at, o.id").bind(a.userId),
		db.prepare("SELECT d.* FROM drives d JOIN memberships m ON m.org_id = d.org_id WHERE m.user_id = ? AND d.status != 'deleted' ORDER BY d.created_at, d.id").bind(a.userId),
		db.prepare("SELECT f.id, f.forked_from FROM drives f JOIN drives d ON d.id = f.forked_from JOIN memberships m ON m.org_id = d.org_id WHERE m.user_id = ? AND f.status != 'deleted' ORDER BY f.created_at, f.id").bind(a.userId),
		db.prepare("SELECT u.drive_id, u.own_bytes FROM drive_usage u JOIN drives d ON d.id = u.drive_id JOIN memberships m ON m.org_id = d.org_id WHERE m.user_id = ?").bind(a.userId),
		db.prepare("SELECT b.* FROM billing b JOIN memberships m ON m.org_id = b.org_id WHERE m.user_id = ?").bind(a.userId),
	]);
	const billing = new Map((billingRows!.results as unknown as BillingRow[]).map((b) => [b.org_id, b]));
	const orgs = orgRows!.results as { id: string; name: string; tier: string; trial_ends_at: number | null; trial_pending: number; role: Role }[];
	const allDrives = driveRows!.results as Omit<DriveRow, "role" | "tier">[];
	// Lazy retry of failed provisioning. Rare; trial state can change, so reread it only then.
	let retried = false;
	for (const d of allDrives) {
		if (d.status === "provisioning_failed" && (await provisionDrive(ctx, d.id, d.placement))) { d.status = "ready"; retried = true; }
	}
	const trials = new Map(orgs.map((o) => [o.id, { trial_ends_at: o.trial_ends_at, trial_pending: o.trial_pending }]));
	if (retried) {
		for (const o of orgs) {
			const t = await db.prepare("SELECT trial_ends_at, trial_pending FROM orgs WHERE id = ?").bind(o.id).first<{ trial_ends_at: number | null; trial_pending: number }>();
			if (t) trials.set(o.id, t);
		}
	}
	const forks = new Map<string, string[]>();
	for (const f of forkRows!.results as { id: string; forked_from: string }[]) forks.set(f.forked_from, [...(forks.get(f.forked_from) ?? []), f.id]);
	const usage = new Map((usageRows!.results as { drive_id: string; own_bytes: number }[]).map((u) => [u.drive_id, u.own_bytes]));
	const out = await Promise.all(orgs.map(async (o) => {
		const trial = trials.get(o.id)!;
		const drives = allDrives.filter((d) => d.org_id === o.id && d.status !== "deleted")
			.map((d) => driveJsonFrom({ ...d, role: o.role, tier: o.tier }, forks.get(d.id) ?? [], usage.get(d.id) ?? 0));
		const e = computeEntitlements({ tier: o.tier, ...trial }, billing.get(o.id), ctx.now);
		const usedBytes = await storageUsage(ctx, o.id);
		return { id: o.id, name: o.name, role: o.role, tier: o.tier, trialEndsAt: trial.trial_ends_at, trialPending: !!trial.trial_pending, quotaBytes: e.quotaBytes, usedBytes, drives };
	}));
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
	if (d.status === "restoring" || d.status === "deleting") throw new HttpError(409, "drive_not_ready");
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
	if (d.status === "restoring") throw new HttpError(409, "drive_not_ready");
	const hard = d.status === "deleting" ? d.purged_at !== null : ctx.url.searchParams.get("hard") === "1";
	if (hard && await ctx.env.DB.prepare("SELECT 1 FROM drives WHERE forked_from=? AND status!='deleted'").bind(driveId).first()) throw new HttpError(409, "drive_has_forks");
	const claimed = await ctx.env.DB.prepare("UPDATE drives SET status='deleting',purged_at=? WHERE id=? AND status=?").bind(hard ? d.purged_at ?? ctx.now : null, driveId, d.status).run();
	if (claimed.meta.changes !== 1) throw new HttpError(409, "drive_not_ready");
	try { await ctx.env.DATA_PLANE.deleteDrive(driveId, { hard }); }
	catch (error) {
		if (hard) {
			await ctx.env.DB.prepare("UPDATE drives SET status=?,purged_at=? WHERE id=? AND status='deleting'").bind(d.status, d.purged_at, driveId).run();
			throw error;
		}
		// The storage outcome is ambiguous; keep the same deletion intent reserved until a retry acknowledges it.
		throw new HttpError(503,"data_plane_unavailable");
	}
	await ctx.env.DB.prepare("UPDATE drives SET status='deleted',deleted_at=?,purged_at=? WHERE id=? AND status='deleting'").bind(ctx.now, hard ? ctx.now : null, driveId).run();
	return json({ ok: true });
}

export async function deletedDrives(ctx: Ctx, a: Authed, orgId: string): Promise<Response> {
	const membership = await ctx.env.DB.prepare("SELECT role FROM memberships WHERE org_id=? AND user_id=?").bind(orgId, a.userId).first<{ role: Role }>();
	if (!membership) throw new HttpError(404, "no_such_org");
	if (!canManage(membership.role)) throw new HttpError(403, "forbidden");
	const rows = (await ctx.env.DB.prepare("SELECT id,name,alias,deleted_at,status FROM drives WHERE org_id=? AND status IN ('deleted','restoring') AND purged_at IS NULL AND deleted_at>? ORDER BY deleted_at DESC,id").bind(orgId, ctx.now - DRIVE_RECOVERY_MS).all<{ id: string; name: string; alias: string | null; deleted_at: number; status: string }>()).results;
	return json({ drives: rows.map(d => ({ id: d.id, name: d.name, alias: d.alias, deletedAt: d.deleted_at, recoverableUntil: d.deleted_at + DRIVE_RECOVERY_MS, status: d.status })) });
}

export async function restoreDrive(ctx: Ctx, a: Authed, driveId: string): Promise<Response> {
	const d = await ctx.env.DB.prepare(`SELECT d.*,m.role,o.tier FROM drives d JOIN memberships m ON m.org_id=d.org_id AND m.user_id=? JOIN orgs o ON o.id=d.org_id WHERE d.id=?`).bind(a.userId, driveId).first<DriveRow>();
	if (!d) throw new HttpError(404, "no_such_drive");
	if (!canManage(d.role)) throw new HttpError(403, "forbidden");
	if (d.purged_at !== null || d.deleted_at === null || d.deleted_at + DRIVE_RECOVERY_MS <= ctx.now) throw new HttpError(410, "recovery_expired");
	if (d.status !== "deleted" && d.status !== "restoring") throw new HttpError(409, "drive_not_deleted");
	const body = await readJson(ctx.req);
	const alias = body.alias === undefined ? d.alias : validateAlias(body.alias);
	if (d.status === "restoring" && alias !== d.alias) throw new HttpError(409, "drive_not_ready");
	await aliasWrite(async () => {
		const claimed = await ctx.env.DB.prepare(`UPDATE drives SET status='restoring',alias=? WHERE id=? AND (status='deleted' OR (status='restoring' AND alias IS ?)) AND purged_at IS NULL AND deleted_at>?
 AND (? != 'individual' OR forked_from IS NOT NULL OR NOT EXISTS(SELECT 1 FROM drives other WHERE other.org_id=drives.org_id AND other.id!=drives.id AND other.status!='deleted' AND other.forked_from IS NULL))
 AND (forked_from IS NULL OR (SELECT COUNT(*) FROM drives other WHERE other.org_id=drives.org_id AND other.id!=drives.id AND other.status!='deleted' AND other.forked_from IS NOT NULL)<50)`)
			.bind(alias, driveId, alias, ctx.now - DRIVE_RECOVERY_MS, d.tier).run();
		if (claimed.meta.changes !== 1) throw new HttpError(403, "plan_limit");
	});
	try { await ctx.env.DATA_PLANE.restoreDrive(driveId); }
	catch (error) {
		const code = (error as { code?: string; message?: string }).code ?? (error as Error).message;
		if (code === "no_such_drive" || code === "recovery_expired") {
			await ctx.env.DB.prepare("UPDATE drives SET status='deleted',purged_at=? WHERE id=? AND status='restoring'").bind(ctx.now, driveId).run();
			throw new HttpError(410, "recovery_expired");
		}
		// Keep the alias reserved after an ambiguous RPC outcome; retrying finishes this same restore.
		throw new HttpError(503, "data_plane_unavailable");
	}
	await ctx.env.DB.prepare("UPDATE drives SET status='ready',deleted_at=NULL WHERE id=? AND status='restoring'").bind(driveId).run();
	return json(await driveJson(ctx, await loadDrive(ctx, a, driveId)));
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
