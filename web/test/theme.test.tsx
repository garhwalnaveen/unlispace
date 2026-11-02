import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";

it("follows system appearance, persists a manual choice and restores system tracking", async () => {
  let onChange = () => {};
  const media = {
    matches: false,
    addEventListener: vi.fn((_event, callback) => { onChange = callback; }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", () => media);
  localStorage.setItem("orbit.theme", "system");
  const auth = new AuthStore(localStorage, null);
  await auth.start();
  const view = render(<MemoryRouter initialEntries={["/login"]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>);
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "Use system theme" })).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement.dataset.theme).toBe("light");
  act(() => { media.matches = true; onChange(); });
  expect(document.documentElement.dataset.theme).toBe("dark");
  await user.click(screen.getByRole("button", { name: "Use light theme" }));
  expect(localStorage.getItem("orbit.theme")).toBe("light");
  act(() => onChange());
  expect(document.documentElement.dataset.theme).toBe("light");
  await user.click(screen.getByRole("button", { name: "Use system theme" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  view.unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  auth.dispose();
});


it("defaults to dark and retains a saved light choice", async () => {
  const auth = new AuthStore(localStorage, null);
  await auth.start();
  const view = render(<MemoryRouter initialEntries={["/login"]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>);
  expect(screen.getByRole("button", { name: "Use dark theme" })).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement.dataset.theme).toBe("dark");
  await userEvent.click(screen.getByRole("button", { name: "Use light theme" }));
  view.unmount();
  render(<MemoryRouter initialEntries={["/login"]}><AuthContext value={auth}><App /></AuthContext></MemoryRouter>);
  expect(screen.getByRole("button", { name: "Use light theme" })).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement.dataset.theme).toBe("light");
  auth.dispose();
});
