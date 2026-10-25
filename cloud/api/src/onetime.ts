import type { Ctx } from "./ctx";
import { randomB64url, sha256Hex } from "./util";

export type OneTimeKind = "handoff" | "desktop" | "google_state";

export async function putOneTime(ctx: Ctx, kind: OneTimeKind, ttlMs: number, userId: string | null, payload: unknown, token = randomB64url(32)): Promise<string> {
	await ctx.env.DB.prepare("INSERT INTO one_time_codes(code_hash, kind, user_id, payload, expires_at) VALUES(?,?,?,?,?)")
		.bind(await sha256Hex(kind + ":" + token), kind, userId, JSON.stringify(payload ?? null), ctx.now + ttlMs)
		.run();
	// Opportunistic cleanup keeps the table small without a cron.
	await ctx.env.DB.prepare("DELETE FROM one_time_codes WHERE expires_at < ?").bind(ctx.now - 3_600_000).run();
	return token;
}

/** Atomically consume (single use). Returns null when unknown, expired, wrong kind, or already used. */
export async function takeOneTime<P>(ctx: Ctx, kind: OneTimeKind, token: string): Promise<{ userId: string | null; payload: P } | null> {
	const row = await ctx.env.DB.prepare("UPDATE one_time_codes SET used_at = ? WHERE code_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id, payload")
		.bind(ctx.now, await sha256Hex(kind + ":" + token), kind, ctx.now)
		.first<{ user_id: string | null; payload: string }>();
	if (!row) return null;
	return { userId: row.user_id, payload: JSON.parse(row.payload) as P };
}
