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
  for (const link of screen.getAllByRole("link", { name: "Get Early Access" })) expect(link).toHaveAttribute("href", "/login");
  expect(fetch).not.toHaveBeenCalled();
});

it("sends signed-in visitors back to their workspace", async () => {
  await showLanding(true);
  for (const link of screen.getAllByRole("link", { name: "Get Early Access" })) expect(link).toHaveAttribute("href", "/");
});

it("opens product navigation, resolves its section links, and closes with Escape", async () => {
  await showLanding();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Product navigation menu" });
  await user.click(trigger);
  const menu = screen.getByRole("menu");
  for (const label of ["Cloud files", "Desktop workflows", "Shared workspaces", "Agent workspaces"]) {
    const item = within(menu).getByRole("menuitem", { name: new RegExp(label) });
    expect(document.querySelector(item.getAttribute("href")!)).toBeInTheDocument();
  }
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("shows the supplied early-access copy, proposed plans, and FAQ questions", async () => {
  await showLanding();
  expect(screen.getByRole("heading", { level: 1, name: "One filesystem for people and AI agents" })).toBeInTheDocument();
  for (const name of [
    "One file. Two places. No handoff.",
    "Your work moves. Your files stay put.",
    "Find files. Keep context.",
    "Built for people and processes",
    "Control the workspace, not every transfer.",
    "Plans that grow with your workflow",
    "Frequently asked questions",
    "Give your work room to move.",
  ]) expect(screen.getByRole("heading", { name })).toBeInTheDocument();
  for (const name of ["Personal", "Developers", "Teams"]) {
    const plan = screen.getByRole("article", { name });
    expect(within(plan).getAllByRole("listitem")).toHaveLength(7);
  }
  expect(screen.getByText("Plans are proposals. Final features, limits, availability, and pricing will be published before paid enrollment.")).toBeInTheDocument();
  expect(screen.queryByText(/7-day trial|seven-day trial|No credit card required/i)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Building with OrbitFS? Explore the docs." })).toHaveAttribute("href", "https://orbitfs.io/docs");
  for (const name of ["Deploying for a team? Talk to us.", "Contact us", "Contact sales"]) {
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", "https://orbitfs.io/contact");
  }
  const faq = screen.getByRole("region", { name: "Frequently asked questions" });
  expect(within(faq).getAllByRole("heading", { level: 3 })).toHaveLength(13);
  await userEvent.click(within(faq).getByText("What is OrbitFS?"));
  expect(within(faq).getByText(/Supported devices, integrations, and performance will be confirmed at launch/)).toBeVisible();
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    expect(document.querySelector(link.hash)).toBeInTheDocument();
  }
});
