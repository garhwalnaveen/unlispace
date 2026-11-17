# Orbit for macOS

Menu-bar app (SwiftUI + AppKit, Swift 6, macOS 14+) that controls the `ulsd` engine. The engine
mounts drives and syncs files; the app shows its state and sends it commands. Built with SwiftPM
and the Command Line Tools; no Xcode project.

## Architecture

```
Orbit.app
  App/        OrbitApp (scenes), AppDelegate (composition root), AppWindows (window routing)
  Model/      one store per concern, composed by AppModel
  Views/      SwiftUI screens; they read stores and call their actions
  Support/    preferences, prompts, global shortcut, updates, notifications
OrbitKit      protocol types, socket client, auth, Keychain, presentation logic (no UI)
      |
      |  NDJSON over ~/Library/Application Support/Orbit/ulsd.sock
      v
ulsd          the engine: mounts, sync, the session and its refresh token
```

| Store | Owns |
| --- | --- |
| `EngineLink` | The one connection: connect, reconnect, poll, event delivery, install state |
| `SessionStore` | Account, browser sign-in, session hand-off, developer token |
| `DriveStore` | Drives, mounts, offline pins and their actions, indexed by drive id |
| `ActivityStore` | Live transfers, upload queue, bounded history of finished uploads |
| `WorkspaceDirectory` | Workspaces, plan access, and web links, loaded once and shared |
| `PermissionsStore`, `ShortcutStore`, `EngineConfigStore`, `AppMessages` | macOS authorizations, the global shortcut, engine settings, status text |

`AppModel` holds the stores and only the operations that span them: applying an engine snapshot,
routing engine events, sign-out, and `uls://` links.

**No stand-in engine.** When the socket is unreachable `EngineLink.client` is nil, the stores are
cleared, and every screen says the background service is not running. The app never shows sample
data.

**Refresh.** Engine events carry live changes. Polling reconciles: every 5 s while transfers or
mounts are in flight, every 20 s when idle, and with backoff from 2 s to 60 s while the engine is
unreachable (`PollSchedule`). One refresh is two rounds of concurrent requests (`status` and
`auth.status`, then drives, transfers, uploads, pins, mounts). Concurrent refresh requests share
one pass. An error reply from the engine keeps the connection; a transport error drops it.

**Large accounts.** Events are applied in batches (50 ms window). Transfer and pin updates replace
one item by id (`IndexedList`) instead of rescanning. The activity list is built in linear time.
Drive, activity, offline, and search lists are lazy; search loads further pages as the list scrolls.
Workspace data is cached for five minutes and shared by every screen that needs it.

## Interface

The app uses standard macOS controls, system text styles, and semantic colors; `Views/Components.swift`
holds the few shared pieces. It follows the system appearance unless Settings › General says otherwise.

- **Window**: sidebar with Drives, Activity, Offline Files, Search, and Ask AI (⌘1–⌘5, ⌘F for
  Search, ⌘R to refresh). A banner above every page reports connection state, errors, and conflicts.
- **Menu bar**: status, the first six drives, and app commands.
- **Setup**: sign in, choose drives to mount and review permissions, pick the global shortcut.
- **Settings**: General, Account (with workspaces and links to Team and Billing on the web),
  Storage, Permissions, Advanced.

Buttons and menu items use title case; everything else is a plain sentence. User-facing text says
"background service", never "engine" or "daemon".

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

`MockDaemonClient` lives in `Tests/OrbitTestSupport` and is linked only into tests.
`WorkspaceRenderTests` renders every screen in light and dark from fixed engine snapshots into
`$TMPDIR/orbit-ui-review`, and fails if a screen is laid out taller than its window. It draws off
screen by default; `ORBIT_UI_CAPTURE=screen bash scripts/test.sh --filter WorkspaceRenderTests`
shows each window and captures it as the user sees it (needs screen-recording permission).

If the host cannot start SwiftPM's nested `sandbox-exec`, use `swift build -c release
--disable-sandbox`, `bash scripts/test.sh --disable-sandbox`, and `bash scripts/bundle.sh
--disable-sandbox`. Both scripts forward arguments to SwiftPM. Build artifacts stay under
`mac/.build` and `mac/build`.

`bundle.sh` places no `ulsd` binary unless you set `ULSD_BIN=/path/to/ulsd`; without it the app
says the background service is not installed.


## Run
Open `build/Orbit.app`. The app is `LSUIElement` (no Dock icon) and registers the `uls://` URL
scheme. The engine's LaunchAgent is registered only when you turn on the background service in
setup or Settings › Permissions. "Open at login" uses `SMAppService.mainApp`.

`Orbit --engine-status | --enable-engine | --disable-engine` prints one status word and exits,
for deployment and support tools.

## Sign-in
The menu, the window, or Settings › Account: **Sign In…**. Flow (`docs/design/control-plane-contract.md` 5.1):
1. `ASWebAuthenticationSession` (callback scheme `uls`) opens
   `GET {api}/auth/desktop/start?state&code_challenge&code_challenge_method=S256`.
2. The web app returns `uls://auth/callback#code&state`. The app checks `state` (constant time)
   before touching the code.
3. `POST {api}/auth/desktop/exchange {code, codeVerifier}` returns a `Session`
   (`accessToken, refreshToken, expiresIn, user{id,email}, accountCreated`; all required).
4. The app sends `auth.set {apiEndpoint, accessToken, refreshToken}` to `ulsd`. The daemon is the
   only long-term holder of the refresh token. The app keeps no copy once the daemon acks, and
   deletes the `refresh-token` Keychain item that early builds wrote.

No production API base is assumed. Set `ULS_API_URL` when running `scripts/bundle.sh` to
embed the API base. Override under Settings › Advanced › Developer (e.g. `http://127.0.0.1:8788`).

**Daemon absent fallback.** If the daemon is unreachable when sign-in finishes (no socket,
connection lost, or it answers `offline`/`internal`), the session is stored as
one Keychain item (service `com.orbit.app`, account `pending-session`, this device only,
after first unlock). Every time the app connects to a real daemon it re-sends `auth.set` and
deletes the item on acknowledgement. This is the only case where the app holds a refresh token;
it ends at the first successful hand-off. If the daemon rejects the session (`unauthorized`,
`bad_request`) the item is dropped, not retried. Sign Out also deletes it.

Signing out while the daemon is unreachable cannot clear the session the daemon holds, so the app
records the request and sends `auth.signOut` the next time it connects.


## uls:// links
- `uls://auth/callback#code&state`: completed by the sign-in session. A stray one is ignored.
- `uls://open?drive=<id>&path=<relative>`: requires sign-in; mounts the drive via the daemon if
  needed, then opens the path in Finder. `drive` must match `[a-z0-9][a-z0-9-]{2,62}`; `path` must
  be relative, with no `..` segment, control characters, or repeated parameters (checked after
  percent-decoding). The resolved path is re-checked to stay inside the mount; if the target does
  not exist, its nearest existing parent opens.


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
other errors remain errors.

The default test gate skips `KeychainTests` and `HandoffTests` to avoid Keychain access.
Run with `ULS_TEST_KEYCHAIN=1` only when explicitly authorized to exercise Keychain storage.


