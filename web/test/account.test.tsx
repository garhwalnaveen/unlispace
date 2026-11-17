import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { json, org, renderApp } from "./fixtures";

/** The shell's requests plus the profile; `handle` answers writes. */
function backend(handle?: (url: string, init: RequestInit) => Response | undefined) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") { const answer = handle?.(url, init); if (answer) return answer; }
    if (url.endsWith("/orgs")) return json({ orgs: [org] });
    if (url.endsWith("/me/access")) return json({ workspaces: [] });
    return json({ email: "you@example.com", displayName: "Old name" });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const main = () => within(screen.getByRole("main"));

it("shows the email, saves a changed display name and keeps a failed save editable", async () => {
  let fail = true;
  const fetcher = backend((_url, init) => init.method === "PATCH" ? (fail ? json({ error: "internal" }, 500) : json({ email: "you@example.com", displayName: "New name" })) : undefined);
  const user = userEvent.setup();
  renderApp("/settings");
  expect(await main().findByText("you@example.com")).toBeInTheDocument();
  const name = main().getByLabelText("Display name");
  const save = main().getByRole("button", { name: "Save changes" });
  expect(name).toHaveValue("Old name");
  expect(save).toBeDisabled();
  await user.clear(name); await user.type(name, " New name ");
  await user.click(save);
  expect(await main().findByRole("alert")).toBeInTheDocument();
  expect(name).toHaveValue(" New name ");
  fail = false;
  await user.click(save);
  expect(await main().findByRole("status")).toHaveTextContent("Saved.");
  expect(JSON.parse(String(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH").pop()![1]!.body))).toEqual({ displayName: "New name" });
  expect(save).toBeDisabled();
  // Access keys have their own page now.
  expect(main().queryByText(/Connected tools/i)).not.toBeInTheDocument();
  expect(main().queryByRole("link", { name: "Manage access keys" })).not.toBeInTheDocument();
});

it("switches appearance between System, Light and Dark and remembers it", async () => {
  backend();
  const user = userEvent.setup();
  renderApp("/settings");
  const group = within(await main().findByRole("radiogroup", { name: "Appearance" }));
  expect(group.getByRole("radio", { name: /Dark/ })).toBeChecked();
  await user.click(group.getByRole("radio", { name: /Light/ }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("orbit.theme")).toBe("light");
  await user.click(group.getByRole("radio", { name: /System/ }));
  expect(localStorage.getItem("orbit.theme")).toBe("system");
  expect(group.getByRole("radio", { name: /System/ })).toBeChecked();
  // The sidebar's account menu reads the same state.
  await user.click(screen.getByRole("button", { name: "Account menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Dark" }));
  expect(group.getByRole("radio", { name: /Dark/ })).toBeChecked();
});

it("keeps the session when sign-out fails, says so, and signs out on retry", async () => {
  let fail = true;
  backend((url) => url.endsWith("/auth/logout") ? (fail ? json({ error: "internal" }, 500) : json({ ok: true })) : undefined);
  const user = userEvent.setup();
  const { auth } = renderApp("/settings");
  await user.click(await main().findByRole("button", { name: "Sign out" }));
  expect(await main().findByRole("alert")).toBeInTheDocument();
  expect(auth.getSnapshot().user).not.toBeNull();
  fail = false;
  await user.click(main().getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(auth.getSnapshot().user).toBeNull());
});
