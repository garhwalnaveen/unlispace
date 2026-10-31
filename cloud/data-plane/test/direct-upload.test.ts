import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { genKey, installJwks, ISS, type TestKey } from "./auth-helpers";
import { api, bytes, newDrive, selfFetch, sha256Hex } from "./helpers";

const encoded = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function capability(key: TestKey, drive: string, hash: string, length: number, expiry = Math.floor(Date.now() / 1000) + 300) {
  const h = encoded({alg: "EdDSA", typ: "JWT", kid: key.kid});
  const p = encoded({iss: ISS, typ: "drive", org: "direct-org", sub: "direct-user", exp: expiry, drives: [{id: drive, access: "write"}], upload: {hash, length}});
  const sig = new Uint8Array(await crypto.subtle.sign({name: "Ed25519"}, key.priv, bytes(`${h}.${p}`)));
  return `${h}.${p}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
async function setup(limit = 1000) {
  const drive = await newDrive(), key = await genKey(`direct-${drive}`);
  installJwks(key);
  await (exports as unknown as {DataPlaneAdmin: {configureQuota(org: string, limit: number, lineages: string[]): Promise<unknown>}}).DataPlaneAdmin.configureQuota("direct-org", limit, [drive]);
  const data = bytes("hello"), hash = await sha256Hex(data), token = await capability(key, drive, hash, data.length);
  const path = `/v0/drives/${drive}/shards/${hash}`;
  const put = (p = path, t = token, body = data, length = data.length) => selfFetch(new Request(`http://example.com${p}?uploadToken=${encodeURIComponent(t)}`, {method: "PUT", body, headers: {"content-length": String(length)}}));
  return {drive, key, data, hash, token, path, put};
}

describe("direct-upload capabilities", () => {
  it("accepts only the exact shard PUT and cannot become a read or commit credential", async () => {
    const s = await setup();
    expect((await s.put()).status).toBe(201);
    expect((await api(s.path, {token: s.token})).status).toBe(403);
    expect((await api(`/v0/drives/${s.drive}/commit`, {token: s.token, json: {ops: []}})).status).toBe(403);
    expect((await selfFetch(new Request(`http://example.com${s.path}?uploadToken=${encodeURIComponent(s.token)}`))).status).toBe(401);
    const read = await api(s.path);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("hello");
  });
  it("rejects changed hash, length, drive, expired scope, and wrong bytes", async () => {
    const s = await setup();
    expect((await s.put(s.path.replace(s.hash, "a".repeat(64)))).status).toBe(403);
    expect((await s.put(s.path, s.token, s.data, 6)).status).toBe(403);
    const other = await newDrive();
    expect((await s.put(s.path.replace(s.drive, other))).status).toBe(404);
    const expired = await capability(s.key, s.drive, s.hash, s.data.length, Math.floor(Date.now() / 1000) - 1);
    expect((await s.put(s.path, expired)).status).toBe(401);
    expect((await s.put(s.path, s.token, bytes("wrong"))).status).toBe(400);
    expect(await env.SHARDS.head(`shards/${s.drive}/${s.hash}`)).toBeNull();
  });
  it("uses the organization quota on direct uploads", async () => {
    const s = await setup(2);
    expect((await s.put()).status).toBe(403);
    expect(await env.SHARDS.head(`shards/${s.drive}/${s.hash}`)).toBeNull();
  });
});
