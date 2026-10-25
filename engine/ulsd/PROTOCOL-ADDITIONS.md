# M3 daemon protocol additions for integration

Append/replace these exact rows in `mac/DAEMON-PROTOCOL.md`:

| method | params | result |
|---|---|---|
| `drive.mount` | `{"driveId": str, "mountpoint"?: str, "readOnly"?: bool}` | `{"mountpoint": str}` |
| `mounts.list` | none | `{"mounts": [{"driveId": str, "mountpoint": str, "readOnly": bool, "adapter": "smb"\|"nfs"}]}` |
| `drive.pin` | `{"driveId": str, "path": str, "pinned": bool}` | `{}` |
| `pins.list` | `{"driveId"?: str}` | `{"pins": [{"driveId": str, "path": str, "bytes": int, "cachedBytes": int}]}` |
| `uploads` | none | `{"pending": [{"driveId": str, "path": str, "bytes": int}], "journalBytes": int, "journalCapBytes": int}` |
| `config.set` | `{"endpoint"?: str, "token"?: str, "cacheCapBytes"?: int, "journalCapBytes"?: int}` | `{}` |

| event | data |
|---|---|
| `pin` | `{"driveId": str, "path": str, "cachedBytes": int, "bytes": int}` |

A rejected write emits `state` with `{"state":"error","message":"journal_full"}` and
returns POSIX ENOSPC (28) through the filesystem adapter. The journal budget is shared across
all drive journals; the default is 10 GiB and changes apply immediately. `uploads` includes
unmounted drive journals queued by the CLI. Mount paths and read-only settings survive restart.
An explicitly read-only mount uses NFS because the SMB backend cannot enforce read-only access.
Pins use leading-slash paths, persist shard ownership on disk, and survive cache reopen/eviction.
Overlapping pins retain independent ownership. Retrying `drive.pin` resumes an interrupted prefetch.

## CLI support RPCs (same private socket, same-uid authentication)

| method | params | result |
|---|---|---|
| `drive.resolve` | `{"driveId": str}` (name, alias, workspace/name, or id) | `{"driveId": str}` |
| `workspace.use` | `{"workspace": str}` | `{"workspace": str}` (workspace id) |
| `upload.queue` | `{"driveId": str, "files": [{"local": str, "path": str, "directory"?: bool}]}` | `{}` (bytes are durable in the daemon journal before return) |
| `daemon.stop` | none | `{}` (then clean shutdown preserving remembered mounts) |
| `changes` | `{"driveId": str, "after"?: int}` | the data-plane `ChangesResponse` |
| `api.request` | `{"method"?: str, "path": str, "body"?: object}` | control-plane JSON (restricted to `/orgs`, `/keys`, `/keys/{id}`, `/drives/{id}/fork`) |
| `cli.run` | serialized Rust CLI data command and `json` boolean | `{"output": [byte]}` |

`cli.run` keeps the daemon the sole holder of the signed-in session and bearer tokens. This is
an internal same-version CLI/daemon interface, not an app integration surface. Raw `show` output
is transported as bytes; `--json` remains valid JSON. `ULS_SOCKET` selects a custom control socket.
Legacy `mount --state-dir`, `--no-mount`, or nonzero `--port` imply the standalone foreground
flow; otherwise `mount` is daemon-owned unless `--foreground` is explicit.
