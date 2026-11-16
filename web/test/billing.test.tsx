import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { externalUrl } from "../src/billing-data";
import { authStore, catalog, drive, json, org, renderApp } from "./fixtures";
it("shows trial, invoices and sends checkout selections without losing errors", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/orgs")) return json({ orgs: [org] });
    if (url.endsWith("/catalog")) return json(catalog);
    if (url.includes("/invoices?")) return json({ invoices: [{ paymentId: "inv_1", createdAt: "2026-10-01T10:00:00Z", amount: 2000, currency: "USD", status: "paid" }], nextPage: null });
    if (init?.method === "POST") return json({ error: "billing_not_configured" }, 503);
    return json({ orgId: org.id, plan: "individual", state: "trial_active", writable: true, status: "trialing", trialEndsAt: Date.now() + 86_400_000, seats: 1, storageAddons: 0, quotaBytes: 500e9, usedBytes: 1000 });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup(); renderApp(`/orgs/${org.id}/billing`);
  expect(await screen.findByText(/1 trial day remaining/)).toBeInTheDocument();
  expect(await screen.findByText("inv_1")).toBeInTheDocument();
  expect(screen.getByRole("table")).toHaveTextContent("inv_1");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "Choose a plan" }));
  expect(screen.getByLabelText("Billing period")).toHaveValue("monthly");
  expect(screen.getByLabelText("Checkout summary")).toHaveTextContent("ends any remaining free trial");
  expect(screen.getByLabelText("Checkout summary")).toHaveTextContent("amount due today");
  await user.selectOptions(await screen.findByLabelText("Plan"), "teams");
  await user.selectOptions(screen.getByLabelText("Billing period"), "annual");
  fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText(/Extra storage/), { target: { value: "2" } });
  await user.click(screen.getByRole("button", { name: "Review annual checkout" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Billing is not configured");
  const checkout = fetcher.mock.calls.find(([url]) => url.endsWith("/checkout"));
  expect(JSON.parse(String(checkout?.[1]?.body))).toEqual({ plan: "teams", cadence: "annual", seats: 3, storageAddons: 2 });
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Manage subscription" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url.endsWith("/portal") && init?.method === "POST")).toBe(true));
});
it("reads checkout and portal URLs and rejects unsafe external links", async () => {
  const auth = authStore();
  vi.stubGlobal("fetch", vi.fn(async () => json({ url: "https://checkout.example/session" })));
  const billing = auth.api.billing;
  expect(await billing.checkout(org.id, { plan: "individual", cadence: "monthly", seats: 1, storageAddons: 0 })).toEqual({ url: "https://checkout.example/session" });
  expect(await billing.portal(org.id)).toEqual({ url: "https://checkout.example/session" });
  for (const value of ["javascript:alert(1)", "data:text/html,hi", "http://billing.example", "https://user:pass@example.com"])
    expect(() => externalUrl(value)).toThrow("invalid billing link");
});
const aliasedOrg = { ...org, trialEndsAt: null, drives: [{ ...drive, alias: "space", usageBytes: 1024 }] };
const overQuota = { orgId: aliasedOrg.id, usedBytes: 2048, quotaBytes: 1024, plan: "individual", status: "active", state: "paid", writable: false, seats: 1, storageAddons: 0, trialEndsAt: null };
it("shows billing's over-quota meter and banner", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/orgs")) return json({ orgs: [{ ...aliasedOrg, role: "viewer" }] });
    if (url.endsWith("/catalog")) return json({ plans: [], storageAddon: { bytes: 1, maxQuantity: 0 } });
    return json(overQuota);
  }));
  renderApp(`/orgs/${aliasedOrg.id}/billing`);
  expect(await screen.findByRole("alert")).toHaveTextContent("Writes are paused");
  expect(screen.getByRole("meter")).toBeInTheDocument();
});
