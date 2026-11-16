// Development-only visual fixture. This does not authenticate or contact a real backend.
// Open /design-preview.html?view=files|empty|error|loading|account&theme=light|dark.
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import type { Drive } from "../src/api";
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
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  const path = url.pathname;
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (view === "loading") return new Promise<Response>(() => {});
  if (view === "error") return response({ error: "request_failed", message: "We couldn’t load your workspace. Check your connection and try again." }, 503);
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
const route = ["files", "folder-empty"].includes(view) ? "/drives/design/" : view === "account" ? "/settings" : "/";
createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={[route]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>,
);
