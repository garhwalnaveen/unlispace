import { LIVE_TREE } from "./nodes";
export const HISTORY_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS path_log(seq INTEGER NOT NULL, ts INTEGER NOT NULL, node_id TEXT NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS path_log_node ON path_log(node_id,ts,seq)`,
    `CREATE INDEX IF NOT EXISTS path_log_path ON path_log(path,seq)`,
];
/** Replay legacy versions, including the old rename + synthetic-delete pair. */
export function migrateHistory(sql: SqlStorage): void {
    const columns = sql.exec<{
        name: string;
    }>("PRAGMA table_info(versions)").toArray();
    for (const column of ["node_id", "restored_from"])
        if (!columns.some(c => c.name === column))
            sql.exec(`ALTER TABLE versions ADD COLUMN ${column} TEXT`);
    sql.exec("CREATE INDEX IF NOT EXISTS versions_node ON versions(node_id,seq)");
    if (!sql.exec("SELECT 1 FROM versions WHERE node_id IS NULL LIMIT 1").toArray().length)
        return;
    // The old log retains both rename endpoints; legacy forks may retain only a resync.
    const renameSources = new Map<string, string>();
    let source: {
        seq: number;
        path: string;
    } | undefined;
    for (const event of sql.exec<{
        seq: number;
        path: string;
        op: string;
        version: string | null;
    }>("SELECT * FROM log ORDER BY rowid")) {
        if (event.op === "rename" && event.version && source?.seq === event.seq)
            renameSources.set(event.version, source.path.replace(/\/$/, ""));
        source = event.op === "delete" && event.version === null ? event : undefined;
    }
    const rows = sql.exec<{
        id: string;
        path: string;
        op: string;
        seq: number;
        ts: number;
        manifest: string | null;
        node_id: string | null;
    }>("SELECT * FROM versions ORDER BY rowid").toArray();
    const live = new Map(sql.exec<{
        id: string;
        path: string;
    }>(LIVE_TREE + " SELECT id,path FROM tree").toArray().map(n => [n.path, n.id]));
    const paths = new Map<string, string>();
    const last = new Map<string, string>();
    const record = (v: typeof rows[number], id: string, path: string, op: string) => sql.exec("INSERT INTO path_log VALUES(?,?,?,?,?)", v.seq, v.ts, id, path, op);
    sql.exec("DELETE FROM path_log");
    for (let i = 0; i < rows.length; i++) {
        const v = rows[i]!;
        if (v.op === "rename") {
            const old = rows[i + 1];
            const paired = old?.op === "delete" && old.seq === v.seq && (!renameSources.has(v.id) || old.path === renameSources.get(v.id));
            const from = renameSources.get(v.id) ?? (paired ? old.path : undefined);
            if (from !== undefined) {
                const id = paths.get(from) ?? v.node_id ?? `history:${v.id}`;
                paths.set(from, id);
                for (const [path, node] of [...paths])
                    if (path === from || path.startsWith(from + "/")) {
                        const dest = v.path + path.slice(from.length);
                        paths.delete(path);
                        paths.set(dest, node);
                        record(v, node, dest, "rename");
                    }
                sql.exec("UPDATE versions SET node_id=? WHERE id=?", id, v.id);
                last.set(id, v.id);
                // The second row never represented an independent content version.
                if (paired) {
                    sql.exec("UPDATE versions SET node_id=? WHERE id=?", `legacy-rename:${old.id}`, old.id);
                    i++;
                }
                continue;
            }
        }
        const id = paths.get(v.path) ?? v.node_id ?? `history:${v.id}`;
        sql.exec("UPDATE versions SET node_id=? WHERE id=?", id, v.id);
        last.set(id, v.id);
        if (v.op === "delete") {
            for (const [path, node] of [...paths])
                if (path === v.path || path.startsWith(v.path + "/")) {
                    record(v, node, path, "delete");
                    paths.delete(path);
                }
        }
        else {
            paths.set(v.path, id);
            record(v, id, v.path, v.op);
        }
    }
    for (const [path, id] of paths) {
        const actual = live.get(path) ?? sql.exec<{
            id: string;
        }>("SELECT id FROM nodes WHERE head=?", last.get(id) ?? "").toArray()[0]?.id;
        if (actual && actual !== id) {
            sql.exec("UPDATE versions SET node_id=? WHERE node_id=?", actual, id);
            sql.exec("UPDATE path_log SET node_id=? WHERE node_id=?", actual, id);
        }
    }
}
