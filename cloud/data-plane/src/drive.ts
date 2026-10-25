import { DurableObject } from "cloudflare:workers";
import { createUlid } from "./ulid";
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

type Row = Record<string, SqlStorageValue>;
interface NodeRow extends Row {
	path: string;
	type: string;
	head: string | null;
	size: number | null;
	ctype: string | null;
	mtime: number | null;
	seq: number | null;
	parent: string;
}
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
const NODE_PAGE = 500;
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

const parentOf = (key: string): string => {
	const i = key.lastIndexOf("/");
	return i < 0 ? "" : key.slice(0, i);
};
/** Subtree range for folder `key`: every descendant path p satisfies lo <= p < hi ('/' + 1 == '0'). */
const subtree = (key: string): [string, string] => [key + "/", key + "0"];

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)`,
	// parent is an M0 addition to the reference schema: it makes paginated listing an index range scan.
	`CREATE TABLE IF NOT EXISTS nodes(path TEXT PRIMARY KEY, type TEXT NOT NULL, head TEXT, size INTEGER, ctype TEXT, mtime INTEGER, seq INTEGER, parent TEXT NOT NULL)`,
	`CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent, path)`,
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

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		for (const stmt of SCHEMA) this.sql.exec(stmt);
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
		return this.sql.exec<NodeRow>("SELECT * FROM nodes WHERE path=?", key).toArray()[0];
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
			.exec<{ c: number; b: number }>("SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS b FROM nodes WHERE type='file'")
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
	markShards(shards: [string, number][]): Result<null> {
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
	commit(ops: NormOp[], confirmed: [string, number][], actor: string): Result<CommitResponse> {
		if (!this.info()) return this.noDrive();
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

	restore(key: string, versionId: string, ifVersion: string | null, actor: string): Result<CommitResponse> {
		if (!this.info()) return this.noDrive();
		const v = this.getVersion(versionId);
		if (!v || v.path !== key) return fail(404, "no_such_version", { path: key, versionId });
		if (v.manifest === null) return fail(400, "not_restorable", { message: `version ${versionId} is a ${v.op}, not file content` });
		const shards = JSON.parse(v.manifest) as [string, number][];
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
		this.sql.exec(
			"INSERT OR REPLACE INTO nodes(path,type,head,size,ctype,mtime,seq,parent) VALUES(?,?,?,?,?,?,?,?)",
			key, type, head, size, ctype, mtime, c.seq, parentOf(key),
		);
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
				if (op.isFolder) {
					const [lo, hi] = subtree(op.key);
					this.checkSubtreeSize(lo, hi);
					this.eachNode(lo, hi, (k) => {
						this.newVersion(c, k.path, "delete", null, null, null, null);
					});
					this.sql.exec("DELETE FROM nodes WHERE path>=? AND path<?", lo, hi);
				}
				const vid = this.newVersion(c, op.key, "delete", null, null, null, null);
				this.sql.exec("DELETE FROM nodes WHERE path=?", op.key);
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

				const moveOne = (n: NodeRow, newKey: string): string => {
					const old = n.head ? this.getVersion(n.head) : undefined;
					const vid = this.newVersion(c, newKey, "rename", n.size ?? 0, old?.manifest ?? null, n.ctype, n.mtime);
					this.putNode(c, newKey, n.type as "file" | "folder", vid, n.size ?? 0, n.ctype, n.mtime ?? c.ts);
					this.newVersion(c, n.path, "delete", null, null, null, null);
					return vid;
				};
				if (op.isFolder) {
					const [lo, hi] = subtree(op.from);
					this.checkSubtreeSize(lo, hi);
					this.checkRenamedPathLengths(lo, hi, op.from, op.to);
					// Move in key order, one bounded page at a time. The destination is disjoint from the source subtree.
					this.eachNode(lo, hi, (k) => {
						moveOne(k, op.to + k.path.slice(op.from.length));
					});
					this.sql.exec("DELETE FROM nodes WHERE path>=? AND path<?", lo, hi);
				}
				const vid = moveOne(src, op.to);
				this.sql.exec("DELETE FROM nodes WHERE path=?", op.from);
				// A rename is logged as a delete of the old path plus a rename of the new path.
				this.logRow(c, extFrom, "delete", null);
				this.logRow(c, extTo, "rename", vid);
				return { path: extTo, versionId: vid, size: op.isFolder ? 0 : (src.size ?? 0) };
			}
		}
	}

	/** Aborts the commit if the subtree [lo,hi) has more than MAX_SUBTREE_NODES nodes (bounded count). */
	private checkSubtreeSize(lo: string, hi: string): void {
		const n = this.sql
			.exec<{ n: number }>("SELECT COUNT(*) AS n FROM (SELECT 1 FROM nodes WHERE path>=? AND path<? LIMIT ?)", lo, hi, MAX_SUBTREE_NODES + 1)
			.one().n;
		if (n > MAX_SUBTREE_NODES) throw new Abort(fail(400, "subtree_too_large", { limit: MAX_SUBTREE_NODES }));
	}

	/** Visits nodes in [lo,hi) in key order in bounded pages (keyset pagination; no toArray over the whole subtree). */
	private eachNode(lo: string, hi: string, fn: (n: NodeRow) => void): void {
		let after = "";
		for (;;) {
			const page = this.sql
				.exec<NodeRow>("SELECT * FROM nodes WHERE path>=? AND path<? AND path>? ORDER BY path LIMIT ?", lo, hi, after, NODE_PAGE)
				.toArray();
			for (const n of page) fn(n);
			if (page.length < NODE_PAGE) return;
			after = page[page.length - 1]!.path;
		}
	}

	/** Every descendant's new external path must stay within 1024 bytes; otherwise the whole commit aborts. */
	private checkRenamedPathLengths(lo: string, hi: string, from: string, to: string): void {
		const delta = utf8Len(to) - utf8Len(from);
		if (delta <= 0) return;
		const row = this.sql
			.exec<{ path: string; type: string }>(
				"SELECT path, type FROM nodes WHERE path>=? AND path<? AND LENGTH(CAST(path AS BLOB)) + (type='folder') + ? > ? LIMIT 1",
				lo, hi, delta, MAX_PATH_BYTES,
			)
			.toArray()[0];
		if (row) throw new Abort(fail(400, "path_too_long", { path: extPath(to + row.path.slice(from.length), row.type === "folder") }));
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
		const rows = this.sql
			.exec<NodeRow>("SELECT * FROM nodes WHERE parent=? AND path>? ORDER BY path LIMIT ?", key, cursor ?? "", limit + 1)
			.toArray();
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

	manifest(key: string, versionId: string | null) {
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
		const shards = (JSON.parse(v.manifest) as [string, number][]).map(([h, n]) => ({ h, n }));
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

	async alarm(): Promise<void> {
		const now = Date.now();
		let nextAt = Infinity;
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
		if (open === 0) return;
		if (ping) await this.ctx.storage.put("lastPing", now);
		const nextPing = (ping ? now : lastPing) + PING_INTERVAL_MS;
		nextAt = Math.min(nextAt, replaying ? now + REPLAY_TICK_MS : nextPing);
		await this.ctx.storage.setAlarm(Math.max(nextAt, now + 1));
	}
}
