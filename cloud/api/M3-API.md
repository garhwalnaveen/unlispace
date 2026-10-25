# M3 control plane

Extends [M2-API.md](M2-API.md); `docs/design/m3-contract.md` is normative.
Apply `migrations/0003_m3.sql` after migrations 0001 and 0002.

## Drives and aliases

Drive JSON retains all M1 fields and adds `alias: string | null`,
`forkOf: {driveId, forkPoint} | null`, `forks: string[]` (live immediate children),
and `usageBytes` (last measured owned bytes, initially zero). Public timestamps are milliseconds.
Existing drives, including the automatically provisioned Space drive, remain addressable by ID
with a null alias until renamed. Explicit drive creation derives an alias when omitted.

- `POST /orgs/{id}/drives` accepts `{name, alias?, placement?}`. Aliases are unique among
  live drives in the org. They match `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`; ID-shaped
  names (`d-` plus 26 lowercase alphanumerics) are reserved. Invalid aliases return
  `400 invalid_argument`; collisions return `409 alias_taken`.
- Derived aliases lowercase the name, replace nonalphanumerics with `-`, trim separators,
  cap at 63 characters, and append `-2`, `-3`, etc. for collisions. Names yielding fewer
  than three characters or a reserved ID shape fall back to the new drive ID. This is
  the contract's intentional exception to the explicit alias validation rule.
- `PATCH /drives/{id}` accepts `{name?, alias?}`, with at least one field required.
  Renaming a legacy drive derives its first alias; a name-only update preserves an existing alias.
- `POST /drives/{id}/fork` accepts `{name?, alias?}` and returns `201 Drive`. Default name
  is the source name. Owner/admin only; source must be ready. The data plane snapshots the source,
  supplies lineage, placement and fork point, and enforces depth 8. Depth 9 returns
  `400 fork_depth_exceeded`; export contention returns `503 slow_down`. Failed fork reservations
  are removed from D1, releasing the alias and plan slot.
- Individual allows one live **root**, independent of forks. All orgs allow at most 50 live
  forks total. Limits use conditional SQL inserts; exceeding either returns `403 plan_limit`.
- `DELETE /drives/{id}` stays soft, including best-effort data-plane deletion after hiding
  the D1 row. `?hard=1` requires no live immediate children (`409 drive_has_forks`) and calls
  the hard-delete RPC before marking the D1 row deleted. Deletion requires management access,
  with no quota or entitlement check.

## Internal `ControlPlane` service entrypoint

Bind the gateway's `CONTROL_PLANE` service to `unlispace-api`, entrypoint `ControlPlane`.
This is a named `WorkerEntrypoint` export; no public secret lookup HTTP route exists.
Every call resolves the access key against D1 again, checking all ancestor revocations,
workspace membership, key access levels, current roles, and intersected drive scopes.

| Method | Result / behavior |
| --- | --- |
| `resolveKey(id)` | `{accessKeyId, orgId, userId, access, drives, secretAccessKey, parent}` or null for invalid/revoked/membership-removed keys. |
| `recordKeyUse(id)` | Rechecks validity, updates last-use monotonically; call after SigV4 and authorization pass. |
| `listDrives(id)` | Reachable live `BucketInfo[]`. |
| `resolveBucket(id,bucket)` | `BucketInfo`; ID-pattern inputs resolve as IDs, all others as aliases in the key's org. Hidden/missing buckets return `no_such_bucket`. |
| `createDrive(id,{alias,displayName?,placement?})` | Admin, workspace-wide key only; returns `BucketInfo`. Scoped admin keys cannot create outside their reach. |
| `forkDrive(id,{source,alias})` | Admin and reachable source; returns `BucketInfo & {forkPoint}` (milliseconds). Source placement is inherited. |
| `deleteDrive(id,bucket,{hard})` | Admin; same soft/hard semantics as HTTP, returns void. |
| `describeDrive(id,bucket)` | `{driveId,alias,displayName,createdAt,forkOf,forks,usageBytes}`, with ISO creation/fork timestamps. |
| `mintChildKey(id,{drives,access?,label?,workspaceId?,orgId?})` | `{key: Key,secretAccessKey}`; same user/workspace, parent recorded. Drives required, unique, nonempty, at most 100, and live reachable IDs. Access defaults to effective parent access and cannot rise. An explicitly different workspace is refused. |
| `mintMountToken(id,bucket)` | `{driveId,alias,displayName,workspaceId,canWrite,endpoint,token,expiresAt}`. Reuses the existing drive-scoped 15-minute token minter; no raw storage credentials. Over-quota or expired entitlement produces a read-only mount token. |

`BucketInfo` is `{driveId,alias,displayName,placement,createdAt,access,writable}`; creation time
is milliseconds and `access` is the key's effective access. `writable` is false for read access,
expired entitlement, or usage strictly above quota. Child keys appear in `GET /keys` with
`parent`; revoking any ancestor invalidates its descendants transitively.

RPC errors are thrown Errors with `code`; HTTP drive collisions `alias_taken` map to
`bucket_exists`, malformed arguments to `invalid_argument`, management denials to
`access_denied`, and missing/invisible drives to `no_such_bucket`. Plan/depth/slow-down,
quota and fork-deletion errors preserve their M3 codes. Missing key-master configuration
remains a service configuration error, never an invalid-key result.

## Metering and quotas (supersedes M2 entitlement/usage text)

Local/default and production Wrangler config schedule `17 * * * *`. Each invocation selects
at most 500 live drives, oldest measurement first (never-measured first), and upserts
`drive_usage` from `DATA_PLANE.driveStats`: logical head bytes in `logical_bytes`, retained
noninherited bytes in `own_bytes`. Null stats are skipped; upstream/invalid measurement errors
fail the invocation without overwriting that drive's previous measurement.

Org billing `usedBytes` sums measured `own_bytes` over live drives, not logical bytes or
live RPC estimates. Unmeasured drives contribute zero. `Drive.usageBytes` uses that same
measurement. Failed metering retains the last value. This makes quota enforcement hourly;
issued tokens retain their existing lifetime.

Write-token requests when expired/not entitled or strictly over quota return
`403 {"error":"over_quota"}`. Explicit reads and viewer-capped grants remain available;
usage exactly equal to quota allows writes. Gateway writes must respect `BucketInfo.writable`
and return S3 `403 QuotaExceeded` when it is false due to quota/entitlement.
