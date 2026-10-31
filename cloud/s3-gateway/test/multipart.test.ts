import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, ListMultipartUploadsCommand, ListPartsCommand, PutObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { client, harness, makeBucket, randomBytes, readAll, readText } from "./helpers";

const code = (e: unknown): string => (e as { name: string }).name;

describe("multipart upload", () => {
	it("completes a manifest larger than a single state value and safely repeats completion",async()=>{
		const h=await harness(),b=makeBucket(h),s3=await client(h.deps);
		const {UploadId}=await s3.send(new CreateMultipartUploadCommand({Bucket:b,Key:"large-manifest"}));
		const hash=createHash("sha256").update("x").digest("hex");
		h.dp.shards.set(`${b}/${hash}`,new TextEncoder().encode("x"));
		const etag='"'+createHash("md5").update("x".repeat(300)).digest("hex")+'"';
		const parts:{PartNumber:number;ETag:string}[]=[];
		for(let number=1;number<=100;number++) {
			await h.deps.state.put(`part:${UploadId}:${String(number).padStart(5,"0")}`,{number,etag,size:300,shards:Array.from({length:300},()=>({h:hash,n:1})),modified:0});
			parts.push({PartNumber:number,ETag:etag});
		}
		const command=()=>new CompleteMultipartUploadCommand({Bucket:b,Key:"large-manifest",UploadId,MultipartUpload:{Parts:parts}});
		const done=await s3.send(command());
		expect((await s3.send(command())).VersionId).toBe(done.VersionId);
		expect(h.dp.drives.get(b)!.versions).toHaveLength(1);
		expect((await s3.send(new HeadObjectCommand({Bucket:b,Key:"large-manifest"}))).ContentLength).toBe(30000);
	});
	it("runs create, upload parts (out of order), list, complete, read back", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const p1 = randomBytes(3_000_000, 1), p2 = randomBytes(1_234_567, 2), p3 = randomBytes(10, 3);
		const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: b, Key: "mp/big.bin", ContentType: "application/x-test" }));
		expect(UploadId).toBeTruthy();

		const etags = new Map<number, string>();
		for (const [n, body] of [[2, p2], [1, p1], [3, p3]] as const) {
			const r = await s3.send(new UploadPartCommand({ Bucket: b, Key: "mp/big.bin", UploadId, PartNumber: n, Body: body }));
			expect(r.ETag).toBe(`"${createHash("md5").update(body).digest("hex")}"`);
			etags.set(n, r.ETag!);
		}
		const parts = await s3.send(new ListPartsCommand({ Bucket: b, Key: "mp/big.bin", UploadId }));
		expect(parts.Parts?.map((p) => [p.PartNumber, p.Size])).toEqual([[1, 3_000_000], [2, 1_234_567], [3, 10]]);
		const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: b }));
		expect(uploads.Uploads?.map((u) => u.Key)).toEqual(["mp/big.bin"]);

		// replacing a part wins
		const p2b = randomBytes(500, 9);
		etags.set(2, (await s3.send(new UploadPartCommand({ Bucket: b, Key: "mp/big.bin", UploadId, PartNumber: 2, Body: p2b }))).ETag!);

		const done = await s3.send(new CompleteMultipartUploadCommand({ Bucket: b, Key: "mp/big.bin", UploadId, MultipartUpload: { Parts: [1, 2, 3].map((n) => ({ PartNumber: n, ETag: etags.get(n) })) } }));
		const expectedEtag = `"${createHash("md5").update(Buffer.concat([1, 2, 3].map((n) => Buffer.from(etags.get(n)!.replaceAll('"', ""), "hex")))).digest("hex")}-3"`;
		expect(done.ETag).toBe(expectedEtag);
		expect(done.VersionId).toMatch(/^v_/);

		const expected = Buffer.concat([p1, p2b, p3]);
		const head = await s3.send(new HeadObjectCommand({ Bucket: b, Key: "mp/big.bin" }));
		expect(head.ContentLength).toBe(expected.length);
		expect(head.ContentType).toBe("application/x-test");
		const got = await readAll((await s3.send(new GetObjectCommand({ Bucket: b, Key: "mp/big.bin" }))).Body);
		expect(Buffer.from(got).equals(expected)).toBe(true);

		// completing again is idempotent; the upload no longer lists
		const again = await s3.send(new CompleteMultipartUploadCommand({ Bucket: b, Key: "mp/big.bin", UploadId, MultipartUpload: { Parts: [1, 2, 3].map((n) => ({ PartNumber: n, ETag: etags.get(n) })) } }));
		expect(again.VersionId).toBe(done.VersionId);
		expect((await s3.send(new ListMultipartUploadsCommand({ Bucket: b }))).Uploads ?? []).toEqual([]);
	});

	it("rejects bad ETags, bad ordering, and unknown uploads", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: b, Key: "k" }));
		const one = await s3.send(new UploadPartCommand({ Bucket: b, Key: "k", UploadId, PartNumber: 1, Body: "aaa" }));
		const two = await s3.send(new UploadPartCommand({ Bucket: b, Key: "k", UploadId, PartNumber: 2, Body: "bbb" }));

		const wrong = await s3.send(new CompleteMultipartUploadCommand({ Bucket: b, Key: "k", UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"00000000000000000000000000000000"' }] } })).catch((e) => e);
		expect(code(wrong)).toBe("InvalidPart");
		const order = await s3.send(new CompleteMultipartUploadCommand({ Bucket: b, Key: "k", UploadId, MultipartUpload: { Parts: [{ PartNumber: 2, ETag: two.ETag }, { PartNumber: 1, ETag: one.ETag }] } })).catch((e) => e);
		expect(code(order)).toBe("InvalidPartOrder");
		const missing = await s3.send(new CompleteMultipartUploadCommand({ Bucket: b, Key: "k", UploadId, MultipartUpload: { Parts: [{ PartNumber: 9, ETag: one.ETag }] } })).catch((e) => e);
		expect(code(missing)).toBe("InvalidPart");
		// a failed complete leaves the upload usable
		const ok = await s3.send(new CompleteMultipartUploadCommand({ Bucket: b, Key: "k", UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: one.ETag }, { PartNumber: 2, ETag: two.ETag }] } }));
		expect(ok.ETag).toMatch(/-2"$/);
		expect(await readText((await s3.send(new GetObjectCommand({ Bucket: b, Key: "k" }))).Body)).toBe("aaabbb");

		const ghost = await s3.send(new UploadPartCommand({ Bucket: b, Key: "k", UploadId: "does-not-exist", PartNumber: 1, Body: "x" })).catch((e) => e);
		expect(code(ghost)).toBe("NoSuchUpload");
		const range = await s3.send(new UploadPartCommand({ Bucket: b, Key: "k", UploadId: "x", PartNumber: 10001, Body: "x" })).catch((e) => e);
		expect(code(range)).toBe("InvalidArgument");
	});

	it("aborts an upload and drops its parts", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: b, Key: "abort-me" }));
		await s3.send(new UploadPartCommand({ Bucket: b, Key: "abort-me", UploadId, PartNumber: 1, Body: "data" }));
		expect((await s3.send(new AbortMultipartUploadCommand({ Bucket: b, Key: "abort-me", UploadId }))).$metadata.httpStatusCode).toBe(204);
		expect(code(await s3.send(new ListPartsCommand({ Bucket: b, Key: "abort-me", UploadId })).catch((e) => e))).toBe("NoSuchUpload");
		expect(code(await s3.send(new GetObjectCommand({ Bucket: b, Key: "abort-me" })).catch((e) => e))).toBe("NoSuchKey");
	});

	it("honours If-None-Match on completion and binds an upload to its key", async () => {
		const h = await harness();
		const b = makeBucket(h), s3 = await client(h.deps);
		await s3.send(new PutObjectCommand({ Bucket: b, Key: "taken", Body: "existing" }));
		const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: b, Key: "taken" }));
		const part = await s3.send(new UploadPartCommand({ Bucket: b, Key: "taken", UploadId, PartNumber: 1, Body: "new" }));
		const lost = await s3.send(new CompleteMultipartUploadCommand({ Bucket: b, Key: "taken", UploadId, IfNoneMatch: "*", MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] } })).catch((e) => e);
		expect(code(lost)).toBe("PreconditionFailed");
		const wrongKey = await s3.send(new UploadPartCommand({ Bucket: b, Key: "other", UploadId, PartNumber: 2, Body: "x" })).catch((e) => e);
		expect(code(wrongKey)).toBe("NoSuchUpload");
		expect(await readText((await s3.send(new GetObjectCommand({ Bucket: b, Key: "taken" }))).Body)).toBe("existing");
	});
});

it("recovers a lost completion response without writing a second version",async()=>{
 const h=await harness();const b=makeBucket(h),s3=await client(h.deps);
 const {UploadId}=await s3.send(new CreateMultipartUploadCommand({Bucket:b,Key:"recover"}));
 const part=await s3.send(new UploadPartCommand({Bucket:b,Key:"recover",UploadId,PartNumber:1,Body:"retained"}));
 const request=()=>new CompleteMultipartUploadCommand({Bucket:b,Key:"recover",UploadId,MultipartUpload:{Parts:[{PartNumber:1,ETag:part.ETag}]}});
 const original=h.deps.state.multipart.bind(h.deps.state);let failed=false;
 h.deps.state.multipart=async(id,action,value)=>{if(action==="finish"&&!failed){failed=true;throw new Error("lost completion response");}return original(id,action,value);};
 await expect(s3.send(request())).rejects.toBeDefined();
 expect(h.dp.drives.get(b)!.versions).toHaveLength(1);
 const recovered=await s3.send(request());expect(recovered.VersionId).toBe(h.dp.drives.get(b)!.versions[0]!.id);
 expect(h.dp.drives.get(b)!.versions).toHaveLength(1);
 expect(await readText((await s3.send(new GetObjectCommand({Bucket:b,Key:"recover"}))).Body)).toBe("retained");
});
it("aborts an expired completion lock and rejects its old owner",async()=>{
 const h=await harness();const b=makeBucket(h),s3=await client(h.deps);
 const {UploadId}=await s3.send(new CreateMultipartUploadCommand({Bucket:b,Key:"abandoned"}));
 await h.deps.state.multipart(UploadId!,"lock",{lease:"dead-worker"});
 const upload=await h.deps.state.get<any>(`upload:${UploadId}`);
 await h.deps.state.put(`upload:${UploadId}`,{...upload,lockedUntil:0});
 expect((await s3.send(new AbortMultipartUploadCommand({Bucket:b,Key:"abandoned",UploadId}))).$metadata.httpStatusCode).toBe(204);
 await expect(h.deps.state.multipart(UploadId!,"finish",{lease:"dead-worker",versionId:"ghost"})).rejects.toBeDefined();
 expect(h.dp.drives.get(b)!.versions).toHaveLength(0);
});
