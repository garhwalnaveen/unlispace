import { describe, expect, it } from "vitest";
import { digest } from "../src/crypto";
import { handle } from "../src/index";
import { DataPlane } from "../src/data-plane";
import { authenticate } from "../src/auth";
import { harness, makeBucket, rawSigned, text } from "./helpers";

async function fixture() {
  const h = await harness(), bucket = makeBucket(h);
  const deps = {...h.deps, publicDataEndpoint: "https://data.test"};
  const bytes = text("direct bytes"), hash = await digest(bytes), shards = [{hash, length: bytes.length}];
  const request = async (operation: "plan" | "commit", value: unknown, key = "file", headers: Record<string, string> = {}) => {
    const body = JSON.stringify(value);
    return handle(await rawSigned(h, operation === "plan" ? "POST" : "PUT", `/${bucket}/${key}?x-s3sdk-direct-${operation}`, {body, payloadHash: await digest(text(body)), headers}), deps);
  };
  const plan = async () => {
    const response = await request("plan", {shards});
    expect(response.status).toBe(200);
    return response.json() as Promise<{token: string; upload: {hash: string; length: number; url: string}[]; held: number; expiresSeconds: number}>;
  };
  return {h, bucket, bytes, hash, shards, request, plan};
}

describe("direct upload plan and commit", () => {
  it("pages shard discovery within the actual data-plane request limit", async () => {
    const s = await fixture();
    const auth = await authenticate(await rawSigned(s.h, "GET", "/"), s.h.deps.resolver);
    const batches: number[] = [];
    const binding = {async fetch(request: Request) {
      const {hashes} = await request.json() as {hashes: string[]};
      expect(hashes.length).toBeLessThanOrEqual(1000);
      batches.push(hashes.length);
      return Response.json({missing: hashes});
    }};
    const dp = new DataPlane(binding, s.h.deps.tokens, auth.key, s.bucket);
    const hashes = Array.from({length: 4096}, (_, i) => i.toString(16).padStart(64,"0"));
    expect(await dp.missing(hashes)).toEqual(hashes);
    expect(batches).toEqual([1000,1000,1000,1000,96]);
  });
  it("issues narrow expiring upload URLs, verifies content, commits, and deduplicates held shards", async () => {
    const s = await fixture(), plan = await s.plan();
    expect(plan).toMatchObject({held: 0, expiresSeconds: 300});
    expect(plan.upload).toHaveLength(1);
    const url = new URL(plan.upload[0]!.url), token = url.searchParams.get("uploadToken")!;
    const claims = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims).toMatchObject({drives: [{id: s.bucket, access: "write"}], upload: {hash: s.hash, length: s.bytes.length}});
    expect(url.origin).toBe("https://data.test");
    // The real data-plane capability gate has separate tests; this fixture models storage semantics.
    expect((await s.h.dp.fetch(new Request(url, {method: "PUT", body: s.bytes, headers: {authorization: `Bearer ${token}`, "content-length": String(s.bytes.length)}}))).status).toBe(201);
    const committed = await s.request("commit", {token: plan.token, shards: s.shards, size: s.bytes.length, contentHash: s.hash}, "file", {"x-s3sdk-content-type": "text/plain"});
    expect(committed.status).toBe(200);
    expect(committed.headers.get("x-amz-version-id")).toBeTruthy();
    const read = await handle(await rawSigned(s.h, "GET", `/${s.bucket}/file`), s.h.deps);
    expect(await read.text()).toBe("direct bytes");
    expect(read.headers.get("content-type")).toBe("text/plain");
    const again = await s.plan();
    expect(again).toMatchObject({held: 1, upload: []});
  });
  it("rejects missing/corrupt bytes, altered plans, cross-key scope, expiry, and stale preconditions", async () => {
    const s = await fixture(), plan = await s.plan();
    const value = {token: plan.token, shards: s.shards, size: s.bytes.length, contentHash: s.hash};
    expect((await s.request("commit", value)).status).toBe(400);
    s.h.dp.shards.set(`${s.bucket}/${s.hash}`, text("bad storage"));
    expect((await s.request("commit", value)).status).toBe(400);
    s.h.dp.shards.set(`${s.bucket}/${s.hash}`, s.bytes);
    expect((await s.request("commit", {...value, contentHash: "0".repeat(64)})).status).toBe(400);
    expect((await s.request("commit", {...value, shards: []})).status).toBe(400);
    expect((await s.request("commit", value, "another-key")).status).toBe(400);
    expect((await s.request("commit", value)).status).toBe(200);
    expect((await s.request("commit", value, "file", {"if-none-match": "*"})).status).toBe(412);
    s.h.now.value += 300_001;
    expect((await s.request("commit", value)).status).toBe(400);
  });
  it("handles empty files and rejects malformed plans and unsafe public endpoints", async () => {
    const s = await fixture();
    const planned = await s.request("plan", {shards: []});
    expect(planned.status).toBe(200);
    const {token} = await planned.json() as {token: string};
    expect((await s.request("commit", {token, shards: [], size: 0, contentHash: await digest(text(""))})).status).toBe(200);
    for (const shards of [null, [{hash: "not-a-hash", length: 1}], [{hash: s.hash, length: 0}], [{hash: s.hash, length: 1}, {hash: s.hash, length: 2}]]) {
      expect((await s.request("plan", {shards})).status).toBe(400);
    }
    const auth = await authenticate(await rawSigned(s.h, "GET", "/"), s.h.deps.resolver);
    const dp = new DataPlane(s.h.deps.dataPlane, s.h.deps.tokens, auth.key, s.bucket);
    for (const endpoint of ["http://untrusted.example", "https://user:pass@example.com", "https://example.com?secret=x"]) {
      await expect(dp.directUploadUrl(endpoint, {h: s.hash, n: s.bytes.length})).rejects.toMatchObject({status: 503});
    }
  });
});
