# Verification report

Run date: 2026-10-25. Host: macOS 26.5.1 (25F80), arm64.
Toolchain: rustc 1.99.1 (58cf8f9c3 2026-10-13).
All generated files, downloaded dependencies, build products, logs and test
scratch were confined to engine/smb/. No sudo, settings changes, /etc edits,
credential files or git commits were used.

## Build, lint and tests

Commands used an isolated CARGO_HOME and TMPDIR under engine/smb/.

| Command | Actual result |
| --- | --- |
| `cargo build` | PASS, exit 0 |
| `cargo clippy -- -D warnings` | PASS, exit 0 |
| `cargo test` | PASS, exit 0; 803 passed, 0 failed, 0 ignored across 48 test binaries/doc-test groups |
| `python3 scripts/macos-smoke.py` | BLOCKED, exit 1: mount fails before any filesystem operations |

Final build/lint summary lines:

```
Finished `dev` profile [unoptimized] target(s) in 2.55s
Finished `dev` profile [unoptimized] target(s) in 1.39s
```

Representative final test summary lines:

```
test result: ok. 478 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.52s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 17.26s
```

The precise timings and full output are in [test.log](verification/test.log).
[Build output](verification/build.log) and [strict Clippy output](verification/clippy.log)
are retained. Platform-gated upstream tests for other operating systems were not
executed on this Mac.

### What passed

- MS-NLMP NT hash, NTOWFv2, proof, session-key, and authentication known-answer
  tests; incorrect password and anonymous NTLM logons denied on the ULS server.
- Microsoft Open Specifications published SMB signing-key/signature vectors,
  HMAC-SHA256/AES-CMAC signing, tamper checks, packet codec round trips, framing,
  credit-window and compound tests.
- Authenticated signed SMB 2.1 read/write/flush/close on MemBackend.
- AES-128-CCM encrypted SMB 3.0.2 and AES-128-GCM encrypted SMB 3.1.1 I/O against
  the ULS backend, plus upstream encryption/rejection cases.
- All six file CREATE dispositions; nested a/b/c directories; read/overwrite;
  rename and continued I/O through the renamed handle; delete-on-close;
  directory listing; basic/end-of-file/allocation information updates; required
  file and filesystem query classes.
- Generic xattr streams, AFP_AfpInfo FinderInfo translation, AFP_Resource mapping
  and removal; signed related CREATE/WRITE/CLOSE stream compounds, including
  overwrite with a shorter value.
- FSCTL_VALIDATE_NEGOTIATE_INFO and CANCEL of a pending signed notification.
- Two handles contending for an exclusive byte-range lock: conflict denied,
  unlock then acquisition succeeds.
- A 50 MiB signed TCP write/read round trip, SHA-256 checked. The file existed
  only inside MemBackend; no native dd/shasum claim is made.
- Direct backend addition delivered to a pending signed CHANGE_NOTIFY within
  the two-second test timeout. This checks the subscription bridge, not Finder's
  directory cache.
- Injected commit failures returned STATUS_UNEXPECTED_IO_ERROR from both FLUSH
  and CLOSE, including close after a size change; data was not silently removed.
- Graceful server shutdown and rejection of invalid/non-loopback mount inputs.

## What macOS rejected

The final demo attempt used the canonical path beneath
`engine/smb/.tmp/macos-smoke/mount`; the requested `/tmp/uls-smb-test` example was
not used because the user explicitly restricted every write to engine/smb/.

The native SMBClient session-opening call failed with errno **6 (ENXIO,
Device not configured)**. Independently invoking Apple's CLI also failed:

```
Shimming not enabled - defaulting to legacy behavior.
mount_smbfs: failed to intitialize the smb library: Device not configured
Exit: 69
```

The public NetFSMountURLSync route was also actually tried earlier. It returned
**OSStatus -6600 (NetAuth internal error)** before a TCP connection. No password
was placed in process arguments for either credential-bearing attempt. The
independent CLI probe contained a username only and was intended to check SMB
library initialization, not to authenticate.

Final server/demo excerpt:

```
SMB listening on 127.0.0.1:60859 (share ULS, signing required, encryption false)
2026-10-25T09:14:41.623066Z  INFO smb_server{listen=Some(127.0.0.1:60859)}: smb_server::server: server starting
Shimming not enabled - defaulting to legacy behavior.
2026-10-25T09:14:41.626546Z  INFO smb_server{listen=Some(127.0.0.1:60859)}: smb_server::server: shutdown requested; stopping accept loop
2026-10-25T09:14:41.626821Z  INFO smb_server{listen=Some(127.0.0.1:60859)}: smb_server::server: server stopped
Error: "mount failed: SMBOpenServerEx: Device not configured (os error 6)"
```

No connection/NEGOTIATE reached the server during these native mount attempts.
Loopback TCP binding and the Rust clients worked. These observations locate the
failure before SMB negotiation; they do not establish the underlying macOS or
execution-environment cause.

| Requested native operation | Result |
| --- | --- |
| smb-demo mount | FAILED as above |
| ls -la / cat / cp in and out / mv / rm | BLOCKED by failed mount |
| mkdir -p a/b/c | BLOCKED by failed mount |
| xattr -w com.test x f / xattr -p com.test f | BLOCKED by failed mount |
| dd 50 MiB + shasum read-back | BLOCKED by failed mount |
| flock / lockf through the mounted filesystem | BLOCKED by failed mount |
| Backend file visible in mounted ls within two seconds | BLOCKED by failed mount |
| Real mounted-volume unmount | BLOCKED: no mount existed |

The smoke script guards against running these on an ordinary local directory.
The separate wire tests are useful protocol evidence, not replacements for the
native acceptance gate. Finder, macOS cache behavior and successful credential-
primed `mount_smbfs -N` session reuse remain unverified.

## Cleanup and daemon handoff

The diagnostic listener was stopped through its original process session. lsof
showed no remaining smb-demo listening socket, and mount showed no volume under
engine/smb/. Mountpoint directories and temporary research/test files were
removed. Target remained below 3 GiB, so the task's cargo-clean threshold was
not reached. Only normal build/dependency caches and the intentional verification
logs remain.

The daemon must supply SmbBackend's file/tree/range-I/O and xattr operations,
stable IDs, metadata, atomic rename/remove semantics, a durable flush, and committed
ChangeEvents via broadcast. Implement set_metadata for timestamps/read-only flags.
Coordinate external rename/unlink with live path-based handles. Quota reporting,
recursive external notifications, lease invalidation and native mount/Finder
qualification remain integration work described in [README.md](README.md).

**Acceptance status: build/lint/tests pass; native mounting and all mounted-shell
acceptance checks remain incomplete. Do not ship this as a qualified production
macOS drive adapter.**
