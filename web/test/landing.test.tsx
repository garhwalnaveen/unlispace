import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Landing, LandingNavigation } from "../src/Landing";
import { authStore, renderWithAuth, signedOutStore } from "./fixtures";

const catalog = {
  plans: [
    { id: "individual", name: "Individual", bytesPerSeat: 500_000_000_000, minSeats: 1, maxSeats: 1 },
    { id: "teams", name: "Teams", bytesPerSeat: 1_000_000_000_000, minSeats: 1, maxSeats: 1000 },
  ],
  storageAddon: { bytes: 500_000_000_000, maxQuantity: 1000 },
  checkoutAvailable: true,
  trialDays: 7,
  prices: {
    individual: { monthly: { amount: 1500, currency: "USD" }, annual: { amount: 15600, currency: "USD" } },
    teams: { monthly: { amount: 2500, currency: "USD" }, annual: { amount: 26400, currency: "USD" } },
    storage: { monthly: { amount: 1000, currency: "USD" }, annual: { amount: 10800, currency: "USD" } },
  },
};

async function showLanding({ signedIn = false, plans = catalog as object | null } = {}) {
  vi.mocked(fetch).mockImplementation(async (input) => {
    if (!plans || !String(input).endsWith("/billing/catalog")) throw new Error("Unexpected network request in test");
    return Response.json(plans);
  });
  const auth = signedIn ? authStore() : await signedOutStore();
  renderWithAuth(<><LandingNavigation /><Landing /></>, "/", auth);
}

it("links new visitors to sign-in", async () => {
  await showLanding();
  for (const link of screen.getAllByRole("link", { name: "Create an account" })) expect(link).toHaveAttribute("href", "/login");
});

it("sends signed-in visitors back to their drives", async () => {
  await showLanding({ signedIn: true });
  for (const link of screen.getAllByRole("link", { name: "Open your drives" })) expect(link).toHaveAttribute("href", "/");
});

it("shows plan storage, prices and trial length from the public billing catalog only", async () => {
  await showLanding();
  const individual = await screen.findByRole("article", { name: "Individual" });
  expect(await within(individual).findByText("500 GB of storage")).toBeInTheDocument();
  expect(within(individual).getByText("US$15.00")).toBeInTheDocument();
  const teams = screen.getByRole("article", { name: "Teams" });
  expect(within(teams).getByText("1 TB of pooled storage per seat")).toBeInTheDocument();
  expect(within(teams).getByText("US$25.00")).toBeInTheDocument();
  expect(screen.getByText(/add storage in 500 GB blocks/)).toBeInTheDocument();
  expect(screen.getByText(/7-day trial/)).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/billing/catalog"]);
});

it("omits prices and limits it cannot confirm when the catalog is unavailable", async () => {
  await showLanding({ plans: null });
  expect(screen.getByRole("article", { name: "Individual" })).toBeInTheDocument();
  expect(screen.queryByText(/US\$|GB|TB|trial\./)).not.toBeInTheDocument();
});

it("answers every question and resolves every in-page link", async () => {
  await showLanding();
  expect(screen.getByRole("heading", { level: 1, name: "Cloud drives that open in Finder" })).toBeInTheDocument();
  const questions = document.querySelectorAll(".faq-list details");
  expect(questions.length).toBeGreaterThan(0);
  for (const item of questions) expect(item.querySelector("p")?.textContent?.length).toBeGreaterThan(20);
  await userEvent.click(screen.getByText("Does the Mac app download all my files?"));
  expect(screen.getByText(/Files stay in the cloud until you open them/)).toBeVisible();
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) expect(document.querySelector(link.hash)).toBeInTheDocument();
  expect(document.querySelector('a[href^="http"]')).toBeNull();
});
