import type { Ctx } from "./ctx";
import { DAY, HOUR } from "./ctx";

/**
 * How long a rotated or logged-out refresh token stays on record. Within this window, presenting
 * it again revokes the whole session family (theft detection); afterwards it is simply unknown.
 */
export const ROTATED_SESSION_RETENTION_MS = 7 * DAY;
const DODO_EVENT_RETENTION_MS = 90 * DAY;
const AI_USAGE_RETENTION_MS = 90 * DAY;
const BATCH = 2000;
const MAX_BATCHES = 10;

/** Delete rows that can no longer affect any request. Bounded per run; the next run continues. */
export async function pruneExpired(ctx: Ctx): Promise<void> {
	const db = ctx.env.DB;
	// Every token refresh adds a session row, so this table grows fastest.
	const sessions = db.prepare("DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE revoked_at < ?1 OR expires_at < ?2 LIMIT ?3)")
		.bind(ctx.now - ROTATED_SESSION_RETENTION_MS, ctx.now, BATCH);
	for (let i = 0; i < MAX_BATCHES; i++) {
		if ((await sessions.run()).meta.changes < BATCH) break;
	}
	await db.batch([
		db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(ctx.now - DAY),
		db.prepare("DELETE FROM otp_codes WHERE expires_at < ?").bind(ctx.now - HOUR),
		db.prepare("DELETE FROM one_time_codes WHERE expires_at < ?").bind(ctx.now - HOUR),
		db.prepare("DELETE FROM dodo_events WHERE received_at < ?").bind(ctx.now - DODO_EVENT_RETENTION_MS),
		db.prepare("DELETE FROM ai_usage WHERE day < ?").bind(new Date(ctx.now - AI_USAGE_RETENTION_MS).toISOString().slice(0, 10)),
	]);
}
