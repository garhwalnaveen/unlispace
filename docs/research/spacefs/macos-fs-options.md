# macOS filesystem technology for a Space-style streaming cloud drive

Research date: 25 October 2026. The current macOS releases are 27.0.1 (shipped 28 Sep 2026), with 27.2 at RC (19 Oct 2026). The research machine runs macOS 26.5.1.
Scope: research only. Where a claim comes from my own inference or memory and not from a source, it is marked **[inference]** or **[unverified]**.

---

## 0. TL;DR

| | Approval needed | Partial (byte-range) reads | Performance | App compatibility | Min macOS | Effort |
|---|---|---|---|---|---|---|
| **FSKit** (FSUnaryFileSystem + FSGenericURLResource) | Yes. Each user flips a toggle in System Settings. An installer can't do it, and MDM can't either (no payload exists). | Yes. Every read goes through the extension. | Every op crosses NSXPC on a serial queue. Apple says the read/write path is "not great" and unoptimised. f_iosize is capped at 1 MB. Kernel offload is block-device only. | Good when it works, but there are open bugs: fsync never reaches the module, locks are kernel-local, RENAME_SWAP corrupts data, root invalidation is broken. Apple DTS (Aug 2026): "isn't currently at a place where it can properly support a network file system". | 26.0 for URL resources. **27.0** for the cache-coherency API (DataCacheHandler). 27.2 fixes negative-lookup pinning. | Medium code, high debugging and operations cost |
| **File Provider** (Replicated) | One-time domain/extension enable, low friction | Only for uncoordinated POSIX reads. Finder opens and coordinated reads download the whole file. | Materialized files run at APFS speed. Cold opens of big files are slow. fileproviderd struggles with very large trees. | Poor for pro apps: CloudStorage path, Final Cut libraries unsupported, case-insensitivity collisions, materializes to local disk. | 12.3 for partial fetch | High, and it still fails the zero-bytes requirement |
| **macFUSE** (kext / FSKit backend) | kext: Recovery-mode Reduced Security plus reboot. FSKit backend: same toggle as FSKit. | Yes | kext is the best. FSKit backend is "not on par". | kext is excellent | kext: any version. FSKit backend: 15.4/26. | Low code, but there's a commercial licence and the kext is a consumer UX non-starter |
| **FUSE-T** (NFSv4/SMB loopback) | None, apart from TCC "Network Volumes" prompts | Yes | NFS-client bound | Network-volume semantics. Locks bypass FUSE. atime/mtime can't be set separately. | ~12+ [unverified] | Low code. Commercial licence required. |
| **Loopback SMB** (own server, kernel smbfs client) | None. Per-app TCC "Network Volumes" prompt, which MDM can pre-approve via PPPC. | Yes | Kernel smbfs: page cache, leases, read-ahead. Good. [no published numbers] | Good. SMB NAS is a well-trodden pro-app path. Real byte-range locks, xattrs via streams, change-notify for remote updates. | Any supported version | **High**: you need to own an SMB2/3 server |
| **Loopback NFSv3** (nfsserve) | None, apart from TCC prompts | Yes | OK. No close-to-open on macOS, so invalidation needs hacks. | Weakest: no xattrs, local or no locks, hangs if the server dies | Any | Low to medium. A mature crate already exists. |

**Recommendation in short:** use the same two-adapter architecture as Space (one Rust core, mounted through FSKit and loopback SMB), but **invert the v1 default**. Make loopback SMB the default mount in v1 for both the app and headless use. Ship FSKit as an opt-in "native mode" on macOS 27.2+, and make it the default only after Apple fixes root-directory invalidation and fsync routing and our app-compatibility matrix passes. Keep an NFSv3 (nfsserve) adapter as a cheap emergency fallback. The reasoning is in §7.

---

## 1. What Space does (confirmed from its docs)

From docs.spacefs.com (`/start/mount/`, `/guides/mount-from-a-program/`, `/llms-full.txt`):

- Mac app: "Install the Space app. It mounts your drives for you, and puts the same `space` command on your path". The app's `space` "is a link into the app bundle".
- Standalone macOS CLI: "serves a mount from its own process over a loopback SMB share, so it needs no driver, no kernel extension and no root". There is "no mount daemon, since a mount is served from the CLI's own process".
- Why the SDK picks SMB over `auto`: "`auto` means FSKit there, and FSKit needs an installed app extension that someone has switched on in System Settings — by Space's own installer notes, a toggle an installer cannot flip". Also: "(The Space app itself does use FSKit; this is a deliberate divergence.)"
- Adapter enum: `"auto" | "fuse" | "fskit" | "winfsp" | "smb" | "nfs"`. On Linux, "`auto`… means FUSE with the NFS loopback as fallback". The supervised Linux path is FUSE3 only, with "no NFS fallback, by design". Windows uses WinFSP.
- Symlinks: "macOS refuses a mount reached through one and reports almost nothing about why, so the SDKs resolve it for you".
- Data model: "Writes land in a local journal first, so an application's save returns at local speed… published to the drive in the background". Shards are "cut with FastCDC at about 2 MiB (256 KiB at the least, 16 MiB at the most) and named by the SHA-256 of their bytes", so "a cached shard can never be stale". Remote changes are "visible within seconds". Cross-region propagation is "well under a second, and at most about two".
- Cache budget: several independent caches. `SPACEDB_SHARD_CACHE_MB` defaults to 256 MiB "charged on top of `--cache-bytes`".
- Their GitHub org has no public repos, so I couldn't confirm the forked rust-smb-server or the Swift FSKit shim from source. The teardown's claims are consistent with the docs.

---

## 2. Option 1: FSKit

### 2.1 Versions and API surface
- FSKit framework and `FSUnaryFileSystem`, `FSVolume`, `FSClient`, `FSExtentPacker` and the `com.apple.developer.fskit.fsmodule` entitlement: **macOS 15.4** (release notes: "enabling delivery of user space file systems as Application Extensions… support integration with DiskArbitration").
- `FSPathURLResource` and **`FSGenericURLResource`**: **macOS 26.0**. The FSGenericURLResource docs: "might represent… some sort of network address for a remote file system. FSKit leaves interpretation of the URL… entirely up to your implementation". You declare schemes with the `FSSupportedSchemes` Info.plist key. This is what makes "pathless" network filesystems possible. On 15.x only block devices are supported.
- `FSVolume.MountOptions` / `requestedMountOptions`: 26.4 (per the 26.4 release notes; the docs originally said 26.0). Read-only marking works from 26.5 beta 2 (forum 807771).
- **macOS 27.0** adds handler-style protocols (`FSVolume.Handler`, `ReadWriteHandler`, `XattrHandler`, `AccessCheckHandler`, `SeekRegionHandler`, …), and the old `*Operations` protocols are deprecated. It also adds **`FSVolume.DataCacheHandler`** (kernel cache coherency: open with a cache mode, reply `noCache/readCache/writeThrough/writeBack`, and `setCacheState(... push/pushInvalidate/invalidate)` for lease-break-style invalidation), `KernelOffloadedIOHandler`, and `FSClient.mountSingleVolume(resource:bundleID:options:)`. That last one needs the `com.apple.developer.fskit.mount` entitlement and mounts under `/Volumes/`.
- **FSUnaryFileSystem vs FSFileSystem.** The docs say "The current version of FSKit supports only `FSUnaryFileSystem`". `FSFileSystem` (multi-volume) appears only in the ObjC docs and isn't usable. Unary means one resource maps to one volume. For us that's one mount per drive (or one per account with drives as top-level folders), which is fine.

### 2.2 Network / pathless support: possible, but Apple says it isn't ready
- Apple DTS (Kevin Elliott, forum 842736, Aug 2026, replying to a developer who built an SMB client on FSKit on 27.0): "FSKit isn't currently at a place where it can properly support a network file system. It's certainly closer this year than it was last year, but it's not really 'there' yet… FSKit's basic function is to replace the in-kernel VFS layer, a task which it clearly cannot yet do." He said it is fine for read-only, relatively static network cases.
- The same thread lists bugs and missing features, each with an in-memory repro:
  - `RENAME_SWAP` reports success but **destroys the destination**, because the module never sees the flags (FB24419773). Apple accepts it as a bug. Apps that use atomic swap saves (`renamex_np`) are at risk. [inference: depends on which apps use it]
  - Negative lookups were cached for the vnode's lifetime (FB24419825). **Fixed in 27.2**.
  - A data-cache grant race can leave the cache permanently stale (FB24419858).
  - `fsync`/`F_FULLFSYNC`/`sync` **never reach the module** on URL-backed volumes (FB24419870). Apple calls this architectural.
  - **flock/fcntl locks stay kernel-local**. There are no ACLs and no per-item "has xattrs" flag, so a cold `ls -l` of 500 entries costs about 2,000 crossings.
  - A failed `activate` wedges the resource URL until fskitd is killed (FB24419932).
  - **Root-directory `setCacheState` invalidation fails** (FB25077250, FB25243414, r.186984837). A top-level dir that is deleted and recreated remotely returns `ESTALE` until unmount. Apple calls it "high-priority" but it isn't fixed as of the thread.
- Before 27 there was no API to invalidate or reclaim items that change remotely. DTS (forum 799809): "The current API is focused on local storage where this kind of 'external modification' cannot occur, so the API support you need simply does not exist." macFUSE 5.5.0 adds a workaround on 26/27 that rejects empty reads with EIO, which "can cause read errors when a file's size changes remotely".
- **Implication: macOS 26 FSKit has no supported way to keep the kernel cache coherent with edits from other machines. 27.x is the realistic floor for "saves sync to other machines within seconds".**

### 2.3 Performance
- No kernel-offloaded data path for us. `FSExtentPacker.packExtent(resource: FSBlockDeviceResource, …)` only maps extents onto a block device. DTS: "you can't use it without a dev node". A request for FUSE_PASSTHROUGH-style file-backed passthrough is pending (FB22596726), with no commitment.
- Every UBC miss follows "pagein → IPC → extension read → copy → return" (forum 828533: about 630 cold read RPCs for one 440-file build action).
- DTS (799283): "We haven't done much to optimize the FSVolumeReadWriteOperations path, so its current performance is not great." A developer measured 100–150% CPU on FSKit against about 40% on the macFUSE kext for the same workload.
- DTS (831338): "All operations are received over NSXPC, on a serial queue… consider making the first step of any work be dispatching that work to a different queue." Apple tested a C-callable ops table and the results were "not great", so it won't happen.
- `f_iosize` is capped at 1 MB "primarily due to mach IPC details" (807771).
- DataCacheHandler negotiated mode adds open and close round trips per file. Unilateral mode (`isDataCacheInhibited`) removes them but also disables invalidation (forum 849057, FB24996000). That's a bad trade for a coherent network FS.
- macFUSE's FSKit backend got "up to 15 times faster" reads with zero-copy borrowed buffers (5.3.0). Implementation quality matters a lot, but macFUSE still says FSKit "I/O performance… is not on par" with the kext.
- **No published MB/s or latency figures for FSKit network-style volumes were found.** We need to benchmark ourselves on 27.x (sequential 4K–1M reads, mmap pagein, `git status` on 100k files, Xcode build).

### 2.4 Enablement and approval (exact steps)
From Apple's "Building a passthrough file system" sample:
1. Install the app (drag it to /Applications) and launch it once so LaunchServices registers the embedded `.appex`.
2. **System Settings → General → Login Items & Extensions → scroll to "Extensions" → "By Category" tab → "File System Extensions" → click ⓘ → toggle on "<Your FS>"**.
3. The app can open this pane with `FSClient.shared.openFileSystemExtensionsSettings()` and detect state with `fetchInstalledExtensions` (`FSModuleIdentity`).
4. Mount by running `/sbin/mount -F -t <FSShortName> <url> <mountpoint>` from the (non-sandboxed) app or helper, or with `FSClient.mountSingleVolume` on 27+.

Constraints:
- **Per-user** by design. The root LaunchServices DB is "typically very empty", and "our current consent/approval model only asks a user for approval for themselves" (831396). There's no global or pre-login enable (808594). Writing `~/Library/Group Containers/group.com.apple.fskit.settings/enabledModules.plist` is unsupported and may become MAC-protected.
- **MDM:** I cloned `apple/device-management` (27.0 schema) and found **no payload or key mentioning FSKit or file-system extensions**. `com.apple.NSExtension` only has allow and deny lists, which can block but not enable. `app.managed` `ExtensionConfigs` (27.0) only delivers config. **Enterprise pre-approval isn't possible today. File an ER.**
- CI: there's no unattended enable. Sign with a real Apple certificate so rebuilds count as updates and don't need re-toggling (831843). You need a persistent, pre-approved VM image.
- fskitd and LaunchServices desync was improved in 26.5. Installing via .pkg pre-registers the extension and confuses the "launch the app" path (831396).

### 2.5 Language
- The public API is ObjC/Swift (an ObjC framework with a Swift overlay). Rust options:
  - `objc2-fs-kit` (Rust bindings, crates.io). In theory you could write a pure-Rust appex, but you'd have to subclass ObjC classes from Rust and hand-assemble the appex bundle and entitlements. [inference: painful, not recommended]
  - `fskit-rs`: a Swift FSKitBridge appex that talks to a Rust engine over **localhost TCP + length-delimited protobuf**. That adds an extra hop on every op.
  - `fskit-native` (cachix/casita), `astrid-storage-provider-fskit`: other early Rust efforts.
- **Recommended:** a thin Swift appex that links a Rust `staticlib` through a C ABI (cbindgen or UniFFI) and runs the core **in-process**. Each FSKit callback immediately hops to a Rust/tokio worker and replies via the reply handler. Avoid the TCP bridge on the data path.

### 2.6 Other FSKit gotchas
- **Spotlight:** FSKit volumes mount as `local` and `mds_stores` will "go wild" indexing them (820931). For a streaming drive, that means **Spotlight would try to read the whole cloud**. Mitigation: put `.metadata_never_index` at the volume root (a DTS suggestion, unconfirmed) and/or run `mdutil -i off`. `-o nobrowse` is ignored (a bug).
- **Finder sidebar:** Finder hides FSKit mounts made under `~` by heuristic. Mount outside home or under `~/Library/Application Support/...`. There's no DiskArb-level mount API for non-block FS (FB22147846). Not listed in `diskutil` (expected).
- **App update or delete kills the extension and force-unmounts without `synchronize`** (809747). The workaround is to keep a (GUI-less) app process running while mounted so Finder and the App Store won't replace the bundle. A post-unclean-exit system hang is fixed in 26.4. [inference] With Sparkle, defer installs while mounted (install-on-quit, then flush the journal, unmount, then install).
- No caller PID or audit token in `FSContext`, and Security has refused to add one (808728).
- FileProvider won't run on an FSKit mount (841771).
- Case sensitivity, xattrs and Finder metadata: xattrs now go through `XattrHandler`. Without native xattrs, the 26.4 release notes describe special resource-fork handling.

---

## 3. Option 2: File Provider (NSFileProviderReplicatedExtension)

- Model: APFS dataless files under `~/Library/CloudStorage/<Provider>-<domain>`. "Reads trigger downloads, and files lose their dataless property before the reads are allowed to resume" (WWDC21 10182). The system evicts LRU uploaded files under disk pressure. Conflicts are resolved by the item returned from `modifyItem`, with server as truth plus APFS compare-and-swap.
- **Partial reads:** `NSFileProviderPartialContentFetching` (macOS 12.3) exists. **But:**
  - "To trigger a partial download, an app must use POSIX read operations… If you clone the entire file, or read the file using file coordination, the system requests the entire file." DTS (732730): opening a file in Finder always does a full download.
  - Ranges get written into the local file, so it's a **sparse local materialization**, not streaming. The bytes land on disk.
  - Reads of uncached ranges block in-kernel. With about 3 s TTFB, sequential readers time out. DTS (812794) advises treating partial fetch "NOT as a firm API contract" and kicking off a full download.
  - Size/extent mismatches produce EINVAL / `cannotMaterialize` (802063).
  - **Result: opening a 40 GB file from Premiere or Finder generally downloads all of it. That breaks the core promise.**
- Scale: Dropbox says accounts with more than 300k files "may sync more slowly". A forum report (842476) describes fileproviderd pegged in sqlite on a ~4 TB tree. EdenFS rejected FileProvider because "fsevents frequently drops events" at its repo sizes.
- App compatibility (Dropbox help): the folder is forced into `~/Library/CloudStorage` and can't be moved, "Final Cut Pro libraries can't be saved or opened", InDesign lock files don't sync, packages are zipped, and Safari needs FDA for local html. FileProvider also silently renames case-only collisions (822980). The path is long and under ~/Library, which many pro-app pickers hide.
- Upside: native badges, context menus, Spotlight for downloaded files, eviction UX, and system-managed offline mode.
- **Verdict:** it doesn't meet "zero bytes on disk, instant header reads". It might be worth it later as a parallel "sync folder" product, not as the mount.

---

## 4. Option 3: macFUSE / FUSE-T

- **macFUSE kext backend:** best performance and features, but on Apple Silicon it needs **Recovery → Startup Security Utility → Reduced Security → "Allow user management of kernel extensions from identified developers"**, then Allow plus a reboot on first use and after updates. It doesn't work in VMs or when booting from external volumes. That rules it out for consumers and most enterprises.
- **macFUSE 5 FSKit backend** (`-o backend=fskit`): 5.0.0 added it as experimental on 15.4+. 5.1.0 added "non-local" (distributed FS) volumes on macOS 26. 5.3.0 brought zero-copy and roughly 15× read gains. 5.5.0 (Oct 2026 pre-release) still lists: no per-file fsync callback, no remote advisory locks, EIO on empty reads to avoid corruption on 26/27, and "The FUSE notification API is not supported, yet". It's FSKit with an extra translation layer and the same user toggle.
- **Licence:** "Since May 2019 (version 3.9) some components… are no longer open source, e.g. the kernel extension… Bundling or integrating macFUSE with commercial software requires a paid-for license." Homebrew can't distribute it (hf-mount README).
- **FUSE-T:** "kext-less implementation of FUSE for macOS that uses NFS v4 local server". It now also has SMB and FSKit backends (`-backend=smb|nfs|fskit`). Licence: free for non-commercial use, and "For commercial use or/and bundling with commercial software… has to obtain a commercial license". Its SMB server (go-smb2) is AGPL or commercial. Wiki limitations: locks "currently bypassing FUSE calls", attribute-cache timeouts from the FS are ignored, atime and mtime can't be set separately (so Finder Preview changes mtime, and rclone re-uploads), no volume icons for network drives, and terminal "Operation not permitted" until the user enables **Network Volumes** in Privacy & Security. Open issues include an SMB reconnect loop and Finder hang on 26.6.2 (#113), wedged processes on concurrent open/unlink/recreate (#112), and a kernel panic in Apple's NFS client (#109).
- **Verdict:** don't take a dependency. FUSE-T proves the loopback approach works, and we can do the same thing ourselves without the licence or the extra hop.

---

## 5. Option 4: Loopback NFS / SMB from userspace

### 5.1 Common properties
- **No driver, no extension, no root.** A user can mount on a directory they own (`mount_nfs`/`mount_smbfs`), or through **NetFS.framework** (`NetFSMountURLAsync`), which also creates `/Volumes/<name>` for the user. [unverified: NetFS-to-loopback-port details]
- **TCC "Network Volumes":** each app that touches the volume is subject to `kTCCServiceSystemPolicyNetworkVolumes` ("Network volumes also appear to protect write access", Eclectic Light, Apr 2026). FUSE-T and hf-mount both document "Operation not permitted" fixes. **MDM can pre-approve** this through the PPPC payload key `SystemPolicyNetworkVolumes` (macOS 10.15+, confirmed in Apple's schema). Choosing the volume in an Open panel counts as user intent and bypasses the prompt.
- Loopback is unaffected by Wi-Fi or network changes. The server lives in our process, so a crash means **hangs (hard mount) or EIO (soft)**. EdenFS: "IO in NFS mounts will hang", and NFS pops a "server not responding" dialog.
- **ELOOP/symlink mountpoints:** macOS refuses mounts reached through a symlink (Space docs), for example `/tmp` → `/private/tmp`. Always `realpath()` the mountpoint before mounting.
- **Spotlight doesn't index network volumes.** "Shared volumes and folders using SMB are unlikely to be accessible to local Spotlight search" (Eclectic Light). That's good for not pulling the cloud down, and bad for search.
- They show up as network volumes: Finder "Locations" or the server name, no custom volume icon, and Time Machine doesn't back them up. [inference: TM excludes network mounts by default]

### 5.2 Loopback NFSv3 (e.g. `nfsserve`, now `huggingface/nfsserve` 0.11, about 1.4M downloads)
- Example mount: `mount_nfs -o nolocks,vers=3,tcp,rsize=131072,actimeo=120,port=11111,mountport=11111 localhost:/ mnt`. Used by xet and hf-mount ("works everywhere, no root, no kernel extension") and by EdenFS (its own server).
- Problems (EdenFS macOS doc):
  - "macOS NFS client does not support close-to-open guarantees". Invalidation needs a no-op `chmod` on parent dirs, and "may not be working reliably".
  - No xattrs in v3, so Finder writes `._` AppleDouble files.
  - No PID.
  - No forget, so inode tables grow without bound.
  - "NFS over UDS is broken", so you have to use TCP.
  - First-seen casing sticks.
- Locks: `nolocks` (ENOTSUP) or `locallocks` (client-only). There are no cross-machine locks.
- Useful client options: `nonegnamecache`, `acregmin/max`, `readahead` (0–128), `deadtimeout`, `mutejukebox`. Use JUKEBOX replies during slow cloud fetches to avoid timeouts, and `mutejukebox` to suppress the dialog (man mount_nfs). Use `soft` + `intr` for killability.
- hf-mount table: NFS has "no page cache invalidation" and staleness "up to poll interval (30 s)", against about 10 s on FUSE.
- NFSv4.1 on macOS: open/unlink/recreate races can leave processes unkillable (842736 follow-up). Avoid v4 leases across sleep (EdenFS).

### 5.3 Loopback SMB (Space's choice for the CLI)
- Apple's kernel smbfs client is the most heavily used third-party-server network FS path on the Mac (NAS workflows for Premiere and Resolve). Features we get for free if our server implements them [server-side capability claims are from protocol knowledge, unverified against smbfs]:
  - **change notify**, so Finder refreshes when another machine saves
  - **leases/oplocks**, so the kernel caches data and we break the lease on a remote change, which gives real coherency
  - **byte-range locks** that reach our server
  - **named streams**, so xattrs, Finder info and resource forks work without `._` files
  - durable handles for reconnect after sleep
  - Apple `AAPL` create-context extensions
- Client knobs: `nodatacache`, `nomdatacache`, `soft`, `nonotification` (mount_smbfs). In `nsmb.conf`: `dir_cache_max/min` (60/30 s defaults), `max_resp_timeout` (30 s), `signing_required`, `mc_on`. Turn signing and encryption off for 127.0.0.1 to save CPU, but authenticate with a random per-mount NTLM secret so other local users can't connect.
- Server options in Rust:
  - `smb-server` (paltaio/rust-smb-server, **MIT**, v0.7) has SMB 2.x–3.1.1, durable handles v1/v2, file leases and byte-range locks. It lacks **xattrs/alternate data streams, directory leases, oplocks, change-notify for external changes**, Kerberos and multichannel. Space forked this, or a sibling such as `ixr-smb-server`.
  - go-smb2 (FUSE-T) is AGPL or commercial. Not an option.
- Known pain: smbfs session drop and reconnect loops on 26.6.2 seen with FUSE-T (#113). Finder `.DS_Store` writes. "Network volume" UX in pro apps.
- **Effort is the main cost.** You have to build out streams, change-notify, lease breaks driven by the remote change feed, and the AAPL context, then soak-test against smbfs on 13–27.

---

## 6. Option 5: other or newer APIs
- **FSKit on macOS 27:** handler protocols, DataCacheHandler and `FSClient.mountSingleVolume` (needs `com.apple.developer.fskit.mount`; the entitlement page returned 404, so whether it's restricted is unknown). This is where Apple is heading. DTS repeatedly asks for Feedback reports to prioritise network-FS work.
- **No WWDC26 FSKit session found.** FSKit questions were handled in the WWDC26 File Systems Q&A (forums).
- **NetFS.framework:** a public API for mounting SMB/NFS URLs as a user, with Finder-style `/Volumes` mountpoints.
- **Network Extension-style system-extension FSKit:** doesn't exist. Apple suggested filing an ER (808594).
- **DiskImageKit (macOS 27):** ASIF images. Irrelevant except for the `hdiutil` + block-device trick for kernel-offloaded I/O, which only works for unmodified single-file data.

---

## 7. Recommendation

### v1: same architecture as Space, different default
1. **Rust core, one multicall binary** (`ourfs`: `cli`, `daemon`, `mount-server`, `supervised-mount`). It holds the VFS, journal, CDC shard cache keyed by content hash, metadata and change-feed sync, the auth/credential renewal loop, and the protocol front-ends:
   - SMB2/3 server (fork the MIT `smb-server`)
   - NFSv3 (`nfsserve`)
   - FUSE3 (Linux, `fuser`)
   - WinFSP (Windows, later)
   - a C-ABI surface for FSKit
2. **Default macOS adapter in v1: loopback SMB**, used by both the Mac app (the app spawns and supervises the core, then mounts via NetFS) and headless or sidecar use. Why:
   - It works on every supported macOS with **no toggle and no MDM gap**. The TCC Network Volumes prompts can be pre-approved by MDM.
   - The kernel client already has coherent caching hooks (leases, change-notify), real locks and xattrs. FSKit on 26 has none of the coherency hooks, and on 27.x root invalidation is still broken and fsync and locks don't reach the module.
   - Apple's own DTS says FSKit isn't ready for read/write network filesystems (Aug 2026).
3. **FSKit adapter as opt-in "native mode" on macOS ≥ 27.2**, built in parallel as a thin Swift appex linking the Rust core in-process. Promote it to default per OS version once all of these hold:
   - root `setCacheState` is fixed
   - RENAME_SWAP is either honoured or not advertised
   - sync/fsync routing works
   - our compatibility matrix passes (Premiere, Blender, Xcode/git, Revit via Parallels shared folders, Claude Code/terminal tools, safe-save editors)

   This is where Space already is. We'd just gate it more conservatively.
4. **NFSv3 (nfsserve) as the fallback** when SMB misbehaves on a given macOS build: soft + intr + `mutejukebox`, `nonegnamecache`, short `actimeo`, chmod-based invalidation. It's cheap insurance, and it's shared with the Linux fallback the way Space does it.
5. **Not** File Provider (it fails byte-range streaming and pro-app paths) and **not** macFUSE/FUSE-T (licensing, kext UX, extra hop).

If time-to-market beats protocol work, flip it: FSKit-first like Space, restricted to macOS 27.2+, and accept the toggle plus the known bugs. Either way, ship both adapters behind one core.

### Language and stack
- Rust is shared across macOS, Linux and Windows.
- The Swift side is minimal:
  - SwiftUI menu-bar app (login, drive picker, upload status from the journal, "enable extension" onboarding)
  - FSKit `.appex` (FSUnaryFileSystem + FSVolume handlers; each callback is dispatched to Rust off the NSXPC serial queue)
  - optional Finder Sync `.appex`
- Bridge with cbindgen or UniFFI to a Rust `staticlib`. Use XPC or a Unix socket only for control, never for the data path.
- One writer owns each drive's journal. Either the appex hosts the core for its mount, or the appex is a thin client of the daemon over shared memory. The appex is sandboxed, so this needs an app-group container or Mach lookup exceptions. Decide early.

---

## 8. Distribution

- **Direct Developer ID distribution, not the Mac App Store.** The sandbox blocks spawning `/sbin/mount` (799283), the loopback SMB/NFS server and NetFS mounts from a sandboxed app aren't viable [inference], and app-update termination of FSKit extensions is harsher there.
- Build steps:
  - Sign the app, appex(es) and the embedded Rust binary with **Developer ID Application** and the **hardened runtime** (`--options runtime`). The FSKit appex carries `com.apple.developer.fskit.fsmodule` and needs a provisioning profile with the **FSKit Module** capability. [unverified: the Developer-ID column for FSKit in Apple's capabilities table didn't render]
  - **Notarize** with `xcrun notarytool submit … --wait`, staple, ship a DMG.
  - Install to `/Applications`, because the FSKit bridge projects report state oddities with other paths.
- **Sparkle 2** for updates (EdDSA-signed appcast). Before installing: flush the journal, unmount, stop the appex, and use install-on-quit / postpone hooks while drives are mounted, because replacing the bundle kills the FSKit extension and skips `synchronize` (809747). [Sparkle hook names not verified in this research]
- CLI: a signed, notarized .pkg or `curl | sh` installer with SHA-256 verified self-update, as Space does. It doesn't need the app and uses SMB.
- **Exact user steps (FSKit mode):**
  1. Open the DMG, drag the app to Applications, launch it, sign in.
  2. When prompted, click "Open Settings". The app calls `FSClient.openFileSystemExtensionsSettings()`.
  3. In **System Settings → General → Login Items & Extensions**, scroll to **Extensions**, choose **By Category**, click ⓘ next to **File System Extensions**, and turn on **<Product>**.
  4. Return to the app. It detects the module is enabled and mounts.

  Optional, for badges: in the same pane under **Finder** / "Added extensions", enable the Finder Sync extension.
- **Exact user steps (SMB mode):**
  1. Install, launch, sign in. The drive appears in Finder.
  2. The first time each app (Terminal, Premiere, …) touches it, click **Allow** on "would like to access files on a network volume". To change it later: System Settings → Privacy & Security → Files & Folders → <App> → Network Volumes.

  Enterprises can push a PPPC profile with `SystemPolicyNetworkVolumes` for the relevant apps.
- **MDM:** SMB/NFS can be pre-approved through PPPC. FSKit has no pre-approval payload in the macOS 27 schema.

---

## 9. Making it feel native

- **Sidebar:** mounts under `/Volumes/<Drive>` appear in Finder's Locations. With FSKit, avoid mountpoints under `~`, which Finder hides by heuristic. There's no public API to add a Favorites entry (LSSharedFileList is deprecated). [inference] Onboarding can tell users to drag the volume into Favorites. Always realpath the mountpoint.
- **Finder Sync extension:** badges for "uploading / synced / conflict" driven by the journal, plus context menus (version history, share link, pin to cache). It needs its own user toggle. Apple positions it for "a local folder", and badges on network mounts depend on our own observation, not FSEvents. [inference: test on SMB and FSKit volumes]
- **Quick Look:** works automatically. Thumbnails read headers or ranges, which is cheap with byte-range streaming. Consider prefetch hints for common container headers (MP4 moov, EXR, PSD).
- **Spotlight:**
  - SMB is not indexed by local Spotlight.
  - FSKit `local` volumes *are* indexed, so we must suppress indexing (`.metadata_never_index` at the root, `mdutil -i off`) or Spotlight will stream the whole drive.
  - For search, provide our own server-side index through the app/CLI. Optionally donate metadata to **CoreSpotlight** (`CSSearchableIndex`) so names show in Spotlight without reading content. [unverified UX for results pointing into a mounted volume]
- **Time Machine:** network volumes aren't backed up. For FSKit volumes, exclude the volume (`tmutil addexclusion -v /Volumes/<Drive>`, admin required) [unverified that TM would include non-local FSKit volumes by default]. Put the shard cache in `~/Library/Caches/<bundle-id>` and set `NSURLIsExcludedFromBackupKey` on the journal and cache directories. The data is already versioned server-side.
- **Volume naming and icon:** `volname`. Custom icons don't work on network volumes (FUSE-T wiki). FSKit volumes can probably show an icon via `.VolumeIcon.icns`. [unverified]

---

## 10. Top risks

1. **FSKit maturity for read/write network FS** (Apple DTS, Aug 2026):
   - RENAME_SWAP data loss
   - fsync not delivered
   - kernel-local locks
   - broken root invalidation, giving ESTALE or stale data across machines
   - wedged resources after a failed activate
   - unkillable processes on hung volume calls
   - extension killed on app update

   You need macOS 27.2+, and you're on Apple's bug-fix schedule.
2. **User-enablement friction** with no MDM path for FSKit. It's per-user, an installer can't flip it, and CI needs pre-approved VM images.
3. **SMB server effort and smbfs quirks.** Implementing streams/xattrs, change-notify, lease breaks and AAPL extensions well enough for Finder and pro apps is a protocol project. smbfs reconnect or hang behaviour across sleep varies by macOS point release.
4. **Per-app TCC "Network Volumes" prompts** on loopback mounts. Terminal agents (Claude Code) and pro apps each prompt once. Pre-approve via MDM in enterprises.
5. **Spotlight / mds and other crawlers** (antivirus, backup, Photos, IDE indexers) on a mount that streams everything. Suppress indexing, rate-limit cold fetches, and consider recognising crawler access patterns (without PIDs on FSKit).
6. **Hangs on daemon death or slow cloud fetch.** Hard mounts freeze apps. Soft mounts return EIO and can corrupt app state. You need JUKEBOX/lease-based back-pressure, watchdog restart of the core, and journal replay.
7. **No published performance numbers for FSKit network volumes.** Benchmark FSKit vs loopback SMB vs NFS on 27.x before committing to a default.

---

## Sources

Apple documentation (DocC JSON endpoints)
- FSKit overview: https://developer.apple.com/documentation/fskit
- FSGenericURLResource (26.0): https://developer.apple.com/documentation/fskit/fsgenericurlresource
- FSPathURLResource (26.0): https://developer.apple.com/documentation/fskit/fspathurlresource
- FSUnaryFileSystem: https://developer.apple.com/documentation/fskit/fsunaryfilesystem
- FSVolume (handlers, setCacheState): https://developer.apple.com/documentation/fskit/fsvolume
- FSVolume.DataCacheHandler (27.0): https://developer.apple.com/documentation/fskit/fsvolume/datacachehandler
- FSVolume.KernelOffloadedIOHandler (27.0): https://developer.apple.com/documentation/fskit/fsvolume/kerneloffloadediohandler
- FSExtentPacker: https://developer.apple.com/documentation/fskit/fsextentpacker
- FSClient / mountSingleVolume (27.0): https://developer.apple.com/documentation/fskit/fsclient
- Entitlement com.apple.developer.fskit.fsmodule: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.fskit.fsmodule
- Sample "Building a passthrough file system": https://developer.apple.com/documentation/fskit/building-a-passthrough-file-system
- NSFileProviderPartialContentFetching: https://developer.apple.com/documentation/fileprovider/nsfileproviderpartialcontentfetching
- fetchPartialContents(...): https://developer.apple.com/documentation/fileprovider/nsfileproviderpartialcontentfetching/fetchpartialcontents(for:version:request:minimalrange:aligningto:options:completionhandler:)
- NSFileProviderMaterializationFlags: https://developer.apple.com/documentation/fileprovider/nsfileprovidermaterializationflags
- Finder Sync: https://developer.apple.com/documentation/findersync
- macOS 15.4 release notes (FSKit introduced): https://developer.apple.com/documentation/macos-release-notes/macos-15_4-release-notes
- macOS 26.4 release notes (MountOptions availability, resource fork): https://developer.apple.com/documentation/macos-release-notes/macos-26_4-release-notes
- macOS 27 / 27.2 release notes (no FSKit entries found): https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes
- Software releases (macOS 27.0.1, 27.2 RC dates): https://developer.apple.com/news/releases/
- WWDC21 "Sync files to the cloud with FileProvider on macOS": https://developer.apple.com/videos/play/wwdc2021/10182/
- Apple device-management schema (no FSKit payload; NSExtension, fileproviderd, TCC SystemPolicyNetworkVolumes): https://github.com/apple/device-management

Apple Developer Forums
- Ten FSKit issues building a network FS (DTS: not ready): https://developer.apple.com/forums/thread/842736
- FSKit and Network File Systems? (DataCacheHandler intent): https://developer.apple.com/forums/thread/831417
- Invalidating kernel-cached data with isDataCacheInhibited: https://developer.apple.com/forums/thread/849057
- DataCacheHandler for block devices?: https://developer.apple.com/forums/thread/831652
- Using FSKit for a network file system (no invalidation API pre-27): https://developer.apple.com/forums/thread/799809
- FSPathURLResource mounting, perf "not great", sandbox: https://developer.apple.com/forums/thread/799283
- Kernel I/O passthrough request: https://developer.apple.com/forums/thread/828533
- FUSE compat surface / NSXPC serial queue: https://developer.apple.com/forums/thread/831338
- AppEx lifecycle (per-user state, 26.5 fixes): https://developer.apple.com/forums/thread/831396
- FSKit AppEx CI: https://developer.apple.com/forums/thread/831843
- Enable FSKit globally pre-login: https://developer.apple.com/forums/thread/808594
- Updating FSKit module (force-unmount on update): https://developer.apple.com/forums/thread/809747
- Read-only support / f_iosize 1 MB: https://developer.apple.com/forums/thread/807771
- FSKit cloud disk not in Finder sidebar: https://developer.apple.com/forums/thread/816899
- nobrowse ignored / Spotlight indexing FSKit volumes: https://developer.apple.com/forums/thread/820931
- FSKit retrieve PID (refused): https://developer.apple.com/forums/thread/808728
- FileProvider & FSKit compatibility: https://developer.apple.com/forums/thread/841771
- Partial fetch, high latency: https://developer.apple.com/forums/thread/812794
- Partial fetch only via POSIX reads: https://developer.apple.com/forums/thread/732730
- cannotMaterialize / extent mismatch: https://developer.apple.com/forums/thread/802063
- FileProvider tag listing (scale, case collisions): https://developer.apple.com/forums/tags/fileprovider

Space
- Mount a drive: https://docs.spacefs.com/start/mount/
- Mount from a program: https://docs.spacefs.com/guides/mount-from-a-program/
- Architecture: https://docs.spacefs.com/how-it-works/architecture/
- Full docs: https://docs.spacefs.com/llms-full.txt
- Changelog: https://spacefs.com/changelog/

FUSE / loopback ecosystems
- macFUSE releases (5.0–5.5): https://github.com/macfuse/macfuse/releases
- macFUSE FUSE Backends: https://github.com/macfuse/macfuse/wiki/FUSE-Backends
- macFUSE Getting Started (kext approval): https://github.com/macfuse/macfuse/wiki/Getting-Started
- macFUSE Open Source Status (commercial licence): https://github.com/macfuse/macfuse/wiki/Open-Source-Status
- FUSE-T README, wiki, license, issues: https://github.com/macos-fuse-t/fuse-t , https://github.com/macos-fuse-t/fuse-t/wiki , https://github.com/macos-fuse-t/fuse-t/blob/main/License.txt , https://github.com/macos-fuse-t/fuse-t/issues
- go-smb2 (AGPL/commercial): https://github.com/macos-fuse-t/go-smb2
- nfsserve: https://github.com/xetdata/nfsserve (now https://github.com/huggingface/nfsserve)
- hf-mount: https://github.com/huggingface/hf-mount
- EdenFS macOS notes: https://github.com/facebook/sapling/blob/main/eden/fs/docs/macOS.md
- rclone mount / nfsmount: https://rclone.org/commands/rclone_mount/ , https://rclone.org/commands/rclone_nfsmount/
- rust-smb-server (MIT): https://github.com/paltaio/rust-smb-server
- fskit-rs (Swift bridge + Rust over TCP/protobuf): https://github.com/debox-network/fskit-rs
- objc2-fs-kit / objc2-file-provider: https://github.com/madsmtm/objc2
- Dropbox on File Provider limitations: https://help.dropbox.com/installs/macos-support-for-expected-changes
- Eclectic Light, Spotlight in Sequoia: https://eclecticlight.co/2024/11/29/using-and-troubleshooting-spotlight-in-sequoia-summary/
- Eclectic Light, Privacy: how locations are protected: https://eclecticlight.co/2026/04/20/privacy-how-locations-are-protected/
- Local man pages (macOS 26.5.1): mount_nfs(8), mount_smbfs(8), nsmb.conf(5)

### Not verified / gaps
- Absolute FSKit throughput and latency numbers: none published.
- Whether FSKit is enabled for Developer ID in Apple's capability table (page didn't render). The `com.apple.developer.fskit.mount` entitlement page returned 404.
- The Space macOS app's minimum OS, and the internals of Space's SMB fork and Swift shim (no public repos).
- Sparkle API names for deferring installs.
- Finder Sync badges on network/FSKit mounts, CoreSpotlight results for mounted paths, and Time Machine defaults for FSKit volumes.
- Web search was unavailable in this environment. Everything above comes from directly fetched pages.
