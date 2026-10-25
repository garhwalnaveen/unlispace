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
