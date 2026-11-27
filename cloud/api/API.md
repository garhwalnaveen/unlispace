# Orbit control-plane API

Worker `orbit-api`. Auth uses short-lived access JWTs (EdDSA) + refresh-token
families; drive tokens are scoped grants minted per drive. Migrations live in
`migrations/` and are applied in filename order by `wrangler d1 migrations apply`.

## Public routes (no session)

- `POST /auth/otp/start` — send a 6-digit email code.
- `POST /auth/otp/verify` — exchange code for a session (`accountCreated` on first sign-in; provisions "My Space" org + drive).
- `GET /auth/google/start`, `GET /auth/google/callback` — Google OIDC.
- `POST /auth/handoff/exchange` — PKCE exchange for the embedded web view.
- `POST /auth/web-handoff` — issue a one-time handoff code.
- `POST /auth/refresh` — rotate refresh token (reuse revokes the family).
- `POST /auth/logout`.
- `GET /auth/desktop/start`, `POST /auth/desktop/code`, `POST /auth/desktop/exchange` — desktop PKCE flow.
- `GET /billing/catalog` — public plan catalog.
- `GET /public/link`, `GET /public/shards/{hash}`, `POST /public/upload` — recipient operations using the link token as an `Authorization: Bearer` header. Downloads are limited to the pinned file version (512 MiB in the browser); uploads accept one file up to 16 MiB to the requested destination and refuse overwrite.

## Authenticated routes

- `GET /me`, `PATCH /me`, `GET /me/access`.
- `GET /orgs`.
- `POST /orgs/{org}/drives`; `GET|PATCH|DELETE /drives/{id}`; `POST /drives/{id}/token` (mint read/write/admin drive token); `POST /drives/{id}/fork`.
- `GET|POST /drives/{id}/links`; `DELETE /drives/{id}/links/{link}` — create, list, and revoke public links. Creation is limited to Individual workspaces and accepts `kind` (`download` or `upload`), exact file `path`, and `expiresAt` (epoch milliseconds, at most 30 days). The token is returned once. The web UI uses seven-day links. A shared download never serves a replacement file. Moving, renaming, or reusing the path may require a new link. Existing links remain revocable after a workspace upgrades.
- `GET|POST /keys`; `DELETE /keys/{id}` — S3 access keys (HMAC-derived secrets, parent scopes, transitive revocation). Listing never returns secrets.
- `GET /orgs/{org}/billing`; `POST /orgs/{org}/billing/checkout`; `GET /orgs/{org}/billing/invoices`; `POST /orgs/{org}/billing/portal` — Dodo Payments.
- `GET /orgs/{org}/members`; `PATCH|DELETE /orgs/{org}/members/{user}`; `POST /orgs/{org}/invites`; `DELETE /orgs/{org}/invites/{id}`; `POST /invites/{id}/accept` — teams.
- `GET /ai/models`; `POST /ai/chat` — managed Ask AI.

## ControlPlane service binding

`ControlPlane` extends `WorkerEntrypoint` (see `src/control-plane.ts`): resolveKey,
listDrives, bucket info, key use recording, quota/configuration. The S3 gateway
calls it over the `CONTROL_PLANE` binding; `data-plane` is reached via
`DataPlaneAdmin` on `DATA_PLANE`. Drives without entitlement or over quota get
`403 over_quota` on write-token requests; explicit reads remain available.

## Config

Secrets (`.dev.vars` locally, `wrangler secret put` in production):
`ULS_JWT_PRIVATE_JWK`, `ULS_JWT_PUBLIC_JWKS`, `ULS_ACCESS_KEY_MASTERS` (JSON
version → base64 master, ≥32 bytes each), `DODO_*` billing keys, optional
`RESEND_API_KEY` (email falls back to the console sender), `ULS_DEV_TOKEN`
(local dev only). Cron `*/15 * * * *` meters own bytes for the 500 least recently measured drives and prunes rotated sessions, expired codes, rate-limit windows and old webhook receipts.
