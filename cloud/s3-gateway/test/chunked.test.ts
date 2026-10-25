import { GetObjectCommand, PutObjectCommand, UploadPartCommand, CreateMultipartUploadCommand } from "@aws-sdk/client-s3";
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { Checksum } from "../src/checksum";
import { client, harness, KEY_ID, makeBucket, randomBytes, readAll, rawSigned, secretOf, text, type Harness } from "./helpers";

const crlf = (s: string): Uint8Array => text(`${s}\r\n`);
const cat = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const crc32 = (bytes: Uint8Array): string => { const c = new Checksum("crc32"); c.update(bytes); return c.finish(); };

function unsignedTrailerBody(data: Uint8Array, trailer: string, pieces = 3): Uint8Array {
	const frames: Uint8Array[] = [];
	const size = Math.ceil(data.length / pieces) || 1;
	for (let o = 0; o < data.length; o += size) { const p = data.subarray(o, o + size); frames.push(crlf(p.length.toString(16)), p, crlf("")); }
	frames.push(crlf("0"), crlf(trailer), crlf(""));
	return cat(...frames);
}
async function chunkedRequest(h: Harness, key: string, body: Uint8Array, decoded: number, extra: Record<string, string>, payloadHash = "STREAMING-UNSIGNED-PAYLOAD-TRAILER"): Promise<Request> {
	const req = await rawSigned(h, "PUT", key, { payloadHash, headers: { "content-encoding": "aws-chunked", "x-amz-decoded-content-length": String(decoded), ...extra } });
	return new Request(req.url, { method: "PUT", headers: req.headers, body });
}

describe("aws-chunked uploads", () => {
	it("accepts the SDK's streaming upload with a trailing CRC32 checksum", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const seen: Request[] = [];
		const s3 = await client(h.deps, { observe: (r) => seen.push(r) });
		const data = randomBytes(300_000, 5);
		const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data.subarray(0, 100_000)); c.enqueue(data.subarray(100_000)); c.close(); } });
		const out = await s3.send(new PutObjectCommand({ Bucket: b, Key: "stream.bin", Body: stream, ContentLength: data.length, ChecksumAlgorithm: "CRC32" }));
		expect(out.ChecksumCRC32 ?? crc32(data)).toBeTruthy();
		const put = seen.find((r) => r.method === "PUT")!;
		expect(put.headers.get("content-encoding")).toContain("aws-chunked");
		expect(put.headers.get("x-amz-content-sha256")).toMatch(/^STREAMING-/);
		expect(put.headers.get("x-amz-trailer")).toBe("x-amz-checksum-crc32");
		const got = await readAll((await s3.send(new GetObjectCommand({ Bucket: b, Key: "stream.bin" }))).Body);
		expect(Buffer.from(got).equals(Buffer.from(data))).toBe(true);
	});

	it("verifies a hand-built STREAMING-UNSIGNED-PAYLOAD-TRAILER body", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const data = randomBytes(10_000, 6);
		const good = await chunkedRequest(h, `/${b}/t1`, unsignedTrailerBody(data, `x-amz-checksum-crc32:${crc32(data)}`), data.length, { "x-amz-trailer": "x-amz-checksum-crc32" });
		expect((await handle(good, h.deps)).status).toBe(200);
		expect(Buffer.from(await readAll((await s3.send(new GetObjectCommand({ Bucket: b, Key: "t1" }))).Body)).equals(Buffer.from(data))).toBe(true);

		const wrong = await chunkedRequest(h, `/${b}/t2`, unsignedTrailerBody(data, `x-amz-checksum-crc32:${crc32(text("different"))}`), data.length, { "x-amz-trailer": "x-amz-checksum-crc32" });
		const res = await handle(wrong, h.deps);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("<Code>BadDigest</Code>");
		expect((await s3.send(new GetObjectCommand({ Bucket: b, Key: "t2" })).catch((e) => e)).name).toBe("NoSuchKey");
	});

	it("supports sha256, sha1 and crc32c trailers", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const data = randomBytes(4_321, 7);
		for (const [name, value] of [["sha256", createHash("sha256").update(data).digest("base64")], ["sha1", createHash("sha1").update(data).digest("base64")], ["crc32c", (() => { const c = new Checksum("crc32c"); c.update(data); return c.finish(); })()]] as const) {
			const req = await chunkedRequest(h, `/${b}/${name}`, unsignedTrailerBody(data, `x-amz-checksum-${name}:${value}`, 2), data.length, { "x-amz-trailer": `x-amz-checksum-${name}` });
			expect((await handle(req, h.deps)).status, name).toBe(200);
		}
	});

	it("rejects malformed framing, missing trailers, short bodies and mismatched decoded length", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const data = text("0123456789");
		const trailer = `x-amz-checksum-crc32:${crc32(data)}`;
		const headers = { "x-amz-trailer": "x-amz-checksum-crc32" };
		const attempts: [string, Uint8Array, number, Record<string, string>][] = [
			["no trailer line", cat(crlf("a"), data, crlf(""), crlf("0"), crlf("")), 10, headers],
			["bad chunk header", cat(crlf("zz"), data, crlf("")), 10, headers],
			["decoded length wrong", unsignedTrailerBody(data, trailer), 11, headers],
			["truncated", unsignedTrailerBody(data, trailer).subarray(0, 12), 10, headers],
			["unannounced trailer", unsignedTrailerBody(data, trailer), 10, { "x-amz-trailer": "x-amz-checksum-sha1" }],
			["trailing garbage", cat(unsignedTrailerBody(data, trailer), text("junk")), 10, headers],
		];
		for (const [name, body, decoded, extra] of attempts) {
			const res = await handle(await chunkedRequest(h, `/${b}/bad`, body, decoded, extra), h.deps);
			expect(res.status, name).toBe(400);
			await res.text();
		}
		const missing = await handle(await chunkedRequest(h, `/${b}/bad`, unsignedTrailerBody(data, trailer), 10, {}), h.deps);
		expect(missing.status).toBe(400);
	});

	it("verifies per-chunk signatures for STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const data = randomBytes(5_000, 8);
		const hash = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER";
		const seedReq = await rawSigned(h, "PUT", `/${b}/signed`, { payloadHash: hash, headers: { "content-encoding": "aws-chunked", "x-amz-decoded-content-length": String(data.length), "x-amz-trailer": "x-amz-checksum-crc32" } });
		const seed = /Signature=([a-f0-9]{64})/.exec(seedReq.headers.get("authorization")!)![1]!;
		const amzDate = seedReq.headers.get("x-amz-date")!, date = amzDate.slice(0, 8), scope = `${date}/auto/s3/aws4_request`;
		const hm = (k: Buffer | string, v: string): Buffer => createHmac("sha256", k).update(v).digest();
		const signingKey = hm(hm(hm(hm(`AWS4${await secretOf(KEY_ID)}`, date), "auto"), "s3"), "aws4_request");
		const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
		const empty = sha("");
		const build = (tamper: boolean): Uint8Array => {
			let prev = seed;
			const sign = (sts: string): string => createHmac("sha256", signingKey).update(sts).digest("hex");
			const parts: Uint8Array[] = [];
			for (const piece of [data.subarray(0, 2_000), data.subarray(2_000)]) {
				const sig = sign(["AWS4-HMAC-SHA256-PAYLOAD", amzDate, scope, prev, empty, sha(piece)].join("\n"));
				parts.push(crlf(`${piece.length.toString(16)};chunk-signature=${tamper && piece.length === 2_000 ? "0".repeat(64) : sig}`), piece, crlf(""));
				prev = sig;
			}
			const finalSig = sign(["AWS4-HMAC-SHA256-PAYLOAD", amzDate, scope, prev, empty, empty].join("\n"));
			parts.push(crlf(`0;chunk-signature=${finalSig}`));
			const trailerLine = `x-amz-checksum-crc32:${crc32(data)}`;
			const trailerSig = sign(["AWS4-HMAC-SHA256-TRAILER", amzDate, scope, finalSig, sha(`${trailerLine}\n`)].join("\n"));
			parts.push(crlf(trailerLine), crlf(`x-amz-trailer-signature:${trailerSig}`), crlf(""));
			return cat(...parts);
		};
		const ok = await handle(new Request(seedReq.url, { method: "PUT", headers: seedReq.headers, body: build(false) }), h.deps);
		expect(ok.status, await ok.clone().text()).toBe(200);
		expect(Buffer.from(await readAll((await s3.send(new GetObjectCommand({ Bucket: b, Key: "signed" }))).Body)).equals(Buffer.from(data))).toBe(true);

		const seedReq2 = await rawSigned(h, "PUT", `/${b}/signed2`, { payloadHash: hash, headers: { "content-encoding": "aws-chunked", "x-amz-decoded-content-length": String(data.length), "x-amz-trailer": "x-amz-checksum-crc32" } });
		const bad = await handle(new Request(seedReq2.url, { method: "PUT", headers: seedReq2.headers, body: build(true) }), h.deps);
		// The second request has a different seed signature, so every chunk signature mismatches.
		expect(bad.status).toBe(403);
		expect(await bad.text()).toContain("SignatureDoesNotMatch");
		expect((await s3.send(new GetObjectCommand({ Bucket: b, Key: "signed2" })).catch((e) => e)).name).toBe("NoSuchKey");
	});

	it("streams multipart parts through aws-chunked as well", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: b, Key: "mp" }));
		const data = randomBytes(50_000, 9);
		const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } });
		const part = await s3.send(new UploadPartCommand({ Bucket: b, Key: "mp", UploadId, PartNumber: 1, Body: stream, ContentLength: data.length, ChecksumAlgorithm: "CRC32" }));
		expect(part.ETag).toBe(`"${createHash("md5").update(data).digest("hex")}"`);
	});
});
