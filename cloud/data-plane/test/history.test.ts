import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { DriveAuthority } from "../src/drive";
import type { DataPlaneAdmin } from "../src/index";
import { LineageGC } from "../src/gc";
import { migrateHistory } from "../src/history";
import { api, commit, newDrive, putFile } from "./helpers";
const stub = (id: string) => { const ns = env.DRIVE_AUTHORITY as DurableObjectNamespace<DriveAuthority>; return ns.get(ns.idFromName(id)); };
const admin = (exports as unknown as {
    DataPlaneAdmin: Pick<DataPlaneAdmin, "forkDrive" | "restoreSnapshot" | "deleteDrive">;
}).DataPlaneAdmin;
async function get(d: string, route: string) { const r = await api(`/v0/drives/${d}/${route}`); expect(r.status, await r.clone().text()).toBe(200); return r.json() as Promise<any>; }
async function move(d: string, from: string, to: string) { expect((await commit(d, [{ op: "rename", from, to }])).status).toBe(200); }
it("reads and restores old content at the renamed key, omits rename versions, and isolates recreated identities", async () => {
    const d = await newDrive();
    await putFile(d, "a", "old");
    const first = await get(d, "manifest?path=a");
    await putFile(d, "a", "new");
    await move(d, "a", "b");
    expect((await get(d, "versions?path=b")).versions.map((v: any) => v.op)).toEqual(["put", "put"]);
    expect((await get(d, "versions?path=b&includeRenames=1")).versions.map((v: any) => v.op)).toEqual(["put", "put", "rename"]);
    expect((await get(d, `manifest?path=b&versionId=${first.versionId}`)).shards).toEqual(first.shards);
    expect((await api(`/v0/drives/${d}/restore`, { json: { path: "b", versionId: first.versionId } })).status).toBe(200);
    expect((await get(d, "versions?path=b")).versions.at(-1)).toMatchObject({ operation: "restore", restoredFrom: first.versionId });
    await runInDurableObject(stub(d), async (_, ctx) => {
        const gc = new LineageGC(ctx.storage.sql, env.SHARDS, d);
        await gc.step(4, Date.now());
        expect(ctx.storage.sql.exec("SELECT 1 FROM gc_marks WHERE h=?", first.shards[0].h).toArray()).toHaveLength(1);
    });
    await commit(d, [{ op: "delete", path: "b" }]);
    expect((await api(`/v0/drives/${d}/restore`, { json: { path: "b", versionId: first.versionId } })).status).toBe(200);
    expect((await get(d, "versions?path=b")).versions[0].versionId).toBe(first.versionId);
    await commit(d, [{ op: "delete", path: "b" }]);
    await putFile(d, "b", "recreated");
    await putFile(d, "a", "other");
    expect((await get(d, "versions?path=b")).versions).toHaveLength(1);
    expect((await api(`/v0/drives/${d}/manifest?path=b&versionId=${first.versionId}`)).status).toBe(404);
    expect((await api(`/v0/drives/${d}/restore`, { json: { path: "b", versionId: first.versionId } })).status).toBe(404);
});
it("records nested descendant paths, paginates historical trees, forks and snapshots history", async () => {
    const d = await newDrive();
    await putFile(d, "old/nest/f", "content");
    const original = await get(d, "manifest?path=old/nest/f");
    const before = await runInDurableObject(stub(d), async (_, ctx) => { ctx.storage.sql.exec("UPDATE path_log SET ts=10"); ctx.storage.sql.exec("UPDATE versions SET ts=10"); return 10; });
    await move(d, "old/", "new/");
    await move(d, "new/nest/", "new/deep/");
    const p1 = await get(d, `tree-at?path=old/&ts=${before}&limit=1`);
    expect(p1.entries).toMatchObject([{ path: "old/nest/", type: "folder" }]);
    expect(p1.cursor).toBeTruthy();
    const p2 = await get(d, `tree-at?path=old/&ts=${before}&limit=1&cursor=${p1.cursor}`);
    expect(p2.entries).toMatchObject([{ path: "old/nest/f", versionId: original.versionId, size: 7, type: "file" }]);
    expect(p2.cursor).toBeNull();
    expect((await get(d, "tree-at?path=new/&ts=9007199254740991")).entries.map((v: any) => v.path)).toEqual(["new/deep/", "new/deep/f"]);
    expect((await get(d, `manifest?path=new/deep/f&versionId=${original.versionId}`)).shards).toEqual(original.shards);
    const child = d + "-fork";
    await admin.forkDrive(d, child);
    expect(await get(child, "versions?path=new/deep/f")).toEqual(await get(d, "versions?path=new/deep/f"));
    expect(await get(child, "tree-at?path=old/&ts=10")).toEqual(await get(d, "tree-at?path=old/&ts=10"));
    const snapshot = await runInDurableObject(stub(d), async (instance, ctx) => { ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES('snapshot_at','0')"); return instance.snapshot(); });
    expect(snapshot).toBeTruthy();
    await admin.deleteDrive(d, { hard: true });
    await admin.restoreSnapshot(d, snapshot!);
    expect((await get(d, `manifest?path=new/deep/f&versionId=${original.versionId}`)).shards).toEqual(original.shards);
    expect(await get(d, "tree-at?path=old/&ts=10")).toMatchObject({ entries: [{ path: "old/nest/" }, { path: "old/nest/f" }] });
});
it("backfills legacy rename pairs and descendant histories without merging reused paths", async () => {
    const d = await newDrive();
    await putFile(d, "old/sub/f", "one");
    await move(d, "old/", "new/");
    await runInDurableObject(stub(d), async (_, ctx) => {
        const sql = ctx.storage.sql;
        const rename = sql.exec<{
            id: string;
            seq: number;
            ts: number;
        }>("SELECT * FROM versions WHERE op='rename'").one();
        sql.exec("INSERT INTO versions(id,path,op,seq,ts) VALUES(?,'old','delete',?,?)", rename.id + "-legacy-delete", rename.seq, rename.ts);
        sql.exec("UPDATE versions SET node_id=NULL");
        sql.exec("DELETE FROM path_log");
        migrateHistory(sql);
    });
    expect((await get(d, "versions?path=new/sub/f")).versions).toHaveLength(1);
    expect((await get(d, "tree-at?path=&ts=9007199254740991")).entries.map((x: any) => x.path)).toEqual(["new/", "new/sub/", "new/sub/f"]);
});
it("upgrades legacy fork and snapshot imports that lack the history columns and table", async () => {
    const source = await newDrive();
    await putFile(source, "before/f", "legacy");
    const first = await get(source, "manifest?path=before/f");
    await move(source, "before/", "after/");
    const exported = await stub(source).beginExport();
    if (!exported.ok)
        throw new Error("export failed");
    const page = await stub(source).exportPage(exported.data.token);
    const rows = page.rows.filter(r => JSON.parse(r.payload).table !== "path_log").map(r => {
        const parsed = JSON.parse(r.payload);
        if (parsed.table === "versions") {
            delete parsed.row.node_id;
            delete parsed.row.restored_from;
        }
        return { ...r, payload: JSON.stringify(parsed) };
    });
    for (const fork of [true, false]) {
        const target = source + (fork ? "-fork" : "-snapshot");
        expect((await stub(target).reserveImport(exported.data.token)).ok).toBe(true);
        await stub(target).importPage(exported.data.token, rows);
        await stub(target).finishImport(exported.data.token, target, exported.data, fork);
        expect((await get(target, `manifest?path=after/f&versionId=${first.versionId}`)).shards).toEqual(first.shards);
        expect((await get(target, "versions?path=after/f")).versions).toHaveLength(1);
    }
    await stub(source).endExport(exported.data.token);
});
