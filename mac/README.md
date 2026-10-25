# Unlispace for macOS (M0/M1 shell)

Menu-bar app (SwiftUI + AppKit, Swift 6) that controls the `ulsd` engine. Built with SwiftPM and
the Command Line Tools; no Xcode project.

## Build and test
```
swift build -c release
bash scripts/test.sh        # swift test with the CLT Testing.framework paths
bash scripts/bundle.sh      # produces build/Unlispace.app, ad-hoc signed
```
With full Xcode, plain `swift test` works. Under the CLT only, `scripts/test.sh` adds the
framework search paths for Swift Testing (XCTest is not shipped with the CLT).

`bundle.sh` places no `ulsd` binary unless you set `ULSD_BIN=/path/to/ulsd`; without it the app
reports "engine not installed".

## Run
Open `build/Unlispace.app` yourself. The app is `LSUIElement` (no Dock icon). In Settings, enter
the endpoint URL and dev token (stored in the Keychain, service `com.unlispace.app`). The
LaunchAgent is registered only when you choose "Enable engine..." in the menu. "Launch at login"
uses `SMAppService.mainApp`. `uls://` is registered as a URL scheme.

## Architecture
```
 +--------------------------- Unlispace.app (LSUIElement) ---------------------------+
 |  MenuBarExtra / Settings (SwiftUI)                                               |
 |        |                                                                         |
 |     AppModel (@MainActor, @Observable) --polls 5s + consumes events              |
 |        |                                     |                                   |
 |   DaemonClient protocol              Keychain (SecItem)   DesktopAuth (M1, PKCE) |
 |     |            |                   DaemonLifecycle (SMAppService)              |
 |  UnixSocket   MockDaemon                                                         |
 +-----|----------------------------------------------------------------------------+
       | NDJSON over ~/Library/Application Support/Unlispace/ulsd.sock
       v
   ulsd (Rust, LaunchAgent) --HTTPS--> Cloudflare Worker (/v0/drives/...)
```
Targets: `UnlispaceKit` (all testable logic), `Unlispace` (UI shell), tests in `Tests/`.
Protocol: see `DAEMON-PROTOCOL.md`.

## What is mocked or untested
- `MockDaemonClient` is used whenever the socket is absent (two demo drives, simulated mount).
- The real socket client is unit-tested only for the missing-socket case and codec; it has not run
  against a real `ulsd`.
- M1 browser sign-in (`DesktopAuth`) is behind the "Enable M1 browser sign-in" toggle and has not
  been tested against a server. Tokens from it are stored, but `ulsd` does not yet receive the
  refresh token.
- SMAppService registration and launch-at-login were not exercised (rules forbade it).
- Finder Sync extension is not built (needs Xcode); see `FinderSync/README.md`.
- Ad-hoc signing only; no hardened runtime, notarization, or Sparkle.
