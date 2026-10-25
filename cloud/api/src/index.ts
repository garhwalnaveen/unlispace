import type { AppEnv } from "./env";
import type { Ctx, Deps } from "./ctx";
import { selectSender } from "./email";
import { HttpError, corsHeaders, errBody, json, preflight, readJson, redirect, str } from "./http";
import { configured, googleCallback, googleStart } from "./google";
import { takeOneTime, putOneTime } from "./onetime";
import { normalizeEmail, otpStart, otpVerify } from "./otp";
import * as R from "./resources";
import { authenticate, createSession, logout, refreshSession } from "./session";
import { sha256B64url, timingSafeEqual } from "./util";
import { findOrCreateUser } from "./users";

const B64URL = /^[A-Za-z0-9_-]{16,256}$/;

async function route(ctx: Ctx): Promise<Response> {
	const { req, url } = ctx;
	const m = req.method;
	const p = url.pathname.replace(/\/+$/, "") || "/";
	const seg = p.split("/").filter(Boolean);

	if (p === "/healthz" && m === "GET") return json({ ok: true });

	// ---- auth (unauthenticated unless noted) ----
	if (seg[0] === "auth") {
		const r = `${m} ${p}`;
		switch (r) {
			case "POST /auth/otp/start": {
				const email = normalizeEmail((await readJson(req)).email);
				if (!email) throw new HttpError(400, "bad_request", "valid email required");
				await otpStart(ctx, email);
				return json({ ok: true });
			}
			case "POST /auth/otp/verify": {
				const body = await readJson(req);
				const email = normalizeEmail(body.email);
				const code = typeof body.code === "string" ? body.code.trim() : "";
				if (!email || !(await otpVerify(ctx, email, code))) throw new HttpError(400, "invalid_code");
				const { user, created } = await findOrCreateUser(ctx, email);
				return json(await createSession(ctx, user, created));
			}
			case "GET /auth/google/start":
				if (!configured(ctx)) throw new HttpError(501, "not_configured");
				return googleStart(ctx);
			case "GET /auth/google/callback":
				if (!configured(ctx)) throw new HttpError(501, "not_configured");
				return googleCallback(ctx);
			case "POST /auth/handoff/exchange": {
				const h = str((await readJson(req)).handoff, 256);
				const row = h ? await takeOneTime<{ created: boolean }>(ctx, "handoff", h) : null;
				if (!row || !row.userId) throw new HttpError(400, "invalid_handoff");
				const user = await ctx.env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(row.userId).first<{ id: string; email: string }>();
				if (!user) throw new HttpError(400, "invalid_handoff");
				return json(await createSession(ctx, user, !!row.payload?.created));
			}
			case "POST /auth/refresh": {
				const t = str((await readJson(req)).refreshToken, 128);
				if (!t) throw new HttpError(401, "invalid_refresh");
				return json(await refreshSession(ctx, t));
			}
			case "POST /auth/logout": {
				const t = str((await readJson(req)).refreshToken, 128);
				if (t) await logout(ctx, t);
				return json({ ok: true });
			}
			case "GET /auth/desktop/start": {
				const q = url.searchParams;
				const state = q.get("state") ?? "";
				const ch = q.get("code_challenge") ?? "";
				if (!B64URL.test(state) || !B64URL.test(ch) || q.get("code_challenge_method") !== "S256") throw new HttpError(400, "bad_request", "state, code_challenge and code_challenge_method=S256 required");
				return redirect(`${ctx.env.ULS_WEB_ORIGIN}/desktop?${new URLSearchParams({ state, code_challenge: ch })}`);
			}
			case "POST /auth/desktop/code": {
				const a = await authenticate(ctx);
				const body = await readJson(req);
				const state = str(body.state, 256);
				const ch = str(body.codeChallenge, 256);
				if (!state || !ch || !B64URL.test(ch)) throw new HttpError(400, "bad_request");
				return json({ code: await putOneTime(ctx, "desktop", 120_000, a.userId, { state, codeChallenge: ch }) });
			}
			case "POST /auth/desktop/exchange": {
				const body = await readJson(req);
				const code = str(body.code, 256);
				const verifier = str(body.codeVerifier, 256);
				if (!code || !verifier) throw new HttpError(400, "invalid_grant");
				// The code is consumed before the PKCE check, so a wrong verifier burns it.
				const row = await takeOneTime<{ codeChallenge: string }>(ctx, "desktop", code);
				if (!row || !row.userId || !timingSafeEqual(await sha256B64url(verifier), row.payload.codeChallenge)) throw new HttpError(400, "invalid_grant");
				const user = await ctx.env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(row.userId).first<{ id: string; email: string }>();
				if (!user) throw new HttpError(400, "invalid_grant");
				return json(await createSession(ctx, user, false));
			}
		}
		throw new HttpError(404, "not_found");
	}

	// ---- authenticated resources ----
	const known = p === "/me" || p === "/orgs" || /^\/(orgs\/[^/]+\/drives|drives\/[^/]+(\/token)?)$/.test(p);
	if (!known) throw new HttpError(404, "not_found");
	const a = await authenticate(ctx);
	if (p === "/me") {
		if (m === "GET") return R.getMe(ctx, a);
		if (m === "PATCH") return R.patchMe(ctx, a);
	} else if (p === "/orgs") {
		if (m === "GET") return R.listOrgs(ctx, a);
	} else if (seg[0] === "orgs") {
		if (m === "POST") return R.createDrive(ctx, a, seg[1]!);
	} else if (seg[2] === "token") {
		if (m === "POST") return R.driveToken(ctx, a, seg[1]!);
	} else {
		if (m === "GET") return R.getDrive(ctx, a, seg[1]!);
		if (m === "PATCH") return R.patchDrive(ctx, a, seg[1]!);
		if (m === "DELETE") return R.deleteDrive(ctx, a, seg[1]!);
	}
	throw new HttpError(405, "method_not_allowed");
}

export async function handle(req: Request, env: AppEnv, deps: Deps = {}): Promise<Response> {
	const cors = corsHeaders(env, req);
	if (req.method === "OPTIONS") return preflight(env, req);
	const f = deps.fetch ?? fetch;
	const ctx: Ctx = { env, req, url: new URL(req.url), now: deps.now ? deps.now() : Date.now(), fetch: f, email: deps.email ?? selectSender(env, f) };
	let res: Response;
	try {
		res = await route(ctx);
	} catch (e) {
		if (e instanceof HttpError) res = json(errBody(e.code, e.message !== e.code ? e.message : undefined), e.status);
		else {
			console.error("unhandled", String((e as Error)?.stack ?? e));
			res = json(errBody("internal"), 500);
		}
	}
	if (res.status !== 101 && Object.keys(cors).length) {
		res = new Response(res.body, res);
		for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
	}
	return res;
}

export default {
	fetch: (req: Request, env: AppEnv): Promise<Response> => handle(req, env),
} satisfies ExportedHandler<AppEnv>;

