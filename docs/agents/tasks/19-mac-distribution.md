# 19 · Normal (gpt-6.1-sol): Mac app distribution (Sparkle 2, dmg, sign/notarize scripts) + uploads/pins UI  — write in: mac/
Constraints: SwiftPM + Command Line Tools only (no Xcode project). There is NO Developer ID identity on
this machine and no notarytool profile: scripts must work end-to-end in ad-hoc mode and switch to real
signing/notarization only when `ULS_SIGN_IDENTITY` / `ULS_NOTARY_PROFILE` are set. Don't launch the app,
register login items, or touch the Keychain. Network: SwiftPM may fetch Sparkle only.
1. Sparkle 2 via SwiftPM (exact version pin, a 2.x release ≥ 2.6 that resolves), embedded into
   `Unlispace.app/Contents/Frameworks` by `scripts/bundle.sh` with correct rpath; `SUFeedURL` and
   `SUPublicEDKey` come from env at bundle time (Info.plist omitted keys → updater disabled, menu item
   hidden). "Check for Updates…" menu item. Updater delegate postpones install/relaunch while daemon
   `status.pendingOps > 0` or `uploads.pending` non-empty (product-design §5.4), retrying every 30 s.
2. `scripts/dmg.sh` (hdiutil, drag-to-Applications layout, versioned name), `scripts/sign.sh`
   (hardened runtime, nested code inside-out: Sparkle XPC services/Autoupdate, ulsd, app; entitlements
   files in `mac/entitlements/`), `scripts/notarize.sh` (notarytool submit --wait + stapler), and
   `scripts/appcast.sh` (Sparkle `generate_appcast` from the resolved artifact, EdDSA key path from env).
   `scripts/release.sh` chains them. Verify in ad-hoc mode: `codesign --verify --deep --strict` passes on
   the bundle and the dmg mounts read-only and contains the app (attach with `-nobrowse`, detach after).
3. UI for daemon additions in docs/design/m3-contract.md §5.1: Transfers view shows queued uploads +
   journal usage; per-drive "Keep offline" pins list with progress (`pin` events); mountpoints from
   `mounts.list`. Implement in UnlispaceKit protocol types + MockDaemonClient; real daemon support is
   landing in parallel, so decode leniently (unknown method → hide the feature).
4. Fix README.md:82 — the daemon now emits `conflict` (commit 30fb4c3).
Gate: `bash mac/scripts/test.sh` green, then `bash mac/scripts/bundle.sh` and `bash mac/scripts/dmg.sh`
in ad-hoc mode with the verification above. Report ≤ 250 words.
