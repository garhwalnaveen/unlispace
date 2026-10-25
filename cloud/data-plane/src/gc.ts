import { loadManifest } from "./manifests";

export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const GC_GRACE_MS = 7 * GC_INTERVAL_MS;
const PAGE = 100;

export const GC_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS gc_marks(h TEXT PRIMARY KEY)`,
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

/** One lineage = one drive until forks exist. Caller serializes steps with commits and shard registrations. */
export class LineageGC {
	constructor(private sql: SqlStorage, private bucket: Pick<R2Bucket, "get" | "list" | "delete">, private lineage: string) {}

	async step(generation: number, now: number, dryRun = true): Promise<GCProgress> {
		let state = this.sql.exec<State>("SELECT * FROM gc_state WHERE id=1").toArray()[0];
		// A commit between pages invalidates the mark snapshot; never sweep against stale marks.
		if (!state || state.generation !== generation || state.dry_run !== Number(dryRun) || state.phase === "done") {
			this.sql.exec("DELETE FROM gc_marks");
			this.sql.exec(`INSERT OR REPLACE INTO gc_state VALUES(1,?,'mark',0,NULL,?,?,0,0,0)`, generation, now - GC_GRACE_MS, Number(dryRun));
			state = this.sql.exec<State>("SELECT * FROM gc_state WHERE id=1").one();
		}
		if (state.phase === "mark") {
			// All history is retained: deleted files and soft-deleted drives still protect their bytes.
			const versions = this.sql.exec<{ rid: number; manifest: string }>(
				"SELECT rowid AS rid,manifest FROM versions WHERE rowid>? AND manifest IS NOT NULL ORDER BY rowid LIMIT ?", state.version_cursor, PAGE,
			).toArray();
			for (const version of versions) {
				const shards = await loadManifest(this.bucket, this.lineage, version.manifest);
				for (const [hash] of shards) this.sql.exec("INSERT OR IGNORE INTO gc_marks(h) VALUES(?)", hash);
			}
			this.sql.exec("UPDATE gc_state SET version_cursor=?,phase=? WHERE id=1", versions.at(-1)?.rid ?? state.version_cursor, versions.length < PAGE ? "sweep" : "mark");
		} else {
			const prefix = `shards/${this.lineage}/`;
			const page = await this.bucket.list({ prefix, limit: PAGE, ...(state.object_cursor ? { cursor: state.object_cursor } : {}) });
			for (const object of page.objects) {
				state.scanned++;
				const hash = object.key.slice(prefix.length);
				if (!/^[0-9a-f]{64}$/.test(hash) || object.uploaded.getTime() >= state.cutoff || this.sql.exec("SELECT 1 FROM gc_marks WHERE h=?", hash).toArray().length) continue;
				state.candidates++;
				if (!dryRun) {
					// Invalidate first: failure/crash leaves a repairable cache miss, never a false positive.
					this.sql.exec("DELETE FROM shards_known WHERE h=?", hash);
					await this.bucket.delete(object.key);
					state.deleted++;
				}
			}
			this.sql.exec("UPDATE gc_state SET object_cursor=?,phase=?,scanned=?,candidates=?,deleted=? WHERE id=1", page.truncated ? page.cursor : null, page.truncated ? "sweep" : "done", state.scanned, state.candidates, state.deleted);
		}
		const result = this.sql.exec<State>("SELECT * FROM gc_state WHERE id=1").one();
		return { done: result.phase === "done", dryRun: !!result.dry_run, scanned: result.scanned, candidates: result.candidates, deleted: result.deleted };
	}
}
