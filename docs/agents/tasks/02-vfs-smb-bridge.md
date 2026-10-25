# 02 · Bridge: SmbBackend on top of uls-vfs  — write in: engine/smb/uls-vfs-backend/ (new crate inside the smb workspace)
Create crate `uls-vfs-backend` as a member of the **engine/smb** workspace that depends on
`uls-vfs` and `uls-client` by path (`../../uls-vfs`, `../../uls-client`) and implements
`uls_smb::SmbBackend` by delegating 1:1 to `uls_vfs::Vfs` (lookup/readdir/read/create/write/
truncate/rename/remove/flush/xattrs; `subscribe()` maps `VfsEvent::Changed` → `ChangeEvent`).
Map `FsError` → NTSTATUS correctly (NotFound→OBJECT_NAME_NOT_FOUND, Exists→OBJECT_NAME_COLLISION,
NotEmpty→DIRECTORY_NOT_EMPTY, NoSpace→DISK_FULL, ReadOnly→MEDIA_WRITE_PROTECTED, Stale/Busy, …).
Add a binary `smb-vfs-demo <drive> <mountpoint>` that starts `uls-mock` in-process, opens a Vfs
on it, serves SMB, mounts. Native test (mountpoint under /tmp): write files through Finder-style
ops, then assert via uls-mock that commits landed with correct bytes; a remote change injected
into uls-mock appears in the mount within 2 s. Only edit engine/smb/Cargo.toml to add the member
(another agent edits engine/smb/src — do not touch src/, vendor/, tests/). Gate: build/clippy/test
green for the new crate; native test script result in its README.
