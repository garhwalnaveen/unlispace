# uls-vfs-backend

`VfsBackend::new(vfs)` implements `uls_smb::SmbBackend` with the mounted drive's
`uls_vfs::Vfs`. Construct it inside a Tokio runtime and pass an `Arc` to
`uls_smb::serve`. The constructor consumes a VFS clone; it does not create a
second journal or start a second cloud watcher. The daemon's existing
`Client::watch` loop must call `Vfs::apply_remote`.

Lookup, directory enumeration, ranged reads/writes, create, truncate,
rename/replace, remove, flush, and all four xattr methods delegate directly.
IDs, file kinds, sizes, read-only flags, and all four FILETIME timestamps are
copied without changing units. Xattrs retain their native names; the SMB layer
owns the AFP stream encoding. `flush` is the VFS's durable **local journal**
barrier; publication to the mock/cloud follows the configured quiet window.

The bridge forwards `VfsEvent::Changed` as path invalidations (`Modified`), with
the current directory flag. The VFS event has no original operation or old kind,
so it cannot faithfully reconstruct Added/Renamed/Removed events. Removed or
unreadable paths, root resyncs, and upstream lag request directory rescans by
overflowing the bridge's broadcast queue; the SMB adapter already handles
`RecvError::Lagged` as a rescan. Transfer, conflict, and sync-state events stay
with the daemon. Dropping the backend aborts its notification task.

The current SMB error contract supports the requested NotFound, Exists,
NotDirectory, IsDirectory, NotEmpty, NoSpace, Invalid, and I/O wire statuses.
It cannot yet carry precise ReadOnly, Busy, or Stale statuses. Those currently
return AccessDenied / I/O, respectively. `set_metadata` returns NotSupported
because VFS has no corresponding setter. These are integration gaps, tracked in
[NEEDS.md](NEEDS.md); this crate is not a completed acceptance gate yet.

## Build and run

From `engine/smb`, after the shared dependency pins are aligned:

```sh
export CARGO_TARGET_DIR="$(cd ../target && pwd)"
cargo build -p uls-vfs-backend --features demo
cargo clippy -p uls-vfs-backend --features demo --all-targets -- -D warnings
cargo test -p uls-vfs-backend --features demo
cargo run -p uls-vfs-backend --features demo --bin smb-vfs-demo -- demo /tmp/uls-vfs-mount
bash uls-vfs-backend/scripts/native-test.sh
```

The `demo` feature keeps the in-process mock and its test dependencies out of
the daemon's production backend dependency graph. The demo creates a temporary
journal under `/tmp`, starts `uls-mock` on loopback, creates the requested drive,
forwards the client's actual watch stream to VFS, serves signed/authenticated
SMB, and mounts with the server's in-memory credentials. Ctrl-C unmounts before
stopping SMB and draining VFS. Failed drains retain their journal and report its
path. Unmount failure keeps serving until open files are released and Ctrl-C is
pressed again. No external service, root, settings, or credentials file is used.

## Native acceptance

The native script creates an empty mountpoint under `/tmp` and runs the built
demo with `--native-test`. It verifies the OS mount table says `smbfs` before any
file operation. It then checks create/write/fsync, safe-save rename, copy,
truncate, delete, correct published bytes and version history via the mock's
HTTP API, and a separately injected remote file becoming readable in the mount
within two seconds of its commit returning. Both file reads and mount calls run
off the async executor. Scratch files are tiny and cleaned up on normal exit.
The script only uses `rmdir` for its mountpoint cleanup, so it cannot recursively
remove a mounted or nonempty volume.

The Rust integration tests additionally cover xattrs including FinderInfo and
ResourceFork, stable IDs, enumeration, replace/no-replace behavior, rejection of
oversized writes without altering bytes, expected errors, real WebSocket remote
invalidation, and root-rescan/task teardown.

Verification results will be recorded below after running the gates.
