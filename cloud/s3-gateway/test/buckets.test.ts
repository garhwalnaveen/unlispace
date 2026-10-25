import { CreateBucketCommand, DeleteBucketCommand, GetBucketVersioningCommand, HeadBucketCommand, ListBucketsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { bucketName, client, harness, makeBucket, rawSigned } from "./helpers";

describe("buckets (bucket = drive)", () => {
	it("creates, heads, lists, versions and deletes a bucket", async () => {
		const h = await harness();
		const s3 = await client(h.deps);
		const name = bucketName();
		await s3.send(new CreateBucketCommand({ Bucket: name }));
		expect(h.dp.drives.has(name)).toBe(true);

		await s3.send(new HeadBucketCommand({ Bucket: name }));
		const list = await s3.send(new ListBucketsCommand({}));
		expect(list.Buckets?.map((b) => b.Name)).toContain(name);
		expect(list.Owner?.ID).toBe("user-1");
		expect((await s3.send(new GetBucketVersioningCommand({ Bucket: name }))).Status).toBe("Enabled");

		await s3.send(new DeleteBucketCommand({ Bucket: name }));
		expect(h.dp.drives.has(name)).toBe(false);
		expect((await s3.send(new HeadBucketCommand({ Bucket: name })).catch((e) => e)).$metadata.httpStatusCode).toBe(404);
		expect((await s3.send(new ListBucketsCommand({}))).Buckets).toEqual([]);
	});

	it("reports BucketAlreadyOwnedByYou on re-create and BucketNotEmpty on non-empty delete", async () => {
		const h = await harness();
		const s3 = await client(h.deps);
		const name = bucketName();
		await s3.send(new CreateBucketCommand({ Bucket: name }));
		expect((await s3.send(new CreateBucketCommand({ Bucket: name })).catch((e) => e)).name).toBe("BucketAlreadyOwnedByYou");
		await s3.send(new PutObjectCommand({ Bucket: name, Key: "x", Body: "1" }));
		const err = await s3.send(new DeleteBucketCommand({ Bucket: name })).catch((e) => e);
		expect(err.name).toBe("BucketNotEmpty");
		expect(err.$metadata.httpStatusCode).toBe(409);
	});

	it("rejects invalid bucket names and non-admin bucket creation", async () => {
		const h = await harness();
		const s3 = await client(h.deps);
		expect((await s3.send(new CreateBucketCommand({ Bucket: "UPPER_case" })).catch((e) => e)).name).toBe("InvalidBucketName");
		const res = await handle(await rawSigned(h, "PUT", `/${bucketName()}`, { keyId: "ULS1READONLYREADONLY" }), h.deps);
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("<Code>AccessDenied</Code>");
	});

	it("supports virtual-host addressing", async () => {
		const h = await harness();
		const b = makeBucket(h);
		const s3 = await client(h.deps);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "vh.txt", Body: "virtual" }));
		// Same signing code path, different Host header: "{bucket}.s3.test".
		const signed = await rawSignedFor(h, `${b}.s3.test`, "/vh.txt");
		const res = await handle(signed, h.deps);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("virtual");
	});
});

async function rawSignedFor(h: Awaited<ReturnType<typeof harness>>, host: string, path: string): Promise<Request> {
	const { SignatureV4 } = await import("@smithy/signature-v4");
	const { createHash, createHmac } = await import("node:crypto");
	const { secretOf, KEY_ID } = await import("./helpers");
	class Sha {
		chunks: Buffer[] = [];
		constructor(private readonly secret?: string | ArrayBuffer | ArrayBufferView) {}
		update(d: string | ArrayBuffer | ArrayBufferView): void { this.chunks.push(typeof d === "string" ? Buffer.from(d) : ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : Buffer.from(d)); }
		async digest(): Promise<Uint8Array> {
			const s = this.secret;
			const x = s === undefined ? createHash("sha256") : createHmac("sha256", typeof s === "string" ? s : ArrayBuffer.isView(s) ? Buffer.from(s.buffer, s.byteOffset, s.byteLength) : Buffer.from(s));
			for (const c of this.chunks) x.update(c);
			return new Uint8Array(x.digest());
		}
		reset(): void { this.chunks = []; }
	}
	const signer = new SignatureV4({ service: "s3", region: "auto", sha256: Sha, credentials: { accessKeyId: KEY_ID, secretAccessKey: await secretOf(KEY_ID) }, uriEscapePath: false, applyChecksum: false });
	const signed = await signer.sign({ method: "GET", protocol: "https:", hostname: host, path, query: {}, headers: { host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" } }, { signingDate: new Date(h.now.value) });
	const { host: _h, ...rest } = signed.headers as Record<string, string>;
	return new Request(`https://${host}${path}`, { headers: rest });
}
