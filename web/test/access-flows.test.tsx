import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import { formatMoney } from "../src/Billing";
import { drive, json, session } from "./fixtures";

const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));
async function renderApp(path: string, signedIn = true) {
  const auth = new AuthStore(localStorage, null); stores.push(auth);
  if (signedIn) auth.accept(session); else await auth.start();
  render(<MemoryRouter initialEntries={[path]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>);
  return auth;
}
const org = (extra = {}) => ({ id: drive.orgId, name: "My Space", role: "owner", tier: "individual", trialPending: false, trialEndsAt: Date.now() + 3 * 86_400_000, quotaBytes: 500e9, usedBytes: 0, drives: [drive], ...extra });
const ws = (extra = {}) => ({ id: drive.orgId, name: "My Space", role: "owner", tier: "individual", state: "trial_active", trialPending: false, trialEndsAt: Date.now() + 3 * 86_400_000, writable: true, storageReady: true, quotaBytes: 500e9, usedBytes: 0, ...extra });
const access = (...workspaces: unknown[]) => ({ user: session.user, workspaces });
const price = (amount: number) => ({ amount, currency: "USD" });
const prices = { individual: { monthly: price(1500), annual: price(15000) }, teams: { monthly: price(1500), annual: price(15000) }, storage: { monthly: price(500), annual: price(5000) } };
const baseCatalog = { plans: [{ id: "individual", name: "Individual", bytesPerSeat: 500e9, minSeats: 1, maxSeats: 1 }, { id: "teams", name: "Teams", bytesPerSeat: 1e12, minSeats: 2, maxSeats: 1000 }], storageAddon: { bytes: 500e9, maxQuantity: 1000 }, checkoutAvailable: true, trialDays: 7, checkoutStartsImmediately: true, checkoutEndsTrial: true };
const summary = { orgId: drive.orgId, plan: "individual", state: "trial_active", writable: true, status: "trialing", trialEndsAt: Date.now() + 86_400_000, seats: 1, storageAddons: 0, quotaBytes: 500e9, usedBytes: 0 };
function billingFetch(catalog: unknown) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/orgs")) return json({ orgs: [org()] });
    if (url.endsWith("/catalog")) return json(catalog);
    if (url.includes("/invoices")) return json({ invoices: [], nextPage: null });
    return json(summary);
  });
}

it("formats minor units, with US$ for dollars", () => {
  expect(formatMoney(18000, "USD")).toBe("US$180.00");
  expect(formatMoney(1500, "USD")).toBe("US$15.00");
  expect(formatMoney(1234567, "USD")).toBe("US$12,345.67");
  expect(formatMoney(500, "JPY")).toContain("500");
});

it("shows the exact amount, tax, renewal and trial consequence before checkout, and labels the button", async () => {
  vi.stubGlobal("fetch", billingFetch({ ...baseCatalog, prices }));
  const user = userEvent.setup();
  await renderApp(`/orgs/${drive.orgId}/billing`);
  await userEvent.click(await screen.findByRole("button", { name: "Choose a plan" }));
  const box = await screen.findByLabelText("Checkout summary");
  expect(box).toHaveTextContent("Due today: US$15.00, plus applicable tax.");
  expect(box).toHaveTextContent("US$15.00 per month, plus applicable tax. Renews automatically each month; cancel in Billing.");
  expect(box).toHaveTextContent("Your card is charged US$15.00 today and your free trial ends now.");
  expect(screen.getByRole("button", { name: "Continue to pay US$15.00" })).toBeEnabled();
  await user.selectOptions(screen.getByLabelText("Billing period"), "annual");
  expect(box).toHaveTextContent("US$150.00 per year");
  expect(box).toHaveTextContent("Renews automatically each year");
  fireEvent.change(screen.getByLabelText(/Extra storage/), { target: { value: "2" } });
  expect(screen.getByRole("button", { name: "Continue to pay US$250.00" })).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Plan"), "teams");
  fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "3" } });
  expect(screen.getByRole("button", { name: "Continue to pay US$550.00" })).toBeInTheDocument();
});

it("does not invent prices or the trial claim when none are configured", async () => {
  vi.stubGlobal("fetch", billingFetch({ ...baseCatalog, prices: null }));
  await renderApp(`/orgs/${drive.orgId}/billing`);
  await userEvent.click(await screen.findByRole("button", { name: "Choose a plan" }));
  const box = await screen.findByLabelText("Checkout summary");
  expect(box).toHaveTextContent("amount due today, currency and applicable tax are shown in Dodo Payments");
  expect(box).not.toHaveTextContent("US$");
  expect(screen.getByRole("button", { name: "Review monthly checkout" })).toBeInTheDocument();
});

it("omits the trial sentence when checkout does not end the trial", async () => {
  vi.stubGlobal("fetch", billingFetch({ ...baseCatalog, checkoutEndsTrial: false, prices }));
  await renderApp(`/orgs/${drive.orgId}/billing`);
  await userEvent.click(await screen.findByRole("button", { name: "Choose a plan" }));
  const box = await screen.findByLabelText("Checkout summary");
  expect(box).not.toHaveTextContent("trial ends now");
});

it("every billing link and return target resolves to a rendered route", async () => {
  vi.stubGlobal("fetch", billingFetch({ ...baseCatalog, prices: null }));
  // return_url and portal return in the API: `${ULS_WEB_ORIGIN}/orgs/${id}/billing`
  await renderApp(`/orgs/${drive.orgId}/billing`);
  await screen.findByRole("heading", { name: "Billing" });
  expect(screen.queryByText("That page could not be found.")).not.toBeInTheDocument();
  const link = within(screen.getByRole("main")).getByRole("link", { name: "Your drives" });
  expect(link).toHaveAttribute("href", "/");
  await userEvent.click(link);
  expect(await screen.findByRole("heading", { name: "Your drives" })).toBeInTheDocument();
  const billing = (await screen.findAllByRole("link", { name: "Billing" }))[0]!;
  expect(billing).toHaveAttribute("href", `/orgs/${drive.orgId}/billing`);
  await userEvent.click(billing);
  expect(await screen.findByRole("heading", { name: "Billing" })).toBeInTheDocument();
});

const desktopQuery = (extra: Record<string, string> = {}) => new URLSearchParams({ state: "s+1", code_challenge: "a".repeat(43), ...extra });

it("switch=1 signs the web session out once and keeps the desktop parameters for sign-in", async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/auth/logout")) return json({ ok: true });
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  await renderApp(`/desktop?${desktopQuery({ switch: "1" })}`);
  expect(await screen.findByRole("heading", { name: "Welcome to Unlispace" })).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/auth/logout"))).toHaveLength(1);
  // The Google button records the return target without `switch`, so the user cannot loop.
  await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await waitFor(() => expect(sessionStorage.getItem("unlispace.return")).toBe(`/desktop?${desktopQuery()}`));
});

it("switch=1 without a web session goes straight to sign-in", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network expected"); }));
  await renderApp(`/desktop?${desktopQuery({ switch: "1" })}`, false);
  expect(await screen.findByRole("heading", { name: "Welcome to Unlispace" })).toBeInTheDocument();
});

it("offers Use a different account on the confirmation screen and keeps the target through email sign-in", async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/auth/logout")) return json({ ok: true });
    if (url.endsWith("/otp/start")) return json({ ok: true });
    if (url.endsWith("/otp/verify")) return json({ ...session, user: { id: "u2", email: "other@example.com" } });
    if (url.endsWith("/orgs")) return json({ orgs: [org()] });
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  await renderApp(`/desktop?${desktopQuery()}`);
  await screen.findByRole("heading", { name: "Your Unlispace is ready" });
  await user.click(screen.getByRole("button", { name: "Use a different account" }));
  await user.type(await screen.findByLabelText("Email address"), "other@example.com");
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.type(await screen.findByLabelText("Verification code"), "123456");
  await user.click(screen.getByRole("button", { name: "Verify & sign in" }));
  expect(await screen.findByRole("heading", { name: "Your Unlispace is ready" })).toBeInTheDocument();
  expect(within(screen.getByRole("main")).getByText("other@example.com")).toBeInTheDocument();
});

it("switching from email to Google mid-flow keeps the desktop return target", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (url.endsWith("/otp/start")) return json({ ok: true }); throw new Error(url); }));
  const user = userEvent.setup();
  await renderApp(`/desktop?${desktopQuery()}`, false);
  await user.type(await screen.findByLabelText("Email address"), "x@example.com");
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await screen.findByLabelText("Verification code");
  await user.click(screen.getByRole("button", { name: "Continue with Google" }));
  await waitFor(() => expect(sessionStorage.getItem("unlispace.return")).toBe(`/desktop?${desktopQuery()}`));
});

function homeFetch(accessBody: unknown, orgBody = org()) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/me/access")) return accessBody instanceof Error ? json({ error: "internal" }, 500) : json(accessBody);
    if (url.endsWith("/orgs")) return json({ orgs: [orgBody] });
    return json({ usedBytes: 0, quotaBytes: 500e9, state: "trial_active", writable: true });
  });
}

it("home shows trial days from /me/access", async () => {
  vi.stubGlobal("fetch", homeFetch(access(ws({ trialEndsAt: Date.now() + 2 * 86_400_000 })), org({ trialEndsAt: null })));
  await renderApp("/");
  expect(await screen.findByText(/2 trial days remaining/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry drive setup" })).not.toBeInTheDocument();
});

it("home explains storage that is not ready yet and retries both endpoints", async () => {
  let ready = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/me/access")) return json(access(ws(ready ? {} : { state: "provisioning", trialPending: true, trialEndsAt: null, writable: false, storageReady: false })));
    if (url.endsWith("/orgs")) return json({ orgs: [org({ drives: [{ ...drive, status: ready ? "ready" : "provisioning_failed" }] })] });
    return json({ usedBytes: 0, quotaBytes: 500e9, state: "trial_active", writable: true });
  });
  vi.stubGlobal("fetch", fetcher);
  await renderApp("/");
  expect(await screen.findByText(/seven-day trial has not started/)).toBeInTheDocument();
  ready = true;
  await userEvent.click(screen.getByRole("button", { name: "Retry drive setup" }));
  expect(await screen.findByRole("link", { name: "Space" })).toBeInTheDocument();
  expect(screen.queryByText(/trial has not started/)).not.toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/me/access"))).toHaveLength(2);
});

it("home says storage is being prepared when verified but not storage-ready, and explains expiry", async () => {
  vi.stubGlobal("fetch", homeFetch(access(ws({ storageReady: false, state: "expired", trialEndsAt: Date.now() - 1000, writable: false }))));
  await renderApp("/");
  expect(await screen.findByText(/storage is still being prepared/)).toBeInTheDocument();
  expect(screen.getByText(/Your trial has ended\. Your files remain readable/)).toBeInTheDocument();
});

it("home still lists drives when /me/access fails", async () => {
  vi.stubGlobal("fetch", homeFetch(new Error("x")));
  await renderApp("/");
  expect(await screen.findByRole("link", { name: "Space" })).toBeInTheDocument();
});
