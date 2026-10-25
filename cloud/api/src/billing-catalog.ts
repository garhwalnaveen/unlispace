import type { AppEnv } from "./env";
import { HttpError } from "./http";

export type Plan = "individual" | "teams";
export type Cadence = "monthly" | "annual";
export type BillingProducts = Record<Plan | "storage", Record<Cadence, string>>;
export const TB = 1_000_000_000_000;
export const STORAGE_ADDON_BYTES = 500_000_000_000;

export function products(env: AppEnv): BillingProducts | null {
	if (!env.DODO_PRODUCTS) return null;
	try {
		const p = JSON.parse(env.DODO_PRODUCTS) as BillingProducts;
		for (const name of ["individual", "teams", "storage"] as const) {
			for (const cadence of ["monthly", "annual"] as const) {
				if (typeof p[name]?.[cadence] !== "string" || !p[name][cadence].length) throw new Error("missing product");
			}
		}
		if (new Set([p.individual.monthly, p.individual.annual, p.teams.monthly, p.teams.annual]).size !== 4) throw new Error("duplicate seat products");
		return p;
	} catch { throw new HttpError(503, "billing_not_configured"); }
}

export function catalog(env: AppEnv) {
	const p = products(env);
	return {
		provider: "dodo", trialDays: 7, trialRequiresCard: false,
		plans: [
			{ id: "individual", name: "Individual", minSeats: 1, maxSeats: 1, bytesPerSeat: TB },
			{ id: "teams", name: "Teams", minSeats: 1, maxSeats: 1000, bytesPerSeat: TB },
		],
		storageAddon: { bytes: STORAGE_ADDON_BYTES, maxQuantity: 1000 },
		cadences: ["monthly", "annual"],
		// Prices are intentionally decided by configured Dodo products, not copied from Space.
		checkoutAvailable: p !== null && !!env.DODO_PAYMENTS_API_KEY && ["test_mode", "live_mode"].includes(env.DODO_PAYMENTS_ENVIRONMENT ?? ""),
	};
}

export function seatProduct(p: BillingProducts, id: unknown): { plan: Plan; cadence: Cadence } | null {
	for (const plan of ["individual", "teams"] as const) for (const cadence of ["monthly", "annual"] as const) if (p[plan][cadence] === id) return { plan, cadence };
	return null;
}
