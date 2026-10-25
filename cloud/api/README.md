# Unlispace control-plane API (M1)

Worker `unlispace-api`: auth (email OTP, Google OIDC, desktop PKCE), sessions, orgs, drives, and drive-token minting.
Implements `docs/design/m1-contract.md`. Storage is D1 (`DB`); drive lifecycle goes to the data plane through the
`DATA_PLANE` service binding (`DataPlaneAdmin` entrypoint).

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
- `migrations/0001_init.sql`; `test/` suite
