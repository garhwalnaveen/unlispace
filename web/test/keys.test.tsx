import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { drive, json, org, renderApp } from "./fixtures";
const key = { accessKeyId: "ULS1ABCDEFGHIJKLMNOP", workspaceId: org.id, label: "Backup", access: "write", drives: [drive.id], parent: null, createdAt: 1, lastUsedAt: null, revokedAt: null };
it("creates a scoped key, reveals and copies its secret once, then confirms revocation", async () => {
  let created = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/orgs")) return json({ orgs: [org] });
    if (init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({ workspaceId: org.id, label: "Backup", access: "write", drives: [drive.id] });
      created = true; return json({ ...key, secretAccessKey: "one-time-secret" }, 201);
    }
    if (init?.method === "DELETE") { expect(url).toContain(key.accessKeyId); return json({ ok: true }); }
    return json({ keys: created ? [key] : [] });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  renderApp("/settings/access-keys");
  await screen.findByText("No access keys yet.");
  await user.selectOptions(screen.getByLabelText("Workspace"), org.id);
  fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Backup" } });
  await user.selectOptions(screen.getByLabelText("Access level"), "write");
  expect(screen.getByRole("button", { name: "Create access key" })).toBeDisabled();
  await user.click(screen.getByLabelText("Space"));
  await user.click(screen.getByRole("button", { name: "Create access key" }));
  expect(await screen.findByText("one-time-secret")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create access key" })).toBeDisabled();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await user.click(screen.getByRole("button", { name: "Copy as env vars" }));
  expect(copy).toHaveBeenCalledWith(`export AWS_ACCESS_KEY_ID='${key.accessKeyId}'\nexport AWS_SECRET_ACCESS_KEY='one-time-secret'`);
  await user.click(screen.getByRole("button", { name: "I saved it — close" }));
  expect(screen.queryByText("one-time-secret")).not.toBeInTheDocument();
  expect(localStorage.getItem("orbit.refreshToken")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Revoke Backup" }));
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
});
it("shows key errors and allows selecting all accessible drives", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/orgs")) return json({ orgs: [org] });
    if (init?.method === "POST") { expect(JSON.parse(String(init.body)).drives).toBeNull(); return json({ error: "keys_not_configured" }, 503); }
    return json({ keys: [] });
  }));
  renderApp("/settings/access-keys");
  const user = userEvent.setup();
  await screen.findByText("No access keys yet.");
  await user.selectOptions(screen.getByLabelText("Workspace"), org.id);
  fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Tools" } });
  await user.click(screen.getByLabelText(/All accessible drives, including future drives/));
  await user.click(screen.getByRole("button", { name: "Create access key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Access keys are not configured");
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
