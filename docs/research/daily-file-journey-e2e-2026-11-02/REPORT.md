# Daily file journey: live and isolated acceptance

This run started on 2 November 2026 and continued on 3 November. The Mac slept and locked; interrupted
transfer timings are excluded. No hosted deployment, subscription change, account creation,
or existing cloud-file modification was performed.

## Verified

| Check | Result |
| --- | --- |
| Hosted Google sign-in | Passed using existing accounts; desktop sign-in/setup was user-assisted |
| Native drive mount | Passed through a temporary memory-store engine and, after relaunch, the registered engine at `/Users/naveen/Orbit/Space`; real read-only kernel NFS mounts |
| Expired-account protection | `/me/access` reports `expired`, `writable: false`; native UI shows Read only, disables Add file, and displays the plan warning |
| Files / Activity | Live two-page navigation and Command-2 passed |
| Command-F from Activity | Returned to Files and focused filename search |
| Cloud filename search | Passed in the corrected preview; searching `metadata` returned two real cloud files, and Show in Finder selected the requested file |
| Native small-file cloud read | 103 bytes; matched recorded source SHA-256 |
| Native larger cloud read | 50,000,000 bytes; matched recorded source SHA-256 on retry after sleep; not a cold throughput benchmark |
| Native 1 MiB cloud read | Read all 1,048,576 bytes of the existing acceptance payload through the registered engine; hash recorded, independent expected hash unavailable |
| Fresh hosted transfer | Uploaded new 90-byte text and 8,388,608-byte binary fixtures through Chrome's native Mac picker, downloaded both through the website, and independently verified exact bytes and SHA-256 against the local originals |
| Swift gate | 82 OrbitKit tests, 27 OrbitApp tests and isolated real-daemon round trip passed; optional Worker-browser test and Keychain suites not enabled |
| Isolated local Worker / filesystem gate | 50 passed, 0 failed; 8 MiB native SMB write and independent read, safe saves, xattrs, conflicts, versions/restore, S3, offline pinned reads, journal cap, and cleanup |
| Production builds | Swift release and web builds passed; corrected preview signature verified |

Full byte counts and hashes are in [downloads.json](downloads.json). The larger source hash
comes from [the earlier generated fixture](../performance/space-vs-orbit-50mb-2026-10-26.md).
The isolated gate uses local Workers and synthetic accounts; it does not establish hosted upload
acceptance or offline-write reconnect recovery.

The separate fresh hosted round trip used the existing writable browser workspace and two
uniquely named generated files, without modifying its existing benchmark folder. Both cloud
file detail pages exposed a saved version; Chrome reported the downloads complete.
The native picker succeeded after bringing the correct Chrome window forward. No extension
permission was changed. Byte counts and hashes are in
[fresh-hosted-roundtrip.json](fresh-hosted-roundtrip.json); screenshots show
[the uploaded files](fresh-cloud-upload.jpg) and [completed downloads](fresh-cloud-download.png).
This verifies the hosted website path, not a fresh desktop upload or a throughput benchmark.

## Problems found and corrections

1. The source production endpoint and earlier preview pointed to `orbit-api`, which returns 404.
   The deployed site's public bundle uses `unlispace-api`; its desktop-start endpoint returned
   the expected 302 to `orbitfs.io/desktop`. Corrected `web/.env.production` and the verified
   preview's embedded endpoint. No service was deployed or renamed.
2. Successful polling cleared a sign-in error immediately, making a failed sign-in look like
   an inactive button. Background refresh now clears only its own error. A regression test
   verifies that action errors survive a successful refresh.
3. The read-only account still saw an instruction to add its first file. The checklist now
   hides for known read-only access, while unknown access and transient failures retain it.
   Focused Swift tests passed (16 tests across five suites); the rebuilt preview was relaunched
   and the contradictory checklist was absent, with Add file still disabled.

Mac release packaging now requires an explicit `ULS_API_URL`, retaining HTTPS validation.
Local bundles can remain unconfigured. This removes the stale worker-name inference from
future bundles; active deployment instructions and web production configuration were updated.
Shell syntax and endpoint validation checks passed. Cloud issuer settings were not changed.

The rebuilt `mac/build/Orbit-verified.app` includes both corrections and passed
compilation/signature checks. It was relaunched with its embedded API setting and passed
sign-in, read-only mounting, Files/Activity navigation, Command-F focus, filename search,
and Show in Finder. The final incremental release build and signature verification also passed.
It has not replaced the installed app.

## Incomplete live checks

- The two desktop-tested accounts have expired trials and do not grant write access.
  A third existing browser session has a ready, writable drive with three trial days remaining.
  Its hosted browser upload/download round trip passed. A fresh hosted write through the
  desktop remains unverified because its signed-in account is read-only.
- A browser download of an existing 1 MiB fixture reported `Failed to fetch` around the
  sleep/lock interruption. It remains unverified; no corruption or root cause is claimed.
- Browser callback fallback coexists with the older installed app registering `uls://`.
  The system authentication tab completed the preview sign-in; the separate fallback also
  launched the older app. Clean installed-upgrade callback acceptance remains unverified.
- Full keyboard-only/VoiceOver operation, hosted write recovery, and real conflict delivery
  were not completed in the GUI. The local gate covers the underlying conflict and offline-read
  paths separately.

Transient logs are under `/tmp/orbit-cloud-e2e-f5sj0799/`: `local-e2e.log`,
`swift-tests.log`, `release-build.log`, `web-build.log`, and `verified-bundle.log`.
No credentials are included in this report.

## Cleanup

The temporary test engine was checked with zero pending operations/uploads, signed out,
verified to have no mounts, and stopped. The macOS background engine enabled during
user-assisted setup was left in place. During the 3 November retest the corrected preview
signed into that engine and mounted Space read-only at `/Users/naveen/Orbit/Space`.
That session and mount remain available. Existing legacy service and unrelated mounted
volumes were not stopped or changed. The third browser session's account settings and
existing benchmark folder were preserved.
The two new cloud fixtures and their downloaded copies remain available for review;
no existing cloud files were overwritten or deleted.
