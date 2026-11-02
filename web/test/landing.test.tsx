import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Landing, LandingNavigation } from "../src/Landing";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import { session } from "./fixtures";

const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.dispose()));
async function showLanding(signedIn = false) {
  const auth = new AuthStore(localStorage, null);
  stores.push(auth);
  if (signedIn) auth.accept(session); else await auth.start();
  render(<MemoryRouter><AuthContext value={auth}><LandingNavigation /><Landing /></AuthContext></MemoryRouter>);
}

it("switches example drives without requesting account data and links new visitors to sign-in", async () => {
  await showLanding();
  expect(screen.getByRole("table", { name: "Example files in Studio" })).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Development" }));
  expect(screen.getByRole("button", { name: "Development" })).toHaveAttribute("aria-pressed", "true");
  expect(within(screen.getByRole("table", { name: "Example files in Development" })).getByText("config.json")).toBeInTheDocument();
  expect(screen.queryByText("Website explorations.fig")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Personal" }));
  expect(within(screen.getByRole("table", { name: "Example files in Personal" })).getByText("Travel plans.md")).toBeInTheDocument();
  for (const link of screen.getAllByRole("link", { name: "Get started with Orbit" })) expect(link).toHaveAttribute("href", "/login");
  expect(fetch).not.toHaveBeenCalled();
});

it("sends signed-in visitors back to their workspace", async () => {
  await showLanding(true);
  for (const link of screen.getAllByRole("link", { name: "Open your workspace" })) expect(link).toHaveAttribute("href", "/");
});

it("opens product navigation, resolves its section links, and closes with Escape", async () => {
  await showLanding();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Product navigation menu" });
  await user.click(trigger);
  const menu = screen.getByRole("menu");
  for (const label of ["Cloud drives", "Orbit for Mac", "Shared workspaces", "Ask AI"]) {
    const item = within(menu).getByRole("menuitem", { name: new RegExp(label) });
    expect(document.querySelector(item.getAttribute("href")!)).toBeInTheDocument();
  }
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
