import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { Landing, LandingNavigation } from "../src/Landing";
import { authStore, renderWithAuth, signedOutStore } from "./fixtures";

async function showLanding(signedIn = false) {
  const auth = signedIn ? authStore() : await signedOutStore();
  renderWithAuth(<><LandingNavigation /><Landing /></>, "/", auth);
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
  for (const link of screen.getAllByRole("link", { name: "Get early access" })) expect(link).toHaveAttribute("href", "/login");
  expect(fetch).not.toHaveBeenCalled();
});

it("sends signed-in visitors back to their workspace", async () => {
  await showLanding(true);
  for (const link of screen.getAllByRole("link", { name: "Get early access" })) expect(link).toHaveAttribute("href", "/");
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

it("introduces Orbit, explains early access honestly, and answers every FAQ", async () => {
  await showLanding();
  expect(screen.getByRole("heading", { level: 1, name: "Your work. All in Orbit." })).toBeInTheDocument();
  for (const name of [
    "Big ideas deserve a little more space.",
    "Everything in reach. Nothing in the way.",
    "Your files. Your favorite tools.",
    "Give AI a place on the project.",
    "Less handoff. More headway.",
    "Your next chapter starts here.",
    "Good questions. Straight answers.",
  ]) expect(screen.getByRole("heading", { name })).toBeInTheDocument();
  for (const name of ["Personal", "Developers", "Teams"]) {
    const plan = screen.getByRole("article", { name });
    expect(within(plan).getAllByRole("listitem")).toHaveLength(3);
  }
  expect(screen.getByText("Orbit is in early access. Final features, limits, availability, and pricing will be shared before paid enrollment.")).toBeInTheDocument();
  expect(screen.queryByText(/7-day trial|seven-day trial|No credit card required/i)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Explore the docs" })).toHaveAttribute("href", "https://orbitfs.io/docs");
  for (const name of ["Let’s talk", "Talk to us"]) {
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", "https://orbitfs.io/contact");
  }
  expect(screen.queryByText(/OrbitFS/)).not.toBeInTheDocument();
  const faq = screen.getByRole("region", { name: "Good questions. Straight answers." });
  const questions = faq.querySelectorAll("summary");
  expect(questions).toHaveLength(6);
  for (const question of questions) {
    await userEvent.click(question);
    expect(question.parentElement).toHaveAttribute("open");
    expect(question.parentElement!.querySelector("p")).toBeVisible();
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    expect(document.querySelector(link.hash)).toBeInTheDocument();
  }
});
