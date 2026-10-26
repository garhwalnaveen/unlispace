# Space → Unlispace desktop UX review

Reviewed 26 October 2026 using the installed Space 0.2.407 macOS app and the local Unlispace source and bundle. Scope: the native macOS client. Existing web changes were preserved.

## Evidence and limits

Space was already signed in, with one unmounted drive and no active uploads. Its General, Drives, Search, Space AI, Shortcuts, Workspace, Uploads, Team, Plan & Storage, Permissions, Cache, Advanced, and About surfaces were inspected through the live UI. Its drive overflow menu was inspected without invoking rename or delete. No files were uploaded, drives mounted, permissions granted, keys entered, or subscriptions changed. Launcher invocation did not produce a separately inspectable launcher surface; its workflows are described only where exposed in settings and shortcut descriptions. First-run Space onboarding and successful transfers were not exercised.

The original Unlispace bundle crashed before rendering because hardened runtime rejected the ad hoc signed Sparkle framework. The original interface comparison therefore uses source inspection: a 320-point menu, one 460 × 480 settings form, a three-stage onboarding window, and a transfers popover. After repairing the development packaging path, the rebuilt native UI was launched and inspected live.

## Flow comparison and implemented response

| Journey | Space observation | Unlispace baseline | Rebuild |
| --- | --- | --- | --- |
| Open app | Dedicated settings window with persistent categorized sidebar; launcher features exposed through commands | Menu-bar shell; no persistent drive workspace | Resizable workspace opens on launch and reopen; menu provides Open app |
| Find drives | Drive count, mounted count, clearly named drive rows and visible Mount action | Drive actions nested in menus | Drive cards, mount counts, name filter, inline Mount/Open in Finder/Eject, offline overflow |
| Understand connection | Cache/daemon empty states explain why data is unavailable and offer next steps | Engine state largely mixed into menu text | Connection notice with setup action; explicit signed-out, unavailable, empty, and no-match states |
| Follow transfers | Dedicated Uploads settings, upload activity entry point, progress preferences | Small transfers popover | Dedicated workspace Transfers page; existing byte progress, upload queue, journal usage and popover retained |
| Set up | Existing signed-in installation; initial onboarding unavailable | Sign in → choose drives → privacy | Visible three-stage orientation, expanded layout; selection, real-engine checks and mount sequence preserved |
| Preferences | General, Permissions, Cache, Advanced are individually discoverable | Single compact form mixing routine and developer controls | Sidebar General, Account, Cache, Permissions, Advanced; scoped grouped sections |
| Appearance | Light, Dark, System options with visual previews | Follows native appearance only | Persisted System/Light/Dark control using native semantic colors |
| Permission trust | Explains each permission's purpose and current status | Network Volumes explanation in onboarding; explicit conflict notification request | Dedicated permission guidance; request remains an explicit user action; no fabricated authorization status |
| Offline files | Separate cache service status and mounting explanation | Per-drive pin actions in menu | Pin actions retained in menu and workspace; cache page shows real available pin progress |
| Diagnostics | Status refresh, logs, service state separated from danger-zone actions | Developer disclosure within general form | Dedicated Advanced page; endpoint validation and Keychain handling preserved |
| Search and AI | Local metadata indexing, optional sources, model/account configuration and shortcuts | No corresponding native backend | Recorded as product gaps; drive filter searches drive names only |
| Teams and billing | Workspace/member screens and web billing handoff; individual-workspace invitation warning | No desktop implementation for these flows | Recorded as product gaps; no nonfunctional navigation or billing controls added |

## Design decisions

- Use native SwiftUI navigation, typography, semantic colors, controls, keyboard focus and accessibility labels.
- Put the next file action beside its drive. Keep secondary offline actions in overflow.
- Explain disconnected and signed-out states without showing demo data as real files or claiming synchronization success.
- Preserve existing auth, pending-session handoff, conflict notices, mount adapter/read-only information, pinning, updater gating and developer validation.
- Keep the menu useful for quick access while the workspace provides room for managing drives and transfers.
- Keep developer overrides in a collapsed Advanced section.

## Packaging correction

Ad hoc builds now use development signing without hardened runtime. Developer ID signing retains hardened runtime and timestamping. No library-validation exception was added to the app entitlements. The local build is for review and is not a notarized distribution release.

## Initially remaining acceptance work (see completed follow-up)

- Complete browser sign-in against the intended deployment and verify pending-session handoff with the bundled engine.
- Mount a real account drive, open a file in Finder, upload/download, eject, and verify queued writes and recovery.
- Exercise actual offline pin downloads, disk limits, network interruption, and conflict delivery.
- Review VoiceOver reading order and keyboard-only operation with real drive data; accessibility labels and native focus are present, but source/render checks do not establish complete assistive-technology acceptance.
- Search/indexing, AI, team management, drive creation, and billing require separately scoped product/backend work for Space feature parity.

## Validation results

- `cargo build -p ulsd --locked`: passed, providing the real daemon for the isolated integration test and local review bundle.
- `bash mac/scripts/test.sh`: 63 tests across 14 suites passed, with Keychain/Handoff tests excluded by the repository's default gate.
- The render smoke test covers signed-out, mounted/unmounted/mounting fixture drives, settings and an active transfer in distinct light and dark appearances. Render output is useful for detail-layout review; offscreen native sidebar layers are incomplete, so live UI inspection supplies sidebar evidence.
- Live UI: setup sign-in stage, workspace, transfers, Settings entry, and General/Account/Cache/Permissions/Advanced navigation verified. No preferences or permissions were changed for this review.
- `ULSD_BIN=.../engine/target/debug/ulsd bash mac/scripts/bundle.sh`: local review packaging includes the tested development engine. Registration remains an explicit setup action. The existing DMG is not regenerated by this task.
- Whitespace checks apply to this task's macOS files and comparison document. Unrelated concurrent web/cloud/e2e changes are outside this validation scope.

The final live check also exercised the sign-in entry point. The native client entered
“Waiting for browser…” but no authentication browser was exposed by the enabled UI surfaces;
a successful login was not established. Cancel sign-in is now available wherever sign-in can
be started so this state has an exit. The local bundle also demonstrated that macOS can
report a missing background service even when the daemon executable is present. That state
now has distinct guidance instead of incorrectly claiming the engine binary is missing.
Service registration and login remain acceptance blockers for real file-flow testing.

Final live cancellation check passed: starting sign-in from setup displayed the waiting
state and Cancel sign-in; cancelling restored the enabled Sign in to Unlispace button.
Cancellation explicitly resolves the pending continuation, and per-session IDs ignore late
callbacks. The final app was left open on My drives with accurate service-unavailable guidance.


## Completed follow-up

The desktop follow-up is recorded in [desktop-acceptance.md](desktop-acceptance.md).
It supersedes the original acceptance blockers above: Cloudflare routing is configured,
real browser/Swift PKCE and pending-session handoff passed, the installed LaunchAgent is
running with the hosted account restored, real hosted/native file exchange passed, and the
expanded local integration suite passed 49 checks. The approved hosted CORS repair is live.
The current DMG was regenerated and read-only mount/signature verification passed.
See that report for exact evidence boundaries and the explicitly deferred feature work.

## UX follow-up: drive discovery and offline visibility

On 26 October, the current Space UI was checked again through its Drives, Shortcuts,
and Cache pages. Drives exposes count/mounted summaries, inline mounting and an overflow;
Shortcuts exposes keyboard entry points for drive browsing and upload activity; Cache
explains an unavailable service instead of presenting invented storage figures.

The native workspace now builds on the existing redesign with:

- All, Mounted, Not mounted, and Needs attention drive filters, combined with trimmed,
  case-insensitive name matching. A no-match state has a Clear filters action.
- A dedicated Offline files sidebar page with drive names, selected paths, byte counts,
  live pin progress, Finder access for mounted drives, and Stop keeping offline actions.
  Disconnected, unsupported-engine and empty states are distinct. This page reports cached
  bytes without treating a completed progress fraction as proof of offline acceptance.
- Window shortcuts: Command-1 My drives, Command-2 Transfers, Command-3 Offline files,
  Command-F drive filter focus, and Command-R refresh.
- Per-drive action guards shared by menu, workspace and settings callers. A pending
  mount, eject or pin request prevents overlapping requests until refresh or failure;
  mock connections cannot execute these actions. Workspace and menu controls reflect the guard.

Validation for this follow-up: the default Swift gate passed 78 tests in 20 suites,
including filter combinations, mock rejection, duplicate action locking and failure cleanup.
The fixture renderer covers the new offline empty/progress layouts in light and dark;
offscreen rendering retains the previously documented native-sidebar limitation.
Release compilation and ad hoc bundle signature verification passed. The local review
bundle is `mac/build/Unlispace.app`, retaining the existing configured endpoint and embedding
`engine/target/debug/ulsd`.

Live review confirmed the new sidebar, Command-2/3 navigation, Command-F focus from another
page, drive filtering and Clear filters recovery against the existing mounted Space drive.
No drive was mounted/ejected, pinned/unpinned or modified during this follow-up. New live
offline downloads, VoiceOver acceptance, AI, indexed file search, teams and billing remain
outside this validation. The installed app and DMG were not replaced by this follow-up.
