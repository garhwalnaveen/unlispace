import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Org } from "../src/api";
import { drive, json, renderApp, session } from "./fixtures";

const org: Org = { id: drive.orgId, name: "My workspace", role: "owner", tier: "individual", trialEndsAt: null, drives: [drive] };
const other: Org = { ...org, id: "other", name: "Other workspace", drives: [] };
afterEach(() => localStorage.clear());
function show(path: string, orgs: Org[], workspaces: unknown[] = []) {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/orgs")) return json({ orgs });
    if (url.endsWith("/me/access")) return json({ workspaces });
    if (url.endsWith("/members")) return json({ name: "Selected workspace", members: [], invitations: [], seats: 1, role: "owner", canManage: true, teamAvailable: false });
    if (url.endsWith("/catalog")) return json({ plans: [], storageAddon: { bytes: 500e9, maxQuantity: 1000 }, checkoutAvailable: false, trialDays: 7 });
    if (url.includes("/invoices")) return json({ invoices: [], nextPage: null });
    if (url.endsWith("/billing")) return json({ plan: "individual", state: "paid", status: "active", trialEndsAt: null, usedBytes: 0, quotaBytes: 500e9, seats: 1, storageAddons: 0, writable: true });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return Object.assign(renderApp(path), { fetcher });
}
const requested = (fetcher: ReturnType<typeof show>["fetcher"], suffix: string) => fetcher.mock.calls.some(([url]) => url.endsWith(suffix));

it("lists the workspace's drives in the sidebar and keeps admin pages under Settings", async () => {
  const { fetcher } = show(`/orgs/${org.id}/team`, [org]);
  const navigation = within(screen.getByRole("navigation", { name: "Main navigation" }));
  expect(await navigation.findByRole("link", { name: drive.name })).toHaveAttribute("href", `/drives/${drive.id}/`);
  expect(navigation.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  expect(navigation.queryByRole("link", { name: /Billing|Team|Members/ })).not.toBeInTheDocument();
  const settings = within(screen.getByRole("navigation", { name: "Settings" }));
  expect(settings.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
  expect(settings.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/settings");
  expect(settings.getByRole("link", { name: "Access keys" })).toHaveAttribute("href", "/settings/access-keys");
  await userEvent.click(settings.getByRole("link", { name: "Plan and billing" }));
  await waitFor(() => expect(requested(fetcher, `/orgs/${org.id}/billing`)).toBe(true));
  expect(settings.getByRole("link", { name: "Plan and billing" })).toHaveAttribute("aria-current", "page");
});

it.each(["billing", "team"])("opens /%s for the current workspace without a picker", async (page) => {
  localStorage.setItem("orbit.workspace", other.id);
  const { fetcher } = show(`/${page}`, [org, other]);
  await waitFor(() => expect(requested(fetcher, `/orgs/other/${page === "team" ? "members" : "billing"}`)).toBe(true));
  expect(requested(fetcher, `/orgs/${org.id}/${page === "team" ? "members" : "billing"}`)).toBe(false);
  expect(await screen.findByRole("button", { name: "Switch workspace" })).toHaveTextContent(other.name);
});

it("switches workspace from the sidebar and shows that workspace's drives", async () => {
  show(`/orgs/${org.id}/team`, [org, other]);
  const navigation = within(screen.getByRole("navigation", { name: "Main navigation" }));
  await navigation.findByRole("link", { name: drive.name });
  await userEvent.click(screen.getByRole("button", { name: "Switch workspace" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: other.name }));
  expect(await screen.findByRole("heading", { name: "Create your first drive" })).toBeInTheDocument();
  expect(navigation.queryByRole("link", { name: drive.name })).not.toBeInTheDocument();
  expect(localStorage.getItem("orbit.workspace")).toBe(other.id);
});

it("shows storage used and remaining trial days in the sidebar", async () => {
  show(`/orgs/${org.id}/team`, [org], [{ id: org.id, state: "trialing", trialEndsAt: Date.now() + 2 * 86_400_000 - 1000, usedBytes: 1e9, quotaBytes: 4e9 }]);
  expect(await screen.findByRole("link", { name: "Storage" })).toHaveTextContent("1 GB of 4 GB used");
  expect(screen.getByText("2 trial days left").closest("a")).toHaveAttribute("href", `/orgs/${org.id}/billing`);
});

it("says files are read-only after the trial ends", async () => {
  show(`/orgs/${org.id}/team`, [org], [{ id: org.id, state: "expired", trialEndsAt: Date.now() - 1000, usedBytes: 0, quotaBytes: 1024 ** 3 }]);
  expect(await screen.findByText("Trial ended")).toBeInTheDocument();
  expect(screen.getByText(/Files are read-only/)).toBeInTheDocument();
});

it.each(["billing", "team"])("explains an account with no workspaces on /%s", async (page) => {
  show(`/${page}`, []);
  expect(await screen.findByText(/Your account has no workspaces/)).toBeInTheDocument();
});

it("explains what to do when the account has no drive yet", async () => {
  show("/", [{ ...org, role: "member", drives: [] }]);
  expect(await screen.findByRole("heading", { name: "No drives shared with you yet" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Create a drive|New drive/ })).not.toBeInTheDocument();
});

it("keeps the session when sign-out fails and allows retry", async () => {
  let fail = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/logout")) return fail ? json({ error: "unavailable" }, 503) : json({ ok: true });
    if (url.endsWith("/orgs")) return json({ orgs: [{ ...org, drives: [] }] });
    if (url.endsWith("/me/access")) return json({ workspaces: [] });
    throw new Error(`Unexpected request ${url}`);
  }));
  const { auth } = renderApp("/");
  const signOut = async () => {
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
  };
  await signOut();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(auth.getSnapshot().user).toEqual(session.user);
  fail = false;
  await signOut();
  await waitFor(() => expect(auth.getSnapshot().user).toBeNull());
});
