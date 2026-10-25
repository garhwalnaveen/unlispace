/** Stable namespace edges. Detached roots keep their descendants and retained history unreachable. */
export interface NodeRow extends Record<string, SqlStorageValue> {
	id: string;
	parent_id: string | null;
	name: string;
	path: string;
	type: string;
	head: string | null;
	size: number | null;
	ctype: string | null;
	mtime: number | null;
	seq: number | null;
}

const CREATE = `CREATE TABLE nodes(id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
 type TEXT NOT NULL, head TEXT, size INTEGER, ctype TEXT, mtime INTEGER, seq INTEGER,
 UNIQUE(parent_id,name))`;
export const LIVE_TREE = `WITH RECURSIVE tree AS (
 SELECT *,name AS path FROM nodes WHERE parent_id=''
 UNION ALL SELECT n.*,tree.path||'/'||n.name FROM nodes n JOIN tree ON n.parent_id=tree.id
)`;

/** Called in the constructor's transaction: either the entire M0 conversion commits or none does. */
export function migrateNodes(sql: SqlStorage): void {
	const columns = sql.exec<{ name: string }>("PRAGMA table_info(nodes)").toArray();
	if (!columns.length) sql.exec(CREATE);
	else if (columns.some((c) => c.name === "path")) {
		sql.exec("ALTER TABLE nodes RENAME TO nodes_m0");
		sql.exec(CREATE);
		sql.exec(`INSERT INTO nodes(id,parent_id,name,type,head,size,ctype,mtime,seq)
 SELECT 'm0:'||path,CASE WHEN parent='' THEN '' ELSE 'm0:'||parent END,
 CASE WHEN parent='' THEN path ELSE substr(path,length(parent)+2) END,
 type,head,size,ctype,mtime,seq FROM nodes_m0`);
		sql.exec("DROP TABLE nodes_m0");
	}
}

export class NodeTree {
	constructor(private sql: SqlStorage) {}

	get(path: string): NodeRow | undefined {
		let parent = "";
		let node: NodeRow | undefined;
		const segments = path.split("/");
		for (let i = 0; i < segments.length; i++) {
			node = this.sql.exec<NodeRow>("SELECT * FROM nodes WHERE parent_id=? AND name=?", parent, segments[i]!).toArray()[0];
			if (!node || (i < segments.length - 1 && node.type !== "folder")) return undefined;
			parent = node.id;
		}
		return node && { ...node, path };
	}

	put(path: string, data: { type: string; head: string; size: number; ctype: string | null; mtime: number; seq: number }): void {
		const at = path.lastIndexOf("/");
		const parent = at < 0 ? "" : this.get(path.slice(0, at))!.id;
		const name = path.slice(at + 1);
		this.sql.exec(`INSERT INTO nodes(id,parent_id,name,type,head,size,ctype,mtime,seq) VALUES(?,?,?,?,?,?,?,?,?)
 ON CONFLICT(parent_id,name) DO UPDATE SET type=excluded.type,head=excluded.head,size=excluded.size,
 ctype=excluded.ctype,mtime=excluded.mtime,seq=excluded.seq`,
			crypto.randomUUID(), parent, name, data.type, data.head, data.size, data.ctype, data.mtime, data.seq);
	}

	detach(id: string): void {
		this.sql.exec("UPDATE nodes SET parent_id=NULL WHERE id=?", id);
	}

	move(id: string, path: string, head: string, seq: number): void {
		const at = path.lastIndexOf("/");
		const parent = at < 0 ? "" : this.get(path.slice(0, at))!.id;
		this.sql.exec("UPDATE nodes SET parent_id=?,name=?,head=?,seq=? WHERE id=?", parent, path.slice(at + 1), head, seq, id);
	}

	children(path: string, after: string | null, limit: number): NodeRow[] {
		const parent = path === "" ? "" : this.get(path)!.id;
		const name = after === null ? "" : path === "" ? after : after.slice(path.length + 1);
		return this.sql.exec<NodeRow>("SELECT * FROM nodes WHERE parent_id=? AND name>? ORDER BY name LIMIT ?", parent, name, limit).toArray()
			.map((n) => ({ ...n, path: path ? path + "/" + n.name : n.name }));
	}

	/** Only reads descendants; rename/delete never write one row per child. */
	descendants(id: string): SqlStorageCursor<NodeRow> {
		return this.sql.exec<NodeRow>(`WITH RECURSIVE sub AS (
 SELECT *,name AS path FROM nodes WHERE parent_id=?
 UNION ALL SELECT n.*,sub.path||'/'||n.name FROM nodes n JOIN sub ON n.parent_id=sub.id
 ) SELECT * FROM sub`, id);
	}
}
