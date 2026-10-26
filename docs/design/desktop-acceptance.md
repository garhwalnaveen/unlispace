# Desktop acceptance — 26 October 2026

Scope: finish the native desktop flows and validation. Search, AI and team-management parity
were explicitly left for a later pass.

## Delivered state

- Installed app: `/Users/naveen/Applications/Unlispace.app`.
- Review disk image: `mac/build/Unlispace-0.2.0.dmg`.
- Configured API: `https://unlispace-api.naveen-f3d.workers.dev`.
- The real `com.unlispace.ulsd` LaunchAgent is enabled and running, its socket is available,
  and the signed-in hosted account and mounted Space drive survived the daemon restart.
- The hosted SMB volume is mounted under
  `/Users/naveen/Library/Application Support/Unlispace/mnt/Space`, outside the repository.
- Final daemon status: `idle`, `pendingOps: 0`.

## Verified flows

| Check | Evidence |
| --- | --- |
| Swift app/library gate | 70 tests passed; includes service states, HTTP service-check cancellation, browser fallback state matching/cancellation/denial, callback validation, rendering and real local daemon socket integration |
| Real Worker/engine integration | 49 checks passed, zero failures, using a pinned SMB-enabled executable and isolated local Workers/D1/R2 |
| Real browser desktop handoff | Browser email sign-in returned to the desktop page and issued a one-time PKCE code; the production Swift parser/exchange consumed it against the local Worker |
| Pending-session handoff | Unique test Keychain service stored the local session while disconnected; retry delivered it through the real daemon socket and removed the pending copy; drive listing and sign-out passed |
| PKCE security | Wrong state rejected before exchange; replay of the consumed browser code returned HTTP 400 |
| Native filesystem | Kernel NFS 8 MiB read comparison and kernel SMB text/8 MiB saves, directory moves, safe save, deletion, xattrs, remote changes, conflict preservation and unmount passed |
| Offline and pressure | Real pin prefetch; 1-byte cache cap retained pinned data; a kernel SMB read matched while the data-plane process group was suspended; journal cap rejected an upload without publishing partial data |
| Recovery tests | 23 VFS tests and 6 publisher tests passed, including interrupted upload, offline queue/recovery, journal reopening and prefetched metadata/shard reads after reopening |
| CLI regression | 9 parity/isolation tests passed; a raw-token command ignored an existing unrelated daemon socket |
| Installed service | Registered actual installed LaunchAgent; confirmed `running`, live socket, authenticated drives, restored SMB mount and zero pending writes |
| Disk image | Read-only mounted the DMG, verified app signature and Applications link, then detached |
| Hosted browser file flow | After the approved CORS repair, drive listing and generated-file upload/download passed against the deployed Workers |
| Hosted native file flow | Normal `uls login --api` consumed a hosted browser PKCE code; the real daemon mounted the account drive through SMB, read the browser's 77-byte fixture exactly, and saved a 103-byte update; the independent hosted browser showed version 2 and size 103 B |

The generated hosted fixture is `unlispace-desktop-acceptance-2026-10-26.txt`. It contains only
test text and remains available for review. Its native-saved 103-byte contents have SHA-256
`653bd3069b77a514c1d464735baf78ceaa90b3c9570d495ac1e2825ee2dac81a`.

## Fixes made during acceptance

1. Removed the unusable hardcoded API fallback. Builds use `ULS_WORKERS_DOMAIN`/`ULS_API_URL`;
   unconfigured builds show actionable endpoint setup guidance.
2. Added a bounded sign-in service check, cancellation of service preparation, and an explicit
   Open browser fallback. Only a pending, state-matched callback completes that flow; provider
   denial and late callbacks are handled.
3. A fresh valid bundle reporting ServiceManagement `notFound` can proceed to registration;
   missing engine and missing service declaration remain distinct failures.
4. Ad hoc development signing omits hardened runtime and empty entitlement blobs; Developer ID
   distribution signing retains its existing runtime/entitlement path. The installation probe
   now preserves the shipped helper signature, preventing the probe from masking signing bugs.
5. Installed bundles are replaced using fresh files. Overwriting an already validated helper
   inode in place caused macOS code-signing launch failures during the check.
6. Pinning warms the mounted VFS namespace and manifests, including completed parent listings
   used to answer missing macOS metadata probes without a network request. Remote changes
   invalidate those cached listings.
7. Explicit `ULS_ACCESS_TOKEN`/`ULS_API` supports daemon-less control requests. Raw `ULS_DEV_TOKEN`
   data requests no longer resolve against an unrelated signed-in daemon. The E2E runner also
   uses an isolated non-user socket and accepts a pinned binary path to avoid concurrent Cargo
   commands swapping in a build without SMB.
8. Fixed the Bash 3 empty-array/nounset issue in the opt-in Keychain test runner.

## Approved hosted CORS repair

The user approved a scoped deployment to the existing data-plane Worker after reviewing
`hosted-cors-patch.md`. The repair downloaded the deployed implementation and added a narrow
HTTP CORS envelope, without deploying the unrelated modified backend source or migrating data.
Only `https://unlispace-web.naveen-f3d.workers.dev` is allowed on file routes; authenticated
requests retain the original authorization logic. Original source hashes and deployment config
are retained under `mac/.build/hosted-cors-review/`.

- Baseline version: `2215c14c-ad19-4fc3-898f-05a0703de95d`.
- Deployed version: `e4829d69-983a-4638-b29f-e614680be05c`.
- Node assertions and Wrangler dry-run passed before deployment; live browser listing,
  upload, commit, manifest and shard download succeeded afterward.
- The canonical production config now supplies the exact web origin through the shared domain
  placeholder for future source deployments.

## Evidence boundaries

The local browser/Swift integration and hosted browser/CLI-to-daemon sign-in are distinct
checks. The final installed GUI's system authentication-sheet presentation and complete
VoiceOver operation were not retested through native UI automation in this pass; its Computer
control surface was unavailable. State matching, fallback handling, native layouts and the
real daemon/hosted filesystem boundary have the evidence described above.

This is an ad hoc signed local review build, not a notarized distribution release. Developer ID,
notarization, update-feed publishing, and the deferred search/AI/team features are outside scope.
No application secrets or session credentials are included in this report.
