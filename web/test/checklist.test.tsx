import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { readOnboarding, writeOnboarding } from "../src/onboarding/state";
import { drive, json, renderApp, session } from "./fixtures";

interface Options { role?: string; tier?: string; usedBytes?: number; keys?: () => Response; members?: number; invitations?: number; drives?: unknown[] }
function shellFetch({ role = "owner", tier = "individual", usedBytes = 0, keys = () => json({ keys: [] }), members = 1, invitations = 0, drives = [drive] }: Options = {}) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/orgs")) return json({ orgs: [{ id: drive.orgId, name: "My Space", role, tier, trialPending: false, trialEndsAt: null, drives }] });
    if (url.endsWith("/me/access")) return json({ user: session.user, workspaces: [{ id: drive.orgId, name: "My Space", role, tier, state: "paid", trialPending: false, trialEndsAt: null, writable: true, storageReady: true, quotaBytes: 500e9, usedBytes }] });
    if (url.endsWith("/keys")) return keys();
    if (url.endsWith("/members")) return json({ name: "My Space", role, canManage: true, members: Array.from({ length: members }, (_, index) => ({ userId: `u${index}`, email: `m${index}@example.com`, displayName: null, role: "member", createdAt: 1 })), invitations: Array.from({ length: invitations }, (_, index) => ({ id: `i${index}`, email: `i${index}@example.com`, role: "member", expiresAt: 1 })), seats: 3, teamAvailable: true });
    return json({ ...drive, usageBytes: 0 });
  });
}
const key = (extra = {}) => ({ accessKeyId: "ULS1KEY", workspaceId: drive.orgId, label: "k", access: "read", drives: null, parent: null, createdAt: 1, lastUsedAt: null, revokedAt: null, ...extra });
const list = () => screen.findByRole("region", { name: "Get started" });
const requests = (fetcher: ReturnType<typeof shellFetch>, suffix: string) => fetcher.mock.calls.filter(([url]) => url.endsWith(suffix)).length;
const settled = () => screen.findByRole("heading", { name: "Page not found" });

beforeEach(() => { writeOnboarding({ status: "done", user: session.user.id }); });

it("is not shown, and asks the server nothing, for an account that did not start here", async () => {
  localStorage.clear();
  const fetcher = shellFetch();
  vi.stubGlobal("fetch", fetcher);
  renderApp("/nowhere");
  await settled();
  await screen.findByRole("link", { name: "Space" });
  expect(screen.queryByRole("region", { name: "Get started" })).not.toBeInTheDocument();
  expect(requests(fetcher, "/keys")).toBe(0);
});

it("lists the open steps with a count, each linking to where it is done", async () => {
  vi.stubGlobal("fetch", shellFetch());
  renderApp("/nowhere");
  const region = await list();
  expect(region).toHaveTextContent("Get started");
  expect(region).toHaveTextContent("0 of 3 done");
  const links = within(region).getAllByRole("link");
  expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["Install the Mac app", "/welcome?path=mac"],
    ["Add your first file", `/drives/${drive.id}/`],
    ["Connect a tool or agent", "/settings/access-keys"],
  ]);
  expect(within(region).queryByText("Invite a teammate")).not.toBeInTheDocument();
});

it("ticks steps from what the server already knows", async () => {
  vi.stubGlobal("fetch", shellFetch({ usedBytes: 1024, keys: () => json({ keys: [key()] }) }));
  renderApp("/nowhere");
  const region = await list();
  await waitFor(() => expect(region).toHaveTextContent("2 of 3 done"));
  expect(within(region).getAllByRole("link").map((link) => link.textContent)).toEqual(["Install the Mac app"]);
  expect(within(region).getByText("Add your first file").closest("li")).toHaveAttribute("data-done");
});

it("does not count a removed key or a key for another workspace", async () => {
  vi.stubGlobal("fetch", shellFetch({ keys: () => json({ keys: [key({ revokedAt: 5 }), key({ workspaceId: "o_other" })] }) }));
  renderApp("/nowhere");
  const region = await list();
  await settled();
  expect(region).toHaveTextContent("0 of 3 done");
});

it("offers Invite a teammate to owners and admins on a team plan", async () => {
  vi.stubGlobal("fetch", shellFetch({ tier: "teams" }));
  renderApp("/nowhere");
  const region = await list();
  expect(region).toHaveTextContent("0 of 4 done");
  expect(within(region).getByRole("link", { name: "Invite a teammate" })).toHaveAttribute("href", `/orgs/${drive.orgId}/team`);
});

it.each([["someone else is a member", { members: 2 }], ["an invitation is pending", { invitations: 1 }]])("ticks Invite a teammate once %s", async (_case, options) => {
  vi.stubGlobal("fetch", shellFetch({ tier: "teams", ...options }));
  renderApp("/nowhere");
  const region = await list();
  await waitFor(() => expect(region).toHaveTextContent("1 of 4 done"));
  expect(within(region).queryByRole("link", { name: "Invite a teammate" })).not.toBeInTheDocument();
});

it("does not ask members who cannot invite, and does not look up the team for them", async () => {
  const fetcher = shellFetch({ tier: "teams", role: "member" });
  vi.stubGlobal("fetch", fetcher);
  renderApp("/nowhere");
  const region = await list();
  await settled();
  expect(region).toHaveTextContent("0 of 3 done");
  expect(within(region).queryByText("Invite a teammate")).not.toBeInTheDocument();
  expect(requests(fetcher, "/members")).toBe(0);
});

it("ticks steps finished in this browser and goes away when everything is done", async () => {
  writeOnboarding({ macOpened: true, keyCreated: true });
  vi.stubGlobal("fetch", shellFetch());
  renderApp("/nowhere");
  const region = await list();
  expect(region).toHaveTextContent("2 of 3 done");
  writeOnboarding({ uploaded: true });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Get started" })).not.toBeInTheDocument());
});

it("folds to its heading and can be dismissed for good", async () => {
  vi.stubGlobal("fetch", shellFetch());
  const user = userEvent.setup();
  const view = renderApp("/nowhere");
  const region = await list();
  const toggle = within(region).getByRole("button", { name: /^Get started/ });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(within(region).queryByRole("list")).not.toBeInTheDocument();
  expect(region).toHaveTextContent("0 of 3 done");
  await user.click(toggle);
  expect(within(region).getByRole("list")).toBeInTheDocument();
  await user.click(within(region).getByRole("button", { name: "Dismiss Get started" }));
  expect(screen.queryByRole("region", { name: "Get started" })).not.toBeInTheDocument();
  expect(readOnboarding()).toMatchObject({ dismissed: true });
  view.unmount();
  renderApp("/nowhere");
  await settled();
  await screen.findByRole("link", { name: "Space" });
  expect(screen.queryByRole("region", { name: "Get started" })).not.toBeInTheDocument();
});

it("leaves a step open, without an error, when its check fails", async () => {
  vi.stubGlobal("fetch", shellFetch({ keys: () => json({ error: "internal" }, 500) }));
  renderApp("/nowhere");
  const region = await list();
  await settled();
  expect(region).toHaveTextContent("0 of 3 done");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("picks up progress made elsewhere when the person returns to the tab", async () => {
  let keys: unknown[] = [];
  const fetcher = shellFetch({ keys: () => json({ keys }) });
  vi.stubGlobal("fetch", fetcher);
  renderApp("/nowhere");
  const region = await list();
  await waitFor(() => expect(requests(fetcher, "/keys")).toBe(1));
  expect(region).toHaveTextContent("0 of 3 done");
  keys = [key()];
  fireEvent.focus(window);
  await waitFor(() => expect(region).toHaveTextContent("1 of 3 done"));
});

it("ignores progress that belongs to a different account", async () => {
  writeOnboarding({ user: "u_someone_else" });
  vi.stubGlobal("fetch", shellFetch());
  renderApp("/nowhere");
  await settled();
  await screen.findByRole("link", { name: "Space" });
  expect(screen.queryByRole("region", { name: "Get started" })).not.toBeInTheDocument();
});
