# Production deployment

Deploy Workers in this order:

1. Deploy `cloud/data-plane`.
2. Apply the API database migrations remotely with `npx wrangler d1 migrations apply unlispace-control --remote -c cloud/api/wrangler.jsonc`, then deploy `cloud/api`.
3. Deploy `cloud/s3-gateway`.
4. Build and deploy `web`.

Set these secrets on the corresponding Worker before deployment:

| Worker | Required secrets |
| --- | --- |
| `unlispace-data-plane` | `ULS_JWT_PUBLIC_JWKS`, `ULS_BLOCK_KEY` |
| `unlispace-api` | `ULS_JWT_PRIVATE_JWK`, `ULS_JWT_PUBLIC_JWKS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, `DODO_PRODUCTS` |
| `unlispace-s3` | `ULS_JWT_PRIVATE_JWK`, `ULS_S3_MASTER_KEY` |
| `unlispace-web` | None |

Set secrets with `wrangler secret put <NAME> --env production -c <config>`. API Google OAuth and Dodo values are optional in the runtime type but must be configured to enable those integrations.

Email OTP requires an onboarded sending domain. The production API config intentionally has no email binding until a domain is onboarded.
