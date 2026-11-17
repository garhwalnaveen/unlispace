import { screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { drive, json, renderApp } from "./fixtures";

const org = { id: "o_test", name: "Design studio", role: "owner", tier: "individual", trialEndsAt: null, drives: [drive, { ...drive, id: "d-other", name: "Archive" }] };

it("marks the open drive in the sidebar and keeps admin links out of the main navigation", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/orgs") return json({ orgs: [org] });
    if (parsed.pathname === "/me/access") return json({ workspaces: [] });
    if (parsed.pathname.endsWith("/token")) return json({ token: "drive-read", endpoint: "https://data.example", driveId: drive.id, expiresAt: Date.now() + 900_000 });
    if (parsed.origin === "https://data.example") return json({ cursor: null, entries: [{ name: "a-small.txt", type: "file", size: 5, mtimeMs: 2000 }] });
    if (parsed.pathname === `/drives/${drive.id}`) return json({ ...drive, access: "read" });
    return json({ usedBytes: 0, quotaBytes: 500e9 });
  }));
  renderApp("/drives/d-test/");
  const nav = within(screen.getByRole("navigation", { name: "Main navigation" }));
  expect(await nav.findByRole("link", { name: drive.name })).toHaveAttribute("aria-current", "page");
  expect(nav.getByRole("link", { name: "Archive" })).not.toHaveAttribute("aria-current");
  expect(nav.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
  expect(nav.queryByRole("link", { name: /Billing|Team|Members/ })).not.toBeInTheDocument();
  expect(await screen.findByText("a-small.txt")).toBeInTheDocument();
  expect(await screen.findByText("View only")).toBeInTheDocument();
  expect(localStorage.getItem("orbit.lastDrive")).toBe(drive.id);
});
