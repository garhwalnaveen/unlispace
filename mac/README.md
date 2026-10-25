# Unlispace for macOS (M1 shell)

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
Open `build/Unlispace.app` yourself. The app is `LSUIElement` (no Dock icon). `uls://` is
registered as a URL scheme. The LaunchAgent is registered only when you choose "Enable engine..."
in the menu. "Launch at login" uses `SMAppService.mainApp`.

## Sign-in (M1, default)
Menu or Settings -> "Sign in to Unlispace". Flow (`docs/design/m1-contract.md` 5.1):
1. `ASWebAuthenticationSession` (callback scheme `uls`) opens
   `GET {api}/auth/desktop/start?state&code_challenge&code_challenge_method=S256`.
2. The web app returns `uls://auth/callback#code&state`. The app checks `state` (constant time)
   before touching the code.
3. `POST {api}/auth/desktop/exchange {code, codeVerifier}` returns a `Session`
   (`accessToken, refreshToken, expiresIn, user{id,email}, accountCreated`; all required).
4. The app sends `auth.set {apiEndpoint, accessToken, refreshToken}` to `ulsd`. The daemon is the
   only long-term holder of the refresh token. The app keeps no copy once the daemon acks, and
   deletes the old M0 `refresh-token` Keychain item on launch.

API base defaults to `https://api.unlispace.com`; override under Settings -> Advanced -> Developer
(e.g. `http://127.0.0.1:8788`).

**Daemon absent fallback.** If the daemon is unreachable when sign-in finishes (no socket, the
mock is active, connection lost, or it answers `offline`/`internal`), the session is stored as
one Keychain item (service `com.unlispace.app`, account `pending-session`, this device only,
after first unlock). Every time the app connects to a real daemon it re-sends `auth.set` and
deletes the item on acknowledgement. This is the only case where the app holds a refresh token;
it ends at the first successful hand-off. If the daemon rejects the session (`unauthorized`,
`bad_request`) the item is dropped, not retried. "Sign out" also deletes it.

## uls:// links
- `uls://auth/callback#code&state`: completed by the sign-in session. A stray one is ignored.
- `uls://open?drive=<id>&path=<relative>`: requires sign-in; mounts the drive via the daemon if
  needed, then opens the path in Finder. `drive` must match `[a-z0-9][a-z0-9-]{2,62}`; `path` must
  be relative, with no `..` segment, control characters, or repeated parameters (checked after
  percent-decoding). The resolved path is re-checked to stay inside the mount; if the target does
  not exist, its nearest existing parent opens.

## Menu and Settings
Signed out: "Sign in to Unlispace". Signed in: email (`auth.status`), engine state, live
`transfer` / `change` / `state` events, drives with mount state (`drives.list`), mount/unmount,
"Sign out" (`auth.signOut`). Settings: account, cache cap (`config.set cacheCapBytes`), launch at
login, Advanced -> Developer (API endpoint override, M0 dev endpoint + token via `config.set`).

Logging: all error text goes through `LogFormat` (`scrub`/`describe`/`url`); secret-bearing types
redact in `description`. Tokens, codes and verifiers are never logged.

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
- `MockDaemonClient` is used whenever the socket is absent (two demo drives, simulated mount and
  auth.*; `auth.set` always "succeeds" as `demo@unlispace.local`).
- The real socket client is unit-tested only for the missing-socket case and codec; it has not run
  against a real `ulsd`. The browser sign-in has not run against a real server.
- SMAppService registration and launch-at-login were not exercised (rules forbade it).
- `uls://open` Finder opening is not exercised in tests (the parser, validator and path resolver are).
- Finder Sync extension is not built (needs Xcode); see `FinderSync/README.md`.
- Ad-hoc signing only; no hardened runtime, notarization, or Sparkle.
