# Daemon control protocol (app <-> `ulsd`)

Version 0. The Rust daemon implements the server; `Orbit.app` is the client
(`Sources/OrbitKit/DaemonProtocol.swift`, `UnixSocketDaemonClient.swift`).

## Transport
- Unix domain socket, `SOCK_STREAM`, at `~/Library/Application Support/Orbit/ulsd.sock`.
- Directory mode `0700`, socket mode `0600`. The server should verify the peer is the same uid
  (`LOCAL_PEERCRED` / `getpeereid`) and reject others.
- Framing: UTF-8 JSON objects, one per line, terminated by `\n`. No pretty-printing; objects must
  not contain raw newlines. Either side ignores empty lines.
- Multiple clients may connect. Events are broadcast to every connected client.
- Tokens must never appear in responses, events, or logs.

## Requests (client -> server)
```
{"id": <int>, "method": "<name>", "params": { ... }}     // params optional
```
`id` is chosen by the client and echoed in the response. Requests may be pipelined; responses may
arrive out of order.

## Responses (server -> client)
```
{"id": <int>, "result": { ... }}
{"id": <int>, "error": {"code": "<snake_case>", "message": "<human text>"}}
```
Exactly one of `result` / `error`. Methods without data return `"result": {}`.

## Events (server -> client, unsolicited)
```
{"event": "<name>", "data": { ... }}
```
Events have no `id`. Clients must ignore unknown event names. Unknown fields are ignored.

## Methods

| method | params | result |
|---|---|---|
| `status` | none | `{"version": str, "state": State, "message"?: str, "pendingOps"?: int, "uploadBandwidthBps"?: int}` |
| `drives.list` | none | `{"drives": [Drive]}` |
| `drive.mount` | `{"driveId": str}` | `{}` (returns once mounted or errors) |
| `drive.unmount` | `{"driveId": str}` | `{}` |
| `transfers` | none | `{"transfers": [Transfer]}` (active and queued) |
| `uploads` | none | `{"pending": [{"driveId", "path", "bytes", "phase", "bytesSent", "bytesTotal"}], "journalBytes", "journalCapBytes"}` |
| `mounts.list` | none | `{"mounts": [{"driveId", "mountpoint", "readOnly", "adapter"}]}` |
| `pins.list` | `{"driveId"?: str}` | `{"pins": [{"driveId", "path", "bytes", "cachedBytes"}]}` |
| `drive.pin` | `{"driveId": str, "path": str, "pinned": bool}` | `{}` |
| `config.set` | `{"endpoint"?: str, "token"?: str, "cacheCapBytes"?: int, "journalCapBytes"?: int, "uploadBandwidthBps"?: int}` | `{}` |
| `auth.set` | `{"apiEndpoint": str, "accessToken": str, "refreshToken": str}` | `{"user": {"id": str, "email": str}}` |
| `auth.status` | none | `{"signedIn": bool, "user"?: {"id": str, "email": str}, "apiEndpoint"?: str}` |
| `auth.signOut` | none | `{}` (daemon calls `/auth/logout`, unmounts all drives, wipes its Keychain item) |

`config.set` is how the app hands the daemon the cache cap. `endpoint`/`token` are the M0
dev-token path and are kept only for local testing. Omitted fields are unchanged. The daemon
must not log `token`.

**M1 sign-in (see `docs/design/m1-contract.md` §5.1).** The app runs the desktop PKCE flow, then
hands the resulting session to the daemon with `auth.set` and keeps no copy. From then on the
daemon is the only holder of the refresh token. It stores it in the macOS Keychain (service
`com.orbit.ulsd`, account = user id), rotates it on refresh, and mints drive tokens with
`POST /drives/{id}/token`. `drives.list` returns the drives from `GET /orgs`. Once signed in, the
daemon emits `state` with `idle`; when refresh fails with `invalid_refresh`, it emits
`signed_out`.

Error codes: `no_such_drive`, `already_mounted`, `not_mounted`, `unauthorized`, `offline`,
`bad_request`, `internal`. Unknown methods return `bad_request`.

## Types
- `State`: `"signed_out" | "idle" | "syncing" | "offline" | "error"`
- `Drive`: `{"driveId": str, "name": str, "mountState": MountState, "mountPath"?: str}`
- `MountState`: `"unmounted" | "mounting" | "mounted" | "unmounting" | "error"`
- `Transfer`: `{"id": str, "driveId": str, "path": str, "direction": "upload"|"download", "bytesDone": int, "bytesTotal": int, "status": "queued"|"active"|"done"|"failed"}`

## Events
| event | data |
|---|---|
| `transfer` | a `Transfer` (sent on start, throttled progress, and completion; `done`/`failed` ends it) |
| `change` | `{"driveId": str, "seq": int, "paths": [str]}` remote change from the drive WebSocket |
| `pin` | `{"driveId": str, "path": str, "cachedBytes": int, "bytes": int}` prefetch progress |
| `conflict` | `{"driveId": str, "path": str, "copy": str}` |
| `state` | `{"state": State, "message"?: str}` |

The server sends a `state` event immediately after a client connects.

## Example
```
-> {"id":1,"method":"status"}
<- {"id":1,"result":{"version":"0.1.0","state":"idle","pendingOps":0}}
-> {"id":2,"method":"drive.mount","params":{"driveId":"demo"}}
<- {"event":"transfer","data":{"id":"t1","driveId":"demo","path":"/a.bin","direction":"download","bytesDone":0,"bytesTotal":4096,"status":"active"}}
<- {"id":2,"result":{}}
<- {"event":"state","data":{"state":"syncing"}}
```

M3 methods are optional for older engines. Unknown-method errors hide that feature; unknown
fields and future mount adapter strings are accepted. Other failures remain visible.

## Workspace and filename search additions (26 October 2026)

`files.search` takes `{driveId,query,cursor?}` and returns
`{entries:[{path,type,size,...}],cursor}`. It uses the active account's read grant and the
current data-plane filename index. Query is a literal case-insensitive filename substring
of at least three characters; it does not download or index file contents. `cursor` is
opaque to the app. Continue while it is non-null, including when a page has no live entries.
The desktop rejects unsafe result paths before constructing Finder URLs.

`api.request` takes `{method,path,body?}` and forwards only explicitly allowed control-plane
routes with the daemon's current access token. Desktop uses `GET /orgs`,
`POST /orgs/{id}/drives`, and `GET /client-config` (`{webOrigin}`) for drive creation and
browser links to `/orgs/{id}/team` and `/orgs/{id}/billing`. Keys, fork, membership,
invitation and billing-portal operations retain explicit route/method restrictions. A token
or arbitrary destination URL is never returned to the app by this bridge. Older engines
fail visibly and require an update; mock connections cannot execute management/search.

## Upload phases, bandwidth limit, capacity and offline behavior (27 October 2026)

**`uploads` items.** Each `pending` item keeps `driveId`, `path` (leading slash), `bytes`, and the
result keeps `journalBytes` and `journalCapBytes`. Items add:

- `phase`: `"saved_locally"` (journaled on this Mac, not being published) or `"uploading"` (a
  publication batch containing the item is running).
- `bytesSent`: bytes of shards PUT so far in the current publication attempt. `0` while
  `saved_locally`. Shards the server already has are not counted, so it can stay below `bytesTotal`
  and jump to commit. It resets if the attempt is retried.
- `bytesTotal`: the file size (same value as `bytes`). Folder and metadata-only items have `0`.

```
-> {"id":5,"method":"uploads"}
<- {"id":5,"result":{"pending":[{"driveId":"d1","path":"/a.mov","bytes":734003200,"phase":"uploading","bytesSent":209715200,"bytesTotal":734003200}],"journalBytes":734003200,"journalCapBytes":10737418240}}
```

Older daemons omit the three new fields; treat a missing `phase` as `saved_locally`.

**"Saved to cloud".** When a file's publication commits, the daemon emits a `transfer` event
for that file: `{"id":"<driveId>:upload:/a.mov","driveId":"d1","path":"/a.mov","direction":"upload",
"bytesDone":N,"bytesTotal":N,"status":"done"}` (`path` is the final path, after any rename in
the same batch). It is followed by the existing per-drive aggregate (`id` `"<driveId>:upload"`,
`path` `"/"`, `status` `"done"`). After the last commit the state returns to `idle`.

**`config.set.uploadBandwidthBps`.** Optional non-negative integer, bytes per second, shared by
every shard upload the daemon makes (mounts, `upload.queue`, CLI puts). `0` removes the limit; an
omitted field leaves it unchanged. It is persisted in the daemon state and applies to the next
shard PUT without a restart. A negative, fractional, non-numeric or absurd (> 10^12) value returns
`bad_request` and changes nothing. `status` reports the current value as `uploadBandwidthBps`
(`0` = unlimited).

**Finder capacity.** For a signed-in session the daemon remembers each drive's owning org
`quotaBytes` and `usedBytes` from `GET /orgs` (refreshed whenever it refetches `/orgs`, not live).
The SMB volume then reports total = `quotaBytes` and available = `max(quotaBytes - usedBytes -
journal bytes still waiting to upload, 0)`. Without those numbers the previous default is kept.

**Readiness call.** `api.request` also allows `GET /me/access`.

**Offline is not signed out.** If the API or drive-token call fails for a transient reason
(unreachable, timeout, 5xx), the request returns `offline`, the daemon state becomes `offline`,
and mounts, journals and pending uploads are kept. The state returns to `idle` on its own after a
later call succeeds. Only an explicit `signed_out` (refresh token rejected, or `auth.signOut`)
unmounts drives.

## Saved sign-in recovery (30 October 2026)

`status` optionally includes `canRetrySignIn: true` when a saved credential exists but macOS
refused access to it. The daemon remains reachable while a Keychain authorization request is
pending. Its `message` describes the required action. A credential-access failure is distinct
from a missing or revoked session; no credential is wiped to resolve it.

`auth.retryRestore` has no parameters and acknowledges `{}` once a user-requested retry has
started. Poll `status` / `auth.status` until it succeeds or reports another credential-access
error. Only one restore attempt runs at once. Signing into another account or signing out
fences an older pending restore, so a late Keychain result cannot reinstate the previous user.
This operation does not grant Keychain access; macOS owns the approval prompt.

A sign-out may return an error after revocation and local disconnection if macOS refused
credential cleanup. The status stays signed out and its message makes the remaining Keychain
item explicit. Do not interpret that error as a still-authenticated session.

Critical account, mount and configuration mutations acknowledge success only after installing
the serialized local state snapshot. Replayable progress, such as watch cursors, remains best
effort. A disk error must not be hidden by falling back to another state-file writer.
