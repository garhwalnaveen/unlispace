# 01-smb-native-fixes handoff needs

- **Coordinator / VFS backend agent:** the concurrently added `uls-vfs-backend`
  workspace member pins `tempfile = "=3.27.0"`, whereas this workspace pins
  `=3.23.0`. Cargo fails dependency resolution even with `-p uls-smb`. Align the
  integration crate's compatible exact pins with the existing SMB workspace;
  do not change the SMB cryptography pins to solve an integration-only conflict.
- **Coordinator / native runner:** run `RUST_LOG=debug bash scripts/macos-smoke.sh`
  from `engine/smb` in the execution environment that previously mounted it.
  This agent's permitted command runner gets `SMBOpenServerEx: Device not
  configured (os error 6)` before any native TCP negotiation, even with `/tmp`
  mountpoints. The new script keeps native failures visible and exits nonzero.
- **Product / coordinator:** POSIX `fcntl.lockf` is rejected in Apple's
  `smbfs_vnop_advlock` before SMB LOCK unless `CIFS_UNIX_FCNTL_LOCKS_CAP` is in
  `ss_unix_caps`. SMB2 share/filesystem flags do not set that field. The source's
  SMB1 UNIX capability parser also masks that bit out. Native POSIX `lockf`
  support cannot be enabled by inventing SMB2 capability bits. Decide the
  product requirement for POSIX locks versus the supported native `flock` / SMB
  byte-range locking interfaces. The strict `lockf` acceptance test is retained.

Evidence and exact gate results are recorded in `VERIFICATION.md`.
