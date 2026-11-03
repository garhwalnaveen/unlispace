# Production deployment

Set `ULS_WORKERS_DOMAIN` to the production `workers.dev` domain, such as
`naveen-f3d.workers.dev`. Production Worker endpoints use a placeholder in Wrangler configs;
the wrapper substitutes this environment variable for each Wrangler command and removes its
temporary config afterwards. Keep the value as a hostname, without `https://`. Set
`ULS_API_URL` to the deployed API base explicitly for the Mac app and web builds; the current
endpoint is `https://unlispace-api.naveen-f3d.workers.dev`. The API's production `ULS_WEB_ORIGIN` is `https://orbitfs.io`;
it must match the canonical web origin for sign-in, browser CORS, and desktop handoff.

Run Wrangler production commands through `node scripts/wrangler-production.mjs`, passing the
usual Wrangler arguments. Deploy Workers in this order:

1. `node scripts/wrangler-production.mjs deploy --env production -c cloud/data-plane/wrangler.jsonc`
2. `node scripts/wrangler-production.mjs d1 migrations apply orbit-control --remote --env production -c cloud/api/wrangler.jsonc`, then `node scripts/wrangler-production.mjs deploy --env production -c cloud/api/wrangler.jsonc`.
3. `node scripts/wrangler-production.mjs deploy --env production -c cloud/s3-gateway/wrangler.jsonc`
4. Build `web` with `VITE_API_URL="${ULS_API_URL:?Set ULS_API_URL to the deployed API base}" npm run build --prefix web`, then `node scripts/wrangler-production.mjs deploy --env production -c web/wrangler.jsonc`.

Build the Mac app with `ULS_API_URL="${ULS_API_URL:?Set ULS_API_URL to the deployed API base}" bash mac/scripts/bundle.sh`.
The engine CLI accepts the same API base through its existing `ULS_API` environment variable.

Set these secrets on the corresponding Worker before deployment:

| Worker | Required secrets |
| --- | --- |
| `orbit-data-plane` | `ULS_JWT_PUBLIC_JWKS`, `ULS_BLOCK_KEY` |
| `orbit-api` | `ULS_JWT_PRIVATE_JWK`, `ULS_JWT_PUBLIC_JWKS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, `DODO_PRODUCTS`, `ULS_ACCESS_KEY_MASTERS`, `MOONSHOT_API_KEY` |
| `orbit-s3` | `ULS_JWT_PRIVATE_JWK` |
| `orbit-web` | None |

Set secrets with `wrangler secret put <NAME> --env production -c <config>`. API Google OAuth, Dodo and `MOONSHOT_API_KEY` values are optional in the runtime type but must be configured to enable those integrations. Without `MOONSHOT_API_KEY`, Ask AI shows as unavailable and `/ai/chat` returns `501`. Free-tier caps default to 50 requests and 100,000 tokens per user per UTC day; override with the `ULS_AI_DAILY_REQUESTS` and `ULS_AI_DAILY_TOKENS` vars.

For S3 key creation, set API `ULS_ACCESS_KEY_MASTERS` to a JSON map of version characters to
base64-encoded random master keys (each at least 32 bytes). `ULS_ACCESS_KEY_VERSION` selects
the version for new keys and defaults to `1`. Keep previous master versions in the map while
keys issued under those versions remain active; deleting a version invalidates those keys.
The S3 gateway resolves secrets through the API and does not use `ULS_S3_MASTER_KEY`.
Never print or commit master values. Verify key creation and signed requests before enabling S3.

Once the separate Dodo merchant and matching products are verified, configure `DODO_PRICES`
with amounts in USD cents per billing period. The agreed price configuration is:

```json
{"individual":{"monthly":{"amount":1500,"currency":"USD"},"annual":{"amount":15600,"currency":"USD"}},"teams":{"monthly":{"amount":2500,"currency":"USD"},"annual":{"amount":26400,"currency":"USD"}},"storage":{"monthly":{"amount":1500,"currency":"USD"},"annual":{"amount":15600,"currency":"USD"}}}
```

Verify that each Dodo product uses the same price and billing interval before enabling checkout.
Individual includes 500 GB; Teams includes 1 TB per seat; each storage add-on adds 500 GB.
Existing Individual customers with more than 500 GB would lose write access when the lower
quota takes effect, so assess their usage and any existing commitments before rollout.

Email OTP requires an onboarded sending domain. The production API config intentionally has no email binding until a domain is onboarded.

## Production safety changes pending rollout

`0006_production_safety.sql` adds checkout locks and metering retry state;
`0007_checkout_subscription.sql` binds checkout intents to subscriptions. Apply both before the
new API. The data-plane `v2` Durable Object migration adds `StorageQuota`; the API and S3
Workers depend on its `configureQuota` and read-only `quotaUsage` service methods. Roll out the data plane, then API and
S3, and publish the web build as one coordinated release. Older drive write tokens cannot
initialize quota; users holding cached tokens may need to remount or refresh them after the
rollout. New web Google sign-in needs the new API and vice versa, so validate both together.

Do not enable paid checkout until the separate merchant account, products, webhook and live
credentials have been verified. A checkout whose provider response was lost stays locked to
avoid charging twice; reconcile it against Dodo before removing the lock. The storage quota
object conservatively retains interrupted reservations and counts existing retained chunks;
quota reconciliation and safe cleanup of orphaned objects need operational acceptance before
these changes are used for a broad public launch. Existing mounted SMB shares can keep accepting
local journal writes after their account loses write access; publication is denied until access
returns, but an automatic read-only remount still needs implementation.

`mac/scripts/release.sh` requires `ULSD_BIN`, `ULS_API_URL`, `ULS_VERSION` and
`ULS_BUILD`, and produces a DMG and SHA-256 manifest after Swift tests, signature verification
and an isolated LaunchAgent/RPC check. The isolated probe does not replace installed upgrade,
Keychain and real mounted-file acceptance. Without Apple credentials it produces
an ad-hoc signed, unnotarized DMG: Gatekeeper will block normal opening until the user
explicitly allows the app in macOS settings. Automatic updates are not generated for this
build. For a notarized release supply both `ULS_SIGN_IDENTITY` and `ULS_NOTARY_PROFILE`.

## Correctness rollout and recovery

Ship the data plane before API/S3 clients that depend on `quotaUsage` and versioned xattrs.
Existing quota inventories and retained-reference grants migrate in checkpointed batches;
503 responses during initialization must be retried until complete. Verify accounting on
representative existing organizations before inviting customers. Read-only usage calls must
not reset quota limits. The ledger includes staged bytes, history and spilled metadata.

Native attribute publication requires a drive advertising `xattrs`; an older data plane leaves
that journal entry pending with an upgrade error. Upgrade the data plane first, then distribute
the matching Mac build. Unsupported folder attributes fail explicitly. NDJSON publication
keeps an 8 MiB encoded-manifest cap, independent of the file's logical size.

S3 new state is partitioned by workspace. Existing multipart uploads keep their original
legacy authority until completion/abort; legacy annotations remain readable through fallback.
Do not delete the legacy global state object during rollout.

Keep GC deletion disabled until recovery acceptance. Internal `reconcileQuota(org,lineages)`
checks a bounded ledger page and reports unresolved active reservations. It never expires a
possibly live upload by time alone; stop/fence the relevant upload writers before any manual
release. This release adds verified GC deletion fences and recovery but does not establish a
new version-retention policy. Deleted files and drives can still consume retained storage.
