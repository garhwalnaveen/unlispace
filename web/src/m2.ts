import { API_URL, readResponse, type Api } from "./api";

export interface AccessKey {
  accessKeyId: string;
  workspaceId: string;
  label: string | null;
  access: "read" | "write" | "admin";
  drives: string[] | null;
  parent: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
export interface NewKey {
  workspaceId: string;
  label: string;
  access: AccessKey["access"];
  drives: string[] | null;
}
export interface KeySecret extends AccessKey { secretAccessKey: string }
export interface BillingCatalog {
  plans: { id: "individual" | "teams"; name: string; bytesPerSeat: number; minSeats: number; maxSeats: number }[];
  storageAddon: { bytes: number; maxQuantity: number };
  checkoutAvailable: boolean;
  trialDays: number;
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
  state: "paid" | "trial_active" | "expired";
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
// Kept together so the M2 contract can be reconciled without changing the screens.
export function m2(api: Api) {
  return {
    keys: () => api.request<{ keys: AccessKey[] }>("/keys"),
    createKey: (body: NewKey) => api.request<KeySecret>("/keys", post(body)),
    revokeKey: (id: string) => api.request<{ ok: true }>(`/keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
    billing: (id: string) => api.request<BillingSummary>(`/orgs/${encodeURIComponent(id)}/billing`),
    invoices: (id: string, page = 0) => api.request<{ invoices: Invoice[]; nextPage: number | null }>(`/orgs/${encodeURIComponent(id)}/billing/invoices?page=${page}`),
    checkout: (id: string, body: Checkout) => api.request<{ url: string }>(`/orgs/${encodeURIComponent(id)}/billing/checkout`, post(body)),
    portal: (id: string) => api.request<{ url: string }>(`/orgs/${encodeURIComponent(id)}/billing/portal`, post({})),
  };
}
function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
export async function billingCatalog(): Promise<BillingCatalog> {
  return readResponse(await fetch(`${API_URL}/billing/catalog`));
}
export function externalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("The server returned an invalid billing link.");
  return url.href;
}
