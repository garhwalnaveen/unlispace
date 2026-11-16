import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { drive, json, org, renderApp } from "./fixtures";
it("shows the trial, explains plan limits, and requires exact drive-name confirmation before deletion", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return json({ error: "plan_limit" }, 403);
    if (init?.method === "DELETE") return json({ ok: true });
    if (url.endsWith("/orgs")) return json({ orgs: [org] });
    throw new Error(`Unexpected call: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  renderApp();
  expect(await screen.findByText(/1 trial day remaining/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /New drive/ }));
  await user.type(screen.getByLabelText("Drive name"), "Another drive");
  await user.click(screen.getByRole("button", { name: "Save drive" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Individual plan includes one drive",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByText("Drive options"));
  await user.click(screen.getByRole("button", { name: "Delete Space" }));
  const deletion = screen.getByRole("button", { name: "Delete drive" });
  expect(deletion).toBeDisabled();
  await user.type(screen.getByLabelText("Type “Space” to confirm"), "space");
  expect(deletion).toBeDisabled();
  await user.clear(screen.getByLabelText("Type “Space” to confirm"));
  await user.type(screen.getByLabelText("Type “Space” to confirm"), "Space");
  await user.click(deletion);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(true),
  );
});
const aliasedOrg = { ...org, trialEndsAt: null, drives: [{ ...drive, alias: "space", usageBytes: 1024 }] };
const overQuota = { orgId: aliasedOrg.id, usedBytes: 2048, quotaBytes: 1024, plan: "individual", status: "active", state: "paid", writable: false, seats: 1, storageAddons: 0, trialEndsAt: null };
it("forks with name and alias and shows lineage, fork point, usage and quota on home", async () => {
  let forked = false;
  const child = { ...drive, id: "d-child", name: "Branch", alias: "branch", usageBytes: 0, forkOf: { driveId: drive.id, forkPoint: 1000 }, forks: [] };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/billing")) return json(overQuota);
    if (url.endsWith("/fork")) { expect(JSON.parse(String(init?.body))).toEqual({ name: "Branch", alias: "branch" }); forked = true; return json(child, 201); }
    return json({ orgs: [{ ...aliasedOrg, drives: forked ? [{ ...aliasedOrg.drives[0], forks: [child.id] }, child] : aliasedOrg.drives }] });
  });
  vi.stubGlobal("fetch", fetcher); renderApp(); const user = userEvent.setup();
  expect(await screen.findByText(/Last measured drive bytes: 1 KiB/)).toBeInTheDocument();
  expect(await screen.findByText(/Deleting a file keeps its history/)).toBeInTheDocument();
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
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/billing")) return json(overQuota);
    if (init?.method === "PATCH") { expect(JSON.parse(String(init.body)).alias).toBe("taken"); return json({ error: "alias_taken" }, 409); }
    if (init?.method === "DELETE") { expect(url).toMatch(/\/drives\/d-test\?hard=1$/); return json({ error: "drive_has_forks" }, 409); }
    return json({ orgs: [aliasedOrg] });
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
it("edits a drive alias from its page and hard-deletes successfully", async () => {
  let alias = "space"; let deleted = false;
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
