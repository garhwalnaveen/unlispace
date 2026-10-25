# Verification report

Run date: 2026-10-25. Host: macOS 26.5.1, arm64. Mounted natively via NetFS under /tmp, no sudo, no prompt.
All mounts and scratch were removed afterwards (checked with `mount`, `pgrep smb-demo`, `ls /tmp`).

## Gate

| Command | Result |
| --- | --- |
| `cargo build` | PASS |
| `cargo test --workspace` | PASS, 811 passed, 0 failed |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS |
| `bash scripts/macos-smoke.sh` | 16 PASS, 0 FAIL (1 of them is a known-limitation check, below) |

## Native smoke output

```
PASS  native mount (no sudo, no prompt)
PASS  ls -la
PASS  write + cat
PASS  cp in
PASS  mv
PASS  rm
PASS  mkdir -p
PASS  xattr write/read + shorter overwrite
PASS  com.apple.ResourceFork write/read
PASS  cp -p preserves xattrs + resource fork in/out
PASS  ditto preserves xattrs + resource fork in/out
PASS  50 MiB dd write + shasum read-back
PASS  flock: second process conflict + release
PASS  lockf byte range: ENOTSUP from smbfs, no LOCK sent (known XFAIL)
PASS  safe-save replace (rename over existing)
PASS  unmount on Ctrl-C
RESULT: 16 passed, 0 failed (of which known client-limitation XFAILs: 1)
```

## Findings

1. xattr write (`[Errno 13]`): fixed by the earlier changes (FILE_NAMED_STREAMS in
   FileFsAttributeInformation, FILE_WRITE_DATA may extend a file). Native xattr, ResourceFork and
   ditto now pass. I did not revert each change to attribute the fix to one of them.
2. `cp -p` failed with `chflags: Operation not permitted`. smbfs maps a missing
   FILE_ATTRIBUTE_ARCHIVE to the root-only SF_ARCHIVED flag (smbfs_vnops.c, ~line 8620) and cp -p
   then tries to clear it. Fix: `FileInfo::attributes()` now reports ARCHIVE on files, like Windows.
3. `fcntl.lockf` (POSIX byte-range, F_SETLK) returns ENOTSUP in the client. Apple's
   `smbfs_vnop_advlock` (apple-oss-distributions/smb, kernel/smbfs/smbfs_vnops.c ~line 5788)
   returns `err_advlock` for any F_POSIX request unless `UNIX_CAPS(share) & CIFS_UNIX_FCNTL_LOCKS_CAP`.
   That bit is only read, never set, in the source I fetched, and UNIX_CAPS is filled from the SMB1
   CIFS UNIX extensions. With debug tracing, flock sends LOCK (offset 0, length u64::MAX, flags 18/4);
   lockf sends no LOCK at all. No negotiate, tree-connect or FILE_SUPPORTS_* bit can change this. It is
   a client limitation, not fixable server-side. flock works, with cross-process conflict.
   The smoke script asserts ENOTSUP and fails if lockf ever starts working.

## Not verified

Finder behaviour and cache invalidation. I did not read the Apple source for the macOS 26.5.1 build
itself, only the public apple-oss-distributions mirror. Signing stays required and leases stay disabled.
