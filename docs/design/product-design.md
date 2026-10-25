# Unlispace — product design (v1: macOS)

Status: draft for review · 2026-10-25 · working name "Unlispace", domain shown as `unlispace.com` (placeholder)

Evidence for every claim about Space (spacefs.com) is in [`docs/research/spacefs/`](../research/spacefs/):
`signed-in.md` (live web app + API), `mac-client.md` (installed app), `mac-pkgs.md` (installers),
`cloudflare-mapping.md` (platform limits), `macos-fs-options.md` (filesystem choice).

---

## 1. What we are building

A cloud drive that behaves like a local disk. Files open instantly because byte ranges stream on
demand, saves sync to every machine in seconds, and every save is a version. Programs and agents
reach the same drive over an S3-compatible API with in-place edits and instant forks.

| Surface | v1 | Later |
|---|---|---|
| macOS app (menu bar + mounted drive) | ✅ | |
| Web app: sign-in, drives, keys, billing, read-only file browser | ✅ | upload, share links |
| S3-compatible API + edit/version/fork extensions | ✅ | |
| `uls` CLI on macOS (mount, history, restore, keys) | ✅ | Linux (FUSE) |
| Windows | | WinFsp |
| Review product, AI agent, search | | yes |
| Bring-your-own bucket, SSO, on-prem | | Enterprise |

**Target users for v1:** individuals and small teams with large files (video, 3D, CAD, datasets),
and developers running coding agents who need a forkable sandbox.

### Where we match Space, and where we deliberately differ

| Area | Space today | Unlispace v1 |
|---|---|---|
| Storage model | FastCDC shards + per-version manifest | same |
| Commit cost | 4 R2 objects per version, so small writes are 2–3× slower than a bare bucket | one SQLite transaction in the drive's Durable Object; we aim for small writes faster than Space (to be benchmarked in M0) |
| Mac mount | FSKit (macOS 26+, manual toggle), SMB fallback | **loopback SMB by default** (no toggle, any macOS ≥ 14); FSKit opt-in later |
| Session token | 100-year HS256 JWT in a plaintext JSON file | 15-min access token, rotating refresh token in the Keychain |
| Shard upload | client writes straight to R2 with temporary credentials, and the server reads every shard back at commit | client uploads through the gateway, which hashes while streaming (no read-back) |
| Updates | custom feed, SHA-256 only | Sparkle 2 with EdDSA signatures; never installs while the journal has unsynced writes |
| Telemetry | PostHog with email + user id | opt-in, pseudonymous install id, no email |
| Debug dashboard | unauthenticated | none in release builds |

---

## 2. System overview

```
 macOS                                     Cloudflare
┌──────────────────────────────┐        ┌───────────────────────────────────────────────┐
│ Unlispace.app (Swift)        │ HTTPS  │ api Worker (control plane)  ── D1 (control db) │
│  menu bar, onboarding,       ├───────►│  auth · orgs · drives · keys · billing          │
│  Keychain, Finder Sync ext   │        │                                                 │
│        │ XPC                 │        │ s3 Worker (data plane)                          │
│ ulsd (Rust daemon,           │ HTTPS  │  SigV4 · S3 subset · extensions · /_blocks      │
│  LaunchAgent)                ├───────►│     │                 │                         │
│  journal · shard cache ·     │   WSS  │     ▼                 ▼                         │
│  sync · SMB server ──────────┼───────►│ DriveAuthority DO    R2 buckets                 │
│        │ 127.0.0.1 SMB2/3    │        │  (1 per drive,       shards/  manifests/        │
│ /Volumes/<Drive> (smbfs)     │        │   SQLite, WebSocket  snapshots/                 │
└──────────────────────────────┘        │   fan-out)                                      │
                                        │ Queues · Workflows · Cron  (GC, metering, sync) │
                                        └───────────────────────────────────────────────┘
```

Hostnames: `app.` (web, Workers static assets), `api.` (control plane), `s3.` (S3 gateway and the
desktop data plane).

---

## 3. Storage engine

### 3.1 Objects
- **Shard:** a content-defined chunk (FastCDC 2020, min 256 KiB, average 2 MiB, max 16 MiB). It
  is named by SHA-256 and immutable. Chunking happens **on the client** (desktop and SDKs). The
  gateway only chunks plain S3 PUTs, streaming them in a Worker (about 0.1–0.5 s CPU per 64 MiB,
  an estimate we still have to benchmark).
- **Manifest:** an ordered `[(sha256, len)]` list plus size, content-type and mtime. Manifests up
  to 64 KiB are stored inline in the DO. Larger ones go to R2 as `manifests/{ns}/{sha256}`, with
  only the hash kept inline. The DO's 2 MB row limit forces this; a 5 TiB file has a manifest of
  roughly 100 MB.
- **Version:** an immutable row. Fields: `version_id`, `node_id`, `op` (put / write / copy /
  restore / rename), `manifest_ref`, `size`, `etag`, `parent_version`, `commit_seq`, `actor`, `ts`.
- **Node:** a file or folder in a real tree (`node_id`, `parent_id`, `name`, `head_version`).
  Folders are real, which gives constant-time rename of whole folders.

### 3.2 Namespaces and dedup
Shards live under `shards/{lineage}/{sha256}`, where `lineage` is the id of the root drive of a
fork tree. Every fork of a drive shares its parent's namespace, so a fork copies only the DO
state, never bytes. Drives in different lineages don't dedup against each other. We accept that
loss: it keeps both access scoping and GC confined to one lineage.

### 3.3 The DriveAuthority Durable Object (one per drive)
- Created with `locationHint` from the placement chosen at drive creation: wnam / enam / weur /
  eeur / apac / oc. `sam`, `afr` and `me` map to the nearest region. Placement is fixed once set.
- SQLite tables: `nodes`, `versions`, `heads`, `log` (commit_seq, change records), `shards_known`
  (a hash set used for commit validation), `uploads` (multipart state), `meta`.
- **Commit** is a single SQLite transaction:
  1. Check the precondition (`if_version` / `If-Match` / `If-None-Match: *`) against the head.
  2. Check that every referenced shard is in `shards_known`. The gateway inserts shards there
     after a verified upload; anything not yet known is batch-HEADed against R2.
  3. Insert the version, move the head, and append to `log`.
  4. Respond and fan out over WebSocket.

  Of two racing guarded writers, exactly one wins. Read-after-write holds through this DO.
- **Edits** (`write_at`, `patch`, `splice`, `truncate`): the gateway loads the head manifest,
  fetches only the shards the edit overlaps, re-chunks that window, uploads the new shards, and
  commits a manifest that reuses everything else.
- **Fork:** `fork(parent)` exports the parent's `nodes` and `heads` at a `commit_seq`. The new DO
  imports them (in chunked RPC pages for large trees). The new drive starts with the same
  lineage, and history before the fork point stays readable through the parent.
- **Limits that shape the design:**
  - 10 GB SQLite per drive (roughly 20–50 M versions). We need a version-pruning policy before
    any drive gets near it.
  - About 1,000 requests/s per drive. Hot, write-heavy drives should batch with `patch`.
  - Shard bytes never pass through the DO.
- **Backup:** an alarm writes a periodic snapshot of the DO database to
  `snapshots/{drive}/{seq}` in R2, plus the log tail. This allows a full rebuild if a DO is lost
  and gives us export.

### 3.4 Reads
1. Resolve the head at the DO, or from the per-colo metadata cache (TTL ≤ 2 s) unless the request
   sends `x-uls-consistent: true`.
2. Map the byte range onto shards.
3. Fetch the shards through `GET s3.unlispace.com/_blocks/{lineage}/{sha}?t=<hmac>`. Shards are
   immutable, so they are served with `Cache-Control: immutable` through the zone cache and
   Smart Tiered Cache. R2 presigned URLs can't use the edge cache on custom domains, so we don't
   use them.

### 3.5 Garbage collection
Mark-and-sweep per lineage, not refcounts, because refcounts would multiply DO row writes, our
biggest cost lever.
1. Each live drive in the lineage exports its live shard set (from current heads plus retained
   versions).
2. A Workflow unions those sets and lists `shards/{lineage}/`.
3. It deletes anything unreferenced and older than 7 days.

Soft-deleted drives keep their shards until their retention window expires.

---

## 4. API surface

### 4.1 Control plane (`api.`), JSON with a bearer access token

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/otp/start`, `POST /auth/otp/verify`, `GET /auth/google/start`, `GET /auth/google/callback`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/desktop/start` → `uls://auth/callback#code&state`, `POST /auth/desktop/exchange` (PKCE) |
| Me | `GET /me`, `PATCH /me` |
| Onboarding | `POST /onboarding/access` (state machine: `new → trial_active → paid / expired`) |
| Orgs | `GET /orgs?include=drives`, `POST /orgs`, `GET/PATCH /orgs/{id}`, members, invitations |
| Drives | `GET/POST /orgs/{id}/drives`, `GET/PATCH/DELETE /drives/{id}`, `POST /drives/{id}/fork`, `GET /drives/{id}/items?parent=`, `GET /drives/{id}/items/{node}/versions`, `POST /drives/{id}/items/{node}/restore` |
| Keys | `GET/POST /keys`, `DELETE /keys/{id}`; child keys minted with SigV4 (narrower scope only, transitive revoke) |
| Billing | `GET /billing/catalog`, `POST /orgs/{id}/billing/checkout`, `GET /orgs/{id}/billing`, `/invoices`, `/portal`, `POST /webhooks/payments` |
| Desktop | `GET /drives/{id}/mount-session`: a short-lived (15 min) drive-scoped data-plane token for `ulsd` |

### 4.2 Data plane (`s3.`)
- **S3 subset** (SigV4: header, presigned, UNSIGNED-PAYLOAD, aws-chunked and trailing checksums):
  ListBuckets, Create/Head/DeleteBucket, GetBucketVersioning, ListObjectsV2, ListObjectVersions,
  Head/Get/Put/Copy/DeleteObject(s), and multipart (our own construct over shards, because R2
  multipart requires equal-sized parts).
- **Extensions:** query flag plus headers, with Space-compatible semantics under our own prefix
  `x-uls-*`:
  - `?x-uls-write` (offset write, truncate)
  - `?x-uls-patch` (binary batch: 10k edits / 64 MiB)
  - `?x-uls-splice` (insert / remove)
  - `?x-uls-rename` (file or folder)
  - `?x-uls-versions`, `x-uls-as-of`, `?x-uls-restore`
  - drive create / fork / describe / delete
- **Desktop data plane:**
  - `PUT /_shards/{lineage}/{sha}`: streamed, hashed with `DigestStream`, written with
    `onlyIf` (first writer wins).
  - `POST /_shards/{lineage}/missing` (dedup probe).
  - `GET /_blocks/...`.
  - `POST /drives/{id}/commit` (batch of up to N file commits in one DO transaction).
  - `GET /drives/{id}/changes?since=<seq>` (WebSocket upgrade, with a resume cursor).
- **Access keys:** id `ULS` + 17 chars, 40-char secret, secret = HMAC(master_k, id), with the key
  version encoded in the id so the master key can rotate. Revocation lives in D1 and is cached per
  colo for at most 30 s.
- **Body limits:** a Worker accepts at most 100 MB (Pro) or 200 MB (Business) per request. A
  single PUT larger than that must use multipart; we document a 95 MB single-PUT limit instead of
  S3's 5 GiB.

---

## 5. macOS client

### 5.1 Components

| Piece | Language | Role |
|---|---|---|
| `Unlispace.app` | Swift (SwiftUI + AppKit), menu-bar app | sign-in, onboarding, drive picker, transfer progress, settings, updates |
| `ulsd` | Rust | the engine: VFS, journal, shard cache, sync, SMB server. Registered as a LaunchAgent with `SMAppService.agent` (user, never root) |
| `UnlispaceFinder.appex` | Swift | Finder Sync: badges (synced / uploading / conflict / offline), context menu (Version history…, Copy link, Restore) |
| `uls` | Rust, the same binary as `ulsd` invoked as multicall | CLI: login, mount, history, restore, keys |
| `UnlispaceFS.appex` (later) | Swift shell linking the Rust staticlib | FSKit "native mode", opt-in on macOS ≥ 27.2 |

The app and daemon talk over XPC (Mach service in our app group). The daemon also exposes a Unix
socket for the CLI, checked with `SO_PEERCRED`.

### 5.2 Mounting, v1
- `ulsd` serves SMB2/3 on `127.0.0.1:<random>` and mounts it with `NetFSMountURLSync` at
  `/Volumes/<Drive>`. No root, no kext and no System Settings toggle are needed. We add the drive
  to the Finder sidebar.
- The SMB server is built on the MIT `rust-smb-server` (which Space also forked). We must add:
  xattrs / named streams (Finder metadata), change-notify (live Finder refresh), leases, and byte
  locks.
- Loopback authentication: a per-install random NTLM credential kept in the Keychain. Guest
  access is off, so other local users can't attach.
- **Approval cost:** each app that touches the volume (Terminal, editors) shows a one-time
  "Network Volumes" privacy prompt. MDM can pre-approve this through PPPC.
- **Fallback:** NFSv3 through `nfsserve`, used as the M1 prototype adapter and an emergency
  switch.
- **Why not FSKit by default:** it needs macOS 26+ and a manual per-user toggle (no MDM payload),
  and has open network-FS bugs: RENAME_SWAP destroys the destination, fsync never reaches the
  module, and root invalidation is broken. Apple DTS (Aug 2026) says it isn't ready for network
  filesystems. Why not File Provider: it can't stream byte ranges to Finder or coordinated reads,
  which breaks the "open a 40 GB file instantly" promise.

### 5.3 Engine behaviour
- **Reads:** a page-aligned range request is mapped to shards. The shard comes from the RAM cache,
  then the disk cache (`~/Library/Caches/com.unlispace/shards/{sha}`, LRU, default 20 GB),
  otherwise it is fetched from `/_blocks` with read-ahead. A cached shard can never be stale.
- **Writes:**
  1. They land in a crash-safe journal (SQLite WAL in `~/Library/Application Support/Unlispace/`),
     so a save returns at local speed.
  2. On close or fsync, plus a 2 s quiet window, the journal is folded into new shards (only
     around dirty ranges).
  3. The shards are uploaded and the commit is sent with `if_version = base`.
- **Conflicts:** if the commit returns 412, the local edit is committed as
  `name (conflict, <machine>, <time>).ext`. The remote version stays as head, and the conflict is
  shown in the badge and a notification. Nothing is ever silently lost.
- **Remote changes:** a WebSocket to the drive DO sends a `seq` and changed node ids. The daemon
  invalidates attributes and directory caches and issues SMB change-notify. It resumes from the
  last `seq` after sleep, network change or a server deploy.
- **Offline:** cached files stay readable and writes queue in the journal. A menu-bar indicator
  shows the queue. "Keep offline" pins a folder's shards.
- **Disk safety:** quotas are enforced at the gateway. The local journal has a cap, and writes
  return ENOSPC with a clear notification when it is full.

### 5.4 Distribution and updates
- Developer ID signed and notarized, with hardened runtime, shipped as a `.dmg`. No App Store.
- Minimum macOS 14 (SMB path). FSKit mode needs macOS 27.2.
- Sparkle 2 with an EdDSA-signed appcast. Installs wait until the journal is empty and drives are
  unmounted cleanly.
- `.metadata_never_index` is set on the volume so Spotlight doesn't stream the whole drive. Our
  own search comes later.

---

## 6. Identity, security, billing

- **Sessions:** a 15-min JWT access token (Ed25519, `kid` rotation) plus a rotating opaque refresh
  token (30 days, reuse detection), stored as hashes in D1. Desktop sign-in uses
  ASWebAuthenticationSession with PKCE, and refresh tokens are kept in the Keychain.
- **OTP email** via the Cloudflare Email Service `send_email` binding (beta). Fallback: Resend or
  Postmark. Codes are 6 digits, expire after 10 min and allow 5 attempts, rate-limited per email
  and per IP with a DO counter.
- **Google:** OIDC code flow with PKCE, hand-written in the Worker.
- **Authorization:** roles `owner / admin / member / viewer` per org. Each drive has an ACL. Every
  data-plane request carries a scope `{org, drives[], access}` checked at the gateway. The DO
  re-checks the `authorization_generation` so a stale grant can't keep working.
- **Plans** (to be decided):
  - Individual: 1 TB, 1 seat.
  - Teams: 1 TB per seat, pooled, shared drives.
  - 500 GB storage add-ons.
  - 7-day trial without a card.

  For reference, Space charges $20/mo or $15/mo annual for Individual and $50/mo or $30/mo annual
  per Teams seat. Usage is metered nightly from the DO stats (bytes referenced by each lineage) by
  a Cron job, and sent to Dodo Payments.
- **Payments:** Dodo Payments (D3), with subscriptions for seats and storage add-ons, and its webhooks
  updating D1.

---

## 7. Cost model (estimate; see cloudflare-mapping §10)

1 TB stored, 5 TB egress and 10 M writes a month comes to about **$135–150/month**:

| Item | Monthly |
|---|---|
| R2 Class A operations | $40 |
| DO SQLite rows written (assuming 10 rows per commit) | $50 |
| R2 storage | $15 |
| Queues | $12 |
| Workers | $12 |
| Egress | $0 |

We keep commits at ≤ 5 rows. Against a $15–20 per TB plan, gross margin depends mostly on
write-heavy users, so batched commits from the desktop matter.

---

## 8. Milestones

| # | Outcome | Contents |
|---|---|---|
| M0 | Spike, 1–2 weeks | DO commit + R2 shards + `/_blocks` edge cache; FastCDC in Rust; benchmark CDC CPU in a Worker; NFSv3 loopback mount of a read-only drive on a Mac |
| M1 | Internal alpha | email OTP + Google, D1 control plane, a drive per user, `ulsd` read/write through NFSv3, journal + commit, WebSocket change feed, menu-bar app, CLI |
| M2 | Private beta | SMB2/3 adapter as default, Finder Sync badges, conflicts, offline pins, version history UI (restore), web app (drives, keys, file browser), S3 subset + extensions, Sparkle |
| M3 | Paid launch | trials + checkout + metering, Teams (members, shared drives, ACLs), forks, child keys, GC Workflow, DO snapshots, quotas |
| M4 | After launch | FSKit native mode (27.2+), Linux CLI (FUSE), search, review links, agent integrations |

**Test matrix for the Mac milestones (gate for M2):**
- Finder copy, rename and duplicate
- Premiere, Final Cut (library-on-network-volume support still to be verified), Blender, Xcode + git, VS Code
- Claude Code / terminal tools
- safe-save editors (TextEdit, Pages), `rsync`
- sleep/wake, Wi-Fi switch, and a 1 M-file tree

---

## 9. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Product name and domain | **Locked 2026-10-25:** Unlispace, bundle id `com.unlispace.app`, URL scheme `uls://` (final domain still to be registered) |
| D2 | Default Mac adapter | **Locked:** loopback SMB in v1, FSKit opt-in later. NFSv3 is the M0/M1 prototype adapter |
| D3 | Payments | **Locked:** Dodo Payments (merchant of record) for seats, storage add-ons and trials |
| D4 | Web app stack | **Locked:** a fresh app on Cloudflare, talking to `api.`. The existing Next.js + Supabase starter is left in place until the new web app replaces it; only the Dodo/UI pieces carry over |
| D5 | Control DB | **Locked:** D1 (10 GB cap per DB, so shard by org later) |
| D6 | Cloudflare plan | Open: Workers Paid + a Business zone (200 MB body limit) |

## 10. Repository layout

| Path | Contents |
|---|---|
| `cloud/data-plane/` | Worker: S3 gateway, `/_shards`, `/_blocks`, commits, WebSocket changes; the `DriveAuthority` DO |
| `cloud/api/` | Worker: control plane (auth, orgs, drives, keys, billing) on D1. Starts in M1 |
| `engine/` | Rust workspace: `uls-chunk`, `uls-proto`, `uls-client`, `ulsd` (daemon + `uls` CLI) |
| `mac/` | Swift: menu-bar app, Finder Sync extension. Starts in M1 |
| `docs/design/` | this doc, plus `m0-contract.md` (the wire contract shared by cloud and engine) |
