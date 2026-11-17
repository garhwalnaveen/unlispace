import { ApiError, type DriveApi } from "./api";
import { chunkLength, MAX_CHUNK } from "./fastcdc";

// Fits the JSON commit even at minimum CDC chunk sizes; larger files use the desktop path.
export const MAX_WEB_UPLOAD = 3 * 1024 * 1024 * 1024;

export interface UploadProgress {
  phase: "hashing" | "uploading" | "committing" | "done";
  bytes: number;
  total: number;
}
interface Shard { h: string; n: number; offset: number }
export interface UploadOptions {
  /** "create" refuses to touch an existing file; the default saves a new version of it. */
  mode?: "create" | "replace";
  signal?: AbortSignal;
}
const isMissing = (error: unknown) => error instanceof ApiError && error.status === 404 && error.code === "no_such_path";
/** What is at `path` right now, or null when the name is free. */
export async function existing(api: DriveApi, path: string) {
  try { return await api.stat(path); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}
/** The first free "name (2).ext", "name (3).ext"… next to `path`, for keeping both files on a name conflict. */
export async function freePath(api: DriveApi, path: string): Promise<string> {
  const slash = path.lastIndexOf("/") + 1;
  const name = path.slice(slash);
  const dot = name.lastIndexOf(".");
  const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; n < 100; n++) {
    const candidate = `${path.slice(0, slash)}${base} (${n})${extension}`;
    if (!(await existing(api, candidate))) return candidate;
  }
  throw new Error("Too many files share this name. Rename the file before uploading.");
}
export async function uploadFile(
  api: DriveApi,
  file: File,
  path: string,
  progress: (value: UploadProgress) => void,
  { mode = "replace", signal }: UploadOptions = {},
): Promise<void> {
  const checkpoint = () => { if (signal?.aborted) throw new DOMException("Upload cancelled.", "AbortError"); };
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_WEB_UPLOAD)
    throw new Error("Files up to 3 GB can be uploaded in the browser. Use the Orbit Mac app for larger files.");
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || path.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(path) || new TextEncoder().encode(path).length > 1024)
    throw new Error("This file name is not supported. Rename it before uploading.");
  // Read the authoritative head before hashing, including names outside the loaded list page.
  let version: string | undefined;
  if (mode === "replace") {
    const head = await existing(api, path);
    if (head && head.type !== "file") throw new Error("A folder already uses this name.");
    version = head?.versionId;
  }
  const shards: Shard[] = [];
  progress({ phase: "hashing", bytes: 0, total: file.size });
  // Sliding reads cap chunking memory at 16 MiB even for large browser uploads.
  for (let offset = 0; offset < file.size;) {
    checkpoint();
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
    throw new Error("This file is too large to upload in the browser. Use the Orbit Mac app.");
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
        checkpoint();
        const bytes = new Uint8Array(await file.slice(shard.offset, shard.offset + shard.n).arrayBuffer());
        await api.putShard(shard.h, bytes);
        bytesDone += weights.get(shard.h)!;
        progress({ phase: "uploading", bytes: bytesDone, total: file.size });
      } catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
  checkpoint();
  progress({ phase: "committing", bytes: file.size, total: file.size });
  await api.commit(operation);
  progress({ phase: "done", bytes: file.size, total: file.size });
}
