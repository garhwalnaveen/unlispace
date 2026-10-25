# Production deployment

Set `ULS_WORKERS_DOMAIN` to the production `workers.dev` domain, such as
`naveen-f3d.workers.dev`. Production Worker endpoints use a placeholder in Wrangler configs;
the wrapper substitutes this environment variable for each Wrangler command and removes its
temporary config afterwards. Keep the value as a hostname, without `https://`. The Mac app
bundle and web build use the same setting to point sign-in and control-plane requests at
`https://unlispace-api.$ULS_WORKERS_DOMAIN`. `ULS_API_URL` can override that full API URL when
building the Mac app or web app.

Run Wrangler production commands through `node scripts/wrangler-production.mjs`, passing the
usual Wrangler arguments. Deploy Workers in this order:

1. `node scripts/wrangler-production.mjs deploy --env production -c cloud/data-plane/wrangler.jsonc`
2. `node scripts/wrangler-production.mjs d1 migrations apply unlispace-control --remote --env production -c cloud/api/wrangler.jsonc`, then `node scripts/wrangler-production.mjs deploy --env production -c cloud/api/wrangler.jsonc`.
3. `node scripts/wrangler-production.mjs deploy --env production -c cloud/s3-gateway/wrangler.jsonc`
4. Build `web` with `VITE_API_URL="${ULS_API_URL:-https://unlispace-api.$ULS_WORKERS_DOMAIN}" npm run build --prefix web`, then `node scripts/wrangler-production.mjs deploy --env production -c web/wrangler.jsonc`.

Build the Mac app with `ULS_WORKERS_DOMAIN="$ULS_WORKERS_DOMAIN" bash mac/scripts/bundle.sh`.
The engine CLI accepts the same API base through its existing `ULS_API` environment variable.

Set these secrets on the corresponding Worker before deployment:

| Worker | Required secrets |
| --- | --- |
| `unlispace-data-plane` | `ULS_JWT_PUBLIC_JWKS`, `ULS_BLOCK_KEY` |
| `unlispace-api` | `ULS_JWT_PRIVATE_JWK`, `ULS_JWT_PUBLIC_JWKS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, `DODO_PRODUCTS` |
| `unlispace-s3` | `ULS_JWT_PRIVATE_JWK`, `ULS_S3_MASTER_KEY` |
| `unlispace-web` | None |

Set secrets with `wrangler secret put <NAME> --env production -c <config>`. API Google OAuth and Dodo values are optional in the runtime type but must be configured to enable those integrations.

Email OTP requires an onboarded sending domain. The production API config intentionally has no email binding until a domain is onboarded.
