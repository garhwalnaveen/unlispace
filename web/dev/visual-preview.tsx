// Development-only visual fixture. This does not authenticate or contact a real backend.
// Open /design-preview.html?view=files|empty|error|loading|account&theme=light|dark.
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import type { Drive } from "../src/api";
import { filesFixture, filesRoute } from "./files-fixture";
import "../src/styles.css";

if (!import.meta.env.DEV) throw new Error("The design fixture is only available in development.");
const params = new URLSearchParams(location.search);
const view = params.get("view") || "drives";
localStorage.setItem("orbit.theme", params.get("theme") === "light" ? "light" : "dark");
const now = Date.UTC(2026, 10, 1, 10, 30);
const drives: Drive[] = [
  { id: "design", orgId: "studio", name: "Design studio", placement: "weur", status: "ready", createdAt: now, access: "admin" },
  { id: "projects", orgId: "studio", name: "Client projects", placement: "weur", status: "ready", createdAt: now, access: "admin" },
  { id: "archive", orgId: "studio", name: "Shared archive", placement: "weur", status: "ready", createdAt: now, access: "read" },
];
const user = { id: "preview-user", email: "alex@example.com" };
const quotaBytes = 1024 ** 4;
const usedBytes = 128 * 1024 ** 3;
const org = { id: "studio", name: "Studio workspace", role: "owner", tier: "teams", trialEndsAt: null, drives: view === "empty" ? [] : drives };
const entries = [
  { name: "Brand assets", type: "folder", size: 0 },
  { name: "Product explorations", type: "folder", size: 0 },
  { name: "Website", type: "folder", size: 0 },
  { name: "Orbit — design guidelines.pdf", type: "file", size: 3481600 },
  { name: "Launch checklist.md", type: "file", size: 4608 },
].map((entry, index) => ({ ...entry, versionId: `version-${index}`, mtimeMs: now - index * 3600000 }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// Settings and drive-management views: keys|keys-empty|members|members-plan|billing|billing-trial|billing-ended.
const settingsRoutes: Record<string, string> = { keys: "/settings/access-keys", "keys-empty": "/settings/access-keys", members: "/orgs/studio/team", "members-plan": "/orgs/studio/team", billing: "/orgs/studio/billing", "billing-trial": "/orgs/studio/billing", "billing-ended": "/orgs/studio/billing" };
function settingsFixture(path: string, init?: RequestInit): Response | null {
  if (!(view in settingsRoutes)) return null;
  const DAY = 86_400_000;
  const trial = view === "billing-trial", ended = view === "billing-ended", solo = trial || ended || view === "members-plan";
  const state = ended ? "expired" : trial ? "trial_active" : "paid";
  const trialEndsAt = ended ? Date.now() - DAY : trial ? Date.now() + 5 * DAY : null;
  const quota = solo ? 500e9 : 5e12, used = ended ? 212e9 : 128e9;
  const workspace = { ...org, tier: solo ? "individual" : "teams", trialEndsAt, drives: solo ? drives.slice(0, 1) : drives };
  if (path === "/orgs") return response({ orgs: [workspace] });
  if (path === "/me/access") return response({ user, workspaces: [{ ...workspace, state, trialPending: false, writable: !ended, storageReady: true, quotaBytes: quota, usedBytes: used }] });
  if (path === "/billing/catalog") return response({ plans: [{ id: "individual", name: "Individual", minSeats: 1, maxSeats: 1, bytesPerSeat: 500e9 }, { id: "teams", name: "Teams", minSeats: 1, maxSeats: 1000, bytesPerSeat: 1e12 }], storageAddon: { bytes: 500e9, maxQuantity: 1000 }, checkoutAvailable: true, trialDays: 7, checkoutStartsImmediately: true, checkoutEndsTrial: true, prices: { individual: { monthly: { amount: 1500, currency: "USD" }, annual: { amount: 15600, currency: "USD" } }, teams: { monthly: { amount: 2500, currency: "USD" }, annual: { amount: 26400, currency: "USD" } }, storage: { monthly: { amount: 1500, currency: "USD" }, annual: { amount: 15600, currency: "USD" } } } });
  if (path.endsWith("/billing/invoices")) return response({ invoices: solo ? [] : [{ paymentId: "pay_sample_2", createdAt: new Date(now).toISOString(), amount: 7500, currency: "USD", status: "succeeded" }, { paymentId: "pay_sample_1", createdAt: new Date(now - 30 * DAY).toISOString(), amount: 7500, currency: "USD", status: "succeeded" }], nextPage: null });
  if (path.endsWith("/billing")) return response({ orgId: "studio", plan: solo ? "individual" : "teams", status: solo ? "trialing" : "active", state, seats: solo ? 1 : 5, storageAddons: 0, trialEndsAt, quotaBytes: quota, usedBytes: used, writable: !ended, cadence: solo ? null : "monthly", currentPeriodEnd: solo ? null : Date.now() + 14 * DAY, cancelAtPeriodEnd: false });
  if (path.endsWith("/members")) return response({ name: org.name, role: "owner", canManage: true, seats: solo ? 1 : 5, teamAvailable: !solo, members: [{ userId: user.id, email: user.email, displayName: "Alex Morgan", role: "owner", createdAt: now }, ...(solo ? [] : [{ userId: "u2", email: "priya@example.com", displayName: "Priya Shah", role: "admin", createdAt: now }, { userId: "u3", email: "sam@example.com", displayName: null, role: "viewer", createdAt: now }])], invitations: solo ? [] : [{ id: "invite-1", email: "jordan@example.com", role: "member", expiresAt: Date.now() + 6 * DAY }] });
  const key = { accessKeyId: "ULS1SAMPLEKEYAAAAAAA", workspaceId: "studio", label: "Laptop backup", access: "write", drives: ["design", "projects"], parent: null, createdAt: now - 20 * DAY, lastUsedAt: now - 3_600_000, revokedAt: null };
  if (path === "/keys" && init?.method === "POST") return response({ ...key, accessKeyId: "ULS1SAMPLEKEYCCCCCCC", ...JSON.parse(String(init.body)), createdAt: Date.now(), lastUsedAt: null, secretAccessKey: "sample-secret-shown-once-not-a-real-key" }, 201);
  if (path === "/keys") return response({ keys: view === "keys" ? [key, { ...key, accessKeyId: "ULS1SAMPLEKEYBBBBBBB", label: "Reporting agent", access: "read", drives: null, createdAt: now - 2 * DAY, lastUsedAt: null }] : [] });
  return null;
}
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  const path = url.pathname;
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (view === "loading") return new Promise<Response>(() => {});
  if (view === "error") return response({ error: "request_failed", message: "We couldn’t load your workspace. Check your connection and try again." }, 503);
  const settings = settingsFixture(path, init);
  if (settings) return settings;
  const files = await filesFixture(view, url, init);
  if (files) return files;
  if (path === "/orgs") return response({ orgs: [org] });
  if (path === "/me/access") return response({ user, workspaces: [{ ...org, state: "paid", trialPending: false, writable: true, storageReady: true, quotaBytes, usedBytes }] });
  if (path === "/me") return response({ ...user, displayName: "Alex Morgan", createdAt: now });
  if (path.endsWith("/billing")) return response({ orgId: "studio", plan: "teams", status: "active", state: "paid", seats: 3, storageAddons: 0, trialEndsAt: null, quotaBytes, usedBytes, writable: true });
  if (path.endsWith("/token")) return response({ token: "local-preview-only", expiresAt: Date.now() + 3600000, endpoint: location.origin + "/fixture-data", driveId: "design" });
  if (path.endsWith("/list")) return response({ entries: view === "folder-empty" || url.searchParams.get("path") ? [] : entries, cursor: null });
  if (path.endsWith("/stat")) return response({ path: url.searchParams.get("path"), type: "file", versionId: "version-3", size: 3481600, contentType: "application/pdf", mtimeMs: now, seq: 1 });
  if (path.endsWith("/versions")) return response({ versions: [], cursor: null });
  if (/^\/drives\/[^/]+$/.test(path)) return response(drives.find((drive) => path.endsWith(drive.id)) || drives[0]);
  if (path === "/keys") return response({ keys: [] });
  // Fail closed: no fixture action is forwarded to a real API.
  return response({ error: "preview_only", message: `Sample-data preview: ${init?.method || "GET"} ${path} is not connected.` }, 501);
};
const auth = new AuthStore(localStorage, null);
auth.accept({ accessToken: "local-preview-only", refreshToken: "local-preview-only", expiresIn: 86400, user, accountCreated: false });
const route = filesRoute(view) ?? settingsRoutes[view] ?? (["files", "folder-empty"].includes(view) ? "/drives/design/" : view === "account" ? "/settings" : "/");
createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={[route]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>,
);
