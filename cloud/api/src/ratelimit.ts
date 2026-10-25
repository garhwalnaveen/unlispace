import type { Ctx } from "./ctx";

/** Fixed-window counter in D1. Returns true when the call is allowed (and counts it). */
export async function hit(ctx: Ctx, key: string, limit: number, windowMs: number): Promise<boolean> {
	const row = await ctx.env.DB.prepare(
		`INSERT INTO rate_limits(k, window_start, count) VALUES(?1, ?2, 1)
		 ON CONFLICT(k) DO UPDATE SET
		   count = CASE WHEN window_start <= ?2 - ?3 THEN 1 ELSE count + 1 END,
		   window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END
		 RETURNING count`,
	)
		.bind(key, ctx.now, windowMs)
		.first<{ count: number }>();
	return (row?.count ?? 1) <= limit;
}
