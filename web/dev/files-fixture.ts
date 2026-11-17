// Development-only: an in-memory drive for the file browser previews (?view=files-live|files-details|files-readonly|files-expired).
// Uploads, folders, renames, moves, deletes, restores and search all work against this copy and are lost on reload.
interface Version { versionId: string; op: string; size: number | null; seq: number; ts: number; actor: string | null; restoredFrom: string | null; content?: Uint8Array<ArrayBuffer> }
interface Node { type: "file" | "folder"; versions: Version[]; mtimeMs: number }
const HOUR = 3_600_000;
const now = Date.now();
const text = (value: string) => new TextEncoder().encode(value);
const checklist = `# Launch checklist\n\n- [x] Final logo files in Brand assets\n- [x] Homepage copy approved\n- [ ] Export social cards\n- [ ] Record the product walkthrough\n- [ ] Send the press kit to partners\n\nOwner: Alex · Review on Friday\n`;
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#171717"/><circle cx="160" cy="100" r="46" fill="none" stroke="#fbffc9" stroke-width="10"/><ellipse cx="160" cy="100" rx="92" ry="26" fill="none" stroke="#fbffc9" stroke-width="6" transform="rotate(-24 160 100)"/></svg>`;
let seq = 0;
let counter = 0;
const id = () => `v_${String(++counter).padStart(26, "0")}`;
const nodes = new Map<string, Node>();
const history = new Map<string, Version[]>();
const log: { ev: number; seq: number; path: string; op: string; versionId: string | null }[] = [];
const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
const record = (path: string, op: string, versionId: string | null) => log.push({ ev: log.length + 1, seq, path, op, versionId });
function write(path: string, op: string, size: number | null, ts: number, content?: Uint8Array<ArrayBuffer>, restoredFrom: string | null = null) {
  seq++;
  const key = path.replace(/\/$/, "");
  const version: Version = { versionId: id(), op, size, seq, ts, actor: "preview-user", restoredFrom, content };
  const versions = [...(history.get(key) ?? []), version];
  history.set(key, versions);
  if (op === "delete") nodes.delete(key); else nodes.set(key, { type: path.endsWith("/") ? "folder" : "file", versions, mtimeMs: ts });
  record(path, op, version.versionId);
  return version;
}
function seed() {
  if (nodes.size) return;
  for (const folder of ["Brand assets/", "Brand assets/Logos/", "Product explorations/", "Website/", "Website/Archive/"]) write(folder, "mkdir", 0, now - 30 * 24 * HOUR);
  write("Launch checklist.md", "put", 3890, now - 9 * 24 * HOUR, text(checklist.slice(0, 120)));
  write("Launch checklist.md", "put", 4310, now - 3 * 24 * HOUR, text(checklist.slice(0, 190)));
  write("Launch checklist.md", "put", text(checklist).length, now - 26 * HOUR, text(checklist));
  write("Orbit — design guidelines.pdf", "put", 12_981_600, now - 6 * 24 * HOUR);
  write("Orbit mark.svg", "put", text(logo).length, now - 2 * HOUR, text(logo));
  write("Q4 budget.xlsx", "put", 48_112, now - 50 * HOUR);
  write("Walkthrough draft.mov", "put", 734_003_200, now - 12 * 24 * HOUR);
  write("Brand assets/Palette.png", "put", 284_100, now - 4 * 24 * HOUR);
  write("Brand assets/Logos/Orbit mark.svg", "put", text(logo).length, now - 5 * 24 * HOUR, text(logo));
  write("Website/Homepage copy.md", "put", 2210, now - 8 * 24 * HOUR, text("# Homepage\n\nYour files, in Finder and everywhere else.\n"));
  write("Old moodboard.png", "put", 1_204_000, now - 20 * 24 * HOUR);
  write("Old moodboard.png", "delete", null, now - 28 * HOUR);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const head = (key: string) => nodes.get(key)?.versions.at(-1);
const entry = (key: string, node: Node) => ({ path: key + (node.type === "folder" ? "/" : ""), type: node.type, versionId: node.versions.at(-1)!.versionId, size: node.versions.at(-1)!.size ?? 0, contentType: null, mtimeMs: node.mtimeMs, seq: node.versions.at(-1)!.seq });
async function sha(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function children(folder: string) {
  return [...nodes].filter(([key]) => key.startsWith(folder) && !key.slice(folder.length).includes("/"));
}
function apply(op: Record<string, unknown>): Response | { path: string; versionId: string; size: number } {
  const path = String(op.path ?? op.from);
  const key = path.replace(/\/$/, "");
  const current = head(key);
  if (op.ifAbsent && current) return json({ error: "precondition_failed", path }, 412);
  if (op.ifVersion && current?.versionId !== op.ifVersion) return json({ error: "precondition_failed", path }, 412);
  if (op.op === "mkdir") return { path, versionId: (current ?? write(path, "mkdir", 0, Date.now())).versionId, size: 0 };
  if (op.op === "put") return { path, versionId: write(path, "put", Number(op.size), Date.now()).versionId, size: Number(op.size) };
  if (!current) return json({ error: "no_such_path", path }, 404);
  if (op.op === "delete") {
    for (const [child] of [...nodes]) if (child.startsWith(`${key}/`)) nodes.delete(child);
    return { path, versionId: write(path, "delete", null, Date.now()).versionId, size: 0 };
  }
  const to = String(op.to).replace(/\/$/, "");
  if (nodes.has(to)) return json({ error: "path_conflict", path: String(op.to) }, 409);
  if (to.startsWith(`${key}/`)) return json({ error: "bad_request", message: "ops[0]: cannot rename a folder into itself" }, 400);
  seq++;
  for (const [child, node] of [...nodes]) {
    if (child !== key && !child.startsWith(`${key}/`)) continue;
    nodes.delete(child); nodes.set(to + child.slice(key.length), node);
    history.set(to + child.slice(key.length), history.get(child) ?? []); history.delete(child);
  }
  record(path, "delete", null); record(String(op.to), "rename", current.versionId);
  return { path: String(op.to), versionId: current.versionId, size: current.size ?? 0 };
}

/** The first page a files view opens on, or undefined for views this fixture does not own. */
export function filesRoute(view: string): string | undefined {
  if (!view.startsWith("files-")) return undefined;
  return view === "files-readonly" ? "/drives/archive/" : view === "files-details" ? "/drives/design/?file=Launch%20checklist.md" : "/drives/design/";
}
/** Answers data-plane requests (and the plan lookup for the expired view); undefined lets the shared fixture answer. */
export async function filesFixture(view: string, url: URL, init?: RequestInit): Promise<Response | undefined> {
  if (!view.startsWith("files-")) return undefined;
  const expired = view === "files-expired";
  if (url.pathname === "/me/access" && expired)
    return json({ user: { id: "preview-user", email: "alex@example.com" }, workspaces: [{ id: "studio", name: "Studio workspace", role: "owner", tier: "teams", state: "expired", trialPending: false, trialEndsAt: now - 24 * HOUR, writable: false, storageReady: true, quotaBytes: 1024 ** 4, usedBytes: 128 * 1024 ** 3 }] });
  const match = url.pathname.match(/\/fixture-data\/v0\/drives\/[^/]+\/(.+)$/);
  if (!match) return undefined;
  seed();
  const rest = match[1];
  const param = (name: string) => url.searchParams.get(name) ?? "";
  const key = param("path").replace(/\/$/, "");
  const body = () => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  if (rest === "list") {
    if (key && nodes.get(key)?.type !== "folder") return json({ error: "no_such_path", path: param("path") }, 404);
    return json({ entries: children(key ? `${key}/` : "").map(([child, node]) => ({ ...entry(child, node), name: child.split("/").pop() })).sort((a, b) => a.name!.localeCompare(b.name!)), cursor: null });
  }
  if (rest === "stat") {
    const node = nodes.get(key);
    return node ? json(entry(key, node)) : json({ error: "no_such_path", path: param("path") }, 404);
  }
  if (rest === "search") {
    const needle = param("q").toLowerCase();
    return json({ entries: [...nodes].filter(([child]) => child.split("/").pop()!.toLowerCase().includes(needle)).map(([child, node]) => entry(child, node)), cursor: null });
  }
  if (rest === "versions") return json({ versions: (history.get(key) ?? []).map(({ content: _content, ...version }) => version), cursor: null });
  if (rest === "changes") {
    const after = Number(param("after"));
    return json({ changes: log.filter((change) => change.ev > after).slice(0, 1000), headSeq: seq, lastEv: log.length, more: false });
  }
  if (rest === "tree-at") return json({ entries: [], cursor: null });
  if (rest === "manifest") {
    const versions = history.get(key) ?? [];
    const version = param("versionId") ? versions.find((item) => item.versionId === param("versionId")) : versions.at(-1);
    if (!version?.content) return json({ error: "preview_only", message: "This sample file has no contents to download." }, 501);
    const hash = await sha(version.content);
    blobs.set(hash, version.content);
    return json({ path: key, versionId: version.versionId, size: version.content.length, contentType: "application/octet-stream", mtimeMs: version.ts, shards: [{ h: hash, n: version.content.length }] });
  }
  if (rest === "shards/missing") return json({ missing: (body().hashes as string[]) ?? [] });
  if (rest.startsWith("shards/")) {
    if (init?.method === "PUT") { await new Promise((resolve) => setTimeout(resolve, 500)); return json({ stored: true }); }
    const bytes = blobs.get(rest.slice(7));
    return bytes ? new Response(bytes) : json({ error: "no_such_shard" }, 404);
  }
  if (expired && init?.method === "POST") return json({ error: "over_quota" }, 403);
  if (rest === "commit") {
    const results = [];
    for (const op of body().ops as Record<string, unknown>[]) {
      const result = apply(op);
      if (result instanceof Response) return result;
      results.push(result);
    }
    return json({ seq, results });
  }
  if (rest === "restore") {
    const { path, versionId, ifVersion, ifAbsent } = body() as { path: string; versionId: string; ifVersion?: string; ifAbsent?: boolean };
    const source = (history.get(path) ?? []).find((item) => item.versionId === versionId);
    const current = head(path);
    if (!source || source.size === null) return json({ error: "no_such_version", path }, 404);
    if ((ifAbsent && current) || (ifVersion && current?.versionId !== ifVersion)) return json({ error: "precondition_failed", path }, 412);
    const version = write(path, "restore", source.size, Date.now(), source.content, source.versionId);
    return json({ seq, results: [{ path, versionId: version.versionId, size: source.size }] });
  }
  return undefined;
}
