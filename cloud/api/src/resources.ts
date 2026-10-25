import type { Ctx } from "./ctx";
import { HttpError, json, readJson, str } from "./http";
import { PLACEMENTS } from "./env";
import { mintDriveToken, type Authed } from "./session";
import { newDriveId, provisionDrive } from "./users";

type Role = "owner" | "admin" | "member" | "viewer";
type Access = "read" | "write" | "admin";

interface DriveRow {
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

const driveJson = (d: DriveRow) => ({ id: d.id, orgId: d.org_id, name: d.name, placement: d.placement, status: d.status, createdAt: d.created_at, access: roleAccess(d.role) });

/** The drive, only if the caller is a member of its org and it isn't deleted; else a 404. */
async function loadDrive(ctx: Ctx, a: Authed, driveId: string): Promise<DriveRow> {
	const d = await ctx.env.DB.prepare(
		`SELECT d.id, d.org_id, d.name, d.placement, d.status, d.created_at, m.role AS role, o.tier AS tier
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
		let drives = (await db.prepare("SELECT id, org_id, name, placement, status, created_at FROM drives WHERE org_id = ? AND status != 'deleted' ORDER BY created_at, id").bind(o.id).all<Omit<DriveRow, "role" | "tier">>()).results;
		// Lazy retry of failed provisioning.
		for (const d of drives) {
			if (d.status === "provisioning_failed" && (await provisionDrive(ctx, d.id, d.placement))) d.status = "ready";
		}
		drives = drives.filter((d) => d.status !== "deleted");
		out.push({ id: o.id, name: o.name, role: o.role, tier: o.tier, trialEndsAt: o.trial_ends_at, drives: drives.map((d) => driveJson({ ...d, role: o.role, tier: o.tier })) });
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
	if (m.tier === "individual") {
		// Count and insert in one statement so concurrent creates can't both pass the limit.
		const r = await db.prepare(
			`INSERT INTO drives(id, org_id, name, placement, status, created_at)
			 SELECT ?, ?, ?, ?, 'provisioning_failed', ? WHERE (SELECT COUNT(*) FROM drives WHERE org_id = ? AND status != 'deleted') < 1`,
		)
			.bind(id, orgId, name, placement, ctx.now, orgId)
			.run();
		if (r.meta.changes !== 1) throw new HttpError(403, "plan_limit");
	} else {
		await db.prepare("INSERT INTO drives(id, org_id, name, placement, status, created_at) VALUES(?,?,?,?,'provisioning_failed',?)").bind(id, orgId, name, placement, ctx.now).run();
	}
	const ready = await provisionDrive(ctx, id, placement as string | null);
	return json(driveJson({ id, org_id: orgId, name, placement: placement as string | null, status: ready ? "ready" : "provisioning_failed", created_at: ctx.now, role: m.role, tier: m.tier }), 201);
}

export async function getDrive(ctx: Ctx, a: Authed, driveId: string): Promise<Response> {
	return json(driveJson(await loadDrive(ctx, a, driveId)));
}

export async function patchDrive(ctx: Ctx, a: Authed, driveId: string): Promise<Response> {
	const d = await loadDrive(ctx, a, driveId);
	if (!canManage(d.role)) throw new HttpError(403, "forbidden");
	const name = str((await readJson(ctx.req)).name, 100);
	if (!name) throw new HttpError(400, "bad_request", "name is required (1-100 characters)");
	await ctx.env.DB.prepare("UPDATE drives SET name = ? WHERE id = ?").bind(name, driveId).run();
	return json(driveJson({ ...d, name }));
}

export async function deleteDrive(ctx: Ctx, a: Authed, driveId: string): Promise<Response> {
	const d = await loadDrive(ctx, a, driveId);
	if (!canManage(d.role)) throw new HttpError(403, "forbidden");
	await ctx.env.DB.prepare("UPDATE drives SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(ctx.now, driveId).run();
	try {
		await ctx.env.DATA_PLANE.deleteDrive(driveId);
	} catch (e) {
		// Row is already soft-deleted, so the drive is unreachable via tokens either way.
		console.error("deleteDrive failed", driveId, String((e as Error)?.message ?? e));
	}
	return json({ ok: true });
}

export async function driveToken(ctx: Ctx, a: Authed, driveId: string): Promise<Response> {
	const d = await loadDrive(ctx, a, driveId);
	if (d.status !== "ready") throw new HttpError(409, "drive_not_ready");
	const body = await readJson(ctx.req);
	const want = body.access ?? "write";
	if (want !== "read" && want !== "write") throw new HttpError(400, "bad_request", "access must be read or write");
	// Cap at the caller's role: viewer = read, everyone else = write (admin is reserved).
	const access: Access = d.role === "viewer" ? "read" : want;
	const { token, expiresAt } = await mintDriveToken(ctx, { sub: a.userId, sid: a.sid, org: d.org_id, drives: [{ id: d.id, access }] });
	return json({ token, expiresAt, endpoint: ctx.env.ULS_DATA_ENDPOINT, driveId: d.id });
}
