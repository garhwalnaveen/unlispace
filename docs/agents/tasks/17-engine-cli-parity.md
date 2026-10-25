# 17 · High stakes (gpt-6.1-sol): uls CLI parity with Space CLI + daemon pins/uploads/journal cap/remembered mounts  — write in: engine/ulsd/, engine/uls-vfs/, engine/uls-client/, engine/uls-mock/
Spec: docs/design/m3-contract.md §5 (normative); Space CLI behaviour in
/tmp/spacefs-docs-1025/llms-full.txt ("Mount a drive", "History from the command line").
Read engine/README.md, engine/ulsd/README.md, mac/DAEMON-PROTOCOL.md, engine/CONTRACT-NOTES.md first.
1. Daemon socket methods/events of §5.1 (`drive.mount` mountpoint/readOnly, `mounts.list`, `drive.pin`,
   `pins.list`, `uploads`, `pin` event), remembered mounts re-mounted on daemon start, journal cap →
   ENOSPC + `state journal_full`. Pins: prefetch every shard under the path into the disk cache and exempt
   them from LRU eviction (shard cache lives in uls-client; extend it with a pin set persisted on disk).
2. CLI of §5.2. Existing subcommands/flags keep working (tests/e2e/harness.mjs drives them — read it and
   don't break it). `mount` goes through the daemon unless `--foreground` (today's behaviour). Name
   resolution case-insensitive with ambiguity listing. `fork` calls the API `POST /drives/{id}/fork`.
   `show/restore --at`: pick the version that was head at the instant (by version `ts`). Folder restore
   `--at T`: for each path under the folder ever seen in `changes?since=0`, restore its head-at-T if it
   differs, delete paths created after T, all in one commit; print the plan with `--dry-run`.
   `--json` on read commands. `uls upload <local...> <drive>:<folder>` queues through the daemon.
3. Update `mac/DAEMON-PROTOCOL.md`? NO — you may not write mac/. Put the exact table rows you implemented
   in `engine/ulsd/PROTOCOL-ADDITIONS.md` for the coordinator.
Tests: unit + uls-mock integration for each command and socket method; journal-full and pin-eviction
tests. Gate: `cd engine && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings &&
cargo test --workspace` and `cargo build -p ulsd --features smb` (debug only). Then run
`bash tests/e2e/run.sh` and paste its RESULT line (do not edit tests/e2e). Report ≤ 300 words.
