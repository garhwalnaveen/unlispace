# Finder Sync extension (not built yet)

`OrbitFinder.appex` needs a full Xcode toolchain (app-extension bundling, entitlements,
provisioning). It is intentionally skipped while we build with SwiftPM and the Command Line Tools.

Planned behaviour (product-design.md section 5.1):
- Badges: synced, uploading, conflict, offline, driven by the daemon's `change` and `transfer` events.
- Context menu: Version history..., Copy link, Restore.
- Talks to `ulsd` through the same socket protocol (`DAEMON-PROTOCOL.md`), or via the app over an
  app-group channel. Monitored root: the drive mount points under `/Volumes`.

When Xcode is available: add an Xcode project (or XcodeGen spec) with a Finder Sync extension target
that embeds in `Orbit.app/Contents/PlugIns/`, sharing `OrbitKit` for the protocol types.
