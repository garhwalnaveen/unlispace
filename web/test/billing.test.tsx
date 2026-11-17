import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { planStatus } from "../src/Billing";
import { externalUrl } from "../src/billing-data";
import { authStore, catalog, drive, json, org, renderApp } from "./fixtures";

const trialing = { orgId: org.id, plan: "individual", state: "trial_active", writable: true, status: "trialing", trialEndsAt: Date.now() + 86_400_000, seats: 1, storageAddons: 0, quotaBytes: 500e9, usedBytes: 125e9 };
const invoice = { paymentId: "inv_1", createdAt: "2026-10-01T10:00:00Z", amount: 2000, currency: "USD", status: "succeeded" };
/** A billing backend for one workspace; `extra` answers first. */
function backend(summary: object, { orgs = [org], plans = catalog, extra }: { orgs?: unknown[]; plans?: object; extra?: (url: string, init?: RequestInit) => Response | undefined } = {}) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const special = extra?.(url, init); if (special) return special;
    if (url.endsWith("/orgs")) return json({ orgs });
    if (url.endsWith("/me/access")) return json({ workspaces: [] });
    if (url.endsWith("/catalog")) return json(plans);
    if (url.includes("/invoices?")) return json({ invoices: [invoice], nextPage: null });
    return json(summary);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const main = () => within(screen.getByRole("main"));

it("shows the trial in plain words, storage, plans and invoices, and sends checkout selections without losing errors", async () => {
  const fetcher = backend(trialing, { extra: (_url, init) => init?.method === "POST" ? json({ error: "billing_not_configured" }, 503) : undefined });
  const user = userEvent.setup(); renderApp(`/orgs/${org.id}/billing`);
  expect(await main().findByText(/1 day left in your free trial/)).toBeInTheDocument();
  expect(main().getByText("Free trial")).toBeInTheDocument();
  expect(main().getByText("125 GB of 500 GB used")).toBeInTheDocument();
  expect(main().getByRole("meter", { name: "Workspace storage usage" })).toHaveAttribute("value", String(125e9));
  expect(await main().findByText("inv_1")).toBeInTheDocument();
  expect(main().getByRole("table")).toHaveTextContent("US$20.00");
  expect(main().getByRole("table")).toHaveTextContent("Succeeded");
  // Plans come from the catalog; a workspace that never paid has nothing to manage yet.
  expect(within(main().getByRole("article", { name: "Individual plan" })).getByText("500 GB of storage")).toBeInTheDocument();
  expect(within(main().getByRole("article", { name: "Teams plan" })).getByText("1 TB of storage per seat")).toBeInTheDocument();
  expect(main().queryByRole("button", { name: /Manage payment method/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await user.click(main().getByRole("button", { name: "Choose a plan" }));
  expect(screen.getByLabelText("Plan")).toHaveValue("individual");
  expect(screen.getByLabelText("Billing period")).toHaveValue("monthly");
  expect(screen.getByLabelText("Checkout summary")).toHaveTextContent("ends any remaining free trial");
  expect(screen.getByLabelText("Checkout summary")).toHaveTextContent("amount due today");
  await user.selectOptions(screen.getByLabelText("Plan"), "teams");
  await user.selectOptions(screen.getByLabelText("Billing period"), "annual");
  fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText(/Extra storage/), { target: { value: "2" } });
  expect(screen.getByLabelText("Checkout summary")).toHaveTextContent("3 seats · 4 TB of storage in total.");
  await user.click(screen.getByRole("button", { name: "Review yearly checkout" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Billing is not configured");
  const checkout = fetcher.mock.calls.find(([url]) => url.endsWith("/checkout"));
  expect(JSON.parse(String(checkout?.[1]?.body))).toEqual({ plan: "teams", cadence: "annual", seats: 3, storageAddons: 2 });
  await user.click(screen.getByRole("button", { name: "Close" }));
  // A plan card opens checkout on that plan.
  await user.click(main().getByRole("button", { name: "Choose Teams" }));
  expect(screen.getByLabelText("Plan")).toHaveValue("teams");
  expect(screen.getByLabelText("Seats")).toHaveValue(2);
});

it("shows prices from the catalog and the amount due before leaving for checkout", async () => {
  const price = (amount: number) => ({ amount, currency: "USD" });
  backend(trialing, { plans: { ...catalog, prices: { individual: { monthly: price(1500), annual: price(15600) }, teams: { monthly: price(2500), annual: price(26400) }, storage: { monthly: price(1500), annual: price(15600) } } } });
  const user = userEvent.setup(); renderApp(`/orgs/${org.id}/billing`);
  const teams = within(await main().findByRole("article", { name: "Teams plan" }));
  expect(teams.getByText(/US\$25\.00/)).toBeInTheDocument();
  expect(teams.getByText("or US$264.00 per seat a year")).toBeInTheDocument();
  await user.click(teams.getByRole("button", { name: "Choose Teams" }));
  expect(screen.getByTestId("due-today")).toHaveTextContent("Due today: US$50.00");
  expect(screen.getByRole("button", { name: /Continue to pay US\$50\.00/ })).toBeEnabled();
});

it("says exactly what an ended trial means before offering a plan", async () => {
  backend({ ...trialing, state: "expired", writable: false, trialEndsAt: Date.now() - 1000 });
  renderApp(`/orgs/${org.id}/billing`);
  const notice = (await main().findByText("Your trial has ended")).closest('[role="status"]');
  expect(notice).toHaveTextContent("Your files are safe and readable; uploads and changes are paused until you choose a plan.");
  expect(main().getByText("Trial ended")).toBeInTheDocument();
  expect(main().getByRole("button", { name: "Choose a plan" })).toBeEnabled();
});

it("hands a subscriber to the billing portal and refuses an unsafe link", async () => {
  const fetcher = backend({ ...trialing, plan: "teams", state: "paid", status: "active", trialEndsAt: null, seats: 3, quotaBytes: 3e12, cadence: "monthly", currentPeriodEnd: Date.UTC(2030, 0, 15, 12), cancelAtPeriodEnd: false },
    { extra: (url) => url.endsWith("/portal") ? json({ url: "http://billing.example/portal" }) : undefined });
  const user = userEvent.setup(); renderApp(`/orgs/${org.id}/billing`);
  expect(await main().findByText(/Billed monthly, renews on Jan 15, 2030/)).toBeInTheDocument();
  expect(main().getByText("3 seats")).toBeInTheDocument();
  expect(within(main().getByRole("article", { name: "Teams plan" })).getByText("Current plan")).toBeInTheDocument();
  // An existing subscription is changed in the portal, never by a second checkout.
  expect(main().queryByRole("button", { name: /^Choose/ })).not.toBeInTheDocument();
  await user.click(main().getByRole("button", { name: /Manage payment method/ }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url.endsWith("/portal") && init?.method === "POST")).toBe(true));
  expect(await screen.findByRole("alert")).toHaveTextContent("invalid billing link");
  expect(main().getByRole("button", { name: /Manage payment method/ })).toBeEnabled();
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

const overQuota = { orgId: org.id, usedBytes: 2048, quotaBytes: 1024, plan: "individual", status: "active", state: "paid", writable: false, seats: 1, storageAddons: 0, trialEndsAt: null };
it("reassures first when over quota and gives members without billing rights nothing to press", async () => {
  backend(overQuota, { orgs: [{ ...org, trialEndsAt: null, role: "viewer", drives: [drive] }], plans: { plans: [], storageAddon: { bytes: 1, maxQuantity: 0 } } });
  renderApp(`/orgs/${org.id}/billing`);
  const alert = await main().findByRole("alert");
  expect(alert.textContent).toMatch(/^Your files are safe and readable\./);
  expect(alert).toHaveTextContent("uploads and changes are paused");
  expect(main().getByRole("meter", { name: "Workspace storage usage" })).toBeInTheDocument();
  expect(main().getByText("2 KB of 1 KB used")).toBeInTheDocument();
  expect(await main().findByText("Only owners and admins of this workspace can change the plan.")).toBeInTheDocument();
  expect(main().queryByRole("button")).not.toBeInTheDocument();
  expect(main().queryByRole("heading", { name: "Invoices" })).not.toBeInTheDocument();
});

it("explains a failed load and retries it", async () => {
  let failures = 1;
  backend(trialing, { extra: (url) => url.endsWith("/billing") && failures-- > 0 ? json({ error: "internal" }, 500) : undefined });
  const user = userEvent.setup(); renderApp(`/orgs/${org.id}/billing`);
  expect(await main().findByRole("alert")).toBeInTheDocument();
  await user.click(main().getByRole("button", { name: "Try again" }));
  expect(await main().findByText(/1 day left in your free trial/)).toBeInTheDocument();
});

it("puts every plan state in plain words", () => {
  const base = { orgId: "o", plan: "teams" as const, seats: 2, storageAddons: 0, quotaBytes: 1, usedBytes: 0, trialEndsAt: null };
  const paid = { ...base, state: "paid" as const, writable: true };
  const lapsed = { ...base, state: "expired" as const, writable: false };
  expect(planStatus({ ...paid, status: "past_due" })).toMatchObject({ badge: "Payment needs attention", line: expect.stringMatching(/^Your files are safe/) });
  expect(planStatus({ ...paid, status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: Date.UTC(2030, 0, 15, 12) })).toMatchObject({ badge: "Ending", line: expect.stringContaining("won't renew") });
  expect(planStatus({ ...lapsed, status: "on_hold" }).paused).toMatchObject({ title: "Your files are safe and readable", text: expect.stringContaining("Update your payment method") });
  expect(planStatus({ ...lapsed, status: "cancelled" }).paused?.text).toBe("Your files are safe and readable; uploads and changes are paused until you choose a plan.");
  expect(planStatus({ ...base, state: "provisioning", status: "trialing", writable: false, trialPending: true })).toEqual({ badge: "Trial not started", tone: "", line: "Your free trial starts when your first drive is ready." });
});
