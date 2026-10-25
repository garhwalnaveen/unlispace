# Daemon integration needs

## Coordinator / agent 01: shared Cargo dependency alignment

`ulsd`'s optional `smb` feature consumes `../smb` (`uls-smb`) and `../smb/uls-vfs-backend`
(`uls-vfs-backend`). Cargo resolves optional dependencies for default builds too. Keep the SMB
workspace's exact tokio, bytes, async-trait, tracing and tracing-subscriber pins aligned with
`engine/Cargo.toml` (including vendor manifests) and regenerate both Cargo.lock files after
integration.

## Agent 04 (uls-vfs): richer transfer lifecycle

`pending()` has only per-drive counts/bytes and `VfsEvent::Transfer` only reports completed
batches, so the daemon reports one aggregate upload at path `/` per drive (queued and done). Per-file
active/progress/failed events need a richer VFS event/pending contract.

## Known limits of the NFS fallback

- mode, uid/gid and times in `setattr` are accepted but not stored; only size changes.
- Symlinks and hard links are unsupported (`NOTSUPP`).
- NFSPROC3_COMMIT is not dispatched by `nfsserve` 0.11; `Vfs::flush` runs after each write instead.

## Agent 17 handoff: coordinator / Mac protocol

Apply the exact public rows in `PROTOCOL-ADDITIONS.md` to `mac/DAEMON-PROTOCOL.md` and update
app UI/types for pins, uploads and `journal_full` as appropriate. No `mac/` files were edited.
The CLI support methods in that file are internal to the same-version daemon and CLI.

## Agent 14 / data-plane history: moved directory descendants

The current data plane logs a directory rename only at its source and destination roots;
it moves descendant nodes without adding descendant version rows/change paths. For a renamed
folder's children, `versions?path=<new-child>` is empty even though the child exists. Complete
head-at-time queries and subtree rollback across directory renames need discoverable destination
child histories/manifests (and source tombstones), or an explicit historical namespace mapping.
Please materialize descendant versions/change rows atomically when renaming directories (and
per-descendant tombstones when deleting), or specify a history endpoint that supplies the mapping.
The CLI handles ordinary file rename versions and ancestor directory deletion tombstones, but
cannot reconstruct destination child histories that the API does not expose. Same-commit
parent deletion and child recreation also require an unambiguous final descendant version.

## Coordinator verification environment

The installed stable toolchain has no `cargo-fmt`; `cargo fmt --check` fails before checking files.
The E2E harness needs `E2E_MANAGED_SANDBOX=1` in this managed sandbox. Its native NFS/SMB mount
commands fail here (`Shimming not enabled`, NFS extension status `0x44c`), so native mount checks
must be repeated on an unrestricted Mac. No toolchain, System Settings or external resources
were changed.
