import type { Ctx } from "./ctx";
import { HOUR, MIN } from "./ctx";
import { HttpError } from "./http";
import { hit } from "./ratelimit";
import { randomCode6, sha256Hex, timingSafeEqual } from "./util";

export const OTP_TTL_MS = 10 * MIN;
export const OTP_MAX_ATTEMPTS = 5;
const START_PER_EMAIL = 5;
const START_PER_IP = 20;

export function normalizeEmail(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const e = v.trim().toLowerCase();
	return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

const codeHash = (email: string, code: string) => sha256Hex(`otp:${email}:${code}`);

/** Always succeeds from the caller's view (no account enumeration); only rate limiting differs. */
export async function otpStart(ctx: Ctx, email: string): Promise<void> {
	const ip = ctx.req.headers.get("cf-connecting-ip") ?? "unknown";
	const okEmail = await hit(ctx, `otp:email:${email}`, START_PER_EMAIL, HOUR);
	const okIp = await hit(ctx, `otp:ip:${ip}`, START_PER_IP, HOUR);
	if (!okEmail || !okIp) throw new HttpError(429, "rate_limited");

	const code = randomCode6();
	await ctx.env.DB.prepare(
		`INSERT INTO otp_codes(email, code_hash, expires_at, attempts) VALUES(?,?,?,0)
		 ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
	)
		.bind(email, await codeHash(email, code), ctx.now + OTP_TTL_MS)
		.run();
	try {
		await ctx.email.send(
			email,
			`Your Unlispace code: ${code}`,
			`Your Unlispace sign-in code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`,
			`<p>Your Unlispace sign-in code is <strong style="font-size:1.4em;letter-spacing:.1em">${code}</strong>.</p><p>It expires in 10 minutes. If you didn't request this, ignore this email.</p>`,
		);
	} catch (e) {
		// Do not surface delivery errors: the response must be identical for every address.
		console.error("otp email failed", String((e as Error)?.message ?? e));
	}
}

/** True when the code is right. Every call burns an attempt; 5 attempts then the code is dead. */
export async function otpVerify(ctx: Ctx, email: string, code: string): Promise<boolean> {
	if (!/^\d{6}$/.test(code)) return false;
	const row = await ctx.env.DB.prepare(
		"UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ? AND attempts < ? AND expires_at > ? RETURNING code_hash",
	)
		.bind(email, OTP_MAX_ATTEMPTS, ctx.now)
		.first<{ code_hash: string }>();
	if (!row) return false;
	if (!timingSafeEqual(row.code_hash, await codeHash(email, code))) return false;
	// Single use: only one concurrent verify can delete the row.
	const del = await ctx.env.DB.prepare("DELETE FROM otp_codes WHERE email = ? AND code_hash = ?").bind(email, row.code_hash).run();
	return del.meta.changes === 1;
}
