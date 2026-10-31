import { DurableObject } from "cloudflare:workers";

const PAGE = 1000;
const INIT_PAGES = 4;
const OBJECT_KEY = /^(shards|manifests)\/[a-z0-9][a-z0-9-]{2,62}\/[0-9a-f]{64}$/;
type ObjectRow = { k: string; n: number; inflight: number; stored: number } & Record<string, SqlStorageValue>;

/** One atomic byte budget per organization, shared by all its drives and upload clients. */
export class StorageQuota extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS objects(k TEXT PRIMARY KEY, n INTEGER NOT NULL, inflight INTEGER NOT NULL DEFAULT 0, stored INTEGER NOT NULL DEFAULT 1)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS lineages(id TEXT PRIMARY KEY)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS quota_scans(id TEXT PRIMARY KEY, kind INTEGER NOT NULL DEFAULT 0, cursor TEXT)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS quota_deletions(k TEXT PRIMARY KEY)");
      if (this.setting("used") === undefined) {
        this.set("used", 0);
        this.set("counter_cursor", 0);
        this.set("counter_ready", ctx.storage.sql.exec("SELECT 1 FROM objects LIMIT 1").toArray().length ? 0 : 1);
      }
    });
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn); this.queue = task.catch(() => undefined); return task;
  }
  private setting(key: string): number | undefined { return this.ctx.storage.sql.exec<{v:number}>("SELECT v FROM settings WHERE k=?", key).toArray()[0]?.v; }
  private set(key: string, value: number): void { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO settings VALUES(?,?)", key, value); }
  private add(bytes: number): void { this.ctx.storage.sql.exec("UPDATE settings SET v=v+? WHERE k='used'", bytes); }
  private row(key: string): ObjectRow | undefined { return this.ctx.storage.sql.exec<ObjectRow>("SELECT * FROM objects WHERE k=?", key).toArray()[0]; }
  private remove(key: string): void {
    const row = this.ctx.storage.sql.exec<ObjectRow & {rid:number}>("SELECT rowid AS rid,* FROM objects WHERE k=?", key).toArray()[0];
    if (!row) return;
    this.ctx.storage.sql.exec("DELETE FROM objects WHERE k=?", key);
    if (this.setting("counter_ready") || row.rid <= (this.setting("counter_cursor") ?? 0)) this.add(-row.n);
  }
  private migrateCounter(): boolean {
    if (this.setting("counter_ready")) return true;
    return this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql.exec<ObjectRow & {rid:number}>("SELECT rowid AS rid,* FROM objects WHERE rowid>? ORDER BY rowid LIMIT ?", this.setting("counter_cursor") ?? 0, PAGE).toArray();
      this.add(rows.reduce((n, row) => n + row.n, 0));
      if (rows.length) this.set("counter_cursor", rows.at(-1)!.rid);
      if (rows.length < PAGE) this.set("counter_ready", 1);
      return rows.length < PAGE;
    });
  }
  private async initialize(lineages: string[]): Promise<void> {
    if (!this.migrateCounter()) throw new Error("quota_initializing");
    for (const id of new Set(lineages)) {
      if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(id)) throw new TypeError("invalid lineage");
      if (this.ctx.storage.sql.exec("SELECT 1 FROM lineages WHERE id=?", id).toArray().length) continue;
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO quota_scans(id) VALUES(?)", id);
    }
    let pages = 0;
    for (const {id} of this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM quota_scans ORDER BY id LIMIT ?", INIT_PAGES).toArray()) {
      for (;;) {
        if (pages++ >= INIT_PAGES) throw new Error("quota_initializing");
        const scan = this.ctx.storage.sql.exec<{kind:number;cursor:string|null}>("SELECT kind,cursor FROM quota_scans WHERE id=?", id).one();
        const prefix = `${scan.kind ? "manifests" : "shards"}/${id}/`;
        const page = await this.env.SHARDS.list({prefix, limit: PAGE, ...(scan.cursor ? {cursor:scan.cursor} : {})});
        this.ctx.storage.transactionSync(() => {
          for (const object of page.objects) {
            if (!OBJECT_KEY.test(object.key) || this.row(object.key)) continue;
            this.ctx.storage.sql.exec("INSERT INTO objects(k,n) VALUES(?,?)", object.key, object.size); this.add(object.size);
          }
          if (page.truncated) this.ctx.storage.sql.exec("UPDATE quota_scans SET cursor=? WHERE id=?", page.cursor, id);
          else if (scan.kind === 0) this.ctx.storage.sql.exec("UPDATE quota_scans SET kind=1,cursor=NULL WHERE id=?", id);
          else {
            this.ctx.storage.sql.exec("INSERT OR IGNORE INTO lineages VALUES(?)", id);
            this.ctx.storage.sql.exec("DELETE FROM quota_scans WHERE id=?", id);
          }
        });
        if (!page.truncated && scan.kind === 1) break;
      }
    }
    if (this.ctx.storage.sql.exec("SELECT 1 FROM quota_scans LIMIT 1").toArray().length) throw new Error("quota_initializing");
  }
  usage(lineages: string[]): Promise<{usedBytes:number}> {
    return this.serial(async () => { await this.initialize(lineages); return {usedBytes:this.setting("used")!}; });
  }
  configure(limit: number, lineages: string[]): Promise<{ usedBytes: number }> {
    return this.serial(async () => {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("invalid quota");
      await this.initialize(lineages); this.set("limit", limit); return {usedBytes:this.setting("used")!};
    });
  }
  reserve(key: string, bytes: number): Promise<boolean> {
    return this.serial(async () => this.ctx.storage.transactionSync(() => {
      if (!OBJECT_KEY.test(key) || !Number.isSafeInteger(bytes) || bytes < 0 || !this.setting("counter_ready")) return false;
      const limit = this.setting("limit");
      if (limit === undefined || this.ctx.storage.sql.exec("SELECT 1 FROM quota_scans LIMIT 1").toArray().length || this.ctx.storage.sql.exec("SELECT 1 FROM quota_deletions WHERE k=?", key).toArray().length) return false;
      const existing = this.row(key);
      if (existing) {
        if (existing.n !== bytes) return false;
        this.ctx.storage.sql.exec("UPDATE objects SET inflight=inflight+1 WHERE k=?", key); return true;
      }
      if (this.setting("used")! + bytes > limit) return false;
      this.ctx.storage.sql.exec("INSERT INTO objects VALUES(?,?,1,0)", key, bytes); this.add(bytes); return true;
    }));
  }
  finish(key: string, stored: boolean): Promise<void> {
    return this.serial(async () => this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE objects SET inflight=MAX(0,inflight-1),stored=MAX(stored,?) WHERE k=?", Number(stored), key);
      const row = this.row(key);
      if (row && row.inflight === 0 && row.stored === 0) this.remove(key);
      // shortcut: interrupted active requests retain reservations; release only after verified absence and no active upload.
    }));
  }
  private async releaseAbsent(key: string): Promise<boolean> {
    if (!this.setting("counter_ready") || this.row(key)?.inflight) return false;
    if (await this.env.SHARDS.head(key)) return false;
    this.ctx.storage.transactionSync(() => {
      this.remove(key); this.ctx.storage.sql.exec("DELETE FROM quota_deletions WHERE k=?", key);
    });
    return true;
  }
  /** GC holds its drive mutation lock; this queue fences concurrent byte reservations. */
  deleteUnreferenced(key: string): Promise<boolean> {
    return this.serial(async () => {
      if (!OBJECT_KEY.test(key) || !this.setting("counter_ready") || this.row(key)?.inflight) return false;
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO quota_deletions VALUES(?)", key);
      await this.env.SHARDS.delete(key);
      return this.releaseAbsent(key);
    });
  }
  /** Retry after a lost delete response without deleting a possibly re-referenced object. */
  releaseDeleted(key: string): Promise<boolean> {
    return this.serial(async () => this.releaseAbsent(key));
  }
  recoverDeletion(key: string): Promise<void> {
    return this.serial(async () => {
      if (!OBJECT_KEY.test(key)) throw new TypeError("invalid object key");
      if (!await this.releaseAbsent(key)) this.ctx.storage.sql.exec("DELETE FROM quota_deletions WHERE k=?", key);
    });
  }
  /** One bounded ledger page; never expires active/ambiguous uploads by guessing a timeout. */
  reconcile(lineages: string[]): Promise<{usedBytes:number;checked:number;unresolved:number;more:boolean}> {
    return this.serial(async () => {
      await this.initialize(lineages);
      const after = this.setting("reconcile_cursor") ?? 0;
      const rows = this.ctx.storage.sql.exec<ObjectRow & {rid:number}>("SELECT rowid AS rid,* FROM objects WHERE rowid>? ORDER BY rowid LIMIT 100", after).toArray();
      let unresolved = 0;
      for (const row of rows) {
        if (row.inflight) { unresolved++; continue; }
        await this.releaseAbsent(row.k);
      }
      this.set("reconcile_cursor", rows.length === 100 ? rows.at(-1)!.rid : 0);
      return {usedBytes:this.setting("used")!,checked:rows.length,unresolved,more:rows.length===100};
    });
  }
}

export function quotaFor(env: Env, org: string) {
  const namespace = env.STORAGE_QUOTA as DurableObjectNamespace<StorageQuota>;
  return namespace.get(namespace.idFromName(org));
}
