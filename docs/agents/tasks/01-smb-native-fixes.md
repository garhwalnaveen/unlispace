# 01 · SMB: make the native macOS mount pass 13/13  — write in: engine/smb/
The SMB server (engine/smb) mounts natively via `target/debug/smb-demo <mountpoint-under-/tmp>`.
Coordinator smoke test `engine/smb/scripts/macos-smoke.sh` (already copied there
and use mountpoints under /tmp — NetFS rejects ones inside the repo sandbox) gives 11/13.
FAIL: `xattr -w com.test hello a.txt` → Errno 13 Permission denied;
`fcntl.lockf(f, LOCK_EX|LOCK_NB, 10, 0)` → Errno 45 EOPNOTSUPP.
Capture what smbfs sends (RUST_LOG=debug / add tracing): CREATE of named stream `a.txt:com.test`
(desired access, disposition, create options), FileFsAttributeInformation flags
(FILE_NAMED_STREAMS, FILE_SUPPORTS_EXTENDED_ATTRIBUTES), share/tree capabilities, and why smbfs
decides locking is unsupported before sending LOCK. Fix both; keep signing required, leases off.
Add wire regression tests + native checks: `cp -p`/`ditto` preserving xattrs,
`com.apple.ResourceFork`, second process sees lock conflict. Rewrite VERIFICATION.md with real
native results (the old "BLOCKED" claim is wrong). Gate: `cargo build && cargo clippy -- -D warnings
&& cargo test` in engine/smb, and `bash scripts/macos-smoke.sh` 13/13+.
