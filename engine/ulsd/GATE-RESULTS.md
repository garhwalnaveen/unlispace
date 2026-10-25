# Agent 17 gate evidence

Source changes are confined to engine/ulsd, engine/uls-vfs, engine/uls-client and engine/uls-mock. No new dependency versions or lockfile edits remain.
## Required format gate

`cd engine && cargo fmt --check` — exit 1. This also blocks the combined fmt/clippy/test pipeline at its first command; the other gates below were run individually.

```text
error: 'cargo-fmt' is not installed for the toolchain 'stable-aarch64-apple-darwin'.
help: run `rustup component add rustfmt` to install it
```
## Clippy

`cd engine && cargo clippy --workspace --all-targets -- -D warnings` — exit 0.

```text
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.32s
```
## Workspace tests

`cd engine && cargo test --workspace` — exit 0. Computed total: 144 passed, 0 failed, 2 ignored. Below are the exact per-suite summary lines, with their original suite labels.

```text
    Finished `test` profile [unoptimized + debuginfo] target(s) in 11.72s
     Running unittests src/lib.rs (target/debug/deps/uls_auth-491fd3181a72aad5)
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/session.rs (target/debug/deps/session-de2312eca75fc735)
test keychain_round_trip ... ignored, touches the real login Keychain; may prompt the user
test result: ok. 11 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.09s
     Running unittests src/lib.rs (target/debug/deps/uls_chunk-43e9bf5ee3a0d74d)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running unittests src/bin/uls-bench.rs (target/debug/deps/uls_bench-11995167d264a65a)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/chunker.rs (target/debug/deps/chunker-f80b8ebf25245654)
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 15.32s
     Running unittests src/lib.rs (target/debug/deps/uls_client-bd50278ab0c876f5)
test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.13s
     Running tests/against_mock.rs (target/debug/deps/against_mock-4bcb0bc56630bdc0)
test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.61s
     Running tests/feed_and_auth.rs (target/debug/deps/feed_and_auth-664b684aed702495)
test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.84s
     Running tests/wiremock_client.rs (target/debug/deps/wiremock_client-befc14cd81872e14)
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
     Running unittests src/lib.rs (target/debug/deps/uls_mock-8948b2bf9837e966)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running unittests src/main.rs (target/debug/deps/uls_mock-dc6458eef76ea63e)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running unittests src/lib.rs (target/debug/deps/uls_proto-cb2f612d1014e697)
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running unittests src/lib.rs (target/debug/deps/uls_vfs-c802247ce925d9ee)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.13s
     Running tests/publisher.rs (target/debug/deps/publisher-6f67ca1a642d8b91)
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 4.93s
     Running tests/vfs.rs (target/debug/deps/vfs-f8de2599f3603f20)
test result: ok. 22 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 4.32s
     Running unittests src/lib.rs (target/debug/deps/ulsd-029c8a0ae72f691b)
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.16s
     Running unittests src/main.rs (target/debug/deps/ulsd-5b85f6dec05332a6)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/drive_integration.rs (target/debug/deps/drive_integration-538581f2e731b3f5)
test native_nfs_mount_vfs_writes_and_watch ... ignored, requires macOS native mount_nfs privileges; run explicitly
test result: ok. 4 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 2.16s
     Running tests/m3_parity.rs (target/debug/deps/m3_parity-e0c633435302e80b)
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.81s
     Running tests/no_secrets_in_logs.rs (target/debug/deps/no_secrets_in_logs-f9ea381fc4acc541)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
     Running tests/protocol.rs (target/debug/deps/protocol-12ff668971cc7073)
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/server.rs (target/debug/deps/server-ed78e515b05377de)
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s
     Running tests/token_provider.rs (target/debug/deps/token_provider-f2c95ae939cd3c5c)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
   Doc-tests uls_auth
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests uls_chunk
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests uls_client
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests uls_mock
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests uls_proto
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests uls_vfs
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests ulsd
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

## SMB debug build

`cd engine && cargo build -p ulsd --features smb` — exit 0.

```text
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 6.69s
```
## End-to-end

`bash tests/e2e/run.sh` — exit 1 at sandbox preflight:

```text
FAIL | setup local Workers + D1 | sandbox-exec unavailable; set E2E_MANAGED_SANDBOX=1 only when the parent sandbox denies writes to ~/Library/Caches/com.unlispace  undefined !== '1' 
RESULT: 1 passed, 1 failed
```
`E2E_MANAGED_SANDBOX=1 bash tests/e2e/run.sh` — exit 1, repeated with the same result. The parent sandbox denies writes to the user cache, as required by this harness option. No harness files were edited.

```text
PASS | setup local Workers + D1 | Wrangler 4.152.0; api :8788, data :8787, inspector :9230; D1 migrated
PASS | cloud 01 otp start | 
PASS | cloud 02 dev OTP logged | 
PASS | cloud 03 wrong code -> 400 | 
PASS | cloud 04 verify -> session, accountCreated | 
PASS | cloud 05 My Space + ready drive via service binding | 
PASS | cloud 06 write drive token minted | 
PASS | cloud 07 data plane accepts API-signed token | 
PASS | cloud 08 shard PUT with drive token | 
PASS | cloud 09 commit | 
PASS | cloud 10 version actor = token user id | 
PASS | cloud 11 drive A token on B -> 404 | 
PASS | cloud 12 read token cannot commit -> 404 | 
PASS | cloud 13 API access token on data plane -> 401 | 
PASS | cloud 14 refresh rotates | 
PASS | cloud 15 reused old refresh token -> 401 | 
PASS | cloud 16 reuse revokes whole refresh family | 
PASS | engine CLI put/get byte-identical | 3 unique shards uploaded; 8388608 bytes compared
PASS | engine dedup re-upload sends zero shards | 0 of 3 shards uploaded
PASS | engine 4 KiB edit uploads exactly one shard | 4096 bytes edited; 1 of 3 shards uploaded; bytes verified
PASS | engine CLI versions + historical get | three ordered versions; first version bytes verified
PASS | engine CLI restore creates new head | new version; original bytes restored
PASS | engine concurrent ifVersion has exactly one winner | exit codes 0,2; one new version; winner bytes verified
PASS | engine second CLI client watches change in < 1 s | 28.9 ms from writer invocation to exact version observed
FAIL | engine native read-only NFS mount + byte-identical read | NFS mount exited: NFS server for drive d-01m5st2gktd8z07p0jxcrz3dp0 listening on 127.0.0.1:61587 mount command: mount_nfs -o port=61587,mountport=61587,nolocks,vers=3,tcp,rdonly,actimeo=1 localhost:/ /private/tmp/unlispace-e2e.U7LEaT/mount mount_nfs failed (exit status: 5): Shimming not enabled - defaulting to legacy behavior. mount_nfs: Loading com.apple.filesystems.nfs status = 0x44c The server 
FAIL | smb daemon auth.set + drives.list + native mount | daemon request rejected: internal: cannot mount loopback SMB share; Shimming not enabled - defaulting to legacy behavior. 
FAIL | smb text save -> independent remote bytes within 10 s | requires a verified SMB mount
FAIL | smb cp random 8 MiB -> independent remote bytes within 10 s | requires a verified SMB mount
FAIL | smb mkdir -p + mv -> remote bytes and old path gone | requires SMB mount
FAIL | smb rename over existing safe save -> remote replacement | requires a verified SMB mount
FAIL | smb rm -> previously published remote file gone within 10 s | requires SMB mount
FAIL | smb xattr write/read preserves file bytes | requires SMB mount
FAIL | smb remote CLI commit -> mount + change event within 5 s | requires SMB mount
FAIL | smb concurrent edits -> conflict event + both remote contents survive | requires SMB mount
FAIL | smb drive.unmount + daemon shutdown leaves no mounts | requires SMB mount
PASS | cleanup | owned processes stopped; no NFS/SMB mounts remain; shell trap removes temporary data
RESULT: 25 passed, 11 failed
```
## Not verified / handoff

Formatting cannot be checked without the missing component. The native mount and real Keychain tests remain unverified: native NFS/SMB commands fail in this environment (NFS extension status 0x44c; shimming unavailable). Live services were not called. Full rollback across directory renames depends on the descendant history work described in NEEDS.md. Pins snapshot the path when requested; re-pin to fetch a new remote head.

Apply PROTOCOL-ADDITIONS.md to the Mac protocol at integration. Large raw signed-in `show` output is buffered over the internal CLI socket; only small fixtures were exercised for that transport.
