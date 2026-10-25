# Unlispace engine (M0)

Rust workspace: chunker, wire types, HTTP/WebSocket client, shard cache, and the `ulsd` / `uls` binary
(CLI plus a read-only loopback NFSv3 mount). Contract: `../docs/design/m0-contract.md`.
Deviations and open questions: `CONTRACT-NOTES.md`.

| Crate | Role |
|---|---|
| `uls-chunk` | FastCDC 2020 (256 KiB / 2 MiB / 16 MiB) + SHA-256; slice and streaming APIs; golden vectors in `tests/` |
| `uls-proto` | serde types for every request and response |
| `uls-client` | async client: upload with dedup, parallel verified download, range reads, watch, shard cache |
| `ulsd` | multicall binary: `uls` CLI and `mount` (NFSv3 via `nfsserve`) |
| `uls-mock` | in-memory server implementing the contract, for tests and offline runs (not a product) |

## Build and test

```sh
source ~/.cargo/env
cargo build --release          # target/release/ulsd
ln -sf ulsd target/release/uls # multicall: `uls ...` behaves the same as `ulsd ...`
cargo clippy --all-targets -- -D warnings
cargo test
```

## Environment

| Var | Default | |
|---|---|---|
| `ULS_ENDPOINT` | `http://127.0.0.1:8787` | Worker base URL |
| `ULS_DEV_TOKEN` | required | static bearer token; never printed or logged |
| `RUST_LOG` | `warn` | e.g. `uls_client=debug` |

Shard cache: `~/Library/Caches/com.unlispace/shards/<sha256>`, 20 GB cap, LRU by mtime, atomic writes, verified on read.
Used by `get` and `mount`.

## CLI

```sh
export ULS_DEV_TOKEN=dev-token
uls drive create my-drive --placement wnam
uls put my-drive ./cut.mov cuts/a.mov [--if-version v_...]
uls get my-drive cuts/a.mov ./copy.mov [--version v_...]
uls ls my-drive [cuts]
uls stat my-drive cuts/a.mov
uls versions my-drive cuts/a.mov
uls restore my-drive cuts/a.mov v_...
uls mkdir my-drive archive
uls mv my-drive cuts/ archive/cuts/        # folders end with /
uls rm my-drive old.txt
uls watch my-drive [--since 0]
uls mount my-drive ~/mnt/my-drive
```

Exit code 2 means the server rejected the request (412 precondition, not found, drive exists); 1 is any other error.

## Daemon (`ulsd daemon`)

`ulsd daemon` is what the Mac app talks to. It is also the default when `ulsd` runs with no
arguments, which is how a LaunchAgent starts it. Protocol: `../mac/DAEMON-PROTOCOL.md`.

- Socket: `~/Library/Application Support/Unlispace/ulsd.sock` (directory 0700, socket 0600). A stale
  socket is removed on start; a live one makes the new daemon exit. Connections from another uid
  are dropped.
- Sign-in: the app hands over its session with `auth.set`. The refresh token is kept in the macOS
  Keychain (service `com.unlispace.ulsd`, account = user id) and rotated on refresh. Access tokens
  stay in memory. Drive tokens come from `POST /drives/{id}/token`. Tokens are never logged.
- `drive.mount` mounts at `~/Unlispace/<Drive name>` using the read-only NFS adapter behind the
  `MountAdapter` trait (`ulsd/src/mount.rs`). Mounts are remembered in
  `~/Library/Application Support/Unlispace/state.json` (also holds per-drive watch cursors as the
  last `ev`; no tokens) and restored on start. SIGTERM unmounts everything and keeps the list.
- Each mounted drive runs a change watch and emits `change` events.
- `uls login [--api URL]` signs in from a terminal: prints the `/auth/desktop/start` PKCE URL, you
  paste the `uls://auth/callback#...` URL back, and the session goes to the running daemon (or
  straight to the Keychain).
- `uls-auth` crate: `Session` (single-flight refresh, rotation, drive-token cache, `orgs()`,
  `sign_out()`), `SecretStore` with `KeychainStore` (macOS) and `MemoryStore`.
- Needed changes in other crates: `ulsd/NEEDS.md`.

## Run against `wrangler dev`

```sh
# terminal 1
cd ../cloud/data-plane && npx wrangler dev          # serves http://127.0.0.1:8787, local R2 + DO
# terminal 2
export ULS_DEV_TOKEN=<the token the worker is configured with>
uls drive create my-drive
uls put my-drive ./200mb.bin big.bin
uls get my-drive big.bin ./out.bin && shasum -a 256 200mb.bin out.bin
```

No Worker? `cargo run --release -p uls-mock -- 127.0.0.1:8787` serves the same contract from memory
(token from `ULS_DEV_TOKEN`).

## Mount (read-only, NFSv3 on loopback)

```sh
mkdir -p ~/mnt/my-drive
uls mount my-drive ~/mnt/my-drive      # prints the exact mount_nfs command, mounts, waits
# Ctrl-C unmounts with umount and exits
```

It runs `mount_nfs -o port=<p>,mountport=<p>,nolocks,vers=3,tcp,rdonly,actimeo=1 localhost:/ <mountpoint>`.
On macOS 26.5.1 this needed no sudo and no prompt for a user-owned directory. Use `--no-mount` to serve only and
run the printed command yourself. The mountpoint is `realpath`ed first (macOS refuses symlinked mountpoints such as `/tmp`).
If the process is killed with SIGKILL the mount is left stale: run `umount <mountpoint>` (or `umount -f`).
Per `docs/research/spacefs/macos-fs-options.md`, apps touching a network volume may trigger the one-time
"Network Volumes" privacy prompt.

Reads fetch whole shards, verify them, and keep them in the disk cache, so the first byte of a large file arrives
after one shard (up to 16 MiB), not after the whole file.
