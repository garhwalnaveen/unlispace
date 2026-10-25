import { GetObjectCommand, ListBucketsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { client, harness, KEY_ID, makeBucket, rawSigned, readText, secretOf, text } from "./helpers";

describe("SigV4 auth", () => {
	it("accepts header-signed SDK requests and mints a drive token for the data plane", async () => {
		const h = await harness();
		const s3 = await client(h.deps);
		const out = await s3.send(new ListBucketsCommand({}));
		expect(out.Buckets).toEqual([]);
		const b = makeBucket(h);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "a.txt", Body: "hello" }));
		expect(h.tokens.length).toBeGreaterThan(0);
		const claims = JSON.parse(atob(h.tokens.at(-1)!.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
		expect(claims).toMatchObject({ iss: "http://issuer.test", sub: "user-1", typ: "drive", drives: [{ id: b }] });
	});

	it("rejects a wrong secret with 403 SignatureDoesNotMatch and an XML error body", async () => {
		const h = await harness();
		const bad = await client(h.deps, { secret: "x".repeat(40) });
		const err = await bad.send(new ListBucketsCommand({})).catch((e) => e);
		expect(err.name).toBe("SignatureDoesNotMatch");
		expect(err.$metadata.httpStatusCode).toBe(403);
	});

	it("returns a well-formed S3 XML error for a tampered signature", async () => {
		const h = await harness();
		const req = await rawSigned(h, "GET", "/");
		const auth = req.headers.get("authorization")!.replace(/Signature=([a-f0-9]{64})/, (_, s: string) => `Signature=${s.startsWith("0") ? "1" : "0"}${s.slice(1)}`);
		req.headers.set("authorization", auth);
		const res = await handle(req, h.deps);
		expect(res.status).toBe(403);
		expect(res.headers.get("content-type")).toContain("xml");
		const body = await res.text();
		expect(body).toContain("<Code>SignatureDoesNotMatch</Code>");
		expect(body).toContain("<RequestId>");
		expect(res.headers.get("x-amz-request-id")).toBeTruthy();
	});

	it("rejects unknown access keys, missing auth, and skewed clocks", async () => {
		const h = await harness();
		const unknown = await client(h.deps, { keyId: "ULS1ZZZZZZZZZZZZZZZZZ", secret: "s".repeat(40) });
		expect((await unknown.send(new ListBucketsCommand({})).catch((e) => e)).name).toBe("InvalidAccessKeyId");
		const res = await handle(new Request("https://s3.test/"), h.deps);
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("<Code>AccessDenied</Code>");
		const s3 = await client(h.deps);
		h.now.value += 3_600_000; // the gateway's clock moves an hour past the signature
		expect((await s3.send(new ListBucketsCommand({})).catch((e) => e)).name).toBe("RequestTimeTooSkewed");
	});

	it("verifies presigned GET URLs and rejects tampered or expired ones", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const s3 = await client(h.deps);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "dir/file one.txt", Body: "presigned body" }));
		const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: b, Key: "dir/file one.txt" }), { expiresIn: 60 });
		const ok = await handle(new Request(url), h.deps);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe("presigned body");

		const tampered = new URL(url);
		tampered.pathname = tampered.pathname.replace("file%20one", "file%20two");
		const bad = await handle(new Request(tampered), h.deps);
		expect(bad.status).toBe(403);
		expect(await bad.text()).toContain("SignatureDoesNotMatch");

		const badSig = new URL(url);
		badSig.searchParams.set("X-Amz-Signature", "0".repeat(64));
		expect((await handle(new Request(badSig), h.deps)).status).toBe(403);

		h.now.value += 120_000;
		const expired = await handle(new Request(url), h.deps);
		expect(expired.status).toBe(403);
		expect(await expired.text()).toContain("Request has expired");
	});

	it("verifies presigned PUT with UNSIGNED-PAYLOAD", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const s3 = await client(h.deps);
		const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: b, Key: "up.bin" }), { expiresIn: 60, unhoistableHeaders: new Set(["content-type"]) });
		const put = await handle(new Request(url, { method: "PUT", body: "via presigned put" }), h.deps);
		expect(put.status).toBe(200);
		const got = await s3.send(new GetObjectCommand({ Bucket: b, Key: "up.bin" }));
		expect(await readText(got.Body)).toBe("via presigned put");
	});

	it("enforces a signed SHA-256 payload hash", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const body = "exact payload";
		const sha = createHash("sha256").update(body).digest("hex");
		const ok = await handle(await rawSigned(h, "PUT", `/${b}/p.txt`, { body, payloadHash: sha }), h.deps);
		expect(ok.status).toBe(200);
		const wrong = await handle(await rawSigned(h, "PUT", `/${b}/q.txt`, { body: "other payload", payloadHash: sha }), h.deps);
		expect(wrong.status).toBe(400);
		expect(await wrong.text()).toContain("XAmzContentSHA256Mismatch");
	});

	it("requires x-uls-* extension headers to be signed", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const req = await rawSigned(h, "PUT", `/${b}/f?x-uls-write`, { body: "x" });
		req.headers.set("x-uls-offset", "5");
		const res = await handle(req, h.deps);
		expect(res.status).toBe(403);
	});

	it("enforces key scope: read keys cannot write, and unknown buckets are NoSuchBucket", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const ro = await client(h.deps, { keyId: "ULS1READONLYREADONLY", secret: await secretOf("ULS1READONLYREADONLY") });
		expect((await ro.send(new PutObjectCommand({ Bucket: b, Key: "k", Body: "v" })).catch((e) => e)).name).toBe("AccessDenied");
		expect((await ro.send(new GetObjectCommand({ Bucket: "no-such-bucket", Key: "k" })).catch((e) => e)).name).toBe("NoSuchBucket");
		void KEY_ID; void text;
	});
});
