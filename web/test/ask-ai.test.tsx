import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
import { json, session } from "./fixtures";

const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));

const models = {
  configured: true,
  models: [
    { id: "kimi-k3", name: "Kimi K3", description: "Balanced" },
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", description: "Most capable" },
  ],
  quota: { requestsUsed: 1, requestsLimit: 50, tokensUsed: 10, tokensLimit: 100000, resetsAt: Date.now() + 3_600_000 },
};

function uiStream(text: string) {
  const chunks = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish-step" },
    { type: "finish" },
  ];
  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
  });
}

function renderAt(path: string) {
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
}

it("streams a managed Kimi answer with the selected model and the session token", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/ai/models")) return json(models);
    if (url.endsWith("/ai/chat")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${session.accessToken}`);
      bodies.push(JSON.parse(String(init?.body)));
      return uiStream("Here is a **summary**.");
    }
    throw new Error(`Unexpected call: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  renderAt("/ai");
  expect(await screen.findByRole("heading", { name: "Ask AI" })).toBeInTheDocument();
  expect(screen.getByText(/49 of 50 free requests left today/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Ask AI" })).toHaveAttribute("href", "/ai");

  await userEvent.type(screen.getByLabelText("Message for Ask AI"), "Summarize my notes");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("summary")).toBeInTheDocument();
  expect(screen.getByText("Summarize my notes")).toBeInTheDocument();
  expect(bodies[0]).toMatchObject({ model: "kimi-k3" });
  expect((bodies[0]!.messages as { role: string }[]).at(-1)!.role).toBe("user");
  // Quota is reloaded after the answer finishes.
  await waitFor(() => expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith("/ai/models")).length).toBe(2));
});

it("explains when the free daily allowance is used up", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/ai/models")) return json(models);
    if (url.endsWith("/ai/chat")) return json({ error: "ai_quota_exceeded" }, 429);
    throw new Error(`Unexpected call: ${url}`);
  }));
  renderAt("/ai");
  await userEvent.type(await screen.findByLabelText("Message for Ask AI"), "Hello");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("You have used today's free AI allowance");
});

it("shows an unavailable state when the server has no managed AI", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ ...models, configured: false })));
  renderAt("/ai");
  expect(await screen.findByRole("heading", { name: "Ask AI is not available" })).toBeInTheDocument();
});

it("signs the desktop app's embedded Ask AI page in with a one-time handoff and PKCE verifier", async () => {
  const exchanged: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/handoff/exchange")) {
      exchanged.push(JSON.parse(String(init?.body)));
      return json(session);
    }
    if (url.endsWith("/ai/models")) return json(models);
    throw new Error(`Unexpected call: ${url}`);
  }));
  sessionStorage.setItem("unlispace.embedVerifier", "v".repeat(43));
  window.history.replaceState(null, "", "/embed/ai#handoff=h123");
  const auth = new AuthStore(localStorage, null);
  stores.push(auth);
  await auth.start();
  render(
    <MemoryRouter initialEntries={["/embed/ai"]}>
      <AuthContext value={auth}>
        <App />
      </AuthContext>
    </MemoryRouter>,
  );
  expect(await screen.findByRole("heading", { name: "Ask AI" })).toBeInTheDocument();
  expect(exchanged).toEqual([{ handoff: "h123", webCodeVerifier: "v".repeat(43) }]);
  expect(sessionStorage.getItem("unlispace.embedVerifier")).toBeNull();
  expect(window.location.hash).toBe("");
  // Embedded pages omit the web sidebar; the desktop app has its own navigation.
  expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
});
