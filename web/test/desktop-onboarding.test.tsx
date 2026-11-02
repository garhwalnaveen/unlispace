import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Desktop } from "../src/AuthPages";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import { deferred, drive, json, session } from "./fixtures";

const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.dispose()));
function renderDesktop() {
  const auth = new AuthStore(localStorage, null);
  stores.push(auth); auth.accept(session);
  return render(<MemoryRouter initialEntries={[`/desktop?state=original&code_challenge=${"a".repeat(43)}`]}>
    <AuthContext value={auth}><Desktop /></AuthContext>
  </MemoryRouter>);
}
const orgs = (ready: boolean) => ({ orgs: [{ drives: [{ ...drive, status: ready ? "ready" : "provisioning_failed" }] }] });

it("waits for real storage readiness before allowing the desktop handoff", async () => {
  vi.useFakeTimers();
  let ready = false;
  const fetcher = vi.fn(async () => json(orgs(ready)));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => { renderDesktop(); });
  expect(screen.getByRole("button", { name: "Open Orbit" })).toBeDisabled();
  expect(screen.getByRole("heading")).toHaveTextContent("Preparing your Orbit");
  ready = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole("heading")).toHaveTextContent("Your Orbit is ready");
  expect(screen.getByRole("button", { name: "Open Orbit" })).toBeEnabled();
  expect(screen.getByText("Drive ready")).toBeInTheDocument();
  expect(screen.getByText("Connect your Mac")).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("bounds provisioning checks and lets the user retry after the deadline", async () => {
  vi.useFakeTimers();
  let ready = false;
  const fetcher = vi.fn(async () => json(orgs(ready)));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => { renderDesktop(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(10);
  expect(screen.getByRole("button", { name: "Open Orbit" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "View drives in browser" })).toHaveAttribute("href", "/");
  ready = true;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry drive setup" })); });
  expect(screen.getByRole("button", { name: "Open Orbit" })).toBeEnabled();
  expect(fetcher).toHaveBeenCalledTimes(11);
});

it("stops on a network failure and clears it when retry succeeds", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("Network unavailable")).mockResolvedValueOnce(json(orgs(true)));
  vi.stubGlobal("fetch", fetcher);
  renderDesktop();
  expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry drive setup" })); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Orbit" })).toBeEnabled();
});

it("cancels pending polling when the desktop page closes", async () => {
  vi.useFakeTimers();
  const response = deferred<Response>();
  const fetcher = vi.fn(() => response.promise);
  vi.stubGlobal("fetch", fetcher);
  const view = renderDesktop();
  view.unmount();
  await act(async () => { response.resolve(json(orgs(false))); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
