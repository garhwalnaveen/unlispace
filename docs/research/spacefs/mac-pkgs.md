# Space macOS installer packages: static teardown

Date: 2026-10-25. Static analysis only. Nothing was installed, opened or executed. Tools used: `pkgutil --check-signature/--expand-full`, `plutil -p`, `codesign -d`, `security cms -D`, `otool -L/-l`, `file`, `strings`, `shasum`.

Scope: the two downloaded installer packages plus the raw CLI binary. The installed copy at /Applications/Space/Space.app and its local data are covered in a separate report (mac-client.md). The app-bundle facts below come from the **pkg payload**, not from an installed copy.

## 1. Artifacts

| URL | HTTP | Size | Type | Signing |
|---|---|---|---|---|
| downloads.spacefs.com/space-launcher-mac/Space-latest.pkg | 200 | 51,059,053 | xar product archive | Developer ID Installer: Space Computer Inc (24J8HFD297), notarized, timestamp 2026-10-24 16:47 UTC |
| downloads.spacefs.com/space/SpaceCLI.pkg | 200 | 12,933,668 | xar flat component pkg | same cert, notarized, timestamp 2026-10-24 02:25 UTC |
| downloads.spacefs.com/space/space-darwin-aarch64 | 200 | 30,800,264 | Mach-O arm64 | **ad-hoc, linker-signed only**: no Team ID, no Developer ID, no hardened runtime |

Team ID across everything: **24J8HFD297** (Space Computer Inc).

## 2. Space-latest.pkg (the main app, "Space" launcher)

### Distribution (product archive)
- Title "Space". `hostArchitectures="arm64"`, so Apple Silicon only. `customize="never"`.
- `allowed-os-versions min="15.0"`. Comment: *"Drives mount over loopback SMB from macOS 15; only the FSKit extension needs macOS 26."*
- `installationCheck()` refuses (Fatal) when `/Applications/Space/Space.app` exists and its bundle id isn't `com.spacefs.launcher`. Comment: *"Space installs to /Applications/Space/Space.app, where space-mac also installs."* So a **sibling product called "space-mac"** (`com.spacefs.mac`) uses the same path, app name and helper names.
- One component: `com.spacefs.launcher` **version 0.2.407** (CFBundleVersion 407), installKBytes 111144, install-location `/`, auth root, 107 files.
- Bundles declared: `com.spacefs.launcher`, `.FinderSync`, `.FSExtension`, `.uninstaller`, plus SPM resource bundles `space-launcher.SpaceLauncher.resources`, `highlightr.Highlightr.resources`, `swiftmath.SwiftMath.resources`.
- Build: Xcode 26.6 (17F113), SDK macosx26.5, build machine 25D125. `generator-version InstallCmds-864`.
- Installer UI resources: welcome.html, conclusion.html ("Space is ready ... Press Option + Space to open the launcher. Space stays available from the menu bar"), background.png and background-darkAqua.png.
- The Scripts dir also ships `make-background.swift`, a build-time tool that renders the installer backgrounds. It was packaged by accident and does nothing at install time.

### Payload layout
```
/Applications/Space/
  Icon\r                                   (custom folder icon)
  Uninstall Space -> Space.app/Contents/Helpers/Uninstall Space.app
  Space.app/Contents/
    Info.plist, PkgInfo, embedded.provisionprofile, _CodeSignature/
    MacOS/Space                 20.4 MB  arm64  Swift/SwiftUI+AppKit host app (menu-bar agent)
    MacOS/spacefs-fskitd        19.7 MB  arm64  Rust daemon (spacefs multicall engine)
    MacOS/spacefs -> spacefs-fskitd               (argv[0] multicall alias / CLI)
    MacOS/SpaceMountHelper      399 KB   arm64  Swift privileged LaunchDaemon (SMAppService.daemon)
    Library/LaunchDaemons/com.spacefs.launcher.MountHelper.plist
    Extensions/SpaceFSExtension.appex          FSKit module (com.apple.fskit.fsmodule), Swift
    PlugIns/SpaceFinderSync.appex              Finder Sync extension, Swift
    Helpers/Uninstall Space.app                Swift AppKit app that wraps uninstall.sh
    Resources/
      space-agent              49.4 MB  Rust AI agent (fork of Block's goose)
      space-computer-use        6.6 MB  Rust computer-use MCP server (ScreenCaptureKit)
      space-launcher-search    11.0 MB  Rust local search engine (tantivy + rocksdb)
      uninstall.sh (88 KB), finish-update-layout.sh, set-folder-icon.sh
      AppIcon.icns, SpaceDriveVolume.icns, Assets.car
      SpaceLauncher_SpaceLauncher.bundle (provider logos: anthropic, openai, codex, claude-code, grok, openrouter; onboarding media, DMSans font)
      Highlightr_Highlightr.bundle (highlight.js), SwiftMath_SwiftMath.bundle (Latin Modern Math)
      *-THIRD_PARTY_NOTICES.md, space-agent-desktopd-LICENSE-APACHE-2.0
```
- No embedded `.framework`s. No Sparkle, no Electron, no Tauri, no Rust dylib: every Rust component is a **separate static executable**.
- No LaunchAgents or LaunchDaemons are written outside the bundle. The only daemon is the in-bundle plist, registered at runtime through `SMAppService.daemon`. Launch-at-login uses `SMAppService.mainApp` (a BTM record, no plist).
- No `/usr/local/bin/space` symlink appears in the payload or scripts. If the app creates it, it does so at runtime; check the installed-app report.
- Every Mach-O is **arm64 only** (thin).

### preinstall (quoted in full)
```bash
#!/bin/bash
# Pre-install (runs as root): stop a running Space app, its search daemon and its spacefs daemon, and
# unmount any Space drives before the bundle is replaced, so the installer can overwrite files cleanly.
#
# space-mac installs to the same /Applications/Space/Space.app and uses the same process names, so
# processes are matched by their path inside a bundle that is ours by id, never by bare name. (The
# distribution's installation check already refused to install over a different app at that path.)
#
# Best-effort throughout with an explicit `exit 0` — PackageKit treats ANY non-zero pre/postinstall
# as a fatal Code 112 and aborts the whole install, so a failing cleanup step must never block the
# upgrade. Intentionally NO `set -e`.
APP_ID="com.spacefs.launcher"
APP="/Applications/Space/Space.app"
# Where installs before the rename lived (/Applications/Spacebar.app, executable Spacebar).
LEGACY_APP="/Applications/Spacebar.app"

bundle_id_of() { /usr/bin/plutil -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist" 2>/dev/null || true; }

OUR_BUNDLES=()
for bundle in "$APP" "$LEGACY_APP"; do
  [ -d "$bundle" ] && [ "$(bundle_id_of "$bundle")" = "$APP_ID" ] && OUR_BUNDLES+=("$bundle")
done

echo "Space preinstall: stopping existing processes..."
pkill -f 'space-launcher-search --socket' 2>/dev/null || true
for bundle in ${OUR_BUNDLES[@]+"${OUR_BUNDLES[@]}"}; do
  pkill -TERM -f "^$bundle/Contents/MacOS/(Space|Spacebar)( |$)" 2>/dev/null || true
done
sleep 1
for bundle in ${OUR_BUNDLES[@]+"${OUR_BUNDLES[@]}"}; do
  pkill -KILL -f "^$bundle/Contents/MacOS/(Space|Spacebar)( |$)" 2>/dev/null || true
done

# Space drives. This app and space-mac both report the `spacefs` fstype, so the mount is attributed
# by its sentinel path, which lives under ~/Library/Application Support/<app id>/sentinels/… (never
# space-mac's ~/…/spacefs/sentinels).
mount | awk -v id="$APP_ID" '/\(spacefs[,)]/ && index($0, "/" id "/sentinels/")' | while IFS= read -r line; do
  mp="$(printf '%s' "$line" | sed -E 's/^.* on (.*) \([^(]*\)$/\1/')"
  [ -n "$mp" ] || continue
  echo "  unmounting $mp"
  umount "$mp" 2>/dev/null || diskutil unmount force "$mp" 2>/dev/null || true
done

# Drives on the SMB mount method run one `spacefs mount --retained-v1` process each, from the old
# bundle. TERM makes each unmount its own client and fence its journal; give them time before KILL, so
# the new app mounts those drives again with the new binary instead of adopting old processes.
for bundle in ${OUR_BUNDLES[@]+"${OUR_BUNDLES[@]}"}; do
  pkill -TERM -f "^$bundle/Contents/MacOS/spacefs mount --retained-v1" 2>/dev/null || true
done
for _ in $(seq 60); do
  alive=0
  for bundle in ${OUR_BUNDLES[@]+"${OUR_BUNDLES[@]}"}; do
    pgrep -f "^$bundle/Contents/MacOS/spacefs mount --retained-v1" >/dev/null 2>&1 && alive=1
  done
  [ "$alive" = 1 ] || break
  sleep 0.5
done
for bundle in ${OUR_BUNDLES[@]+"${OUR_BUNDLES[@]}"}; do
  pkill -KILL -f "^$bundle/Contents/MacOS/spacefs mount --retained-v1" 2>/dev/null || true
done

# The daemon outlives the app by design; a stale one holding the App Group socket would keep
# serving the OLD binary to the freshly installed app.
for bundle in ${OUR_BUNDLES[@]+"${OUR_BUNDLES[@]}"}; do
  pkill -f "^$bundle/Contents/MacOS/spacefs-fskitd" 2>/dev/null || true
done
sleep 1
for bundle in ${OUR_BUNDLES[@]+"${OUR_BUNDLES[@]}"}; do
  pkill -KILL -f "^$bundle/Contents/MacOS/spacefs-fskitd" 2>/dev/null || true
done

# Installs from before the rename lived at /Applications/Spacebar.app. Drop that copy, and its
# extension registration, so the Mac doesn't keep two apps claiming the same FSKit module.
if [ -d "$LEGACY_APP" ] && [ "$(bundle_id_of "$LEGACY_APP")" = "$APP_ID" ]; then
  echo "  removing the previous install at $LEGACY_APP"
  CONSOLE_USER="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
  if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ]; then
    CONSOLE_UID="$(id -u "$CONSOLE_USER" 2>/dev/null || true)"
    [ -n "$CONSOLE_UID" ] && /bin/launchctl asuser "$CONSOLE_UID" /usr/bin/sudo -H -u "$CONSOLE_USER" \
      /usr/bin/pluginkit -r "$LEGACY_APP/Contents/Extensions/SpaceFSExtension.appex" 2>/dev/null || true
  fi
  rm -rf "$LEGACY_APP" 2>/dev/null || true
fi
echo "Space preinstall: done."
exit 0
```
What it does:
1. Kills `space-launcher-search --socket`, then TERMs and KILLs the host app (`Space` or the legacy `Spacebar`), matching by full bundle path.
2. Unmounts FSKit drives whose fstype is `spacefs` and whose source path is a sentinel under `~/Library/Application Support/com.spacefs.launcher/sentinels/`.
3. TERMs each per-drive SMB process, `spacefs mount --retained-v1`. It waits up to 30 s so each one unmounts and fences its journal, then KILLs any that remain.
4. Kills `spacefs-fskitd`, which outlives the app by design and holds the App Group socket.
5. Removes the legacy `/Applications/Spacebar.app` and runs `pluginkit -r` on its FSKit extension as the console user.

### postinstall (quoted in full)
```bash
#!/bin/bash
# Post-install (runs as root): register the SpaceFS file-system extension and launch Space as
# the logged-in GUI user so the menu-bar agent comes up right after install without a manual open.
#
# Every step is BEST-EFFORT and the script always exits 0 — PackageKit treats ANY non-zero
# postinstall as a fatal error (Code 112) and rolls the whole install back. The host app re-registers
# the extension on first launch (FSKitMaintenance), so registration here is only a fast path.
#
# Do NOT try to "pre-enable" the module: macOS gates FSKit module activation behind an explicit user
# toggle (System Settings → General → Login Items & Extensions → File System Extensions), keyed to
# the extension's signature; `pluginkit -e use` and seeding enabledModules.plist are unsupported
# no-ops. Running `lsregister -f -R` or killing extensionkitservice during the install races
# LaunchServices/Gatekeeper trust-record creation and can leave the bundle launch-disabled.
#
# Intentionally NO `set -e`: `pluginkit -a` run as root from installd's script sandbox returns
# "Connection invalid" (no per-user pluginkitd is reachable there), so it runs in the GUI user's
# context and its result never aborts the install.
APP="/Applications/Space/Space.app"
APPEX="$APP/Contents/Extensions/SpaceFSExtension.appex"

INSTALL_USER=$(stat -f "%Su" /dev/console 2>/dev/null || echo "")
INSTALL_UID=""
if [ -n "$INSTALL_USER" ] && [ "$INSTALL_USER" != "root" ] && [ "$INSTALL_USER" != "_mbsetupuser" ]; then
  INSTALL_UID=$(id -u "$INSTALL_USER" 2>/dev/null || echo "")
fi

# Run a command in the GUI user's context (so pluginkit reaches their per-user plugin daemon), or as
# root if there's no GUI user. Always best-effort.
as_user() {
  if [ -n "$INSTALL_UID" ]; then
    /bin/launchctl asuser "$INSTALL_UID" /usr/bin/sudo -H -u "$INSTALL_USER" "$@" 2>/dev/null || true
  else
    "$@" 2>/dev/null || true
  fi
}

echo "Space postinstall: registering filesystem extension..."
if [ -d "$APPEX" ]; then
  as_user /usr/bin/pluginkit -r "$APPEX"
  as_user /usr/bin/pluginkit -a "$APPEX"
  echo "  registered (best-effort): $APPEX"
else
  echo "  warning: extension not found at $APPEX"
fi
# Restart fskitd so it rescans modules (cheap + safe; the app also heals the per-user fskit_agent on
# its next launch, which covers in-place updates without a reboot).
killall fskitd 2>/dev/null || true

if [ -n "$INSTALL_UID" ] && [ -d "$APP" ]; then
  echo "Space postinstall: launching $APP as $INSTALL_USER (uid $INSTALL_UID)..."
  ( sleep 2; as_user /usr/bin/open -a "$APP" ) &
  disown 2>/dev/null || true
else
  echo "  no GUI user; open Space from /Applications/Space when ready."
fi
echo "Space postinstall: done."
exit 0
```
What it does:
1. Runs `pluginkit -r` and then `pluginkit -a` on the FSKit appex as the console user (via `launchctl asuser` + `sudo -u`).
2. Runs `killall fskitd` (Apple's daemon) to force a rescan of FSKit modules.
3. Opens the app as the console user after 2 s.

It does **not** activate a system extension or install a LaunchAgent/LaunchDaemon, and it doesn't create `/usr/local/bin/space`. The user still has to enable the FSKit module by hand in System Settings > General > Login Items & Extensions > File System Extensions. The postinstall comments say Apple doesn't support automating that step.

### Other scripts in the payload
- `finish-update-layout.sh <current-app> <destination-app> [applications-root]`: the privileged helper (`BundleInstaller.finishApplicationsLayout`) and the updater's legacy swap script run it after an **in-app update**. It refuses any path other than `/Applications/Space/Space.app`, recreates the `Uninstall Space` symlink, and calls `set-folder-icon.sh`.
- `set-folder-icon.sh`: uses JXA `NSWorkspace.setIcon` to set the folder icon. Cosmetic only.
- `uninstall.sh` (88 KB, identical copy inside the Uninstall app): a full footprint inventory. Its FOOTPRINT block is the most useful map of runtime state:
  - updater: `~/Library/Caches/com.spacefs.launcher/Updates` (staged.json), `/var/db/com.spacefs.launcher` (update-staging, rollback-cleanup), `/var/db/com.spacefs.launcher.update-results`, rollback bundles `/Applications/Space/Space.app.old.*`
  - launchd: `system/com.spacefs.launcher.MountHelper` (SMAppService.daemon), `gui/<uid>/application.com.spacefs.launcher*` (SMAppService.mainApp)
  - state: `~/Library/Group Containers/group.com.spacefs.launcher/{fskitd.sock, spacefs-config/config.json, SpaceDriveVolume.icns}`; `~/Library/Application Support/com.spacefs.launcher/{sentinels, retained-smb/mounts/*.json}`; `~/Library/Application Support/SpaceLauncher` (search.sock, search-index/, user-preferences.db, space-agent-owner.json, space-agent-*); `~/Library/Logs/com.spacefs.launcher/{spacefs-fskitd.log, retained-smb/*.log}`; `/tmp/space-agent-desktopd-<sha>.sock`
  - the app disables Apple's Spotlight Cmd-Space hotkey (`com.apple.symbolichotkeys` key 64) to claim it; uninstall restores it
  - TCC grants it resets: Accessibility, ListenEvent, PostEvent, ScreenCapture, AppleEvents, AddressBook, Calendar, Reminders, Desktop/Documents/Downloads, Network/Removable volumes, Full Disk Access (opt-in, used to read `~/Library/Messages/chat.db`)
  - the source-tree names it mentions (`Demo/project.yml`, `Sources/SpaceShared/SpaceAppIdentity.swift`, `Sources/SpaceLauncherHost/...`, `search-core/target/`, `Installer/build-installer.sh`) show an XcodeGen + SwiftPM project with the Rust search engine in `search-core/`.
  - legacy ids: `so.spacelauncher*` (prefs), `Spacebar` (old product name).

### Info.plist highlights (from the payload)
| Bundle | Id | Min macOS | Notes |
|---|---|---|---|
| Space.app | com.spacefs.launcher | 15.0 | `LSUIElement=true` (menu-bar agent). URL scheme `space` (CFBundleURLName `com.spacefs.launcher.auth`); **no `spacedev`**. Document type "Space Drive" (OSType `SpDr`). Custom keys: `PostHogHost=https://us.i.posthog.com`, `PostHogProjectToken=phc_«redacted»`, `SpaceAppGroup=group.com.spacefs.launcher`, `SpaceDaemonIdentifier=com.spacefs.launcher.spacefs-fskitd`, `SpaceFSShortName=SpaceFS`, `SpaceMountHelperLabel=com.spacefs.launcher.MountHelper`, `SpaceAuthCallbackScheme=space`. Usage strings mention "Space AI" (calendar), "Space Agent" (reminders), search indexing of Desktop/Documents/Downloads, Apple Mail via Apple Events, contacts, location. **No Sparkle keys** (no SUFeedURL or SUPublicEDKey). |
| SpaceFSExtension.appex | com.spacefs.launcher.FSExtension | **26.0** | `EXExtensionPointIdentifier=com.apple.fskit.fsmodule`, `FSShortName=SpaceFS`, `FSSupportsPathURLs=true`, `FSRequiresSecurityScopedPathURLResources=true`, `FSSupportsBlockResources=false`, activate options `u:g:m:o:`, check `nqy`, format `v`. A path-URL (non-block) FSKit module. |
| SpaceFinderSync.appex | com.spacefs.launcher.FinderSync | 15.0 | `com.apple.FinderSync`, principal class `SpaceFinderSync.SpaceFinderSync`, display name "Space Finder Integration" |
| Uninstall Space.app | com.spacefs.launcher.uninstaller | 15.0 | `LSMultipleInstancesProhibited` |
| MountHelper LaunchDaemon plist | label com.spacefs.launcher.MountHelper | n/a | `BundleProgram=Contents/MacOS/SpaceMountHelper`, MachService `com.spacefs.launcher.MountHelper`, AssociatedBundleIdentifiers `com.spacefs.launcher` |

No Quick Look extension, File Provider extension, Spotlight importer, XPC service bundle or system extension (DriverKit/NetworkExtension) is present.

### Entitlements and signing (all binaries: Developer ID Application, Team 24J8HFD297, hardened runtime, timestamp 2026-10-24 22:17)
| Binary | Signing id | Entitlements |
|---|---|---|
| MacOS/Space | com.spacefs.launcher | application-identifier `24J8HFD297.com.spacefs.launcher`, **com.apple.developer.fskit.mount**, app group `group.com.spacefs.launcher`, automation.apple-events, files.user-selected.read-write, personal-information addressbook/calendars/location. **Not sandboxed.** |
| MacOS/spacefs-fskitd | com.spacefs.launcher.spacefs-fskitd | app group `group.com.spacefs.launcher` only. Not sandboxed. |
| MacOS/SpaceMountHelper | SpaceMountHelper | application-identifier `24J8HFD297.com.spacefs.launcher.MountHelper` only (runs as root via SMAppService) |
| SpaceFSExtension | com.spacefs.launcher.FSExtension | **com.apple.developer.fskit.fsmodule**, **app-sandbox**, network.client, app group `group.com.spacefs.launcher` |
| SpaceFinderSync | com.spacefs.launcher.FinderSync | app-sandbox, files.user-selected.read-only, app group `24J8HFD297.com.spacefs.launcher` (team-prefixed form, unlike the others) |
| Uninstall Space | com.spacefs.launcher.uninstaller | none |
| space-agent, space-computer-use, space-launcher-search | own names | none (hardened runtime only; they inherit TCC from the parent app) |

Provisioning profiles (Developer ID, `ProvisionsAllDevices`, expire 2044):
- Host "Spacebar Host DevID-Dist" (AppIDName "Spacebar Host App"): allows fskit.mount, app groups `group.com.spacefs.launcher` and `24J8HFD297.*`, keychain-access-groups `24J8HFD297.*`.
- Extension "Spacebar FSExt DevID-Dist": allows fskit.fsmodule, the same groups and keychain.

The FSKit entitlements are managed capabilities, so they need these profiles. The keychain group is provisioned but the signed binaries don't claim it.

### UI and frameworks (host app, from `otool -L`)
SwiftUI, AppKit, Combine, Observation, FSKit, ServiceManagement, UserNotifications, WebKit, JavaScriptCore, AVKit/AVFoundation, Vision, CoreLocation, Contacts, EventKit, QuickLookUI/QuickLookThumbnailing, LinkPresentation, Metal/MetalKit, Carbon (global hotkeys), Network, CryptoKit, libsqlite3. SwiftPM dependencies: Highlightr (highlight.js in JSContext) and SwiftMath. The UI is native Swift, SwiftUI plus AppKit; there is no web-shell framework.

### Rust components in the app (crate paths from strings)
- **spacefs-fskitd** (built with rustc 58cf8f9c, CI paths `/Users/runner/...` on GitHub Actions macOS): crates `spacefs-core`, `spacefs-fskit`, `spacefs-smb`, `spacefs-nfs`, `spacefs-storage`, `spacefs-spacedb-v1`, `spacefs-retained-v1`, `spacefs-service`, `spacefs-dashboard`, plus stubs for `spacefs-fuse`/`spacefs-winfsp`. Git dependencies: `spacefs-core@b08a5f3` (a separate repo providing spacefs-storage, spacefs-spacedb-v1, spacefs-smb, spacefs-service), `spacedb@62e01dc` (crates client, storage, sdk, model, fold, queue), `rust-smb-server@6683931` (the fork). Notable registry crates: async-nats 0.49.1, aws-sdk-s3 1.148, nfsserve 0.11, axum 0.7, tokio-tungstenite, fastcdc, rmp-serde, zstd. Bundled SQLite runs a WAL-mode local store with tables `objects, dirents, xattrs, chunks (4 KiB blocks), cache_blocks, holes, pending, publications, remote_ranges, remote_keys, mutation_log, journal, local_redo_state, meta` and `state.sqlite`, `owner.lock`.
- **space-agent**: built on **goose@881f96c** (Block's open-source agent: crates goose, goose-providers, goose-agent, goose-context-management, goose-provider-types), with rmcp 2.2/3.4 (MCP), agent-client-protocol 2.0, sqlx-sqlite, tree-sitter, tiktoken-rs, minijinja, oauth2, portable-pty, jsonschema. Env prefix `SPACE_AGENT_*` plus `GOOSE_*`.
- **space-computer-use**: rmcp 3.4 + axum + objc2 ScreenCaptureKit/AppKit/ApplicationServices. A local MCP server for screenshots and input.
- **space-launcher-search**: **tantivy 0.25** + **rocksdb 0.24** + rust-stemmers + lz4/zstd. Lexical full-text search; no embedding model or ONNX runtime is bundled (none of the binaries contain one).

### Endpoints referenced in the host app (strings)
app.spacefs.com (`/desktop`), web-gateway.spacefs.com, control.spacefs.com, **compute.spacefs.com**, **drive.spacefs.com/resources/ingest**, downloads.spacefs.com, assets.spacefs.com/public/clips/, spacefs.com/{changelog,privacy,terms}, us.i.posthog.com, **speed.cloudflare.com** (bandwidth probe), an R2 public bucket `pub-133e535c1dae429f8a12b2136d541880.r2.dev/browser-packs/manifest.json` (agent browser packs, signed: `SPACE_AGENT_BROWSER_PACK_PUBLIC_KEY`), BYO-key AI providers (api.anthropic.com, api.openai.com, api.x.ai, openrouter.ai), open.er-api.com, plus claude.ai/install.sh and x.ai/cli/install.sh (agent CLI installers).

Host-app env vars include `SPACE_UPDATE_FEED`, `SPACE_UPDATE_INTERVAL`, `SPACE_UPDATER_DISABLED`, `SPACE_UPDATE_LEGACY_SWAP`, `SPACE_UPDATE_TELEMETRY_TAG`, `SPACE_GATEWAY_URL`, `SPACE_COMPUTE_URL`, `SPACE_AI_PROXY_URL`, `SPACE_WEB_LOGIN_URL`, `SPACEFS_FSKITD_BIN`, `SPACEFS_FSKIT_SOCKET`, `SPACEFS_FSKIT_FSTYPE`, `SPACEFS_CONFIG_DIR`, `SPACEFS_UPLOAD_BANDWIDTH_TARGET_BPS` and `SPACE_LAUNCHER_SEARCH_BINARY`.

### Update mechanism (from the pkg)
A custom in-app updater; there is no Sparkle. Evidence:
- `SPACE_UPDATE_FEED`/`SPACE_UPDATE_INTERVAL` env vars
- staged downloads under `~/Library/Caches/com.spacefs.launcher/Updates/staged.json` and `$TMPDIR/space-update-*.zip`
- the privileged install is done by SpaceMountHelper (`BundleInstaller`), staged in `/var/db/com.spacefs.launcher`, with result records in `/var/db/com.spacefs.launcher.update-results` and rollback copies at `Space.app.old.*`
- `finish-update-layout.sh` runs after the swap
- the prefs `update.snoozedUntil` and `update.relaunchMarker`

The release feed is keyed by the product channel string `space-launcher-mac`, the same name as the downloads path. Near it in the binary sit `https://control.spacefs.com` and `https://downloads.spacefs.com`, so the feed is probably served by control and the artifacts by downloads; the exact feed path isn't a literal. The feed metadata is validated for:
- a dotted-numeric version
- a **SHA-256 checksum (64 hex)** ("Downloaded file failed its checksum")
- an absolute http(s) download URL
- `minimumSystemVersion`

The download is staged as a zip and handed to the privileged helper ("helper_has_custody", "handing_off"). A legacy fallback (`SPACE_UPDATE_LEGACY_SWAP=1`) runs an embedded bash swap script: it arms rollback, `ditto`s NEW into `$DEST.new`, moves `DEST` to `OLD`, moves `$DEST.new` to `DEST`, then runs `finish-update-layout.sh`. Manual installs and reinstalls go through `Space-latest.pkg`.

## 3. SpaceCLI.pkg (standalone CLI)

- Flat component pkg, identifier **com.spacefs.cli**, **version 0.1.608**, install-location `/`, 6 files / 29,940 KB.
- Payload: a single file, **`/usr/local/libexec/space-cli/space`** (30,656,160 bytes, arm64 thin, Developer ID signed, Team 24J8HFD297, hardened runtime, **no entitlements**, no Info.plist bound, `LC_BUILD_VERSION minos 11.0`; the app's daemon targets minos 15.0).
- It has no preinstall script, and nothing in it touches a LaunchAgent, LaunchDaemon or extension.

### postinstall (quoted in full)
```sh
#!/bin/sh
# Put 'space' on PATH, unless something else already owns that name.
#
# The payload is already installed at this point; this only decides whether to claim the command. A
# skipped link is a complete, working install — the binary is where the payload put it.
set -eu

target="$3/usr/local/bin/space"
binary="$3/usr/local/libexec/space-cli/space"

say() { echo "space-cli: $*"; }

if [ -L "$target" ]; then
	link="$(readlink "$target")"
	case "$link" in
	*.app/Contents/*)
		say "left the Space app's command alone: $target -> $link"
		say "the app updates that copy. This CLI is installed at $binary."
		say "to make it the 'space' command instead: sudo ln -sf '/usr/local/libexec/space-cli/space' '/usr/local/bin/space'"
		exit 0
		;;
	esac
elif [ -e "$target" ]; then
	# A real file: another installer's or a hand-copied build. Keep it, and say where ours is.
	say "$target already exists and was left as it is; this CLI is installed at $binary"
	say "to make it the 'space' command instead: sudo ln -sf '/usr/local/libexec/space-cli/space' '/usr/local/bin/space'"
	exit 0
fi

mkdir -p "$3/usr/local/bin"
ln -sf "/usr/local/libexec/space-cli/space" "$target"
say "installed $target -> /usr/local/libexec/space-cli/space"
```
What it does: it creates `/usr/local/bin/space -> /usr/local/libexec/space-cli/space` only when nothing owns that name yet. If the existing name is a symlink into a `*.app/Contents/*` (the app's multicall `spacefs`), it **defers to the app**. It also leaves any regular file in place. A symlink that points anywhere else gets overwritten.

### How the standalone CLI differs from the app's spacefs-fskitd
Both are the same Rust codebase (same rustc hash, same spacedb@62e01dc and rust-smb-server@6683931 pins, same backend hosts). Differences:

| | SpaceCLI `space` 0.1.608 | App `spacefs-fskitd` (0.2.407 bundle) |
|---|---|---|
| Version line | 0.1.x | app 0.2.407 (strings show "0.2.407") |
| Signing | Developer ID, hardened, **no entitlements** | Developer ID, app group `group.com.spacefs.launcher` |
| Min macOS | 11.0 | 15.0 |
| Crates | spacefs-core, -fskit, -smb (only backend/external_host/health/mount), -nfs, stubs for fuse/winfsp. **No spacefs-storage, spacefs-spacedb-v1, spacefs-retained-v1, spacefs-service, spacefs-dashboard**, and no aws-config/sso/sts | All of those, plus the full rust-smb-server host (`smb.rs, fs.rs, disk.rs, aapl.rs, auth.rs, persistent.rs, volume_icon.rs, mf_symlink.rs, nfs_mode.rs`). The retained-v1 local SQLite engine lives only here. |
| Default socket / state | `~/Library/Group Containers/group.com.spacefs.mac/fskitd.sock`, `~/Library/Application Support/com.spacefs.mac/updater/state.json`, i.e. the **space-mac** sibling product's App Group | Same compiled-in defaults; the launcher app probably overrides them through `SPACEFS_FSKIT_SOCKET`/`SPACEFS_CONFIG_DIR` to point at `group.com.spacefs.launcher` (an inference from the env vars in the host binary) |
| Self-update | `space update` reads `latest-macos.json` from `downloads.spacefs.com/space` (Linux: `spacefs-dist.t3.tigrisfiles.io/install.sh`). It detects deb/rpm installs (`/var/lib/dpkg/info/space.list`), and for an app-owned copy prints "The Space app installs and updates this copy, and `space` follows it. Update the app." `SPACE_ALLOW_INSECURE_DOWNLOADS` env var | same code present |
| Mount adapters | Help text: "Uses the host's native adapter by default (FSKit on macOS, FUSE on Linux ... daemon-hosted, so the mount persists after this command); `--adapter smb` runs a loopback SMB server mounted via the OS SMB client (a non-privileged fallback needing no driver/extension)". SMB binds 127.0.0.1 on an OS-picked high port (avoiding 445) and macOS mounts it with `mount_smbfs` at `smb://127.0.0.1:<port>/<share>`. An NFS loopback ("bind loopback NFS server") exists too | same, plus `retained-v1` SMB mode with its own local engine |
| Daemon | macOS/Windows: "on macOS/Windows the Space app manages the daemon"; `space daemon start/info/restart`; systemd user units are Linux-only | is the daemon |

Raw `space-darwin-aarch64`: built from the same 0.1.608 sources, with near-identical strings (a few diffs in error text). It is 144 KB larger, and its SHA-256 differs from the pkg copy (`d737fa96...` vs `706a24f2...`) because it's ad-hoc linker-signed rather than Developer ID signed. Treat it as the unsigned build behind the `install.sh` path.

### CLI surface (strings)
- Commands: `login [--email]` (magic-code OTP: `POST /auth/otp/start`, `/auth/otp/verify`), `logout`, `whoami`, `use`, `drives`/`ls`, `drive create|rename|delete`, `workspace list|show|use`, `mount <drive> [--bucket <id>] [--adapter fskit|smb|fuse|nfs]`, `mounts`, `unmount`, `daemon start|info|restart|logs`, `update`, `history`, `restore`, `watch-access` (streams access-change hints), `shared-volumes`, `connect-bucket`, `supervised-tool` (runs build tools against a supervised SMB mount), plus a "Space Sandbox delegated-mount" mode that reads credential frames from stdin.
- Routes seen: `/auth/otp/start`, `/auth/otp/verify`, `/buckets/connect`, `/invites/accept`, `/volumes`, `/workspaces/delete`, `/v1/logs`, `/analytics/content-actions/cli-read`.
- Hosts: web-gateway, auth, control, creds, s3sdk (all .spacefs.com), app.spacefs.com, docs.spacefs.com, downloads.spacefs.com/space, spacefs-dist.t3.tigrisfiles.io, us.i.posthog.com.
- NATS: log messages name three streams, "metadata-sync NATS", "access-change NATS" and "demand NATS" (plus `txn/connected`). Subject strings aren't recoverable as literals.
- Env vars: `SPACEFS_DISK_CACHE(_MB)`, `SPACEFS_BG_WRITE_BUDGET_SECS`, `SPACEFS_LOG_FILE`, `SPACEFS_LOG_FORMAT`, `SPACEFS_TELEMETRY`, `SPACEFS_NATS_CONNECT_TIMEOUT_MS`, `SPACEFS_SYNC_CONNECT_TIMEOUT_MS`, `SPACEFS_SMB_{CACHE_MB,PASSWORD,LISTEN,MAX_XFER_MB,NO_LOCAL_MOUNT}`, `SPACEFS_TRASH_DIR`, `SPACEFS_FSKITD_BIN`, `SPACEFS_FSKIT_SOCKET`, `SPACE_UPDATER_STATE`, `SPACE_ALLOW_INSECURE_DOWNLOADS`. The daemon adds `SPACEFS_SMB_TRACE_OPS/READ`, `SPACEFS_SMB_STATS_SECS`, `SPACEFS_SQL_STATS_SECS`, `SPACEFS_REMOTE_STATS_SECS`, `SPACEFS_RAM_MIRROR`, `SPACEFS_FOLDER_DROP_HEAL`, `SPACEFS_DIAG_PROTECTED_DIRS` and `SPACEFS_THROUGHPUT_TELEMETRY`.
- I found no PostHog `phc_` key in the CLI binary. The app's key is in its Info.plist; the CLI may receive one from the server or config, which I couldn't determine.

## 4. Differences from what was known
- Bundle id is now **com.spacefs.launcher**, not so.getspace.Space. Legacy ids are `so.spacelauncher*` and product name "Spacebar".
- The install path is **/Applications/Space/Space.app** (inside a folder with an Uninstall link), not /Applications/Space.app.
- A **second Mac product, "space-mac" (`com.spacefs.mac`, group `group.com.spacefs.mac`)**, shares the path, name, fstype `spacefs` and helper names. The CLI's compiled defaults point at space-mac's group.
- The URL scheme in this build is `space` only; `spacedev` doesn't appear.
- The installer allows macOS 15. On macOS 15 drives mount over loopback SMB; the FSKit path needs macOS 26.
- The CLI pkg installs the real binary at /usr/local/libexec/space-cli/space and symlinks /usr/local/bin/space to it, unless the app already owns that name.

## 5. Not determined
- The exact update feed path and request parameters. The channel is `space-launcher-mac`, the metadata carries version, sha256, url and minimumSystemVersion, and the hosts are control/downloads. I couldn't see any signature check on updates beyond the SHA-256 and codesign.
- Whether the app creates `/usr/local/bin/space` at runtime. The pkg doesn't.
- The XPC/Mach protocol between the app, the extension, SpaceMountHelper and fskitd. Only the names are known: MachService `com.spacefs.launcher.MountHelper` and a Unix socket `fskitd.sock` in the App Group.
- NATS subject names, and the exact FSKit-to-daemon wire protocol (`spacefs-fskit/src/protocol.rs` exists, but its schema isn't recoverable from strings).
- Whether the CLI sends PostHog telemetry with an embedded key.
