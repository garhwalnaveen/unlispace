import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { readOnboarding } from "../src/onboarding/state";
import { authStore, drive, json, renderApp, session, signedOutStore } from "./fixtures";

/** Resolves once the sidebar marks `name` as the open drive. */
const openDrive = (name: string) => waitFor(() => expect(within(screen.getByRole("navigation", { name: "Main navigation" })).getByRole("link", { name })).toHaveAttribute("aria-current", "page"));
const DAY = 86_400_000;
const org = (extra = {}) => ({ id: drive.orgId, name: "My Space", role: "owner", tier: "individual", trialPending: false, trialEndsAt: Date.now() + 7 * DAY, drives: [drive], ...extra });
const workspace = (extra = {}) => ({ id: drive.orgId, name: "My Space", role: "owner", tier: "individual", state: "trial_active", trialPending: false, trialEndsAt: Date.now() + 7 * DAY, writable: true, storageReady: true, quotaBytes: 500e9, usedBytes: 0, ...extra });
/** Answers the requests the signed-in shell and an empty drive make. */
function appFetch(overrides: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const override = overrides(url, init);
    if (override) return override;
    if (url.endsWith("/orgs")) return json({ orgs: [org()] });
    if (url.endsWith("/me/access")) return json({ user: session.user, workspaces: [workspace()] });
    if (url.endsWith("/token")) return json({ token: "drive", endpoint: "https://data.example", expiresAt: Date.now() + 900_000, driveId: drive.id });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    if (url.endsWith("/keys")) return json({ keys: [] });
    return json(drive);
  });
}
async function signInWithEmail(user = userEvent.setup()) {
  await user.type(await screen.findByLabelText("Email address"), "you@example.com");
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.type(await screen.findByLabelText("Verification code"), "123456");
}

it("offers Google first, then email, and tells new people what signing in does", async () => {
  renderApp("/login", await signedOutStore());
  expect(await screen.findByRole("heading", { level: 1, name: "Sign in to Orbit" })).toBeInTheDocument();
  const google = screen.getByRole("button", { name: "Continue with Google" });
  const email = screen.getByRole("button", { name: "Continue with email" });
  expect(google.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("New to Orbit? Signing in creates your account with a 7-day trial. No card needed.")).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
});

it("sends a newly created account to the welcome question", async () => {
  vi.stubGlobal("fetch", appFetch((url) => {
    if (url.endsWith("/otp/start")) return json({ ok: true });
    if (url.endsWith("/otp/verify")) return json({ ...session, accountCreated: true });
  }));
  renderApp("/login", await signedOutStore());
  await signInWithEmail();
  expect(await screen.findByRole("heading", { level: 1, name: "Welcome to Orbit" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "How will you use Orbit?" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  expect(readOnboarding()).toMatchObject({ status: "pending", user: session.user.id });
});

it("takes a returning account straight to its files, with no welcome and no Get started list", async () => {
  vi.stubGlobal("fetch", appFetch((url) => {
    if (url.endsWith("/otp/start")) return json({ ok: true });
    if (url.endsWith("/otp/verify")) return json(session);
  }));
  renderApp("/login", await signedOutStore());
  await signInWithEmail();
  expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
  await openDrive("Space");
  expect(screen.queryByRole("heading", { name: "Welcome to Orbit" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Get started" })).not.toBeInTheDocument();
  expect(readOnboarding()).toBeNull();
});

it("does not carry one account's welcome over to the next person on the same browser", async () => {
  localStorage.setItem("orbit.onboarding", JSON.stringify({ status: "pending", user: "u_someone_else" }));
  vi.stubGlobal("fetch", appFetch((url) => {
    if (url.endsWith("/otp/start")) return json({ ok: true });
    if (url.endsWith("/otp/verify")) return json(session);
  }));
  renderApp("/login", await signedOutStore());
  await signInWithEmail();
  expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
  expect(readOnboarding()).toBeNull();
});

it("says why sign-in is needed when it was reached from the Mac app or an invitation", async () => {
  const first = renderApp(`/login?${new URLSearchParams({ return: `/desktop?state=s&code_challenge=${"a".repeat(43)}` })}`, await signedOutStore());
  expect(await screen.findByText("Sign in to connect Orbit on this Mac.")).toBeInTheDocument();
  first.unmount();
  renderApp(`/login?${new URLSearchParams({ return: "/invites/abc" })}`, await signedOutStore());
  expect(await screen.findByText("Sign in to accept your invitation.")).toBeInTheDocument();
});

it("explains a drive that is still being set up and checks again only when asked", async () => {
  let ready = false;
  const fetcher = appFetch((url) => {
    if (url.endsWith("/orgs")) return json({ orgs: [org({ trialPending: !ready, trialEndsAt: ready ? Date.now() + 7 * DAY : null, drives: [{ ...drive, status: ready ? "ready" : "provisioning_failed" }] })] });
    if (url.endsWith("/me/access")) return json({ user: session.user, workspaces: [workspace({ state: ready ? "trial_active" : "provisioning", storageReady: ready })] });
  });
  vi.stubGlobal("fetch", fetcher);
  renderApp("/");
  expect(await screen.findByRole("heading", { name: "Your drive is being set up" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Space" })).not.toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/orgs"))).toHaveLength(1);
  ready = true;
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("link", { name: "Space" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Your drive is being set up" })).not.toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/orgs"))).toHaveLength(2);
});

it("keeps the saved desktop return target when returning from a failed Google callback", async () => {
  const target = `/desktop?state=original&code_challenge=${"a".repeat(43)}`;
  sessionStorage.setItem("orbit.return", target);
  renderApp("/auth/callback", await signedOutStore());
  expect(await screen.findByRole("heading", { name: "Sign-in didn't finish" })).toBeInTheDocument();
  const link = screen.getByRole("link", { name: "Back to sign in" });
  expect(link).toHaveAttribute("href", `/login?${new URLSearchParams({ return: target })}`);
  await userEvent.click(link);
  expect(await screen.findByRole("heading", { name: "Sign in to Orbit" })).toBeInTheDocument();
  expect(screen.getByText("Sign in to connect Orbit on this Mac.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
});

it("keeps a deployed billing address inside the signed-in app, one click from the files", async () => {
  vi.stubGlobal("fetch", appFetch((url) => {
    if (url.endsWith("/orgs")) return json({ orgs: [org({ trialEndsAt: null })] });
    if (url.endsWith("/catalog")) return json({ plans: [], storageAddon: { bytes: 500e9, maxQuantity: 1000 }, checkoutAvailable: false, trialDays: 7 });
    if (url.includes("/invoices")) return json({ invoices: [], nextPage: null });
    if (url.endsWith("/billing")) return json({ plan: "individual", state: "paid", writable: true, status: "active", trialEndsAt: null, seats: 1, storageAddons: 0, quotaBytes: 500e9, usedBytes: 0 });
  }));
  renderApp(`/orgs/${drive.orgId}/billing`);
  const files = await screen.findByRole("link", { name: "Space" });
  expect(files).toHaveAttribute("href", `/drives/${drive.id}/`);
  await waitFor(() => expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page"));
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

it("redirects signed-out drive visitors to sign in and returns them to the drive afterwards", async () => {
  vi.stubGlobal("fetch", appFetch((url) => {
    if (url.endsWith("/otp/start")) return json({ ok: true });
    if (url.endsWith("/otp/verify")) return json(session);
  }));
  renderApp("/drives/d-test/", await signedOutStore());
  expect(await screen.findByRole("heading", { name: "Sign in to Orbit" })).toBeInTheDocument();
  await signInWithEmail();
  await openDrive("Space");
});
