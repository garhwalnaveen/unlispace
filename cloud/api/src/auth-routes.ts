import type { Ctx } from "./ctx";
import { HOUR } from "./ctx";
import { configured, googleCallback, googleStart } from "./google";
import { HttpError, json, readJson, redirect, str } from "./http";
import { putOneTime, takeOneTime } from "./onetime";
import { normalizeEmail, otpStart, otpVerify } from "./otp";
import { clientIp, enforce } from "./ratelimit";
import { authed, open, type Route } from "./router";
import { createSession, logout, refreshSession } from "./session";
import { findOrCreateUser } from "./users";
import { B64URL_RE as B64URL, PKCE_VERIFIER_RE, sha256B64url, timingSafeEqual, TOKEN43_RE } from "./util";

const GOOGLE_START_PER_IP = 60;

/** Consume a one-time PKCE code and return its user, or throw `error` (400). */
async function exchangePkceCode<P>(ctx: Ctx, kind: "handoff" | "desktop", code: string, verifier: string, challengeOf: (p: P) => string | undefined, error: string) {
	const row = await takeOneTime<P>(ctx, kind, code);
	const challenge = row ? challengeOf(row.payload) : undefined;
	if (!row?.userId || !challenge || !timingSafeEqual(await sha256B64url(verifier), challenge)) throw new HttpError(400, error);
	const user = await ctx.env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(row.userId).first<{ id: string; email: string }>();
	if (!user) throw new HttpError(400, error);
	return { user, payload: row.payload };
}

export const authRoutes: Route[] = [
	open("POST", "/auth/otp/start", async (ctx) => {
		const email = normalizeEmail((await readJson(ctx.req)).email);
		if (!email) throw new HttpError(400, "bad_request", "valid email required");
		await otpStart(ctx, email);
		return json({ ok: true });
	}),
	open("POST", "/auth/otp/verify", async (ctx) => {
		const body = await readJson(ctx.req);
		const email = normalizeEmail(body.email);
		const code = typeof body.code === "string" ? body.code.trim() : "";
		if (!email || !(await otpVerify(ctx, email, code))) throw new HttpError(400, "invalid_code");
		const { user, created } = await findOrCreateUser(ctx, email);
		return json(await createSession(ctx, user, created));
	}),
	open("GET", "/auth/google/start", async (ctx) => {
		if (!configured(ctx)) throw new HttpError(501, "not_configured");
		// Each start stores a state row before the caller has proven anything.
		await enforce(ctx, `google:ip:${clientIp(ctx)}`, GOOGLE_START_PER_IP, HOUR);
		return googleStart(ctx);
	}),
	open("GET", "/auth/google/callback", (ctx) => {
		if (!configured(ctx)) throw new HttpError(501, "not_configured");
		return googleCallback(ctx);
	}),
	open("POST", "/auth/handoff/exchange", async (ctx) => {
		const body = await readJson(ctx.req);
		const h = str(body.handoff, 256);
		const verifier = str(body.webCodeVerifier, 128);
		if (!verifier || !PKCE_VERIFIER_RE.test(verifier) || !h) throw new HttpError(400, "invalid_handoff");
		const { user, payload } = await exchangePkceCode<{ created: boolean; webChallenge: string }>(ctx, "handoff", h, verifier, (p) => p.webChallenge, "invalid_handoff");
		return json(await createSession(ctx, user, !!payload?.created));
	}),
	// A signed-in client (the desktop app) opens the web app as the same user. The web side
	// proves possession of the verifier when it exchanges the handoff at /auth/handoff/exchange.
	authed("POST", "/auth/web-handoff", async (ctx, a) => {
		const ch = str((await readJson(ctx.req)).webChallenge, 128);
		if (!ch || !TOKEN43_RE.test(ch)) throw new HttpError(400, "bad_request", "webChallenge must be a base64url SHA-256 PKCE challenge");
		return json({ handoff: await putOneTime(ctx, "handoff", 60_000, a.userId, { created: false, webChallenge: ch }) });
	}),
	open("POST", "/auth/refresh", async (ctx) => {
		const t = str((await readJson(ctx.req)).refreshToken, 128);
		if (!t) throw new HttpError(401, "invalid_refresh");
		return json(await refreshSession(ctx, t));
	}),
	open("POST", "/auth/logout", async (ctx) => {
		const t = str((await readJson(ctx.req)).refreshToken, 128);
		if (t) await logout(ctx, t);
		return json({ ok: true });
	}),
	open("GET", "/auth/desktop/start", (ctx) => {
		const q = ctx.url.searchParams;
		const state = q.get("state") ?? "";
		const ch = q.get("code_challenge") ?? "";
		if (!B64URL.test(state) || !B64URL.test(ch) || q.get("code_challenge_method") !== "S256") throw new HttpError(400, "bad_request", "state, code_challenge and code_challenge_method=S256 required");
		return redirect(`${ctx.env.ULS_WEB_ORIGIN}/desktop?${new URLSearchParams({ state, code_challenge: ch, ...(q.get("switch") === "1" ? { switch: "1" } : {}) })}`);
	}),
	authed("POST", "/auth/desktop/code", async (ctx, a) => {
		const body = await readJson(ctx.req);
		const state = str(body.state, 256);
		const ch = str(body.codeChallenge, 256);
		if (!state || !ch || !B64URL.test(ch)) throw new HttpError(400, "bad_request");
		return json({ code: await putOneTime(ctx, "desktop", 120_000, a.userId, { state, codeChallenge: ch }) });
	}),
	open("POST", "/auth/desktop/exchange", async (ctx) => {
		const body = await readJson(ctx.req);
		const code = str(body.code, 256);
		const verifier = str(body.codeVerifier, 256);
		if (!code || !verifier) throw new HttpError(400, "invalid_grant");
		// The code is consumed before the PKCE check, so a wrong verifier burns it.
		const { user } = await exchangePkceCode<{ codeChallenge: string }>(ctx, "desktop", code, verifier, (p) => p.codeChallenge, "invalid_grant");
		return json(await createSession(ctx, user, false));
	}),
];
