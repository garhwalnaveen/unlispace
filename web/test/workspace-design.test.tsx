import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { drive, json, renderApp } from "./fixtures";

const org = { id: "o_test", name: "Design studio", role: "owner", tier: "individual", trialEndsAt: null, drives: [drive] };
function renderWorkspace(path = "/") {
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
  return renderApp(path);
}

it("keeps top navigation and the drive section current inside a drive", async () => {
  renderWorkspace("/drives/d-test/");
  const nav = screen.getByRole("navigation", { name: "Main navigation" });
  expect(within(nav).getByRole("link", { name: "Your drives" })).toHaveAttribute("aria-current", "page");
  expect(within(nav).getByRole("link", { name: "Billing" })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: "Team" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "you@example.com" })).toHaveAttribute("href", "/settings");
  expect(await screen.findByText("Read only")).toBeInTheDocument();
});

it("filters the drive library and clears a no-match result", async () => {
  renderWorkspace();
  const user = userEvent.setup();
  const search = await screen.findByRole("searchbox", { name: "Search drives" });
  await user.keyboard("/");
  expect(search).toHaveFocus();
  await user.type(search, "missing");
  expect(screen.getByRole("heading", { name: "No matching drives" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Space" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("link", { name: "Space" })).toBeInTheDocument();
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
