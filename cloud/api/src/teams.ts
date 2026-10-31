import type { Ctx } from "./ctx";
import { DAY, ulid } from "./ctx";
import { entitlements } from "./entitlements";
import { HttpError, json, readJson } from "./http";
import { normalizeEmail } from "./otp";
import type { Role } from "./resources";
import type { Authed } from "./session";
import { randomB64url, sha256Hex } from "./util";

type OrgAccess = { role: Role; name: string };
async function access(ctx: Ctx, a: Authed, orgId: string, manage = false): Promise<OrgAccess> {
	const row = await ctx.env.DB.prepare("SELECT m.role,o.name FROM memberships m JOIN orgs o ON o.id=m.org_id WHERE m.org_id=? AND m.user_id=?").bind(orgId, a.userId).first<OrgAccess>();
	if (!row) throw new HttpError(404, "no_such_org");
	if (manage && row.role !== "owner" && row.role !== "admin") throw new HttpError(403, "access_denied");
	return row;
}
const invitationFields = "id,email,role,created_at AS createdAt,expires_at AS expiresAt";
// Recheck actor privilege inside mutations: a concurrent demotion must not retain authority.
const manager = (role = "?") => `EXISTS(SELECT 1 FROM memberships actor WHERE actor.org_id=? AND actor.user_id=? AND (actor.role='owner' OR (actor.role='admin' AND ${role} IN ('member','viewer'))))`;
const availableSeat = `(SELECT COUNT(*) FROM memberships WHERE org_id=?) <
 (SELECT seats FROM billing WHERE org_id=? AND plan='teams' AND status='active' AND current_period_end>?)`;

export async function members(ctx: Ctx, a: Authed, orgId: string): Promise<Response> {
	const org = await access(ctx, a, orgId);
	const canManage = org.role === "owner" || org.role === "admin";
	const members = (await ctx.env.DB.prepare("SELECT u.id AS userId,u.email,u.display_name AS displayName,m.role,m.created_at AS createdAt FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY m.created_at,u.id").bind(orgId).all()).results;
	const invitations = canManage ? (await ctx.env.DB.prepare(`SELECT ${invitationFields} FROM invitations WHERE org_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>? ORDER BY created_at,id`).bind(orgId, ctx.now).all()).results : [];
	const e = await entitlements(ctx, orgId);
	return json({ name: org.name, role: org.role, canManage, members, invitations, seats: e.seats, teamAvailable: e.plan === "teams" && e.state === "paid" });
}

export async function invite(ctx: Ctx, a: Authed, orgId: string): Promise<Response> {
	const org = await access(ctx, a, orgId, true);
	const body = await readJson(ctx.req);
	const email = normalizeEmail(body.email);
	const role = body.role ?? "member";
	if (!email || !["admin", "member", "viewer"].includes(String(role))) throw new HttpError(400, "bad_request");
	if (org.role !== "owner" && role === "admin") throw new HttpError(403, "access_denied");
	const e = await entitlements(ctx, orgId);
	if (e.plan !== "teams" || e.state !== "paid") throw new HttpError(403, "team_plan_required", "Choose an active Teams plan before inviting members.");
	if (await ctx.env.DB.prepare("SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=? AND u.email=?").bind(orgId, email).first()) throw new HttpError(409, "already_member");
	const id = ulid(), token = randomB64url(32), expiresAt = ctx.now + 7 * DAY;
	const result = await ctx.env.DB.prepare(`INSERT INTO invitations(id,org_id,email,role,token_hash,invited_by,created_at,expires_at)
 SELECT ?,?,?,?,?,?,?,? WHERE ${manager()} AND
 (SELECT COUNT(*) FROM memberships WHERE org_id=?) +
 (SELECT COUNT(*) FROM invitations WHERE org_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?) <
 (SELECT seats FROM billing WHERE org_id=? AND plan='teams' AND status='active' AND current_period_end>?) AND
 NOT EXISTS(SELECT 1 FROM invitations WHERE org_id=? AND email=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?)`)
		.bind(id, orgId, email, role, await sha256Hex(token), a.userId, ctx.now, expiresAt,
			orgId, a.userId, role, orgId, orgId, ctx.now, orgId, ctx.now, orgId, email, ctx.now).run();
	if (!result.meta.changes) throw new HttpError(409, "invite_unavailable", "No seat available, an invitation is already pending, or your role changed. Refresh the team page.");
	try {
		await ctx.email.send(email, `Join ${org.name} on Unlispace`, `You have been invited to ${org.name} as ${role}. Sign in with ${email} to accept within seven days:\n${ctx.env.ULS_WEB_ORIGIN}/invites/${token}`);
	} catch {
		await ctx.env.DB.prepare("UPDATE invitations SET revoked_at=? WHERE id=? AND used_at IS NULL").bind(ctx.now, id).run();
		throw new HttpError(503, "email_unavailable", "The invitation could not be sent. Please try again later.");
	}
	return json({ id, email, role, expiresAt }, 201);
}

export async function revokeInvite(ctx: Ctx, a: Authed, orgId: string, id: string): Promise<Response> {
	await access(ctx, a, orgId, true);
	const result = await ctx.env.DB.prepare(`UPDATE invitations SET revoked_at=? WHERE id=? AND org_id=? AND used_at IS NULL AND revoked_at IS NULL AND ${manager("invitations.role")}`)
		.bind(ctx.now, id, orgId, orgId, a.userId).run();
	if (!result.meta.changes) throw new HttpError(404, "no_such_invite");
	return json({ ok: true });
}

export async function acceptInvite(ctx: Ctx, a: Authed, token: string): Promise<Response> {
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, "invalid_invite");
	const hash = await sha256Hex(token);
	const invite = await ctx.env.DB.prepare(`SELECT i.org_id AS orgId,i.email FROM invitations i JOIN users u ON u.id=? AND u.email=i.email WHERE i.token_hash=? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?`).bind(a.userId, hash, ctx.now).first<{ orgId: string; email: string }>();
	if (!invite) throw new HttpError(400, "invalid_invite", "This invitation is expired, unavailable, or belongs to a different email address.");
	// D1 batches are transactional. Admission checks and insertion happen in one SQL statement,
	// so simultaneous accepts cannot oversubscribe a seat or reuse an invitation.
	const results = await ctx.env.DB.batch([
		ctx.env.DB.prepare(`INSERT INTO memberships(org_id,user_id,role,created_at)
 SELECT i.org_id,?,i.role,? FROM invitations i JOIN users u ON u.id=? AND u.email=i.email
 WHERE i.token_hash=? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?
 AND ${availableSeat} AND EXISTS(SELECT 1 FROM memberships actor WHERE actor.org_id=i.org_id AND actor.user_id=i.invited_by AND (actor.role='owner' OR (actor.role='admin' AND i.role IN ('member','viewer'))))
 AND NOT EXISTS(SELECT 1 FROM memberships WHERE org_id=i.org_id AND user_id=?)`)
			.bind(a.userId, ctx.now, a.userId, hash, ctx.now, invite.orgId, invite.orgId, ctx.now, a.userId),
		ctx.env.DB.prepare("UPDATE invitations SET used_at=? WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND changes()>0").bind(ctx.now, hash),
	]);
	if (!results[0]!.meta.changes) throw new HttpError(409, "invite_unavailable", "The invitation is no longer available or the team has no free seats.");
	return json({ orgId: invite.orgId });
}

export async function changeMember(ctx: Ctx, a: Authed, orgId: string, userId: string): Promise<Response> {
	await access(ctx, a, orgId, true);
	const deleting = ctx.req.method === "DELETE";
	const role = deleting ? null : (await readJson(ctx.req)).role;
	if (!deleting && !["owner", "admin", "member", "viewer"].includes(String(role))) throw new HttpError(400, "bad_request");
	const target = await ctx.env.DB.prepare("SELECT role FROM memberships WHERE org_id=? AND user_id=?").bind(orgId, userId).first<{ role: Role }>();
	if (!target) throw new HttpError(404, "no_such_member");
	// Only owners may alter privileged members or assign privileged roles.
	const clause = `org_id=? AND user_id=? AND ${manager("memberships.role")} AND ${manager()}
 AND (role!='owner' OR ?='owner' OR (SELECT COUNT(*) FROM memberships owners WHERE owners.org_id=? AND owners.role='owner')>1)`;
	const values = [orgId, userId, orgId, a.userId, orgId, a.userId, role ?? "member", role, orgId];
	const result = deleting
		? await ctx.env.DB.prepare(`DELETE FROM memberships WHERE ${clause}`).bind(...values).run()
		: await ctx.env.DB.prepare(`UPDATE memberships SET role=? WHERE ${clause}`).bind(role, ...values).run();
	if (!result.meta.changes) throw new HttpError(409, "membership_protected", "Only owners can manage privileged members; the team must retain an owner. Refresh to check current roles.");
	return json({ ok: true });
}
