import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Desktop } from "../src/AuthPages";
import { desktopCallback } from "../src/links";
import { readOnboarding, startOnboarding } from "../src/onboarding/state";
import { deferred, drive, json, renderApp, renderWithAuth, session, signedOutStore } from "./fixtures";

vi.mock("../src/links", async (original) => {
  const actual = await original<typeof import("../src/links")>();
  return { ...actual, desktopCallback: vi.fn(actual.desktopCallback) };
});

const challenge = "a".repeat(43);
const desktopQuery = (extra: Record<string, string> = {}) => new URLSearchParams({ state: "s+1", code_challenge: challenge, ...extra });
function renderDesktop() {
  return renderWithAuth(<Desktop />, `/desktop?${desktopQuery()}`);
}
const orgs = (ready: boolean) => ({ orgs: [{ drives: [{ ...drive, status: ready ? "ready" : "provisioning_failed" }] }] });
const heading = () => screen.getByRole("heading", { level: 1 });

it("shows one state at a time: setting up the drive, then the single Open Orbit action", async () => {
  vi.useFakeTimers();
  let ready = false;
  const fetcher = vi.fn(async () => json(orgs(ready)));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => { renderDesktop(); });
  expect(heading()).toHaveTextContent("Setting up your drive");
  expect(screen.getByText("you@example.com")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open Orbit" })).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  ready = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(heading()).toHaveTextContent("Connect Orbit on this Mac");
  expect(screen.getByRole("button", { name: "Open Orbit" })).toBeEnabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("bounds drive checks, reassures instead of failing, and lets the person try again", async () => {
  vi.useFakeTimers();
  let ready = false;
  const fetcher = vi.fn(async () => json(orgs(ready)));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => { renderDesktop(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(10);
  expect(heading()).toHaveTextContent("Your drive isn't ready yet");
  expect(screen.getByText(/Your account is safe/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open Orbit" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Continue on the web" })).toHaveAttribute("href", "/");
  ready = true;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
  expect(screen.getByRole("button", { name: "Open Orbit" })).toBeEnabled();
  expect(fetcher).toHaveBeenCalledTimes(11);
});

it("stops on a network failure and clears it when trying again succeeds", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("Network unavailable")).mockResolvedValueOnce(json(orgs(true)));
  vi.stubGlobal("fetch", fetcher);
  renderDesktop();
  expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Orbit" })).toBeEnabled();
});

it("cancels pending checks when the page closes", async () => {
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

it("hands the one-time code to the app with the original state and challenge, then says the tab can be closed", async () => {
  startOnboarding(session.user.id);
  let minted = 0;
  const code = deferred<Response>();
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/orgs")) return json(orgs(true));
    if (url.endsWith("/desktop/code")) return ++minted === 1 ? code.promise : json({ code: "second" });
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const user = userEvent.setup();
  renderDesktop();
  await user.click(await screen.findByRole("button", { name: "Open Orbit" }));
  expect(heading()).toHaveTextContent("Opening Orbit");
  expect(screen.queryByRole("button", { name: "Open Orbit" })).not.toBeInTheDocument();
  await act(async () => { code.resolve(json({ code: "first" })); });
  expect(await screen.findByRole("heading", { name: "You can close this tab" })).toBeInTheDocument();
  const request = fetcher.mock.calls.find(([url]) => url.endsWith("/desktop/code"));
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ state: "s+1", codeChallenge: challenge });
  expect(desktopCallback).toHaveBeenLastCalledWith("first", "s+1");
  expect(vi.mocked(desktopCallback).mock.results[0].value).toMatch(/^uls:\/\/auth\/callback#/);
  // A new account that connected its Mac does not get the web welcome afterwards.
  expect(readOnboarding()).toMatchObject({ status: "done", macOpened: true });
  await user.click(screen.getByRole("button", { name: "Open Orbit again" }));
  await waitFor(() => expect(desktopCallback).toHaveBeenLastCalledWith("second", "s+1"));
  expect(screen.getByRole("link", { name: "Open your files on the web" })).toHaveAttribute("href", "/");
});

it("keeps Open Orbit available when the code cannot be issued, and records nothing", async () => {
  const fetcher = vi.fn(async (url: string) => url.endsWith("/orgs") ? json(orgs(true)) : json({ error: "temporarily_unavailable", message: "Try again shortly." }, 503));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  renderDesktop();
  await user.click(await screen.findByRole("button", { name: "Open Orbit" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Try again shortly.");
  expect(screen.getByRole("button", { name: "Open Orbit" })).toBeEnabled();
  expect(desktopCallback).not.toHaveBeenCalled();
  expect(readOnboarding()).toBeNull();
});

it("does not start a Get started list for an account that already existed", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/orgs") ? json(orgs(true)) : json({ code: "c" })));
  vi.spyOn(console, "error").mockImplementation(() => {});
  renderDesktop();
  await userEvent.click(await screen.findByRole("button", { name: "Open Orbit" }));
  await screen.findByRole("heading", { name: "You can close this tab" });
  expect(readOnboarding()).toBeNull();
});

it("refuses an incomplete link before any request and points back to the Mac app", async () => {
  renderWithAuth(<Desktop />, "/desktop?state=only");
  expect(screen.getByRole("heading", { name: "Start again from the Mac app" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("incomplete or invalid");
  expect(screen.queryByRole("button", { name: "Open Orbit" })).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("switch=1 signs the web session out once and keeps the desktop parameters for sign-in", async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/auth/logout")) return json({ ok: true });
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  renderApp(`/desktop?${desktopQuery({ switch: "1" })}`);
  expect(await screen.findByRole("heading", { name: "Sign in to Orbit" })).toBeInTheDocument();
  expect(screen.getByText("Sign in to connect Orbit on this Mac.")).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/auth/logout"))).toHaveLength(1);
  // The Google button records the return target without `switch`, so the user cannot loop.
  await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await waitFor(() => expect(sessionStorage.getItem("orbit.return")).toBe(`/desktop?${desktopQuery()}`));
});

it("switch=1 without a web session goes straight to sign-in", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network expected"); }));
  renderApp(`/desktop?${desktopQuery({ switch: "1" })}`, await signedOutStore());
  expect(await screen.findByRole("heading", { name: "Sign in to Orbit" })).toBeInTheDocument();
});

it("says so when switch=1 cannot sign out, and offers to continue as the current account", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "request_failed", message: "Sign-out failed." }, 500)));
  renderApp(`/desktop?${desktopQuery({ switch: "1" })}`);
  expect(await screen.findByRole("heading", { name: "Could not sign out" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Sign-out failed.");
  expect(screen.getByRole("link", { name: "Continue as you@example.com" })).toHaveAttribute("href", `/desktop?${desktopQuery()}`);
});

it("offers Use a different account and keeps the desktop request through email sign-in", async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/auth/logout")) return json({ ok: true });
    if (url.endsWith("/otp/start")) return json({ ok: true });
    if (url.endsWith("/otp/verify")) return json({ ...session, user: { id: "u2", email: "other@example.com" } });
    if (url.endsWith("/orgs")) return json(orgs(true));
    if (url.endsWith("/desktop/code")) return json({ error: "temporarily_unavailable" }, 503);
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  renderApp(`/desktop?${desktopQuery()}`);
  await screen.findByRole("heading", { name: "Connect Orbit on this Mac" });
  expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Use a different account" }));
  await user.type(await screen.findByLabelText("Email address"), "first@example.com");
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.click(await screen.findByRole("button", { name: "Use a different email" }));
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "other@example.com" } });
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await user.type(await screen.findByLabelText("Verification code"), "123456");
  expect(await screen.findByRole("heading", { name: "Connect Orbit on this Mac" })).toBeInTheDocument();
  expect(screen.getByText("other@example.com")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open Orbit" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  const request = fetcher.mock.calls.find(([url]) => url.endsWith("/desktop/code"));
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ state: "s+1", codeChallenge: challenge });
});

it("going back from the code step to Google keeps the desktop return target", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (url.endsWith("/otp/start")) return json({ ok: true }); throw new Error(url); }));
  const user = userEvent.setup();
  renderApp(`/desktop?${desktopQuery()}`, await signedOutStore());
  await user.type(await screen.findByLabelText("Email address"), "x@example.com");
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await screen.findByLabelText("Verification code");
  // The code step has one job; Google comes back with the email step.
  expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Use a different email" }));
  await user.click(screen.getByRole("button", { name: "Continue with Google" }));
  await waitFor(() => expect(sessionStorage.getItem("orbit.return")).toBe(`/desktop?${desktopQuery()}`));
});
