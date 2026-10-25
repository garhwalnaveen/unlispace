# M0 wire contract (cloud ⇄ engine)

Status: frozen for M0 · 2026-10-25. Both `cloud/data-plane/` and `engine/` implement this exactly.
Any change goes through this file first.

M0 is a spike. Auth is a single static bearer token (`ULS_DEV_TOKEN`) so the storage path can be
proven end to end. Real auth, scopes, SigV4 and the S3 subset come in M1/M2.

## 1. Constants

| Name | Value |
|---|---|
| Chunker | FastCDC **2020** (normalization level 1), min 262144, avg 2097152, max 16777216 bytes |
| Shard hash | SHA-256 of the shard bytes, lowercase hex (64 chars) |
| Empty file | manifest with `shards: []`, `size: 0` |
| Max shard upload body | 16 MiB |
| Max commit body | 1 MiB JSON |
| Lineage | for M0, `lineage = driveId` |

**Golden vector.** Both sides MUST pass this. Generate the input as bytes `b[i] = (i * 2654435761 >> 13) & 0xff` for `i in 0..33554432` (32 MiB, u64 arithmetic, wrap on 64 bits). The expected chunk boundaries are produced by the Rust `fastcdc` crate v3 (`fastcdc::v2020::FastCDC::new(data, 262144, 2097152, 16777216)`), with the chunk lengths and SHA-256 stored in `engine/uls-chunk/tests/golden.json`. A TypeScript port in the Worker must produce identical output; it is only used for server-side chunking of plain PUTs in M1.

## 2. Auth (M0)

Every request carries `Authorization: Bearer <ULS_DEV_TOKEN>`; a missing or wrong token gets `401 {"error":"unauthorized"}`. `/healthz` is exempt.

## 3. Endpoints

Base URL: the Worker URL (local: `http://127.0.0.1:8787`). Errors are JSON `{"error": "<code>", "message"?: string, ...}`.

### 3.1 Drives

`PUT /v0/drives/{driveId}` with body `{"placement"?: "wnam"|"enam"|"weur"|"eeur"|"apac"|"oc"}` returns `201 {"driveId","placement","createdAt"}`, or `409 {"error":"drive_exists"}`.
`driveId`: `[a-z0-9][a-z0-9-]{2,62}`. The DO is addressed by `idFromName(driveId)`, with the `locationHint` set from `placement` on first access.

`GET /v0/drives/{driveId}` returns `200 {"driveId","placement","createdAt","headSeq","fileCount","bytes"}`, or `404 {"error":"no_such_drive"}`.

### 3.2 Shards

`POST /v0/drives/{driveId}/shards/missing` with body `{"hashes": ["<hex>", ...]}` (≤ 1000) returns `200 {"missing": ["<hex>", ...]}`.

`PUT /v0/drives/{driveId}/shards/{hash}` sends the raw shard bytes with `Content-Length` and returns `201 {"hash","size","stored":true}` if new, or `200 {"hash","size","stored":false}` if it already existed.
- The server streams the body through `crypto.DigestStream("SHA-256")` while writing to R2 key `shards/{lineage}/{hash}` with `onlyIf: { etagDoesNotMatch: "*" }`.
- If the computed hash ≠ `{hash}`, it deletes what it wrote (only if it created it) and returns `400 {"error":"hash_mismatch"}`.
- A body over 16 MiB gets `413 {"error":"too_large"}`.
- After a successful store, the server records the hash in the DO's `shards_known` table.

`GET /v0/drives/{driveId}/shards/{hash}` returns `200` with the bytes, `Cache-Control: public, max-age=31536000, immutable`, and `ETag: "<hash>"`. It supports a single `Range: bytes=a-b` (returns 206). Missing shards get `404`.
- In M0 the bearer is still required; in M1 it moves to `/_blocks/` with an HMAC query token so it can be edge-cached.

### 3.3 Commit

`POST /v0/drives/{driveId}/commit`:

```json
{
  "ops": [
    {
      "op": "put",
      "path": "cuts/a.mov",
      "ifVersion": "v_…" | null,
      "ifAbsent": false,
      "size": 67108864,
      "contentType": "video/quicktime",
      "mtimeMs": 1792911671000,
      "shards": [{"h": "<hex>", "n": 2097152}, ...]
    },
    { "op": "mkdir", "path": "cuts/" },
    { "op": "delete", "path": "old.txt", "ifVersion": "v_…" | null },
    { "op": "rename", "from": "cuts/", "to": "archive/cuts/", "ifVersion": null }
  ]
}
```

Rules:
- `ops` has 1..=1000 entries and is applied **atomically**: all succeed or none do. One commit gives one `seq`, and every op gets its own new version id.
- Paths: no leading `/`, segments not empty, not `.` or `..`, ≤ 1024 bytes UTF-8, and no NUL. A folder path ends with `/`.
- `put` creates missing parent folders. A file and a folder can't share a path: `409 path_conflict`.
- `sum(shards.n) == size` must hold, otherwise `400 bad_manifest`.
- Every shard hash must be in `shards_known`, or exist in R2 (checked with HEAD in a batch), otherwise `409 {"error":"missing_shards","hashes":[...]}`.
- Preconditions:
  - `ifVersion` must equal the current head version id of that path.
  - `ifAbsent: true` means the path must not exist.
  - Failure returns `412 {"error":"precondition_failed","path","currentVersionId": string|null}`.
- `rename` moves a file or a whole folder subtree. It is metadata-only, and the destination must not exist.

Response `200`:

```json
{ "seq": 42, "results": [ { "path": "cuts/a.mov", "versionId": "v_…", "size": 67108864 } ] }
```

Version ids look like `v_` + 26-char ULID. Clients treat them as opaque.

### 3.4 Read metadata

`GET /v0/drives/{driveId}/stat?path=<p>` returns `200 {"path","type":"file"|"folder","versionId","size","contentType","mtimeMs","seq"}`, or `404 {"error":"no_such_path"}`.

`GET /v0/drives/{driveId}/list?path=<folder/>&cursor=<c>&limit=<≤1000>` returns `200 {"entries":[{"name","type","versionId","size","mtimeMs"}],"cursor": string|null}`, sorted by name using bytewise UTF-8 order. The root is `path=` (empty).

`GET /v0/drives/{driveId}/manifest?path=<p>[&versionId=<v>]` returns `200 {"path","versionId","size","contentType","mtimeMs","shards":[{"h","n"}]}`.

`GET /v0/drives/{driveId}/versions?path=<p>` returns `200 {"versions":[{"versionId","op","size","seq","ts","actor"}]}`, oldest first.

`POST /v0/drives/{driveId}/restore` with body `{"path","versionId","ifVersion"?}` returns the same shape as commit. It creates a new head version with the old manifest.

### 3.5 Changes

**Amended 2026-10-25 (review finding: seq-only pagination dropped events).** Every log entry gets
`ev`, an integer event id that is unique and strictly increasing per drive (the log rowid). One
commit (`seq`) can produce many events, for example auto-created parents or folder moves.

`GET /v0/drives/{driveId}/changes?after=<ev>&limit=<≤1000>` returns
`200 {"changes":[{"ev","seq","path","op","versionId"|null}],"headSeq","lastEv","more":bool}`.
`after` is exclusive. Pages are cut by `ev`, so a commit larger than `limit` spans pages without
losing anything. `since=<seq>` is still accepted, meaning "events of commits with seq > since"; it
is equivalent to `after = <last ev of commit seq>`.

`GET /v0/drives/{driveId}/watch?after=<ev>` (or `since=<seq>`) is a **WebSocket upgrade**. The bearer can be passed as `?token=`, because browsers can't set headers on a WebSocket; header auth is also accepted.
- The server returns `101` promptly, then replays events after the cursor in bounded batches, with the replay cursor stored per socket.
- Live events for that socket are queued behind the replay, so they can never overtake it.
- Each event is `{"type":"change","ev","seq","path","op","versionId"}`.
- The server sends `{"type":"ping"}` every 30 s, and clients reply `{"type":"pong"}`. The DO uses the hibernation API (`ctx.acceptWebSocket`).
- Clients persist the last `ev` they processed and reconnect with `after=<ev>`.
- If the backlog exceeds 100,000 events, the server sends `{"type":"resync","headSeq","lastEv"}` and closes. The client then re-lists from scratch and resumes from `lastEv`.

### 3.6 Amendments from review (2026-10-25)
- `GET /versions` takes `cursor` and `limit` (≤ 1000, default 1000) and returns `{"versions":[…],"cursor":string|null}`, oldest first. History is never silently truncated.
- `mkdir` on an existing folder is **idempotent**. It returns the existing versionId and creates no version or log entry. This overrides "every op gets its own new version id" for that case only.
- Every path a commit *produces* must also meet the §3.3 path rules, including descendants of a folder rename. If any would be over 1024 bytes, the whole commit fails with `400 {"error":"path_too_long","path"}`.
- Paths must be well-formed Unicode; lone surrogates get `400 bad_path`.
- JSON bodies are read as a stream with a byte cap, never buffered whole. Going over the cap gives `413 too_large`.
- Folder delete and rename are limited to subtrees of ≤ 100,000 nodes per commit. Larger subtrees get `400 {"error":"subtree_too_large","limit":100000}`. M1's node-id tree makes these operations constant-time and removes the limit.

## 4. DO storage (SQLite) — reference schema

```sql
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE nodes(path TEXT PRIMARY KEY, type TEXT NOT NULL, head TEXT, size INTEGER, ctype TEXT, mtime INTEGER, seq INTEGER);
CREATE TABLE versions(id TEXT PRIMARY KEY, path TEXT NOT NULL, op TEXT NOT NULL, size INTEGER, manifest TEXT, seq INTEGER NOT NULL, ts INTEGER NOT NULL, actor TEXT);
CREATE INDEX versions_path ON versions(path, seq);
CREATE TABLE log(seq INTEGER NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL, version TEXT);
CREATE INDEX log_seq ON log(seq);
CREATE TABLE shards_known(h TEXT PRIMARY KEY, n INTEGER NOT NULL);
```

This is path-keyed for M0, so a folder rename rewrites its subtree's rows. That's acceptable for the spike; the node-id tree described in the design doc §3.1 lands in M1.

The manifest is stored inline as JSON, compact `[[h,n],...]`. Manifests larger than 1 MiB go to R2 at `manifests/{lineage}/{sha256}`, with `manifest = "r2:<sha>"`.

## 5. M0 acceptance

1. `engine` CLI: `uls put <drive> <local-file> <path>`, `uls get <drive> <path> <local-file>`, `uls ls`, `uls versions`, `uls restore`, and `uls watch <drive>`. Run against `wrangler dev` (local R2 + DO), a 200 MiB file round-trips byte-identical.
2. Re-uploading the same file sends zero shard bytes. Changing 4 KiB in the middle re-uploads ≤ 2 shards.
3. Two concurrent `put` with the same `ifVersion`: exactly one 200 and one 412.
4. `uls watch` in terminal A prints a change within 1 s of a commit made from terminal B.
5. `ulsd mount <drive> <mountpoint>` serves a read-only NFSv3 loopback mount on macOS. In it, `cat`, `cp`, `shasum` and Finder Quick Look of a 200 MiB file work, and the first byte arrives without downloading the whole file.
