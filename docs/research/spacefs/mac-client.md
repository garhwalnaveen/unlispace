# Space Mac client (com.spacefs.launcher 0.2.407): static and local-state analysis

Source: the installed bundle at /Applications/Space/Space.app and the signed-in user's local state on this Mac, inspected read-only on 2026-10-25. Nothing was launched, killed or written under the app or its data. Every token, key and secret value is redacted; only key names and structure are given. The pkg was not downloaded: the installed receipt (`pkgutil --pkg-info com.spacefs.launcher`, 106 files, v0.2.407) matches the bundle.

## TL;DR

- Space is a Swift/SwiftUI menu-bar app (LSUIElement). It acts as a Spotlight replacement (it takes over Cmd-Space), a cloud drive and an AI agent. It is signed by Developer ID "Space Computer Inc" (24J8HFD297), notarized-style with hardened runtime, and **not sandboxed**. The product was formerly called "Spacebar" (legacy id `so.spacelauncher`). A sibling product, `com.spacefs.mac` ("space-mac"), shares the team, install path and helper names.
- The drive is mounted through **FSKit**: the Rust daemon `spacefs-fskitd` runs `/sbin/mount -F -t SpaceFS <sentinel> /Volumes/<name>`, and macOS loads `SpaceFSExtension.appex` (an FSUnaryFileSystem). That extension talks to the daemon over a UNIX socket in the App Group container. There is also a **loopback SMB fallback** (127.0.0.1, `mount_smbfs`) that needs no extension.
- **On this Mac no drive is mounted.** The SpaceFS module is registered with pluginkit but **not enabled** (it is missing from `enabledModules.plist`). The privileged `MountHelper` LaunchDaemon is not loaded. `spacefs-fskitd` ran twice for about 1.5 s right after sign-in and then exited.
- Backend: `auth.` / `control.` / `creds.` / `web-gateway.` / `fanout.` / `s3sdk.spacefs.com`. Storage is per-workspace S3-compatible buckets (`spacedb-<workspace-uuid>-data`) across 10 backends (AWS, B2, GCS, six IDrive e2 regions, Tigris). Change notification runs over NATS/WebSocket.
- The session is an **HS256 JWT with a 100-year expiry**, stored in plaintext JSON (mode 0600) in the App Group container.
- AI provider: **OpenRouter**, model **`space`** (a Space-managed alias, "Space model": 1.05M context, 128k output), reasoning effort `medium`. The API key is an **environment reference (`OPENROUTER_API_KEY`), not a stored key**. No BYOK key file exists, so this is the **Space-managed allowance**: $2 `free_annual` window, 0 keys issued, not BYOK.

## 1. Bundle layout and signing

| Component | Path | Identifier | Notes |
|---|---|---|---|
| Main app | Contents/MacOS/Space (20 MB, arm64 only) | com.spacefs.launcher | Swift/SwiftUI. Hardened runtime, **no app-sandbox** |
| Daemon + CLI | Contents/MacOS/spacefs-fskitd (19.7 MB), `spacefs` symlink | com.spacefs.launcher.spacefs-fskitd | Rust multicall binary. Entitlement: app group only |
| Privileged helper | Contents/MacOS/SpaceMountHelper | SpaceMountHelper | LaunchDaemon `com.spacefs.launcher.MountHelper` (SMAppService.daemon, MachService of the same name) |
| FSKit module | Contents/Extensions/SpaceFSExtension.appex | com.spacefs.launcher.FSExtension | `com.apple.fskit.fsmodule`. Sandboxed + `network.client`. Min macOS 26.0 |
| Finder Sync | Contents/PlugIns/SpaceFinderSync.appex | com.spacefs.launcher.FinderSync | Sandboxed, user-selected read-only |
| Search | Contents/Resources/space-launcher-search (11 MB) | space-launcher-search | Rust, tantivy + RocksDB (frecency) |
| AI agent | Contents/Resources/space-agent (49 MB) | space-agent | Rust; local HTTP server; 75 tools |
| Computer use | Contents/Resources/space-computer-use (6.6 MB) | space-computer-use | Rust; private WindowServer event tricks (credits yabai and cua-driver) |
| Uninstaller | Contents/Helpers/Uninstall Space.app + Resources/uninstall.sh (88 KB) | | uninstall.sh documents the whole on-disk footprint (see 7) |

- Version 0.2.407 (build 407). Built with Xcode 26.6 against the macOS 26.5 SDK. Min OS is 15.0 for the app and 26.0 for the FSKit extension.
- Provisioning profile: "Spacebar Host DevID-Dist", AppIDName "Spacebar Host App", team "Space Computer Inc". It grants `com.apple.developer.fskit.mount`, app groups `group.com.spacefs.launcher` and `24J8HFD297.*`, and keychain group `24J8HFD297.*`. Expires 2044.
- Main-app entitlements: `fskit.mount`, `automation.apple-events`, `files.user-selected.read-write`, `personal-information.{addressbook,calendars,location}`, app group `group.com.spacefs.launcher`.
- URL scheme `space://` (`com.spacefs.launcher.auth`) is used for the sign-in callback.
- Info.plist contains `PostHogHost=https://us.i.posthog.com` and a `PostHogProjectToken` (a `phc_…` client token; value redacted). Other custom keys: `SpaceAppGroup`, `SpaceDaemonIdentifier`, `SpaceFSShortName=SpaceFS`, `SpaceMountHelperLabel`.
- TCC usage strings: Apple Events (Mail read-only), Calendars, Contacts, Desktop/Documents/Downloads (indexing), Location, Network Volumes (SMB mounts), Reminders. The uninstaller also resets Accessibility, Input Monitoring, Screen Recording and Full Disk Access (opt-in for reading Messages chat.db).
- Main app links FSKit, ServiceManagement, WebKit, JavaScriptCore, EventKit, Contacts, CoreLocation, Vision, CryptoKit, Network and libsqlite3.
- Mismatch: the FinderSync appex's app group is `24J8HFD297.com.spacefs.launcher`, not the `group.com.spacefs.launcher` used by everything else. That explains why the `24J8HFD297.com.spacefs.launcher` group container exists but holds only containermanager metadata.

## 2. How the drive mounts (FSKit)

Reconstructed from strings in `spacefs-fskitd`, `SpaceFSExtension` and `SpaceMountHelper`, plus the unified log:

1. Space.app starts `spacefs-fskitd`, the "spacefs FSKit daemon", and redirects its output to `~/Library/Logs/com.spacefs.launcher/spacefs-fskitd.log`. It sets env vars including `SPACEFS_FSKIT_SOCKET`, `SPACEFS_FSKIT_FSTYPE`, `SPACE_GATEWAY_URL`, `SPACE_WEB_LOGIN_URL`, `SPACEFS_DISK_CACHE_MB`, `SPACEFS_READAHEAD_BLOCKS` and `SPACEFS_UPLOAD_BANDWIDTH_TARGET_BPS`. The daemon listens on `~/Library/Group Containers/group.com.spacefs.launcher/fskitd.sock` / `spacefs-fskitd.sock`.
2. The app asks the root `SpaceMountHelper` over NSXPC to `prepareMountpoint:` under `/Volumes`, and `createAliasSymlink:target:` for friendly names. The helper validates callers with the code requirement `anchor apple generic and identifier "com.spacefs.launcher" and certificate leaf[subject.OU] = "24J8HFD297"`. The same helper also does in-place updates: `stageUpdateBundle:`, `commitUpdateBundle:appPID:`, and `removeRetainedPreviousBundle:` via `/var/db/com.spacefs.launcher/update-staging`.
3. The daemon writes a **sentinel** file under `~/Library/Application Support/com.spacefs.launcher/sentinels/` and runs `/sbin/mount -F -t SpaceFS <sentinel> <mountpoint>`. On failure it reports "is the SpaceFS file system extension installed & enabled?".
4. fskitd/fskit_agent load `SpaceFSExtension.appex`. Its Info.plist declares `FSSupportsPathURLs=true`, `FSSupportsBlockResources=false` and `FSRequiresSecurityScopedPathURLResources=true`, so the "resource" is the sentinel path URL, not a block device. Activate options are `-u -g -m -o`. The extension reads `.spacefsconfig.json`/the sentinel ("no spacefs sentinel at …"), connects to the daemon socket (`DaemonClient`, `DaemonPool`, `WireProtocol`, JSON bodies) and implements `FSVolumeOperations`, ReadWrite, OpenClose, Rename, Xattr, AccessCheck, PathConf and ItemDeactivation. All file I/O is proxied to the daemon.
5. The daemon (crates `spacefs-core`, `spacefs-fskit`, `spacefs-spacedb-v1`, `spacefs-storage`, `spacefs-retained-v1`) serves a VFS. It has a RAM+disk block cache, read-ahead, a write-back upload queue, pins, a conflict journal and a WAL. It reads and writes S3-compatible objects (aws-sdk-s3 / SigV4), syncs metadata via NATS, and falls back to `wss://fanout.spacefs.com`.

Fallback adapters in the same binary: `--adapter smb` runs a loopback SMB 3.1.1 server on 127.0.0.1 (ephemeral port, avoids 445) mounted with `mount_smbfs`, a "non-privileged fallback needing no driver/extension". Remembered under `Application Support/com.spacefs.launcher/retained-smb/`. There are also FUSE and NFS adapters (Linux, via `nfsserve`) and WinFsp (Windows). FSKit is the only adapter that shows the drive's display name instead of `spacedb-<uuid>-data`.

CLI surface (`spacefs`/`space`): `login [--email]` (magic code: `/auth/otp/start`, `/auth/otp/verify`), `drives`, `drive create`, `mount [--bucket <id>] [mountpoint]`, `mounts`, `unmount`, `invite`, `workspace list`, `daemon start|restart|info`, `update` (from `downloads.spacefs.com/space` / `spacefs-dist.t3.tigrisfiles.io/install.sh`). It also has a `supervised-mount` mode for a "Space Sandbox" that takes credential frames on stdin, and an `s3sdk` access-key mount (`--s3sdk-key-id`, `--s3sdk-secret`) that bypasses Space login.

Security note: the daemon has an optional local web dashboard (`--dashboard-addr` / `SPACEFS_DASHBOARD_ADDR`, `/api/health|snapshot|stream|rpc|cache/clear`). Its own help text says "the dashboard has no auth". It is not enabled on this machine.

### Observed state on this Mac

- `mount` shows no spacefs/SMB volume. `/Volumes` has no Space drive. `~/Library/Logs/com.spacefs.launcher` does not exist.
- `pluginkit`: `com.spacefs.launcher.FinderSync` is enabled (`+`). `com.spacefs.launcher.FSExtension` is registered but **not enabled**. `~/Library/Group Containers/group.com.apple.fskit.settings/enabledModules.plist` lists only apfs, exfat, msdos, ntfs and ftp. The user has not yet turned on SpaceFS in System Settings → General → Login Items & Extensions → File System Extensions.
- `launchctl print system/com.spacefs.launcher.MountHelper` returns "Could not find service", so the privileged helper is not registered or approved. `launchctl list` shows only the app itself (`application.com.spacefs.launcher.*`, managed by RunningBoard).
- `systemextensionsctl list`: no Space system extensions (it uses FSKit app extensions, not system extensions).
- Unified log timeline:
  - 12:07:02 `[com.spacefs.launcher:FSKitMaintenance] bundle version changed (none -> 0.2.407); re-registering with LaunchServices and restarting fskit_agent so the new extension loads`. fskitd/fskit_agent restart (new PIDs 22867/22870) and "Added 4 identifiers".
  - 12:07:02 SMAppService register → status 1 (the launch-at-login main-app item; `[so.spacelauncher:LaunchAtLogin] default result status=enabled`). Later periodic `Service <private> status: 3` (3 = notFound in SMAppService.Status) fits the MountHelper daemon being unregistered. That is inferred, because the service name is `<private>`.
  - 12:07:02 `[Sidebar]` "macOS reserves Finder's Favorites list for applications with Full Disk Access, which Space does not ask for".
  - 12:07:11 `[ForcePolicy] min_version=0.2.392 severity=required`.
  - 12:07:13 `[SpaceSession] sign-in callback accepted; exchanging the one-time code`.
  - 12:07:15 two `spacefs-fskitd` processes (22883, 22884) start, do TLS trust evaluation and one TCP connection each, then exit about 1.5 s later. These look like CLI-config/credential probes; no mount attempt was logged.
- The running processes match the brief: Space (22845), space-launcher-search (22853, child of Space), three SpaceFinderSync instances, fskitd (root) and fskit_agent. **space-agent, space-computer-use, spacefs-fskitd and SpaceMountHelper are not running.**
- `lsof -i` on Space, space-launcher-search and SpaceFinderSync shows **no TCP/UDP sockets** at snapshot time. Only UNIX sockets are open: Space ↔ `search.sock` (6 connections). Network use is bursty HTTPS (h2, TLS 1.3, `TLS_AES_256_GCM_SHA384`). About 35 request summaries in 40 minutes were mostly 200/206, with one 403.

## 3. Network endpoints (from binaries + URL cache)

Observed in `~/Library/Caches/com.spacefs.launcher/Cache.db`, all at sign-in time:

| Endpoint | Purpose / response shape |
|---|---|
| `GET control.spacefs.com/shared-volumes` | `{shared_volumes: []}` |
| `GET control.spacefs.com/invites/pending` | `{invitations: []}` |
| `GET control.spacefs.com/backends` | 10 backends: `aws` us-east-1, `b2` ca-east-006, `gcs` auto, `idrivee2worker-{ap-northeast-1,ca-east-1,eu-central-1,eu-west-4,us-east-1,us-west-2}`, `tigris` (tigrisworker, iad). None `is_default` |
| `GET control.spacefs.com/members?workspace_id=` | Member list (owner = the user) |
| `GET control.spacefs.com/ai/quota?workspace_id=` | `windows[{definition: free_annual, limit_usd: 2.0000, remaining_usd: 2.0000, keys: 0, state: not_anchored}]`, `outstanding_keys: []`, `addons: []` |
| `GET control.spacefs.com/ai/model?workspace_id=` | `{model_ref: "space", label: "Space model", context_tokens: 1050000, max_output_tokens: 128000}` |
| `GET web-gateway.spacefs.com/me` | userId, legacySpaceUserId, workosUserId (null), identitySource "space", email, developerAccess false |
| `GET web-gateway.spacefs.com/orgs/<ws>/quota-status` | `limit_bytes: 1e12` (1 TB), `plan_state: trial_active`, 7-day `free_trial`, `billing_status: active` |
| `POST us.i.posthog.com/batch/` | Product telemetry |

Requests carry `Authorization: Bearer <session JWT>`.

Other hosts referenced in binaries:
- First-party: `app.spacefs.com` (`/desktop` web login), `auth.spacefs.com`, `creds.spacefs.com` (vends S3/STS-style credentials: `access_key_id`, `secret_access_key`, `session_token`, `expiration`, NATS URL), `s3sdk.spacefs.com`, `fanout.spacefs.com` (wss), `compute.spacefs.com` (`SPACE_COMPUTE_URL`, `v1/agents/policy`, `v1/agents/peers/`), `drive.spacefs.com/resources/ingest`, `downloads.spacefs.com`, `assets.spacefs.com/public/clips/`, `docs.spacefs.com`, and an R2 bucket `pub-…r2.dev/{manifest.json,browser-packs/manifest.json}` (Ed25519-signed agent browser packs).
- Third-party: `openrouter.ai/api` (+ `/api/v1/auth/key`), `api.anthropic.com/v1/models`, `api.openai.com/v1/models`, `api.x.ai/v1/models` (BYOK model listing), `open.er-api.com` (FX rates), `speed.cloudflare.com` (bandwidth probe), and installers for Claude Code, Codex and Grok CLI.

Sign-in flow (strings + log): the browser goes to `https://app.spacefs.com/desktop`, the callback returns as `space://…` with a one-time code, and the app posts to `/auth/desktop/exchange` (web-gateway) to receive the session JWT. The CLI path uses an email magic code against `auth.spacefs.com`.

## 4. Local state (read-only)

### ~/Library/Group Containers/group.com.spacefs.launcher/
- `spacefs-config/config.json` (0600) is the CLI/daemon session shared by the app, the daemon and the extension. Keys:
  - `auth_url` = https://auth.spacefs.com
  - `control_url` = https://control.spacefs.com
  - `creds_url` = https://creds.spacefs.com
  - `gateway_url` = https://web-gateway.spacefs.com
  - `force_path_style` = false
  - `user_id` (UUID)
  - `token` (redacted): a 263-char **JWT, HS256**. Claims: `email`, `iat`, `exp`, `iss` = `spacedb-auth`, `sub`. iat 2026-10-25, **exp 2126-10-01 (100 years)**. It is a long-lived bearer token stored in plaintext on disk, not in the Keychain.
- `config.json.lock`, `SpaceDriveVolume.icns` (+ `.stamp`, served as each drive's `.VolumeIcon.icns`).
- `Library/Preferences/group.com.spacefs.launcher.plist`: `workspaceByBucket` {`spacedb-<workspace-uuid>-data` → workspace UUID}.
- `fskitd.sock` is absent because the daemon is not running.

### ~/Library/Group Containers/24J8HFD297.com.spacefs.launcher/
Empty apart from `.com.apple.containermanagerd.metadata.plist` and the standard Library skeleton. It was created for the FinderSync appex's group id.

### ~/Library/Application Support/SpaceLauncherDemo-Primary/ (the shipped app's state dir)
- `search.sock` and `search.pid`: socket of space-launcher-search, started as `--socket … --index-dir …/search-index --log-dir …/logs`.
- `search-index/unified/`: tantivy index. Schema fields are doc_key, path, path_searchable, source_path, record_kind, availability_status, display_name, parent_path, content_type, file_type, size, last_modified, created, **body** (full text), `_partition`, volume_id, name_abbreviations, source_id, source_kind, subtitle, activation_id and activation_url. `search-index/frecency/` is RocksDB.
- `logs/space-launcher-search.log.<date>`: JSON tracing logs. Index ready, "search server listening … max_connections 64", and query logging that includes the query text.
- `user-preferences.db` (SQLite) has tables `search_selections(query, result_path, count, last_selected_at)`, `action_usage(action_id, count, last_used_at, score)`, `synced_settings(key, value, updated_at)`, `sync_state(key, value)` and `pending_mutations(seq, payload, created_at)`. Current contents: 1 synced setting (`orgShortcutsAppliedAt` = `{}`) and 2 pending `set_setting` mutations (server-synced settings outbox). No secrets.
- `workspace/` is empty: the agent workspace root.
- `space-agent.toml` and `space-agent-provider.json`: see section 5.
- Not present yet: `space-agent-state/`, `space-agent-objects/`, `space-agent-<kind>-provider.key`, `local-home/`.

### ~/Library/Application Support/SpaceFS/
Only `local-home/Space/Plugins/Clipboard History/`. This is the local staging copy of the `Space/` folder that normally lives on the user's Space drive (`storage.location.v2 = space_home`). It is staged locally because no drive is mounted.

### ~/Library/Application Support/com.spacefs.launcher/
`update-telemetry-outbox.json` = `[]`. No `sentinels/` or `retained-smb/` yet, which confirms no mount has ever been attempted.

### Other
- `~/Library/Preferences/com.spacefs.launcher.plist` keys:
  - `LastLaunchedBundleVersion`, `LastLaunchedDaemonVersion`
  - `launchAtLogin.defaultApplied.v2`
  - `launcherOnboarding.*`
  - `primaryHotkeyDefaultMigration.commandSpace.v1` = true (Cmd-Space taken over)
  - `selectedWorkspaceID`
  - `storage.homeBucket.v1` (bucket id), `storage.homeDriveName.v1` = "Space", `storage.legacyLayoutMigration.v1`
  - `driveMeta.v1`, `driveServerNames.v1` (JSON blobs)
  - `telemetry.installID.v1`, `telemetry.lastKnownIdentity.v1` {email, user_id, saved_at}
  - `workspaceSnapshot.v1` {user → [{id, name "My Space", role owner}]}
- `~/Library/Caches/com.spacefs.launcher/Cache.db` (NSURLCache) holds the API responses in section 3, including the full `/me` and member emails.
- Keychain: no generic-password item with service `com.spacefs.launcher` was found. Secrets live in files or the environment, not the Keychain.
- Sandbox containers exist for `com.spacefs.launcher.FSExtension` and `.FinderSync` (empty Library skeletons).

## 5. AI agent configuration

`space-agent-provider.json` (version 1, updatedAt 2026-10-25T06:37:15Z, written at sign-in):
`settings = { kind: "openrouter", baseURL: "https://openrouter.ai/api", model: "space", reasoningEffort: "medium" }`. It contains no key fields.

`space-agent.toml`:
- `[provider]`: id `primary`, kind `openrouter`, model `space`, reasoning_effort `medium`, base_url `https://openrouter.ai/api`. `key = { source = "environment", name = "OPENROUTER_API_KEY" }`, a reference only, so the file holds no literal key.
- `[server]`: bind `127.0.0.1:7331`, `allow_remote_bind = false`, `token = { source = "environment", name = "SPACE_AGENT_SERVER_TOKEN" }`. This is a local HTTP API protected by a bearer token. It is not listening now because space-agent is not running.
- `[sidecars.desktopd]`: disabled. Socket `/tmp/space-agent-desktopd-<hash>.sock`, token from env `SPACE_AGENT_DESKTOPD_TOKEN`.
- `[store]` filesystem at `…/space-agent-objects`. `state_dir` `…/space-agent-state`. `[workspace]` path `…/workspace`.
- Disabled: browser, media/recording, streaming, remote_desktop, specialists, updates, streamd.
- `[runtime]` profile `standard` with a 75-tool `default_tool_allowlist`:
  - shell and PTY: `shell.exec`, `shell.script`, `pty.*`
  - workspace FS and git: `workspace.*`, `git.commit`, `git.push`
  - Space: `space.search`, `space.drives.list`, `space.drive.import`
  - personal data: `calendar.*`, `reminders.list`, `contacts.*`, `mail.*`, `location.get_current`, `weather`
  - computer use: `computer.applescript`, `computer.capture`, `computer.read_clipboard`, `computer.action`, `computer.app.launch`, `computer.shortcut.run`, …
  - browser: `browser.*` incl. `browser.sign_ins`
  - other: `subagent.*`, `skill.*`
- Main-app strings show the app serves these to the agent via a native-context endpoint (`SPACE_AGENT_NATIVE_CONTEXT_ENDPOINT` / `_TOKEN`): `/v1/personal/{accounts,calendar/events,contacts/search,mail/search,reminders}`, `/v1/location/current`, `/v1/space/{drives,imports,search,app-status}`, `/v1/browser/{cookies,sign-ins,…}` and `/v1/volume-chats/claude-code/sync`.

**Verdict: OpenRouter, model `space`, Space-managed, not BYOK.**
- The model ref `space` is resolved by `control.spacefs.com/ai/model` ("Space model"). The usage allowance comes from `ai/quota`: $2.00 `free_annual`, nothing spent, 0 keys.
- No `space-agent-openrouter-provider.key` (the file the app writes for BYOK keys, per uninstall.sh) exists. The UI strings frame BYOK as the alternative path ("Sign in to Space to use AI, or add your own API key in Settings", "Use your own API key. It stays on this Mac.").
- So the key is presumably a Space-issued OpenRouter key passed in `OPENROUTER_API_KEY` when space-agent is launched. That is inferred from the env-reference design and the `keys`/`outstanding_keys` fields. It was not observed, because the agent is not running.
- BYOK options compiled in: Anthropic, OpenAI, xAI, OpenRouter, Claude Code / Codex / Grok CLI subscriptions ("Bring your own subscription"), and many OpenAI-compatible routers in space-agent (Moonshot, Z.ai, DeepSeek, Routstr, Tetrate, HF router, Databricks, Snowflake, etc.).
- The bundled OpenRouter model catalog includes `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `anthropic/claude-fable-5.1`, `openai/gpt-6-astra(-pro)`, `openai/gpt-5.6-{luna,terra}`, `google/gemini-3.8-flash`, `x-ai/grok-4.6`, `deepseek/deepseek-v4-*`, `qwen/qwen3.8-*`, `moonshotai/kimi-k3`, `z-ai/glm-5.3`, `minimax/minimax-m3`, plus `:free` models.

## 6. Search helper

`space-launcher-search` is a child of Space. It serves JSON over `search.sock` (max 64 connections), with tantivy full-text (including file `body`) plus RocksDB frecency. It indexes Desktop, Documents and Downloads and walks the home directory (SpotlightCrawler). Contacts, Calendar, Reminders, Mail and opt-in Messages are added via app-side providers. It has no network sockets.

## 7. System modifications the app makes (from uninstall.sh FOOTPRINT block)

- Disables Apple's Spotlight Cmd-Space shortcut (`com.apple.symbolichotkeys` key 64) to claim the hotkey. The uninstaller restores it.
- Launch-at-login via SMAppService.mainApp (BTM), the LaunchDaemon MountHelper, and the FSKit and FinderSync extensions (pluginkit).
- Finder sidebar Favorites rows (needs FDA, so skipped here), `/Volumes/<name>` mountpoints and alias symlinks, and `/Volumes` volume icons.
- Updater state in `~/Library/Caches/com.spacefs.launcher/Updates`, `/var/db/com.spacefs.launcher{,.update-results}`, and rollback bundles `/Applications/Space/Space.app.old.*`. None of these exist yet.
- `$TMPDIR/space-*` temp dirs, and `~/Library/Application Support/space-computer-use` (absent).
- User data on the Space drive (`<drive>/Space`: agent chats, plugin data) is never removed by the uninstaller.

## 8. Notable observations

1. Session JWT: HS256, 100-year expiry, stored in plaintext JSON in a group container that is readable by any process running as the user. The extension, daemon and app all share it.
2. FSKit module installed but not enabled, and MountHelper not approved. The drive cannot mount until the user enables "SpaceFS" in File System Extensions. The SMB loopback fallback exists for exactly this case.
3. The main app is unsandboxed. Together with the agent's default tool allowlist (shell, AppleScript, git push, mail/contacts/calendar read, screen capture, browser sign-ins), the agent has broad local reach once space-agent runs.
4. The daemon's optional debug dashboard has no auth by design. It is off by default.
5. Telemetry goes to PostHog, carrying an install ID, user ID and email (`telemetry.lastKnownIdentity.v1`). There is also an update-telemetry outbox.
6. space-mac (`com.spacefs.mac`) is a separate sibling product, and daemon strings reference its paths (`group.com.spacefs.mac/fskitd.sock`). The uninstaller is careful never to match it.

## Commands used (all read-only)

`plutil -p`, `codesign -dvv / -d --entitlements`, `security cms -D` (provisioning profile), `strings`, `otool -L`, `pkgutil --pkg-info/--files`, `ps`, `pluginkit -mAvvv`, `systemextensionsctl list`, `launchctl list/print`, `mount`, `lsof -a -p <pid> -i` / `-U`, `/usr/bin/log show --last 40m` (with the process/subsystem predicate; zsh's `log` builtin shadows /usr/bin/log), `sqlite3 -readonly` (immutable URI), and Python `-I` for redacted JSON/TOML/JWT-structure dumps. Scratch files were in /tmp/spacefs-scripts.
