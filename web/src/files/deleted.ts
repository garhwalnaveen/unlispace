import type { Change, DriveApi, TreeEntry, Version } from "../api";

const WINDOW = 1000;
export interface DeletedItem { path: string; isFolder: boolean; ev: number }
export interface DeletedPage { items: DeletedItem[]; /** Oldest event read so far; 0 when the whole history has been read. */ from: number }

/** Every version of `path`, oldest first. Works for deleted paths too. */
export async function allVersions(api: DriveApi, path: string): Promise<Version[]> {
  const versions: Version[] = [];
  let cursor: string | null = null;
  do {
    const page: { versions: Version[]; cursor: string | null } = await api.versions(path, cursor);
    if (page.cursor && page.cursor === cursor) throw new Error("The history could not be read. Please try again.");
    versions.push(...page.versions);
    cursor = page.cursor;
  } while (cursor);
  return versions;
}

/**
 * Items whose latest activity is a deletion, newest first. Reads the drive's activity backwards in
 * windows; pass the previous page to read further back.
 */
export async function deletedItems(api: DriveApi, previous?: DeletedPage & { seen: Map<string, Change> }) {
  const end = previous ? previous.from : (await api.changes(Number.MAX_SAFE_INTEGER, 1)).lastEv;
  const from = Math.max(0, end - WINDOW);
  const seen = new Map(previous?.seen);
  const changes = end > from ? (await api.changes(from, WINDOW)).changes.filter((change) => change.ev <= end) : [];
  // Newer activity wins: a path that was restored or recreated after its deletion is not deleted.
  for (const change of [...changes].reverse()) if (!seen.has(change.path)) seen.set(change.path, change);
  const items = [...seen.values()]
    // A rename logs the old path as a deletion without a version; that item still exists elsewhere.
    .filter((change) => change.op === "delete" && change.versionId)
    .sort((a, b) => b.ev - a.ev)
    .map((change) => ({ path: change.path, isFolder: change.path.endsWith("/"), ev: change.ev }));
  return { items, from, seen };
}

/** Puts a deleted file back where it was, with the contents it had when it was deleted. */
export async function restoreDeletedFile(api: DriveApi, writeApi: DriveApi, path: string) {
  const versions = await allVersions(api, path);
  const last = versions.filter((version) => version.op !== "delete" && version.size !== null).at(-1);
  if (!last) throw new Error("This file has no saved contents to restore.");
  await writeApi.restore(path, last.versionId, null, true);
}

/** Puts a deleted folder back with everything it held at the moment it was deleted. Files that exist again are left alone. */
export async function restoreDeletedFolder(api: DriveApi, writeApi: DriveApi, folder: string): Promise<{ restored: number; skipped: number }> {
  const removal = (await allVersions(api, folder.replace(/\/$/, ""))).filter((version) => version.op === "delete").at(-1);
  if (!removal) throw new Error("This folder can’t be found in the drive’s history.");
  const entries: TreeEntry[] = [];
  let cursor: string | null = null;
  do {
    const page: { entries: TreeEntry[]; cursor: string | null } = await api.treeAt(folder, removal.ts - 1, cursor);
    entries.push(...page.entries);
    cursor = page.cursor;
  } while (cursor);
  const folders = [folder, ...entries.filter((entry) => entry.type === "folder").map((entry) => entry.path)];
  for (let i = 0; i < folders.length; i += 500)
    await writeApi.commit(folders.slice(i, i + 500).map((path) => ({ op: "mkdir" as const, path })));
  const files = entries.filter((entry) => entry.type === "file");
  let restored = 0, skipped = 0, next = 0, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (!failure && next < files.length) {
      const file = files[next++];
      try { await writeApi.restore(file.path, file.versionId, null, true); restored++; }
      catch (error) {
        // 412: a file is already at that path. Leave it and carry on.
        if ((error as { status?: number }).status === 412) skipped++; else failure = error;
      }
    }
  }));
  if (failure) throw failure;
  return { restored, skipped };
}
