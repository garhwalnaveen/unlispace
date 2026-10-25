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

/** The current data-plane RPC reports logical head bytes, summed across every live org drive. */
export async function storageUsage(ctx: Ctx, orgId: string): Promise<number> {
	const drives = (await ctx.env.DB.prepare("SELECT id FROM drives WHERE org_id = ? AND status = 'ready'").bind(orgId).all<{ id: string }>()).results;
	let bytes = 0;
	for (const d of drives) {
		let stats;
		try { stats = await ctx.env.DATA_PLANE.driveStats(d.id); }
		catch { throw new HttpError(503, "usage_unavailable"); }
		if (stats === null || !Number.isSafeInteger(stats.bytes) || stats.bytes < 0) throw new HttpError(503, "usage_unavailable");
		bytes += stats.bytes;
		if (!Number.isSafeInteger(bytes)) throw new HttpError(503, "usage_unavailable");
	}
	return bytes;
}

export async function entitledDriveAccess(ctx: Ctx, orgId: string, want: "read" | "write"): Promise<"read" | "write"> {
	if (want === "read") return "read";
	const e = await entitlements(ctx, orgId);
	if (!e.writable) return "read";
	if (await storageUsage(ctx, orgId) > e.quotaBytes) throw new HttpError(403, "quota_exceeded");
	return "write";
}
