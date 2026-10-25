// In-memory stand-in for cloud/data-plane's HTTP API (/v0/drives/{id}/...), following its CONTRACT-NOTES.
// It models the semantics the gateway relies on: versions, preconditions, parents, rename, restore and the change log.
import type { FetchBinding } from "../src/data-plane";

interface Version { id: string; path: string; op: string; size: number | null; ts: number; actor: string; shards: { h: string; n: number }[] | null; ctype: string | null; mtime: number | null }
interface Node { type: "file" | "folder"; head: string }
interface Drive { nodes: Map<string, Node>; versions: Version[]; log: { ev: number; path: string; op: string; versionId: string | null }[]; seq: number }

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let counter = 0;
const ulid = (): string => {
  let n = ++counter, tail = "";
  for (let i = 0; i < 6; i++) { tail = ALPHABET[n % 32] + tail; n = Math.floor(n / 32); }
  const random = Array.from(crypto.getRandomValues(new Uint8Array(20)), b => ALPHABET[b % 32]).join("");
  return `v_${random}${tail}`.slice(0, 29);
};
const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response => json({ error, ...extra }, status);
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");

export class FakeDataPlane implements FetchBinding {
  drives = new Map<string, Drive>();
  shards = new Map<string, Uint8Array>();
  tokens: string[] = [];
  shardPuts = 0;
  now = 1_700_000_000_000;

  createDrive(id: string): void { this.drives.set(id, { nodes: new Map(), versions: [], log: [], seq: 0 }); }
  private tick(): number { return (this.now += 1000); }

  async fetch(request: Request): Promise<Response> {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return fail(401, "unauthorized");
    this.tokens.push(auth.slice(7));
    const url = new URL(request.url);
    const m = /^\/v0\/drives\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!m) return fail(404, "not_found");
    const drive = this.drives.get(m[1]!);
    if (!drive) return fail(404, "no_such_drive");
    const rest = m[2] ?? "", method = request.method;
    const p = (name: string): string => url.searchParams.get(name) ?? "";
    const key = (raw: string): string => raw.replace(/\/$/, "");

    if (rest === "") return json({ driveId: m[1], placement: null, createdAt: 0, headSeq: drive.seq, fileCount: [...drive.nodes.values()].filter(n => n.type === "file").length, bytes: 0 });
    if (rest.startsWith("shards/") && rest !== "shards/missing") {
      const hash = rest.slice(7);
      if (method === "PUT") {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > 16 * 1024 * 1024) return fail(413, "too_large");
        if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== hash) return fail(400, "hash_mismatch");
        this.shardPuts++; this.shards.set(`${m[1]}/${hash}`, bytes);
        return json({ hash, size: bytes.length, stored: true }, 201);
      }
      const bytes = this.shards.get(`${m[1]}/${hash}`);
      return bytes ? new Response(bytes) : fail(404, "no_such_shard");
    }
    if (rest === "stat") {
      const k = key(p("path"));
      if (k === "") return json({ path: "", type: "folder", versionId: null, size: 0, contentType: null, mtimeMs: null, seq: drive.seq });
      const n = drive.nodes.get(k);
      return n ? json(this.nodeJson(drive, k, n)) : fail(404, "no_such_path");
    }
    if (rest === "list") {
      const k = key(p("path"));
      if (k !== "" && drive.nodes.get(k)?.type !== "folder") return fail(404, "no_such_path");
      const names = [...drive.nodes.keys()].filter(x => (k === "" ? !x.includes("/") : x.startsWith(`${k}/`) && !x.slice(k.length + 1).includes("/"))).sort();
      const limit = Number(p("limit") || 1000), after = p("cursor") ? atob(p("cursor")) : "";
      const rows = names.filter(x => x > after).slice(0, limit + 1);
      const page = rows.slice(0, limit);
      return json({
        entries: page.map(x => { const j = this.nodeJson(drive, x, drive.nodes.get(x)!); return { name: x.slice(k === "" ? 0 : k.length + 1), type: j.type, versionId: j.versionId, size: j.size, mtimeMs: j.mtimeMs }; }),
        cursor: rows.length > limit ? btoa(page.at(-1)!) : null,
      });
    }
    if (rest === "manifest") {
      const k = key(p("path")), vid = p("versionId");
      let v: Version | undefined;
      if (vid) { v = drive.versions.find(x => x.id === vid); if (!v || v.path !== k) return fail(404, "no_such_version"); }
      else {
        const n = drive.nodes.get(k);
        if (!n) return fail(404, "no_such_path");
        if (n.type !== "file") return fail(400, "not_a_file");
        v = drive.versions.find(x => x.id === n.head);
      }
      if (!v?.shards) return fail(404, "no_such_version");
      return json({ path: k, versionId: v.id, size: v.size, contentType: v.ctype, mtimeMs: v.mtime, shards: v.shards });
    }
    if (rest === "versions") {
      const k = key(p("path")), limit = Number(p("limit") || 1000), skip = Number(p("cursor") ? atob(p("cursor")) : 0);
      const all = drive.versions.filter(v => v.path === k);
      const page = all.slice(skip, skip + limit);
      return json({ versions: page.map(v => ({ versionId: v.id, op: v.op, size: v.size, seq: 0, ts: v.ts, actor: v.actor })), cursor: skip + limit < all.length ? btoa(String(skip + limit)) : null });
    }
    if (rest === "changes") {
      const after = Number(p("after") || 0), limit = Number(p("limit") || 1000);
      const rows = drive.log.filter(x => x.ev > after);
      return json({ changes: rows.slice(0, limit), headSeq: drive.seq, lastEv: drive.log.at(-1)?.ev ?? 0, more: rows.length > limit });
    }
    if (rest === "commit" && method === "POST") return this.commit(drive, await request.json() as { ops: Record<string, unknown>[] }, m[1]!);
    if (rest === "restore" && method === "POST") {
      const b = await request.json() as { path: string; versionId: string; ifVersion?: string };
      const v = drive.versions.find(x => x.id === b.versionId);
      if (!v || v.path !== b.path) return fail(404, "no_such_version");
      if (!v.shards) return fail(400, "not_restorable");
      const cur = drive.nodes.get(b.path);
      if (b.ifVersion && cur?.head !== b.ifVersion) return fail(412, "precondition_failed", { currentVersionId: cur?.head ?? null });
      const row = this.addVersion(drive, b.path, "restore", v.size, v.shards, v.ctype, v.mtime);
      drive.nodes.set(b.path, { type: "file", head: row.id });
      drive.seq++;
      return json({ seq: drive.seq, results: [{ path: b.path, versionId: row.id, size: v.size }] });
    }
    return fail(404, "not_found");
  }

  private nodeJson(drive: Drive, k: string, n: Node) {
    const v = drive.versions.find(x => x.id === n.head);
    return { path: n.type === "folder" ? `${k}/` : k, type: n.type, versionId: n.head, size: v?.size ?? 0, contentType: v?.ctype ?? null, mtimeMs: v?.mtime ?? this.now, seq: 0 };
  }
  private addVersion(drive: Drive, path: string, op: string, size: number | null, shards: Version["shards"], ctype: string | null, mtime: number | null): Version {
    const row: Version = { id: ulid(), path, op, size, ts: this.tick(), actor: "test", shards, ctype, mtime };
    drive.versions.push(row);
    drive.log.push({ ev: drive.log.length + 1, path, op, versionId: row.id });
    return row;
  }
  private parents(drive: Drive, k: string): Response | null {
    const parts = k.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/"), n = drive.nodes.get(dir);
      if (n && n.type !== "folder") return fail(409, "path_conflict", { path: dir });
      if (!n) { const row = this.addVersion(drive, dir, "mkdir", null, null, null, null); drive.nodes.set(dir, { type: "folder", head: row.id }); }
    }
    return null;
  }
  private commit(drive: Drive, body: { ops: Record<string, unknown>[] }, driveId: string): Response {
    // All-or-nothing, like the Durable Object transaction.
    const snapshot = { nodes: new Map(drive.nodes), versions: [...drive.versions], log: [...drive.log], seq: drive.seq };
    const results: unknown[] = [];
    for (const op of body.ops) {
      const raw = String(op.path ?? op.to), k = key2(raw), cur = drive.nodes.get(k);
      const ifVersion = op.ifVersion as string | undefined | null;
      const precondition = (target: Node | undefined): Response | null => {
        if ((ifVersion && target?.head !== ifVersion) || (op.ifAbsent && target)) return fail(412, "precondition_failed", { currentVersionId: target?.head ?? null });
        return null;
      };
      let failed: Response | null = null;
      if (op.op === "put") {
        failed = precondition(cur);
        if (!failed && cur?.type === "folder") failed = fail(409, "path_conflict");
        for (const s of op.shards as { h: string; n: number }[]) if (!failed && !this.shards.has(`${driveId}/${s.h}`)) failed = fail(409, "missing_shards", { hashes: [s.h] });
        if (!failed) failed = this.parents(drive, k);
        if (!failed) {
          const row = this.addVersion(drive, k, "put", op.size as number, op.shards as Version["shards"], op.contentType as string, op.mtimeMs as number);
          drive.nodes.set(k, { type: "file", head: row.id });
          results.push({ path: k, versionId: row.id, size: row.size });
        }
      } else if (op.op === "mkdir") {
        failed = precondition(cur);
        if (!failed && cur && cur.type !== "folder") failed = fail(409, "path_conflict");
        if (!failed && !cur) { failed = this.parents(drive, k); if (!failed) { const row = this.addVersion(drive, k, "mkdir", null, null, null, null); drive.nodes.set(k, { type: "folder", head: row.id }); results.push({ path: `${k}/`, versionId: row.id, size: 0 }); } }
        else if (!failed) results.push({ path: `${k}/`, versionId: cur!.head, size: 0 });
      } else if (op.op === "delete") {
        failed = precondition(cur);
        if (!failed && (!cur || (cur.type === "folder") !== raw.endsWith("/"))) failed = fail(404, "no_such_path");
        if (!failed) {
          for (const x of [...drive.nodes.keys()]) if (x === k || x.startsWith(`${k}/`)) { const row = this.addVersion(drive, x, "delete", null, null, null, null); void row; drive.nodes.delete(x); }
          results.push({ path: raw, versionId: drive.versions.at(-1)!.id, size: 0 });
        }
      } else if (op.op === "rename") {
        const from = key2(String(op.from)), src = drive.nodes.get(from);
        failed = precondition(src);
        if (!failed && !src) failed = fail(404, "no_such_path");
        if (!failed && drive.nodes.has(k)) failed = fail(409, "path_conflict");
        if (!failed) failed = this.parents(drive, k);
        if (!failed) {
          let last = "";
          for (const x of [...drive.nodes.keys()].sort()) {
            if (x !== from && !x.startsWith(`${from}/`)) continue;
            const node = drive.nodes.get(x)!, v = drive.versions.find(y => y.id === node.head)!, dest = k + x.slice(from.length);
            this.addVersion(drive, x, "delete", null, null, null, null);
            const row = this.addVersion(drive, dest, node.type === "folder" ? "mkdir" : "rename", v.size, v.shards, v.ctype, v.mtime);
            drive.nodes.delete(x); drive.nodes.set(dest, { type: node.type, head: row.id });
            if (x === from) last = row.id;
          }
          results.push({ path: String(op.to), versionId: last, size: 0 });
        }
      } else failed = fail(400, "bad_request");
      if (failed) { drive.nodes = snapshot.nodes; drive.versions = snapshot.versions; drive.log = snapshot.log; drive.seq = snapshot.seq; return failed; }
    }
    drive.seq++;
    return json({ seq: drive.seq, results });
  }
}
const key2 = (s: string): string => s.replace(/\/$/, "");
