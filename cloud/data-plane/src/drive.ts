import { HISTORY_SCHEMA, migrateHistory } from "./history";
import { DurableObject } from "cloudflare:workers";
import { createUlid } from "./ulid";
import { LIVE_TREE, migrateNodes, NodeTree, type NodeRow } from "./nodes";
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
import { loadManifest, storeManifest } from "./manifests";
import { EXPORT_COLUMNS, validateExportRow, withinDeadline, type ExportHeader } from "./exports";
import { GC_SCHEMA, GC_INTERVAL_MS, LineageGC } from "./gc";

type Row = Record<string, SqlStorageValue>;
interface VersionRow extends Row {
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

/** Per-socket state kept across hibernation via serializeAttachment. */
interface WsAttachment {
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

export class DriveAuthority extends DurableObject<Env> {
	private ulid = createUlid();
	private sql: SqlStorage;
	private tree: NodeTree;
	private pendingIO: Promise<unknown> = Promise.resolve();
	private pendingSnapshot: Promise<string | null> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.ctx.storage.transactionSync(() => {
			for (const stmt of [...SCHEMA, ...GC_SCHEMA, ...HISTORY_SCHEMA]) this.sql.exec(stmt);
			migrateNodes(this.sql);
			migrateHistory(this.sql);
			if (!this.sql.exec<{name: string}>("PRAGMA table_info(shards_known)").toArray().some(c => c.name === "inherited"))
				this.sql.exec("ALTER TABLE shards_known ADD COLUMN inherited INTEGER NOT NULL DEFAULT 0");
			const id = this.getMeta("drive_id");
			if (id) {
				if (!this.getMeta("lineage")) this.setMeta("lineage", id);
				if (!this.getMeta("depth")) this.setMeta("depth", "0");
				this.sql.exec("INSERT OR IGNORE INTO lineage_members VALUES(?,?,NULL)", id, Date.now());
			}
		});
		this.tree = new NodeTree(this.sql);
		if (this.getMeta("created_at") !== null) {
			if (this.getMeta("gc_next_at") === null) this.setMeta("gc_next_at", String(Date.now() + GC_INTERVAL_MS));
			this.ctx.waitUntil(this.scheduleAlarm(Math.min(Number(this.getMeta("gc_next_at")), this.snapshotDueAt()), null));
		}
	}

	/** Serialize R2-dependent metadata mutations without blocking reads or WebSocket alarm ticks. */
	private withIO<T>(fn: () => Promise<T>): Promise<T> {
		const task = this.pendingIO.then(fn);
		this.pendingIO = task.catch(() => undefined);
		return task;
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

	create(driveId: string, placement: Placement | null): Result<DriveInfo> {
		// A deleted drive keeps its id: re-creating it is refused too.
		if (this.getMeta("created_at") !== null || this.getMeta("importing") !== null) return fail(409, "drive_exists");
		const createdAt = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.setMeta("drive_id", driveId);
			this.setMeta("lineage", driveId);
			this.setMeta("depth", "0");
			this.sql.exec("INSERT OR REPLACE INTO lineage_members VALUES(?,?,NULL)", driveId, createdAt);
			this.setMeta("placement", placement ?? "");
			this.setMeta("head_seq", "0");
			this.setMeta("deleted", "0");
			this.setMeta("created_at", String(createdAt));
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
				for (const ws of this.ctx.getWebSockets()) ws.close(WS_CLOSE_DELETED, "drive_deleted");
				this.ctx.storage.transactionSync(() => {
					for (const table of ["nodes", "versions", "path_log", "log", "shards_known", "gc_state", "gc_marks"]) this.sql.exec(`DELETE FROM ${table}`);
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

	lineageInfo(): {lineage: string; driveId: string} | null {
		const driveId = this.getMeta("drive_id");
		return driveId ? {driveId, lineage: this.lineage()} : null;
	}

	private softDelete(): Result<null> {
		if (this.getMeta("created_at") === null || this.getMeta("deleted") === "1") return ok(null);
		this.setMeta("deleted", "1");
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(WS_CLOSE_DELETED, "drive_deleted");
			} catch {
				// already closed
			}
		}
		return ok(null);
	}

	describe(): Result<DriveInfo & {headSeq: number; fileCount: number; bytes: number; lineage: string; depth: number; forkOf: {driveId: string; forkPoint: number} | null}> {
		const i = this.info();
		if (!i) return this.noDrive();
		const agg = this.sql.exec<{c: number; b: number}>(LIVE_TREE + " SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS b FROM tree WHERE type='file'").one();
		const fork = this.getMeta("forkOf");
		const forkOf = fork ? JSON.parse(fork) as {driveId: string; ts: number} : null;
		return ok({...i, headSeq: this.headSeq(), fileCount: agg.c, bytes: agg.b, lineage: this.lineage(), depth: Number(this.getMeta("depth") ?? 0), forkOf: forkOf ? {driveId: forkOf.driveId, forkPoint: forkOf.ts} : null});
	}

	stats() {
		return this.withIO(async () => {
			const info = this.describe();
			if (!info.ok) return info;
			const hashes = new Set<string>();
			for (const v of this.sql.exec<{manifest: string}>("SELECT manifest FROM versions WHERE manifest IS NOT NULL"))
				for (const [h] of await loadManifest(this.env.SHARDS, this.lineage(), v.manifest)) hashes.add(h);
			let bytes = 0;
			for (const h of hashes) bytes += this.sql.exec<{n: number}>("SELECT n FROM shards_known WHERE h=? AND inherited=0", h).toArray()[0]?.n ?? 0;
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
					this.sql.exec(`INSERT INTO export_rows SELECT ?,?+ROW_NUMBER() OVER (ORDER BY rowid),
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
				migrateHistory(this.sql);
				this.setMeta("drive_id", driveId);
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

	snapshot(): Promise<string | null> {
		if (this.pendingSnapshot) return this.pendingSnapshot;
		const task = this.writeSnapshot();
		this.pendingSnapshot = task;
		return task.finally(() => { this.pendingSnapshot = null; });
	}

	private async writeSnapshot(): Promise<string | null> {
		if (!this.info() || this.headSeq() <= Number(this.getMeta("snapshot_seq") ?? 0) ||
			Date.now() - Number(this.getMeta("snapshot_at") ?? this.getMeta("created_at") ?? 0) < SNAPSHOT_INTERVAL_MS) return null;
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

	/** Returns the subset of `hashes` not present in shards_known. */
	filterUnknown(hashes: string[]): Result<string[]> {
		if (!this.info()) return this.noDrive();
		return ok(hashes.filter((h) => this.sql.exec("SELECT 1 FROM shards_known WHERE h=?", h).toArray().length === 0));
	}

	/** Records shards the Worker has verified in R2. */
	markShards(shards: [string, number][]): Promise<Result<null>> {
		return this.withIO(async () => {
			if (!this.info()) return this.noDrive();
			const lineage = this.lineage();
			const present: [string, number][] = [];
			for (const [h] of shards) {
				const object = await this.env.SHARDS.head(`shards/${lineage}/${h}`);
				if (object) present.push([h, object.size]);
			}
			return this.recordShards(present);
		});
	}

	private recordShards(shards: [string, number][]): Result<null> {
		if (!this.info()) return this.noDrive();
		this.ctx.storage.transactionSync(() => {
			for (const [h, n] of shards) this.sql.exec("INSERT OR IGNORE INTO shards_known(h,n) VALUES(?,?)", h, n);
		});
		return ok(null);
	}

	// ---------- commit ----------

	/**
	 * Atomic commit. `confirmed` lists shards the Worker has already HEADed in R2 (hash, size),
	 * so unknown-but-present hashes are accepted and added to shards_known.
	 */
	commit(ops: NormOp[], confirmed: [string, number][], actor: string): Promise<Result<CommitResponse>> {
		return this.withIO(() => this.commitExclusive(ops, confirmed, actor));
	}

	private async commitExclusive(ops: NormOp[], confirmed: [string, number][], actor: string): Promise<Result<CommitResponse>> {
		if (!this.info()) return this.noDrive();
		const lineage = this.lineage();
		// Worker HEADs can race a sweep before this queued call starts; recheck under the IO lock.
		const present: [string, number][] = [];
		for (const [h] of confirmed) {
			const object = await this.env.SHARDS.head(`shards/${lineage}/${h}`);
			if (object) present.push([h, object.size]);
		}
		confirmed = present;
		for (const op of ops) if (op.op === "put") op.manifest = await storeManifest(this.env.SHARDS, lineage, op.manifest);
		// Shard registration, consistency checks and the ops share ONE transaction: a failed commit leaves nothing behind.
		return this.runCommit(actor, (c) => {
			for (const [h, n] of confirmed) this.sql.exec("INSERT OR IGNORE INTO shards_known(h,n) VALUES(?,?)", h, n);
			const missing = new Set<string>();
			for (const op of ops) {
				if (op.op !== "put") continue;
				for (const [h, n] of op.shards) {
					const row = this.sql.exec<{ n: number }>("SELECT n FROM shards_known WHERE h=?", h).toArray()[0];
					if (!row) missing.add(h);
					else if (row.n !== n) throw new Abort(fail(400, "bad_manifest", { message: `shard ${h} is ${row.n} bytes, manifest says ${n}` }));
				}
			}
			if (missing.size) throw new Abort(fail(409, "missing_shards", { hashes: [...missing] }));
			return ops.map((op) => this.applyOp(op, c));
		});
	}

	restore(key: string, versionId: string, ifVersion: string | null, actor: string): Promise<Result<CommitResponse>> {
		return this.withIO(() => this.restoreExclusive(key, versionId, ifVersion, actor));
	}

	private async restoreExclusive(key: string, versionId: string, ifVersion: string | null, actor: string): Promise<Result<CommitResponse>> {
		if (!this.info()) return this.noDrive();
		const v = this.getVersion(versionId);
		if (!v || v.node_id !== this.historyNode(key)) return fail(404, "no_such_version", { path: key, versionId });
		if (v.manifest === null) return fail(400, "not_restorable", { message: `version ${versionId} is a ${v.op}, not file content` });
		const shards = await loadManifest(this.env.SHARDS, this.lineage(), v.manifest);
		const op: NormOp = {
			op: "restore",
			key,
			ifVersion,
			ifAbsent: false,
			size: v.size ?? 0,
			ctype: v.ctype ?? "application/octet-stream",
			mtimeMs: v.mtime ?? Date.now(),
			manifest: v.manifest,
			shards,
			restoredFrom: versionId,
			nodeId: v.node_id,
		};
		return this.runCommit(actor, (c) => [this.applyOp(op, c)]);
	}

	private runCommit(actor: string, fn: (c: CommitCtx) => CommitResult[]): Result<CommitResponse> {
		let events: ChangeEntry[] = [];
		let response: CommitResponse;
		try {
			response = this.ctx.storage.transactionSync(() => {
				const c: CommitCtx = { actor, seq: this.headSeq() + 1, ts: Date.now(), events: [] };
				const results = fn(c);
				this.setMeta("head_seq", String(c.seq));
				events = c.events;
				return { seq: c.seq, results };
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
		const row = this.sql.exec<{ ev: number }>("SELECT last_insert_rowid() AS ev").one();
		c.events.push({ ev: row.ev, seq: c.seq, path, op, versionId });
	}

	private newVersion(c: CommitCtx, key: string, op: string, size: number | null, manifest: string | null, ctype: string | null, mtime: number | null, nodeId = this.getNode(key)?.id ?? crypto.randomUUID(), restoredFrom: string | null = null): string {
		const id = "v_" + this.ulid();
		this.sql.exec(
			"INSERT INTO versions(id,path,op,size,manifest,seq,ts,actor,ctype,mtime,node_id,restored_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
			id, key, op, size, manifest, c.seq, c.ts, c.actor, ctype, mtime, nodeId, restoredFrom,
		);
		return id;
	}

	private putNode(c: CommitCtx, key: string, type: "file" | "folder", head: string, size: number, ctype: string | null, mtime: number): void {
		const nodeId = this.getVersion(head)!.node_id;
		this.tree.put(key, { type, head, size, ctype, mtime, seq: c.seq }, nodeId);
		this.sql.exec("INSERT INTO path_log VALUES(?,?,?,?,?)", c.seq, c.ts, nodeId, key, type);
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
				const vid = this.newVersion(c, op.key, op.op, op.size, op.manifest, op.ctype, op.mtimeMs, node?.id ?? (op.op === "restore" ? op.nodeId : undefined), op.op === "restore" ? op.restoredFrom ?? null : null);
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
				const vid = this.newVersion(c, op.to, "rename", src.size ?? 0, old?.manifest ?? null, src.ctype, src.mtime, src.id);
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

	stat(key: string): Result<ReturnType<DriveAuthority["nodeJson"]>> {
		if (!this.info()) return this.noDrive();
		if (key === "") return ok({ path: "", type: "folder", versionId: null, size: 0, contentType: null, mtimeMs: null, seq: this.headSeq() });
		const n = this.getNode(key);
		if (!n) return fail(404, "no_such_path");
		return ok(this.nodeJson(n));
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

	async manifest(key: string, versionId: string | null) {
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
		const shards = (await loadManifest(this.env.SHARDS, this.lineage(), v.manifest)).map(([h, n]) => ({ h, n }));
		return ok({ path: key, versionId: v.id, size: v.size ?? 0, contentType: v.ctype, mtimeMs: v.mtime, shards });
	}

	private historyNode(key: string): string | null {
		return this.getNode(key)?.id ?? this.sql.exec<{node_id:string}>("SELECT p.node_id FROM path_log p WHERE p.path=? AND p.path=(SELECT q.path FROM path_log q WHERE q.node_id=p.node_id ORDER BY q.seq DESC,q.rowid DESC LIMIT 1) ORDER BY p.seq DESC,p.rowid DESC LIMIT 1",key).toArray()[0]?.node_id ?? null;
	}

	private recordSubtree(c: CommitCtx, root: NodeRow, from: string, to: string, op: string): void {
		this.sql.exec(`WITH RECURSIVE sub(id,path) AS (
 SELECT ?,? UNION ALL SELECT n.id,sub.path||'/'||n.name FROM nodes n JOIN sub ON n.parent_id=sub.id
 ) INSERT INTO path_log SELECT ?,?,id,?||substr(path,length(?)+1),? FROM sub`,root.id,from,c.seq,c.ts,to,from,op);
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
		server.serializeAttachment({ exp, replayAfter: after < last ? after : null } satisfies WsAttachment);
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
		for (const ws of this.ctx.getWebSockets()) {
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
			const result = await new LineageGC(this.sql, this.env.SHARDS, lineage).step(this.headSeq(), Date.now(), this.env.ULS_GC_DELETE !== "1");
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
		const lastPing = (await this.ctx.storage.get<number>("lastPing")) ?? 0;
		const ping = lastPing + PING_INTERVAL_MS <= now + REPLAY_TICK_MS;
		for (const ws of this.ctx.getWebSockets()) {
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
					ws.serializeAttachment({ exp: att.exp, replayAfter: done ? null : cursor } satisfies WsAttachment);
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
		if (ping) await this.ctx.storage.put("lastPing", now);
		const nextPing = (ping ? now : lastPing) + PING_INTERVAL_MS;
		nextAt = Math.min(nextAt, replaying ? now + REPLAY_TICK_MS : nextPing);
		await this.ctx.storage.setAlarm(Math.max(nextAt, now + 1));
	}
}
