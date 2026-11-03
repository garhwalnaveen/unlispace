import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import { drive, json, session } from "./fixtures";

const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));
const org = { id: "o_test", name: "Design studio", role: "owner", tier: "individual", trialEndsAt: null, drives: [drive] };
function renderWorkspace(path = "/") {
  const auth = new AuthStore(localStorage, null);
  stores.push(auth);
  auth.accept(session);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/orgs") return json({ orgs: [org] });
    if (parsed.pathname === "/me/access") return json({ workspaces: [] });
    if (parsed.pathname === "/keys") return json({ keys: [] });
    if (parsed.pathname.endsWith("/token")) return json({ token: "drive-read", endpoint: "https://data.example", driveId: drive.id, expiresAt: Date.now() + 900_000 });
    if (parsed.origin === "https://data.example") return json({ cursor: "next", entries: [
      { name: "z-folder/", type: "folder", size: 0, mtimeMs: 1000 },
      { name: "a-small.txt", type: "file", size: 5, mtimeMs: 2000 },
      { name: "b-large.txt", type: "file", size: 500, mtimeMs: 3000 },
    ] });
    if (parsed.pathname === `/drives/${drive.id}`) return json({ ...drive, access: "read" });
    return json({ usedBytes: 0, quotaBytes: 500e9 });
  }));
  return render(<MemoryRouter initialEntries={[path]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>);
}

it("groups persistent navigation and keeps the drive section current inside a drive", async () => {
  renderWorkspace("/drives/d-test/");
  const nav = screen.getByRole("navigation", { name: "Main navigation" });
  expect(within(nav).getByRole("link", { name: "Your drives" })).toHaveAttribute("aria-current", "page");
  expect(within(nav).getByText("Workspace")).toBeInTheDocument();
  expect(within(nav).getByText("Manage")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Your account.*you@example.com/ })).toHaveAttribute("href", "/settings");
  expect(await screen.findByText("Read only")).toBeInTheDocument();
});

it("discloses mobile navigation, closes it on Escape and navigation, and restores it on desktop", async () => {
  let resize = () => {};
  const media = { matches: true, addEventListener: vi.fn((_event, callback) => { resize = callback; }), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", (query: string) => query.includes("max-width") ? media : { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  renderWorkspace();
  const user = userEvent.setup();
  expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open navigation" }));
  expect(screen.getByRole("button", { name: "Close navigation" })).toHaveAttribute("aria-expanded", "true");
  const nav = screen.getByRole("navigation", { name: "Main navigation" });
  within(nav).getByRole("link", { name: "Account" }).focus();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Open navigation" }));
  await user.click(screen.getByRole("link", { name: "Access keys" }));
  expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  act(() => { media.matches = false; resize(); });
  expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
});

it("filters the drive library and recovers from no matches without an API change", async () => {
  renderWorkspace();
  const user = userEvent.setup();
  const search = await screen.findByRole("textbox", { name: "Find a drive" });
  expect(screen.getByRole("region", { name: "Workspace summary" })).toHaveTextContent("1Active drive1Workspace");
  await user.type(search, "missing");
  expect(screen.getByRole("heading", { name: "No matching drives" })).toBeInTheDocument();
  expect(screen.queryByRole("article", { name: "Space" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByRole("article", { name: "Space" })).toBeInTheDocument();
});

it("filters only loaded files, keeps folders first when sorting, and preserves pagination", async () => {
  renderWorkspace("/drives/d-test/");
  const user = userEvent.setup();
  await screen.findByText("b-large.txt");
  const files = screen.getByRole("list", { name: "Files and folders" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Sort loaded items" }), "size");
  expect(within(files).getAllByRole("link")).toHaveLength(3);
  expect(within(files).getAllByRole("link")[0]).toHaveTextContent("z-folder");
  expect(within(files).getAllByRole("link")[1]).toHaveTextContent("b-large.txt");
  const filter = screen.getByRole("textbox", { name: "Filter loaded items" });
  await user.type(filter, "absent");
  expect(screen.getByRole("heading", { name: "No matching files" })).toBeInTheDocument();
  expect(screen.getByText(/Load more items to search further/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Clear filter" }));
  await waitFor(() => expect(within(files).getAllByRole("link")).toHaveLength(3));
  expect(screen.queryByLabelText("Choose files")).not.toBeInTheDocument();
});
