import type { Ctx } from "./ctx";
import { DAY, ulid } from "./ctx";
import { HttpError } from "./http";
import { signJwt, verifyJwt, type Jwk } from "./jwt";
import { randomB64url, sha256Hex } from "./util";

export const ACCESS_TTL_S = 900;
export const REFRESH_TTL_MS = 30 * DAY;

export interface Session {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	user: { id: string; email: string };
	accountCreated: boolean;
}

export interface UserRow {
	id: string;
	email: string;
	display_name: string | null;
	created_at: number;
}

function privateJwk(ctx: Ctx): Jwk {
	return JSON.parse(ctx.env.ULS_JWT_PRIVATE_JWK) as Jwk;
}

export async function mintAccess(ctx: Ctx, user: { id: string; email: string }, sid: string): Promise<string> {
	const iat = Math.floor(ctx.now / 1000);
	return signJwt(privateJwk(ctx), { iss: ctx.env.ULS_ISSUER, sub: user.id, typ: "access", iat, exp: iat + ACCESS_TTL_S, sid, email: user.email });
}

export async function mintDriveToken(
	ctx: Ctx,
	p: { sub: string; sid: string; org: string; drives: { id: string; access: "read" | "write" | "admin" }[] },
): Promise<{ token: string; expiresAt: number }> {
	const iat = Math.floor(ctx.now / 1000);
	const exp = iat + ACCESS_TTL_S;
	const token = await signJwt(privateJwk(ctx), {
		iss: ctx.env.ULS_ISSUER,
		sub: p.sub,
		typ: "drive",
		iat,
		exp,
		sid: p.sid,
		org: p.org,
		drives: p.drives,
		jti: ulid(),
	});
	return { token, expiresAt: exp * 1000 };
}

/**
 * Create a refresh-token row. `family` is the session id the client sees as `sid`; it stays
 * constant across rotations, each rotation being a new row.
 */
async function insertRefreshRow(ctx: Ctx, userId: string, family: string, prevHash: string | null): Promise<string> {
	const refreshToken = "rt_" + randomB64url(32);
	const ua = (ctx.req.headers.get("user-agent") ?? "").slice(0, 200) || null;
	await ctx.env.DB.prepare(
		"INSERT INTO sessions(id, user_id, family, refresh_hash, prev_hash, created_at, expires_at, user_agent) VALUES(?,?,?,?,?,?,?,?)",
	)
		.bind("s_" + ulid(), userId, family, await sha256Hex(refreshToken), prevHash, ctx.now, ctx.now + REFRESH_TTL_MS, ua)
		.run();
	return refreshToken;
}

export async function createSession(ctx: Ctx, user: { id: string; email: string }, accountCreated: boolean): Promise<Session> {
	const family = "s_" + ulid();
	const refreshToken = await insertRefreshRow(ctx, user.id, family, null);
	return { accessToken: await mintAccess(ctx, user, family), refreshToken, expiresIn: ACCESS_TTL_S, user: { id: user.id, email: user.email }, accountCreated };
}

interface SessionRow {
	id: string;
	user_id: string;
	family: string;
	expires_at: number;
	revoked_at: number | null;
}

export async function revokeFamily(ctx: Ctx, family: string): Promise<void> {
	await ctx.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL").bind(ctx.now, family).run();
}

/** Rotate a refresh token. A token that was already rotated away revokes the whole family. */
export async function refreshSession(ctx: Ctx, refreshToken: string): Promise<Session> {
	const invalid = new HttpError(401, "invalid_refresh");
	if (!/^rt_[A-Za-z0-9_-]{43}$/.test(refreshToken)) throw invalid;
	const hash = await sha256Hex(refreshToken);
	const row = await ctx.env.DB.prepare("SELECT id, user_id, family, expires_at, revoked_at FROM sessions WHERE refresh_hash = ?").bind(hash).first<SessionRow>();
	if (!row) throw invalid;
	if (row.revoked_at !== null) {
		// Presenting a rotated-away (or logged-out) token: assume theft, kill the family.
		await revokeFamily(ctx, row.family);
		throw invalid;
	}
	if (row.expires_at <= ctx.now) throw invalid;

	// Claim the row atomically so two concurrent refreshes can't both succeed.
	const claimed = await ctx.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(ctx.now, row.id).run();
	if (claimed.meta.changes !== 1) {
		await revokeFamily(ctx, row.family);
		throw invalid;
	}
	const user = await ctx.env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(row.user_id).first<{ id: string; email: string }>();
	if (!user) throw invalid;
	const next = await insertRefreshRow(ctx, user.id, row.family, hash);
	return { accessToken: await mintAccess(ctx, user, row.family), refreshToken: next, expiresIn: ACCESS_TTL_S, user, accountCreated: false };
}

export async function logout(ctx: Ctx, refreshToken: string): Promise<void> {
	const row = await ctx.env.DB.prepare("SELECT family FROM sessions WHERE refresh_hash = ?").bind(await sha256Hex(refreshToken)).first<{ family: string }>();
	if (row) await revokeFamily(ctx, row.family);
}

export interface Authed {
	userId: string;
	email: string;
	sid: string;
}

/** Verify the bearer access token and that its session family is still live. */
export async function authenticate(ctx: Ctx): Promise<Authed> {
	const m = /^Bearer (.+)$/.exec(ctx.req.headers.get("authorization") ?? "");
	if (!m) throw new HttpError(401, "unauthorized");
	let claims;
	try {
		claims = await verifyJwt(m[1]!, ctx.env.ULS_JWT_PUBLIC_JWKS, { issuer: ctx.env.ULS_ISSUER, typ: "access", now: ctx.now });
	} catch {
		throw new HttpError(401, "unauthorized");
	}
	const sid = typeof claims.sid === "string" ? claims.sid : "";
	const email = typeof claims.email === "string" ? claims.email : "";
	const live = await ctx.env.DB.prepare("SELECT 1 AS x FROM sessions WHERE family = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1").bind(sid, ctx.now).first();
	if (!live) throw new HttpError(401, "unauthorized");
	return { userId: claims.sub, email, sid };
}
