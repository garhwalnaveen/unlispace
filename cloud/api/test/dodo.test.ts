import { describe, expect, it, vi } from "vitest";
import { selectDodo, verifyDodoWebhook, type CheckoutInput } from "../src/dodo";
import { makeWorld } from "./helpers";
import { readText } from "../src/http";

const input: CheckoutInput = { product_cart: [{ product_id: "p_test", quantity: 2, addons: [{ addon_id: "a_test", quantity: 1 }] }], customer: { customer_id: "cus_test" }, metadata: { org_id: "o_test", checkout_intent: "bc_test" }, return_url: "https://app.test/billing", subscription_data: { trial_period_days: 0 } };

describe("Dodo HTTP adapter (fake fetch only)", () => {
	it("uses documented checkout and portal paths, JSON and query shapes", async () => {
		const w = await makeWorld({ DODO_PAYMENTS_API_KEY: "test-only", DODO_PAYMENTS_ENVIRONMENT: "test_mode" });
		const fetcher = vi.fn<typeof fetch>(async (_url, _init) => Response.json({ checkout_url: "https://checkout.test/session" }));
		const client = selectDodo(w.env, fetcher);
		expect(await client.checkout(input)).toEqual({ url: "https://checkout.test/session" });
		const [url, init] = fetcher.mock.calls[0]!;
		expect(url).toBe("https://test.dodopayments.com/checkouts");
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual(input);
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only");
		expect(init?.redirect).toBe("error");
		fetcher.mockResolvedValueOnce(Response.json({ link: "https://portal.test/session" }));
		expect(await client.portal("cus/encoded", "https://app.test/billing")).toEqual({ url: "https://portal.test/session" });
		const portal = new URL(String(fetcher.mock.calls[1]![0]));
		expect(portal.pathname).toBe("/customers/cus%2Fencoded/customer-portal/session");
		expect(portal.searchParams.get("send_email")).toBe("false");
		expect(portal.searchParams.get("return_url")).toBe("https://app.test/billing");
	});

	it("filters invoices to the stored customer, normalizes payment records and reports pagination", async () => {
		const w = await makeWorld({ DODO_PAYMENTS_API_KEY: "test-only", DODO_PAYMENTS_ENVIRONMENT: "live_mode" });
		const payment = { payment_id: "pay_test", status: "succeeded", total_amount: 2400, currency: "USD", created_at: "2026-10-25T00:00:00Z", customer: { email: "never-return@example.com" } };
		const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: Array.from({ length: 100 }, () => payment) }));
		const client = selectDodo(w.env, fetcher);
		const result = await client.invoices("cus_test", 2);
		expect(result.nextPage).toBe(3);
		expect(result.invoices[0]).toEqual({ paymentId: "pay_test", status: "succeeded", amount: 2400, currency: "USD", createdAt: payment.created_at });
		const url = new URL(String(fetcher.mock.calls[0]![0]));
		expect(url.origin).toBe("https://live.dodopayments.com");
		expect(url.pathname).toBe("/payments");
		expect(Object.fromEntries(url.searchParams)).toEqual({ customer_id: "cus_test", page_number: "2", page_size: "100" });
		fetcher.mockResolvedValueOnce(Response.json({ items: [] }));
		expect(await client.invoices("cus_test", 3)).toEqual({ invoices: [], nextPage: null });
	});

	it("fails closed on missing/invalid environment, provider failures and unsafe checkout URLs", async () => {
		const w = await makeWorld();
		const fetcher = vi.fn<typeof fetch>(async () => new Response("provider error and sensitive details", { status: 400 }));
		const client = selectDodo(w.env, fetcher);
		await expect(client.checkout(input)).rejects.toMatchObject({ status: 503, code: "billing_not_configured" });
		expect(fetcher).not.toHaveBeenCalled();
		w.env.DODO_PAYMENTS_API_KEY = "test-only";
		w.env.DODO_PAYMENTS_ENVIRONMENT = "test_mode";
		await expect(client.checkout(input)).rejects.toMatchObject({ status: 502, code: "billing_unavailable" });
		for (const checkout_url of ["http://insecure.test", "javascript:alert(1)", null]) {
			fetcher.mockResolvedValueOnce(Response.json({ checkout_url }));
			await expect(client.checkout(input)).rejects.toMatchObject({ status: 502 });
		}
		fetcher.mockResolvedValueOnce(new Response("not JSON"));
		await expect(client.checkout(input)).rejects.toMatchObject({ status: 502 });
		fetcher.mockResolvedValueOnce(Response.json({ items: [{ payment_id: "bad" }] }));
		await expect(client.invoices("cus_test", 0)).rejects.toMatchObject({ status: 502 });
		fetcher.mockRejectedValueOnce(new Error("network unavailable"));
		await expect(client.checkout(input)).rejects.toMatchObject({ status: 502 });
	});
});

describe("webhook compatibility and bounded reading", () => {
	it("matches an independently calculated Standard Webhooks HMAC vector", async () => {
		const req = new Request("https://api.test/webhooks/dodo", { headers: { "webhook-id": "evt_vector", "webhook-timestamp": "1700000000", "webhook-signature": "v1,ZTWpFRBuE/RhmZy32VP0ZNE4ODa5HCeIyrZNbXEjiGQ=" } });
		expect(await verifyDodoWebhook(req, "{}", "whsec_dGVzdCBzZWNyZXQ=", 1700000000000)).toBe("evt_vector");
		await expect(verifyDodoWebhook(req, "{ }", "whsec_dGVzdCBzZWNyZXQ=", 1700000000000)).rejects.toMatchObject({ status: 401 });
	});

	it("limits bytes even without content-length and preserves multibyte sequences across chunks", async () => {
		const bytes = new TextEncoder().encode("é");
		const request = () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1)); c.close(); } }));
		expect(await readText(request(), 2)).toBe("é");
		await expect(readText(request(), 1)).rejects.toMatchObject({ status: 413 });
	});
});
