import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { json, org, renderApp, session } from "./fixtures";

const you = { userId: session.user.id, email: session.user.email, displayName: "You Yourself", role: "owner", createdAt: 0 };
const member = { userId: "u_peer", email: "peer@example.com", displayName: null, role: "member", createdAt: 1 };
const team = { name: "Studio", role: "owner", canManage: true, members: [you, member], invitations: [] as object[], seats: 5, teamAvailable: true };
const invitation = { id: "invite1", email: "new@example.com", role: "viewer", expiresAt: Date.UTC(2030, 0, 15, 12) };
/** The workspace's members endpoint plus the shell's own requests; `handle` answers writes. */
function backend(current: () => object, handle?: (url: string, init: RequestInit) => Response | undefined) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") { const answer = handle?.(url, init); if (answer) return answer; }
    if (url.endsWith("/orgs")) return json({ orgs: [{ ...org, id: "studio", name: "Studio" }] });
    if (url.endsWith("/me/access")) return json({ workspaces: [] });
    return json(current());
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const writes = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([, init]) => init?.method && init.method !== "GET").map(([url, init]) => `${init.method} ${new URL(url).pathname}`);

it("invites from the inline row, says what the recipient gets, then lists the pending invitation", async () => {
  let invited = false;
  backend(() => ({ ...team, invitations: invited ? [invitation] : [] }), (_url, init) => {
    expect(JSON.parse(String(init.body))).toEqual({ email: "new@example.com", role: "viewer" }); invited = true; return json({}, 201);
  });
  renderApp("/orgs/studio/team");
  const user = userEvent.setup();
  expect(await screen.findByText("2 of 5 seats used.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send invitation" })).toBeDisabled();
  await user.type(screen.getByLabelText("Invite by email"), "new@example.com");
  await user.selectOptions(screen.getByLabelText("Role"), "viewer");
  await user.click(screen.getByRole("button", { name: "Send invitation" }));
  expect(await screen.findByText("Invitation sent to new@example.com. They'll get an email with a link to join.")).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Pending invitations" })).toBeInTheDocument();
  expect(screen.getByText("Viewer · link expires Jan 15, 2030")).toBeInTheDocument();
  expect(screen.getByText("2 of 5 seats used, 1 held for pending invitation.")).toBeInTheDocument();
  expect(screen.getByLabelText("Invite by email")).toHaveValue("");
});

it("keeps removal in a menu, asks first, and preserves membership errors in the confirmation", async () => {
  const fetcher = backend(() => team, (_url, init) => init.method === "DELETE" ? json({ error: "membership_protected" }, 409) : undefined);
  renderApp("/orgs/studio/team");
  const user = userEvent.setup();
  expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "Options for peer@example.com" }));
  await user.click(screen.getByRole("menuitem", { name: "Remove from workspace…" }));
  expect(writes(fetcher)).toEqual([]);
  const dialog = within(screen.getByRole("dialog", { name: "Remove peer@example.com?" }));
  expect(dialog.getByText(/peer@example.com loses access to Studio and its drives/)).toBeInTheDocument();
  await user.click(dialog.getByRole("button", { name: "Remove member" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent("workspace must retain an owner");
  expect(writes(fetcher)).toEqual(["DELETE /orgs/studio/members/u_peer"]);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("changes a role from its menu, where each role is explained", async () => {
  let role = "member";
  const fetcher = backend(() => ({ ...team, members: [you, { ...member, role }] }), (_url, init) => {
    if (init.method !== "PATCH") return undefined;
    role = JSON.parse(String(init.body)).role; return json({ ok: true });
  });
  renderApp("/orgs/studio/team");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Role for peer@example.com: Member" }));
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
  expect(screen.getByRole("menuitemradio", { name: /^member/ })).toBeChecked();
  await user.click(screen.getByRole("menuitemradio", { name: /viewer.*Can open and download files\./ }));
  expect(await screen.findByText("peer@example.com is now a viewer.")).toBeInTheDocument();
  expect(writes(fetcher)).toEqual(["PATCH /orgs/studio/members/u_peer"]);
  expect(await screen.findByRole("button", { name: "Role for peer@example.com: Viewer" })).toBeInTheDocument();
  // The same four sentences are always on the page.
  const roles = within(screen.getByRole("region", { name: "What each role can do" }));
  for (const text of ["Can open and download files.", "Can also add, change and delete files.", "Can also manage drives, billing, members and viewers.", "Can also add or remove admins and owners."])
    expect(roles.getByText(text)).toBeInTheDocument();
});

it("lets admins manage members and viewers only", async () => {
  backend(() => ({ ...team, role: "admin", members: [{ ...you, role: "admin" }, { ...member, userId: "u_owner", email: "owner@example.com", role: "owner" }, member] }));
  renderApp("/orgs/studio/team");
  const user = userEvent.setup();
  await screen.findByText("owner@example.com");
  expect(screen.queryByRole("button", { name: /Role for owner@example.com/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Options for owner@example.com" })).not.toBeInTheDocument();
  expect(within(screen.getByLabelText("Role")).getAllByRole("option").map((option) => option.textContent)).toEqual(["Viewer", "Member"]);
  await user.click(screen.getByRole("button", { name: "Role for peer@example.com: Member" }));
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
});

it("revokes a pending invitation, and sends one again by replacing it", async () => {
  let failInvite = false;
  const fetcher = backend(() => ({ ...team, invitations: [invitation] }), (_url, init) => init.method === "POST" && failInvite ? json({ error: "email_unavailable" }, 503) : json({ ok: true }));
  renderApp("/orgs/studio/team");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Revoke invitation for new@example.com" }));
  expect(await screen.findByText("Invitation for new@example.com revoked. The link no longer works.")).toBeInTheDocument();
  expect(writes(fetcher)).toEqual(["DELETE /orgs/studio/invites/invite1"]);
  await user.click(await screen.findByRole("button", { name: "Send again to new@example.com" }));
  expect(await screen.findByText("A new invitation was sent to new@example.com. The earlier link no longer works.")).toBeInTheDocument();
  expect(writes(fetcher).slice(1)).toEqual(["DELETE /orgs/studio/invites/invite1", "POST /orgs/studio/invites"]);
  expect(JSON.parse(String(fetcher.mock.calls.filter(([, init]) => init?.method === "POST").pop()![1]!.body))).toEqual({ email: "new@example.com", role: "viewer" });
  // If the replacement cannot be sent, say that the earlier one is gone.
  failInvite = true;
  await user.click(await screen.findByRole("button", { name: "Send again to new@example.com" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The earlier invitation to new@example.com was cancelled, but a new one could not be sent");
});

it("explains a plan without members and links to billing instead of showing disabled controls", async () => {
  backend(() => ({ ...team, members: [you], seats: 1, teamAvailable: false }));
  renderApp("/orgs/studio/team");
  expect(await screen.findByText("Inviting people needs an active Teams plan")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "See plans" })).toHaveAttribute("href", "/orgs/studio/billing");
  expect(screen.queryByRole("button", { name: "Send invitation" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Invite by email")).not.toBeInTheDocument();
  expect(within(screen.getByRole("main")).queryAllByRole("button").filter((button) => (button as HTMLButtonElement).disabled)).toEqual([]);
});

it("points to billing when every seat is taken", async () => {
  backend(() => ({ ...team, seats: 3, invitations: [invitation] }));
  renderApp("/orgs/studio/team");
  expect(await screen.findByRole("link", { name: "Add a seat in Plan and billing" })).toHaveAttribute("href", "/orgs/studio/billing");
  expect(screen.queryByLabelText("Invite by email")).not.toBeInTheDocument();
});

it("shows members read-only to people who cannot manage them, and retries a failed load", async () => {
  let failures = 1;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/orgs")) return json({ orgs: [{ ...org, id: "studio", name: "Studio", role: "member" }] });
    if (url.endsWith("/me/access")) return json({ workspaces: [] });
    return failures-- > 0 ? json({ error: "internal" }, 500) : json({ ...team, role: "member", canManage: false });
  }));
  renderApp("/orgs/studio/team");
  const user = userEvent.setup();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("peer@example.com");
  expect(within(screen.getByText("peer@example.com").closest("tr")!).getByText("Member")).toBeInTheDocument();
  expect(screen.queryByLabelText("Invite by email")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Role for|^Options for peer/ })).not.toBeInTheDocument();
});
