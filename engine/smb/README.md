# uls-smb

Isolated Rust workspace containing the Unlispace SMB library, `smb-demo`, and an
MIT-licensed protocol-server fork. **The native macOS mount acceptance gate is
blocked on this machine; this is not a verified production mount adapter.** The
server and backend have been exercised over real loopback TCP.

## Architecture

```
macOS smbfs / test client
    -> loopback TCP, Direct TCP framing, SMB2/3
    -> vendor/smb-server: authentication, crypto, credits, compounds,
       access/share checks, open tables, byte locks, async notifications
    -> src/adapter.rs: dispositions, paths, streams, per-open flush and watches
    -> SmbBackend
       -> MemBackend (demo/tests)
       -> daemon VFS/journal/cloud implementation (integration seam)
```

`serve(Arc<dyn SmbBackend>, encrypt)` binds **127.0.0.1:0**, generates one random
username and a 192-bit random password, and returns `RunningServer` with the bound
address, credentials and an awaited shutdown method. Credentials are not logged.
The ULS share requires authentication; anonymous and incorrect-password logons
are denied. Signing is required. Pass `true` to require session encryption.
Dropping the server requests shutdown; await `shutdown()` to finish backend closes.

The adapter disables leases and durable handles: the daemon can change data
outside SMB, and granting client caches without correctly breaking every such
lease would return stale data. Per-open path references follow protocol renames;
rename waits for in-flight operations using those paths. CREATE and stream
read/modify/write operations are serialized. Share modes, delete-pending state
and byte locks are enforced by the protocol server across connections.

`MemBackend` has stable node IDs, atomic tree mutations, sparse writes, persistent
in-memory times/read-only state, xattrs and broadcast notifications. It limits each
file/attribute to 50 MiB and total data/xattr contents to 128 MiB. It is volatile;
its flush verifies that the node exists, with no durability claim.

### Upstream decision and licensing

Vendored `smb-server` 0.7.0 from
[paltaio/rust-smb-server](https://github.com/paltaio/rust-smb-server/tree/ac13f304c20d6ada43db3cb693835acae193965f),
revision `ac13f304c20d6ada43db3cb693835acae193965f`. The crate and repository are
the same implementation. Existing signing, encryption, NTLMv2, locks, compounds,
credit accounting, async cancellation and tests made extending it preferable to a
new MS-SMB2 implementation. No AGPL code was used.

The original [MIT notice](vendor/LICENSE) and source notices are preserved.
[UPSTREAM.md](vendor/UPSTREAM.md) lists local changes. All RustCrypto requirements
are exact pins in Cargo.toml; Cargo.lock fixes transitive versions. The host
filesystem backend is enabled only for test coverage, not used by the demo.
Rust 1.99 or later is required by the fork's updated atomic APIs.

## Supported protocol

Negotiates SMB 2.1 and 3.0.2, plus upstream 2.0.2, 3.0 and 3.1.1 support. The latter
allows testing GCM without incorrectly advertising GCM for SMB 3.0.2.

| Area | Implemented behavior |
| --- | --- |
| Connection | NEGOTIATE, NTLMv2/SPNEGO SESSION_SETUP, LOGOFF, TREE_CONNECT, TREE_DISCONNECT, ECHO |
| Files | CREATE, CLOSE, READ, WRITE, FLUSH; open/create/open-if/overwrite/overwrite-if/supersede; directory/non-directory and delete-on-close options; write-through flushes |
| Queries | QUERY_DIRECTORY with paging, restart and SMB/DOS wildcard patterns; QUERY_INFO and SET_INFO |
| Coordination | Shared/exclusive byte-range LOCK/unlock, share-mode enforcement, CHANGE_NOTIFY, async STATUS_PENDING and CANCEL |
| IOCTL | FSCTL_VALIDATE_NEGOTIATE_INFO; upstream empty snapshot enumeration and appropriate DFS/error responses; unsupported controls fail cleanly |
| Transport | Credit windows, multi-credit requests, related and unrelated compounds, packet/offset/length checks |
| Security | HMAC-SHA256 for SMB2, AES-CMAC plus derived keys for SMB3; AES-128-CCM for 3.0.2; negotiated CCM/GCM for 3.1.1; AEAD integrity checking |

| Information kind | Classes |
| --- | --- |
| File query | Basic (4), Standard (5), Internal (6), EA (7), Access (8), Position (14), Mode (16), Alignment (17), All (18), Stream (22), NetworkOpen (34) |
| File set | Basic (4), Rename (10), Disposition (13), Allocation (19), EndOfFile (20) |
| Directory query | Directory (1), FullDirectory (2), BothDirectory (3), Names (12), IdBothDirectory (37), IdFullDirectory (38) |
| Filesystem query | Volume (1), Size (3), Device (4), Attribute (5), FullSize (7), SectorSize (11) |

No 8.3 names are synthesized. Full EA queries return no native EAs; macOS xattrs
are named streams. FileNameInformation is not supported for remote queries.
Allocation reductions can shorten a file; larger allocations are advisory.
Read-only attributes and the four FILETIME timestamps are supported by MemBackend;
unsupported DOS attribute bits return STATUS_NOT_SUPPORTED.

### Named streams and notifications

`file:stream:$DATA` and `file:stream` map to backend xattrs. `file::$DATA` opens the
normal data fork. Stream names are allowed only in the final path component and
only for backends opting into named streams. Stream enumeration includes proper
sizes, alignment and next-entry offsets; filesystem attributes advertise streams.

- `AFP_AfpInfo` maps the 32 FinderInfo bytes at offsets 16..48 of Apple's 60-byte
  AFP stream to `com.apple.FinderInfo`; the signature, version and unset backup
  time are synthesized.
- `AFP_Resource` maps to `com.apple.ResourceFork`.
- Other names, including `com.apple.*` and `com.test`, map directly.
- Stream writes support byte offsets; deletes call `remove_xattr`.

A watched handle subscribes to `SmbBackend::subscribe()`. Committed events are
translated to directory changes, including rename old/new names. Broadcast lag
requests a directory rescan instead of silently losing notifications. Upstream
watch buffering coalesces protocol/backend echoes and handles cancellation.

## Mounting without a password in ps

`mount(addr, user, pass, mountpoint)` checks IPv4 loopback, resolves the mountpoint
with `std::fs::canonicalize` (realpath), and uses a small C bridge to Apple's
SMBClient framework. The bridge opens an authenticated **session only**, with an
nsmb URL `//escaped-user:escaped-password@127.0.0.1:PORT/ULS` held entirely in memory.
It sets NoPrompt, NoUserPreferences and ForceNewSession, with guest disabled.

The helper keeps that session alive while invoking:

```
/sbin/mount_smbfs -N -o soft //escaped-user@127.0.0.1:PORT/ULS REAL_MOUNTPOINT
```

The child can reuse the authenticated kernel session. The password is absent from
argv and environment; no credential file, temporary home or nsmb.conf is written,
and no Keychain-writing command is used. Session/library handles are released on
success and failure. `unmount` canonicalizes the path and calls `/sbin/umount`.

Research: Apple's actual
[mount_smbfs implementation](https://github.com/apple-oss-distributions/SMBClient/blob/main/mount_smbfs/mount_smbfs.c)
uses `SMBOpenServerEx` and SMBClient mount APIs. Its
[SMBClient API definitions](https://github.com/apple-oss-distributions/SMBClient/blob/main/lib/smbclient/smbclient.h)
define the session/no-prompt/no-preferences flags. A bare `-N` has no secret-input
file-descriptor option. The public NetFS credential-in-memory alternative is
`NetFSMountURLSync(url, mountpath, user, passwd, options, ...)`, documented in the
installed SDK's `NetFS.h`. That route was tried first and returned -6600 before any
TCP connection. The session-priming/CLI route also fails before TCP here, so its
successful session reuse still needs validation on an unrestricted native run.
The bridge dynamically loads a private system framework and returns ENOSYS if its
symbols are unavailable; compatibility across macOS releases needs testing.

## Run

From this directory, keep build scratch and Cargo downloads within the task scope:

```sh
mkdir -p .tmp
export CARGO_HOME="$PWD/.cargo-home"
export TMPDIR="$PWD/.tmp"
cargo build
cargo clippy -- -D warnings
cargo test
cargo run -p uls-smb --bin smb-demo -- .tmp/mount
# Require encryption:
cargo run -p uls-smb --bin smb-demo -- .tmp/mount --encrypt
# Create a file directly in the backend three seconds after mounting:
cargo run -p uls-smb --bin smb-demo -- .tmp/mount --backend-event-after 3
# Reproducible native mount/shell/lock/hash/change-notify checks:
python3 scripts/macos-smoke.py
```

The demo seeds `hello.txt` and `Documents/readme.txt`, prints the actual port,
mounts, and unmounts on Ctrl-C before stopping the server. If unmount fails, it
keeps serving and lets Ctrl-C retry after applications release their files. It
removes a mountpoint only when it created that directory. `--serve-only` runs the
server without mounting, for diagnostics; credentials remain available through
the library API, not console output.

The native smoke script checks that the path really is mounted before writing
anything. It exercises ls/cat, copies both directions, mv/rm, recursive mkdir,
xattr, a 50 MiB dd/shasum round trip, flock/lockf conflicts through Python's fcntl,
backend appearance within two seconds, and unmount. It records a blocked result
when mounting fails. It does not substitute local-directory success for SMB.

## Verification on this Mac

Tested 2026-10-25 on macOS 26.5.1 (25F80), arm64, rustc 1.99.1.
Build/lint/test results and native failure excerpts are recorded in
[VERIFICATION.md](VERIFICATION.md). No sudo, settings or /etc edits, or git commits
were performed. The requested `/tmp/uls-smb-test` path was replaced by a path under
this directory to honor the user's stricter write boundary. Test data never
exceeded 50 MiB per file. Target size remained below 3 GiB.

## Known gaps and daemon integration

- **Native mount/Finder acceptance is unverified.** Both Apple's direct CLI and
  library reject SMB initialization on this host before negotiation; a successful
  macOS mount, password-free CLI session reuse, shell operations and real unmount
  are required before shipping.
- No AAPL create-context extensions, macOS POSIX extensions, ACLs, hard links,
  symlinks, named-stream renames, persistent/resilient handles, multichannel,
  compression, DFS hosting or discovery. Unsupported operations return errors.
- AFP_AfpInfo has fixed synthetic header semantics; truncating/overwriting it as
  an ordinary zero-length stream is rejected. Normal macOS FinderInfo open/write
  semantics and resource/generic stream operations are implemented, but native
  Finder behavior remains unverified.
- The path-only backend contract cannot retain the old inode when replacing an
  open destination. The adapter refuses that rename with sharing violation rather
  than redirecting the destination's handles. External rename/unlink of files with
  live handles also requires daemon coordination or a future inode/handle API.
- External notifications currently watch direct directory entries. Protocol-origin
  recursive notifications are supported by upstream; recursive external-only
  changes need further watch integration. Leases remain disabled.
- Volume capacities currently use upstream synthetic VolumeInfo defaults, not a
  cloud quota. MemBackend bounds are enforced even though those numbers differ.
- Streams use whole-xattr read/modify/write and are serialized; large resource
  forks need a ranged backend API for efficient cloud I/O. No throughput or sleep/
  reconnect qualification is claimed. In-memory locks end with the connection.

The daemon must implement every method in [SmbBackend](src/backend.rs): lookup,
readdir, ranged read, create, ranged write, truncate, atomic rename/replace,
remove, flush, all four xattr operations, and subscribe. Implement the default
`set_metadata` method to preserve copy timestamps and read-only state. Root is
`""`; other paths are share-relative UTF-8 with `/` separators, without traversal
or stream syntax. Supply stable IDs across opens/listings/renames, correct file
kinds/sizes, and FILETIME values. Return precise FsError values. Make mutations
atomic, preserve data on failure, and publish events **after** committing them.

`flush` is the durability boundary for SMB2 FLUSH and close of a modified handle,
including size changes. Map it to the daemon's durable journal/usage policy and
return failures rather than reporting success early. Explicit CLOSE propagates
those errors; disconnect cleanup logs them. The daemon must retain failed work
for recovery. Map FinderInfo/ResourceFork to their native xattr names and prevent
out-of-band mutations from racing live path-based handles. Call `serve` with an
Arc of that backend, mount with its per-run credentials, then unmount and await
server shutdown in that order.
