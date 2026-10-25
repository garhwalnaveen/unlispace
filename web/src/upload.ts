import { ApiError, type DriveApi } from "./api";
import { chunkLength, MAX_CHUNK } from "./fastcdc";

export interface UploadProgress {
  phase: "hashing" | "uploading" | "committing" | "done";
  bytes: number;
  total: number;
}
interface Shard { h: string; n: number; offset: number }
export async function uploadFile(
  api: DriveApi,
  file: File,
  path: string,
  progress: (value: UploadProgress) => void,
): Promise<void> {
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || path.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(path) || new TextEncoder().encode(path).length > 1024)
    throw new Error("This file name is not supported. Rename it before uploading.");
  // Read the authoritative head before hashing, including names outside the loaded list page.
  let version: string | undefined;
  try {
    const head = await api.stat(path);
    if (head.type !== "file") throw new Error("A folder already uses this name.");
    version = head.versionId;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404 && error.code === "no_such_path")) throw error;
  }
  const shards: Shard[] = [];
  progress({ phase: "hashing", bytes: 0, total: file.size });
  // Sliding reads cap chunking memory at 16 MiB even for large browser uploads.
  for (let offset = 0; offset < file.size;) {
    const bytes = new Uint8Array(await file.slice(offset, offset + MAX_CHUNK).arrayBuffer());
    const n = chunkLength(bytes);
    const digest = await crypto.subtle.digest("SHA-256", bytes.subarray(0, n));
    const h = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    shards.push({ h, n, offset });
    offset += n;
    progress({ phase: "hashing", bytes: offset, total: file.size });
  }
  const manifest = shards.map(({ h, n }) => ({ h, n }));
  const operation = {
    op: "put" as const, path, ...(version ? { ifVersion: version } : { ifAbsent: true }),
    size: file.size, contentType: file.type || "application/octet-stream", mtimeMs: file.lastModified, shards: manifest,
  };
  if (new TextEncoder().encode(JSON.stringify({ ops: [operation] })).length > 1024 * 1024)
    throw new Error("This file has too many chunks for a browser upload. Use the desktop app.");
  const unique = [...new Map(shards.map((shard) => [shard.h, shard])).values()];
  const missing = new Set<string>();
  for (let i = 0; i < unique.length; i += 1000) {
    const result = await api.missing(unique.slice(i, i + 1000).map(({ h }) => h));
    result.missing.forEach((hash) => missing.add(hash));
  }
  const queue = unique.filter(({ h }) => missing.has(h));
  const weights = new Map<string, number>();
  shards.forEach(({ h, n }) => weights.set(h, (weights.get(h) || 0) + n));
  let bytesDone = shards.filter(({ h }) => !missing.has(h)).reduce((sum, { n }) => sum + n, 0);
  progress({ phase: "uploading", bytes: bytesDone, total: file.size });
  let next = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (!failure && next < queue.length) {
      const shard = queue[next++];
      try {
        const bytes = new Uint8Array(await file.slice(shard.offset, shard.offset + shard.n).arrayBuffer());
        await api.putShard(shard.h, bytes);
        bytesDone += weights.get(shard.h)!;
        progress({ phase: "uploading", bytes: bytesDone, total: file.size });
      } catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
  progress({ phase: "committing", bytes: file.size, total: file.size });
  await api.commit(operation);
  progress({ phase: "done", bytes: file.size, total: file.size });
}
