# 08 · macOS app: real daemon wiring, onboarding, transfers UI  — write in: mac/
Read mac/README.md, DAEMON-PROTOCOL.md, engine/ulsd/src/protocol.rs + server.rs (the real daemon).
1) Integration test: a test target that spawns the real `engine/target/debug/ulsd daemon` with a
temp HOME-equivalent socket dir (add a `--socket <path>` flag request to NEEDS.md if ulsd lacks one;
otherwise use it) and drives status/drives.list/config.set through `UnixSocketDaemonClient`.
2) First-run onboarding window (sign in → choose drives to mount → "Network Volumes" privacy
explanation), transfers popover with progress bars from `transfer` events, conflict notifications
via UserNotifications for `VfsEvent::Conflict`-style daemon events (add `conflict` event to
DAEMON-PROTOCOL.md as a proposal in mac/NEEDS.md, render it if present). 3) Accessibility labels,
dark mode, VoiceOver for the menu. Gate: `swift build -c release`, `bash mac/scripts/test.sh`,
`bash mac/scripts/bundle.sh`, codesign verify. Don't launch the app or register login items.
