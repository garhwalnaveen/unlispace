import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { json, renderApp } from "./fixtures";
const member = { userId: "u_peer", email: "peer@example.com", displayName: null, role: "member", createdAt: 1 };
const team = { name: "Studio", role: "owner", canManage: true, members: [member], invitations: [], seats: 3, teamAvailable: true };
it("sends a recipient invitation, then displays pending invitations", async () => {
  let invited = false;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { expect(JSON.parse(String(init.body))).toEqual({ email: "new@example.com", role: "viewer" }); invited = true; return json({}, 201); }
    return json({ ...team, invitations: invited ? [{ id: "invite1", email: "new@example.com", role: "viewer", expiresAt: Date.now() + 100000 }] : [] });
  });
  vi.stubGlobal("fetch", fetcher); renderApp("/orgs/studio/team");
  const user = userEvent.setup();
  await screen.findByText("Studio");
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.com" } });
  await user.selectOptions(screen.getByLabelText("Role"), "viewer");
  await user.click(screen.getByRole("button", { name: "Send invitation" }));
  expect(await screen.findByText("Invitation sent.")).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Pending invitations" })).toBeInTheDocument();
});
it("requires confirmation before member removal and preserves membership errors", async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "DELETE" ? json({ error: "membership_protected" }, 409) : json(team));
  vi.stubGlobal("fetch", fetcher); renderApp("/orgs/studio/team");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Remove" }));
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Remove member" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("workspace must retain an owner");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});
it("disables invitations without a Teams plan and exposes billing", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ ...team, teamAvailable: false })));
  renderApp("/orgs/studio/team");
  expect(await screen.findByRole("button", { name: "Send invitation" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "Manage plan and seats" })).toHaveAttribute("href", "/orgs/studio/billing");
});
