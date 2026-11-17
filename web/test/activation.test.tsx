import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { authStore, drive, json, renderApp, session, signedOutStore } from "./fixtures";

it("explains pending provisioning and retries only on an explicit action, then exposes the ready drive", async () => {
  let ready = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/orgs")) return json({ orgs: [{ id: drive.orgId, name: "My Space", role: "owner", tier: "individual", trialPending: !ready, trialEndsAt: ready ? Date.now() + 7 * 86_400_000 : null, drives: [{ ...drive, status: ready ? "ready" : "provisioning_failed" }] }] });
    return json({ usedBytes: 0, quotaBytes: 500e9, state: "provisioning", writable: false });
  });
  vi.stubGlobal("fetch", fetcher); renderApp("/");
  expect(await screen.findByText(/trial has not started/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Space" })).not.toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/orgs"))).toHaveLength(1);
  ready = true;
  await userEvent.click(screen.getByRole("button", { name: "Retry drive setup" }));
  expect(await screen.findByRole("link", { name: "Space" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry drive setup" })).not.toBeInTheDocument();
  expect(screen.queryByText(/trial has not started/)).not.toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/orgs"))).toHaveLength(2);
});

it("preserves the desktop state and challenge through changing email and OTP verification", async () => {
  const state = "original+desktop-state"; const challenge = "a".repeat(43);
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/otp/start")) return json({ ok: true });
    if (url.endsWith("/otp/verify")) return json(session);
    if (url.endsWith("/orgs")) return json({ orgs: [{ drives: [drive] }] });
    if (url.endsWith("/desktop/code")) return json({ error: "temporarily_unavailable" }, 503);
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  renderApp(`/desktop?${new URLSearchParams({ state, code_challenge: challenge })}`, await signedOutStore());
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email address"), "first@example.com");
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.click(await screen.findByRole("button", { name: "Change email" }));
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "second@example.com" } });
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.type(await screen.findByLabelText("Verification code"), "123456");
  await user.click(screen.getByRole("button", { name: "Verify & sign in" }));
  expect(await screen.findByRole("heading", { name: "Your Orbit is ready" })).toBeInTheDocument();
  expect(screen.getByText("Account verified")).toBeInTheDocument();
  expect(screen.getByText("Drive ready")).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open Orbit" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  const request = fetcher.mock.calls.find(([url]) => url.endsWith("/desktop/code"));
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ state, codeChallenge: challenge });
});

it("keeps the saved desktop return target when returning from a failed Google callback", async () => {
  const target = `/desktop?state=original&code_challenge=${"a".repeat(43)}`;
  sessionStorage.setItem("orbit.return", target);
  renderApp("/auth/callback", await signedOutStore());
  const link = await screen.findByRole("link", { name: "Return to sign in" });
  expect(link).toHaveAttribute("href", `/login?${new URLSearchParams({ return: target })}`);
  await userEvent.click(link);
  expect(await screen.findByRole("heading", { name: "Welcome to Orbit" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
});

it("returns from a deployed billing route to the working drives route", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/orgs")) return json({ orgs: [{ id: drive.orgId, name: "My Space", role: "owner", tier: "individual", trialEndsAt: null, drives: [drive] }] });
    if (url.endsWith("/catalog")) return json({ plans: [], storageAddon: { bytes: 500e9, maxQuantity: 1000 }, checkoutAvailable: false, trialDays: 7 });
    if (url.includes("/invoices")) return json({ invoices: [], nextPage: null });
    return json({ plan: "individual", state: "paid", writable: true, status: "active", trialEndsAt: null, seats: 1, storageAddons: 0, quotaBytes: 500e9, usedBytes: 0 });
  }));
  renderApp(`/orgs/${drive.orgId}/billing`);
  await screen.findByRole("heading", { name: "Billing" });
  await userEvent.click(within(screen.getByRole("main")).getByRole("link", { name: "Your drives" }));
  expect(await screen.findByRole("heading", { name: "Your drives" })).toBeInTheDocument();
  expect(screen.queryByText("That page could not be found.")).not.toBeInTheDocument();
});

it("shows the public landing page at the root and keeps drive routes protected", async () => {
  renderApp("/", await signedOutStore());
  expect(await screen.findByRole("navigation", { name: "Product navigation" })).toBeInTheDocument();
  for (const link of screen.getAllByRole("link", { name: "Sign in" })) expect(link).toHaveAttribute("href", "/login");
  expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
});

it("renders the public overview before session recovery finishes", () => {
  renderApp("/overview", authStore({ signedIn: false }));
  expect(screen.getByRole("heading", { level: 1, name: "One filesystem for people and AI agents" })).toBeInTheDocument();
  expect(screen.queryByText("Loading your account…")).not.toBeInTheDocument();
});

it("redirects signed-out drive visitors to sign in with their destination", async () => {
  renderApp("/drives/d-test/", await signedOutStore());
  expect(await screen.findByRole("heading", { name: "Welcome to Orbit" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue with email" })).toBeInTheDocument();
});
