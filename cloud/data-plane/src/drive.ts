import { HISTORY_SCHEMA, migrateHistory } from "./history";
import { DurableObject } from "cloudflare:workers";
import { createUlid } from "./ulid";
import { LIVE_TREE, migrateNodes, migrateSearch, NodeTree, type NodeRow } from "./nodes";
import {
	fail,
	ok,
	type ChangeEntry,
	type CommitResponse,
	type CommitResult,
	type NormOp,
	type Placement,
	type Result,
} from "./types";
import { extPath } from "./validate";
import { INLINE_MANIFEST_BYTES, iterateManifest, loadManifest, loadMetadata, loadXattrs, manifestShards, manifestTree, readManifestPage, storeManifest, storeMetadata } from "./manifests";
import { EXPORT_COLUMNS, validateExportRow, withinDeadline, type ExportHeader } from "./exports";
import { GC_SCHEMA, GC_INTERVAL_MS, LineageGC } from "./gc";
import { quotaFor } from "./quota";
import { hasBranches, migrateBranches, forkBranch, branchSql, branchIds } from "./mvcc";

type Row = Record<string, SqlStorageValue>;
interface VersionRow extends Row {
	xattrs: string | null;
	node_id: string;
	restored_from: string | null;
	id: string;
	path: string;
	op: string;
	size: number | null;
	manifest: string | null;
	seq: number;
	ts: number;
	actor: string | null;
	ctype: string | null;
	mtime: number | null;
}

const SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PING_INTERVAL_MS = 30_000;
/** Internal header the Worker sets (always overwritten) on /watch upgrades: token expiry in epoch seconds, or absent. */
export const EXP_HEADER = "x-uls-token-exp";
/** WebSocket close code: token expired (contract M1 §3). Clients reconnect with a fresh token. */
export const WS_CLOSE_EXPIRED = 4401;
/** WebSocket close code: drive deleted. */
export const WS_CLOSE_DELETED = 4404;
export const DRIVE_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-socket state kept across hibernation via serializeAttachment. */
interface WsAttachment {
	drive?: string;
	/** token expiry, epoch seconds; null for the dev token (never expires) */
	exp: number | null;
	/** Replay in progress: last event id already sent. Live events are not pushed to a socket until replay completes. */
	replayAfter: number | null;
}

export const MAX_SUBTREE_NODES = 100_000;
export const MAX_BACKLOG_EVENTS = 100_000;
const REPLAY_BATCH = 500;
const REPLAY_TICK_MS = 5;
const MAX_PATH_BYTES = 1024;
interface EventRow extends Row {
	ev: number;
	seq: number;
	path: string;
	op: string;
	version: string | null;
}
const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/** Thrown inside transactionSync to roll back the whole commit. */
class Abort {
	constructor(readonly failure: ReturnType<typeof fail>) {}
}

interface CommitCtx {
	actor: string;
	seq: number;
	ts: number;
	events: ChangeEntry[];
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS drive_shards(h TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS retained_shards(h TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS commit_receipts(actor TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT, PRIMARY KEY(actor,id))`,
	`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)`,
	// ctype/mtime are M0 additions so that historical versions can serve /manifest?versionId=.
	`CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, path TEXT NOT NULL, op TEXT NOT NULL, size INTEGER, manifest TEXT, seq INTEGER NOT NULL, ts INTEGER NOT NULL, actor TEXT, ctype TEXT, mtime INTEGER)`,
	`CREATE INDEX IF NOT EXISTS versions_path ON versions(path, seq)`,
	`CREATE TABLE IF NOT EXISTS log(seq INTEGER NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL, version TEXT)`,
	`CREATE INDEX IF NOT EXISTS log_seq ON log(seq)`,
	`CREATE TABLE IF NOT EXISTS shards_known(h TEXT PRIMARY KEY, n INTEGER NOT NULL, inherited INTEGER NOT NULL DEFAULT 0)`,
	`CREATE TABLE IF NOT EXISTS lineage_members(drive_id TEXT PRIMARY KEY, added_at INTEGER NOT NULL, removed_at INTEGER)`,
	`CREATE TABLE IF NOT EXISTS export_rows(token TEXT NOT NULL, id INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(token,id))`,
];

export interface DriveInfo {
	driveId: string;
	placement: Placement | null;
	createdAt: number;
}

class DriveStore {
	private ulid = createUlid();
	private sql: SqlStorage;
	private tree: NodeTree;
	private queue: { tail: Promise<unknown> };
	private pendingSnapshot: Promise<string | null> | null = null;

	constructor(private ctx: DurableObjectState, private env: Env, sql?: SqlStorage, queue = {tail: Promise.resolve() as Promise<unknown>}) {
		this.queue = queue;
		this.sql = sql ?? ctx.storage.sql;
		if (!sql && !hasBranches(this.sql)) this.ctx.storage.transactionSync(() => {
			for (const stmt of [...SCHEMA, ...GC_SCHEMA, ...HISTORY_SCHEMA]) this.sql.exec(stmt);
			migrateNodes(this.sql);
			migrateHistory(this.sql);
            if (!this.sql.exec<{name:string}>("PRAGMA table_info(versions)").toArray().some(c => c.name === "xattrs"))
                this.sql.exec("ALTER TABLE versions ADD COLUMN xattrs TEXT");
			migrateSearch(this.sql);
			if (!this.sql.exec<{name: string}>("PRAGMA table_info(shards_known)").toArray().some(c => c.name === "inherited"))
				this.sql.exec("ALTER TABLE shards_known ADD COLUMN inherited INTEGER NOT NULL DEFAULT 0");
			const id = this.getMeta("drive_id");
			if (id) {
				if (!this.getMeta("lineage")) this.setMeta("lineage", id);
				if (!this.getMeta("depth")) this.setMeta("depth", "0");
				this.sql.exec("INSERT OR IGNORE INTO lineage_members VALUES(?,?,NULL)", id, Date.now());
				migrateBranches(this.sql,id);
			}
		});
		this.tree = new NodeTree(this.sql);
		if (!sql && this.getMeta("created_at") !== null) {
			if (this.getMeta("gc_next_at") === null) this.setMeta("gc_next_at", String(Date.now() + GC_INTERVAL_MS));
			this.ctx.waitUntil(this.scheduleAlarm(Math.min(Number(this.getMeta("gc_next_at")), this.snapshotDueAt()), null));
		}
	}

	/** Serialize R2-dependent metadata mutations without blocking reads or WebSocket alarm ticks. */
	private withIO<T>(fn: () => Promise<T>): Promise<T> {
		const task = this.queue.tail.then(fn);
		this.queue.tail = task.catch(() => undefined);
		return task;
	}

	private sockets(): WebSocket[] {
		const id = this.getMeta("drive_id");
		return this.ctx.getWebSockets().filter(ws => { const drive = (ws.deserializeAttachment() as WsAttachment | null)?.drive; return drive ? drive === id : id === this.lineage(); });
	}

	private lineage(): string { return this.getMeta("lineage") ?? this.getMeta("drive_id")!; }

	private snapshotDueAt(): number {
		return Number(this.getMeta("snapshot_next_at") ?? (Number(this.getMeta("snapshot_at") ?? this.getMeta("created_at") ?? Date.now()) + SNAPSHOT_INTERVAL_MS));
	}

	// ---------- small helpers ----------

	private getMeta(k: string): string | null {
		const r = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k=?", k).toArray();
		return r[0]?.v ?? null;
	}
	private setMeta(k: string, v: string): void {
		this.sql.exec("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", k, v);
	}
	/** The drive, or null if it was never created or has been (soft) deleted. */
	private info(): DriveInfo | null {
		const createdAt = this.getMeta("created_at");
		if (createdAt === null || this.getMeta("deleted") === "1") return null;
		const placement = this.getMeta("placement");
		return {
			driveId: this.getMeta("drive_id") ?? "",
			placement: placement ? (placement as Placement) : null,
			createdAt: Number(createdAt),
		};
	}
	private headSeq(): number {
		return Number(this.getMeta("head_seq") ?? "0");
	}
	private getNode(key: string): NodeRow | undefined {
		return this.tree.get(key);
	}
	private getVersion(id: string): VersionRow | undefined {
		return this.sql.exec<VersionRow>("SELECT * FROM versions WHERE id=?", id).toArray()[0];
	}
	private noDrive() {
		return fail(404, "no_such_drive");
	}

	// ---------- drives ----------

	/** A fork records a revision cutoff and a fixed number of metadata rows, never a tree copy. */
	forkMetadata(child: string, requested: number): Promise<Result<ExportHeader>> {
		const task = this.withIO(async () => {
			if (Date.now() - requested >= 60_000) return fail(503,"slow_down");
			const info = this.info();
			if (!info) return this.noDrive();
			if (Number(this.getMeta("depth") ?? 0) >= 8) return fail(400,"fork_depth_exceeded");
			if (!await this.ensureReferences()) return fail(503,"references_initializing");
			const header: ExportHeader = {token:"",driveId:info.driveId,lineage:this.lineage(),depth:Number(this.getMeta("depth") ?? 0),seq:this.headSeq(),ts:Date.now(),placement:info.placement};
			this.ctx.storage.transactionSync(() => {
				forkBranch(this.ctx.storage.sql,info.driveId,child);
				const sql = branchSql(this.ctx.storage.sql,child);
				const values: Record<string,string> = {drive_id:child,lineage:header.lineage,depth:String(header.depth+1),refs_ready:"1",placement:header.placement ?? "",head_seq:String(header.seq),deleted:"0",created_at:String(header.ts),forkOf:JSON.stringify({driveId:info.driveId,seq:header.seq,ts:header.ts}),gc_next_at:String(Date.now()+GC_INTERVAL_MS)};
				const org = this.getMeta("quota_org");
				if (org) values.quota_org=org;
				for (const [key,value] of Object.entries(values)) sql.exec("INSERT INTO meta VALUES(?,?)",key,value);
				sql.exec("INSERT INTO log(seq,path,op,version) VALUES(?,'','resync',NULL)",header.seq);
			});
			return ok(header);
		});
		return withinDeadline<Result<ExportHeader>>(task,requested+60_000,()=>fail(503,"slow_down"));
	}

	create(driveId: string, placement: Placement | null): Result<DriveInfo> {
		// A deleted drive keeps its id: re-creating it is refused too.
		if (this.getMeta("created_at") !== null || this.getMeta("importing") !== null) return fail(409, "drive_exists");
		const createdAt = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.setMeta("drive_id", driveId);
			this.setMeta("lineage", driveId);
			this.setMeta("depth", "0");
            this.setMeta("refs_ready", "1");
			this.sql.exec("INSERT OR REPLACE INTO lineage_members VALUES(?,?,NULL)", driveId, createdAt);
			this.setMeta("placement", placement ?? "");
			this.setMeta("head_seq", "0");
			this.setMeta("deleted", "0");
			this.setMeta("created_at", String(createdAt));
			migrateBranches(this.sql,driveId);
		});
		this.setMeta("gc_next_at", String(Date.now() + GC_INTERVAL_MS));
		this.ctx.waitUntil(this.scheduleAlarm(Math.min(Number(this.getMeta("gc_next_at")), this.snapshotDueAt()), null));
		return ok({ driveId, placement, createdAt });
	}

	/** Soft delete: refuse every request from now on and close all sockets. Idempotent; absent drives are left absent. */
	async delete(hard = false): Promise<Result<null>> {
		if (hard) await this.pendingSnapshot?.catch(() => undefined);
		return this.withIO(async () => {
			if (!this.getMeta("drive_id")) return ok(null);
			if (hard) {
				for (const ws of this.sockets()) ws.close(WS_CLOSE_DELETED, "drive_deleted");
				this.ctx.storage.transactionSync(() => {
					for (const table of ["nodes", "versions", "path_log", "log", "shards_known", "drive_shards", "retained_shards", "gc_state", "gc_marks", "gc_pending", "gc_manifest_marks", "commit_receipts"]) this.sql.exec(`DELETE FROM ${table}`);
					// Frozen exports must finish even if the source is hard-deleted mid-fork.
					const importing = this.getMeta("importing");
					if (importing) this.sql.exec("DELETE FROM export_rows WHERE token=?", importing);
					// The root registry survives hard deletion so descendants remain protected.
					this.sql.exec("DELETE FROM meta WHERE k NOT IN ('drive_id','lineage','depth')");
					this.setMeta("deleted", "1");
				});
				await this.ctx.storage.deleteAlarm();
				return ok(null);
			}
			return this.softDelete();
		});
	}

    bindQuotaOrg(org: string): void {
        const current = this.getMeta("quota_org");
        if (current && current !== org) throw new Error("quota_org_mismatch");
        this.setMeta("quota_org", org);
    }

	lineageInfo(): {lineage: string; driveId: string} | null {
		const driveId = this.getMeta("drive_id");
		return driveId ? {driveId, lineage: this.lineage()} : null;
	}

	private softDelete(): Result<null> {
		if (this.getMeta("created_at") === null || this.getMeta("deleted") === "1") return ok(null);
		this.setMeta("deleted", "1");
		this.setMeta("deleted_at", String(Date.now()));
		for (const ws of this.sockets()) {
			try {
				ws.close(WS_CLOSE_DELETED, "drive_deleted");
			} catch {
				// already closed
			}
		}
		return ok(null);
	}

	restoreDrive(): Promise<Result<DriveInfo>> {
		return this.withIO(async () => {
			if (this.getMeta("created_at") === null) return this.noDrive();
			const deletedAt = this.getMeta("deleted_at");
			if (this.getMeta("deleted") === "1" && deletedAt !== null && Number(deletedAt) + DRIVE_RECOVERY_MS <= Date.now()) return fail(410, "recovery_expired");
			this.setMeta("deleted", "0");
			this.sql.exec("DELETE FROM meta WHERE k='deleted_at'");
			return ok(this.info()!);
		});
	}

	/** Existence + lineage only. Shard routes call this per request; `describe` walks the whole tree. */
	locate(): Result<{lineage: string}> {
		if (!this.info()) return this.noDrive();
		return ok({lineage: this.lineage()});
	}

	forkInfo() {
		const info=this.info();
		return info ? ok({...info,lineage:this.lineage(),depth:Number(this.getMeta("depth") ?? 0)}) : this.noDrive();
	}

	describe(): Result<DriveInfo & {headSeq: number; fileCount: number; bytes: number; lineage: string; depth: number; forkOf: {driveId: string; forkPoint: number} | null; features: string[]}> {
		const i = this.info();
		if (!i) return this.noDrive();
		const agg = this.sql.exec<{c: number; b: number}>(LIVE_TREE + " SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS b FROM tree WHERE type='file'").one();
		const fork = this.getMeta("forkOf");
		const forkOf = fork ? JSON.parse(fork) as {driveId: string; ts: number} : null;
		return ok({...i, features: ["xattrs"], headSeq: this.headSeq(), fileCount: agg.c, bytes: agg.b, lineage: this.lineage(), depth: Number(this.getMeta("depth") ?? 0), forkOf: forkOf ? {driveId: forkOf.driveId, forkPoint: forkOf.ts} : null});
	}

	stats() {
		return this.withIO(async () => {
			const info = this.describe();
			if (!info.ok) return info;
			const bytes = this.sql.exec<{n: number}>("SELECT COALESCE(SUM(n),0) AS n FROM shards_known WHERE inherited=0").one().n;
			return ok({...info.data, ownBytes: bytes});
		});
	}

	/** Registry updates queue behind a running sweep, before any child can reference bytes. */
	member(driveId: string, removed = false, deadline?: number): Promise<boolean> {
		const task = this.withIO(async () => {
			if (deadline !== undefined && Date.now() >= deadline) return false;
			this.sql.exec("INSERT INTO lineage_members VALUES(?,?,?) ON CONFLICT(drive_id) DO UPDATE SET removed_at=excluded.removed_at",
				driveId, Date.now(), removed ? Date.now() : null);
			return true;
		});
		return deadline === undefined ? task : withinDeadline(task, deadline, () => false);
	}

	beginExport(requested = Date.now()): Promise<Result<ExportHeader>> {
		const task = this.withIO(async () => {
			if (Date.now() - requested >= 60_000) return fail(503, "slow_down");
			const info = this.info();
			if (!info) return this.noDrive();
			const header: ExportHeader = {token: crypto.randomUUID(), driveId: info.driveId, lineage: this.lineage(),
				depth: Number(this.getMeta("depth") ?? 0), seq: this.headSeq(), ts: Date.now(), placement: info.placement};
			this.ctx.storage.transactionSync(() => {
				let offset = 0;
				for (const [table, columns] of Object.entries(EXPORT_COLUMNS)) {
					const object = columns.map(c => `'${c}',${c}`).join(",");
					const order = ["nodes","versions","path_log","log"].includes(table) ? "rowid" : columns[0];
					this.sql.exec(`INSERT INTO export_rows SELECT ?,?+ROW_NUMBER() OVER (ORDER BY ${order}),
						json_object('table','${table}','row',json_object(${object})) FROM ${table}`, header.token, offset);
					offset += this.sql.exec<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
				}
			});
			return ok(header);
		});
		return withinDeadline<Result<ExportHeader>>(task, requested + 60_000, () => fail(503, "slow_down"));
	}

	exportPage(token: string, after = 0): { rows: {id: number; payload: string}[]; done: boolean } {
		const rows: {id: number; payload: string}[] = [];
		let bytes = 0;
		for (const row of this.sql.exec<{id: number; payload: string}>("SELECT id,payload FROM export_rows WHERE token=? AND id>? ORDER BY id LIMIT 100", token, after)) {
			if (rows.length && bytes + utf8Len(row.payload) > 512 * 1024) break;
			rows.push(row); bytes += utf8Len(row.payload);
		}
		const last = rows.at(-1)?.id ?? after;
		const done = !this.sql.exec("SELECT 1 FROM export_rows WHERE token=? AND id>? LIMIT 1", token, last).toArray().length;
		return {rows, done};
	}

	endExport(token: string): void { this.sql.exec("DELETE FROM export_rows WHERE token=?", token); }

	reserveImport(token: string): Result<null> {
		if (this.getMeta("created_at") !== null || this.getMeta("importing") !== null ||
			this.sql.exec("SELECT 1 FROM nodes UNION ALL SELECT 1 FROM versions LIMIT 1").toArray().length) return fail(409, "drive_exists");
		this.setMeta("importing", token);
		return ok(null);
	}

	importPage(token: string, rows: {id: number; payload: string}[]): void {
		if (this.getMeta("importing") !== token) throw new Error("invalid import token");
		this.ctx.storage.transactionSync(() => {
			for (const row of rows) {
				validateExportRow(JSON.parse(row.payload));
				this.sql.exec("INSERT INTO export_rows VALUES(?,?,?)", token, row.id, row.payload);
			}
		});
	}

	finishImport(token: string, driveId: string, header: ExportHeader, fork: boolean): Promise<void> {
		return this.withIO(async () => {
			if (this.getMeta("importing") !== token) throw new Error("invalid import token");
			this.ctx.storage.transactionSync(() => {
				for (const {payload} of this.sql.exec<{payload: string}>("SELECT payload FROM export_rows WHERE token=? ORDER BY id", token)) {
					const r = validateExportRow(JSON.parse(payload));
					const cols = EXPORT_COLUMNS[r.table];
					this.sql.exec(`INSERT OR REPLACE INTO ${r.table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`, ...cols.map(c => r.row[c]!));
				}
				if (!hasBranches(this.ctx.storage.sql)) { migrateHistory(this.sql); migrateSearch(this.sql); }
				this.setMeta("drive_id", driveId);
                this.sql.exec("DELETE FROM drive_shards");
                this.sql.exec("INSERT INTO drive_shards SELECT * FROM retained_shards");
                // Only retained grants cross a fork; the source's staged uploads stay private.
                if (this.getMeta("refs_ready") !== "1") this.sql.exec("DELETE FROM meta WHERE k IN ('refs_ready','refs_cursor')");
				this.setMeta("lineage", header.lineage);
				this.setMeta("head_seq", String(header.seq));
				this.setMeta("deleted", "0");
				if (!fork) {
					this.setMeta("gc_restored", "1");
					this.setMeta("snapshot_seq", String(header.seq));
					this.setMeta("snapshot_at", String(Date.now()));
					this.setMeta("snapshot_next_at", String(Date.now() + SNAPSHOT_INTERVAL_MS));
				}
				if (fork) {
					this.sql.exec("DELETE FROM commit_receipts");
					this.setMeta("created_at", String(header.ts));
					this.sql.exec("DELETE FROM meta WHERE k IN ('snapshot_seq','snapshot_at','snapshot_next_at')");
					this.setMeta("depth", String(header.depth + 1));
					this.setMeta("forkOf", JSON.stringify({driveId: header.driveId, seq: header.seq, ts: header.ts}));
					this.sql.exec("UPDATE shards_known SET inherited=1");
					this.sql.exec("DELETE FROM lineage_members");
					this.sql.exec("DELETE FROM log");
					this.sql.exec("INSERT INTO log(seq,path,op,version) VALUES(?,'','resync',NULL)", header.seq);
				}
				this.sql.exec("DELETE FROM meta WHERE k='importing'");
				this.sql.exec("DELETE FROM export_rows WHERE token=?", token);
				this.setMeta("gc_next_at", String(Date.now() + GC_INTERVAL_MS));
			});
			await this.scheduleAlarm(Date.now() + SNAPSHOT_INTERVAL_MS, null);
		});
	}

	cancelImport(token: string): void {
		if (this.getMeta("importing") === token) {
			this.sql.exec("DELETE FROM meta WHERE k='importing'");
			this.endExport(token);
		}
	}

	snapshot(force = false): Promise<string | null> {
		if (this.pendingSnapshot) return this.pendingSnapshot;
		const task = this.writeSnapshot(force);
		this.pendingSnapshot = task;
		return task.finally(() => { this.pendingSnapshot = null; });
	}

	private async writeSnapshot(force: boolean): Promise<string | null> {
		if (!this.info() || this.headSeq() <= Number(this.getMeta("snapshot_seq") ?? 0) || (!force &&
			Date.now() - Number(this.getMeta("snapshot_at") ?? this.getMeta("created_at") ?? 0) < SNAPSHOT_INTERVAL_MS)) return null;
		const result = await this.beginExport();
		if (!result.ok) return null;
		const header = result.data;
		const key = `snapshots/${header.driveId}/${header.seq}.ndjson.gz`;
		let after = 0;
		let started = false;
		const source = new ReadableStream<Uint8Array>({pull: controller => {
			if (!started) { controller.enqueue(new TextEncoder().encode(JSON.stringify({format: 1, ...header}) + "\n")); started = true; return; }
			const page = this.exportPage(header.token, after);
			for (const row of page.rows) controller.enqueue(new TextEncoder().encode(row.payload + "\n"));
			after = page.rows.at(-1)?.id ?? after;
			if (page.done) controller.close();
		}});
		try {
			// R2 requires a known length for put(); multipart keeps snapshot memory bounded.
			const upload = await this.env.SHARDS.createMultipartUpload(key);
			const reader = source.pipeThrough(new CompressionStream("gzip")).getReader();
			const parts: R2UploadedPart[] = [];
			const partSize = 5 * 1024 * 1024;
			let buffer = new Uint8Array(partSize);
			let used = 0;
			try {
				for (;;) {
					const {value, done} = await reader.read();
					if (done) break;
					let offset = 0;
					while (offset < value.length) {
						const n = Math.min(partSize - used, value.length - offset);
						buffer.set(value.subarray(offset, offset + n), used); used += n; offset += n;
						if (used === partSize) {
							parts.push(await upload.uploadPart(parts.length + 1, buffer));
							buffer = new Uint8Array(partSize); used = 0;
						}
					}
				}
				if (used) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)));
				await upload.complete(parts);
			} catch (e) { await upload.abort(); throw e; }
			finally { await reader.cancel().catch(() => undefined); }
			this.setMeta("snapshot_seq", String(header.seq));
			this.setMeta("snapshot_at", String(Date.now()));
			this.setMeta("snapshot_next_at", String(Date.now() + SNAPSHOT_INTERVAL_MS));
			const keys: R2Object[] = [];
			let cursor: string | undefined;
			do {
				const page = await this.env.SHARDS.list({prefix: `snapshots/${header.driveId}/`, cursor});
				keys.push(...page.objects);
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
			keys.sort((a,b) => b.uploaded.getTime() - a.uploaded.getTime() || Number(b.key.split("/").pop()!.split(".")[0]) - Number(a.key.split("/").pop()!.split(".")[0]));
			for (const object of keys.slice(7)) await this.env.SHARDS.delete(object.key);
			return key;
		} finally { this.endExport(header.token); }
	}

	// ---------- shards_known ----------

	/** Rebuild legacy/fork authorization from retained versions, never from the shared physical cache. */
    private async ensureReferences(): Promise<boolean> {
        if (this.getMeta("refs_ready") === "1") return true;
        const cursor = Number(this.getMeta("refs_cursor") ?? 0);
        const versions = this.sql.exec<VersionRow & {rid:number}>("SELECT rowid AS rid,* FROM versions WHERE rowid>? ORDER BY rowid LIMIT 8", cursor).toArray();
        for (const version of versions) {
            const attrs = await loadXattrs(this.env.SHARDS, this.lineage(), version.xattrs);
            if (version.manifest) for await (const page of iterateManifest(this.env.SHARDS, this.lineage(), version.manifest)) {
                this.ctx.storage.transactionSync(() => {
                    for (const [h,n] of page.shards) {
                        this.sql.exec("INSERT OR IGNORE INTO drive_shards VALUES(?,?)", h,n);
                        this.sql.exec("INSERT OR IGNORE INTO retained_shards VALUES(?,?)", h,n);
                    }
                });
            }
            this.ctx.storage.transactionSync(() => {
                for (const [h,n] of Object.values(attrs).flat()) {
                    this.sql.exec("INSERT OR IGNORE INTO drive_shards VALUES(?,?)", h,n);
                    this.sql.exec("INSERT OR IGNORE INTO retained_shards VALUES(?,?)", h,n);
                }
                this.setMeta("refs_cursor", String(version.rid));
            });
        }
        const more = this.sql.exec("SELECT 1 FROM versions WHERE rowid>? LIMIT 1", Number(this.getMeta("refs_cursor") ?? 0)).toArray().length;
        if (!more) this.setMeta("refs_ready", "1");
        return !more;
    }

    filterUnknown(hashes: string[]): Promise<Result<string[]>> {
        return this.withIO(async () => {
            if (!this.info()) return this.noDrive();
            if (!await this.ensureReferences()) return fail(503, "references_initializing");
            return ok(hashes.filter(h => !this.sql.exec("SELECT 1 FROM drive_shards d JOIN shards_known s ON s.h=d.h WHERE d.h=?", h).toArray().length));
        });
    }

    async authorizeShard(hash: string): Promise<Result<{lineage:string}>> {
        const result = await this.filterUnknown([hash]);
        if (!result.ok) return result;
        return result.data.length ? fail(404, "no_such_shard") : this.locate();
    }

	/** Records shards the Worker has verified in R2. */
	markShards(shards: [string, number][]): Promise<Result<null>> {
		return this.withIO(async () => {
			if (!this.info()) return this.noDrive();
			const lineage = this.lineage();
			// HEAD in parallel: these R2 round trips sit inside every shard PUT's response.
			const heads = await Promise.all(shards.map(([h]) => this.env.SHARDS.head(`shards/${lineage}/${h}`)));
			const present: [string, number][] = [];
			heads.forEach((object, i) => { if (object) present.push([shards[i]![0], object.size]); });
			return this.recordShards(present);
		});
	}

	private recordShards(shards: [string, number][]): Result<null> {
		if (!this.info()) return this.noDrive();
		this.ctx.storage.transactionSync(() => {
			for (const [h, n] of shards) {
                this.sql.exec("INSERT OR IGNORE INTO shards_known(h,n) VALUES(?,?)", h, n);
                this.sql.exec("INSERT OR IGNORE INTO drive_shards VALUES(?,?)", h, n);
            }
		});
		return ok(null);
	}

	// ---------- commit ----------

    storeManifestPage(value: unknown, org?: string): Promise<Result<{hash:string}>> {
        return this.withIO(async () => {
            if (!this.info()) return this.noDrive();
            let parsed: unknown;
            try { parsed = Array.isArray(value) ? manifestShards(value) : manifestTree(value); }
            catch { return fail(400, "bad_manifest"); }
            const data = new TextEncoder().encode(JSON.stringify(parsed));
            if (data.length > INLINE_MANIFEST_BYTES) return fail(413, "too_large");
            const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(n=>n.toString(16).padStart(2,"0")).join("");
            const key = `manifests/${this.lineage()}/${hash}`;
            const quota = org ? quotaFor(this.env, org) : null;
            if (quota && !await quota.reserve(key,data.length)) return fail(403, "over_quota");
            let stored = false;
            try { await storeMetadata(this.env.SHARDS,this.lineage(),parsed); stored = true; }
            catch (error) { stored = await this.env.SHARDS.head(key).then(Boolean).catch(()=>true); throw error; }
            finally { if (quota) await quota.finish(key,stored); }
            return ok({hash});
        });
    }

	/**
	 * Atomic commit. `confirmed` lists shards the Worker has already HEADed in R2 (hash, size),
	 * so unknown-but-present hashes are accepted and added to shards_known.
	 */
	commit(ops: NormOp[], confirmed: [string, number][], actor: string, requestId?: string, org?: string): Promise<Result<CommitResponse>> {
		return this.withIO(() => this.commitExclusive(ops, confirmed, actor, requestId, org));
	}

	private async commitExclusive(ops: NormOp[], confirmed: [string, number][], actor: string, requestId?: string, org?: string): Promise<Result<CommitResponse>> {
		if (!this.info()) return this.noDrive();
        if (!await this.ensureReferences()) return fail(503, "references_initializing");
		const fingerprint = requestId ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(ops.map(op => (op.op === "put" && op.generatedMtime) ? {...op, mtimeMs: null} : op)))))].map(n => n.toString(16).padStart(2,"0")).join("") : "";
		if (requestId) {
			const previous = this.sql.exec<{fingerprint: string; response: string | null}>("SELECT fingerprint,response FROM commit_receipts WHERE actor=? AND id=?", "drive", requestId).toArray()[0];
			if (previous) return previous.fingerprint === fingerprint && previous.response ? ok(JSON.parse(previous.response) as CommitResponse) : fail(409, "idempotency_conflict");
		}
		const lineage = this.lineage(), stage = crypto.randomUUID();
		try {
		try {
			for (const op of ops) if (op.op === "put" && op.manifest.startsWith("tree:")) {
				const root=manifestTree(await loadMetadata(this.env.SHARDS,lineage,`r2:${op.manifest.slice(5)}`));
				if (root.size!==op.size) return fail(400,"bad_manifest");
				for await (const page of iterateManifest(this.env.SHARDS,lineage,op.manifest)) {
					const unique=new Map<string,number>();
					for (const [h,n] of page.shards) {
						if (unique.has(h) && unique.get(h)!==n) return fail(400,"bad_manifest");
						unique.set(h,n);
					}
					for (const [h,n] of unique) {
						const row=this.sql.exec<{n:number}>("SELECT d.n FROM drive_shards d JOIN shards_known s ON s.h=d.h WHERE d.h=?",h).toArray()[0];
						if (!row) return fail(409,"missing_shards",{hashes:[h]});
						if (row.n!==n) return fail(400,"bad_manifest");
						const prior=this.sql.exec<{n:number}>("SELECT n FROM manifest_stage WHERE token=? AND h=?",stage,h).toArray()[0];
						if (prior && prior.n!==n) return fail(400,"bad_manifest");
					}
					this.ctx.storage.transactionSync(()=>{for (const [h,n] of unique) this.sql.exec("INSERT OR IGNORE INTO manifest_stage VALUES(?,?,?)",stage,h,n);});
				}
			}
		} catch { return fail(400,"bad_manifest"); }

		// Worker HEADs can race a sweep before this queued call starts; recheck under the IO lock.
		const present: [string, number][] = [];
		for (let i = 0; i < confirmed.length; i += 50) {
			const batch = confirmed.slice(i, i + 50);
			const heads = await Promise.all(batch.map(([h]) => this.env.SHARDS.head(`shards/${lineage}/${h}`)));
			heads.forEach((object, j) => { if (object) present.push([batch[j]![0], object.size]); });
		}
		confirmed = present;
		for (const op of ops) if (op.op === "put") {
            for (const field of ["manifest", "xattrs"] as const) {
                const text = op[field];
                if (text === undefined) continue;
                if (field === "manifest" && text.startsWith("tree:")) continue;
                const data = new TextEncoder().encode(text);
                if (!org || data.byteLength <= INLINE_MANIFEST_BYTES) {
                    op[field] = await storeManifest(this.env.SHARDS, lineage, text); continue;
                }
                const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(n => n.toString(16).padStart(2,"0")).join("");
                const key = `manifests/${lineage}/${hash}`, quota = quotaFor(this.env, org);
                if (!await quota.reserve(key, data.byteLength)) return fail(403, "over_quota");
                let stored = false;
                try { op[field] = await storeManifest(this.env.SHARDS, lineage, text); stored = true; }
                catch (error) { stored = await this.env.SHARDS.head(key).then(Boolean).catch(() => true); throw error; }
                finally { await quota.finish(key, stored); }
            }
        }
		// Shard registration, consistency checks and the ops share ONE transaction: a failed commit leaves nothing behind.
		return this.runCommit(actor, (c) => {
			for (const [h, n] of confirmed) {
                this.sql.exec("INSERT OR IGNORE INTO drive_shards VALUES(?,?)", h, n);
                this.sql.exec("INSERT OR IGNORE INTO shards_known(h,n) VALUES(?,?)", h,n);
            }
			const missing = new Set<string>();
			for (const op of ops) {
				if (op.op !== "put") continue;
				for (const [h, n] of [...op.shards, ...(op.attributeShards ?? [])]) {
					const row = this.sql.exec<{ n: number }>("SELECT d.n FROM drive_shards d JOIN shards_known s ON s.h=d.h WHERE d.h=?", h).toArray()[0];
					if (!row) missing.add(h);
					else if (row.n !== n) throw new Abort(fail(400, "bad_manifest", { message: `shard ${h} is ${row.n} bytes, manifest says ${n}` }));
				}
			}
			if (missing.size) throw new Abort(fail(409, "missing_shards", { hashes: [...missing] }));
			const results = ops.map((op) => {
                const result = this.applyOp(op,c);
                if (op.op === "put") for (const [h,n] of [...op.shards, ...(op.attributeShards ?? [])]) this.sql.exec("INSERT OR IGNORE INTO retained_shards VALUES(?,?)",h,n);
                return result;
            });
            this.sql.exec("INSERT OR IGNORE INTO retained_shards SELECT h,n FROM manifest_stage WHERE token=?",stage);
            return results;
		}, requestId ? {id: requestId, fingerprint} : undefined);
		} finally { this.sql.exec("DELETE FROM manifest_stage WHERE token=?",stage); }
	}

	cancelCommit(requestId: string, actor: string): Promise<Result<{committed: CommitResponse | null}>> {
		return this.withIO(async () => {
			if (!this.info()) return this.noDrive();
			const previous = this.sql.exec<{response: string | null}>("SELECT response FROM commit_receipts WHERE actor=? AND id=?", "drive", requestId).toArray()[0];
			if (!previous) this.sql.exec("INSERT INTO commit_receipts VALUES(?,?,?,NULL)", "drive", requestId, "cancelled");
			return ok({committed: previous?.response ? JSON.parse(previous.response) as CommitResponse : null});
		});
	}

	restore(key: string, versionId: string, ifVersion: string | null, actor: string, ifAbsent = false): Promise<Result<CommitResponse>> {
		return this.withIO(() => this.restoreExclusive(key, versionId, ifVersion, actor, ifAbsent));
	}

	private async restoreExclusive(key: string, versionId: string, ifVersion: string | null, actor: string, ifAbsent: boolean): Promise<Result<CommitResponse>> {
		if (!this.info()) return this.noDrive();
		const v = this.getVersion(versionId);
		if (!v || v.node_id !== this.historyNode(key)) return fail(404, "no_such_version", { path: key, versionId });
		if (v.manifest === null) return fail(400, "not_restorable", { message: `version ${versionId} is a ${v.op}, not file content` });
		const shards = v.manifest.startsWith("tree:") ? [] : await loadManifest(this.env.SHARDS, this.lineage(), v.manifest);
		const op: NormOp = {
			op: "restore",
			key,
			ifVersion,
			ifAbsent,
			size: v.size ?? 0,
			ctype: v.ctype ?? "application/octet-stream",
			mtimeMs: v.mtime ?? Date.now(),
			manifest: v.manifest,
            xattrs: v.xattrs ?? "{}",
			shards,
			restoredFrom: versionId,
			nodeId: v.node_id,
		};
		return this.runCommit(actor, (c) => [this.applyOp(op, c)]);
	}

	private runCommit(actor: string, fn: (c: CommitCtx) => CommitResult[], receipt?: {id: string; fingerprint: string}): Result<CommitResponse> {
		let events: ChangeEntry[] = [];
		let response: CommitResponse;
		try {
			response = this.ctx.storage.transactionSync(() => {
				const c: CommitCtx = { actor, seq: this.headSeq() + 1, ts: Date.now(), events: [] };
				const results = fn(c);
				this.setMeta("head_seq", String(c.seq));
				events = c.events;
				const response = { seq: c.seq, results };
				if (receipt) this.sql.exec("INSERT INTO commit_receipts VALUES(?,?,?,?)", "drive", receipt.id, receipt.fingerprint, JSON.stringify(response));
				return response;
			});
		} catch (e) {
			if (e instanceof Abort) return e.failure;
			throw e;
		}
		this.broadcast(events);
		return ok(response);
	}

	private logRow(c: CommitCtx, path: string, op: string, versionId: string | null): void {
		this.sql.exec("INSERT INTO log(seq,path,op,version) VALUES(?,?,?,?)", c.seq, path, op, versionId);
		c.events.push({ ev: this.lastEv(), seq: c.seq, path, op, versionId });
	}

	private newVersion(c: CommitCtx, key: string, op: string, size: number | null, manifest: string | null, ctype: string | null, mtime: number | null, nodeId = this.getNode(key)?.id ?? crypto.randomUUID(), restoredFrom: string | null = null, xattrs: string | null = null): string {
		const id = "v_" + this.ulid();
		this.sql.exec(
			"INSERT INTO versions(id,path,op,size,manifest,seq,ts,actor,ctype,mtime,node_id,restored_from,xattrs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
			id, key, op, size, manifest, c.seq, c.ts, c.actor, ctype, mtime, nodeId, restoredFrom, xattrs,
		);
		return id;
	}

	private putNode(c: CommitCtx, key: string, type: "file" | "folder", head: string, size: number, ctype: string | null, mtime: number): void {
		const nodeId = this.getVersion(head)!.node_id;
		this.tree.put(key, { type, head, size, ctype, mtime, seq: c.seq }, nodeId);
		this.sql.exec("INSERT INTO path_log(seq,ts,node_id,path,op) VALUES(?,?,?,?,?)", c.seq, c.ts, nodeId, key, type);
	}

	private precondition(op: { ifVersion: string | null; ifAbsent?: boolean }, node: NodeRow | undefined, ext: string): void {
		const cur = node?.head ?? null;
		if ((op.ifAbsent && node) || (op.ifVersion !== null && cur !== op.ifVersion)) {
			throw new Abort(fail(412, "precondition_failed", { path: ext, currentVersionId: cur }));
		}
	}

	private createFolder(c: CommitCtx, key: string): string {
		const vid = this.newVersion(c, key, "mkdir", 0, null, null, c.ts);
		this.putNode(c, key, "folder", vid, 0, null, c.ts);
		this.logRow(c, key + "/", "mkdir", vid);
		return vid;
	}

	private ensureParents(c: CommitCtx, key: string): void {
		const parts = key.split("/");
		parts.pop();
		let cur = "";
		for (const seg of parts) {
			cur = cur ? cur + "/" + seg : seg;
			const n = this.getNode(cur);
			if (!n) this.createFolder(c, cur);
			else if (n.type !== "folder") throw new Abort(fail(409, "path_conflict", { path: cur }));
		}
	}

	private applyOp(op: NormOp, c: CommitCtx): CommitResult {
		switch (op.op) {
			case "put":
			case "restore": {
				const node = this.getNode(op.key);
				this.precondition(op, node, op.key);
				if (node?.type === "folder") throw new Abort(fail(409, "path_conflict", { path: op.key }));
				this.ensureParents(c, op.key);
				const vid = this.newVersion(c, op.key, op.op, op.size, op.manifest, op.ctype, op.mtimeMs, node?.id ?? (op.op === "restore" ? op.nodeId : undefined), op.op === "restore" ? op.restoredFrom ?? null : null, op.xattrs ?? (node?.head ? this.getVersion(node.head)?.xattrs ?? null : null));
				this.putNode(c, op.key, "file", vid, op.size, op.ctype, op.mtimeMs);
				this.logRow(c, op.key, op.op, vid);
				return { path: op.key, versionId: vid, size: op.size };
			}
			case "mkdir": {
				const ext = op.key + "/";
				const node = this.getNode(op.key);
				this.precondition(op, node, ext);
				if (node) {
					if (node.type !== "folder") throw new Abort(fail(409, "path_conflict", { path: op.key }));
					return { path: ext, versionId: node.head ?? "", size: 0 }; // idempotent: already a folder
				}
				this.ensureParents(c, op.key);
				return { path: ext, versionId: this.createFolder(c, op.key), size: 0 };
			}
			case "delete": {
				const ext = extPath(op.key, op.isFolder);
				const node = this.getNode(op.key);
				this.precondition(op, node, ext);
				if (!node || (node.type === "folder") !== op.isFolder) throw new Abort(fail(404, "no_such_path", { path: ext }));
				const size = node.size ?? 0;
				if (op.isFolder) this.checkSubtree(node, op.key, null);
				const vid = this.newVersion(c, op.key, "delete", null, null, null, null);
				this.recordSubtree(c, node, op.key, op.key, "delete");
				this.tree.detach(node.id);
				this.logRow(c, ext, "delete", vid);
				return { path: ext, versionId: vid, size: op.isFolder ? 0 : size };
			}
			case "rename": {
				const extFrom = extPath(op.from, op.isFolder);
				const extTo = extPath(op.to, op.isFolder);
				const src = this.getNode(op.from);
				this.precondition(op, src, extFrom);
				if (!src || (src.type === "folder") !== op.isFolder) throw new Abort(fail(404, "no_such_path", { path: extFrom }));
				if (this.getNode(op.to)) throw new Abort(fail(409, "path_conflict", { path: extTo }));
				this.ensureParents(c, op.to);

				if (op.isFolder) this.checkSubtree(src, op.from, op.to);
				const old = src.head ? this.getVersion(src.head) : undefined;
				const vid = this.newVersion(c, op.to, "rename", src.size ?? 0, old?.manifest ?? null, src.ctype, src.mtime, src.id, null, old?.xattrs ?? null);
				this.recordSubtree(c, src, op.from, op.to, "rename");
				this.tree.move(src.id, op.to, vid, c.seq);
				// A rename is logged as a delete of the old path plus a rename of the new path.
				this.logRow(c, extFrom, "delete", null);
				this.logRow(c, extTo, "rename", vid);
				return { path: extTo, versionId: vid, size: op.isFolder ? 0 : (src.size ?? 0) };
			}
		}
	}

	private checkSubtree(root: NodeRow, from: string, to: string | null): void {
		let count = 0;
		for (const n of this.tree.descendants(root.id)) {
			if (++count > MAX_SUBTREE_NODES) throw new Abort(fail(400, "subtree_too_large", { limit: MAX_SUBTREE_NODES }));
			if (to !== null) {
				const path = extPath(to + "/" + n.path, n.type === "folder");
				if (utf8Len(path) > MAX_PATH_BYTES) throw new Abort(fail(400, "path_too_long", { path }));
			}
		}
	}

	// ---------- reads ----------

	private nodeJson(n: NodeRow) {
		return {
			path: extPath(n.path, n.type === "folder"),
			type: n.type,
			versionId: n.head,
			size: n.size ?? 0,
			contentType: n.ctype,
			mtimeMs: n.mtime,
			seq: n.seq,
		};
	}

	stat(key: string): Result<ReturnType<DriveStore["nodeJson"]>> {
		if (!this.info()) return this.noDrive();
		if (key === "") return ok({ path: "", type: "folder", versionId: null, size: 0, contentType: null, mtimeMs: null, seq: this.headSeq() });
		const n = this.getNode(key);
		if (!n) return fail(404, "no_such_path");
		return ok(this.nodeJson(n));
	}

	search(query: string, after: string | null, limit: number) {
		if (!this.info()) return this.noDrive();
		const phrase = '"' + query.replace(/"/g, '""') + '"';
		// Bound the FTS candidates before walking ancestors; common names can match entire drives.
		const matches = this.sql.exec<{rowid: number}>(`SELECT rowid FROM node_search
			WHERE node_search MATCH ? AND rowid>? ORDER BY rowid LIMIT ?`, phrase, Number(after ?? 0), limit + 1).toArray();
		const page = matches.slice(0, limit);
		if (!page.length) return ok({entries: [], cursor: null});
		const rows = this.sql.exec<NodeRow>(`WITH RECURSIVE ancestors AS (
			SELECT n.id AS origin,n.parent_id,n.name AS path,0 AS depth
			FROM nodes n WHERE n.rowid IN (${page.map(() => "?").join(",")})
			UNION ALL
			SELECT a.origin,n.parent_id,n.name||'/'||a.path,a.depth+1
			FROM ancestors a JOIN nodes n ON a.parent_id=n.id WHERE a.depth<1024
		) SELECT n.*,a.path FROM ancestors a JOIN nodes n ON n.id=a.origin
			WHERE a.parent_id='' ORDER BY a.path`, ...page.map(r => r.rowid)).toArray();
		// Detached candidates can yield an empty page; advance past them instead of rescanning.
		return ok({entries: rows.map(n => this.nodeJson(n)), cursor: matches.length > limit ? String(page.at(-1)!.rowid) : null});
	}

	list(key: string, cursor: string | null, limit: number) {
		if (!this.info()) return this.noDrive();
		if (key !== "") {
			const n = this.getNode(key);
			if (!n || n.type !== "folder") return fail(404, "no_such_path");
		}
		const rows = this.tree.children(key, cursor, limit + 1);
		const page = rows.slice(0, limit);
		const more = rows.length > limit;
		return ok({
			entries: page.map((n) => ({
				name: n.path.slice(key === "" ? 0 : key.length + 1),
				type: n.type,
				versionId: n.head,
				size: n.size ?? 0,
				mtimeMs: n.mtime,
			})),
			next: more ? (page[page.length - 1]?.path ?? null) : null,
		});
	}

	async manifest(key: string, versionId: string | null, shardCursor: number | null = null) {
		if (!this.info()) return this.noDrive();
		let v: VersionRow | undefined;
		if (versionId) {
			v = this.getVersion(versionId);
			if (!v || v.node_id !== this.historyNode(key)) return fail(404, "no_such_version", { path: key, versionId });
		} else {
			const n = this.getNode(key);
			if (!n) return fail(404, "no_such_path");
			if (n.type !== "file") return fail(400, "not_a_file", { path: key + "/" });
			v = n.head ? this.getVersion(n.head) : undefined;
			if (!v) return fail(404, "no_such_path");
		}
		if (v.manifest === null) return fail(404, "no_such_version", { message: `version ${v.id} has no content (${v.op})` });
		const page = shardCursor === null ? null : await readManifestPage(this.env.SHARDS, this.lineage(), v.manifest, shardCursor);
        const shards = (page ? page.shards : await loadManifest(this.env.SHARDS, this.lineage(), v.manifest)).map(([h, n]) => ({ h, n }));
		const attrs = await loadXattrs(this.env.SHARDS, this.lineage(), v.xattrs);
        const xattrs = Object.fromEntries(Object.entries(attrs).map(([name, refs]) => [name, refs.map(([h,n]) => ({h,n}))]));
        return ok({ xattrs, path: key, versionId: v.id, size: v.size ?? 0, contentType: v.ctype, mtimeMs: v.mtime, shards,
            ...(v.manifest.startsWith("tree:") ? {manifestRef: v.manifest} : {}), ...(page ? {nextShardCursor: page.next} : {}) });
	}

	private historyNode(key: string): string | null {
		return this.getNode(key)?.id ?? this.sql.exec<{node_id:string}>("SELECT p.node_id FROM path_log p WHERE p.path=? AND p.path=(SELECT q.path FROM path_log q WHERE q.node_id=p.node_id ORDER BY q.seq DESC,q.rowid DESC LIMIT 1) ORDER BY p.seq DESC,p.rowid DESC LIMIT 1",key).toArray()[0]?.node_id ?? null;
	}

	private recordSubtree(c: CommitCtx, root: NodeRow, from: string, to: string, op: string): void {
		this.sql.exec(`WITH RECURSIVE sub(id,path) AS (
 SELECT ?,? UNION ALL SELECT n.id,sub.path||'/'||n.name FROM nodes n JOIN sub ON n.parent_id=sub.id
 ) INSERT INTO path_log(seq,ts,node_id,path,op) SELECT ?,?,id,?||substr(path,length(?)+1),? FROM sub`,root.id,from,c.seq,c.ts,to,from,op);
	}

	versions(key: string, cursor: string | null, limit: number, includeRenames = false) {
		if (!this.info()) return this.noDrive();
		const after = cursor === null ? 0 : Number(cursor);
		if (!Number.isSafeInteger(after) || after < 0) return fail(400, "bad_request", { message: "invalid cursor" });
		const rows = this.sql.exec<VersionRow & {rid:number}>(`SELECT rowid AS rid,* FROM versions WHERE node_id=? AND rowid>? ${includeRenames ? "" : "AND op!='rename'"} ORDER BY rowid LIMIT ?`,this.historyNode(key),after,limit+1).toArray();
		const page=rows.slice(0,limit);
		return ok({versions:page.map(r=>({versionId:r.id,op:r.op,operation:r.op === "put" ? "write" : r.op,restoredFrom:r.restored_from,size:r.size,seq:r.seq,ts:r.ts,actor:r.actor})),cursor:rows.length>limit?String(page.at(-1)!.rid):null});
	}

	treeAt(key: string, ts: number, cursor: string | null, limit: number) {
		if (!this.info()) return this.noDrive();
		const rows=this.sql.exec<{path:string;nodeId:string;versionId:string;size:number;type:string}>(`WITH latest AS (
 SELECT *,ROW_NUMBER() OVER(PARTITION BY node_id ORDER BY seq DESC,rowid DESC) AS rank FROM path_log WHERE ts<=?
 ), heads AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY node_id ORDER BY seq DESC,rowid DESC) AS rank FROM versions WHERE ts<=?)
 SELECT p.path||CASE WHEN v.manifest IS NULL THEN '/' ELSE '' END AS path,p.node_id AS nodeId,v.id AS versionId,COALESCE(v.size,0) AS size,CASE WHEN v.manifest IS NULL THEN 'folder' ELSE 'file' END AS type
 FROM latest p JOIN heads v ON p.node_id=v.node_id AND v.rank=1 WHERE p.rank=1 AND p.op!='delete' AND ( ?='' OR substr(p.path,1,length(?)+1)=?||'/') AND p.path>? ORDER BY p.path LIMIT ?`,ts,ts,key,key,key,cursor ?? "",limit+1).toArray();
		const page=rows.slice(0,limit);
		return ok({entries:page,cursor:rows.length>limit?page.at(-1)!.path.replace(/\/$/,""):null});
	}

	/** Event id of the last event of commit `seq` (0 if none): `since=<seq>` means `after=<that>`. */
	private evAfterSeq(seq: number): number {
		return this.sql.exec<{ m: number }>("SELECT COALESCE(MAX(rowid),0) AS m FROM log WHERE seq<=?", seq).one().m;
	}
	private lastEv(): number {
		return this.sql.exec<{ m: number }>("SELECT COALESCE(MAX(rowid),0) AS m FROM log").one().m;
	}

	changes(cursor: { after: number } | { since: number }, limit: number) {
		if (!this.info()) return this.noDrive();
		const after = "after" in cursor ? cursor.after : this.evAfterSeq(cursor.since);
		const rows = this.readLog(after, limit + 1);
		return ok({ changes: rows.slice(0, limit), headSeq: this.headSeq(), lastEv: this.lastEv(), more: rows.length > limit });
	}

	private readLog(after: number, limit: number): ChangeEntry[] {
		return this.sql
			.exec<EventRow>("SELECT rowid AS ev,seq,path,op,version FROM log WHERE rowid>? ORDER BY rowid LIMIT ?", after, limit)
			.toArray()
			.map((r) => ({ ev: r.ev, seq: r.seq, path: r.path, op: r.op, versionId: r.version }));
	}

	// ---------- watch (hibernatable WebSockets) ----------

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return Response.json({ error: "upgrade_required" }, { status: 426 });
		}
		if (!this.info()) return Response.json({ error: "no_such_drive" }, { status: 404 });
		const q = new URL(request.url).searchParams;
		const rawAfter = q.get("after");
		const rawSince = q.get("since");
		let after: number;
		if (rawAfter !== null) after = Number(rawAfter);
		else if (rawSince !== null) after = Number.isSafeInteger(Number(rawSince)) && Number(rawSince) >= 0 ? this.evAfterSeq(Number(rawSince)) : NaN;
		else after = this.lastEv();
		if (!Number.isSafeInteger(after) || after < 0) return Response.json({ error: "bad_request", message: "since/after must be a non-negative integer" }, { status: 400 });
		const rawExp = request.headers.get(EXP_HEADER);
		const exp = rawExp === null ? null : Number(rawExp);
		// A token inside its +30 s verification leeway is accepted here; the first alarm tick closes it with 4401.
		if (exp !== null && !Number.isFinite(exp)) return Response.json({ error: "unauthorized" }, { status: 401 });

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.ctx.acceptWebSocket(server);
		const last = this.lastEv();
		if (last - after > MAX_BACKLOG_EVENTS || (this.getMeta("forkOf") !== null && after === 0)) {
			server.send(JSON.stringify({ type: "resync", headSeq: this.headSeq(), lastEv: last }));
			server.close(1000, "resync");
			return new Response(null, { status: 101, webSocket: client });
		}
		// Replay runs from the alarm in bounded batches; live events skip this socket until it has caught up.
		server.serializeAttachment({ drive: this.getMeta("drive_id")!, exp, replayAfter: after < last ? after : null } satisfies WsAttachment);
		await this.scheduleAlarm(after < last ? Date.now() + REPLAY_TICK_MS : Date.now() + PING_INTERVAL_MS, exp);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Sets the alarm to min(requested, token expiry), never later than an alarm that is already pending. */
	private async scheduleAlarm(at: number, exp: number | null): Promise<void> {
		const wake = Math.max(Math.min(at, exp === null ? Infinity : exp * 1000), Date.now() + 1);
		const current = await this.ctx.storage.getAlarm();
		if (current === null || wake < current) await this.ctx.storage.setAlarm(wake);
	}

	private broadcast(events: ChangeEntry[]): void {
		if (!events.length) return;
		for (const ws of this.sockets()) {
			// Sockets still replaying will pick these up from the log; sending now could overtake the replay.
			if ((ws.deserializeAttachment() as WsAttachment | null)?.replayAfter != null) continue;
			for (const e of events) {
				try {
					ws.send(JSON.stringify({ type: "change", ...e }));
				} catch {
					// socket already closing; the close handler will clean up
				}
			}
		}
	}

	webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): void {
		// Clients only send {"type":"pong"} (or nothing). Nothing to do; receipt keeps the connection warm.
		if (typeof message !== "string") return;
	}

	webSocketClose(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {
			// already closed
		}
	}

	webSocketError(ws: WebSocket): void {
		try {
			ws.close(1011, "error");
		} catch {
			// already closed
		}
	}

	/** Internal RPC for operators/tests; also called by the shared alarm, never exposed over HTTP. */
	gcStep() {
		return this.withIO(async () => {
			const lineage = this.lineage();
			if (!lineage) return null;
			// A local mark cannot prove a shared lineage is unreferenced. Keep all bytes until a union sweep exists.
			if (lineage !== this.getMeta("drive_id") || this.sql.exec("SELECT 1 FROM lineage_members WHERE drive_id<>? AND removed_at IS NULL LIMIT 1", lineage).toArray().length) {
				this.setMeta("gc_next_at", String(Date.now() + GC_INTERVAL_MS));
				return { done: true, dryRun: true, scanned: 0, candidates: 0, deleted: 0 };
			}
			const result = await new LineageGC(this.sql, this.env.SHARDS, lineage,
                this.getMeta("quota_org") ? key => quotaFor(this.env, this.getMeta("quota_org")!).deleteUnreferenced(key) : undefined,
                this.getMeta("quota_org") ? key => quotaFor(this.env, this.getMeta("quota_org")!).recoverDeletion(key) : undefined).step(this.headSeq(), Date.now(), this.env.ULS_GC_DELETE !== "1");
			const next = Date.now() + (result.done ? GC_INTERVAL_MS : 1000);
			this.setMeta("gc_next_at", String(next));
			await this.scheduleAlarm(next, null);
			return result;
		});
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		await this.snapshot();
		if (this.snapshotDueAt() <= now) this.setMeta("snapshot_next_at", String(now + SNAPSHOT_INTERVAL_MS));
		if (Number(this.getMeta("gc_next_at") ?? "Infinity") <= now) await this.gcStep();
		const gcNext = Math.min(Number(this.getMeta("gc_next_at") ?? "Infinity"), this.snapshotDueAt());
		let nextAt = gcNext;
		let open = 0;
		let replaying = false;
		const pingKey = `lastPing:${this.getMeta("drive_id")}`;
		const lastPing = (await this.ctx.storage.get<number>(pingKey)) ?? 0;
		const ping = lastPing + PING_INTERVAL_MS <= now + REPLAY_TICK_MS;
		for (const ws of this.sockets()) {
			const att = (ws.deserializeAttachment() as WsAttachment | null) ?? { exp: null, replayAfter: null };
			if (att.exp !== null && att.exp * 1000 <= now) {
				try {
					ws.close(WS_CLOSE_EXPIRED, "token_expired");
				} catch {
					// already closed
				}
				continue;
			}
			open++;
			if (att.exp !== null) nextAt = Math.min(nextAt, att.exp * 1000);
			try {
				if (att.replayAfter !== null) {
					const batch = this.readLog(att.replayAfter, REPLAY_BATCH);
					for (const e of batch) ws.send(JSON.stringify({ type: "change", ...e }));
					const cursor = batch.length ? batch[batch.length - 1]!.ev : att.replayAfter;
					// Caught up when nothing newer exists; from then on live broadcasts take over (same synchronous turn).
					const done = batch.length < REPLAY_BATCH;
					ws.serializeAttachment({ drive: this.getMeta("drive_id")!, exp: att.exp, replayAfter: done ? null : cursor } satisfies WsAttachment);
					if (!done) replaying = true;
				} else if (ping) {
					ws.send(JSON.stringify({ type: "ping" }));
				}
			} catch {
				// closing
			}
		}
		if (open === 0) {
			if (Number.isFinite(gcNext)) await this.scheduleAlarm(gcNext, null);
			return;
		}
		if (ping) await this.ctx.storage.put(pingKey, now);
		const nextPing = (ping ? now : lastPing) + PING_INTERVAL_MS;
		nextAt = Math.min(nextAt, replaying ? now + REPLAY_TICK_MS : nextPing);
		await this.scheduleAlarm(nextAt,null);
	}
}

/** One SQLite authority owns a lineage's immutable metadata; child objects hold only a routing pointer. */
export class DriveAuthority extends DurableObject<Env> {
	private queue = {tail: Promise.resolve() as Promise<unknown>};
	private primary: DriveStore | null;
	private sessions = new Map<string,DriveStore>();
	private route: {root: string; branch: string} | null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx,env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS manifest_stage(token TEXT NOT NULL,h TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(token,h))");
		ctx.storage.sql.exec("DELETE FROM manifest_stage");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS authority_route(id INTEGER PRIMARY KEY,root TEXT NOT NULL,branch TEXT NOT NULL)");
		this.route=ctx.storage.sql.exec<{root:string;branch:string}>("SELECT root,branch FROM authority_route WHERE id=1").toArray()[0] ?? null;
		this.primary=this.route ? null : new DriveStore(ctx,env,undefined,this.queue);
	}

	// The queue remains observable to the existing deadline regression fixture.
	get pendingIO(): Promise<unknown> { return this.queue.tail; }
	set pendingIO(value: Promise<unknown>) { this.queue.tail=value; }

	private local(branch?: string): DriveStore {
		if (!this.primary) throw new Error("proxy_has_no_local_store");
		if (!branch || this.primary.lineageInfo()?.driveId===branch) return this.primary;
		let store=this.sessions.get(branch);
		if (!store) {
			store=new DriveStore(this.ctx,this.env,branchSql(this.ctx.storage.sql,branch),this.queue);
			this.sessions.set(branch,store);
		}
		return store;
	}
	private rootStub(id: string) {
		const ns=this.env.DRIVE_AUTHORITY as unknown as DurableObjectNamespace<DriveAuthority>;
		return ns.get(ns.idFromName(id));
	}
	private invoke<K extends keyof DriveStore>(method:K,args:Parameters<Extract<DriveStore[K],(...args:any[])=>any>>): ReturnType<Extract<DriveStore[K],(...args:any[])=>any>> | Promise<Awaited<ReturnType<Extract<DriveStore[K],(...args:any[])=>any>>>> {
		if (this.route) return this.rootStub(this.route.root).branchCall(this.route.branch,method,args).then(result => JSON.parse(result)) as never;
		const fn=this.local()[method] as (...args:any[])=>any;
		return fn.apply(this.local(),args);
	}
	async branchCall(branch: string, method: string, args: unknown[]): Promise<string> {
		if (this.route) throw new Error("invalid_branch_authority");
		const allowed=new Set(["bindQuotaOrg","lineageInfo","delete","restoreDrive","locate","forkInfo","describe","stats","member","beginExport","exportPage","endExport","reserveImport","importPage","finishImport","cancelImport","snapshot","filterUnknown","authorizeShard","markShards","storeManifestPage","commit","cancelCommit","restore","stat","search","list","manifest","versions","treeAt","changes","forkMetadata","gcStep"]);
		if (!allowed.has(method) || !Array.isArray(args)) throw new Error("invalid_branch_method");
		const store=this.local(branch);
		return JSON.stringify(await (store[method as keyof DriveStore] as (...args:unknown[])=>unknown).apply(store,args)) ?? "null";
	}
	async installFork(token: string, root: string, branch: string): Promise<void> {
		if (this.route) {
			if (this.route.root===root && this.route.branch===branch) return;
			throw new Error("drive_exists");
		}
		if (!this.primary || this.ctx.storage.sql.exec<{v:string}>("SELECT v FROM meta WHERE k='importing'").toArray()[0]?.v!==token) throw new Error("invalid import token");
		this.ctx.storage.transactionSync(()=>{
			this.ctx.storage.sql.exec("INSERT INTO authority_route VALUES(1,?,?)",root,branch);
			this.ctx.storage.sql.exec("DELETE FROM meta WHERE k='importing'");
		});
		this.route={root,branch};this.primary=null;
	}
	async metadataAuthority(): Promise<string> {
		if (this.route) return this.route.root;
		const id=this.primary?.lineageInfo()?.driveId;
		if (!id) throw new Error("no_such_drive");
		return id;
	}
	async forkInfo(): Promise<ReturnType<DriveStore["forkInfo"]>> { return await this.invoke("forkInfo",[]) as ReturnType<DriveStore["forkInfo"]>; }

	async create(...args: Parameters<DriveStore["create"]>): Promise<Awaited<ReturnType<DriveStore["create"]>>> { return await this.invoke("create",args) as Awaited<ReturnType<DriveStore["create"]>>; }

	async delete(...args: Parameters<DriveStore["delete"]>): Promise<Awaited<ReturnType<DriveStore["delete"]>>> { return await this.invoke("delete",args) as Awaited<ReturnType<DriveStore["delete"]>>; }

	async bindQuotaOrg(...args: Parameters<DriveStore["bindQuotaOrg"]>): Promise<Awaited<ReturnType<DriveStore["bindQuotaOrg"]>>> { return await this.invoke("bindQuotaOrg",args) as Awaited<ReturnType<DriveStore["bindQuotaOrg"]>>; }

	async lineageInfo(...args: Parameters<DriveStore["lineageInfo"]>): Promise<Awaited<ReturnType<DriveStore["lineageInfo"]>>> { return await this.invoke("lineageInfo",args) as Awaited<ReturnType<DriveStore["lineageInfo"]>>; }

	async restoreDrive(...args: Parameters<DriveStore["restoreDrive"]>): Promise<Awaited<ReturnType<DriveStore["restoreDrive"]>>> { return await this.invoke("restoreDrive",args) as Awaited<ReturnType<DriveStore["restoreDrive"]>>; }

	async locate(...args: Parameters<DriveStore["locate"]>): Promise<Awaited<ReturnType<DriveStore["locate"]>>> { return await this.invoke("locate",args) as Awaited<ReturnType<DriveStore["locate"]>>; }

	async describe(...args: Parameters<DriveStore["describe"]>): Promise<Awaited<ReturnType<DriveStore["describe"]>>> { return await this.invoke("describe",args) as Awaited<ReturnType<DriveStore["describe"]>>; }

	async stats(...args: Parameters<DriveStore["stats"]>): Promise<Awaited<ReturnType<DriveStore["stats"]>>> { return await this.invoke("stats",args) as Awaited<ReturnType<DriveStore["stats"]>>; }

	async member(...args: Parameters<DriveStore["member"]>): Promise<Awaited<ReturnType<DriveStore["member"]>>> { return await this.invoke("member",args) as Awaited<ReturnType<DriveStore["member"]>>; }

	async beginExport(...args: Parameters<DriveStore["beginExport"]>): Promise<Awaited<ReturnType<DriveStore["beginExport"]>>> { return await this.invoke("beginExport",args) as Awaited<ReturnType<DriveStore["beginExport"]>>; }

	async exportPage(...args: Parameters<DriveStore["exportPage"]>): Promise<Awaited<ReturnType<DriveStore["exportPage"]>>> { return await this.invoke("exportPage",args) as Awaited<ReturnType<DriveStore["exportPage"]>>; }

	async endExport(...args: Parameters<DriveStore["endExport"]>): Promise<Awaited<ReturnType<DriveStore["endExport"]>>> { return await this.invoke("endExport",args) as Awaited<ReturnType<DriveStore["endExport"]>>; }

	async reserveImport(...args: Parameters<DriveStore["reserveImport"]>): Promise<Awaited<ReturnType<DriveStore["reserveImport"]>>> { return await this.invoke("reserveImport",args) as Awaited<ReturnType<DriveStore["reserveImport"]>>; }

	async importPage(...args: Parameters<DriveStore["importPage"]>): Promise<Awaited<ReturnType<DriveStore["importPage"]>>> { return await this.invoke("importPage",args) as Awaited<ReturnType<DriveStore["importPage"]>>; }

	async finishImport(...args: Parameters<DriveStore["finishImport"]>): Promise<Awaited<ReturnType<DriveStore["finishImport"]>>> { return await this.invoke("finishImport",args) as Awaited<ReturnType<DriveStore["finishImport"]>>; }

	async cancelImport(...args: Parameters<DriveStore["cancelImport"]>): Promise<Awaited<ReturnType<DriveStore["cancelImport"]>>> { return await this.invoke("cancelImport",args) as Awaited<ReturnType<DriveStore["cancelImport"]>>; }

	async snapshot(...args: Parameters<DriveStore["snapshot"]>): Promise<Awaited<ReturnType<DriveStore["snapshot"]>>> { return await this.invoke("snapshot",args) as Awaited<ReturnType<DriveStore["snapshot"]>>; }

	async filterUnknown(...args: Parameters<DriveStore["filterUnknown"]>): Promise<Awaited<ReturnType<DriveStore["filterUnknown"]>>> { return await this.invoke("filterUnknown",args) as Awaited<ReturnType<DriveStore["filterUnknown"]>>; }

	async authorizeShard(...args: Parameters<DriveStore["authorizeShard"]>): Promise<Awaited<ReturnType<DriveStore["authorizeShard"]>>> { return await this.invoke("authorizeShard",args) as Awaited<ReturnType<DriveStore["authorizeShard"]>>; }

	async markShards(...args: Parameters<DriveStore["markShards"]>): Promise<Awaited<ReturnType<DriveStore["markShards"]>>> { return await this.invoke("markShards",args) as Awaited<ReturnType<DriveStore["markShards"]>>; }

	async storeManifestPage(...args: Parameters<DriveStore["storeManifestPage"]>): Promise<Awaited<ReturnType<DriveStore["storeManifestPage"]>>> { return await this.invoke("storeManifestPage",args) as Awaited<ReturnType<DriveStore["storeManifestPage"]>>; }

	async commit(...args: Parameters<DriveStore["commit"]>): Promise<Awaited<ReturnType<DriveStore["commit"]>>> { return await this.invoke("commit",args) as Awaited<ReturnType<DriveStore["commit"]>>; }

	async cancelCommit(...args: Parameters<DriveStore["cancelCommit"]>): Promise<Awaited<ReturnType<DriveStore["cancelCommit"]>>> { return await this.invoke("cancelCommit",args) as Awaited<ReturnType<DriveStore["cancelCommit"]>>; }

	async restore(...args: Parameters<DriveStore["restore"]>): Promise<Awaited<ReturnType<DriveStore["restore"]>>> { return await this.invoke("restore",args) as Awaited<ReturnType<DriveStore["restore"]>>; }

	async stat(...args: Parameters<DriveStore["stat"]>): Promise<Awaited<ReturnType<DriveStore["stat"]>>> { return await this.invoke("stat",args) as Awaited<ReturnType<DriveStore["stat"]>>; }

	async search(...args: Parameters<DriveStore["search"]>): Promise<Awaited<ReturnType<DriveStore["search"]>>> { return await this.invoke("search",args) as Awaited<ReturnType<DriveStore["search"]>>; }

	async list(...args: Parameters<DriveStore["list"]>): Promise<Awaited<ReturnType<DriveStore["list"]>>> { return await this.invoke("list",args) as Awaited<ReturnType<DriveStore["list"]>>; }

	async manifest(...args: Parameters<DriveStore["manifest"]>): Promise<Awaited<ReturnType<DriveStore["manifest"]>>> { return await this.invoke("manifest",args) as Awaited<ReturnType<DriveStore["manifest"]>>; }

	async versions(...args: Parameters<DriveStore["versions"]>): Promise<Awaited<ReturnType<DriveStore["versions"]>>> { return await this.invoke("versions",args) as Awaited<ReturnType<DriveStore["versions"]>>; }

	async treeAt(...args: Parameters<DriveStore["treeAt"]>): Promise<Awaited<ReturnType<DriveStore["treeAt"]>>> { return await this.invoke("treeAt",args) as Awaited<ReturnType<DriveStore["treeAt"]>>; }

	async changes(...args: Parameters<DriveStore["changes"]>): Promise<Awaited<ReturnType<DriveStore["changes"]>>> { return await this.invoke("changes",args) as Awaited<ReturnType<DriveStore["changes"]>>; }

	async forkMetadata(...args: Parameters<DriveStore["forkMetadata"]>): Promise<Awaited<ReturnType<DriveStore["forkMetadata"]>>> { return await this.invoke("forkMetadata",args) as Awaited<ReturnType<DriveStore["forkMetadata"]>>; }

	async gcStep(...args: Parameters<DriveStore["gcStep"]>): Promise<Awaited<ReturnType<DriveStore["gcStep"]>>> { return await this.invoke("gcStep",args) as Awaited<ReturnType<DriveStore["gcStep"]>>; }

	override async fetch(request: Request): Promise<Response> {
		if (this.route) {
			const headers = new Headers(request.headers);
			headers.set("x-uls-authority-branch",this.route.branch);
			return this.rootStub(this.route.root).fetch(new Request(request,{headers}));
		}
		return this.local(request.headers.get("x-uls-authority-branch") ?? undefined).fetch(request);
	}
	override webSocketMessage(ws: WebSocket, message:string|ArrayBuffer): void { this.socketStore(ws).webSocketMessage(ws,message); }
	override webSocketClose(ws: WebSocket, code:number, reason:string, _clean:boolean): void { this.socketStore(ws).webSocketClose(ws,code,reason); }
	override webSocketError(ws: WebSocket): void { this.socketStore(ws).webSocketError(ws); }
	private socketStore(ws:WebSocket):DriveStore { return this.local((ws.deserializeAttachment() as WsAttachment|null)?.drive); }
	override async alarm(): Promise<void> {
		if (this.route) return;
		const ids=hasBranches(this.ctx.storage.sql) ? branchIds(this.ctx.storage.sql) : [];
		if (!ids.length) { await this.local().alarm(); return; }
		for (const id of ids) await this.local(id).alarm();
	}
}
