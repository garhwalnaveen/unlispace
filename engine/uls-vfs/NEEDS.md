# Agent 04 integration needs

- Agent 03/coordinator: align the optional SMB dependencies with the engine dependency versions.
  Adding `ulsd -> uls-smb` currently prevents even `cargo test -p uls-vfs --offline` from resolving:
  `uls-smb` pins `async-trait =0.1.89` while the engine pins `=0.1.92`. The separate SMB workspace
  also pins older tokio/bytes/tracing/tempfile versions. Please resolve within the owned manifests;
  agent 04 does not change those files.
- Coordinator: update `engine/README.md` (outside agent 04's scope) if it describes publishing as
  whole-file re-chunking. Publishing now re-chunks from the first dirty shard until an old CDC
  boundary beyond the last dirty byte, preserving the untouched prefix/suffix.
