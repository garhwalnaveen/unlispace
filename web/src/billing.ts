import { publicGet } from "./api";

export interface Price { amount: number; currency: string }
export interface BillingCatalog {
  plans: { id: "individual" | "teams"; name: string; bytesPerSeat: number; minSeats: number; maxSeats: number }[];
  storageAddon: { bytes: number; maxQuantity: number };
  checkoutAvailable: boolean;
  /** Minor currency units per product, present only when the operator configured them. */
  prices?: Record<"individual" | "teams" | "storage", Record<"monthly" | "annual", Price>> | null;
  trialDays: number;
  checkoutStartsImmediately?: boolean;
  checkoutEndsTrial?: boolean;
}
export interface BillingSummary {
  orgId: string;
  plan: "individual" | "teams";
  status: string;
  trialEndsAt: number | null;
  seats: number;
  storageAddons: number;
  quotaBytes: number;
  writable: boolean;
  state: "paid" | "trial_active" | "provisioning" | "expired";
  trialPending?: boolean;
  usedBytes: number;
}
export interface Invoice {
  paymentId: string;
  createdAt: string;
  amount: number;
  currency: string;
  status: string;
}
export interface Checkout {
  plan: "individual" | "teams";
  cadence: "monthly" | "annual";
  seats: number;
  storageAddons: number;
}
export const billingCatalog = () => publicGet<BillingCatalog>("/billing/catalog");
export function externalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("The server returned an invalid billing link.");
  return url.href;
}
