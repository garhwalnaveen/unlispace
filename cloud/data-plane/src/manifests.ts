export const INLINE_MANIFEST_BYTES = 256 * 1024;
export const MAX_STREAM_COMMIT_BYTES = 8 * 1024 * 1024;
const enc = new TextEncoder();

export async function storeManifest(bucket: R2Bucket, lineage: string, manifest: string): Promise<string> {
	const data = enc.encode(manifest);
	if (data.byteLength <= INLINE_MANIFEST_BYTES) return manifest;
	const digest = await crypto.subtle.digest("SHA-256", data);
	const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	await bucket.put(`manifests/${lineage}/${hash}`, data, { sha256: hash, onlyIf: { etagDoesNotMatch: "*" } });
	return "r2:" + hash;
}

export async function loadManifest(bucket: Pick<R2Bucket, "get">, lineage: string, ref: string): Promise<[string, number][]> {
	if (!ref.startsWith("r2:")) return JSON.parse(ref) as [string, number][];
	const object = await bucket.get(`manifests/${lineage}/${ref.slice(3)}`);
	if (!object) throw new Error("retained manifest missing");
	if (object.size > MAX_STREAM_COMMIT_BYTES) throw new Error("manifest exceeds size limit");
	const data = await object.arrayBuffer();
	const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
	if (hash !== ref.slice(3)) throw new Error("manifest checksum mismatch");
	return JSON.parse(new TextDecoder().decode(data)) as [string, number][];
}
