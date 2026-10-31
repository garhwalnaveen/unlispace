import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import { json, session } from "./fixtures";
const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.dispose()));
function renderApp(path: string) {
  const auth = new AuthStore(localStorage, null); stores.push(auth); auth.accept(session);
  render(<MemoryRouter initialEntries={[path]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>);
}
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
  await screen.findByRole("heading", { name: "Studio" });
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
it("accepts only after an explicit action and shows a wrong-account error", async () => {
  const fetcher = vi.fn(async () => json({ error: "invalid_invite" }, 400));
  vi.stubGlobal("fetch", fetcher); renderApp("/invites/test-token");
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: "Accept invitation" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("alert")).toHaveTextContent("belongs to another email address");
});
