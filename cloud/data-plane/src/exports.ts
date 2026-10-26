import type { Placement } from "./types";

export const EXPORT_COLUMNS = {
	meta: ["k", "v"], nodes: ["id", "parent_id", "name", "type", "head", "size", "ctype", "mtime", "seq"],
	versions: ["id", "path", "op", "size", "manifest", "seq", "ts", "actor", "ctype", "mtime", "node_id", "restored_from"],
	path_log: ["seq", "ts", "node_id", "path", "op"],
	log: ["rowid", "seq", "path", "op", "version"],
	shards_known: ["h", "n", "inherited"], lineage_members: ["drive_id", "added_at", "removed_at"],
} as const;
export interface ExportRow { table: keyof typeof EXPORT_COLUMNS; row: Record<string, SqlStorageValue> }
export interface ExportHeader { token: string; driveId: string; lineage: string; depth: number; seq: number; ts: number; placement: Placement | null }

/** Snapshot and fork pages share the same bounded NDJSON row representation. */
export function validateExportRow(value: unknown): ExportRow {
	const r = value as ExportRow;
	if (!r || !Object.hasOwn(EXPORT_COLUMNS, r.table) || !r.row || typeof r.row !== "object") throw new Error("invalid snapshot row");
	if (r.table === "versions") {
		if (!Object.hasOwn(r.row,"node_id")) r.row.node_id=null;
		if (!Object.hasOwn(r.row,"restored_from")) r.row.restored_from=null;
	}
	const columns = EXPORT_COLUMNS[r.table];
	if (Object.keys(r.row).length !== columns.length || !columns.every(c => Object.hasOwn(r.row, c)) ||
		Object.values(r.row).some(v => v !== null && typeof v !== "string" && typeof v !== "number")) throw new Error("invalid snapshot row");
	return r;
}

/** The queued operation checks the same deadline before mutating state after a timeout. */
export function withinDeadline<T>(task: Promise<T>, at: number, expired: () => T): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<T>(resolve => { timer = setTimeout(() => resolve(expired()), Math.max(0, at - Date.now())); });
	return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}
