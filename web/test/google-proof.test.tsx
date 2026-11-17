import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { Callback, googleSignIn, GOOGLE_VERIFIER_KEY } from "../src/AuthPages";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import { readOnboarding } from "../src/onboarding/state";
import { json, session } from "./fixtures";

let auth: AuthStore;
function renderCallback(fragment: string) {
  window.history.replaceState(null, "", `/auth/callback${fragment}`);
  auth = new AuthStore(localStorage, null);
  render(<MemoryRouter><AuthContext value={auth}><Callback /></AuthContext></MemoryRouter>);
}
afterEach(() => { auth?.dispose(); window.history.replaceState(null, "", "/"); });

it("creates a browser-held proof and sends only its challenge to Google start", async () => {
  const url = new URL(await googleSignIn("/"));
  const verifier = sessionStorage.getItem(GOOGLE_VERIFIER_KEY)!;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(url.searchParams.get("web_code_challenge")).toBe(challenge);
  expect(url.toString()).not.toContain(verifier);
});
it("rejects copied callbacks before exchanging a session", async () => {
  renderCallback("#handoff=copied");
  expect(await screen.findByRole("alert")).toHaveTextContent("Start Google sign-in in this browser");
  expect(screen.getByRole("heading", { name: "Sign-in didn't finish" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login?return=%2F");
  expect(fetch).not.toHaveBeenCalled();
});
it("exchanges with the originating proof and removes it", async () => {
  await googleSignIn("/"); const verifier = sessionStorage.getItem(GOOGLE_VERIFIER_KEY);
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => json(session)); vi.stubGlobal("fetch", fetcher);
  renderCallback("#handoff=valid");
  expect(screen.getByRole("heading", { name: "Signing you in…" })).toBeInTheDocument();
  await waitFor(() => expect(auth.getSnapshot().user).toEqual(session.user));
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ handoff: "valid", webCodeVerifier: verifier });
  expect(sessionStorage.getItem(GOOGLE_VERIFIER_KEY)).toBeNull();
  expect(window.location.hash).toBe("");
  expect(readOnboarding()).toBeNull();
});
it("starts onboarding when Google sign-in created the account", async () => {
  await googleSignIn("/");
  vi.stubGlobal("fetch", vi.fn(async () => json({ ...session, accountCreated: true })));
  renderCallback("#handoff=valid");
  await waitFor(() => expect(auth.getSnapshot().user).toEqual(session.user));
  expect(readOnboarding()).toMatchObject({ status: "pending", user: session.user.id });
});
it("says plainly when Google sign-in was cancelled, without contacting the server", async () => {
  renderCallback("#error=access_denied");
  expect(await screen.findByRole("alert")).toHaveTextContent("Google sign-in was cancelled.");
  expect(screen.getByText("Nothing was changed on your account.")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
it("reports a refused exchange and offers the way back", async () => {
  await googleSignIn("/");
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid_code" }, 400)));
  renderCallback("#handoff=stale");
  expect(await screen.findByRole("alert")).toHaveTextContent("invalid or has expired");
  expect(screen.getByRole("link", { name: "Back to sign in" })).toBeInTheDocument();
  expect(auth.getSnapshot().user).toBeNull();
});
