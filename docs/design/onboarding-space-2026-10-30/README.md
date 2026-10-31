# Space-based onboarding — 30 October 2026

Rebuilt in the existing product worktree at `/Users/naveen/.codex/worktrees/unlispace-engine/unlispace`. The chat checkout is the older subscription starter and was left unchanged.

The reference is the saved [27 October Space signup and first-use research](/Users/naveen/Documents/Codex/2026-10-26/se/projects/unlispace/docs/space-audit-2026-10-27/REPORT.md), including its native tour, permission and shortcut screenshots. The current request to match that onboarding supersedes the audit's earlier recommendation for a shorter setup.

## Flow and layout

Sign in with browser → cloud files in Finder → search → feature overview → Ask AI → permissions and drive selection → shortcut and Open Unlispace.

The native window opens at 1100 × 760, resizes down to 800 × 640, and scrolls its content while keeping Back, centered progress marks and Continue available. Large system-font headings, centered product previews, split feature/access pages, and the final keycaps follow the researched Space screens. The palette reuses the native design system: light canvas `#FAFAFA`, surface `#FFFFFF`, subtle `#F2F2F2`, border `#E0E0E0`, foreground `#171717`, muted `#666666`; dark appearance uses the existing semantic alternatives. Blue folders and familiar window controls appear only inside the Finder illustration.

The browser handoff now prepares storage before enabling Open Unlispace. It checks the existing organization/drive endpoint at most ten times, two seconds apart after responses, then offers an explicit retry. The final connection remains a separate step. Authentication pages have no workspace sidebar, and moving keyboard focus no longer scrolls away the header.

## Behavior retained or completed

- Browser reopen, cancel, saved-session retry and account switching remain available.
- Drive selection defaults to the first drive. Optional permissions do not block setup.
- Continue waits for selected mounts, a confirmed mounted state and a Finder path. Failure stays on the access screen with a retry action.
- The final screen opens the mounted drive in Finder and leads into the existing first-file checklist.
- A global Option–Space shortcut opens the workspace; Control–Option–Space and Command–Option–Space are alternate choices. Registration failure is shown rather than stealing a conflicting shortcut. Command–Space remains Spotlight's shortcut. Recording suspends the current registration and cancellation restores it.
- Pressing the shortcut on the final screen completes setup. Earlier onboarding screens retain focus.
- Only actual Unlispace features are described. Search is online and filename-based, cache/offline storage uses local disk, and AI requires an explicitly chosen provider and selected text. The previews are labeled illustrations.

## Verification

- Web: 85 tests pass, including readiness, bounded polling, network failure/retry, cleanup, account switching and preserved desktop return parameters. Production build passes.
- Mac: full suite passed 79 Kit tests, 23 app tests, and one executed daemon test. Keychain/Handoff tests were excluded; the browser/Worker fixture was skipped by its existing gate. A final affected-suite rerun passed 17 tests after the shortcut completion change.
- Every native step was rendered in light/dark appearance at both window sizes. Inspected the Finder, feature, permissions and final screens.
- Browser local-fixture OTP → preparing → ready flow was verified through the UI. At the observed 384px viewport, content width equals viewport width. No real email was sent and no account or mounted file was changed.
- The installed app and hosted website were not replaced or deployed. Live sign-in, OS shortcut conflicts, packaged-app upgrade and complete VoiceOver traversal remain acceptance checks.

## Screens

[Welcome](welcome-light.png) · [Storage](storage-light.png) · [Search](search-light.png) · [Features](features-light.png) · [AI](ai-light.png) · [Permissions](access-light.png) · [Finish](ready-light.png)

[Dark storage](storage-dark.png) · [Dark permissions](access-dark.png) · [Dark finish](ready-dark.png) · [Compact permissions](access-compact-light.png) · [Browser readiness](browser-ready.jpg)
