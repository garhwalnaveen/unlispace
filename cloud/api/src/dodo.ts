import type { AppEnv } from "./env";
import { HttpError, readText } from "./http";
import { timingSafeEqual } from "./util";

export interface CheckoutInput {
	product_cart: { product_id: string; quantity: number; addons?: { addon_id: string; quantity: number }[] }[];
	customer: { customer_id: string } | { email: string; name: string };
	metadata: { org_id: string; checkout_intent: string };
	return_url: string;
	subscription_data: { trial_period_days: number };
}

export interface Invoice {
	paymentId: string;
	status: string;
	amount: number;
	currency: string;
	createdAt: string;
}

/** All outbound Dodo operations are injected at this boundary in tests. */
export interface DodoPayments {
	checkout(input: CheckoutInput): Promise<{ url: string }>;
	portal(customerId: string, returnUrl: string): Promise<{ url: string }>;
	invoices(customerId: string, page: number): Promise<{ invoices: Invoice[]; nextPage: number | null }>;
}

export function selectDodo(env: AppEnv, fetcher: typeof fetch): DodoPayments {
	const request = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
		if (!env.DODO_PAYMENTS_API_KEY || !["test_mode", "live_mode"].includes(env.DODO_PAYMENTS_ENVIRONMENT ?? "")) throw new HttpError(503, "billing_not_configured");
		const origin = env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
		try {
			const res = await fetcher(origin + path, {
				method: body === undefined ? "GET" : "POST",
				headers: { authorization: `Bearer ${env.DODO_PAYMENTS_API_KEY}`, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(10_000),
				redirect: "error",
			});
			if (!res.ok) {
				await res.body?.cancel();
				throw new Error("provider rejected request");
			}
			const data: unknown = JSON.parse(await readText(res, 1024 * 1024));
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid response");
			return data as Record<string, unknown>;
		} catch {
			// Provider bodies can contain payment details. Never log or forward them.
			throw new HttpError(502, "billing_unavailable");
		}
	};
	const url = (v: unknown): string => {
		if (typeof v !== "string") throw new HttpError(502, "billing_unavailable");
		try { if (new URL(v).protocol === "https:") return v; } catch { /* invalid URL */ }
		throw new HttpError(502, "billing_unavailable");
	};
	return {
		async checkout(input) { return { url: url((await request("/checkouts", input)).checkout_url) }; },
		async portal(customerId, returnUrl) {
			const query = new URLSearchParams({ send_email: "false", return_url: returnUrl });
			return { url: url((await request(`/customers/${encodeURIComponent(customerId)}/customer-portal/session?${query}`, {})).link) };
		},
		async invoices(customerId, page) {
			const query = new URLSearchParams({ customer_id: customerId, page_number: String(page), page_size: "100" });
			const result = await request(`/payments?${query}`);
			if (!Array.isArray(result.items)) throw new HttpError(502, "billing_unavailable");
			const invoices = result.items.map((p: Record<string, unknown>): Invoice => {
				if (typeof p.payment_id !== "string" || typeof p.status !== "string" || !Number.isSafeInteger(p.total_amount) || typeof p.currency !== "string" || typeof p.created_at !== "string") throw new HttpError(502, "billing_unavailable");
				return { paymentId: p.payment_id, status: p.status, amount: p.total_amount as number, currency: p.currency, createdAt: p.created_at };
			});
			return { invoices, nextPage: invoices.length === 100 ? page + 1 : null };
		},
	};
}

/** Dodo follows Standard Webhooks: HMAC-SHA256(id.timestamp.rawBody), base64. */
export async function verifyDodoWebhook(req: Request, raw: string, secret: string | undefined, now: number): Promise<string> {
	if (!secret) throw new HttpError(503, "billing_not_configured");
	const id = req.headers.get("webhook-id");
	const timestamp = req.headers.get("webhook-timestamp") ?? "";
	const signatures = req.headers.get("webhook-signature") ?? "";
	const invalid = new HttpError(401, "invalid_webhook_signature");
	if (!id || id.length > 256 || !/^\d+$/.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) throw invalid;
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), c => c.charCodeAt(0));
		if (!bytes.length) throw new Error("empty key");
	} catch { throw new HttpError(503, "billing_not_configured"); }
	const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`));
	const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
	if (!signatures.split(" ").some(s => s.startsWith("v1,") && timingSafeEqual(s.slice(3), expected))) throw invalid;
	return id;
}
