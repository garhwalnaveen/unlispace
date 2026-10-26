# Unlispace access and permission experience

Implemented 26 October 2026 in the native macOS app. The same permission dashboard appears
in onboarding's final Access & permissions step and Settings → Permissions.

## Supported features

| Feature | Explanation and status | Action |
| --- | --- | --- |
| Background engine | Why background execution is needed; actual ServiceManagement registration/approval state | Enable engine or open Login Items management |
| Network volume access | Why Finder/editors may request access; labelled Managed by each app rather than inventing a global grant | Open Files and Folders settings |
| Conflict notifications | Optional alerts, with Not requested, Enabled, Quiet delivery and Not allowed states | Request only from Enable alerts; denied/existing grants open Notification settings |
| Launch at login | Optional menu-bar startup, with real registration/approval state | Explicit Enable or Login Items management |

The dashboard explains that files added to a mounted drive are uploaded to the configured
Unlispace service. It separates drive access from optional conveniences. Skipping notification
or login-item access never blocks Finish setup.

## Behavior

- Reads authorization when the relevant UI appears and when the app returns to the foreground.
- Provides Refresh access status for manual rechecking.
- Clears action feedback when external authorization changes would make it stale.
- Uses text and icons for status; text retains normal contrast in light and dark appearance.
- Buttons have feature-specific accessibility labels.
- No permission prompt is initiated from status reads, appearance or refresh handlers.
- macOS does not expose a single read API for all other apps' network-volume grants; that row
  is intentionally descriptive and links to the per-app controls.
- Unbundled CLI/SwiftPM contexts report notification authorization as unavailable without
  calling an API that raises an Objective-C exception outside an app bundle.
- This change adds no Contacts, Mail, Calendar, Full Disk Access, screen-recording or browser-cookie
  requests. Those require corresponding product integrations before a meaningful permission UI.

## Validation

76 Swift tests passed, including OS-state mapping, unknown initial states, unbundled notification
queries, feedback refresh behavior, existing authentication/mount gates and real local socket
integration. The dashboard was rendered and inspected in light/dark appearances using denied
notification and approval-needed fixtures. Those screenshots are layout fixtures, not claims
about the user's grants.

The app and DMG were rebuilt for the existing Cloudflare Workers endpoint with the previously
validated SMB engine. The shipped-signature installation probe and read-only DMG signature/mount
checks passed. Installing the update waits for no pending file operations, preserves the old
bundle in Trash, uses fresh executable inodes, and re-enables the existing engine service.
Optional OS permission grants are left to the user's explicit actions.
