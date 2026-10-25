# Daemon integration needs (agent 03)

## Coordinator / agent 01: shared Cargo dependency alignment

`ulsd`'s optional `smb` feature consumes `../smb` (`uls-smb`) and
`../smb/uls-vfs-backend` (`uls-vfs-backend`). Cargo resolves optional dependencies
for default builds too. Align the SMB workspace's exact tokio, bytes,
async-trait, tracing and tracing-subscriber pins with `engine/Cargo.toml`, including
vendor manifests, so the combined graph resolves. Regenerate both shared
Cargo.lock files after integration; agent 03 does not own them.

## Agent 04: richer transfer lifecycle

The daemon forwards `Client::watch` to `Vfs::apply_remote`, including Resync.
`pending()` currently has only per-drive counts/bytes, and `VfsEvent::Transfer`
only reports completed batches. The daemon therefore reports one aggregate upload
at path `/` per drive (queued and done), including metadata-only batches. Per-file
active/progress/failed events require a richer VFS event/pending contract; no
invented progress or failed status is emitted.
