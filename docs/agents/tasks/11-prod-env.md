# Small task (Codex · gpt-6-luna): production env blocks for wrangler configs

Add an `"env": { "production": { ... } }` block to each of these four files. **Do not change
the existing top-level (dev) config.** Wrangler does not inherit vars or bindings into envs, so
repeat every binding inside production.

| File | Worker name in production |
|---|---|
| `cloud/data-plane/wrangler.jsonc` | `unlispace-data-plane` |
| `cloud/api/wrangler.jsonc` | `unlispace-api` |
| `cloud/s3-gateway/wrangler.jsonc` | `unlispace-s3` |
| `web/wrangler.jsonc` | `unlispace-web` |

In each production env, set `"name"` to the Worker name above so wrangler doesn't append
`-production`. Also set `"workers_dev": true` and `"preview_urls": false`.

Use the placeholder `__SUBDOMAIN__` wherever a workers.dev URL is needed. The coordinator
replaces it.

## `cloud/data-plane/wrangler.jsonc` (production)
- R2 `SHARDS` → bucket `unlispace-shards`
- the DO binding `DRIVE_AUTHORITY`, unchanged
- vars:
  - `ULS_ISSUER = "https://unlispace-api.__SUBDOMAIN__.workers.dev"`
  - `ULS_ALLOW_DEV_TOKEN = "0"`
  - `ULS_GC_DELETE = "0"`

## `cloud/api/wrangler.jsonc` (production)
- D1 `DB` → database_name `unlispace-control`, `database_id` `__D1_ID__`, the same `migrations_dir`
- service `DATA_PLANE` → `unlispace-data-plane`, entrypoint `DataPlaneAdmin`
- **no** `send_email` binding: no sending domain yet, so email OTP is off
- vars:
  - `ULS_ISSUER = "https://unlispace-api.__SUBDOMAIN__.workers.dev"`
  - `ULS_DATA_ENDPOINT = "https://unlispace-data-plane.__SUBDOMAIN__.workers.dev"`
  - `ULS_WEB_ORIGIN = "https://unlispace-web.__SUBDOMAIN__.workers.dev"`
  - `DODO_PAYMENTS_ENVIRONMENT = "test_mode"`

## `cloud/s3-gateway/wrangler.jsonc` (production)
- both service bindings, the `S3_STATE` DO binding and the existing migration
- vars:
  - `ULS_ISSUER` as above
  - `ULS_S3_HOST = "unlispace-s3.__SUBDOMAIN__.workers.dev"`
  - `ULS_S3_DEV_KEYS = "[]"`

## `web/wrangler.jsonc` (production)
- the same `assets` block

## Also
1. Create `docs/DEPLOY.md`:
   - the deploy order: data-plane → api (with `d1 migrations apply --remote`) → s3 → web
   - every secret per Worker, taken from each wrangler.jsonc `secrets.required` and from
     `cloud/api/src/env.ts`: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `DODO_PAYMENTS_API_KEY`,
     `DODO_PAYMENTS_WEBHOOK_KEY`, `DODO_PRODUCTS`
   - the rule that email OTP needs an onboarded domain later
2. Validate each file. Run `npx wrangler@4 deploy --dry-run --env production -c <file>`, using a
   copy with the placeholders replaced by a dummy subdomain and a dummy UUID. Do NOT deploy for
   real, and do not create or modify any Cloudflare resource.
3. Don't run `git commit`. Write only these 4 files plus `docs/DEPLOY.md`.

Report: the dry-run result for each file, in one line each.
