# 08-mac-app-polish integration needs

## Daemon agent: isolated socket flag

`ulsd daemon` currently has no `--socket <path>` option (`Cmd::Daemon` is a unit variant).
Please add one. Ideally derive the state directory from the override too, or provide an
explicit state directory option so integration tests cannot load a user's remembered session.
The mac integration target currently uses a fresh HOME under `/tmp` and the daemon's existing
`~/Library/Application Support/Unlispace/ulsd.sock` convention. No mounts, browser sign-in,
Keychain session or remote service is used by this test.

## Conflict event status

Resolved: the daemon emits `conflict` as of `30fb4c3`; the app decodes and displays it.

## Coordinator: distribution and manual review

Bundle with `ULSD_BIN=/absolute/path/to/engine/target/debug/ulsd bash mac/scripts/bundle.sh`
to include the real engine; the default bundle script still intentionally omits it.
Review onboarding, keyboard navigation, VoiceOver, light/dark appearance, notification
permission/delivery, actual mounts and browser sign-in on a Mac by manually launching the
bundle. This task forbids launching the app or registering login items.

Spec interpretation: the current M1 Unix socket protocol and NFS prototype take precedence
over product-design §5.1's future XPC transport. Network Volumes text describes macOS app
access permission without claiming that SMB is wired into this M1 daemon.


# 19-mac-distribution integration needs

- Coordinator/release owner: supply Developer ID identity, notarytool profile, HTTPS feed URL,
  public EdDSA key and private EdDSA key file via the documented environment variables.
  No credentials were provisioned and nothing was published by this task.
- Daemon agent: keep `status.pendingOps`, `uploads`, `mounts.list`, `pins.list`, `drive.pin`,
  and `pin` events aligned with M3 §5.1. Unknown methods hide only the unavailable feature.
  Update checks fail closed when the socket/status is unavailable. The updater unmounts all
  mounted drives and rechecks pending work before handing control back to Sparkle.
- Coordinator: manually validate actual update download/install/relaunch and the uploads/pins
  UI against the new daemon. A fresh-status check followed by installation is not an atomic
  daemon quiescence protocol; future writers outside mounted drives need a daemon update
  barrier if they can enqueue writes after the final check.

- Coordinator: rerun `bash mac/scripts/dmg.sh` outside this execution sandbox. Here the
  diagnostic was `[DIHelperProxy threadSetupServer] Cannot start hdiejectd because app is
  sandboxed`, followed by `hdiutil: create failed - Device not configured`. No DMG mount
  occurred; read-only mount/content/detach verification remains blocked on host access.
