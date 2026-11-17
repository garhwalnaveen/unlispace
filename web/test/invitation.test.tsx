import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { drive, json, renderApp, session, signedOutStore } from "./fixtures";

const personal = { id: drive.orgId, name: "My Space", role: "owner", tier: "individual", trialEndsAt: null, drives: [drive] };
const team = { id: "o_team", name: "Studio", role: "member", tier: "teams", trialEndsAt: null, drives: [{ ...drive, id: "d-team", orgId: "o_team", name: "Shared", access: "write" }] };
function inviteFetch(accept: () => Response) {
  let joined = false;
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/accept")) { const response = accept(); joined = response.ok; return response; }
    if (url.endsWith("/auth/logout")) return json({ ok: true });
    if (url.endsWith("/orgs")) return json({ orgs: joined ? [personal, team] : [personal] });
    if (url.endsWith("/me/access")) return json({ user: session.user, workspaces: [] });
    if (url.endsWith("/token")) return json({ token: "drive", endpoint: "https://data.example", expiresAt: Date.now() + 900_000, driveId: "d-team" });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    return json(init?.method ? {} : team.drives[0]);
  });
}
/** Resolves once the sidebar marks `name` as the open drive. */
const openDrive = (name: string) => waitFor(() => expect(within(screen.getByRole("navigation", { name: "Main navigation" })).getByRole("link", { name })).toHaveAttribute("aria-current", "page"));
const acceptCalls = (fetcher: ReturnType<typeof inviteFetch>) => fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"));

it("joins only after an explicit action and explains an invitation meant for another address", async () => {
  const fetcher = inviteFetch(() => json({ error: "invalid_invite" }, 400));
  vi.stubGlobal("fetch", fetcher);
  renderApp("/invites/test-token");
  expect(await screen.findByRole("heading", { name: "Join a workspace" })).toBeInTheDocument();
  expect(within(screen.getByRole("main")).getByText("you@example.com")).toBeInTheDocument();
  await screen.findByRole("link", { name: "Space" });
  expect(acceptCalls(fetcher)).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("belongs to another email address");
  expect(acceptCalls(fetcher)).toHaveLength(1);
  expect(acceptCalls(fetcher)[0][0]).toMatch(/\/invites\/test-token\/accept$/);
  expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled();
});

it("opens the joined workspace's files after accepting", async () => {
  const fetcher = inviteFetch(() => json({ orgId: "o_team" }));
  vi.stubGlobal("fetch", fetcher);
  renderApp("/invites/test-token");
  await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
  await openDrive("Shared");
  expect(screen.getByRole("button", { name: "Switch workspace" })).toHaveTextContent("Studio");
  expect(screen.queryByRole("heading", { name: "Join a workspace" })).not.toBeInTheDocument();
  expect(localStorage.getItem("orbit.workspace")).toBe("o_team");
});

it("lets the wrong account sign out in place and come back to the invitation", async () => {
  const fetcher = inviteFetch(() => json({ orgId: "o_team" }));
  vi.stubGlobal("fetch", fetcher);
  renderApp("/invites/test-token");
  await userEvent.click(await screen.findByRole("button", { name: "Use a different account" }));
  expect(await screen.findByRole("heading", { name: "Sign in to Orbit" })).toBeInTheDocument();
  expect(screen.getByText("Sign in to accept your invitation.")).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/auth/logout"))).toHaveLength(1);
  expect(acceptCalls(fetcher)).toHaveLength(0);
});

it("keeps the invitation open when sign-out fails", async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/auth/logout")) return json({ error: "request_failed", message: "Sign-out failed." }, 500);
    if (url.endsWith("/orgs")) return json({ orgs: [personal] });
    return json({ user: session.user, workspaces: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  renderApp("/invites/test-token");
  await userEvent.click(await screen.findByRole("button", { name: "Use a different account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Sign-out failed.");
  await waitFor(() => expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled());
});

it("asks a signed-out visitor to sign in to accept", async () => {
  renderApp("/invites/test-token", await signedOutStore());
  expect(await screen.findByText("Sign in to accept your invitation.")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
