# Unlispace web · M1

A static Vite / React 19 / TypeScript SPA. All application files, dependencies, caches and build
output live in this directory. Node 22.22+ and npm are recommended. No deployment is performed.

## Local development

From this directory:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open **http://127.0.0.1:5173**. Use the same origin throughout sign-in and redirects (avoid mixing
`localhost` and `127.0.0.1`).

Run the control plane on **8788** and data plane on **8787**, following
[`m1-contract.md`](../docs/design/m1-contract.md). In another terminal, from the repository root:

```sh
node cloud/scripts/dev-keys.mjs
npx wrangler@4 dev -c cloud/api/wrangler.jsonc -c cloud/data-plane/wrangler.jsonc
```

Those commands are backend setup instructions; this web task does not create or modify backend
files. Configure the backend's `ULS_WEB_ORIGIN=http://127.0.0.1:5173`,
`ULS_DATA_ENDPOINT=http://127.0.0.1:8787`, and `ULS_ISSUER=http://127.0.0.1:8788`.
For local email sign-in, `ULS_DEV_LOG_OTP=1` logs codes in the API terminal. Google requires the
backend's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; without them the backend returns 501.
The data plane must allow the web origin and Authorization headers in CORS, including shard GETs.

### Web environment

| Variable       | Default                 | Meaning                                                  |
| -------------- | ----------------------- | -------------------------------------------------------- |
| `VITE_API_URL` | `http://127.0.0.1:8788` | Control-plane API base, fixed at build time. No secrets. |

The data endpoint is taken from `POST /drives/{id}/token`, never inferred from the API base.

## Verification and static hosting

```sh
npm run build
npm run typecheck
npm test
npm run preview
```

`npm test` uses fetch stubs and never contacts either Worker. Tests cover concurrent 401s,
cross-tab rotation, proactive refresh, OTP success/errors, desktop URLs, ordered and verified
shard assembly, paginated folder navigation, drive management and file history.

`wrangler.jsonc` serves `dist/` using Workers static assets with
`not_found_handling: "single-page-application"`. Build before serving. Direct navigation to
`/drives/...`, `/desktop` and `/auth/callback` falls back to `index.html`. No Worker script or
server-side rendering is needed. [Cloudflare SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).

## Screens and behavior

- `/login`: email → six-digit OTP, or Google; `/auth/callback` consumes and immediately removes
  the single-use handoff fragment. New accounts get the backend's personal org, drive and trial.
- `/desktop?state&code_challenge`: preserves the desktop return location through either login
  flow, mints a PKCE-bound code on an explicit button press, then opens `uls://auth/callback`.
  “Use another account” revokes the current session before returning to login.
- `/`: organizations, trial days, drives, create, rename, exact-name confirmation for delete.
  Plan-limit errors explain that additional drives require Teams; no invented billing route.
- `/drives/:id/*`: root/folder listing, cursor-based Load more, breadcrumbs and file details.
  Version history has its own cursor pagination and is a panel (`?panel=versions`) backed by the data plane's `/versions` endpoint.
  Current and historical file downloads assemble shards in manifest order, checking sizes and
  SHA-256; progress reports received bytes. Files above 512 MiB direct users to the desktop app.
  Finder links preserve the drive id and path. This browser is read-only.
- `/settings`: profile, display-name editing and server-revoked sign-out.
- Light/dark theme follows the OS initially, with a persistent manual toggle. Mobile layouts
  support 360 px. Native modal dialogs contain focus and Escape closes them. Inputs have labels,
  errors use live alerts, and status/progress updates are announced.

## Session storage trade-off

Access tokens and user session data live only in memory. The rotating refresh token is kept in
`localStorage` so sessions survive reloads. This is deliberately convenient but exposes the
refresh credential to any script running on the same origin; XSS could steal it. Do not add
untrusted scripts. A future cookie-based design would need a contract change.

A same-origin Web Lock serializes rotation and logout. BroadcastChannel distributes new access
tokens to other tabs **without persisting them**, including when a new tab starts. Concurrent
401s share the same refresh promise; tabs request the current access token inside the lock before
rotating. Refresh happens 60 seconds before expiry and once on a 401. Network failures retain the
refresh credential for retry; invalid refresh credentials clear the session in all tabs. Use a
current browser with Web Locks and BroadcastChannel on HTTPS or localhost. If Web Locks is absent,
refresh fails explicitly instead of risking refresh-token reuse and session-family revocation.

## Contract notes

`m1-contract.md` is normative over the broader product design: M1 uses the M0 path-based `/v0`
data-plane reads and bearer-authorized shard GETs, rather than the product design's future
node-based APIs or `/_blocks` presigning. Billing, keys, memberships, invitations, uploads and
restore controls are outside this M1 web task. No extra endpoints are invented.

No blocking endpoint gaps were found. M1's `Org.role` union excludes `viewer` although the drive-token
authorization prose mentions it; the client follows the declared union, restricts lifecycle UI
to owners/admins, and always requests a read token. The server remains the authority for access.
