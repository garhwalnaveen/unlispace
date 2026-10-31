import { iterateManifest, loadXattrs } from "./manifests";

export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const GC_GRACE_MS = 7 * GC_INTERVAL_MS;
const PAGE = 100;

export const GC_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS gc_marks(h TEXT PRIMARY KEY)`,
	`CREATE TABLE IF NOT EXISTS gc_manifest_marks(h TEXT PRIMARY KEY)`,
	`CREATE TABLE IF NOT EXISTS gc_pending(k TEXT PRIMARY KEY, generation INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS gc_state(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL,
 phase TEXT NOT NULL, version_cursor INTEGER NOT NULL, object_cursor TEXT, cutoff INTEGER NOT NULL,
 dry_run INTEGER NOT NULL, scanned INTEGER NOT NULL, candidates INTEGER NOT NULL, deleted INTEGER NOT NULL)`,
];
interface State extends Record<string, SqlStorageValue> {
	generation: number;
	phase: string;
	version_cursor: number;
	object_cursor: string | null;
	cutoff: number;
	dry_run: number;
	scanned: number;
	candidates: number;
	deleted: number;
}

export interface GCProgress {
	done: boolean;
	dryRun: boolean;
	scanned: number;
	candidates: number;
	deleted: number;
}

/** Caller serializes steps with commits and root membership registration. */
export class LineageGC {
	constructor(private sql: SqlStorage, private bucket: Pick<R2Bucket, "get" | "list" | "delete">, private lineage: string,
		private deleteObject?: (key: string) => Promise<boolean>, private recoverDeletion?: (key: string) => Promise<void>) {}

	private invalidate(key: string): void {
		if (!key.startsWith("shards/")) return;
		const hash = key.slice(key.lastIndexOf("/") + 1);
		this.sql.exec("DELETE FROM shards_known WHERE h=?", hash);
		if (this.sql.exec("SELECT 1 FROM sqlite_master WHERE name='drive_shards'").toArray().length)
			this.sql.exec("DELETE FROM drive_shards WHERE h=?", hash);
	}
	private async remove(key: string): Promise<boolean> {
		this.invalidate(key);
		if (this.deleteObject) return this.deleteObject(key);
		await this.bucket.delete(key); return true;
	}

	async step(generation: number, now: number, dryRun = true): Promise<GCProgress> {
		const shared = this.sql.exec("SELECT 1 FROM sqlite_master WHERE name='lineage_members'").toArray().length &&
			this.sql.exec("SELECT 1 FROM lineage_members WHERE drive_id<>? AND removed_at IS NULL LIMIT 1", this.lineage).toArray().length;
		const child = this.sql.exec<{v: string}>("SELECT v FROM meta WHERE k='drive_id'").toArray()[0]?.v !== this.lineage;
		const protectedLineage = !!(shared || child || this.sql.exec("SELECT 1 FROM meta WHERE k='gc_restored' AND v='1'").toArray().length);
		for (const pending of this.sql.exec<{k:string;generation:number}>("SELECT * FROM gc_pending").toArray()) {
			// New commits or lineage members invalidate the old deletion decision. Never repeat that delete.
			if (pending.generation !== generation || protectedLineage || dryRun) await this.recoverDeletion?.(pending.k);
			else await this.remove(pending.k);
			this.sql.exec("DELETE FROM gc_pending WHERE k=?", pending.k);
		}
		if (protectedLineage) return {done: true, dryRun: true, scanned: 0, candidates: 0, deleted: 0};
		let state = this.sql.exec<State>("SELECT * FROM gc_state WHERE id=1").toArray()[0];
		// A commit between pages invalidates the mark snapshot; never sweep against stale marks.
		if (!state || state.generation !== generation || state.dry_run !== Number(dryRun) || state.phase === "done") {
			this.sql.exec("DELETE FROM gc_marks");
			this.sql.exec("DELETE FROM gc_manifest_marks");
			this.sql.exec(`INSERT OR REPLACE INTO gc_state VALUES(1,?,'mark',0,NULL,?,?,0,0,0)`, generation, now - GC_GRACE_MS, Number(dryRun));
			state = this.sql.exec<State>("SELECT * FROM gc_state WHERE id=1").one();
		}
		if (state.phase === "mark") {
			// All history is retained: deleted files and soft-deleted drives still protect their bytes.
			const hasXattrs = this.sql.exec<{name:string}>("PRAGMA table_info(versions)").toArray().some(c => c.name === "xattrs");
			const versions = this.sql.exec<{ rid: number; manifest: string; xattrs:string|null }>(
				`SELECT rowid AS rid,manifest,${hasXattrs ? "xattrs" : "NULL AS xattrs"} FROM versions WHERE rowid>? AND manifest IS NOT NULL ORDER BY rowid LIMIT ?`, state.version_cursor, PAGE,
			).toArray();
			for (const version of versions) {
				for (const ref of [version.manifest, version.xattrs]) if (ref?.startsWith("r2:"))
					this.sql.exec("INSERT OR IGNORE INTO gc_manifest_marks(h) VALUES(?)", ref.slice(3));
				for await (const page of iterateManifest(this.bucket, this.lineage, version.manifest)) {
                    for (const hash of page.metadata) this.sql.exec("INSERT OR IGNORE INTO gc_manifest_marks(h) VALUES(?)",hash);
                    for (const [hash] of page.shards) this.sql.exec("INSERT OR IGNORE INTO gc_marks(h) VALUES(?)", hash);
                }
				for (const refs of Object.values(await loadXattrs(this.bucket, this.lineage, version.xattrs)))
					for (const [hash] of refs) this.sql.exec("INSERT OR IGNORE INTO gc_marks(h) VALUES(?)", hash);
			}
			this.sql.exec("UPDATE gc_state SET version_cursor=?,phase=? WHERE id=1", versions.at(-1)?.rid ?? state.version_cursor, versions.length < PAGE ? "sweep" : "mark");
		} else {
			const manifests = state.phase === "sweep-manifests";
			const prefix = `${manifests ? "manifests" : "shards"}/${this.lineage}/`;
			const page = await this.bucket.list({ prefix, limit: PAGE, ...(state.object_cursor ? { cursor: state.object_cursor } : {}) });
			for (const object of page.objects) {
				state.scanned++;
				const hash = object.key.slice(prefix.length);
				if (!/^[0-9a-f]{64}$/.test(hash) || object.uploaded.getTime() >= state.cutoff || this.sql.exec(`SELECT 1 FROM ${manifests ? "gc_manifest_marks" : "gc_marks"} WHERE h=?`, hash).toArray().length) continue;
				state.candidates++;
				if (!dryRun) {
					this.sql.exec("INSERT OR REPLACE INTO gc_pending VALUES(?,?)", object.key, generation);
					if (await this.remove(object.key)) state.deleted++;
					this.sql.exec("DELETE FROM gc_pending WHERE k=?", object.key);
				}
			}
			this.sql.exec("UPDATE gc_state SET object_cursor=?,phase=?,scanned=?,candidates=?,deleted=? WHERE id=1", page.truncated ? page.cursor : null, page.truncated ? state.phase : manifests ? "done" : "sweep-manifests", state.scanned, state.candidates, state.deleted);
		}
		const result = this.sql.exec<State>("SELECT * FROM gc_state WHERE id=1").one();
		return { done: result.phase === "done", dryRun: !!result.dry_run, scanned: result.scanned, candidates: result.candidates, deleted: result.deleted };
	}
}
