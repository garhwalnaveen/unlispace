import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import type { Org } from "../src/api";
import { drive, json, session } from "./fixtures";

const org: Org = { id: drive.orgId, name: "My workspace", role: "owner", tier: "individual", trialEndsAt: null, drives: [drive] };
const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));
function show(path: string, orgs: Org[]) {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/orgs")) return json({ orgs });
    if (url.endsWith("/me/access")) return json({ workspaces: [] });
    if (url.endsWith("/members")) return json({ name: "Selected workspace", members: [], invitations: [], seats: 1, role: "owner", canManage: true, teamAvailable: false });
    if (url.endsWith("/catalog")) return json({ plans: [], storageAddon: { bytes: 500e9, maxQuantity: 1000 }, checkoutAvailable: false, trialDays: 7 });
    if (url.includes("/invoices")) return json({ invoices: [], nextPage: null });
    if (url.endsWith("/billing")) return json({ plan: "individual", state: "paid", status: "active", trialEndsAt: null, usedBytes: 0, quotaBytes: 500e9, seats: 1, storageAddons: 0, writable: true });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const auth = new AuthStore(localStorage, null);
  stores.push(auth);
  auth.accept(session);
  render(<MemoryRouter initialEntries={[path]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>);
  return fetcher;
}

it.each(["Billing", "Team"])("opens %s from its own tab and retains workspace navigation", async (title) => {
  show("/", [org]);
  await screen.findByRole("link", { name: drive.name });
  const main = within(screen.getByRole("main"));
  expect(main.queryByRole("link", { name: title })).not.toBeInTheDocument();
  expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  const navigation = within(screen.getByRole("navigation", { name: "Main navigation" }));
  await userEvent.click(navigation.getByRole("link", { name: title }));
  expect(await main.findByRole("heading", { name: title })).toBeInTheDocument();
  expect(navigation.getByRole("link", { name: title })).toHaveAttribute("aria-current", "page");
  expect(navigation.getByRole("link", { name: "Billing" })).toHaveAttribute("href", `/orgs/${org.id}/billing`);
  expect(navigation.getByRole("link", { name: "Team" })).toHaveAttribute("href", `/orgs/${org.id}/team`);
});

it.each(["billing", "team"])("lets multiple-workspace accounts choose the workspace for %s", async (page) => {
  const other = { ...org, id: "other", name: "Other workspace", drives: [] };
  const fetcher = show(`/${page}`, [org, other]);
  const link = await screen.findByRole("link", { name: `Open ${page} for ${other.name}` });
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/members") || url.endsWith("/billing"))).toBe(false);
  await userEvent.click(link);
  expect(await screen.findByRole("link", { name: page === "team" ? "Team" : "Billing", current: "page" })).toHaveAttribute("href", `/orgs/other/${page}`);
  expect(await screen.findByText(page === "team" ? "Selected workspace" : "Individual plan")).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith(`/orgs/other/${page === "team" ? "members" : "billing"}`))).toBe(true);
});

it.each(["billing", "team"])("explains an account with no workspaces on /%s", async (page) => {
  show(`/${page}`, []);
  expect(await screen.findByText(/Your account has no workspaces/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Open (team|billing) for/ })).not.toBeInTheDocument();
});

it("keeps the session when header sign-out fails and allows retry", async () => {
  let fail = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/logout")) return fail ? json({ error: "unavailable" }, 503) : json({ ok: true });
    if (url.endsWith("/orgs")) return json({ orgs: [org] });
    if (url.endsWith("/me/access")) return json({ workspaces: [] });
    throw new Error(`Unexpected request ${url}`);
  }));
  const auth = new AuthStore(localStorage, null);
  stores.push(auth);
  auth.accept(session);
  render(<MemoryRouter initialEntries={["/"]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(auth.getSnapshot().user).toEqual(session.user);
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(auth.getSnapshot().user).toBeNull());
});
