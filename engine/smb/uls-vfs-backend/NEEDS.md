# Integration needs

For agent 01 / coordinator (outside this task's write scope):

- Align SMB workspace pins with `engine/Cargo.toml`: tokio 1.54.1, bytes 1.12.1,
  async-trait 0.1.92, tracing 0.1.44, and tracing-subscriber 0.3.23 (including
  the vendor dev dependency), tempfile 3.27.0, and cc 1.10.0 (required by
  aws-lc-sys's cmake dependency). Cargo cannot combine these differing exact pins.
  Update the SMB Cargo.lock after integration; this agent may only add its member
  to the shared manifest and does not edit the shared lockfile.
- Extend `uls_smb::FsError` and its conversion in `src/adapter.rs` to preserve
  `ReadOnly` -> STATUS_MEDIA_WRITE_PROTECTED (0xC00000A2),
  `Busy` -> STATUS_SHARING_VIOLATION (0xC0000043), and
  `Stale` -> STATUS_FILE_INVALID (0xC0000098). A lossless NTSTATUS carrier variant
  would also work. The bridge currently must use AccessDenied for ReadOnly and
  Io for Busy/Stale because no precise carrier exists. Those three wire statuses
  are not implemented by this bridge alone.

For agent 03 / VFS owner:

- `Vfs` has no timestamp/read-only metadata setter. The bridge inherits the SMB
  trait's NotSupported result for set_metadata. Add a durable VFS setter before
  claiming Finder cp -p / ditto metadata preservation.
- `Vfs::flush` persists locally and schedules cloud publication after the quiet
  window; SMB close/FLUSH keeps those exact semantics. Cloud persistence is tested
  by waiting for the mock's published bytes, never by treating flush as upload.
- The caller must forward Client::watch events to Vfs::apply_remote. The demo
  does this; the bridge constructor does not start an additional remote watcher.
