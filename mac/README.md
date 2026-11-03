# Orbit for macOS (M1 shell)

Menu-bar app (SwiftUI + AppKit, Swift 6) that controls the `ulsd` engine. Built with SwiftPM and
the Command Line Tools; no Xcode project.

## Daily file workflow — 2 November 2026

The main window groups **Files** and **Activity** under Workspace, with **Offline files**
under On this Mac. The account footer opens account settings and keeps the engine state visible.
Files starts with drive, mount, and offline-selection counts, then a filterable drive list.
Find a file and ⌘F expand and focus filename search below the list; drive-name filters are
separate and appear only with multiple drives. Workspace administration and optional Ask AI
are in Settings; New drive opens Workspace settings. ⌘1 opens Files, ⌘2 opens Activity,
⌘3 opens Offline files, and ⌘R refreshes.

Setup now has three stages: sign in, connect drives, and open Finder. It retains explicit
permission actions and verifies mounting before continuing. The first-file checklist disappears
when dismissed or complete; account blockers remain separate. Only an individual file upload
completion advances its cloud-save milestone; drive summaries and Finder metadata do not.

Activity combines pending saves with matching events and omits redundant drive summaries.
Pending files and failures remain visible. Upload-journal storage is under a disclosure, with a
full-storage warning outside it. SMB still journals Finder metadata, including `.DS_Store`;
this change does not discard pending writes or change storage behavior.

These changes supersede the navigation and setup descriptions in the historical sections below.

## Build and test
```
swift build -c release
bash scripts/test.sh        # swift test with the CLT Testing.framework paths
bash scripts/bundle.sh      # produces build/Orbit.app, ad-hoc signed
```
With full Xcode, plain `swift test` works. Under the CLT only, `scripts/test.sh` adds the
framework search paths for Swift Testing (XCTest is not shipped with the CLT).
The test gate requires an existing `../engine/target/debug/ulsd`. `DaemonIntegrationTests`
spawns that binary with an isolated HOME under `/tmp`, exercises the real socket client
(`status`, `drives.list`, `config.set`, errors and cache-cap persistence), then stops it and
deletes its state. It does not sign in, mount drives, or contact remote services.

If the host cannot start SwiftPM's nested `sandbox-exec`, use `swift build -c release
--disable-sandbox`, `bash scripts/test.sh --disable-sandbox`, and `bash scripts/bundle.sh
--disable-sandbox`. Both scripts forward arguments to SwiftPM. Build artifacts stay under
`mac/.build` and `mac/build`.

`bundle.sh` places no `ulsd` binary unless you set `ULSD_BIN=/path/to/ulsd`; without it the app
reports "engine not installed".

## Run
Open `build/Orbit.app` yourself (the app displays as Orbit). The app is `LSUIElement` (no Dock icon). `uls://` is
registered as a URL scheme. The LaunchAgent is registered only when you choose "Enable engine..."
in the menu. "Launch at login" uses `SMAppService.mainApp`.

## Sign-in (M1, default)
Menu or Settings -> "Sign in to Orbit". Flow (`docs/design/m1-contract.md` 5.1):
1. `ASWebAuthenticationSession` (callback scheme `uls`) opens
   `GET {api}/auth/desktop/start?state&code_challenge&code_challenge_method=S256`.
2. The web app returns `uls://auth/callback#code&state`. The app checks `state` (constant time)
   before touching the code.
3. `POST {api}/auth/desktop/exchange {code, codeVerifier}` returns a `Session`
   (`accessToken, refreshToken, expiresIn, user{id,email}, accountCreated`; all required).
4. The app sends `auth.set {apiEndpoint, accessToken, refreshToken}` to `ulsd`. The daemon is the
   only long-term holder of the refresh token. The app keeps no copy once the daemon acks, and
   deletes the old M0 `refresh-token` Keychain item on launch.

No production API base is assumed. Set `ULS_API_URL` when running `scripts/bundle.sh` to
embed the API base. Override under Settings -> Advanced -> Developer (e.g. `http://127.0.0.1:8788`).

**Daemon absent fallback.** If the daemon is unreachable when sign-in finishes (no socket, the
mock is active, connection lost, or it answers `offline`/`internal`), the session is stored as
one Keychain item (service `com.orbit.app`, account `pending-session`, this device only,
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
First launch opens a setup window: sign in, choose real daemon drives, then read the
Network Volumes privacy explanation before mounting. “Set up later” leaves setup incomplete;
the window returns next launch and can always be opened from the menu or Settings. The app
starts polling at launch, independently of opening the menu. Setup never registers the engine
or login items automatically.

Signed out: "Sign in to Orbit". Signed in: email (`auth.status`), engine state, live
`transfer` / `change` / `state` events, drives with mount state (`drives.list`), mount/unmount,
"Sign out" (`auth.signOut`). Settings: account, cache cap (`config.set cacheCapBytes`), launch at
login, Advanced -> Developer (API endpoint override, M0 dev endpoint + token via `config.set`).
The menu uses a native window-style popover; “Transfers” opens individual progress bars,
updated by `transfer` events. Unknown totals show indeterminate progress. Finished transfers
leave the list; failures show an error in the menu. Native semantic colors follow light/dark
appearance; controls and progress bars have VoiceOver labels and values.

The daemon `conflict` event is rendered in the menu even when notifications are denied.
Setup and Settings offer an explicit “Enable conflict notifications…” action. Authorized
alerts use UserNotifications, including while the app is foregrounded. The real daemon emits it (commit `30fb4c3`).

Logging: all error text goes through `LogFormat` (`scrub`/`describe`/`url`); secret-bearing types
redact in `description`. Tokens, codes and verifiers are never logged.

## Architecture
```
 +--------------------------- Orbit.app (LSUIElement) ---------------------------+
 |  MenuBarExtra / Settings (SwiftUI)                                               |
 |        |                                                                         |
 |     AppModel (@MainActor, @Observable) --polls 5s + consumes events              |
 |        |                                     |                                   |
 |   DaemonClient protocol              Keychain (SecItem)   DesktopAuth (M1, PKCE) |
 |     |            |                   DaemonLifecycle (SMAppService)              |
 |  UnixSocket   MockDaemon                                                         |
 +-----|----------------------------------------------------------------------------+
       | NDJSON over ~/Library/Application Support/Orbit/ulsd.sock
       v
   ulsd (Rust, LaunchAgent) --HTTPS--> Cloudflare Worker (/v0/drives/...)
```
Targets: `OrbitKit` (all testable logic), `Orbit` (UI shell), tests in `Tests/`.
Protocol: see `DAEMON-PROTOCOL.md`.

## What is mocked or untested
- `MockDaemonClient` is used internally whenever the socket is absent; its demo drives and
  transfers are hidden in the UI. Onboarding cannot mount mock drives.
- The real socket client has a separate integration test against the local debug `ulsd`.
  Browser sign-in has not run against a real server.
- Onboarding, light/dark layout, keyboard/VoiceOver behavior and notification authorization or
  delivery need manual review. The app was not launched for this task.
- SMAppService registration and launch-at-login were not exercised (rules forbade it).
- `uls://open` Finder opening is not exercised in tests (the parser, validator and path resolver are).
- Finder Sync extension is not built (needs Xcode); see `FinderSync/README.md`.
- Ad-hoc signing only; no hardened runtime, notarization, or Sparkle.


## Distribution (Command Line Tools only)

`bash mac/scripts/release.sh` tests, bundles, signs inside-out, creates a compressed read-only
DMG with an Applications shortcut, and verifies the mounted copy before detaching. It never
launches the app. It requires `ULSD_BIN`, `ULS_VERSION`, `ULS_BUILD`, and a production
API endpoint (`ULS_API_URL`). Default signing is ad-hoc; the
unnotarized app requires users to explicitly allow it in macOS settings. Developer ID
builds enable hardened runtime.

Set `ULS_SIGN_IDENTITY` to a Developer ID Application identity for real signing, and
`ULS_NOTARY_PROFILE` to an existing notarytool profile for submission, waiting, and stapling.
Supply both values together; without either, notarization and appcast generation are skipped.
Set both `ULS_SU_FEED_URL` (HTTPS) and `ULS_SU_PUBLIC_ED_KEY` at bundle time to enable Sparkle;
otherwise both plist keys are omitted and Check for Updates is hidden. Sparkle is pinned to
2.6.4 and copied from its resolved XCFramework, with an executable-relative framework rpath.
Set `ULS_EDDSA_KEY_FILE` to an existing private EdDSA key file to generate `build/feed/appcast.xml`
using the resolved Sparkle `generate_appcast`. Without a key, appcast generation skips. Publish
the signed feed and DMG separately. Never commit private keys.

Install/relaunch waits for fresh `status.pendingOps == 0` and an empty `uploads.pending`,
then cleanly unmounts drives and checks again. Failed/disconnected checks retry every 30 seconds.
An older daemon's unknown-method response hides uploads, pins or mounts independently;
other errors remain errors. Transfers shows the upload queue and journal usage. Each drive's
Keep offline menu pins the whole drive and lists paths with live `pin` progress and unpin actions.

The default test gate skips `KeychainTests` and `HandoffTests` to avoid Keychain access.
Run with `ULS_TEST_KEYCHAIN=1` only when explicitly authorized to exercise Keychain storage.


## Desktop workspace (Space UX review)

The native app opens a resizable drive workspace on launch and reopen. My drives provides
name filtering, inline Mount/Open in Finder/Eject actions and offline options. Transfers
shows the existing live progress and upload queue. The menu-bar popover still provides quick
access and an Open app action. Settings uses General, Account, Cache, Permissions and Advanced
sidebar pages with persisted System/Light/Dark appearance. Setup retains the authenticated
three-stage flow with a visible step indicator.

See `../docs/design/space-desktop-comparison.md` for the observed comparison, scope and remaining
acceptance work. `WorkspaceRenderTests` renders signed-out, fixture drives, settings and
transfers in both appearances to the system temporary directory under `orbit-ui-review/`.
These fixtures do not authenticate or mount drives.

Ad hoc development signing omits hardened runtime so the embedded ad hoc Sparkle framework
can load without a team identity. Developer ID signing retains hardened runtime and timestamping.
The bundle is for local review; this does not establish notarization or cloud-flow acceptance.


## Completed desktop acceptance (26 October 2026)

The October 2026 review build was configured for `https://orbit-api.naveen-f3d.workers.dev` and included
the SMB-enabled engine. An unconfigured build shows an endpoint setup message rather than
silently using an unavailable hostname. Sign-in checks the service with a 15-second deadline;
Open browser offers a state-checked custom-scheme fallback when the system sheet is unavailable.
Cancellation also stops service preparation.

`Orbit.app/Contents/MacOS/Orbit --engine-status`, `--enable-engine`, and
`--disable-engine` provide ServiceManagement operations for installation/support tools.
Disabling waits up to 15 seconds for macOS's unregistration completion callback before
reporting success, so a subsequent registration does not race service shutdown.
`bash mac/scripts/check-installation.sh` validates the actual shipped helper signature in a
separate temporary app, registering an isolated memory-store daemon, requiring valid `status`
and signed-out `auth.status` RPC responses, and unregistering it. Release packaging runs this
gate before creating the DMG. This isolated check does not establish same-identity installed
upgrade behavior; the installed app must still pass restart and saved sign-in acceptance.
For installed updates, replace the app bundle with fresh files rather than overwriting executable
inodes in place; macOS can retain invalid code-signing state for an overwritten helper.

The installed app's LaunchAgent was confirmed running with the hosted account restored,
the Space drive remounted, and zero pending writes. The hosted browser and native kernel SMB
mount exchanged a generated test file. See `../docs/design/desktop-acceptance.md` for exact
checks, the approved production CORS repair, and remaining evidence limits.

## Access & permissions dashboard

Setup's final step and Settings → Permissions share one dashboard for background engine,
per-app network-volume access, optional conflict notifications and optional launch at login.
Status is refreshed on appearance, app activation and manual refresh; permissions are requested
only from the corresponding action. Denied notification access links to System Settings.
Skipping optional access does not block setup. See `../docs/design/permissions-experience.md`.

The workspace also includes an Offline files page showing live per-selection cached bytes
and progress, with Finder and stop-offline actions. Drive filters combine name search with
All/Mounted/Not mounted/Needs attention and offer Clear filters recovery. Keyboard shortcuts:
⌘1 My drives, ⌘2 Transfers, ⌘3 Offline files, ⌘F focus the drive filter, ⌘R refresh.
Drive operations reject duplicate in-flight requests and mock connections.


## Shared desktop styling

`Sources/Orbit/DesignSystem.swift` defines a layered neutral light/dark palette, inset icon
surfaces, rounded panel borders, and heading scale used by the workspace, setup, settings,
and menu-bar UI. Buttons and group boxes use native SwiftUI styles and the system accent,
including native selection and prominent-button contrast. Drive badges pair a distinct
symbol with every mount state. Transfer rows separate filename, full path, and progress so
pending saves, failures, and drive summaries remain explicit.
System typography, SF Symbols, native navigation and form controls remain in use. Drive
and offline-file actions stack when horizontal space is limited. Increased Contrast uses
stronger panel borders; status labels retain their semantic colors.

`DesignSystemTests` checks AA text contrast across canvas, panel, sidebar, and inset surfaces
in both appearances, distinct drive-state symbols/labels, and transfer filename presentation.
`WorkspaceRenderTests` renders window-backed fixtures, including the 800 × 580 workspace,
compact offline actions, setup, and menu-bar UI. Images are written under the system
temporary directory at `orbit-ui-review/`. These fixtures do not sign in or mount drives.
