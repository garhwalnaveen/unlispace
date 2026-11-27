import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { harness, makeBucket, rawSigned } from "./helpers";

describe("object protocol parity", () => {
  it("discovers and restores deleted object history with an absence precondition", async () => {
    const h = await harness(), bucket = makeBucket(h);
    const call = async (method: string, path: string, options: { body?: string; headers?: Record<string, string> } = {}) =>
      handle(await rawSigned(h, method, `/${bucket}/${path}`, options), h.deps);
    const first = await call("PUT", "record", { body: "historical bytes" });
    const version = first.headers.get("x-amz-version-id")!;
    await call("PUT", "record", { body: "newer bytes" });
    expect((await call("DELETE", "record")).status).toBe(204);
    expect((await call("GET", "record")).status).toBe(404);
    expect(await (await call("GET", `record?versionId=${version}`)).text()).toBe("historical bytes");
    const history = await call("GET", "record?x-uls-versions");
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ versions: [
      { versionId: version, isLatest: false }, { isLatest: false },
    ] });
    const restored = await call("POST", `record?x-uls-restore&versionId=${version}`, { headers: { "if-none-match": "*" } });
    expect(restored.status).toBe(200);
    expect(restored.headers.get("x-amz-version-id")).not.toBe(version);
    expect(restored.headers.get("x-uls-restored-from")).toBe(version);
    expect(await (await call("GET", "record")).text()).toBe("historical bytes");
    expect((await call("POST", `record?x-uls-restore&versionId=${version}`, { headers: { "if-none-match": "*" } })).status).toBe(412);
    const after = await (await call("GET", "record?x-uls-versions")).json() as { versions: { versionId: string; isLatest: boolean; operation: string }[] };
    expect(after.versions.map(v => v.operation)).toEqual(["put", "put", "restore"]);
    expect(after.versions.at(-1)).toMatchObject({ versionId: restored.headers.get("x-amz-version-id"), isLatest: true });
  });

  it("preserves a concurrent restore when the destination must remain absent", async () => {
    const h = await harness(), bucket = makeBucket(h);
    const first = await handle(await rawSigned(h, "PUT", `/${bucket}/record`, { body: "historical" }), h.deps);
    const version = first.headers.get("x-amz-version-id")!;
    const newer = await handle(await rawSigned(h, "PUT", `/${bucket}/record`, { body: "newer" }), h.deps);
    const competingVersion = newer.headers.get("x-amz-version-id")!;
    await handle(await rawSigned(h, "DELETE", `/${bucket}/record`), h.deps);
    h.deps.dataPlane = {
      async fetch(request) {
        if (new URL(request.url).pathname.endsWith("/restore")) {
          const created = await h.dp.fetch(new Request(`https://data-plane.internal/v0/drives/${bucket}/restore`, {
            method: "POST", headers: { authorization: "Bearer concurrent-writer" },
            body: JSON.stringify({ path: "record", versionId: competingVersion }),
          }));
          expect(created.status).toBe(200);
        }
        return h.dp.fetch(request);
      },
    };
    const restored = await handle(await rawSigned(h, "POST", `/${bucket}/record?x-uls-restore&versionId=${version}`, { headers: { "if-none-match": "*" } }), h.deps);
    expect(restored.status).toBe(412);
    const current = await handle(await rawSigned(h, "GET", `/${bucket}/record`), h.deps);
    expect(current.status).toBe(200);
    expect(await current.text()).toBe("newer");
    expect(h.dp.drives.get(bucket)!.versions.filter(v => v.op === "restore")).toHaveLength(1);
  });

  it("requires a real RFC 3339 instant for historical reads", async () => {
    const h = await harness(), bucket = makeBucket(h);
    const put = await handle(await rawSigned(h, "PUT", `/${bucket}/history`, { body: "first" }), h.deps);
    expect(put.status).toBe(200);
    const timestamp = h.dp.now;
    await handle(await rawSigned(h, "PUT", `/${bucket}/history`, { body: "second" }), h.deps);
    const read = (asOf: string) => rawSigned(h, "GET", `/${bucket}/history`, { headers: { "x-uls-as-of": asOf } }).then(request => handle(request, h.deps));
    for (const invalid of ["", "2026-10-31T12:00:00", "2026-10-31T12:00Z", "2026-02-30T12:00:00Z", "2025-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-10-31T24:00:00Z"]) {
      const response = await read(invalid);
      expect(response.status, invalid).toBe(400);
      expect(await response.text()).toContain("InvalidArgument");
    }
    const offset = new Date(timestamp + 5.5 * 3600_000).toISOString().replace("Z", "+05:30");
    const both = await handle(await rawSigned(h, "GET", `/${bucket}/history?versionId=`, { headers: { "x-uls-as-of": offset } }), h.deps);
    expect(both.status).toBe(400);
    const historical = await read(offset);
    expect(historical.status).toBe(200);
    expect(await historical.text()).toBe("first");
    expect((await read("2024-02-29T00:00:00Z")).status).toBe(200);
  });
});
