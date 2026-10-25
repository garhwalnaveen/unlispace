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
import { GC_SCHEMA, GC_INTERVAL_MS, LineageGC } from "./gc";

type Row = Record<string, SqlStorageValue>;
interface VersionRow extends Row {
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
	`CREATE TABLE IF NOT EXISTS shards_known(h TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
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

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.ctx.storage.transactionSync(() => {
			for (const stmt of [...SCHEMA, ...GC_SCHEMA]) this.sql.exec(stmt);
			migrateNodes(this.sql);
		});
		this.tree = new NodeTree(this.sql);
		if (this.getMeta("created_at") !== null) {
			if (this.getMeta("gc_next_at") === null) this.setMeta("gc_next_at", String(Date.now() + GC_INTERVAL_MS));
			this.ctx.waitUntil(this.scheduleAlarm(Number(this.getMeta("gc_next_at")), null));
		}
	}

	/** Serialize R2-dependent metadata mutations without blocking reads or WebSocket alarm ticks. */
	private withIO<T>(fn: () => Promise<T>): Promise<T> {
		const task = this.pendingIO.then(fn);
		this.pendingIO = task.catch(() => undefined);
		return task;
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
		if (this.getMeta("created_at") !== null) return fail(409, "drive_exists");
		const createdAt = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.setMeta("drive_id", driveId);
			this.setMeta("placement", placement ?? "");
			this.setMeta("head_seq", "0");
			this.setMeta("created_at", String(createdAt));
		});
		this.setMeta("gc_next_at", String(Date.now() + GC_INTERVAL_MS));
		this.ctx.waitUntil(this.scheduleAlarm(Number(this.getMeta("gc_next_at")), null));
		return ok({ driveId, placement, createdAt });
	}

	/** Soft delete: refuse every request from now on and close all sockets. Idempotent; absent drives are left absent. */
	delete(): Result<null> {
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

	describe(): Result<DriveInfo & { headSeq: number; fileCount: number; bytes: number }> {
		const i = this.info();
		if (!i) return this.noDrive();
		const agg = this.sql
			.exec<{ c: number; b: number }>(LIVE_TREE + " SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS b FROM tree WHERE type='file'")
			.one();
		return ok({ ...i, headSeq: this.headSeq(), fileCount: agg.c, bytes: agg.b });
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
			const lineage = this.getMeta("drive_id")!;
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
		const lineage = this.getMeta("drive_id")!;
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
		if (!v || v.path !== key) return fail(404, "no_such_version", { path: key, versionId });
		if (v.manifest === null) return fail(400, "not_restorable", { message: `version ${versionId} is a ${v.op}, not file content` });
		const shards = await loadManifest(this.env.SHARDS, this.getMeta("drive_id")!, v.manifest);
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

	private newVersion(c: CommitCtx, key: string, op: string, size: number | null, manifest: string | null, ctype: string | null, mtime: number | null): string {
		const id = "v_" + this.ulid();
		this.sql.exec(
			"INSERT INTO versions(id,path,op,size,manifest,seq,ts,actor,ctype,mtime) VALUES(?,?,?,?,?,?,?,?,?,?)",
			id, key, op, size, manifest, c.seq, c.ts, c.actor, ctype, mtime,
		);
		return id;
	}

	private putNode(c: CommitCtx, key: string, type: "file" | "folder", head: string, size: number, ctype: string | null, mtime: number): void {
		this.tree.put(key, { type, head, size, ctype, mtime, seq: c.seq });
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
				const vid = this.newVersion(c, op.key, op.op, op.size, op.manifest, op.ctype, op.mtimeMs);
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
				const vid = this.newVersion(c, op.to, "rename", src.size ?? 0, old?.manifest ?? null, src.ctype, src.mtime);
				this.newVersion(c, op.from, "delete", null, null, null, null);
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
			if (!v || v.path !== key) return fail(404, "no_such_version", { path: key, versionId });
		} else {
			const n = this.getNode(key);
			if (!n) return fail(404, "no_such_path");
			if (n.type !== "file") return fail(400, "not_a_file", { path: key + "/" });
			v = n.head ? this.getVersion(n.head) : undefined;
			if (!v) return fail(404, "no_such_path");
		}
		if (v.manifest === null) return fail(404, "no_such_version", { message: `version ${v.id} has no content (${v.op})` });
		const shards = (await loadManifest(this.env.SHARDS, this.getMeta("drive_id")!, v.manifest)).map(([h, n]) => ({ h, n }));
		return ok({ path: key, versionId: v.id, size: v.size ?? 0, contentType: v.ctype, mtimeMs: v.mtime, shards });
	}

	versions(key: string, cursor: string | null, limit: number) {
		if (!this.info()) return this.noDrive();
		// cursor = rowid of the last returned version (oldest first == rowid order, since versions are only appended)
		const after = cursor === null ? 0 : Number(cursor);
		if (!Number.isSafeInteger(after) || after < 0) return fail(400, "bad_request", { message: "invalid cursor" });
		const rows = this.sql
			.exec<VersionRow & { rid: number }>("SELECT rowid AS rid,id,op,size,seq,ts,actor FROM versions WHERE path=? AND rowid>? ORDER BY rowid LIMIT ?", key, after, limit + 1)
			.toArray();
		const page = rows.slice(0, limit);
		return ok({
			versions: page.map((r) => ({ versionId: r.id, op: r.op, size: r.size, seq: r.seq, ts: r.ts, actor: r.actor })),
			cursor: rows.length > limit ? String(page[page.length - 1]!.rid) : null,
		});
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
		if (last - after > MAX_BACKLOG_EVENTS) {
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
			const lineage = this.getMeta("drive_id");
			if (!lineage) return null;
			const result = await new LineageGC(this.sql, this.env.SHARDS, lineage).step(this.headSeq(), Date.now(), this.env.ULS_GC_DELETE !== "1");
			const next = Date.now() + (result.done ? GC_INTERVAL_MS : 1000);
			this.setMeta("gc_next_at", String(next));
			await this.scheduleAlarm(next, null);
			return result;
		});
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		if (Number(this.getMeta("gc_next_at") ?? "Infinity") <= now) await this.gcStep();
		const gcNext = Number(this.getMeta("gc_next_at") ?? "Infinity");
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
