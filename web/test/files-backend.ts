import { vi } from "vitest";
import type { Drive, Entry, Workspace } from "../src/api";
import { drive as baseDrive, json, org } from "./fixtures";

export const HEAD = "v_HEAD";
export const file = (name: string, size = 3, mtimeMs = 1000, versionId = `v_${name}`): Entry => ({ name, type: "file", size, mtimeMs, versionId });
export const folder = (name: string, versionId = `v_${name}`): Entry => ({ name, type: "folder", size: 0, mtimeMs: 1000, versionId });
export const missing = () => json({ error: "no_such_path" }, 404);
type Data = (route: string, url: URL, init: RequestInit | undefined, body: any) => Response | undefined | Promise<Response | undefined>;

/**
 * Stubs fetch with a signed-in workspace, one drive and a data plane. `folders` maps a folder path to its
 * entries; `data` answers data-plane routes first and may return undefined to fall through to the defaults.
 */
export function backend({ drive = {}, workspace = {}, folders = { "": [] }, data }: {
  drive?: Partial<Drive>; workspace?: Partial<Workspace>; folders?: Record<string, Entry[]>; data?: Data;
} = {}) {
  const current = { ...baseDrive, ...drive };
  const requests: { route: string; url: URL; method: string; body: any; headers: Headers }[] = [];
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.origin === "https://data.example") {
      const route = url.pathname.replace(`/v0/drives/${current.id}/`, "");
      requests.push({ route, url, method: init?.method ?? "GET", body, headers: new Headers(init?.headers) });
      const custom = await data?.(route, url, init, body);
      if (custom) return custom;
      const path = url.searchParams.get("path") ?? "";
      if (route === "list") return path in folders ? json({ entries: folders[path], cursor: null }) : missing();
      if (route === "stat") {
        const parent = path.slice(0, path.replace(/\/$/, "").lastIndexOf("/") + 1);
        const found = folders[parent]?.find((entry) => entry.name === path.slice(parent.length).replace(/\/$/, ""));
        return found ? json({ path: found.type === "folder" ? `${path.replace(/\/$/, "")}/` : path, type: found.type, versionId: found.versionId, size: found.size, contentType: "text/plain", mtimeMs: found.mtimeMs, seq: 1 }) : missing();
      }
      if (route === "versions") return json({ versions: [], cursor: null });
      if (route === "shards/missing") return json({ missing: [] });
      if (route === "commit" || route === "restore") return json({ seq: 2, results: [] });
      return json({ error: "not_stubbed" }, 500);
    }
    if (url.pathname === "/orgs") return json({ orgs: [{ ...org, drives: [current] }] });
    if (url.pathname === "/me/access")
      return json({ user: { id: "u_test", email: "you@example.com" }, workspaces: [{ id: org.id, name: org.name, role: "owner", tier: "individual", state: "trial_active", trialPending: false, trialEndsAt: null, writable: true, storageReady: true, quotaBytes: 1e12, usedBytes: 0, ...workspace }] });
    if (url.pathname === `/drives/${current.id}/token`)
      return json({ token: `drive-${body.access}`, expiresAt: Date.now() + 900_000, endpoint: "https://data.example", driveId: current.id });
    if (url.pathname === `/drives/${current.id}`) return json(current);
    return json({ error: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, requests, sent: (route: string) => requests.filter((request) => request.route === route) };
}
