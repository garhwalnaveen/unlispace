# ulsd

The Unlispace daemon and CLI (`ulsd`, also invoked as `uls`).

## Daemon options

```
ulsd daemon [--socket <path>] [--state-dir <dir>] [--secret-store keychain|memory] [--read-only]
```

- Defaults are unchanged: `~/Library/Application Support/Unlispace/{ulsd.sock,state.json,drives/}`,
  mounts under `~/Unlispace`, Keychain secrets.
- `--state-dir <dir>`: the state file, drive journals (`drives/<id>/`), shard cache (`cache/`),
  mount root (`mnt/`) and, by default, the socket (`<dir>/ulsd.sock`) all live under `<dir>`.
- `--socket <path>` overrides only the socket location.
- `--secret-store memory` creates no Keychain item. With `--state-dir` this keeps tests away from
  the user's session.
- `--read-only` forces the read-only NFS adapter (the SMB backend has no read-only mode).

## Events

`conflict` (`{"driveId","path","copy"}`, leading-slash paths) is broadcast when `uls-vfs` preserves
a local edit next to a concurrent remote one. See `mac/DAEMON-PROTOCOL.md`.

## NFS fallback (`nfs.rs`)

A loopback NFSv3 server over the drive's `uls_vfs::Vfs`. It is writable unless `--read-only`:
create, write, setattr (truncate), rename, remove/rmdir, mkdir. File ids are the Vfs attr ids, so
they survive rename. `nfsserve` 0.11 does not dispatch NFSPROC3_COMMIT and replies `FILE_SYNC` to
every WRITE, so every write, create and truncate also calls `Vfs::flush` (what COMMIT would do).
Bytes are durable in the journal at once and the publisher uploads them after its quiet window.
macOS `._*` AppleDouble files and `.DS_Store` stay in a per-mount memory overlay for Finder
readback, are hidden when found remotely, and are discarded when the mount ends.
`ulsd mount <drive> <dir> [--read-only] [--state-dir <journal dir>]` runs it standalone; it
drains the journal on Ctrl-C.

### Native write test (macOS 26, `uls-mock`, debug build)

`uls-mock 127.0.0.1:18787`, `ulsd drive create demo`, `ulsd mount demo $W/mnt --state-dir $W/state`
(`mount_nfs -o port=64507,mountport=64507,nolocks,vers=3,tcp,actimeo=1 localhost:/ $W/mnt`):

```
$ echo hi > f
hi
$ cp 20MiB big.bin
-rw-r--r--@ 1 naveen  wheel  20971520 Oct 25 18:07 big.bin
$ mv big.bin moved.bin
$ echo gone > tmp; rm tmp
$ mkdir -p a/b; echo deep > a/b/c.txt
$ ls -lR
drwxr-xr-x@ 2 naveen  wheel      4096 Oct 25 18:07 a
-rw-r--r--@ 1 naveen  wheel         3 Oct 25 18:07 f
-rw-r--r--@ 1 naveen  wheel  20971520 Oct 25 18:07 moved.bin
./a:
drwxr-xr-x@ 2 naveen  wheel  4096 Oct 25 18:07 b
./a/b:
-rw-r--r--@ 1 naveen  wheel  5 Oct 25 18:07 c.txt
```

Read back from the remote after the publisher drained (`ulsd ls/get/stat`):

```
         -  a/
       3 B  f
  20.0 MiB  moved.bin
$ ulsd get demo f          -> hi
$ ulsd get demo moved.bin  -> 20.0 MiB, cmp with the source: identical
$ ulsd get demo a/b/c.txt  -> deep
$ ulsd stat demo tmp       -> not found: no_such_path (exit 2)
$ ulsd stat demo big.bin   -> not found: no_such_path (exit 2)
```

Unmounted with Ctrl-C (`unmounted ...`); `mount` showed no leftover; the mock and temp data were
removed.

## M3 CLI and daemon

```
uls daemon start
uls drives --json
uls use "My workspace"
uls mount Footage [mountpoint] [--read-only]
uls mounts --json
uls upload ./rushes ./audio drive-id:/incoming
uls uploads --watch
uls pin Footage /incoming
uls unpin Footage /incoming
uls history Footage cuts/a.mov --json
uls show Footage cuts/a.mov --at 2026-09-13T09:00:00Z > before.mov
uls restore Footage cuts/ --at 2026-09-13T09:00:00Z --dry-run
uls fork Footage Experiment
uls keys list --json
uls keys create --name automation --org workspace-id --access write
uls keys revoke ACCESS_KEY_ID
uls unmount Footage
uls daemon stop
```

Names, aliases, ids and workspace/name forms match case-insensitively. Ambiguous names list
workspace-qualified choices; `use` remembers a workspace default. Signed-in data commands execute
inside the daemon's session; the CLI never reads/rotates its refresh token. The M0 `ULS_DEV_TOKEN`
commands remain available. `ULS_SOCKET` selects an isolated daemon socket for CLI commands.

`mount` returns after the daemon owns the mount. Use `--foreground` for the standalone NFS
process; existing `--state-dir`, `--no-mount` and nonzero `--port` also select that flow so old
scripts keep working. `daemon start|stop|status` accepts the daemon's existing isolation options.

Uploads copy into durable daemon journals before acknowledging the queue, use staging paths
before replacing destinations, and publish independently of the terminal. File and directory
imports (including empty directories) are supported; directory traversal does not follow symlinks.
The shared journal cap is 10 GiB by default and can be changed with `config.set journalCapBytes`.
A rejected filesystem write returns ENOSPC and emits `state` with message `journal_full`.

Keep-offline pins persist independent shard ownership per drive/path, including overlapping
paths, and protect pinned shards from LRU even in cache instances opened before the pin. Pin
progress counts unique shard bytes. A failed prefetch keeps its pin and can be retried. Pins are
snapshots of the path at prefetch time; re-pin to fetch a newer remote head.

`show --at` and rollback choose by version timestamp, with sequence as the tie-breaker, rather
than file mtime. Subtree rollback follows the complete change feed and commits one guarded plan;
`--dry-run` prints that plan without mutating the drive. The data plane must expose moved
subtree descendant history for rollback across directory renames; see `NEEDS.md`.

Protocol handoff: `PROTOCOL-ADDITIONS.md`. Exact gate output summaries: `GATE-RESULTS.md`.
