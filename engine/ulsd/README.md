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
   4.0 KiB  ._a            (macOS AppleDouble files, see NEEDS.md)
   4.0 KiB  ._f
   4.0 KiB  ._moved.bin
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
