import type { Ctx } from "./ctx";
import { TB, STORAGE_ADDON_BYTES } from "./billing-catalog";
import { HttpError } from "./http";

export interface BillingRow {
	org_id: string;
	customer_id: string | null;
	subscription_id: string | null;
	status: string;
	plan: "individual" | "teams";
	cadence: "monthly" | "annual";
	seats: number;
	storage_addons: number;
	current_period_end: number | null;
	cancel_at_period_end: number;
	event_at: number;
	event_id: string;
}

export async function billingRow(ctx: Ctx, orgId: string): Promise<BillingRow | null> {
	return ctx.env.DB.prepare("SELECT * FROM billing WHERE org_id = ?").bind(orgId).first<BillingRow>();
}

export async function entitlements(ctx: Ctx, orgId: string) {
	const org = await ctx.env.DB.prepare("SELECT tier, trial_ends_at FROM orgs WHERE id = ?").bind(orgId).first<{ tier: string; trial_ends_at: number | null }>();
	if (!org) throw new HttpError(404, "no_such_org");
	const b = await billingRow(ctx, orgId);
	const paid = b?.status === "active" && b.current_period_end !== null && b.current_period_end > ctx.now;
	const trial = org.trial_ends_at !== null && org.trial_ends_at > ctx.now;
	const seats = paid ? b.seats : 1;
	const storageAddons = paid ? b.storage_addons : 0;
	return { writable: paid || trial, state: paid ? "paid" : trial ? "trial_active" : "expired", trialEndsAt: org.trial_ends_at, plan: paid ? b.plan : org.tier, seats, storageAddons, quotaBytes: seats * TB + storageAddons * STORAGE_ADDON_BYTES };
}

/** Billing counts only measured, retained bytes owned by live drives. */
export async function storageUsage(ctx: Ctx, orgId: string): Promise<number> {
	const row = await ctx.env.DB.prepare("SELECT COALESCE(SUM(u.own_bytes),0) AS bytes FROM drives d JOIN drive_usage u ON u.drive_id = d.id WHERE d.org_id = ? AND d.status != 'deleted'").bind(orgId).first<{ bytes: number }>();
	return row!.bytes;
}

export async function meterUsage(ctx: Ctx): Promise<void> {
	const rows = (await ctx.env.DB.prepare("SELECT d.id FROM drives d LEFT JOIN drive_usage u ON u.drive_id = d.id WHERE d.status != 'deleted' ORDER BY COALESCE(u.measured_at,0), d.id LIMIT 500").all<{ id: string }>()).results;
	for (const d of rows) {
		const stats = await ctx.env.DATA_PLANE.driveStats(d.id);
		if (!stats) continue;
		if (![stats.bytes, stats.ownBytes].every(n => Number.isSafeInteger(n) && n >= 0)) throw new HttpError(503, "usage_unavailable");
		await ctx.env.DB.prepare("INSERT INTO drive_usage VALUES(?,?,?,?) ON CONFLICT(drive_id) DO UPDATE SET logical_bytes=excluded.logical_bytes, own_bytes=excluded.own_bytes, measured_at=excluded.measured_at").bind(d.id, stats.bytes, stats.ownBytes, ctx.now).run();
	}
}

export async function entitledDriveAccess(ctx: Ctx, orgId: string, want: "read" | "write"): Promise<"read" | "write"> {
	if (want === "read") return "read";
	const e = await entitlements(ctx, orgId);
	if (!e.writable) throw new HttpError(403, "over_quota");
	if (await storageUsage(ctx, orgId) > e.quotaBytes) throw new HttpError(403, "over_quota");
	return "write";
}
