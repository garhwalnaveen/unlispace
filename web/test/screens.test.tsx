import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import { Desktop } from "../src/AuthPages";
import { drive, json, session } from "./fixtures";
const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));
function renderApp(path = "/") {
  const auth = new AuthStore(localStorage, null);
  stores.push(auth);
  auth.accept(session);
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext value={auth}>
        <App />
      </AuthContext>
    </MemoryRouter>,
  );
  return auth;
}
const org = {
  id: "o_test",
  name: "My Space",
  role: "owner",
  tier: "individual",
  trialEndsAt: Date.now() + 86_400_000,
  drives: [drive],
};
it("shows the trial, explains plan limits, and requires exact drive-name confirmation before deletion", async () => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return json({ error: "plan_limit" }, 403);
    if (init?.method === "DELETE") return json({ ok: true });
    if (url.endsWith("/orgs")) return json({ orgs: [org] });
    throw new Error(`Unexpected call: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  renderApp();
  expect(await screen.findByText(/1 trial day remaining/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /New drive/ }));
  await user.type(screen.getByLabelText("Drive name"), "Another drive");
  await user.click(screen.getByRole("button", { name: "Save drive" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Individual plan includes one drive",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByText("Drive options"));
  await user.click(screen.getByRole("button", { name: "Delete Space" }));
  const deletion = screen.getByRole("button", { name: "Delete drive" });
  expect(deletion).toBeDisabled();
  await user.type(screen.getByLabelText("Type “Space” to confirm"), "space");
  expect(deletion).toBeDisabled();
  await user.clear(screen.getByLabelText("Type “Space” to confirm"));
  await user.type(screen.getByLabelText("Type “Space” to confirm"), "Space");
  await user.click(deletion);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(true),
  );
});
it("opens a file with a drive read token and shows its version history", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/token")) {
      expect(init?.body).toBe(JSON.stringify({ access: "read" }));
      return json({
        token: "drive-only",
        expiresAt: Date.now() + 900_000,
        endpoint: "https://data.example",
        driveId: drive.id,
      });
    }
    if (parsed.origin === "https://data.example") {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer drive-only",
      );
      expect(parsed.searchParams.get("path")).toBe("a #?.txt");
      if (parsed.pathname.endsWith("/versions"))
        return json({
          cursor: null,
          versions: [
            {
              versionId: "v_old",
              size: 3,
              seq: 1,
              ts: 1000,
              actor: "u_test",
              op: "put",
            },
          ],
        });
      return json({
        path: "a #?.txt",
        type: "file",
        versionId: "v_head",
        size: 3,
        contentType: "text/plain",
        mtimeMs: 2000,
        seq: 2,
      });
    }
    return json(drive);
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  renderApp("/drives/d-test/a%20%23%3F.txt");
  expect(await screen.findByText("v_head")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Show in Finder/ })).toHaveAttribute(
    "href",
    "uls://open?drive=d-test&path=a+%23%3F.txt",
  );
  await user.click(screen.getByRole("button", { name: "Version history" }));
  expect(await screen.findByText("v_old")).toBeInTheDocument();
});
it("keeps desktop state and challenge through sign-in", async () => {
  const auth = new AuthStore(localStorage, null);
  stores.push(auth);
  await auth.start();
  const query = `state=original%2Bstate&code_challenge=${"a".repeat(43)}`;
  render(
    <MemoryRouter initialEntries={[`/desktop?${query}`]}>
      <AuthContext value={auth}>
        <Routes>
          <Route path="/desktop" element={<Desktop />} />
          <Route path="/login" element={<p>Login</p>} />
        </Routes>
      </AuthContext>
    </MemoryRouter>,
  );
  expect(await screen.findByText("Login")).toBeInTheDocument();
});
