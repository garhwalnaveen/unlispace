# 08-mac-app-polish integration needs

## Daemon agent: isolated socket flag

`ulsd daemon` currently has no `--socket <path>` option (`Cmd::Daemon` is a unit variant).
Please add one. Ideally derive the state directory from the override too, or provide an
explicit state directory option so integration tests cannot load a user's remembered session.
The mac integration target currently uses a fresh HOME under `/tmp` and the daemon's existing
`~/Library/Application Support/Unlispace/ulsd.sock` convention. No mounts, browser sign-in,
Keychain session or remote service is used by this test.

## Daemon/VFS agents: proposed conflict event

Propose adding this row to `mac/DAEMON-PROTOCOL.md` after agreement:

| event | data |
|---|---|
| `conflict` | `{"driveId": str, "path": str, "copy": str}` |

Example: `{"event":"conflict","data":{"driveId":"d-example","path":"/notes.txt","copy":"/notes (conflict, Mac, timestamp).txt"}}`.
`path` is the original path; `copy` is the preserved local edit, matching
`uls_vfs::VfsEvent::Conflict { path, copy }`. Emit after the conflict copy is successfully
preserved, adding the drive id from the owning VFS. The app already decodes this proposal,
shows the original/copy in the menu, and sends a UserNotifications alert if permission was
granted. The existing protocol remains unchanged until this proposal is accepted.

## Coordinator: distribution and manual review

Bundle with `ULSD_BIN=/absolute/path/to/engine/target/debug/ulsd bash mac/scripts/bundle.sh`
to include the real engine; the default bundle script still intentionally omits it.
Review onboarding, keyboard navigation, VoiceOver, light/dark appearance, notification
permission/delivery, actual mounts and browser sign-in on a Mac by manually launching the
bundle. This task forbids launching the app or registering login items.

Spec interpretation: the current M1 Unix socket protocol and NFS prototype take precedence
over product-design §5.1's future XPC transport. Network Volumes text describes macOS app
access permission without claiming that SMB is wired into this M1 daemon.
