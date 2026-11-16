import { CopyObjectCommand, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { ControlPlaneKeyResolver } from "../src/control-plane";
import { handle } from "../src/index";
import { digest } from "../src/crypto";
import { FakeControlPlane } from "./fake-control-plane";
import { bucketName, client, harness, KEY_ID, makeBucket, rawSigned, readText, text } from "./helpers";
describe("M3 trust boundaries", () => {
    it("expires positive and negative cached key resolution within 30 seconds", async () => {
        const h = await harness();
        let now = 0, calls = 0;
        const cp = h.deps.controlPlane, resolve = cp.resolveKey.bind(cp);
        cp.resolveKey = async (id) => { calls++; return resolve(id); };
        const resolver = new ControlPlaneKeyResolver(cp, () => now);
        await resolver.resolve(KEY_ID);
        await resolver.resolve(KEY_ID);
        expect(calls).toBe(1);
        now = 30000;
        await resolver.resolve(KEY_ID);
        expect(calls).toBe(2);
        await resolver.resolve("missing");
        await resolver.resolve("missing");
        expect(calls).toBe(3);
        now = 60000;
        await resolver.resolve("missing");
        expect(calls).toBe(4);
    });
    it("records use only after signature and authorization; every response advertises protocol 1", async () => {
        const h = await harness(), b = makeBucket(h), cp = h.deps.controlPlane as FakeControlPlane;
        const denied = await handle(await rawSigned(h, "PUT", `/${b}/f`, { keyId: "ULS1READONLYREADONLY", body: "x" }), h.deps);
        expect(denied.status).toBe(403);
        expect(denied.headers.get("x-uls-protocol")).toBe("1");
        expect(cp.uses).toEqual([]);
        const signed = await rawSigned(h, "GET", `/${b}/f`);
        signed.headers.set("authorization", signed.headers.get("authorization")!.replace(/.$/, c => c === "0" ? "1" : "0"));
        expect((await handle(signed, h.deps)).status).toBe(403);
        expect(cp.uses).toEqual([]);
        const s = await client(h.deps);
        await s.send(new PutObjectCommand({ Bucket: b, Key: "f", Body: "x" }));
        expect(cp.uses).toEqual([KEY_ID]);
        expect((await handle(new Request("https://s3.test/healthz"), h.deps)).headers.get("x-uls-protocol")).toBe("1");
    });
    it("returns QuotaExceeded on writes while allowing reads and deletes", async () => {
        const h = await harness(), b = makeBucket(h), s = await client(h.deps), cp = h.deps.controlPlane as FakeControlPlane;
        await s.send(new PutObjectCommand({ Bucket: b, Key: "f", Body: "x" }));
        cp.buckets.get(b)!.writable = false;
        await expect(s.send(new PutObjectCommand({ Bucket: b, Key: "f", Body: "bad" }))).rejects.toMatchObject({ name: "QuotaExceeded", $metadata: { httpStatusCode: 403 } });
        expect(await readText((await s.send(new GetObjectCommand({ Bucket: b, Key: "f" }))).Body)).toBe("x");
        await s.send(new DeleteObjectCommand({ Bucket: b, Key: "f" }));
    });
    it("copies via aliases, including across drives with authorization", async () => {
        const h = await harness(), s = await client(h.deps), a = bucketName(), b = bucketName();
        for (const Bucket of [a, b])
            await s.send(new CreateBucketCommand({ Bucket }));
        await s.send(new PutObjectCommand({ Bucket: a, Key: "f", Body: "source" }));
        await s.send(new CopyObjectCommand({ Bucket: a, Key: "same", CopySource: `${a}/f` }));
        await s.send(new CopyObjectCommand({ Bucket: b, Key: "cross", CopySource: `${a}/f` }));
        expect(await readText((await s.send(new GetObjectCommand({ Bucket: b, Key: "cross" }))).Body)).toBe("source");
    });
    it("maps hard-delete fork guards and SlowDown with Retry-After", async () => {
        const h = await harness(), b = makeBucket(h), cp = h.deps.controlPlane;
        const child = bucketName();
        await cp.forkDrive(KEY_ID, { source: b, alias: child });
        const response = await handle(await rawSigned(h, "DELETE", `/${b}`, { headers: { "x-uls-hard-delete": "true" } }), h.deps);
        expect(response.status).toBe(409);
        expect(await response.text()).toContain("DriveHasForks");
        cp.forkDrive = async () => { throw Object.assign(new Error("busy"), { code: "slow_down" }); };
        const retry = await handle(await rawSigned(h, "PUT", `/${bucketName()}`, { headers: { "x-uls-fork-source": b } }), h.deps);
        expect(retry.status).toBe(503);
        expect(retry.headers.get("retry-after")).toBe("1");
    });
    it("requires offsets and enforces extension body length limits before reading", async () => {
        const h = await harness(), b = makeBucket(h), s = await client(h.deps);
        await s.send(new PutObjectCommand({ Bucket: b, Key: "f", Body: "x" }));
        for (const ext of ["write", "splice"]) {
            const r = await handle(await rawSigned(h, "PUT", `/${b}/f?x-uls-${ext}`, { body: "x" }), h.deps);
            expect(r.status).toBe(400);
            const large = await handle(await rawSigned(h, "PUT", `/${b}/f?x-uls-${ext}`, { headers: { "x-uls-offset": "0", "content-length": String(64 * 1024 * 1024 + 1) } }), h.deps);
            expect(large.status).toBe(413);
        }
        const patch = await handle(await rawSigned(h, "POST", `/${b}/f?x-uls-patch`, { headers: { "content-length": String(64 * 1024 * 1024 + 1) } }), h.deps);
        expect(patch.status).toBe(413);
    });
});
describe("M3 JSON key routes", () => {
    it("forwards session list/create/revoke to the API without exposing the login header", async () => {
        const h = await harness();
        const seen: Request[] = [];
        h.deps.sessionAPI = { fetch: async (r) => { seen.push(r); return r.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ ok: true }, { status: r.method === "POST" ? 201 : 200 }); } };
        for (const [method, path] of [["GET", "/_uls/keys"], ["POST", "/_uls/keys"], ["DELETE", "/_uls/keys/id"]]) {
            const r = await handle(new Request(`https://s3.test${path}`, { method, headers: { "x-uls-login-authorization": "Bearer session", "content-type": "application/json" }, body: method === "POST" ? '{"orgId":"org-1"}' : null }), h.deps);
            expect(r.status).toBe(method === "DELETE" ? 204 : method === "POST" ? 201 : 200);
            expect(r.headers.get("x-uls-protocol")).toBe("1");
        }
        expect(seen.map(r => new URL(r.url).pathname)).toEqual(["/keys", "/keys", "/keys/id"]);
        expect(seen.every(r => r.headers.get("authorization") === "Bearer session" && !r.headers.has("x-uls-login-authorization"))).toBe(true);
        expect(await seen[1]!.json()).toEqual({ orgId: "org-1" });
    });
    it("mints a child only with a real signed digest and a reachable nonempty scope", async () => {
        const h = await harness(), b = makeBucket(h), cp = h.deps.controlPlane as FakeControlPlane;
        const body = JSON.stringify({ drives: [b], access: "read" });
        const r = await handle(await rawSigned(h, "POST", "/_uls/keys", { body, payloadHash: await digest(text(body)) }), h.deps);
        expect(r.status).toBe(201);
        expect(await r.json()).toMatchObject({ key: { parent: KEY_ID, drives: [b], access: "read" } });
        expect(cp.uses).toEqual([KEY_ID]);
        for (const payloadHash of ["UNSIGNED-PAYLOAD", "0".repeat(64)]) {
            const r = await handle(await rawSigned(h, "POST", "/_uls/keys", { body, payloadHash }), h.deps);
            expect(r.status).toBe(400);
            expect(r.headers.get("content-type")).toContain("json");
        }
        expect(cp.uses).toEqual([KEY_ID]);
        for (const value of [{ drives: [] }, { drives: [b], workspaceId: "other" }, { drives: [b], access: "admin" }]) {
            const body = JSON.stringify(value);
            const r = await handle(await rawSigned(h, "POST", "/_uls/keys", { keyId: "ULS1READONLYREADONLY", body, payloadHash: await digest(text(body)) }), h.deps);
            expect(r.status).toBe(value.drives.length === 0 ? 400 : 403);
        }
    });
    it("refuses presigned minting and returns uniform authentication errors", async () => {
        const h = await harness();
        const r = await handle(new Request("https://s3.test/_uls/keys?X-Amz-Algorithm=AWS4-HMAC-SHA256", { method: "POST" }), h.deps);
        expect(r.status).toBe(400);
        const body = '{"drives":["missing"]}';
        const hash = await digest(text(body));
        const signed = await rawSigned(h, "POST", "/_uls/keys", { body, payloadHash: hash });
        signed.headers.set("authorization", "invalid");
        const bad = await handle(signed, h.deps);
        expect(bad.status).toBe(403);
        expect(await bad.json()).toEqual({ error: "access_denied" });
    });
});
