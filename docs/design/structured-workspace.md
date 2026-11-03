# Structured workspace design

This refresh treats Orbit as a file workspace rather than a collection of settings screens.
The web and native apps share the same hierarchy while retaining platform-appropriate controls.

## Design contract

- **Navigation:** a persistent workspace sidebar separates daily file work from account management.
  The account and connection context lives at the bottom, not alongside primary file actions.
  Small web viewports use a collapsible navigation control with an explicit expanded state.
- **Hierarchy:** one page title, a short description, then grouped tools and content. Workspace,
  drive, and file headings are distinct. Destructive and administrative actions stay secondary.
- **Surfaces:** neutral canvas, slightly elevated content panels, quiet borders, restrained radii.
  Both appearance modes use semantic foreground, muted, border, and surface roles.
- **Spacing and type:** a regular spacing scale separates pages, sections, rows, and controls.
  Strong titles and compact metadata make the file and drive names easiest to scan.
- **Interaction:** retain the existing API, permissions, routes, drive operations, Finder links,
  keyboard shortcuts, upload/download behavior, and authentication. Status is communicated with
  words as well as color. Focus and reduced-motion preferences remain supported.
- **States:** loading, empty, filtered-empty, disconnected, and failure states explain what is
  happening and expose an appropriate existing next action without implying success.

## Web visual fixture

Run `npm ci --prefix web`, then `npm run dev --prefix web -- --host 0.0.0.0 --port 4187 --strictPort`.
Open `/design-preview.html` on that development server. This is a **sample-data fixture**, not a
signed-in account or a production backend verification. Its source is `web/test/visual-preview.tsx`.
It renders the actual `App`, `Home`, `DriveBrowser`, and shared components, using an isolated
in-memory auth store and a fail-closed fetch fixture: no action is sent to a real API.
The production Vite build has only the normal `index.html` entry and does not ship the fixture.

Supported query parameters:

- `theme=light` or `theme=dark` selects the appearance for the fixture.
- `view=drives` shows a populated workspace (the default).
- `view=files` shows a drive with folders and files; links navigate within the memory router.
- `view=empty` shows a workspace with no drives.
- `view=folder-empty` shows an empty drive.
- `view=error` and `view=loading` exercise shared failure and loading presentation.
- `view=account` shows the existing account form with sample profile data.

Unsupported fixture mutations fail explicitly with a sample-data message. Use the real app and
backend for operational acceptance; fixture screenshots do not verify storage, sign-in, billing,
Finder integration, or native macOS behavior.

## Validation boundaries

The web build and component tests check browser implementation and existing workflows. Native
SwiftUI compilation and tests require macOS/Xcode; a Linux source inspection is not a native build.
Native visual evidence must come from the actual SwiftUI app, not an HTML imitation. A successful
build is separate from signed-in engine, Keychain, mount, and installed-app acceptance.
