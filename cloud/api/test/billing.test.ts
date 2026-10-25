import { describe, expect, it, vi } from "vitest";
import type { CheckoutInput, DodoPayments } from "../src/dodo";
import { verifyJwt } from "../src/jwt";
import { HttpError } from "../src/http";
import { makeWorld, signIn, type World } from "./helpers";

const json = async (r: Response): Promise<any> => r.json();
const products = {
	individual: { monthly: "p_ind_m", annual: "p_ind_a" },
	teams: { monthly: "p_team_m", annual: "p_team_a" },
	storage: { monthly: "a_store_m", annual: "a_store_a" },
};
const webhookKey = btoa("a local test-only webhook secret!");

async function fixture() {
	const w = await makeWorld({ DODO_PRODUCTS: JSON.stringify(products), DODO_PAYMENTS_WEBHOOK_KEY: "whsec_" + webhookKey, DODO_PAYMENTS_API_KEY: "local-test-only", DODO_PAYMENTS_ENVIRONMENT: "test_mode" });
	const provider = {
		checkout: vi.fn(async (_input: CheckoutInput) => ({ url: "https://checkout.dodopayments.com/test" })),
		portal: vi.fn(async (_customerId: string, _returnUrl: string) => ({ url: "https://customer.dodopayments.com/test" })),
		invoices: vi.fn(async (_customerId: string, _page: number) => ({ invoices: [{ paymentId: "pay_test", status: "succeeded", amount: 2000, currency: "USD", createdAt: new Date(w.clock.t).toISOString() }], nextPage: null })),
	} satisfies DodoPayments;
	w.dodoImpl.client = provider;
	const s = await signIn(w);
	const org = (await json(await w.call("/orgs", { token: s.accessToken }))).orgs[0];
	const path = `/orgs/${org.id}/billing`;
	const call = (suffix = "", init: RequestInit & { json?: unknown } = {}) => w.call(path + suffix, { token: s.accessToken, ...init });
	const activate = async (overrides: Record<string, unknown> = {}, id = "evt_active") => {
		const plan = Object.values(products.teams).includes(String(overrides.product_id)) ? "teams" : "individual";
		await call("/checkout", { json: { plan, seats: overrides.quantity ?? 1 } });
		const input = provider.checkout.mock.calls.at(-1)![0];
		const data = subscription(w, { metadata: input.metadata, ...overrides });
		const response = await deliver(w, { type: "subscription.active", timestamp: new Date(w.clock.t).toISOString(), data }, id);
		return { response, data };
	};
	return { w, s, org, path, call, provider, activate };
}

function subscription(w: World, overrides: Record<string, unknown> = {}) {
	return { subscription_id: "sub_test", customer: { customer_id: "cus_test" }, status: "active", product_id: products.individual.monthly, quantity: 1, addons: [], next_billing_date: new Date(w.clock.t + 30 * 86_400_000).toISOString(), cancel_at_next_billing_date: false, ...overrides };
}

async function signature(w: World, raw: string, id: string, timestamp = String(Math.floor(w.clock.t / 1000))) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("a local test-only webhook secret!"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`));
	return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": "v1," + btoa(String.fromCharCode(...new Uint8Array(mac))) };
}

async function deliver(w: World, event: unknown, id = "evt_test") {
	const raw = JSON.stringify(event);
	return w.call("/webhooks/dodo", { method: "POST", body: raw, headers: await signature(w, raw, id) });
}

async function tokenAccess(w: World, token: string, driveId: string, access = "write") {
	const r = await w.call(`/drives/${driveId}/token`, { token, json: { access } });
	if (r.status !== 200) return { status: r.status, ...await json(r) };
	const t = await json(r);
	const claims = await verifyJwt(t.token, w.env.ULS_JWT_PUBLIC_JWKS, { issuer: w.env.ULS_ISSUER, typ: "drive", now: w.clock.t });
	return { status: r.status, access: (claims.drives as { access: string }[])[0]!.access };
}

describe("billing catalog and checkout", () => {
	it("publishes the plan capacities and no-card trial without authentication or private config", async () => {
		const { w } = await fixture();
		const r = await w.call("/billing/catalog");
		expect(r.status).toBe(200);
		const b = await json(r);
		expect(b).toMatchObject({ provider: "dodo", trialDays: 7, trialRequiresCard: false, checkoutAvailable: true, storageAddon: { bytes: 500_000_000_000 }, plans: [{ id: "individual", bytesPerSeat: 1_000_000_000_000, maxSeats: 1 }, { id: "teams", bytesPerSeat: 1_000_000_000_000 }] });
		expect(JSON.stringify(b)).not.toContain("local-test-only");
		delete w.env.DODO_PRODUCTS;
		expect((await json(await w.call("/billing/catalog"))).checkoutAvailable).toBe(false);
		expect((await w.call("/billing/catalog", { method: "POST" })).status).toBe(405);
	});

	it("creates a recurring Teams checkout with seats and storage addons; entitlements await a webhook", async () => {
		const { w, call, org, provider } = await fixture();
		const res = await call("/checkout", { json: { plan: "teams", cadence: "annual", seats: 4, storageAddons: 2, returnUrl: "https://evil.test" } });
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({ url: "https://checkout.dodopayments.com/test" });
		const input = provider.checkout.mock.calls[0]![0];
		expect(input).toMatchObject({ product_cart: [{ product_id: "p_team_a", quantity: 4, addons: [{ addon_id: "a_store_a", quantity: 2 }] }], subscription_data: { trial_period_days: 0 }, metadata: { org_id: org.id }, return_url: `${w.env.ULS_WEB_ORIGIN}/orgs/${org.id}/billing` });
		expect(await w.env.DB.prepare("SELECT org_id FROM billing_checkouts WHERE id = ?").bind(input.metadata.checkout_intent).first()).toMatchObject({ org_id: org.id });
		expect(await json(await call())).toMatchObject({ state: "trial_active", plan: "individual", seats: 1, storageAddons: 0 });
	});

	it("validates plans, cadence and bounded integer quantities without contacting Dodo", async () => {
		const { call, provider } = await fixture();
		for (const b of [{}, { plan: "free" }, { plan: "teams", cadence: "week" }, { plan: "individual", seats: 2 }, { plan: "teams", seats: 0 }, { plan: "teams", seats: 1.5 }, { plan: "teams", seats: 1001 }, { plan: "teams", seats: "2" }, { plan: "teams", storageAddons: -1 }, { plan: "teams", storageAddons: 1001 }]) expect((await call("/checkout", { json: b })).status).toBe(400);
		expect(provider.checkout).not.toHaveBeenCalled();
	});

	it("rejects missing config, insufficient seats and duplicate subscriptions; failed checkouts clear their intent", async () => {
		const { w, call, org, activate, provider } = await fixture();
		delete w.env.DODO_PRODUCTS;
		expect((await call("/checkout", { json: { plan: "teams" } })).status).toBe(503);
		w.env.DODO_PRODUCTS = JSON.stringify(products);
		const member = await signIn(w, "member@example.com");
		await w.env.DB.prepare("INSERT INTO memberships VALUES(?,?,?,?)").bind(org.id, member.user.id, "member", w.clock.t).run();
		expect(await json(await call("/checkout", { json: { plan: "teams" } }))).toEqual({ error: "seats_below_members" });
		provider.checkout.mockRejectedValueOnce(new HttpError(502, "billing_unavailable"));
		expect((await call("/checkout", { json: { plan: "teams", seats: 2 } })).status).toBe(502);
		expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM billing_checkouts").first()).toEqual({ n: 0 });
		await activate({ product_id: products.teams.monthly, quantity: 2 });
		expect((await call("/checkout", { json: { plan: "teams", seats: 2 } })).status).toBe(409);
	});
});

describe("billing access and provider boundary", () => {
	it("hides other orgs and limits checkout, invoices and portal to owners/admins", async () => {
		const { w, org, path, call, provider } = await fixture();
		const outsider = await signIn(w, "other@example.com");
		expect((await w.call(path)).status).toBe(401);
		expect((await w.call(path, { token: outsider.accessToken })).status).toBe(404);
		await w.env.DB.prepare("INSERT INTO memberships VALUES(?,?,?,?)").bind(org.id, outsider.user.id, "viewer", w.clock.t).run();
		expect((await w.call(path, { token: outsider.accessToken })).status).toBe(200);
		for (const [suffix, method] of [["/checkout", "POST"], ["/portal", "POST"], ["/invoices", "GET"]]) expect((await w.call(path + suffix, { token: outsider.accessToken, method })).status).toBe(403);
		expect(await json(await call("/invoices"))).toEqual({ invoices: [], nextPage: null });
		expect((await call("/portal", { method: "POST" })).status).toBe(409);
		expect(provider.invoices).not.toHaveBeenCalled();
		expect((await call("/invoices", { method: "POST" })).status).toBe(405);
	});

	it("passes the stored customer to invoice/portal adapters and safely validates pagination", async () => {
		const { call, provider, activate } = await fixture();
		expect((await activate()).response.status).toBe(200);
		expect((await json(await call("/invoices?page=3"))).invoices[0]).toMatchObject({ paymentId: "pay_test", amount: 2000 });
		expect(provider.invoices).toHaveBeenCalledWith("cus_test", 3);
		expect((await call("/invoices?page=-1")).status).toBe(400);
		expect(await json(await call("/portal", { method: "POST" }))).toEqual({ url: "https://customer.dodopayments.com/test" });
		expect(provider.portal.mock.calls[0]![0]).toBe("cus_test");
	});
});

describe("Dodo Standard Webhooks verification", () => {
	it("rejects missing, forged, stale, future, altered-body and wrong-version signatures before parsing JSON", async () => {
		const { w } = await fixture();
		const raw = "not even json";
		expect((await w.call("/webhooks/dodo", { method: "POST", body: raw })).status).toBe(401);
		const valid = await signature(w, raw, "evt_bad_json");
		expect((await w.call("/webhooks/dodo", { method: "POST", body: raw, headers: valid })).status).toBe(400);
		expect((await w.call("/webhooks/dodo", { method: "POST", body: raw + " ", headers: valid })).status).toBe(401);
		for (const offset of [-301, 301]) {
			const headers = await signature(w, raw, "evt_time", String(Math.floor(w.clock.t / 1000) + offset));
			expect((await w.call("/webhooks/dodo", { method: "POST", body: raw, headers })).status).toBe(401);
		}
		valid["webhook-signature"] = valid["webhook-signature"].replace("v1,", "v2,");
		expect((await w.call("/webhooks/dodo", { method: "POST", body: raw, headers: valid })).status).toBe(401);
		expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM dodo_events").first()).toEqual({ n: 0 });
		expect((await w.call("/webhooks/dodo")).status).toBe(405);
	});

	it("supports signature rotation candidates, ignores unrelated events, and bounds raw bodies", async () => {
		const { w } = await fixture();
		const raw = JSON.stringify({ type: "payment.succeeded", timestamp: new Date(w.clock.t).toISOString(), data: {} });
		const headers = await signature(w, raw, "evt_other");
		headers["webhook-signature"] = `v1,not-the-signature v2,other ${headers["webhook-signature"]}`;
		expect(await json(await w.call("/webhooks/dodo", { method: "POST", body: raw, headers }))).toEqual({ ok: true, ignored: true });
		expect((await w.call("/webhooks/dodo", { method: "POST", body: "x".repeat(65_537) })).status).toBe(413);
		delete w.env.DODO_PAYMENTS_WEBHOOK_KEY;
		expect((await w.call("/webhooks/dodo", { method: "POST", body: raw, headers })).status).toBe(503);
	});
});

describe("subscription event persistence", () => {
	it("uses verified product/quantity/addons, updates org tier, and handles replay/out-of-order events", async () => {
		const { w, org, call, activate } = await fixture();
		const { response, data } = await activate({ product_id: products.teams.annual, quantity: 3, addons: [{ addon_id: products.storage.annual, quantity: 2 }] });
		expect(response.status).toBe(200);
		expect(await json(await call())).toMatchObject({ plan: "teams", seats: 3, storageAddons: 2, quotaBytes: 4_000_000_000_000, state: "paid", writable: true });
		expect(await w.env.DB.prepare("SELECT tier,trial_ends_at FROM orgs WHERE id = ?").bind(org.id).first()).toEqual({ tier: "teams", trial_ends_at: null });
		const old = { type: "subscription.on_hold", timestamp: new Date(w.clock.t - 1000).toISOString(), data: { ...data, status: "on_hold" } };
		expect((await deliver(w, old, "evt_old")).status).toBe(200);
		expect((await json(await call())).state).toBe("paid");
		const hold = { ...old, timestamp: new Date(w.clock.t + 1000).toISOString() };
		expect((await deliver(w, hold, "evt_hold")).status).toBe(200);
		// Same delivery ID cannot grant access again, even with a different signed body.
		expect((await deliver(w, { ...hold, data }, "evt_hold")).status).toBe(200);
		expect(await json(await call())).toMatchObject({ state: "expired", writable: false, status: "on_hold" });
		expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM dodo_events").first()).toEqual({ n: 3 });
	});

	it("ignores unrecognized checkout metadata and rejects invalid subscription products and scopes without receipts", async () => {
		const { w, call, provider } = await fixture();
		const base = { type: "subscription.active", timestamp: new Date(w.clock.t).toISOString() };
		expect(await json(await deliver(w, { ...base, data: subscription(w, { metadata: { org_id: "o_unknown", checkout_intent: "made_up" } }) }, "evt_unknown"))).toMatchObject({ ignored: true });
		await call("/checkout", { json: { plan: "individual" } });
		const metadata = provider.checkout.mock.calls[0]![0].metadata;
		for (const [n, invalid] of [{ product_id: "unrecognized" }, { quantity: 2 }, { addons: [{ addon_id: "unrecognized", quantity: 3 }] }, { quantity: 0 }, { addons: [{ addon_id: products.storage.monthly, quantity: -1 }] }, { next_billing_date: "yesterday" }, { status: "mystery" }].entries()) expect((await deliver(w, { ...base, data: subscription(w, { metadata, ...invalid }) }, `evt_invalid_${n}`)).status).toBe(400);
		expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM billing").first()).toEqual({ n: 0 });
		expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM dodo_events").first()).toEqual({ n: 1 });
	});

	it("accepts lifecycle events without metadata and distinguishes scheduled from effective cancellation", async () => {
		const { w, call, activate } = await fixture();
		const { data } = await activate({ cancel_at_next_billing_date: true, next_billing_date: new Date(w.clock.t + 2000).toISOString() });
		expect(await json(await call())).toMatchObject({ writable: true, cancelAtPeriodEnd: true });
		w.clock.t += 2000;
		expect((await json(await call())).writable).toBe(false);
		const cancelled = { ...data, metadata: undefined, status: "cancelled" };
		expect((await deliver(w, { type: "subscription.cancelled", timestamp: new Date(w.clock.t).toISOString(), data: cancelled }, "evt_cancel")).status).toBe(200);
		expect(await json(await call())).toMatchObject({ status: "cancelled", writable: false });
	});
});

describe("drive-token entitlements", () => {
	it("expires a trial exactly at trialEndsAt, retaining read-only access without payment", async () => {
		const { w, s, org, call } = await fixture();
		expect(await tokenAccess(w, s.accessToken, org.drives[0].id)).toEqual({ status: 200, access: "write" });
		await w.env.DB.prepare("UPDATE orgs SET trial_ends_at = ? WHERE id = ?").bind(w.clock.t, org.id).run();
		expect(await tokenAccess(w, s.accessToken, org.drives[0].id)).toEqual({ status: 200, access: "read" });
		expect(await json(await call())).toMatchObject({ state: "expired", writable: false });
	});

	it("blocks over-quota writes across all org drives, allows reads/viewers, and restores writes after activation", async () => {
		const { w, s, org, activate } = await fixture();
		const id = org.drives[0].id;
		w.dp.stats.set(id, 1_000_000_000_000);
		expect(await tokenAccess(w, s.accessToken, id)).toMatchObject({ access: "write" });
		await w.env.DB.prepare("INSERT INTO drives(id,org_id,name,status,created_at) VALUES(?,?,?,'ready',?)").bind("d_second", org.id, "Second", w.clock.t).run();
		w.dp.stats.set("d_second", 1);
		expect(await tokenAccess(w, s.accessToken, id)).toEqual({ status: 403, error: "quota_exceeded" });
		expect(await tokenAccess(w, s.accessToken, id, "read")).toEqual({ status: 200, access: "read" });
		const viewer = await signIn(w, "view@example.com");
		await w.env.DB.prepare("INSERT INTO memberships VALUES(?,?,?,?)").bind(org.id, viewer.user.id, "viewer", w.clock.t).run();
		expect(await tokenAccess(w, viewer.accessToken, id)).toEqual({ status: 200, access: "read" });
		// Checkout needs a seat per member, so buy the add-on before the viewer joins in a real flow;
		// here we activate first-run checkout state, then deliver the subscription webhook.
		await w.env.DB.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").bind(org.id, viewer.user.id).run();
		expect((await activate({ addons: [{ addon_id: products.storage.monthly, quantity: 1 }] })).response.status).toBe(200);
		expect(await tokenAccess(w, s.accessToken, id)).toEqual({ status: 200, access: "write" });
	});

	it("fails closed on unavailable/invalid usage and still permits read-only tokens", async () => {
		const { w, s, org } = await fixture();
		w.dp.failStats = true;
		expect(await tokenAccess(w, s.accessToken, org.drives[0].id)).toEqual({ status: 503, error: "usage_unavailable" });
		expect(await tokenAccess(w, s.accessToken, org.drives[0].id, "read")).toEqual({ status: 200, access: "read" });
		w.dp.failStats = false;
		w.dp.stats.set(org.drives[0].id, -1);
		expect((await tokenAccess(w, s.accessToken, org.drives[0].id)).status).toBe(503);
	});
});
