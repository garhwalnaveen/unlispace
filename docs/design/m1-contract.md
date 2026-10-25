# M1 contract: identity, tokens, control-plane API

Status: frozen for M1 · 2026-10-25. Implemented by `cloud/api/` (issuer), `cloud/data-plane/`
(verifier), `engine/` (daemon client), `web/` and `mac/` (UI clients). Change this file first.

M0's data-plane endpoints (`docs/design/m0-contract.md` §3) are unchanged except for auth (§3
below) and drive creation (§4).

## 1. Local dev topology

| Service | Dir | Local URL |
|---|---|---|
| Control-plane API | `cloud/api` | `http://127.0.0.1:8788` |
| Data plane | `cloud/data-plane` | `http://127.0.0.1:8787` |
| Web app | `web` | `http://127.0.0.1:5173` |

`npx wrangler@4 dev -c cloud/api/wrangler.jsonc -c cloud/data-plane/wrangler.jsonc` runs both
Workers in one process, with the service binding live. `node cloud/scripts/dev-keys.mjs` generates
an Ed25519 keypair and the internal secret, and writes them into both `.dev.vars` files. It keeps
existing keys and never prints secrets.

| Env var | Who | Meaning |
|---|---|---|
| `ULS_JWT_PRIVATE_JWK` | api (secret) | Ed25519 private JWK, with `kid` |
| `ULS_JWT_PUBLIC_JWKS` | api + data plane | `{"keys":[<public JWK with kid>, ...]}`; more than one key allows rotation |
| `ULS_ISSUER` | both | `https://unlispace-api.$ULS_WORKERS_DOMAIN` in production, or `http://127.0.0.1:8788` locally |
| `ULS_DATA_ENDPOINT` | api | public base URL of the data plane, returned to clients |
| `ULS_WEB_ORIGIN` | api | CORS allow-origin and redirect base for the web app |
| `ULS_ALLOW_DEV_TOKEN` | data plane | `"1"` keeps the M0 static bearer working (dev only; default off) |
| `ULS_DEV_LOG_OTP` | api | `"1"` logs OTP codes with `console.log` instead of emailing them (dev only) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | api (secret) | Google OIDC; when absent, `/auth/google/*` answers `501 not_configured` |

## 2. Tokens

All tokens are JWTs: `alg: EdDSA` (Ed25519), header `kid`, signed by the api. Verifiers must check:
- the signature against the JWKS key named by `kid`
- `iss == ULS_ISSUER`
- `exp > now` (±30 s leeway)
- `typ`

| `typ` | Lifetime | Claims | Used at |
|---|---|---|---|
| `access` | 15 min | `sub` (user id), `sid` (session id), `email` | api |
| `drive` | ≤ 15 min | `sub`, `sid`, `org`, `drives: [{"id": "<driveId>", "access": "read"\|"write"\|"admin"}]`, `jti` | data plane |

The **refresh token** is opaque: `rt_` + 43 chars of base64url (32 random bytes). D1 stores only
its SHA-256. It lasts 30 days and is rotated on every use. If a refresh token that was already
rotated away is presented again, every token in that session's family is revoked (reuse
detection).

Ids:
- users `u_` + ULID
- orgs `o_` + ULID
- sessions `s_` + ULID
- drives `d-` + lowercase ULID (fits the M0 driveId regex `[a-z0-9][a-z0-9-]{2,62}`)

## 3. Data-plane auth (replaces M0 §2)

- `Authorization: Bearer <drive token>`. On `/watch`, the token may also be given as `?token=`.
- Required access:
  - `read` for GET `stat`, `list`, `manifest`, `versions`, `changes`, `watch`, shard GET, and `/shards/missing`
  - `write` for shard PUT, `commit`, `restore`
  - `admin` is reserved
- The path's `{driveId}` must appear in the token's `drives` claim with sufficient access.
  Otherwise the response is `404 {"error":"no_such_drive"}` (absent, not forbidden, so tokens
  can't be used to probe for drives).
- A bad, expired or missing token gets `401 {"error":"unauthorized"}`.
- A WebSocket stays open past token expiry. The client reconnects with a fresh token when it is
  closed with code `4401`. The server closes with `4401` once `exp` passes (an alarm, or a check
  on each ping).
- The `actor` recorded on versions = the token's `sub`.
- `ULS_DEV_TOKEN` is accepted only when `ULS_ALLOW_DEV_TOKEN == "1"`. It acts as admin on all
  drives with actor `dev`.

## 4. Drive lifecycle (api → data plane)

The data plane exports a `WorkerEntrypoint` named `DataPlaneAdmin`. The api binds to it as service
binding `DATA_PLANE`, with `entrypoint: "DataPlaneAdmin"`. It's reachable only through the
binding, never over HTTP.

```ts
createDrive(driveId: string, placement?: Placement): Promise<{ driveId: string; placement: string; createdAt: number }>
deleteDrive(driveId: string): Promise<{ ok: true }>          // soft: drive refuses all requests afterwards
driveStats(driveId: string): Promise<{ headSeq: number; fileCount: number; bytes: number } | null>
```

The public `PUT /v0/drives/{driveId}` exists only under `ULS_ALLOW_DEV_TOKEN`.

## 5. Control-plane API (`cloud/api`)

JSON everywhere. Errors are `{"error": "<code>", "message"?: string}`. Authenticated routes need
`Authorization: Bearer <access token>`. CORS allows `ULS_WEB_ORIGIN`, with methods GET, POST,
PATCH, DELETE and headers `authorization, content-type`.

### 5.1 Auth

| Route | Body → Response |
|---|---|
| `POST /auth/otp/start` | `{email}` → `200 {"ok":true}` always (no account enumeration). 6-digit code, 10 min TTL, max 5 attempts. Rate limit: 5 starts per email per hour and 20 per IP per hour, otherwise `429 {"error":"rate_limited"}` |
| `POST /auth/otp/verify` | `{email, code}` → `200 Session`, or `400 {"error":"invalid_code"}` |
| `GET /auth/google/start?return=<url>` | `302` to Google (OIDC code flow + PKCE + state + nonce; `return` must be on `ULS_WEB_ORIGIN`) |
| `GET /auth/google/callback` | verifies the id_token (Google JWKS, `aud`, `iss`, nonce, `email_verified`), then `302` to `<return>#handoff=<one-time, 60 s>` |
| `POST /auth/handoff/exchange` | `{handoff}` → `200 Session` (single use) |
| `POST /auth/refresh` | `{refreshToken}` → `200 Session` (rotated), or `401 {"error":"invalid_refresh"}` |
| `POST /auth/logout` | `{refreshToken}` → `200 {"ok":true}` (revokes the session) |
| `GET /auth/desktop/start?state&code_challenge&code_challenge_method=S256` | `302` to `${ULS_WEB_ORIGIN}/desktop?state=…&code_challenge=…` |
| `POST /auth/desktop/code` (authed) | `{state, codeChallenge}` → `200 {"code": "<one-time, 120 s>"}`. The web app then navigates to `uls://auth/callback#code=<code>&state=<state>` |
| `POST /auth/desktop/exchange` | `{code, codeVerifier}` → `200 Session` (PKCE S256 check, single use) |

`Session` = `{"accessToken","refreshToken","expiresIn":900,"user":{"id","email"},"accountCreated":bool}`

The first sign-in for an email creates: the user, a personal org `"My Space"` (role `owner`, tier
`individual`, `trialEndsAt = now + 7 d`), and a drive `"Space"` (via `DATA_PLANE.createDrive`).
This all happens in one D1 batch, plus the RPC call. If the RPC fails, the drive row is marked
`status: "provisioning_failed"` and retried lazily on `GET /orgs`.

### 5.2 Resources

| Route | Response |
|---|---|
| `GET /me` | `{"id","email","displayName":string\|null,"createdAt"}` |
| `PATCH /me` | `{displayName}` → same shape as `GET /me` |
| `GET /orgs` | `{"orgs":[Org]}`, where `Org` = `{"id","name","role":"owner"\|"admin"\|"member"\|"viewer","tier":"individual"\|"teams","trialEndsAt":ms\|null,"drives":[Drive]}` |
| `POST /orgs/{orgId}/drives` | `{name, placement?}` → `201 Drive`. Owner or admin only; `individual` tier is limited to 1 drive → `403 {"error":"plan_limit"}` |
| `GET /drives/{driveId}` | `Drive`. `Drive` = `{"id","orgId","name","placement","status":"ready"\|"provisioning_failed"\|"deleted","createdAt","access":"read"\|"write"\|"admin"}` |
| `PATCH /drives/{driveId}` | `{name}` → `Drive` |
| `DELETE /drives/{driveId}` | `200 {"ok":true}`. Owner or admin; soft-deletes the drive and calls `DATA_PLANE.deleteDrive` |
| `POST /drives/{driveId}/token` | `{access?: "read"\|"write"}` → `200 {"token","expiresAt":ms,"endpoint": ULS_DATA_ENDPOINT,"driveId"}`. `access` is capped at the caller's role: owner/admin = write, member = write, viewer = read |

Access keys, billing (Dodo Payments) and members/invitations are **M2**. Their routes are not
built in M1.

## 6. D1 schema (reference)

```sql
CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT, created_at INTEGER NOT NULL);
CREATE TABLE orgs(id TEXT PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL, trial_ends_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE memberships(org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(org_id, user_id));
CREATE TABLE drives(id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, placement TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, family TEXT NOT NULL, refresh_hash TEXT NOT NULL UNIQUE, prev_hash TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, user_agent TEXT);
CREATE TABLE otp_codes(email TEXT PRIMARY KEY COLLATE NOCASE, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE one_time_codes(code_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, payload TEXT, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE rate_limits(k TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
```

Hashes are SHA-256 hex. OTP codes are compared in constant time.
