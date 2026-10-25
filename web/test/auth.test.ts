import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStore, REFRESH_KEY } from "../src/auth";
import { deferred, json, rotated, session } from "./fixtures";

const stores: AuthStore[] = [];
function store(channel: BroadcastChannel | null = null) {
  const auth = new AuthStore(localStorage, channel);
  stores.push(auth);
  return auth;
}
afterEach(() => {
  stores.splice(0).forEach((auth) => auth.dispose());
});

class TestChannel extends EventTarget implements BroadcastChannel {
  static peers = new Set<TestChannel>();
  name = "unlispace.auth";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  constructor() {
    super();
    TestChannel.peers.add(this);
  }
  postMessage(data: unknown) {
    for (const peer of TestChannel.peers)
      if (peer !== this)
        queueMicrotask(() =>
          peer.onmessage?.(new MessageEvent("message", { data })),
        );
  }
  close() {
    TestChannel.peers.delete(this);
  }
}

describe("rotating sessions", () => {
  it("shares one refresh for concurrent 401 responses and retries with the new bearer", async () => {
    const auth = store();
    auth.accept(session);
    const refresh = deferred<Response>();
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/auth/refresh")) return refresh.promise;
        return init?.headers &&
          new Headers(init.headers).get("Authorization") === "Bearer access-new"
          ? json({ id: "u_test" })
          : json({ error: "unauthorized" }, 401);
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const first = auth.api.me();
    const second = auth.api.me();
    await vi.waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([url]) =>
          String(url).endsWith("/auth/refresh"),
        ),
      ).toHaveLength(1),
    );
    refresh.resolve(json(rotated));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: "u_test" },
      { id: "u_test" },
    ]);
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/auth/refresh"),
      ),
    ).toHaveLength(1);
  });

  it("shares a refresh and in-memory access token across two tabs", async () => {
    const first = store(new TestChannel());
    const second = store(new TestChannel());
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(rotated),
    );
    vi.stubGlobal("fetch", fetcher);
    first.accept({ ...session, expiresIn: 1 });
    await Promise.resolve();
    await Promise.all([first.start(), second.start()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.getSnapshot().user).toEqual(session.user);
    expect(second.getSnapshot().user).toEqual(session.user);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      refreshToken: "rt_old",
    });
  });

  it("refreshes proactively one minute before access expiry", async () => {
    vi.useFakeTimers();
    const auth = store();
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(rotated),
    );
    vi.stubGlobal("fetch", fetcher);
    auth.accept({ ...session, expiresIn: 120 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it("clears revoked credentials without retrying forever", async () => {
    const auth = store();
    auth.accept(session);
    const fetcher = vi.fn(async (url: string) =>
      String(url).endsWith("/auth/refresh")
        ? json({ error: "invalid_refresh" }, 401)
        : json({ error: "unauthorized" }, 401),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(auth.api.me()).rejects.toMatchObject({
      code: "invalid_refresh",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(auth.getSnapshot().user).toBeNull();
  });

  it("keeps the refresh credential after a network failure so retry is possible", async () => {
    const auth = store();
    auth.accept({ ...session, expiresIn: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Network unavailable")),
    );
    await auth.start();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(auth.getSnapshot()).toMatchObject({
      ready: true,
      error: "Network unavailable",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => json(rotated)),
    );
    await auth.refresh();
    expect(auth.getSnapshot().user).toEqual(session.user);
  });

  it("signs out all tabs and revokes the current refresh token", async () => {
    const first = store(new TestChannel());
    const second = store(new TestChannel());
    first.accept(session);
    await Promise.resolve();
    const fetcher = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await first.logout();
    await Promise.resolve();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(second.getSnapshot().user).toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/auth/logout"),
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: "rt_old" }),
      }),
    );
  });
});

it("discards legacy persisted credentials and starts signed out when no live tab exists", async () => {
  localStorage.setItem(REFRESH_KEY, "legacy-secret");
  const auth = store();
  await auth.start();
  expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
  expect(auth.getSnapshot()).toMatchObject({ ready: true, user: null });
  expect(fetch).not.toHaveBeenCalled();
});
it("recovers the session from a live tab without writing browser storage", async () => {
  const first = store(new TestChannel());
  first.accept(session);
  await Promise.resolve();
  const second = store(new TestChannel());
  await second.start();
  expect(second.getSnapshot().user).toEqual(session.user);
  expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it("signs out after all live sessions are disposed", async () => {
  const first = store(new TestChannel());
  first.accept(session);
  first.dispose();
  const second = store(new TestChannel());
  await second.start();
  expect(second.getSnapshot().user).toBeNull();
});
it("lets a user explicitly retry a failed refresh even when their old access token is still fresh", async () => {
  const auth = store();
  auth.accept(session);
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
    json(rotated),
  );
  vi.stubGlobal("fetch", fetcher);
  await auth.retry();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
});
it("ignores a delayed broadcast from a signed-out session", async () => {
  const first = store(new TestChannel());
  const observer = new TestChannel();
  let snapshot: unknown;
  observer.onmessage = ({ data }) => { if (data.type === "session") snapshot = data; };
  first.accept(session);
  await Promise.resolve();
  vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true })));
  await first.logout();
  observer.postMessage(snapshot);
  await Promise.resolve();
  expect(first.getSnapshot().user).toBeNull();
  observer.close();
});
it("uses one rotation when two tabs receive 401 at once", async () => {
  const first = store(new TestChannel());
  const second = store(new TestChannel());
  first.accept(session);
  await Promise.resolve();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/refresh")) return json(rotated);
    return new Headers(init?.headers).get("Authorization") === "Bearer access-new" ? json({ id: "u_test" }) : json({ error: "unauthorized" }, 401);
  });
  vi.stubGlobal("fetch", fetcher);
  await Promise.all([first.api.me(), second.api.me()]);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/auth/refresh"))).toHaveLength(1);
});
