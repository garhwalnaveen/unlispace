# Space permission audit — 26 October 2026

Checked installed Space 0.2.407 (407): Info.plist usage descriptions, code-signing entitlements,
permission-related product text, and the local agent's configured tool names. The permission
screen descriptions also come from the earlier live UI inspection in this chat. Reviewed the
current public privacy notice and Apple permission documentation. No permissions were granted
or changed; no contact, calendar, Mail, Messages, cookie or credential contents were read.

This identifies declared capabilities and intended uses. It is not a network-traffic audit,
proof of each feature's implementation, or a fresh reading of macOS grant switches.

| Permission/integration | Space's stated or configured use | Practical scope to understand |
| --- | --- | --- |
| Accessibility | Paste results, arrange windows, computer actions | Read exposed UI information and operate app controls; broad device-control access |
| Screen & System Audio Recording | Let AI see the screen during computer use | The OS permission concerns screen/audio capture; the observed Space explanation specifically mentions seeing the screen, not evidence of audio capture |
| Automation / Apple Events | Requested system actions and read-only Apple Mail account/message access | Control of individually authorized target apps; the permission is broader than a product promise of read-only use |
| Full Disk Access | Optional Messages/group-chat search and access to protected browser sign-ins, particularly Safari | Broad access to protected application files; the search UI says conversation contents are not indexed, which does not narrow the underlying OS grant |
| Desktop/Documents/Downloads | Index files for local search | Files in approved folders can be read, including their contents; not just filenames |
| Network Volumes | Open, search and preview files on SMB-mounted drives | Access to mounted network-volume files; loopback SMB drives trigger the same category |
| Contacts | Contact information in search | Personal address-book information; agent tools include contacts.search and contacts.get |
| Calendars | Read events when asked | Full Calendar Access permits reading and writing at OS level even though Space's purpose text describes reading |
| Reminders | Read reminder details on request | Reminder information; the bundle declares the full-access usage key and the agent exposes reminders.list |
| Location | Approximate location for requested local answers/weather | Device-location access; the product's stated purpose is narrower than a blanket use of location |
| Notifications | Upload completion and drive-attention alerts | Notification presentation rather than access to another app's data |
| SpaceFS extension | Make workspace drives available in Finder | Filesystem integration; Space also includes an SMB mounting alternative |
| Drive Location Helper | Prepare mountpoints in /Volumes | Privileged helper; earlier local analysis also identified app-update staging operations |
| Browser sign-ins / Keychain | Import cookies from a selected browser so Space's browser is already signed in | Cookie import can carry authenticated sessions. Product text says passwords are not copied and cookies stay on the Mac and are not sent to the AI; these statements were not independently traffic-verified |

## Confirmed integration surface

The local agent allowlist currently includes contacts.search/get, calendar.events.list/get,
reminders.list, mail.accounts.list, mail.messages.search/get, location.get_current,
computer.capture/snapshot/action/applescript/read_clipboard, shell.exec/script, and
browser.open/read/act/extract/screenshot/sign_ins. This supports the stated search and AI
integration purposes; it does not establish that these tools have run or accessed particular data.

The main app's signing entitlements include Apple Events, Contacts, Calendars, Location,
user-selected read/write files, FSKit mounting and an app group. It has no App Sandbox
entitlement. Entitlements are capabilities, not evidence that the user granted TCC permissions;
macOS privacy protections still apply to an unsandboxed app.

Input Monitoring and clipboard features are referenced in existing local research/uninstaller
text. A separate current Input Monitoring prompt was not established, so it is not asserted as
a mandatory signup permission here. Clipboard reading itself should not be confused with an
OS permission labelled Clipboard.

## Data handling and unresolved questions

Space's privacy notice allows cloud processing, storage/search providers and AI-processing
providers for requested features. It discusses operational diagnostics that may contain file
names/paths and technical context. It does not establish that all search or AI processing is
local. The reviewed notice did not give a clear feature-specific answer about model training
or retention of Mail/calendar/screenshot tool results. No claim of covert uploading or misuse
is established by this audit.

The app's narrow purpose text is a description of intended use, not an OS-enforced restriction
to that purpose. The highest-trust grants are Accessibility, screen capture, Full Disk Access,
automation, and browser-session import. Start with the integrations actually needed for mounted
drives and selected file access; add personal-data and computer-control access only when using
those features.

Sources:
- Installed bundle: `/Applications/Space/Space.app/Contents/Info.plist` and signing entitlements.
- Earlier direct UI inspection in this conversation; `docs/design/space-desktop-comparison.md`.
- Local agent allowlist; values and credentials intentionally omitted.
- https://spacefs.com/privacy/
- https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac
- https://support.apple.com/guide/security/controlling-app-access-to-files-secddd1d86a6/web
- https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac
- https://developer.apple.com/documentation/eventkit/accessing-calendar-using-eventkit-and-eventkitui
