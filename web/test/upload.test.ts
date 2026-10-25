import { File } from "node:buffer";
import { expect, it, vi } from "vitest";
import { Api, DriveApi } from "../src/api";
import { uploadFile, type UploadProgress } from "../src/upload";
import { deferred, json } from "./fixtures";
function driveApi() {
  return new DriveApi(new Api(async (_path, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ access: "write" });
    return { token: "write-only", endpoint: "https://data.example", expiresAt: Date.now() + 900_000, driveId: "d-test" } as never;
  }), "d-test", "write");
}
const file = (bytes: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3])) => new File([bytes], "test.bin", { type: "application/test", lastModified: 1234 }) as unknown as globalThis.File;
it("probes dedup, uploads with a write bearer and commits ifAbsent before reporting success", async () => {
  const calls: string[] = [];
  const states: UploadProgress[] = [];
  let hash = "";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(new URL(url).pathname.split("/").pop()!);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer write-only");
    if (url.includes("/stat?")) return json({ error: "no_such_path" }, 404);
    if (url.endsWith("/missing")) { hash = JSON.parse(String(init?.body)).hashes[0]; return json({ missing: [hash] }); }
    if (init?.method === "PUT") { expect(url).toContain(hash); expect(init.body).toEqual(new Uint8Array([1, 2, 3])); return json({ stored: true }); }
    expect(JSON.parse(String(init?.body))).toEqual({ ops: [{ op: "put", path: "folder/test.bin", ifAbsent: true, size: 3, mtimeMs: 1234, contentType: "application/test", shards: [{ h: hash, n: 3 }] }] });
    expect(states.at(-1)?.phase).toBe("committing");
    return json({ seq: 1 });
  }));
  await uploadFile(driveApi(), file(), "folder/test.bin", (p) => states.push(p));
  expect(calls).toEqual(["stat", "missing", hash, "commit"]);
  expect(states.at(-1)).toEqual({ phase: "done", bytes: 3, total: 3 });
});
it("sends zero shard bytes for duplicate content and guards an overwrite with the stat version", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/stat?")) return json({ versionId: "v_base", type: "file" });
    if (url.endsWith("/missing")) return json({ missing: [] });
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body)).ops[0]).toMatchObject({ ifVersion: "v_base" });
    expect(JSON.parse(String(init?.body)).ops[0]).not.toHaveProperty("ifAbsent");
    return json({ seq: 1 });
  });
  vi.stubGlobal("fetch", fetcher);
  await uploadFile(driveApi(), file(), "test.bin", vi.fn());
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
});
it("commits an empty manifest without uploading shards", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/stat?")) return json({ error: "no_such_path" }, 404);
    expect(JSON.parse(String(init?.body)).ops[0]).toMatchObject({ size: 0, shards: [], ifAbsent: true });
    return json({ seq: 1 });
  });
  vi.stubGlobal("fetch", fetcher);
  await uploadFile(driveApi(), file(new Uint8Array()), "test.bin", vi.fn());
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("propagates a commit conflict and never reports done", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/stat?")) return json({ error: "no_such_path" }, 404);
    if (url.endsWith("/missing")) return json({ missing: [] });
    return json({ error: "precondition_failed" }, 412);
  }));
  const progress = vi.fn();
  await expect(uploadFile(driveApi(), file(), "test.bin", progress)).rejects.toMatchObject({ status: 412 });
  expect(progress.mock.calls.some(([p]) => p.phase === "done")).toBe(false);
});
it("limits shard PUT concurrency and waits for in-flight failures before returning", async () => {
  const bytes = new Uint8Array(10 * 1024 * 1024);
  // A deterministic 32-bit PRNG produces several nonidentical chunks.
  let state = 123;
  for (let i = 0; i < bytes.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[i] = state & 255; }
  const pending: ReturnType<typeof deferred<Response>>[] = [];
  let putCount = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/stat?")) return json({ error: "no_such_path" }, 404);
    if (url.endsWith("/missing")) { const hashes = JSON.parse(String(init?.body)).hashes; expect(hashes.length).toBeGreaterThan(3); return json({ missing: hashes }); }
    if (init?.method === "PUT") { putCount++; const d = deferred<Response>(); pending.push(d); return d.promise; }
    throw new Error("Must not commit after a failed PUT");
  });
  vi.stubGlobal("fetch", fetcher);
  const upload = uploadFile(driveApi(), file(bytes), "test.bin", vi.fn());
  const rejected = expect(upload).rejects.toMatchObject({ status: 503 });
  await vi.waitFor(() => expect(pending).toHaveLength(3), { timeout: 10_000 });
  pending[0].resolve(json({ error: "unavailable" }, 503));
  await new Promise((resolve) => setTimeout(resolve, 20));
  pending[1].resolve(json({ stored: true })); pending[2].resolve(json({ stored: true }));
  await rejected;
  expect(putCount).toBe(3);
});
it("does not upload on authorization errors or invalid paths", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "forbidden" }, 403)));
  await expect(uploadFile(driveApi(), file(), "test.bin", vi.fn())).rejects.toMatchObject({ status: 403 });
  for (const path of ["../bad", "/bad", "a//b", "bad\0name", "bad\ud800", "a".repeat(1025)])
    await expect(uploadFile(driveApi(), file(), path, vi.fn())).rejects.toThrow("file name");
  expect(fetch).toHaveBeenCalledTimes(1);
});
