import { describe, expect, it, vi } from "vitest";
import { assembleFile, MAX_WEB_DOWNLOAD } from "../src/download";
import type { Manifest } from "../src/api";
async function shard(value: string) {
  const bytes = new TextEncoder().encode(value).buffer;
  const h = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return { bytes, h, n: bytes.byteLength };
}
const empty: Manifest = {
  path: "a.txt",
  versionId: "v_a",
  size: 0,
  contentType: "text/plain",
  mtimeMs: 0,
  shards: [],
};
describe("downloads", () => {
  it("assembles repeated shards in manifest order and reports byte progress", async () => {
    const a = await shard("first");
    const b = await shard("second");
    const fetcher = vi.fn(async (hash: string) =>
      hash === a.h ? a.bytes : b.bytes,
    );
    const progress = vi.fn();
    const blob = await assembleFile(
      { ...empty, size: 16, shards: [a, b, a] },
      fetcher,
      progress,
    );
    expect(await blob.text()).toBe("firstsecondfirst");
    expect(fetcher.mock.calls.map(([hash]) => hash)).toEqual([a.h, b.h, a.h]);
    expect(progress.mock.calls.map(([bytes]) => bytes)).toEqual([0, 5, 11, 16]);
  });
  it("saves empty files without fetching shards", async () => {
    const fetcher = vi.fn();
    const blob = await assembleFile(empty, fetcher, vi.fn());
    expect(blob.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects oversized files before fetching any shards", async () => {
    const fetcher = vi.fn();
    await expect(
      assembleFile({ ...empty, size: MAX_WEB_DOWNLOAD + 1 }, fetcher, vi.fn()),
    ).rejects.toThrow("desktop app");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects truncated or corrupted shards and malformed manifests", async () => {
    const part = await shard("abc");
    const manifest = { ...empty, size: 3, shards: [part] };
    await expect(
      assembleFile(manifest, async () => new ArrayBuffer(2), vi.fn()),
    ).rejects.toThrow("incomplete");
    await expect(
      assembleFile(manifest, async () => new ArrayBuffer(3), vi.fn()),
    ).rejects.toThrow("integrity");
    await expect(
      assembleFile({ ...manifest, size: 4 }, vi.fn(), vi.fn()),
    ).rejects.toThrow("invalid size");
  });
});
