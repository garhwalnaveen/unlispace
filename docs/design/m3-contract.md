# M3 contract: forks, drive registry, real S3 keys, quotas, CLI parity

Status: normative for wave 14–20 · 2026-10-25. Extends `m1-contract.md` and `cloud/api/M2-API.md`.
Reference behaviour is Space's public protocol v1 (`docs.spacefs.com/llms-full.txt`, §1–§9). We
keep its semantics under our own prefix: every `x-s3sdk-*` name becomes `x-uls-*`, `/_s3sdk/` becomes
`/_uls/`. Where we deliberately differ it says **Differs**.

## 1. Identity of a drive

- `driveId` = `d-` + lowercase ULID (unchanged). Always accepted wherever a bucket is named.
- `alias` (new) = S3 bucket name, unique among non-deleted drives of one org. Rule:
  `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`, and it must not match `^d-[0-9a-z]{26}$` (reserved for ids).
  A bucket string that matches the id pattern is resolved as an id, otherwise as an alias in the
  key's org.
- `displayName` = the existing `name` column. Default for S3-created drives: the alias.
- Existing drives get `alias = NULL` until renamed; API `POST /orgs/{id}/drives` accepts `alias?`
  and otherwise derives one from the name (lowercase, non-alnum → `-`, trimmed, numeric suffix
  `-2`, `-3`… on collision; fall back to the id when nothing usable remains).

## 2. Lineage and forks (data plane)

- Every DriveAuthority stores in `meta`: `lineage` (default: its own driveId, so all existing
  drives are unchanged), `forkOf` (`{driveId, seq, ts}` or absent), `depth` (0 for roots).
- R2 keys use the lineage: `shards/{lineage}/{sha}`, `manifests/{lineage}/{sha}`. The signed block
  route is `GET /_blocks/{lineage}/{sha}?d=<drive>&exp=<s>&sig=<hmac>`; it serves only if the
  token-less signature verifies **and** `<drive>`'s lineage equals `{lineage}` (sig covers both).
- **Fork** copies DO state only, never bytes. The child imports, at the parent's current `seq`:
  nodes, heads, every version row reachable from the imported heads' paths (so history before the
  fork point is readable in the child), and `shards_known` (rows marked `inherited = 1`). Large
  trees move in pages over RPC. The child's own change log starts at `seq = parent seq` with one
  synthetic `resync` boundary; watchers of the child never see parent writes after the fork.
- Afterwards writes to either side are invisible to the other. Child `lineage` = parent `lineage`,
  `depth` = parent depth + 1, max depth **8** → `400 fork_depth_exceeded`.
- A fork holds every write the parent acknowledged before the call (the DO serialises the export
  behind in-flight commits). If the export cannot start within 60 s → `503 slow_down`.
- `ownBytes` of a drive = sum of `n` over shards referenced by any retained version of this drive
  and **not** inherited. `logicalBytes` = current-head bytes (today's `bytes`). Billing uses
  `ownBytes` so a fork is free until it diverges.
- **GC**: a shard may be deleted only if no live drive in its lineage references it. A lineage
  with more than one live member must never be swept by a single drive's local mark. The root
  DO keeps the member list (`lineage_members(drive_id, added_at, removed_at)`), updated by
  `forkDrive` / hard delete. Sweep stays dry-run by default.

### 2.1 `DataPlaneAdmin` RPC (service binding, `cloud/data-plane/src/index.ts`)

```ts
createDrive(driveId: string, placement?: Placement): Promise<{driveId, placement, createdAt}>   // unchanged
forkDrive(sourceId: string, newId: string): Promise<{driveId, sourceId, lineage, forkSeq: number, forkPoint: number /*ms*/, placement}>
deleteDrive(driveId: string, opts?: {hard?: boolean}): Promise<{ok: true}>   // soft = current behaviour; hard drops DO state + leaves shards to lineage GC
driveStats(driveId: string): Promise<{headSeq, fileCount, bytes /*= logicalBytes*/, ownBytes, lineage, depth, forkOf: {driveId, forkPoint /*ms*/} | null} | null>
```
Errors are thrown `Error`s with a string `code`: `no_such_drive` (404), `drive_exists` (409, the
existing `DriveExistsError`), `fork_depth_exceeded` (400), `slow_down` (503).
The child is created with the parent's placement (location hint); a placement argument is ignored.

### 2.2 Browser access to `/v0` and `/_blocks`
CORS with an exact allowlist from env `ULS_WEB_ORIGINS` (comma-separated). `OPTIONS` preflight,
methods `GET, POST, PUT`, headers `Authorization, Content-Type`, `Vary: Origin`, on every response
including errors. No wildcard, no credentials.

## 3. Control plane (`cloud/api`)

### 3.1 Migration `0003_m3.sql`
`drives` gains `alias TEXT`, `forked_from TEXT`, `fork_point INTEGER`, `lineage TEXT`; partial unique
index `(org_id, alias) WHERE status != 'deleted' AND alias IS NOT NULL`. New table
`drive_usage(drive_id TEXT PRIMARY KEY, logical_bytes INTEGER NOT NULL, own_bytes INTEGER NOT NULL, measured_at INTEGER NOT NULL)`.

### 3.2 Public routes (bearer session, JSON)
- `Drive` JSON gains `alias`, `forkOf: {driveId, forkPoint} | null`, `forks: string[]` (live child
  ids), `usageBytes` (= last measured `own_bytes`, 0 if never measured).
- `POST /drives/{id}/fork` `{name?, alias?}` → `201 Drive`. Owner/admin of the source's org. The
  individual tier's one-drive limit counts **root** drives only; forks are limited to 50 live per
  org (`403 {"error":"plan_limit"}`).
- `DELETE /drives/{id}?hard=1` → `409 {"error":"drive_has_forks"}` while a live fork exists;
  otherwise hard-deletes. Plain `DELETE` stays soft.
- `PATCH /drives/{id}` accepts `alias` too (409 `alias_taken`).

### 3.3 Internal entrypoint `ControlPlane` (named `WorkerEntrypoint` export, for the S3 gateway)
All methods take the **access key id** of an already SigV4-verified request except `resolveKey`.
Key access is capped by the key, its ancestors, and the owner's current role (as `resolveAccessKey`
already does). Errors: thrown `Error` with `code` ∈ `no_such_bucket` (also used for "not visible to
this key", never 403), `access_denied`, `bucket_exists`, `drive_has_forks`, `invalid_argument`,
`plan_limit`, `over_quota`, `fork_depth_exceeded`, `slow_down`.

```ts
resolveKey(accessKeyId): Promise<{accessKeyId, orgId, userId, access: "read"|"write"|"admin", drives: string[] | null, secretAccessKey, parent: string | null} | null>
recordKeyUse(accessKeyId): Promise<void>                       // call only after SigV4 + authorization passed
listDrives(accessKeyId): Promise<BucketInfo[]>                 // drives this key reaches
resolveBucket(accessKeyId, bucket): Promise<BucketInfo>        // alias or id
createDrive(accessKeyId, {alias, displayName?, placement?}): Promise<BucketInfo>          // admin
forkDrive(accessKeyId, {source: string /*bucket*/, alias}): Promise<BucketInfo & {forkPoint: number}>  // admin, source must be reachable
deleteDrive(accessKeyId, bucket, {hard}): Promise<void>        // admin
describeDrive(accessKeyId, bucket): Promise<{driveId, alias, displayName, createdAt /*ISO*/, forkOf: {driveId, forkPoint /*ISO*/} | null, forks: string[], usageBytes}>
mintChildKey(accessKeyId, {drives: string[], access?, label?}): Promise<{key: Key, secretAccessKey}>   // Space §9.2 rules 1–3
mintMountToken(accessKeyId, bucket): Promise<{driveId, alias, displayName, workspaceId, canWrite, endpoint, token, expiresAt /*ms*/}>
// BucketInfo = {driveId, alias, displayName, placement, createdAt /*ms*/, access /*effective*/, writable /*false when over quota or read access*/}
```
Child keys appear in `GET /keys` with `parent`; revoking a key revokes descendants (exists).

### 3.4 Metering and quota
- `scheduled` cron `"17 * * * *"` (hourly): for each live drive, `DATA_PLANE.driveStats` →
  upsert `drive_usage`. Bounded batch per run (≤ 500 drives, oldest `measured_at` first).
- Org `usedBytes` = sum of `own_bytes` over live drives; `GET /orgs/{id}/billing` reports it.
- Over quota (`usedBytes > quotaBytes`) or not entitled: `POST /drives/{id}/token` with write →
  `403 {"error":"over_quota"}` (read still allowed); `BucketInfo.writable = false`; the gateway
  answers writes with S3 `403 QuotaExceeded`. Deleting data never requires quota.

## 4. S3 gateway (`cloud/s3-gateway`)

- Keys come from `ControlPlane` (service binding `CONTROL_PLANE`, entrypoint `ControlPlane`).
  `MemoryKeyResolver` stays for tests only. Resolution results may be cached per isolate ≤ 30 s.
- Every response carries `x-uls-protocol: 1`.
- Buckets: alias or id (§1). `ListBuckets` = `listDrives`. `CreateBucket` = create, with
  `x-uls-display-name`, `x-uls-placement` (wnam enam weur eeur apac oc; `sam`→`enam`, `afr`→`weur`,
  `me`→`eeur`; else `400 InvalidArgument`), or fork with `x-uls-fork-source: <bucket>` (response
  headers `x-uls-drive-id`, `x-uls-fork-source-id`, `x-uls-fork-point` RFC 3339).
  `DeleteBucket` soft-deletes without requiring an empty drive (**matches Space**, replaces
  today's `BucketNotEmpty`); `x-uls-hard-delete: true` → hard (`409 DriveHasForks`).
- `GET /{bucket}?x-uls-drive` → describe JSON (§3.3).
- `GET /{bucket}?x-uls-mount` → `mintMountToken` JSON. **Differs:** we hand out a 15-min
  drive-scoped data-plane token + endpoint, never raw R2 credentials.
- `x-uls-consistent: true` is accepted on reads (always consistent through the drive DO).
- `GET ?x-uls-versions` orders **oldest → newest** with `operation` and `restoredFrom`, and omits
  metadata-only rename versions (Space §4.3). ListObjectVersions unchanged.
- Key routes (JSON, errors `{"error": "..."}`):
  - `GET/POST /_uls/keys`, `DELETE /_uls/keys/{id}` with a session bearer in
    `x-uls-login-authorization` or `authorization: Bearer` → forwarded to the API's `/keys`.
  - `POST /_uls/keys` signed with SigV4 → `mintChildKey`. `x-amz-content-sha256` must be the real
    body digest; `UNSIGNED-PAYLOAD`, presigned, or mismatch → `400`.

## 5. Desktop and CLI (`engine/`)

### 5.1 Daemon socket additions (append to `mac/DAEMON-PROTOCOL.md` at integration)
| method | params | result |
|---|---|---|
| `drive.mount` | `{"driveId": str, "mountpoint"?: str, "readOnly"?: bool}` | `{"mountpoint": str}` |
| `mounts.list` | none | `{"mounts": [{"driveId", "mountpoint", "readOnly", "adapter": "smb"\|"nfs"}]}` |
| `drive.pin` | `{"driveId": str, "path": str, "pinned": bool}` | `{}` keep-offline: prefetch and exempt from LRU |
| `pins.list` | `{"driveId"?: str}` | `{"pins": [{"driveId", "path", "bytes", "cachedBytes"}]}` |
| `uploads` | none | `{"pending": [{"driveId", "path", "bytes"}], "journalBytes", "journalCapBytes"}` |

Event `pin` `{"driveId", "path", "cachedBytes", "bytes"}` during prefetch. Mounts the daemon owned
are remembered in its state file and re-mounted on start. When the journal is over
`journalCapBytes` (default 10 GiB, `config.set journalCapBytes`) writes return ENOSPC and the
daemon emits `state` with message `journal_full`.

### 5.2 `uls` CLI (Space CLI parity; one binary, current flags keep working)
`uls drives` · `uls use <workspace>` · `uls mount <drive> [mountpoint] [--read-only] [--foreground]`
(via the daemon unless `--foreground`; `<drive>` = name, `workspace/name`, alias or id, matched
case-insensitively, ambiguity lists choices; default mountpoint `~/Unlispace/<Name>`) · `uls mounts` ·
`uls unmount <drive|mountpoint>` · `uls status` · `uls uploads [--watch]` · `uls pin|unpin <drive> <path>` ·
`uls history <drive> <path>` · `uls show <drive> <path> [--at <rfc3339> | --version <id>]` ·
`uls restore <drive> <path> (--at <rfc3339> | <versionId>)` (a folder path restores the subtree as
of that instant, one commit) · `uls fork <drive> <new-name>` · `uls keys [list|create|revoke]` ·
`uls daemon start|stop|status`. `--json` on every read command.
