import type { Ctx } from "./ctx";
import { TB, INDIVIDUAL_BYTES, STORAGE_ADDON_BYTES } from "./billing-catalog";
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

export interface OrgTrialRow { tier: string; trial_ends_at: number | null; trial_pending: number }

/** Pure entitlement computation; `entitlements` and the batched org summaries both use it so they cannot drift. */
export function computeEntitlements(org: OrgTrialRow, b: BillingRow | null | undefined, now: number) {
	const paid = b?.status === "active" && b.current_period_end !== null && b.current_period_end > now;
	const trial = org.trial_ends_at !== null && org.trial_ends_at > now;
	const seats = paid ? b.seats : 1;
	const storageAddons = paid ? b.storage_addons : 0;
	const plan = paid ? b.plan : org.tier;
	return { writable: paid || trial, state: (paid ? "paid" : trial ? "trial_active" : org.trial_pending ? "provisioning" : "expired") as "paid" | "trial_active" | "provisioning" | "expired", trialPending: !!org.trial_pending, trialEndsAt: org.trial_ends_at, plan, seats, storageAddons, quotaBytes: seats * (plan === "individual" ? INDIVIDUAL_BYTES : TB) + storageAddons * STORAGE_ADDON_BYTES };
}

export async function entitlements(ctx: Ctx, orgId: string) {
	const org = await ctx.env.DB.prepare("SELECT tier, trial_ends_at, trial_pending FROM orgs WHERE id = ?").bind(orgId).first<OrgTrialRow>();
	if (!org) throw new HttpError(404, "no_such_org");
	return computeEntitlements(org, await billingRow(ctx, orgId), ctx.now);
}

/** Batch organization metadata; byte totals come from each organization's quota authority. */
export async function accessSummaries(ctx: Ctx, userId: string) {
	const db = ctx.env.DB;
	const [orgRows, billingRows, lineageRows, readyRows] = await db.batch([
		db.prepare("SELECT o.id, o.name, o.tier, o.trial_ends_at, o.trial_pending, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at, o.id").bind(userId),
		db.prepare("SELECT b.* FROM billing b JOIN memberships m ON m.org_id = b.org_id WHERE m.user_id = ?").bind(userId),
		db.prepare("SELECT DISTINCT d.org_id,COALESCE(d.lineage,d.id) AS lineage FROM drives d JOIN memberships m ON m.org_id=d.org_id WHERE m.user_id=?").bind(userId),
		db.prepare("SELECT DISTINCT d.org_id FROM drives d JOIN memberships m ON m.org_id = d.org_id WHERE m.user_id = ? AND d.status = 'ready'").bind(userId),
	]);
	const billing = new Map((billingRows!.results as unknown as BillingRow[]).map(b => [b.org_id, b]));
	const lineages = lineageRows!.results as {org_id: string; lineage: string}[];
	const ready = new Set((readyRows!.results as { org_id: string }[]).map(r => r.org_id));
	return Promise.all((orgRows!.results as (OrgTrialRow & { id: string; name: string; role: string })[]).map(async o => {
		const e = computeEntitlements(o, billing.get(o.id), ctx.now);
		const usedBytes = await quotaUsage(ctx, o.id, lineages.filter(d => d.org_id === o.id).map(d => d.lineage));
		return { id: o.id, name: o.name, role: o.role, tier: e.plan, state: e.state, trialPending: e.trialPending, trialEndsAt: e.trialEndsAt, writable: e.writable && usedBytes <= e.quotaBytes, overQuota: usedBytes > e.quotaBytes, storageReady: ready.has(o.id), quotaBytes: e.quotaBytes, usedBytes };
	}));
}

async function quotaUsage(ctx: Ctx, orgId: string, lineages: string[]): Promise<number> {
	try {
		const {usedBytes} = await ctx.env.DATA_PLANE.quotaUsage(orgId, lineages);
		if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) throw new Error("invalid usage");
		return usedBytes;
	} catch { throw new HttpError(503, "usage_unavailable"); }
}

/** Physical retained and staged bytes, including soft-deleted drives and spilled manifests. */
export async function storageUsage(ctx: Ctx, orgId: string): Promise<number> {
	const rows = (await ctx.env.DB.prepare("SELECT DISTINCT COALESCE(lineage,id) AS lineage FROM drives WHERE org_id=?").bind(orgId).all<{lineage:string}>()).results;
	return quotaUsage(ctx, orgId, rows.map(d => d.lineage));
}

export async function meterUsage(ctx: Ctx): Promise<void> {
	const rows = (await ctx.env.DB.prepare("SELECT d.id FROM drives d LEFT JOIN drive_usage u ON u.drive_id = d.id LEFT JOIN drive_usage_attempts a ON a.drive_id=d.id WHERE d.status != 'deleted' ORDER BY COALESCE(a.attempted_at,u.measured_at,0), d.id LIMIT 500").all<{ id: string }>()).results;
	let failed = false;
	for (const d of rows) {
		await ctx.env.DB.prepare("INSERT INTO drive_usage_attempts VALUES(?,?) ON CONFLICT(drive_id) DO UPDATE SET attempted_at=excluded.attempted_at").bind(d.id, ctx.now).run();
		try {
			const stats = await ctx.env.DATA_PLANE.driveStats(d.id);
			if (!stats) continue;
			if (![stats.bytes, stats.ownBytes].every(n => Number.isSafeInteger(n) && n >= 0)) throw new HttpError(503, "usage_unavailable");
			await ctx.env.DB.prepare("INSERT INTO drive_usage VALUES(?,?,?,?) ON CONFLICT(drive_id) DO UPDATE SET logical_bytes=excluded.logical_bytes, own_bytes=excluded.own_bytes, measured_at=excluded.measured_at").bind(d.id, stats.bytes, stats.ownBytes, ctx.now).run();
		} catch {
			failed = true;
			console.error("usage measurement failed", d.id);
		}
	}
	if (failed) throw new HttpError(503, "usage_unavailable");
}

export async function entitledDriveAccess(ctx: Ctx, orgId: string, want: "read" | "write"): Promise<"read" | "write"> {
	if (want === "read") return "read";
	const e = await entitlements(ctx, orgId);
	if (!e.writable) throw new HttpError(403, "over_quota");
	if (await storageUsage(ctx, orgId) > e.quotaBytes) throw new HttpError(403, "over_quota");
	await configureStorageQuota(ctx, orgId, e.quotaBytes);
	return "write";
}

export async function configureStorageQuota(ctx: Ctx, orgId: string, quotaBytes: number) {
	const rows = (await ctx.env.DB.prepare("SELECT DISTINCT COALESCE(lineage,id) AS lineage FROM drives WHERE org_id=?").bind(orgId).all<{lineage: string}>()).results;
	await ctx.env.DATA_PLANE.configureQuota(orgId, quotaBytes, rows.map(d => d.lineage));
}
