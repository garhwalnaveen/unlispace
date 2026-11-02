# Installed production preview acceptance — 29–30 October 2026

**Final result:** 0.2.6-preview build 6 is installed, signed in to the user's selected account,
Space is mounted once, and the engine is idle with zero pending uploads. The targeted
production recovery checks pass. This is accepted as a local preview, not a paid-launch or
100 TB capacity qualification; the remaining distribution and operational gates are below.

The production preview `0.2.3-preview` build 3 was installed from the provided DMG after
signing out through the old app and verifying `pendingOps=0` and an empty upload queue.
The previous app, preferences, state and 8.8 GB cache were archived under
`~/Orbit-deploy-backup-2026-10-29/local-install-before-preview/`, preserving recovery.
No Keychain item was read or wiped directly and no macOS protection was disabled.

Installer SHA-256: `ccd0ad15807bd5ecc768f982d0648a040c76b0568ed0654eaeb0ccc0fe110d25`.
Installed app SHA-256: `fd9f128d16b599b5dfa5657004338f38c6395fca5fad61b24a5997392a81593d`.
Installed engine SHA-256: `067adc3c578549da55ebf586069efe9fcd9313cb7aeab6c3518246608ee5a66e`.
Both executables matched the release bundle. Signature verification passed; this is an ad hoc,
locally built preview and does not establish downloaded-app Gatekeeper acceptance on a clean Mac.

## Installed behavior

- Google sign-in and desktop PKCE handoff succeeded against production. Registering the
  installed app with LaunchServices resolved the initial stalled URL handoff.
- The service first failed with a launch-constraint violation despite `.enabled` status.
  Targeted supported unregister/register recovered it. Old/new helper signing structures
  matched; stale registration is a supported inference, not a proven cache-level diagnosis.
- Space mounted through real macOS SMB. A 1 MiB test file reached production and a fresh
  cloud request returned identical bytes. Cloud manifests retained resource fork/custom xattrs.
- Historical restore recovered original file bytes and resource fork on retry.
- The initial overwrite/read-only stat encountered intermittent errno 72 (`RPC struct is bad`).
  Passing retries do not close that finding. Slow parent-directory reads reproduced it locally.
- A forced daemon kill initially failed authenticated recovery. Securityd recorded a Keychain
  ACL rejection for the updated ad hoc helper; credential loss was not established. The saved
  item still trusted older helper signatures. A later graceful restart with the account selected
  by the user recovered authentication without another Google login.
- A current-account cloud upload followed by an empty-cache mounted read passed, as did 12
  traced reopen iterations. After clearing both cache and the clean per-drive journal, ordinary
  bytes still matched, but macOS reported empty/missing attributes. Read-only journal inspection
  confirmed the VFS had hydrated the exact cloud attribute bytes; this narrows the failure to
  SMB delivery/discovery rather than loss of the stored attributes.

Only named acceptance files were created/modified. The account selected by the user during
recovery was preserved. No live payment, production rollback or backend redeployment was made
in this continuation.

## Evidence and follow-up

Private local evidence is under `~/Orbit-deploy-backup-2026-10-29/acceptance/` and
`/tmp/uls-installed-acceptance-20261029/`. Earlier continuation gates under
`/tmp/orbit-final-review-2026-10-29/continue/` passed 191 Rust tests (2 ignored), 815 SMB
tests, the Mac suite, and 53 local end-to-end checks including 50 MB stress. Those gates
preceded the installed failures above.

The preview is under acceptance, not approved for a paid launch. Code fixes and rerun results
will be recorded below after the recovery and SMB regressions complete.

## Follow-up fixes and local gates

- Startup restores Keychain access on a blocking worker, leaving RPC available while macOS
  waits for approval. A failed read exposes an explicit saved-sign-in retry in the app.
  Revision fencing prevents a late restore from replacing a newer sign-in or sign-out.
- Critical state updates now serialize the complete durable write and report persistence
  failure. Mount state rolls back on failed persistence; replayable cursor updates remain
  best effort. Sign-out reports a failed credential deletion rather than claiming it succeeded.
- Session replacement waits for old refreshes before saving a new credential, retires the old
  session before another switch, and serializes sign-out with token refresh. This closes the
  refresh/sign-out, same-account replacement and rapid A/B/A credential-deletion races.
  Account transitions clear old pin/workspace metadata after persistence, and refuse switching
  while an old mount cannot disconnect. Cached file bytes are retained.
- Compound SMB QueryDirectory and QueryInfo responses remain together with related
  CREATE/CLOSE responses. Ordinary file reads/writes retain asynchronous handling. A real
  Mac fixture reproduced the directory errors with 600 ms metadata latency and cold attribute
  failures with 2.5 s serialized stream discovery. Fixed directory operations passed 32/32;
  cold attributes improved from 0/6 to 6/6 correct values. Diagnostic code was removed.
- Release packaging now requires an isolated signed-helper `status` and signed-out
  `auth.status` RPC handshake before creating the DMG. The probe preserves helper signing
  and uses an in-memory credential store. It remains separate from actual upgrade acceptance.

Frozen recovery source passed **84 tests, 0 failures, 2 ignored** (real Keychain and privileged
NFS gates). Frozen SMB source passed **816 tests, 0 failures**, including the new delayed
compound regression, 50 MiB signed I/O, encrypted I/O, asynchronous reads/cancellation and
write/flush ordering. Evidence: `/tmp/uls-recovery-races-frozen.log`,
`/tmp/uls-smb-finish-full.log`, `/tmp/uls-smb-finish-summary.json`.

Preview 0.2.4 build 4 uses the SMB-enabled **debug Rust engine** and release Swift app;
no Rust release build was made, per repository disk/build instructions. This is an acceptance
artifact, not a performance qualification for 100 TB or 200 concurrent customers.

## Installed 0.2.4 preview acceptance

DMG SHA-256: `8d6f4e6ce7b7c07787e2eb12a56d1306c48ef66076aef5fa92e5524b4568cb38`.
The installed helper matched the signed bundle:
`6521653bb3624feff67b946e9efe82107ba68d32c5c7fc46918c51c54bddb14d`.
The prior 0.2.3 app and persistent files were retained in
`~/Orbit-deploy-backup-2026-10-29/acceptance/before-0.2.4-preview/`.
The first backup attempt stopped on a stale Unix socket; the corrected copy explicitly
excluded that transient socket before replacing the app. Both journals were clean.

The release gate passed 76 Kit tests, 19 app tests and one executed daemon integration test
(one browser fixture skipped; Keychain/Handoff tests excluded), plus signature verification,
isolated RPC and a read-only DMG mount. Installed sign-in recovered, and Space mounted with
the account chosen by the user. Initial service registration again required targeted supported
unregister/register; unsigned same-identity upgrade behavior is not considered closed.

Installed production checks passed:

- Existing test file bytes, resource fork and custom attribute.
- A new 1 MiB mounted write checked through cloud responses, 24 reopen iterations, and
  historical restore of bytes and both attributes.
- SIGKILL followed by authenticated service restart, remount and data/attribute recovery.
- Empty shard cache **and** empty clean VFS journals recovering both previous and new test
  folders, including resource forks and custom attributes. The old cache/journals were archived,
  not deleted, after confirming zero actions and no frozen batch.
- Sign-out through Settings: the engine returned `signedIn=false`, `state=signed_out`,
  `pendingOps=0`, and Space detached. The user's approved browser handoff subsequently
  reconnected the same account, and Space remounted with no pending uploads.

The write/restore harness first misclassified the CLI's successful plain-text restore output
as JSON. The harness was corrected; the complete check passed on rerun. This harness error is
retained alongside the passing evidence in `/tmp/uls-final-acceptance-20261030/`.

The successful SIGKILL drill also exposed two kernel shares stacked at the same mount path.
They detached during the subsequent supported service stop. A further source fix is under
validation: inspect the mount table before probing a dead root, recognize only exact Orbit
loopback shares, refuse live/unreachable/unrelated mounts, and bound stale-share detachment
before mounting again.

## Stale-mount and service lifecycle completion

The SMB preparation hook now runs before the engine probes the requested root. It only
force-detaches exact Orbit loopback shares whose listening port refuses connections;
live, unreachable, unrelated or changed shares stop recovery. Command execution is bounded.
The failed-mount path no longer probes a potentially dead root to remove a directory.
Eighteen library tests, 20 engine caller tests, and an explicitly executed real-Mac stale/live
mount fixture passed. The native fixture preserved the live share, detached the dead share,
and left no test mount. Evidence: `/tmp/uls-stale-mount-{unit-final,callers-final,native}.log`.

Installed 0.2.5 passed the strengthened production SIGKILL check: authenticated files and
attributes recovered in 14.56 seconds, with **exactly one** kernel SMB share at Space.

The repeated registration failure exposed a separate support-command bug. The synchronous
ServiceManagement unregister API returns before service reap; the completion API is documented
to finish after reap. The CLI now waits for that callback, propagates errors, and times out
after 15 seconds. Success/error/timeout tests pass, and the isolated installation probe reuses
the same completion waiter before removing its temporary bundle. This fixes the documented
ordering error; it does not establish that every macOS launch-constraint cache failure is fixed.

## Final preview artifact

Preview **0.2.6-preview, build 6** was built from frozen source with the same SMB-enabled
Rust helper as 0.2.5 and the updated release Swift app. Its release gate passed **79 Kit tests,
19 app tests and one executed daemon test** (one browser fixture skipped; Keychain/Handoff
excluded), signed-bundle checks, isolated RPC and completion-based unregister/reap, and the
read-only DMG check. Release evidence: `/tmp/uls-final-0.2.6-release-20261030.log`.

DMG SHA-256: `e32eb4cc454c1de8ff447caa8741bcf6d42e350152335e3241fb635e490cb6c2`.
Helper SHA-256: `fdb43f30327ec36f347e3820d08cae4e22b5b67c8619b08eb09694d0d401fb59`.
Installed app SHA-256: `c7ac61eb264db5bcb402554891afc582eb0762b8ed5790daecaaae51fdf81332`.
The previous app and persistent state are retained under
`~/Orbit-deploy-backup-2026-10-29/acceptance/before-0.2.6-preview/`.

Completion-based unregister returned successfully before first registration of this build.
The new service started on its first registration, restored the user's selected account and
mounted Space. Final installed production checks passed:

- Existing cloud file bytes and both Mac attributes.
- New 1 MiB mounted write, independent cloud byte verification, 24 reopens, and historical
  restoration of file data, resource fork and custom attribute.
- Forced daemon kill: authentication, mount, bytes and attributes recovered in **11.51 s**,
  with exactly **one** kernel Space mount.
- The installed completion-based stop returned with no helper process and no Space mount,
  checked immediately without a sleep or polling grace period.
- The clean journal and shard cache were then archived; both old and new acceptance folders
  recovered their bytes, resource forks and custom attributes with fresh local state.
- Final signature verification passed; the service is enabled, the selected account is signed
  in, Space is mounted once, `state=idle`, `pendingOps=0`, and the upload queue is empty.

All seven latest acceptance checks pass. The earlier harness parsing error remains in raw
evidence and is superseded by passing reruns. Persistent final evidence, scripts, test logs
and `final-summary.json` are under
`~/Orbit-deploy-backup-2026-10-29/acceptance/final-0.2.6-evidence/`.
The connected-app screenshot is `../final-0.2.6.png` relative to that directory.

## Limits before a paid launch

- This is an ad hoc signed local preview with a debug Rust helper. Developer ID signing,
  notarization and a downloaded first installation on a clean Mac remain unverified. Old
  preview identities can require user-approved Keychain access; no ACL was bypassed or reset.
- No 100 TB dataset or 200-customer concurrent load was exercised. Existing local stress and
  50 MiB SMB checks establish correctness at their tested sizes, not capacity or latency SLOs.
- No live merchant checkout/payment, production email sender setup, production rollback, or
  destructive production GC/quota-reconciliation recovery drill ran in this continuation.
  The deployment runbook retains those operational launch gates.
- Keychain unit tests and privileged NFS tests remain opt-in. Real saved sign-in and native
  SMB recovery were exercised above; creative-app-specific compatibility still needs its own
  acceptance matrix. `rustfmt` was unavailable; targeted whitespace checks and builds passed.

No backend redeployment, global background-task reset, Gatekeeper bypass, direct credential
read/wipe, or macOS security-setting change was performed in this continuation. Previous apps,
state and clean caches remain in the private backup for recovery. Named cloud acceptance
folders remain available for inspection.
