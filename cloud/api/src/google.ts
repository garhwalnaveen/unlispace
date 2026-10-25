import type { Ctx } from "./ctx";
import { MIN } from "./ctx";
import { b64urlDecode } from "./jwt";
import { putOneTime, takeOneTime } from "./onetime";
import { randomB64url, sha256B64url } from "./util";
import { HttpError, redirect } from "./http";
import { findOrCreateUser } from "./users";
import { normalizeEmail } from "./otp";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

interface GoogleState {
	nonce: string;
	verifier: string;
	ret: string;
}

export function configured(ctx: Ctx): boolean {
	return !!(ctx.env.GOOGLE_CLIENT_ID && ctx.env.GOOGLE_CLIENT_SECRET);
}

const redirectUri = (ctx: Ctx) => `${ctx.env.ULS_ISSUER}/auth/google/callback`;

/** `return` must be absolute on ULS_WEB_ORIGIN (or omitted, which means the web root). */
export function allowedReturn(ctx: Ctx, ret: string | null): string {
	if (!ret) return ctx.env.ULS_WEB_ORIGIN + "/";
	let u: URL;
	try {
		u = new URL(ret);
	} catch {
		throw new HttpError(400, "bad_return");
	}
	if (u.origin !== ctx.env.ULS_WEB_ORIGIN || u.username || u.password) throw new HttpError(400, "bad_return");
	return u.toString().split("#")[0]!;
}

export async function googleStart(ctx: Ctx): Promise<Response> {
	const ret = allowedReturn(ctx, ctx.url.searchParams.get("return"));
	const state = randomB64url(32);
	const nonce = randomB64url(24);
	const verifier = randomB64url(48);
	await putOneTime(ctx, "google_state", 10 * MIN, null, { nonce, verifier, ret } satisfies GoogleState, state);
	const q = new URLSearchParams({
		client_id: ctx.env.GOOGLE_CLIENT_ID!,
		redirect_uri: redirectUri(ctx),
		response_type: "code",
		scope: "openid email",
		state,
		nonce,
		code_challenge: await sha256B64url(verifier),
		code_challenge_method: "S256",
		prompt: "select_account",
	});
	return redirect(`${AUTH_URL}?${q}`);
}

class GoogleFail extends Error {}

interface GoogleClaims {
	iss?: string;
	aud?: string;
	exp?: number;
	nonce?: string;
	email?: string;
	email_verified?: boolean | string;
}

async function verifyIdToken(ctx: Ctx, idToken: string, nonce: string): Promise<string> {
	const parts = idToken.split(".");
	if (parts.length !== 3) throw new GoogleFail("invalid_token");
	const [h, p, s] = parts as [string, string, string];
	let header: { alg?: string; kid?: string };
	let claims: GoogleClaims;
	try {
		header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
		claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
	} catch {
		throw new GoogleFail("invalid_token");
	}
	if (header.alg !== "RS256" || !header.kid) throw new GoogleFail("invalid_token");

	const res = await ctx.fetch(JWKS_URL);
	if (!res.ok) throw new GoogleFail("jwks_unavailable");
	const jwks = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
	const jwk = jwks.keys?.find((k) => k.kid === header.kid && k.kty === "RSA");
	if (!jwk) throw new GoogleFail("invalid_token");
	const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s), new TextEncoder().encode(h + "." + p));
	if (!ok) throw new GoogleFail("invalid_token");

	if (!claims.iss || !ISSUERS.includes(claims.iss)) throw new GoogleFail("invalid_issuer");
	if (claims.aud !== ctx.env.GOOGLE_CLIENT_ID) throw new GoogleFail("invalid_audience");
	if (typeof claims.exp !== "number" || claims.exp * 1000 + 30_000 <= ctx.now) throw new GoogleFail("token_expired");
	if (claims.nonce !== nonce) throw new GoogleFail("invalid_nonce");
	if (claims.email_verified !== true && claims.email_verified !== "true") throw new GoogleFail("email_not_verified");
	const email = normalizeEmail(claims.email);
	if (!email) throw new GoogleFail("invalid_token");
	return email;
}

/** Callback: errors after a valid state go back to the web app as `#error=<code>`. */
export async function googleCallback(ctx: Ctx): Promise<Response> {
	const q = ctx.url.searchParams;
	const stateParam = q.get("state") ?? "";
	const st = stateParam ? await takeOneTime<GoogleState>(ctx, "google_state", stateParam) : null;
	if (!st) throw new HttpError(400, "invalid_state");
	const back = (frag: string) => redirect(`${st.payload.ret}#${frag}`);

	if (q.get("error")) return back("error=access_denied");
	const code = q.get("code");
	if (!code) return back("error=invalid_request");
	try {
		const tokRes = await ctx.fetch(TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code,
				client_id: ctx.env.GOOGLE_CLIENT_ID!,
				client_secret: ctx.env.GOOGLE_CLIENT_SECRET!,
				redirect_uri: redirectUri(ctx),
				grant_type: "authorization_code",
				code_verifier: st.payload.verifier,
			}),
		});
		if (!tokRes.ok) throw new GoogleFail("token_exchange_failed");
		const tok = (await tokRes.json()) as { id_token?: string };
		if (!tok.id_token) throw new GoogleFail("token_exchange_failed");
		const email = await verifyIdToken(ctx, tok.id_token, st.payload.nonce);
		const { user, created } = await findOrCreateUser(ctx, email);
		const handoff = await putOneTime(ctx, "handoff", 60_000, user.id, { created });
		return back(`handoff=${handoff}`);
	} catch (e) {
		if (e instanceof GoogleFail) return back(`error=${e.message}`);
		console.error("google callback failed", String((e as Error)?.message ?? e));
		return back("error=server_error");
	}
}
