import { expect, it, vi } from "vitest";
import { ApiError, type DriveApi } from "../src/api";
import { deletedItems, restoreDeletedFile, restoreDeletedFolder } from "../src/files/deleted";

const change = (ev: number, path: string, op: string, versionId: string | null = `v_${ev}`) => ({ ev, seq: ev, path, op, versionId });
const version = (versionId: string, op: string, ts: number, size: number | null = 1) => ({ versionId, op, size, seq: 1, ts, actor: null });

it("reads activity backwards in windows and keeps only items whose latest event is a real deletion", async () => {
  const log = [
    change(1, "gone.txt", "put"), change(2, "gone.txt", "delete"),
    ...Array.from({ length: 1000 }, (_, index) => change(3 + index, `bulk-${index}.txt`, "put")),
    change(1003, "back.txt", "delete"), change(1004, "back.txt", "restore"),
    change(1005, "old-name.txt", "delete", null), change(1006, "new-name.txt", "rename"),
    change(1007, "dir/", "delete"),
  ];
  const api = { changes: vi.fn(async (after: number, limit: number) => ({ changes: log.filter((item) => item.ev > after).slice(0, limit), lastEv: log.length, more: false })) } as unknown as DriveApi;
  const first = await deletedItems(api);
  expect(first.items).toEqual([{ path: "dir/", isFolder: true, ev: 1007 }]);
  expect(first.from).toBe(7);
  const second = await deletedItems(api, first);
  expect(second.items.map((item) => item.path)).toEqual(["dir/", "gone.txt"]);
  expect(second.from).toBe(0);
});

it("restores a deleted file from its last version that has contents, only if the name is still free", async () => {
  const api = { versions: vi.fn().mockResolvedValueOnce({ versions: [version("v_1", "put", 1)], cursor: "next" }).mockResolvedValueOnce({ versions: [version("v_2", "put", 2), version("v_3", "delete", 3, null)], cursor: null }) } as unknown as DriveApi;
  const writeApi = { restore: vi.fn().mockResolvedValue({ seq: 9, results: [] }) } as unknown as DriveApi;
  await restoreDeletedFile(api, writeApi, "docs/a.txt");
  expect(writeApi.restore).toHaveBeenCalledWith("docs/a.txt", "v_2", null, true);
});

it("restores a deleted folder as it was just before deletion and leaves files that exist again alone", async () => {
  const api = {
    versions: vi.fn().mockResolvedValue({ versions: [version("v_m", "mkdir", 100, 0), version("v_d", "delete", 5000, null)], cursor: null }),
    treeAt: vi.fn().mockResolvedValue({ cursor: null, entries: [
      { path: "dir/sub/", versionId: "v_s", size: 0, type: "folder" }, { path: "dir/a.txt", versionId: "v_a", size: 1, type: "file" }, { path: "dir/sub/b.txt", versionId: "v_b", size: 1, type: "file" },
    ] }),
  } as unknown as DriveApi;
  const writeApi = {
    commit: vi.fn().mockResolvedValue({ seq: 1, results: [] }),
    restore: vi.fn(async (path: string) => { if (path === "dir/a.txt") throw new ApiError(412, "precondition_failed"); return { seq: 2, results: [] }; }),
  } as unknown as DriveApi;
  await expect(restoreDeletedFolder(api, writeApi, "dir/")).resolves.toEqual({ restored: 1, skipped: 1 });
  expect(api.versions).toHaveBeenCalledWith("dir", null);
  expect(api.treeAt).toHaveBeenCalledWith("dir/", 4999, null);
  expect(writeApi.commit).toHaveBeenCalledWith([{ op: "mkdir", path: "dir/" }, { op: "mkdir", path: "dir/sub/" }]);
  expect(writeApi.restore).toHaveBeenCalledWith("dir/sub/b.txt", "v_b", null, true);
});
