import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import { api, bytes, newDrive, sha256Hex, TOKEN } from "./helpers";

it.each([
	["put: We encountered an internal connectivity issue. (10001)", 503, "service_unavailable"],
	["checksum mismatch", 400, "hash_mismatch"],
	["bad Content-Length", 400, "bad_request"],
])("classifies failed shard storage: %s", async (message, status, code) => {
	const drive = await newDrive(), data = bytes("shard"), hash = await sha256Hex(data);
	const shards = {
		head: env.SHARDS.head.bind(env.SHARDS),
		async put(_key: string, body: ReadableStream) {
			await new Response(body).arrayBuffer();
			throw new Error(message);
		},
	} as unknown as R2Bucket;
	const response = await worker.fetch(new Request(`http://example.com/v0/drives/${drive}/shards/${hash}`, {
		method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-length": String(data.length) }, body: data,
	}), { ...env, SHARDS: shards }, {} as ExecutionContext);
	expect(response.status).toBe(status);
	expect((await response.json() as { error: string }).error).toBe(code);
	expect(await (await api(`/v0/drives/${drive}/shards/missing`, { json: { hashes: [hash] } })).json()).toEqual({ missing: [hash] });
});
