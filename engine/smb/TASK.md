# Task (Codex): SMB2/3 loopback server for the Unlispace Mac drive

You are building the production macOS mount adapter for **Unlispace**, a versioned cloud drive
(clone of spacefs.com). macOS mounts the drive with its built-in `smbfs` client against a server
we run on `127.0.0.1`. That gives us real locks, xattrs/named streams, change-notify and no
user-approval toggle. Design rationale: `docs/research/spacefs/macos-fs-options.md` §SMB, and
`docs/design/product-design.md` §5.2.

## Scope: work ONLY in `engine/smb/`
`engine/smb/` is excluded from the main Cargo workspace (`exclude = ["smb"]` in
`engine/Cargo.toml`), so make it its **own Cargo workspace** with a root `Cargo.toml`. Other agents
are editing the rest of `engine/`, `cloud/`, `web/` and `mac/` right now. Do not touch them. You
may *read* anything.

## Deliverable: a crate `uls-smb` (library + `smb-demo` binary)
1. **Backend abstraction.** This is the seam the daemon plugs into later:
   ```rust
   #[async_trait] pub trait SmbBackend: Send + Sync + 'static {
       async fn lookup(&self, path: &str) -> Result<Attr, FsError>;
       async fn readdir(&self, dir: &str) -> Result<Vec<DirEntry>, FsError>;
       async fn read(&self, path: &str, off: u64, len: u32) -> Result<Bytes, FsError>;
       async fn create(&self, path: &str, kind: Kind) -> Result<Attr, FsError>;
       async fn write(&self, path: &str, off: u64, data: &[u8]) -> Result<u32, FsError>;
       async fn truncate(&self, path: &str, size: u64) -> Result<(), FsError>;
       async fn rename(&self, from: &str, to: &str, replace: bool) -> Result<(), FsError>;
       async fn remove(&self, path: &str) -> Result<(), FsError>;
       async fn flush(&self, path: &str) -> Result<(), FsError>;   // SMB2 FLUSH + close of a written handle
       async fn get_xattr / set_xattr / list_xattr / remove_xattr(...);
       fn subscribe(&self) -> tokio::sync::broadcast::Receiver<ChangeEvent>; // for CHANGE_NOTIFY
   }
   ```
   Include a `MemBackend` (in-memory tree) used for tests and the demo.
2. **SMB server**: SMB 2.1/3.0.2 dialects over TCP on 127.0.0.1, ephemeral port, sufficient for
   macOS `mount_smbfs` and Finder:
   - NEGOTIATE, SESSION_SETUP (NTLMv2 against a single per-run random user and password; no guest), LOGOFF
   - TREE_CONNECT (one share, `ULS`), CREATE (all dispositions and options macOS uses), CLOSE, READ,
     WRITE, FLUSH, QUERY_DIRECTORY, QUERY_INFO / SET_INFO
     - file info classes macOS uses: basic, standard, network open, all, rename, disposition,
       end-of-file, allocation
     - fs info classes: volume, size, full size, attribute, device
   - LOCK (byte ranges, in-memory), IOCTL (at least FSCTL_VALIDATE_NEGOTIATE_INFO, and fail others cleanly)
   - CHANGE_NOTIFY driven by `subscribe()`, ECHO, CANCEL
   - Named streams / xattrs as macOS sends them (AFP_AfpInfo, AFP_Resource, com.apple.* via
     streams), mapped to the backend's xattr API
   - Credits and compounding as macOS requires. SMB signing must work (macOS 14+ requires it by
     default), and so must SMB3 encryption where needed. Use RustCrypto crates for HMAC-SHA256,
     AES-CMAC, AES-128-CCM/GCM and MD4/MD5 for NTLM. Pin exact versions.
   - Evaluate the MIT-licensed `rust-smb-server`/`smb-server` crates. Fork or vendor them if they
     help, keeping the licence notices, or write from MS-SMB2 if they're too incomplete. Say which
     you chose and why. Never use AGPL code (e.g. go-smb2).
3. **Mount helper**:
   - `uls_smb::mount(addr, user, pass, mountpoint)`: canonicalise the mountpoint with realpath,
     because macOS refuses symlinked mountpoints. Mount with `mount_smbfs -N` and a nsmb-style URL
     `//user:pass@127.0.0.1:PORT/ULS`. Pass the password so it never appears in `ps`: use a
     NetFS-compatible method, or a temp `~/Library/Preferences/nsmb.conf`-free approach. Research
     the right one and document it.
   - `unmount(mountpoint)`.
4. **`smb-demo` binary**: serves a `MemBackend` seeded with a few files. It prints the port and mounts
   at a given path, and on Ctrl-C unmounts.

## Verification (you must actually run these on this Mac: macOS 26.5.1, arm64)
- `cargo build`, `cargo clippy -- -D warnings` and `cargo test` pass. Unit tests cover NTLMv2
  (MS-NLMP test vectors), signing (MS-SMB2 test vectors), and packet codec round-trips.
- `smb-demo /tmp/uls-smb-test` mounts, and then in the shell:
  - `ls -la`, `cat`, `cp` in and out, `mv`, `rm`
  - `mkdir -p a/b/c`
  - `xattr -w com.test x f && xattr -p com.test f`
  - `dd` 50 MiB write + `shasum` read-back
  - `flock`/`lockf` basic
  - a file appearing in the backend after mount shows up in `ls` within 2 s (change-notify)
  - unmount works.
- Report anything macOS rejected, with the server log excerpt.
- Do NOT use sudo, do not change System Settings, do not modify `/etc`, don't commit to git.
  Clean up mountpoints and temp files. Disk space is tight (about 7 GB free): `cargo clean` if
  `target/` exceeds 3 GB, and keep test files ≤ 50 MiB.

## Final output
`engine/smb/README.md` (architecture, supported commands and info classes, known gaps, how to run
the demo), plus a final report: what works, test output summary lines, which macOS operations
failed, and what the daemon needs to implement for `SmbBackend`.
