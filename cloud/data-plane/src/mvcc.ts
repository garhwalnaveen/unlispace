/** Branches keep immutable row revisions in their authority's database; a fork stores one cutoff. */
const INHERITED = new Set(["nodes", "versions", "path_log", "shards_known", "retained_shards", "drive_shards"]);
const ROWID = new Set(["nodes", "versions", "path_log", "log"]);
const KEYS: Record<string, string[]> = {
	nodes: ["id"], versions: ["id"], path_log: ["_event"], log: ["_event"],
	shards_known: ["h"], retained_shards: ["h"], drive_shards: ["h"], meta: ["k"],
	commit_receipts: ["actor", "id"], gc_marks: ["h"], gc_manifest_marks: ["h"], gc_pending: ["k"], gc_state: ["id"],
};
interface Column extends Record<string, SqlStorageValue> { name: string; type: string }
interface Branch extends Record<string, SqlStorageValue> { id: string; parent: string | null; cutoff: number; prefix: string }
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const table = (s: string) => `"${s.replaceAll('"', '""')}"`;
const store = (name: string) => `mv_${name}`;

export function hasBranches(sql: SqlStorage): boolean {
	return !!sql.exec("SELECT 1 FROM sqlite_master WHERE name='mv_branches'").toArray().length;
}

/** One-time migration preserves the original drive and row ids, including history cursors. */
export function migrateBranches(sql: SqlStorage, root: string): void {
	if (hasBranches(sql)) return;
	sql.exec("CREATE TABLE mv_branches(id TEXT PRIMARY KEY,parent TEXT,cutoff INTEGER NOT NULL,prefix TEXT NOT NULL UNIQUE)");
	sql.exec("CREATE TABLE mv_clock(v INTEGER NOT NULL)");
	sql.exec("INSERT INTO mv_clock VALUES(0)");
	sql.exec("CREATE TABLE mv_columns(name TEXT PRIMARY KEY,columns TEXT NOT NULL)");
	sql.exec("INSERT INTO mv_branches VALUES(?,NULL,0,'')", root);
	for (const [name, key] of Object.entries(KEYS)) {
		const columns = sql.exec<Column>(`PRAGMA table_info(${table(name)})`).toArray();
		if (!columns.length) continue;
		const names = columns.map(c => c.name);
		sql.exec("INSERT INTO mv_columns VALUES(?,?)", name, JSON.stringify(names));
		sql.exec(`CREATE TABLE ${store(name)}(_record INTEGER PRIMARY KEY AUTOINCREMENT,_branch TEXT NOT NULL,_rev INTEGER NOT NULL,_dead INTEGER NOT NULL,${columns.map(c => `${table(c.name)} ${c.type}`).join(",")}${key.includes("_event") ? ",_event INTEGER" : ""})`);
		sql.exec(`INSERT INTO ${store(name)}(_record,_branch,_rev,_dead,${names.map(table).join(",")}${key.includes("_event") ? ",_event" : ""}) SELECT rowid,?,0,0,${names.map(table).join(",")}${key.includes("_event") ? ",rowid" : ""} FROM ${table(name)}`, root);
		sql.exec(`CREATE INDEX ${store(name)}_visible ON ${store(name)}(_branch,${key.map(table).join(",")},_rev DESC)`);
		if (name === "nodes") sql.exec("CREATE INDEX mv_nodes_edges ON mv_nodes(_branch,parent_id,name,_rev DESC)");
		sql.exec(`UPDATE mv_clock SET v=MAX(v,(SELECT COALESCE(MAX(rowid),0) FROM ${table(name)}))`);
		sql.exec(`DROP TABLE ${table(name)}`);
	}
	// FTS row ids name immutable node revisions; visibility is checked against the branch view.
	sql.exec("DROP TABLE IF EXISTS node_search");
	sql.exec("CREATE VIRTUAL TABLE node_search USING fts5(name, tokenize='trigram')");
	sql.exec("INSERT INTO node_search(rowid,name) SELECT _record,name FROM mv_nodes WHERE _dead=0");
	sql.exec("CREATE TRIGGER mv_node_search_insert AFTER INSERT ON mv_nodes WHEN new._dead=0 BEGIN INSERT INTO node_search(rowid,name) VALUES(new._record,new.name); END");
	createViews(sql, root);
}

function branch(sql: SqlStorage, id: string): Branch {
	const result = sql.exec<Branch>("SELECT * FROM mv_branches WHERE id=?", id).toArray()[0];
	if (!result) throw new Error("no_such_branch");
	return result;
}

function ancestry(id: string): string {
	return `WITH RECURSIVE ancestry(id,bound,depth) AS (
 SELECT ${quote(id)},9223372036854775807,0 UNION ALL
 SELECT b.parent,MIN(a.bound,b.cutoff),a.depth+1 FROM ancestry a JOIN mv_branches b ON b.id=a.id WHERE b.parent IS NOT NULL AND a.depth<8
)`;
}

function createViews(sql: SqlStorage, id: string): void {
	const { prefix } = branch(sql, id);
	for (const row of sql.exec<{ name: string; columns: string }>("SELECT * FROM mv_columns").toArray()) {
		const name = row.name, names = JSON.parse(row.columns) as string[], keys = KEYS[name]!;
		const view = table(prefix + name), physical = store(name);
		const projection = names.map(n => name === "shards_known" && n === "inherited" ? "CASE WHEN a.depth>0 THEN 1 ELSE r.inherited END AS inherited" : `r.${table(n)}`).join(",");
		const source = name === "drive_shards" ? `(SELECT * FROM mv_drive_shards WHERE _branch=${quote(id)} UNION ALL SELECT * FROM mv_retained_shards WHERE _branch!=${quote(id)})` : physical;
		const isInherited = INHERITED.has(name);
		const join = isInherited ? "JOIN ancestry a ON a.id=r._branch AND r._rev<=a.bound" : `JOIN ancestry a ON a.id=r._branch AND a.depth=0`;
		const sameKey = keys.map(k => `s.${table(k)} IS r.${table(k)}`).join(" AND ");
		const shadows = `NOT EXISTS(SELECT 1 FROM ${source} s JOIN ancestry b ON b.id=s._branch AND ${isInherited ? "s._rev<=b.bound" : "b.depth=0"} WHERE ${sameKey} AND (b.depth<a.depth OR (b.depth=a.depth AND s._rev>r._rev)))`;
		// A parent's uncommitted/staged uploads never cross a fork's authorization boundary.
		const retained = name === "shards_known" ? `AND (a.depth=0 OR EXISTS(SELECT 1 FROM mv_retained_shards t WHERE t._branch=a.id AND t.h=r.h AND t._rev<=a.bound AND t._dead=0))` : "";
		sql.exec(`CREATE VIEW ${view} AS ${ancestry(id)} SELECT ${ROWID.has(name) ? `${keys.includes("_event") ? "r._event" : "r._record"} AS rowid,` : ""}${projection} FROM ${source} r ${join} WHERE r._dead=0 AND ${shadows} ${retained}`);
		const writeValues = names.map(n => name === "shards_known" && n === "inherited" ? "COALESCE(new.inherited,0)" : `new.${table(n)}`).join(",");
		const insertCondition = name === "shards_known" || name === "drive_shards" || name === "retained_shards" ? `WHEN NOT EXISTS(SELECT 1 FROM ${view} WHERE h=new.h)` : "";
		const event = keys.includes("_event") ? ",_event" : "";
		const eventValue = keys.includes("_event") ? ",COALESCE(new.rowid,(SELECT v FROM mv_clock))" : "";
		sql.exec(`CREATE TRIGGER ${table(prefix + name + "_insert")} INSTEAD OF INSERT ON ${view} ${insertCondition} BEGIN
 UPDATE mv_clock SET v=v+1;
 INSERT INTO ${physical}(_branch,_rev,_dead,${names.map(table).join(",")}${event}) VALUES(${quote(id)},(SELECT v FROM mv_clock),0,${writeValues}${eventValue}); END`);
		const oldEvent = keys.includes("_event") ? ",old.rowid" : "";
		for (const mutation of ["UPDATE", "DELETE"]) {
			const values = names.map(n => `${mutation === "DELETE" ? "old" : "new"}.${table(n)}`).join(",");
			sql.exec(`CREATE TRIGGER ${table(prefix + name + "_" + mutation.toLowerCase())} INSTEAD OF ${mutation} ON ${view} BEGIN
 UPDATE mv_clock SET v=v+1;
 INSERT INTO ${physical}(_branch,_rev,_dead,${names.map(table).join(",")}${event}) VALUES(${quote(id)},(SELECT v FROM mv_clock),${mutation === "DELETE" ? 1 : 0},${values}${oldEvent}); END`);
		}
	}
}

export function forkBranch(sql: SqlStorage, source: string, child: string): void {
	branch(sql, source);
	if (sql.exec("SELECT 1 FROM mv_branches WHERE id=?", child).toArray().length) throw new Error("drive_exists");
	const cutoff = sql.exec<{ v: number }>("SELECT v FROM mv_clock").one().v;
	sql.exec("INSERT INTO mv_branches VALUES(?,?,?,?)", child, source, cutoff, `branch_${crypto.randomUUID().replaceAll("-", "")}_`);
	createViews(sql, child);
}

/** SQL keeps its existing statements; branch-specific views provide read isolation and append-only writes. */
export function branchSql(sql: SqlStorage, id: string): SqlStorage {
	const { prefix } = branch(sql, id);
	if (!prefix) return sql;
	return {
		exec(query: string, ...bindings: SqlStorageValue[]) {
			const scoped = query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\b[A-Za-z_][A-Za-z_0-9]*\b/g, token => {
				if (token.startsWith("'")) return token;
				const name = token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token;
				return Object.hasOwn(KEYS, name) ? table(prefix + name) : token;
			});
			return sql.exec(scoped, ...bindings);
		},
	} as SqlStorage;
}

export function branchIds(sql: SqlStorage): string[] {
	return sql.exec<{ id: string }>("SELECT id FROM mv_branches ORDER BY rowid").toArray().map(b => b.id);
}
