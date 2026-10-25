# 12 · Small (gpt-6-luna): hide macOS AppleDouble `._*` files  — write in: engine/ulsd/src/nfs.rs, engine/ulsd/tests/
User decision: hide them. macOS writes `._name` sidecars (and `.DS_Store`) on NFS mounts to emulate
xattrs; today they are published to the drive as real files (see engine/ulsd/NEEDS.md).
In the NFS adapter only (SMB keeps real xattrs and is unaffected):
- create/write/rename of a name matching `._*` must NOT reach `uls_vfs::Vfs`. Keep such files in a
  small in-memory per-mount overlay so Finder still works (reads back what it wrote during the
  session), and drop the overlay on unmount. Same for `.DS_Store` (overlay, never published).
- readdir must not show remote `._*` / `.DS_Store` entries either.
- Add tests: writing `._a` and `.DS_Store` through the adapter publishes nothing (assert via the VFS
  pending() / uls-mock), reading them back works within the session, normal files still publish.
- Update engine/ulsd/NEEDS.md (remove the AppleDouble item) and README.
Gate: `cargo test -p ulsd` and `cargo clippy -p ulsd --all-targets -- -D warnings` green (run from
engine/). No release builds, no commit. Report in ≤ 120 words.
