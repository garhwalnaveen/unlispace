import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import { drive, json, session } from "./fixtures";
const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));
const org = { id: drive.orgId, name: "My Space", role: "owner", tier: "individual", trialEndsAt: null, drives: [{ ...drive, alias: "space", usageBytes: 1024 }] };
const billing = { orgId: org.id, usedBytes: 2048, quotaBytes: 1024, plan: "individual", status: "active", state: "paid", writable: false, seats: 1, storageAddons: 0, trialEndsAt: null };
function renderApp(path = "/") {
  const auth = new AuthStore(localStorage, null); stores.push(auth); auth.accept(session);
  render(<MemoryRouter initialEntries={[path]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>);
}
function dialogs() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
}
it("forks with name and alias and shows lineage, fork point, usage and quota on home", async () => {
  dialogs(); let forked = false;
  const child = { ...drive, id: "d-child", name: "Branch", alias: "branch", usageBytes: 0, forkOf: { driveId: drive.id, forkPoint: 1000 }, forks: [] };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/billing")) return json(billing);
    if (url.endsWith("/fork")) { expect(JSON.parse(String(init?.body))).toEqual({ name: "Branch", alias: "branch" }); forked = true; return json(child, 201); }
    return json({ orgs: [{ ...org, drives: forked ? [{ ...org.drives[0], forks: [child.id] }, child] : org.drives }] });
  });
  vi.stubGlobal("fetch", fetcher); renderApp(); const user = userEvent.setup();
  expect(await screen.findByText(/Usage: 1 KiB/)).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("Writes are paused");
  expect(screen.getByRole("meter", { name: "Organization storage usage" })).toHaveAttribute("value", "1024");
  await user.click(screen.getByText("Drive options"));
  await user.click(screen.getByRole("button", { name: "Fork Space" }));
  await user.type(screen.getByLabelText("Drive name"), "Branch");
  await user.type(screen.getByLabelText("Drive alias"), "branch");
  await user.click(screen.getByRole("button", { name: "Fork drive" }));
  const branch = (await screen.findByRole("heading", { name: "Branch" })).closest("article")!;
  expect(screen.getByText(/Fork point:/)).toHaveTextContent("1970");
  await user.click(within(branch).getByText("Lineage"));
  expect(within(branch).getByRole("link", { name: drive.id })).toHaveAttribute("href", `/drives/${drive.id}/`);
  expect(within(branch).getByText(/Forked from/)).toHaveTextContent("1970");
});
it("keeps alias conflicts editable and protects hard delete with typed confirmation and fork errors", async () => {
  dialogs();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/billing")) return json(billing);
    if (init?.method === "PATCH") { expect(JSON.parse(String(init.body)).alias).toBe("taken"); return json({ error: "alias_taken" }, 409); }
    if (init?.method === "DELETE") { expect(url).toMatch(/\/drives\/d-test\?hard=1$/); return json({ error: "drive_has_forks" }, 409); }
    return json({ orgs: [org] });
  });
  vi.stubGlobal("fetch", fetcher); renderApp(); const user = userEvent.setup();
  await user.click(await screen.findByText("Drive options"));
  await user.click(screen.getByRole("button", { name: "Rename Space" }));
  await user.clear(screen.getByLabelText("Drive alias")); await user.type(screen.getByLabelText("Drive alias"), "taken");
  await user.click(screen.getByRole("button", { name: "Save drive" }));
  expect(await screen.findByText(/That alias is already in use/)).toBeInTheDocument();
  expect(screen.getByLabelText("Drive alias")).toHaveValue("taken");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Permanently delete Space" }));
  const confirm = screen.getByRole("button", { name: "Permanently delete drive" });
  expect(confirm).toBeDisabled();
  await user.type(screen.getByLabelText("Type “Space” to confirm"), "space"); expect(confirm).toBeDisabled();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  await user.clear(screen.getByLabelText("Type “Space” to confirm")); await user.type(screen.getByLabelText("Type “Space” to confirm"), "Space");
  await user.click(confirm);
  expect(await screen.findByText(/This drive has live forks/)).toBeInTheDocument();
});
it("shows billing's over-quota meter and banner", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/orgs")) return json({ orgs: [{ ...org, role: "viewer" }] });
    if (url.endsWith("/catalog")) return json({ plans: [], storageAddon: { bytes: 1, maxQuantity: 0 } });
    return json(billing);
  }));
  renderApp(`/orgs/${org.id}/billing`);
  expect(await screen.findByRole("alert")).toHaveTextContent("Writes are paused");
  expect(screen.getByRole("meter")).toBeInTheDocument();
});
it("nests child and grandchild keys and explains descendant revocation", async () => {
  const base = { workspaceId: org.id, access: "read", drives: null, createdAt: 1, lastUsedAt: null, revokedAt: null };
  let revoked = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/orgs")) return json({ orgs: [org] });
    if (init?.method === "DELETE") { expect(url).toMatch(/\/keys\/parent$/); revoked = true; return json({ ok: true }); }
    return json({ keys: [ { ...base, accessKeyId: "grandchild", label: "Grandchild", parent: "child" }, { ...base, accessKeyId: "child", label: "Child", parent: "parent" }, { ...base, accessKeyId: "parent", label: "Parent", parent: null } ].map((key) => ({ ...key, revokedAt: revoked ? 2000 : null })) });
  });
  vi.stubGlobal("fetch", fetcher); renderApp("/settings/access-keys"); const user = userEvent.setup();
  const parent = (await screen.findByRole("heading", { name: "Parent" })).closest("li")!;
  const child = within(parent).getByRole("heading", { name: "Child" }).closest("li")!;
  expect(within(child).getByRole("heading", { name: "Grandchild" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Revoke Parent" }));
  expect(screen.getByText(/all its descendants/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke Child" })).not.toBeInTheDocument());
});
const versions = [
  { versionId: "v1", ts: new Date("2026-10-01T10:00:00").getTime(), seq: 1, op: "put", size: 3, actor: null },
  { versionId: "v2", ts: new Date("2026-10-02T10:00:00").getTime(), seq: 2, op: "put", size: 4, actor: null },
  { versionId: "v3", ts: new Date("2026-10-03T10:00:00").getTime(), seq: 3, op: "delete", size: 0, actor: null },
];
it("picks the actual head as of time across pages, downloads it and restores through a guarded confirmation", async () => {
  dialogs(); let restored = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/token")) return json({ token: "token", expiresAt: Date.now() + 900000, endpoint: "https://data.example", driveId: drive.id });
    if (url.includes("/versions?")) return json(new URL(url).searchParams.has("cursor") ? { versions: versions.slice(1), cursor: null } : { versions: versions.slice(0, 1), cursor: "next" });
    if (url.includes("/stat?")) return json({ path: "note.txt", type: "file", versionId: restored ? "v_restored" : "v_head", size: 3, mtimeMs: 1000, seq: 4 });
    if (url.includes("/manifest?")) { expect(new URL(url).searchParams.get("versionId")).toBe("v2"); return json({ path: "note.txt", versionId: "v2", size: 0, shards: [] }); }
    if (url.endsWith("/restore")) { expect(JSON.parse(String(init?.body))).toEqual({ path: "note.txt", versionId: "v2", ifVersion: "v_head" }); restored = true; return json({ seq: 5 }); }
    return json(drive);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  renderApp(`/drives/${drive.id}/note.txt?panel=versions`); const user = userEvent.setup();
  await screen.findByText("v1");
  const date = screen.getByLabelText("View as of…");
  fireEvent.change(date, { target: { value: "2026-10-02T12:00" } });
  expect(screen.getByRole("button", { name: "View as of" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Load more versions" })); await screen.findByText("v3");
  await user.click(screen.getByRole("button", { name: "View as of" }));
  expect(within(screen.getByRole("region", { name: "Version as of selected time" })).getByText("v2")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Download selected version" }));
  await screen.findByText(/Your file is ready/);
  await user.click(screen.getByRole("button", { name: "Restore selected version" }));
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/restore"))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Confirm restore" }));
  expect(await screen.findByText("Version restored as the new head.")).toBeInTheDocument();
  expect(await screen.findByText("v_restored")).toBeInTheDocument();
  fireEvent.change(date, { target: { value: "2026-10-03T12:00" } });
  // Reloaded history must be fully read again after restoring.
  await screen.findByRole("button", { name: "Load more versions" });
  await user.click(screen.getByRole("button", { name: "Load more versions" }));
  await user.click(screen.getByRole("button", { name: "View as of" }));
  expect(await screen.findByText("This file was deleted at that time.")).toBeInTheDocument();
  fireEvent.change(date, { target: { value: "2026-09-01T12:00" } });
  await user.click(screen.getByRole("button", { name: "View as of" }));
  expect(await screen.findByText("This file did not exist at that time.")).toBeInTheDocument();
});
it("edits a drive alias from its page and hard-deletes successfully", async () => {
  dialogs(); let alias = "space"; let deleted = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/token")) return json({ token: "read", expiresAt: Date.now() + 900000, endpoint: "https://data.example", driveId: drive.id });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    if (init?.method === "PATCH") { alias = JSON.parse(String(init.body)).alias; }
    if (init?.method === "DELETE") { expect(url).toMatch(/\?hard=1$/); deleted = true; return json({ ok: true }); }
    return json({ ...drive, alias, status: deleted ? "deleted" : "ready", usageBytes: 1024, forks: [] });
  });
  vi.stubGlobal("fetch", fetcher); renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await user.click(await screen.findByText("Drive options"));
  await user.click(screen.getByRole("button", { name: "Rename Space" }));
  expect(screen.getByLabelText("Drive name")).toHaveFocus();
  await user.clear(screen.getByLabelText("Drive alias")); await user.type(screen.getByLabelText("Drive alias"), "new-alias");
  await user.click(screen.getByRole("button", { name: "Save drive" }));
  expect(await screen.findByText("new-alias")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Permanently delete Space" }));
  await user.type(screen.getByLabelText("Type “Space” to confirm"), "Space");
  await user.click(screen.getByRole("button", { name: "Permanently delete drive" }));
  expect(await screen.findByRole("heading", { name: "Drive unavailable" })).toBeInTheDocument();
});
it("keeps failed restores in the confirmation", async () => {
  dialogs();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/token")) return json({ token: "token", expiresAt: Date.now() + 900000, endpoint: "https://data.example", driveId: drive.id });
    if (url.includes("/versions?")) return json({ versions: versions.slice(0, 1), cursor: null });
    if (url.includes("/stat?")) return json({ path: "note.txt", type: "file", versionId: "head", size: 3, mtimeMs: 1000, seq: 4 });
    if (url.endsWith("/restore")) { expect(JSON.parse(String(init?.body)).ifVersion).toBe("head"); return json({ error: "precondition_failed" }, 412); }
    return json(drive);
  });
  vi.stubGlobal("fetch", fetcher); renderApp(`/drives/${drive.id}/note.txt?panel=versions`); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Restore version v1" }));
  await user.click(screen.getByRole("button", { name: "Confirm restore" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Your change was not committed");
  expect(screen.getByRole("dialog", { name: "Restore version" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
});
it("keeps history readable without restore or drive management controls for read-only members", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/token")) return json({ token: "read", expiresAt: Date.now() + 900000, endpoint: "https://data.example", driveId: drive.id });
    if (url.includes("/versions?")) return json({ versions: versions.slice(0, 1), cursor: null });
    if (url.includes("/stat?")) return json({ path: "note.txt", type: "file", versionId: "head", size: 3, mtimeMs: 1000, seq: 4 });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    return json({ ...drive, access: "read" });
  }));
  renderApp(`/drives/${drive.id}/note.txt?panel=versions`);
  await screen.findByText("v1");
  expect(screen.queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: "Space" }));
  await screen.findByText("Alias:", { exact: false });
  expect(screen.queryByRole("button", { name: /Fork Space|Rename Space|Delete Space|Permanently delete Space/ })).not.toBeInTheDocument();
});
