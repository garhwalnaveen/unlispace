import { File } from "node:buffer";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import { externalUrl, m2 } from "../src/m2";
import { drive, json, session } from "./fixtures";
const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));
const org = { id: "o_test", name: "My Space", role: "owner", tier: "individual", trialEndsAt: Date.now() + 86_400_000, drives: [drive] };
const key = { accessKeyId: "ULS1ABCDEFGHIJKLMNOP", workspaceId: org.id, label: "Backup", access: "write", drives: [drive.id], parent: null, createdAt: 1, lastUsedAt: null, revokedAt: null };
function renderApp(path: string) {
  const auth = new AuthStore(localStorage, null);
  stores.push(auth); auth.accept(session);
  render(<MemoryRouter initialEntries={[path]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>);
  return auth;
}
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
  await user.selectOptions(screen.getByLabelText("Organization"), org.id);
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
  expect(localStorage.getItem("unlispace.refreshToken")).toBeNull();
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
  await user.selectOptions(screen.getByLabelText("Organization"), org.id);
  fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Tools" } });
  await user.click(screen.getByLabelText(/All accessible drives, including future drives/));
  await user.click(screen.getByRole("button", { name: "Create access key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Access keys are not configured");
});
const catalog = { plans: [{ id: "individual", name: "Individual", bytesPerSeat: 1e12, minSeats: 1, maxSeats: 1 }, { id: "teams", name: "Teams", bytesPerSeat: 1e12, minSeats: 2, maxSeats: 1000 }], storageAddon: { bytes: 500e9, maxQuantity: 1000 }, checkoutAvailable: true, trialDays: 7 };
it("shows trial, invoices and sends checkout selections without losing errors", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/orgs")) return json({ orgs: [org] });
    if (url.endsWith("/catalog")) return json(catalog);
    if (url.includes("/invoices?")) return json({ invoices: [{ paymentId: "inv_1", createdAt: "2026-10-01T10:00:00Z", amount: 2000, currency: "USD", status: "paid" }], nextPage: null });
    if (init?.method === "POST") return json({ error: "billing_not_configured" }, 503);
    return json({ orgId: org.id, plan: "individual", state: "trial_active", writable: true, status: "trialing", trialEndsAt: Date.now() + 86_400_000, seats: 1, storageAddons: 0, quotaBytes: 1e12, usedBytes: 1000 });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup(); renderApp(`/orgs/${org.id}/billing`);
  expect(await screen.findByText(/1 trial day remaining/)).toBeInTheDocument();
  expect(await screen.findByText("inv_1")).toBeInTheDocument();
  await user.selectOptions(await screen.findByLabelText("Plan"), "teams");
  await user.selectOptions(screen.getByLabelText("Billing period"), "annual");
  fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText(/Extra storage/), { target: { value: "2" } });
  await user.click(screen.getByRole("button", { name: "Continue to checkout" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Billing is not configured");
  const checkout = fetcher.mock.calls.find(([url]) => url.endsWith("/checkout"));
  expect(JSON.parse(String(checkout?.[1]?.body))).toEqual({ plan: "teams", cadence: "annual", seats: 3, storageAddons: 2 });
  await user.click(screen.getByRole("button", { name: "Manage subscription" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url.endsWith("/portal") && init?.method === "POST")).toBe(true));
});
it("reads checkout and portal URLs and rejects unsafe external links", async () => {
  const auth = new AuthStore(localStorage, null); stores.push(auth); auth.accept(session);
  vi.stubGlobal("fetch", vi.fn(async () => json({ url: "https://checkout.example/session" })));
  const billing = m2(auth.api);
  expect(await billing.checkout(org.id, { plan: "individual", cadence: "monthly", seats: 1, storageAddons: 0 })).toEqual({ url: "https://checkout.example/session" });
  expect(await billing.portal(org.id)).toEqual({ url: "https://checkout.example/session" });
  for (const value of ["javascript:alert(1)", "data:text/html,hi", "http://billing.example", "https://user:pass@example.com"])
    expect(() => externalUrl(value)).toThrow("invalid billing link");
});
it("accepts a file drop, refreshes the list on commit and explains 412 conflicts", async () => {
  let conflict = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/token")) return json({ token: "drive", endpoint: "https://data.example", expiresAt: Date.now() + 900_000, driveId: drive.id });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    if (url.includes("/stat?")) return json({ error: "no_such_path" }, 404);
    if (url.endsWith("/missing")) return json({ missing: [] });
    if (url.endsWith("/commit")) { expect(JSON.parse(String(init?.body)).ops[0].ifAbsent).toBe(true); return conflict ? json({ error: "precondition_failed" }, 412) : json({ seq: 1 }); }
    return json(drive);
  });
  vi.stubGlobal("fetch", fetcher); renderApp(`/drives/${drive.id}/`);
  const area = await screen.findByRole("region", { name: "File upload and folder contents" });
  const file = new File(["hello"], "note.txt");
  fireEvent.drop(area, { dataTransfer: { files: [file] } });
  expect(await screen.findByText("Uploaded 1 file.")).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.includes("/list?"))).toHaveLength(2);
  conflict = true;
  fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [file] } });
  expect(await screen.findByRole("alert")).toHaveTextContent("This file changed while you were uploading");
});
it("hides upload controls from read-only drive members", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/token")) return json({ token: "read", endpoint: "https://data.example", expiresAt: Date.now() + 900_000 });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    return json({ ...drive, access: "read" });
  }));
  renderApp(`/drives/${drive.id}/`);
  await screen.findByText("This folder is empty.");
  expect(screen.queryByLabelText("Choose files to upload")).not.toBeInTheDocument();
});
