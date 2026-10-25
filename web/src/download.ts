import type { DriveApi, Manifest } from "./api";
export const MAX_WEB_DOWNLOAD = 512 * 1024 * 1024;
export async function assembleFile(
  manifest: Manifest,
  fetchShard: (hash: string) => Promise<ArrayBuffer>,
  onProgress: (bytes: number) => void,
): Promise<Blob> {
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 0)
    throw new Error("Invalid file size.");
  if (manifest.size > MAX_WEB_DOWNLOAD)
    throw new Error(
      "For files above 512 MiB, use the desktop app to download in Finder.",
    );
  if (
    manifest.shards.some(
      (shard) => !Number.isSafeInteger(shard.n) || shard.n < 0,
    ) ||
    manifest.shards.reduce((sum, shard) => sum + shard.n, 0) !== manifest.size
  )
    throw new Error("The file manifest has an invalid size.");
  const parts: ArrayBuffer[] = [];
  let received = 0;
  onProgress(0);
  for (const shard of manifest.shards) {
    const bytes = await fetchShard(shard.h);
    if (bytes.byteLength !== shard.n)
      throw new Error("A downloaded shard is incomplete. Please try again.");
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== shard.h)
      throw new Error(
        "A downloaded shard failed its integrity check. Please try again.",
      );
    parts.push(bytes);
    received += bytes.byteLength;
    onProgress(received);
  }
  return new Blob(parts, {
    type: manifest.contentType || "application/octet-stream",
  });
}
export async function downloadFile(
  api: DriveApi,
  path: string,
  onProgress: (bytes: number, total: number) => void,
  versionId?: string,
) {
  const manifest = await api.manifest(path, versionId);
  const blob = await assembleFile(manifest, api.shard.bind(api), (bytes) =>
    onProgress(bytes, manifest.size),
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = path.split("/").pop() || "download";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
