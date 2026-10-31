import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { digest } from "../src/crypto";
import { handle } from "../src/index";
import { client, harness, KEY_ID, makeBucket, rawSigned, readText, text } from "./helpers";

describe("SpaceFS wire compatibility", () => {
  it("uses signed SpaceFS edit, version, rename and restore names with native clients", async () => {
    const h = await harness(), b = makeBucket(h), s3 = await client(h.deps);
    const first = await s3.send(new PutObjectCommand({Bucket:b, Key:"original", Body:"hello"}));
    const edited = await handle(await rawSigned(h, "PUT", `/${b}/original?x-s3sdk-write`, {
      headers:{"x-s3sdk-offset":"0", "x-s3sdk-if-version":first.VersionId!}, body:"H",
    }), h.deps);
    expect(edited.status).toBe(200);
    expect(edited.headers.get("x-s3sdk-protocol")).toBe("1");
    expect(edited.headers.get("x-s3sdk-size")).toBe("5");
    expect(edited.headers.get("x-uls-size")).toBe("5");
    expect(await readText((await s3.send(new GetObjectCommand({Bucket:b, Key:"original"}))).Body)).toBe("Hello");
    const stale = await handle(await rawSigned(h, "PUT", `/${b}/original?x-s3sdk-write`, {
      headers:{"x-s3sdk-offset":"0", "x-s3sdk-if-version":first.VersionId!}, body:"X",
    }), h.deps);
    expect(stale.status).toBe(412);
    expect(stale.headers.get("x-amz-version-id")).toBe(edited.headers.get("x-amz-version-id"));
    const moved = await handle(await rawSigned(h, "PUT", `/${b}/renamed?x-s3sdk-rename`, {
      headers:{"x-s3sdk-source":"original"},
    }), h.deps);
    expect(moved.status).toBe(200);
    const restored = await handle(await rawSigned(h, "POST", `/${b}/renamed?x-s3sdk-restore&versionId=${first.VersionId}`), h.deps);
    expect(restored.status).toBe(200);
    expect(restored.headers.get("x-s3sdk-restored-from")).toBe(first.VersionId);
    const history = await handle(await rawSigned(h, "GET", `/${b}/renamed?x-s3sdk-versions`), h.deps);
    expect(await history.json()).toMatchObject({key:"renamed", versions:[{operation:"put"}, {operation:"write"}, {operation:"restore", isLatest:true}]});
    expect(await readText((await s3.send(new GetObjectCommand({Bucket:b, Key:"renamed"}))).Body)).toBe("hello");
  });

  it("refuses ambiguous, unsigned, or tampered extension names before mutation", async () => {
    const h = await harness(), b = makeBucket(h), s3 = await client(h.deps);
    await s3.send(new PutObjectCommand({Bucket:b, Key:"f", Body:"safe"}));
    const requests = [
      await rawSigned(h,"PUT",`/${b}/f?x-s3sdk-write&x-uls-write`,{headers:{"x-s3sdk-offset":"0"},body:"X"}),
      await rawSigned(h,"PUT",`/${b}/f?x-s3sdk-write`,{headers:{"x-s3sdk-offset":"0","x-uls-offset":"1"},body:"X"}),
    ];
    for (const req of requests) expect((await handle(req,h.deps)).status).toBe(400);
    const unsigned = await rawSigned(h,"PUT",`/${b}/f?x-s3sdk-write`,{body:"X"});
    unsigned.headers.set("x-s3sdk-offset","0");
    expect((await handle(unsigned,h.deps)).status).toBe(403);
    const signed = await rawSigned(h,"PUT",`/${b}/f?x-s3sdk-write`,{headers:{"x-s3sdk-offset":"0"},body:"X"});
    const changed = new Request(signed.url.replace("x-s3sdk-write","x-s3sdk-splice"),signed);
    expect((await handle(changed,h.deps)).status).toBe(403);
    const unknown = await handle(await rawSigned(h,"PUT",`/${b}/f?x-s3sdk-unknown-operation`,{body:"X"}),h.deps);
    expect(unknown.status).toBe(501);
    expect(unknown.headers.get("x-s3sdk-protocol")).toBe("1");
    expect(await readText((await s3.send(new GetObjectCommand({Bucket:b, Key:"f"}))).Body)).toBe("safe");
  });

  it("forwards SpaceFS session routes and returns flat, digest-bound child credentials", async () => {
    const h = await harness(), b = makeBucket(h), seen:Request[] = [];
    h.deps.sessionAPI = {fetch:async req => {seen.push(req); return Response.json({ok:true});}};
    const revoked = await handle(new Request("https://s3.test/_s3sdk/keys/old", {
      method:"DELETE", headers:{"x-s3sdk-login-authorization":"Bearer fixture"},
    }),h.deps);
    expect(revoked.status).toBe(204);
    expect(seen[0]!.url).toBe("https://api.internal/keys/old");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer fixture");
    expect(seen[0]!.headers.has("x-s3sdk-login-authorization")).toBe(false);
    const body = JSON.stringify({drives:[b],access:"read"});
    const minted = await handle(await rawSigned(h,"POST","/_s3sdk/keys",{body,payloadHash:await digest(text(body))}),h.deps);
    expect(minted.status).toBe(201);
    expect(minted.headers.get("cache-control")).toBe("no-store");
    expect(await minted.json()).toMatchObject({accessKeyId:"child",parent:KEY_ID,drives:[b],access:"read",secretAccessKey:"child-secret"});
    const unsigned = await handle(await rawSigned(h,"POST","/_s3sdk/keys",{body}),h.deps);
    expect(unsigned.status).toBe(400);
    const wrongDigest = await handle(await rawSigned(h,"POST","/_s3sdk/keys",{body,payloadHash:"0".repeat(64)}),h.deps);
    expect(wrongDigest.status).toBe(400);
    for (const workspaceId of ["", null, false, 0]) {
      const malformed = JSON.stringify({drives:[b],workspaceId});
      const rejected = await handle(await rawSigned(h,"POST","/_s3sdk/keys",{body:malformed,payloadHash:await digest(text(malformed))}),h.deps);
      expect(rejected.status).toBe(400);
    }
  });
});

it("rejects version-targeted batch deletion without deleting the current file", async () => {
  const h = await harness(), b = makeBucket(h), s3 = await client(h.deps);
  const first = await s3.send(new PutObjectCommand({Bucket:b, Key:"f", Body:"old"}));
  await s3.send(new PutObjectCommand({Bucket:b, Key:"f", Body:"current"}));
  await s3.send(new PutObjectCommand({Bucket:b, Key:"other", Body:"remove"}));
  const result = await s3.send(new DeleteObjectsCommand({Bucket:b, Delete:{Objects:[{Key:"f",VersionId:first.VersionId},{Key:"other"}]}}));
  expect(result.Errors).toMatchObject([{Key:"f",VersionId:first.VersionId,Code:"NotImplemented"}]);
  expect(result.Deleted).toMatchObject([{Key:"other"}]);
  expect(await readText((await s3.send(new GetObjectCommand({Bucket:b,Key:"f"}))).Body)).toBe("current");
});

it("does not treat unsupported object subresources as file writes or deletes", async () => {
  const h = await harness(), b = makeBucket(h), s3 = await client(h.deps);
  const original = await s3.send(new PutObjectCommand({Bucket:b,Key:"f",Body:"keep"}));
  for (const query of ["acl", "tagging", "torrent", "legal-hold", "retention", "attributes", "select", "restore"]) {
    for (const method of ["GET", "PUT", "POST", "DELETE"]) {
      const response = await handle(await rawSigned(h,method,`/${b}/f?${query}`,{body:method === "PUT" || method === "POST" ? "configuration" : undefined}),h.deps);
      expect(response.status).toBe(501);
    }
  }
  const current = await s3.send(new GetObjectCommand({Bucket:b,Key:"f"}));
  expect(current.VersionId).toBe(original.VersionId);
  expect(await readText(current.Body)).toBe("keep");
});
