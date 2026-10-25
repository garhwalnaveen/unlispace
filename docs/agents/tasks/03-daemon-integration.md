# 03 · Daemon: retire custom watch, use TokenProvider, writable VFS + SMB adapter  — write in: engine/ulsd/, engine/uls-auth/
Per engine/ulsd/NEEDS.md (items now implemented in uls-client 3feba15): replace ulsd/src/watch.rs's
own loop with `Client::watch` + a `TokenProvider` adapter over uls-auth's `DriveTokenSource`
(map AuthError→uls_client::Error::Auth); remove `SharedClient`/`spawn_rotation`; persist
`WatchStream::last_ev()`; handle `WatchEvent::Resync`. Do not edit engine/uls-vfs (agent 04 owns it). Each mounted drive gets a `uls_vfs::Vfs`
(state dir `~/Library/Application Support/Unlispace/drives/<id>/`), fed by the watch
(`apply_remote`). Implement the `transfers` method and `transfer` events from `Vfs::pending()`/
`VfsEvent::Transfer`. Keep `MountAdapter`; NFS stays read-only fallback. Add an `SmbAdapter`
behind a cargo feature `smb` that depends on `../smb` (path `uls-smb` + `uls-vfs-backend`, which
agent 02 is creating — code against the `SmbBackend` trait in engine/smb/src/backend.rs; if the
bridge crate isn't there yet, implement the adapter against the trait and gate it). Default mount
adapter = smb when the feature is on. Mount path `~/Unlispace/<Drive>`. Gate: `cargo build
-p ulsd -p uls-auth`, clippy -D warnings, tests (incl. an end-to-end test against uls-mock:
mount via NFS adapter read-only + VFS write path via direct Vfs calls, watch drives invalidation).
