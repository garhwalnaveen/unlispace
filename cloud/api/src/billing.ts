import type { Ctx } from "./ctx";
import { ulid } from "./ctx";
import { catalog, products, seatProduct, type Cadence, type Plan } from "./billing-catalog";
import { selectDodo, verifyDodoWebhook } from "./dodo";
import { billingRow, entitlements, storageUsage } from "./entitlements";
import { HttpError, json, readJson, readText, str } from "./http";
import type { Authed } from "./session";

const dodo = (ctx: Ctx) => ctx.dodo ?? selectDodo(ctx.env, ctx.fetch);

async function authorize(ctx: Ctx, a: Authed, orgId: string, manage = false) {
	const m = await ctx.env.DB.prepare("SELECT role FROM memberships WHERE user_id = ? AND org_id = ?").bind(a.userId, orgId).first<{ role: string }>();
	if (!m) throw new HttpError(404, "no_such_org");
	if (manage && m.role !== "owner" && m.role !== "admin") throw new HttpError(403, "forbidden");
}

export const getCatalog = (ctx: Ctx) => json(catalog(ctx.env));

export async function getBilling(ctx: Ctx, a: Authed, orgId: string): Promise<Response> {
	await authorize(ctx, a, orgId);
	const b = await billingRow(ctx, orgId);
	const e = await entitlements(ctx, orgId);
	const usedBytes = await storageUsage(ctx, orgId);
	return json({ orgId, provider: "dodo", ...e, writable: e.writable && usedBytes <= e.quotaBytes, usedBytes, overQuota: usedBytes > e.quotaBytes, status: b?.status ?? "trialing", cadence: b?.cadence ?? null, currentPeriodEnd: b?.current_period_end ?? null, cancelAtPeriodEnd: !!b?.cancel_at_period_end });
}

export async function checkout(ctx: Ctx, a: Authed, orgId: string): Promise<Response> {
	await authorize(ctx, a, orgId, true);
	const b = await readJson(ctx.req);
	const plan = b.plan as Plan;
	const cadence = (b.cadence ?? "monthly") as Cadence;
	const seats = b.seats ?? 1;
	const addons = b.storageAddons ?? 0;
	if (!["individual", "teams"].includes(plan) || !["monthly", "annual"].includes(cadence) || !Number.isSafeInteger(seats) || (seats as number) < 1 || (seats as number) > 1000 || (plan === "individual" && seats !== 1) || !Number.isSafeInteger(addons) || (addons as number) < 0 || (addons as number) > 1000) throw new HttpError(400, "bad_request");
	const p = products(ctx.env);
	if (!p) throw new HttpError(503, "billing_not_configured");
	const current = await billingRow(ctx, orgId);
	if (current?.subscription_id && !["cancelled", "expired", "failed"].includes(current.status)) throw new HttpError(409, "subscription_exists", "use the billing portal to manage an existing subscription");
	const members = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?").bind(orgId).first<{ n: number }>();
	if ((members?.n ?? 0) > (seats as number)) throw new HttpError(409, "seats_below_members");
	const intent = "bc_" + ulid();
	await ctx.env.DB.prepare("INSERT INTO billing_checkouts(id,org_id,created_at) VALUES(?,?,?)").bind(intent, orgId, ctx.now).run();
	try {
		return json(await dodo(ctx).checkout({
			product_cart: [{ product_id: p[plan][cadence], quantity: seats as number, addons: addons ? [{ addon_id: p.storage[cadence], quantity: addons as number }] : [] }],
			customer: current?.customer_id ? { customer_id: current.customer_id } : { email: a.email, name: a.email },
			metadata: { org_id: orgId, checkout_intent: intent },
			return_url: `${ctx.env.ULS_WEB_ORIGIN}/orgs/${encodeURIComponent(orgId)}/billing`,
			// The no-card trial belongs to Unlispace; checkout converts immediately.
			subscription_data: { trial_period_days: 0 },
		}));
	} catch (e) {
		await ctx.env.DB.prepare("DELETE FROM billing_checkouts WHERE id = ?").bind(intent).run();
		throw e;
	}
}

export async function invoices(ctx: Ctx, a: Authed, orgId: string): Promise<Response> {
	await authorize(ctx, a, orgId, true);
	const page = ctx.url.searchParams.get("page") ?? "0";
	if (!/^\d{1,5}$/.test(page)) throw new HttpError(400, "bad_request");
	const b = await billingRow(ctx, orgId);
	return json(b?.customer_id ? await dodo(ctx).invoices(b.customer_id, Number(page)) : { invoices: [], nextPage: null });
}

export async function portal(ctx: Ctx, a: Authed, orgId: string): Promise<Response> {
	await authorize(ctx, a, orgId, true);
	const b = await billingRow(ctx, orgId);
	if (!b?.customer_id) throw new HttpError(409, "no_billing_customer");
	return json(await dodo(ctx).portal(b.customer_id, `${ctx.env.ULS_WEB_ORIGIN}/orgs/${encodeURIComponent(orgId)}/billing`));
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_webhook");
	return value as Record<string, unknown>;
}

const subscriptionTypes = new Set(["subscription.active", "subscription.renewed", "subscription.updated", "subscription.plan_changed", "subscription.on_hold", "subscription.cancelled", "subscription.expired", "subscription.failed"]);

export async function webhook(ctx: Ctx): Promise<Response> {
	const raw = await readText(ctx.req);
	const id = await verifyDodoWebhook(ctx.req, raw, ctx.env.DODO_PAYMENTS_WEBHOOK_KEY, ctx.now);
	let event: Record<string, unknown>;
	try { event = object(JSON.parse(raw)); } catch { throw new HttpError(400, "invalid_webhook"); }
	const type = str(event.type, 100);
	const eventAt = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
	if (!type || !Number.isFinite(eventAt) || eventAt > ctx.now + 300_000) throw new HttpError(400, "invalid_webhook");
	if (await ctx.env.DB.prepare("SELECT 1 FROM dodo_events WHERE id = ?").bind(id).first()) return json({ ok: true });
	const db = ctx.env.DB;
	const remember = db.prepare("INSERT OR IGNORE INTO dodo_events(id,type,received_at) VALUES(?,?,?)").bind(id, type, ctx.now);
	if (!subscriptionTypes.has(type)) {
		await remember.run();
		return json({ ok: true, ignored: true });
	}
	const data = object(event.data);
	const subscriptionId = str(data.subscription_id, 256);
	const customerId = str(object(data.customer).customer_id, 256);
	const status = str(data.status, 32);
	if (!subscriptionId || !customerId || !status || !["active", "on_hold", "cancelled", "expired", "failed", "pending"].includes(status)) throw new HttpError(400, "invalid_webhook");
	// Existing subscriptions keep working even when metadata is absent on a later event.
	const existing = await db.prepare("SELECT org_id FROM billing WHERE subscription_id = ? AND customer_id = ?").bind(subscriptionId, customerId).first<{ org_id: string }>();
	let orgId = existing?.org_id;
	if (!orgId) {
		const metadata = object(data.metadata ?? {});
		const intent = str(metadata.checkout_intent, 100);
		const org = str(metadata.org_id, 100);
		const known = intent && org ? await db.prepare("SELECT org_id FROM billing_checkouts WHERE id = ? AND org_id = ?").bind(intent, org).first<{ org_id: string }>() : null;
		if (!known) { await remember.run(); return json({ ok: true, ignored: true }); }
		orgId = known.org_id;
		const current = await billingRow(ctx, orgId);
		if (current?.customer_id && current.customer_id !== customerId) throw new HttpError(400, "invalid_webhook");
		if (current?.subscription_id && !["cancelled", "expired", "failed"].includes(current.status)) throw new HttpError(409, "subscription_exists");
	}
	const p = products(ctx.env);
	if (!p) throw new HttpError(503, "billing_not_configured");
	const selection = seatProduct(p, data.product_id);
	if (!selection) throw new HttpError(400, "invalid_webhook", "unknown subscription product");
	const seats = data.quantity;
	if (!Number.isSafeInteger(seats) || (seats as number) < 1 || (seats as number) > 1000 || (selection.plan === "individual" && seats !== 1)) throw new HttpError(400, "invalid_webhook");
	if (!Array.isArray(data.addons)) throw new HttpError(400, "invalid_webhook");
	let storageAddons = 0;
	for (const item of data.addons) {
		const addon = object(item);
		if (addon.addon_id !== p.storage[selection.cadence] || !Number.isSafeInteger(addon.quantity) || (addon.quantity as number) < 0) throw new HttpError(400, "invalid_webhook");
		storageAddons += addon.quantity as number;
	}
	if (storageAddons > 1000) throw new HttpError(400, "invalid_webhook");
	const periodEnd = typeof data.next_billing_date === "string" ? Date.parse(data.next_billing_date) : NaN;
	if (!Number.isFinite(periodEnd)) throw new HttpError(400, "invalid_webhook");
	// D1 batch is transactional: entitlement mutation and receipt cannot diverge on retry.
	await db.batch([
		db.prepare(`INSERT INTO billing(org_id,customer_id,subscription_id,status,plan,cadence,seats,storage_addons,current_period_end,cancel_at_period_end,event_at,event_id)
			SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM dodo_events WHERE id = ?)
			ON CONFLICT(org_id) DO UPDATE SET customer_id=excluded.customer_id, subscription_id=excluded.subscription_id,
			status=excluded.status, plan=excluded.plan, cadence=excluded.cadence, seats=excluded.seats, storage_addons=excluded.storage_addons,
			current_period_end=excluded.current_period_end, cancel_at_period_end=excluded.cancel_at_period_end, event_at=excluded.event_at, event_id=excluded.event_id
			WHERE excluded.event_at > billing.event_at OR (excluded.event_at = billing.event_at AND excluded.event_id > billing.event_id)`)
			.bind(orgId, customerId, subscriptionId, status, selection.plan, selection.cadence, seats, storageAddons, periodEnd, data.cancel_at_next_billing_date === true ? 1 : 0, eventAt, id, id),
		db.prepare(`UPDATE orgs SET tier = (SELECT plan FROM billing WHERE org_id = ?),
			trial_ends_at = CASE WHEN (SELECT status FROM billing WHERE org_id = ?) = 'active' THEN NULL ELSE trial_ends_at END
			WHERE id = ? AND EXISTS(SELECT 1 FROM billing WHERE org_id = ?)`)
			.bind(orgId, orgId, orgId, orgId),
		remember,
	]);
	return json({ ok: true });
}
