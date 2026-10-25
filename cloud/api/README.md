# Unlispace control-plane API (M1 + M2 + M3)

Worker `unlispace-api`: auth (email OTP, Google OIDC, desktop PKCE), sessions, orgs, drives, and drive-token minting.
Implements `docs/design/m1-contract.md`. Storage is D1 (`DB`); drive lifecycle goes to the data plane through the
`DATA_PLANE` service binding (`DataPlaneAdmin` entrypoint).

M2 adds versioned HMAC-derived S3 access keys with parent scopes/transitive revocation and Dodo
Payments billing (public catalog, checkout, billing state, invoices, portal and signed webhooks).
The complete request/response and configuration contracts are in [M2-API.md](M2-API.md);
cross-owner integration needs and verification limits are in [NEEDS.md](NEEDS.md).
M3 adds aliases, forks, hard deletion, the `ControlPlane` RPC entrypoint and hourly own-byte
metering. See [M3-API.md](M3-API.md), which supersedes M2 quota semantics: write-token requests
without entitlement or over quota return `403 over_quota`; explicit reads remain available.
Existing tokens retain the M1 lifetime.

## Run locally

```sh
npm install
node ../scripts/dev-keys.mjs      # Ed25519 keypair -> api/.dev.vars and data-plane/.dev.vars (idempotent; --rotate to replace)
npm run db:migrate:local          # applies migrations/ to the local D1
npm run dev                       # http://127.0.0.1:8788; OTP codes print to the console (ULS_DEV_LOG_OTP=1)
npm test                          # vitest + @cloudflare/vitest-plugin, local D1, fake DATA_PLANE
npm run typecheck
```

Both Workers with a live service binding: `npx wrangler@4 dev -c cloud/api/wrangler.jsonc -c cloud/data-plane/wrangler.jsonc` (repo root).
If `npm install` crashes with "edgesOut", install the devDependencies in groups.

## Config

Vars in `wrangler.jsonc`: `ULS_ISSUER`, `ULS_DATA_ENDPOINT`, `ULS_WEB_ORIGIN` (local values; override for production).
Secrets (`.dev.vars` locally, `wrangler secret put` in production): `ULS_JWT_PRIVATE_JWK`, `ULS_JWT_PUBLIC_JWKS`,
optional `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (without them `/auth/google/*` is `501 not_configured`), `RESEND_API_KEY`.
M2 key secrets: `ULS_ACCESS_KEY_MASTERS` (JSON version → base64 master, each at least 32 bytes);
`ULS_ACCESS_KEY_VERSION` selects the issuing version, default `1`.
Billing: `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, explicit
`DODO_PAYMENTS_ENVIRONMENT=test_mode|live_mode`, and `DODO_PRODUCTS` (catalog JSON; see M2 contract).
Catalog remains public without credentials, with `checkoutAvailable:false`.
`ULS_DEV_LOG_OTP=1` logs OTP codes instead of emailing them (dev only). `ULS_EMAIL_FROM` sets the sender (default `login@unlispace.com`).

Email sender order: console (dev flag), Resend (`RESEND_API_KEY`), Cloudflare Email Service `send_email` binding `EMAIL`.
The sending domain must be onboarded first (`npx wrangler email sending enable <domain>`).

`npm run deploy` was not run. Before deploying: create the D1 database and put its id in `wrangler.jsonc`, apply migrations, set secrets, onboard the email domain.

## Layout

- `src/index.ts` routing, CORS, error mapping (`handle(req, env, deps)` is the test seam)
- `src/jwt.ts` EdDSA JWT sign/verify, WebCrypto only, no Worker imports (copy into the data plane)
- `src/session.ts` access/drive token minting, refresh rotation + reuse detection, bearer auth
- `src/otp.ts`, `src/google.ts`, `src/onetime.ts`, `src/ratelimit.ts`, `src/email.ts`
- `src/users.ts` first sign-in provisioning; `src/resources.ts` me/orgs/drives/token
- `src/access-keys.ts` key scopes, derivation, revocation and internal verification/last-use helpers
- `src/billing.ts`, `src/billing-catalog.ts`, `src/entitlements.ts` billing routes and token entitlements
- `src/dodo.ts` injectable provider interface, REST adapter and Standard Webhooks verification
- `src/control-plane.ts` gateway RPC methods; `src/entitlements.ts` hourly metering and quotas
- `migrations/0001_init.sql`, `migrations/0002_keys_billing.sql`, `migrations/0003_m3.sql`; `test/` suite (all external I/O mocked)

Gate (from this directory): `npx tsc --noEmit && npm test`. For a sandbox that cannot write the
user's global Wrangler log folder, set `WRANGLER_LOG_PATH=./.wrangler/logs` for the gate.
