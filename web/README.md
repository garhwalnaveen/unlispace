# Unlispace web · M2

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
  Plan-limit errors explain that additional drives require Teams; each organization links to Billing.
- `/drives/:id/*`: root/folder listing, cursor-based Load more, breadcrumbs and file details.
  Version history has its own cursor pagination and is a panel (`?panel=versions`) backed by the data plane's `/versions` endpoint.
  Current and historical file downloads assemble shards in manifest order, checking sizes and
  SHA-256; progress reports received bytes. Files above 512 MiB direct users to the desktop app.
  Finder links preserve the drive id and path. Writable drives support file selection and drag-and-drop.
  Uploads use FastCDC 2020 normalization level 1 (256 KiB / 2 MiB / 16 MiB), verified against both
  Rust golden vectors. The uploader reads at most 16 MiB for chunking, hashes with WebCrypto,
  probes `/shards/missing` in batches of 1000 hashes, and PUTs missing shards with three workers.
  Progress counts prepared bytes, then uploaded or deduplicated bytes; shard PUT progress updates
  after each successful PUT. Repeated hashes are uploaded once. Empty files commit an empty manifest.
  The server's current stat supplies `ifVersion` for overwrites; absent paths use `ifAbsent`.
  A 412 shows a conflict message without an unguarded retry. Failed transfers never commit.
  New uploads create versions for matching names, as explained beside the file picker.
  Read-only drive members do not see upload controls.
- `/settings`: profile, display-name editing, server-revoked sign-out and access-key navigation.
- `/settings/access-keys`: list metadata, create with organization/access/drive allowlist, reveal a
  secret once, copy POSIX-quoted AWS environment variables, and explicitly confirm transitive revoke.
  The secret disappears on close/navigation and is never written to browser storage.
- `/orgs/:id/billing`: current plan, trial days, used/quota bytes, seats, storage add-ons, monthly or
  annual checkout, paginated invoices, and the Dodo customer portal. Management controls and invoice
  requests are limited to owners/admins. Checkout honors the catalog's availability flag. Final
  prices are displayed by Dodo; the catalog currently provides no prices. Redirects require HTTPS.
- System/light/dark appearance selector follows OS changes in System mode and persists a manual choice. Mobile layouts
  support 360 px. Native modal dialogs contain focus and Escape closes them. Inputs have labels,
  errors use live alerts, and status/progress updates are announced.

## Memory-only sessions and cookie migration

Access tokens, refresh tokens and user session data live only in `AuthStore` memory. Startup removes
any legacy `unlispace.refreshToken` localStorage item without reusing it. Theme preference remains
persistent. A reload/new tab can recover a session only from another live tab on the same origin via
BroadcastChannel; closing all tabs requires signing in again. Nothing uses sessionStorage or IndexedDB
for credentials. This reduces persistent credential exposure; same-origin XSS can still access a live
session, including BroadcastChannel messages. It is not an HttpOnly boundary.

A same-origin Web Lock serializes rotation and logout. Each rotation asks live peers for their latest
in-memory session while holding the lock, preventing concurrent tabs from reusing an old refresh
token. Concurrent 401s share one refresh promise. Refresh happens one minute before expiry and once
on a 401. Network failures retain credentials in memory for retry; invalid refresh clears all tabs.
Session-family tombstones reject delayed pre-logout broadcasts; in-flight responses only apply if
the refresh token has not changed. Current browsers with Web Locks and BroadcastChannel are required
for sharing; without BroadcastChannel a single tab works, but reload cannot recover its session.

**HttpOnly-cookie migration (requires API-agent work):** the API should issue the rotating refresh
credential with `Set-Cookie: ...; HttpOnly; Secure; SameSite=Lax; Path=/auth`, use a host-only cookie,
and stop returning it in JSON for browser OTP/handoff/refresh. Keep the desktop JSON/Keychain contract
separate. Browser refresh/logout then send `credentials: "include"`, with no refresh token in their
request body. Credentialed CORS must allow the exact web origin and the API must verify Origin/CSRF
for mutating cookie-authenticated requests. Coordinate SameSite behavior if web/API are ever on
separate sites; do not silently weaken cookie settings. Remove refresh credentials from channel
messages after that migration; continue sharing access tokens/rotation notifications and the Web
Lock. Cookie expiry/reuse detection and logout must clear the cookie. Test reload, cross-tab races,
logout, expired cookies and CSRF before enabling durable browser sessions. This task changes no
backend auth contract.

## Contract notes and verification limits

M1/M0's path-based `/v0/drives/{id}` routes remain normative for uploads and downloads. Read and
write grants are cached separately; only upload operations request write access. Browsers set
`Content-Length` for typed-array PUT bodies; application code must not set this forbidden header.
Data-plane CORS must allow the web origin, OPTIONS, GET/POST/PUT, Authorization and Content-Type,
including error responses. See `NEEDS.md` for the current integration gap.

M2 requests follow task 06 plus the API agent's implementation (`access-keys.ts`, `billing.ts`,
`billing-catalog.ts`, `dodo.ts`): key creation uses `workspaceId`; checkout uses `plan`; billing returns
`quotaBytes` and `state`; invoice pages return `paymentId`, ISO `createdAt`, minor-unit `amount` and
`nextPage`. There are no invoice download URLs in the current response. The web client isolates
these shapes in `src/m2.ts`. No payment or storage calls run against external services in tests.

Tests cover both Rust FastCDC fixtures including hashes, deduplication, empty uploads, write-token
use, concurrency/failure handling, guarded overwrites, 412 conflicts, drag-and-drop and picker flows,
read-only controls, one-time key reveal/copy/revoke, checkout/portal requests, invoices, and memory-only
cross-tab auth. The test suite uses one worker to limit shared-machine load. A 15-second test deadline
accommodates existing UI tests under that load; golden fixtures have a 30-second deadline.

UI styling was checked in desktop Chrome and at 360 px for sign-in, drive overview and folder listing; authenticated previews used temporary fixture data. The workspace uses a navigation rail on desktop and a compact navigation row on mobile. Drive management actions expand under Drive options.

No live Worker/R2 upload, Dodo checkout/portal, cookie migration, or deployed CORS verification is claimed. No deployment is performed.
