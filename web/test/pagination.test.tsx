import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Api, DriveApi, type ListPage } from "../src/api";
import { useListing, useVersions } from "../src/usePagination";
import { deferred, json } from "./fixtures";
const entry = (name: string) => ({
  name,
  type: "file" as const,
  size: 3,
  versionId: `v_${name}`,
  mtimeMs: 1000,
});
function client() {
  const control = new Api(
    vi.fn().mockResolvedValue({
      token: "drive-read",
      endpoint: "https://data.example",
      expiresAt: Date.now() + 900_000,
      driveId: "d-test",
    }),
  );
  return new DriveApi(control, "d-test");
}
describe("folder pagination", () => {
  it("uses drive authorization, preserves existing entries and follows opaque cursors once", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer drive-read",
      );
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://data.example");
      expect(parsed.searchParams.get("path")).toBe("a folder/");
      return json(
        parsed.searchParams.has("cursor")
          ? { entries: [entry("b")], cursor: null }
          : { entries: [entry("a")], cursor: "opaque+/=" },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const api = client();
    const { result } = renderHook(() => useListing(api, "a folder/"));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    await act(async () => {
      await Promise.all([result.current.loadMore(), result.current.loadMore()]);
    });
    expect(result.current.entries.map((item) => item.name)).toEqual(["a", "b"]);
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("cursor")).toBe(
      "opaque+/=",
    );
    expect(result.current.cursor).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("discards a late page after navigation to a different folder", async () => {
    const pending = deferred<ListPage>();
    const api = client();
    vi.spyOn(api, "list").mockImplementation(async (path) =>
      path === "old/"
        ? pending.promise
        : { entries: [entry("new")], cursor: null },
    );
    const { result, rerender } = renderHook(
      ({ path }) => useListing(api, path),
      { initialProps: { path: "old/" } },
    );
    rerender({ path: "new/" });
    await waitFor(() => expect(result.current.entries[0]?.name).toBe("new"));
    await act(async () =>
      pending.resolve({ entries: [entry("stale")], cursor: "old-cursor" }),
    );
    expect(result.current.entries.map((item) => item.name)).toEqual(["new"]);
    expect(result.current.cursor).toBeNull();
  });
  it("keeps the cursor and entries on page errors so the user can retry", async () => {
    const api = client();
    vi.spyOn(api, "list")
      .mockResolvedValueOnce({ entries: [entry("a")], cursor: "next" })
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce({ entries: [entry("b")], cursor: null });
    const { result } = renderHook(() => useListing(api, ""));
    await waitFor(() => expect(result.current.cursor).toBe("next"));
    await act(async () => result.current.loadMore());
    expect(result.current.error).toMatchObject({ message: "Offline" });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.cursor).toBe("next");
    await act(async () => result.current.loadMore());
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.error).toBeUndefined();
  });
});

it("loads older-first version pages without truncating history", async () => {
  const api = client();
  const version = (versionId: string, seq: number) => ({
    versionId,
    seq,
    size: 3,
    ts: 1000,
    actor: "u_test",
    op: "put",
  });
  const fetcher = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v0/drives/d-test/versions");
    expect(parsed.searchParams.get("path")).toBe("file.txt");
    return json(
      parsed.searchParams.get("cursor") === "history+next"
        ? { versions: [version("v_new", 2)], cursor: null }
        : { versions: [version("v_old", 1)], cursor: "history+next" },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useVersions(api, "file.txt"));
  await waitFor(() => expect(result.current.cursor).toBe("history+next"));
  await act(async () => result.current.loadMore());
  expect(result.current.versions.map((item) => item.versionId)).toEqual([
    "v_old",
    "v_new",
  ]);
  expect(result.current.cursor).toBeNull();
});
