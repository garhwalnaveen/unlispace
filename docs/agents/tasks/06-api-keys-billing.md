# 06 · Control plane M2: S3 access keys + Dodo Payments billing  — write in: cloud/api/
Read docs/research/spacefs/signed-in.md (Space's billing + access-key behaviour) and
product-design §4.1/§6. 1) Access keys: `GET/POST /keys`, `DELETE /keys/{id}` exactly like Space's
`/_s3sdk/keys` semantics (id `ULS`+17 chars, 40-char secret = HMAC(master_k, id) with key version
in id, read/write/admin, drive allowlist, `parent` + transitive revoke, secret shown once,
last-used tracking). Add D1 migration. 2) Billing with **Dodo Payments** (merchant of record):
plans Individual/Teams (seats + 500 GB storage add-ons, 7-day no-card trial already modelled by
`trialEndsAt`). Endpoints: `GET /billing/catalog` (public), `POST /orgs/{id}/billing/checkout`
(creates Dodo checkout session; returns URL), `GET /orgs/{id}/billing`, `GET /orgs/{id}/billing/invoices`,
`POST /orgs/{id}/billing/portal`, `POST /webhooks/dodo` (verify signature per Dodo docs — check
docs.dodopayments.com for the current webhook signing scheme; the repo root has an old Next.js Dodo
starter you may read for reference: actions/, lib/dodo-payments, supabase/functions). Entitlement
enforcement: trial expiry → read-only drive tokens; storage over quota → 403 `quota_exceeded` on
write tokens. All Dodo calls behind an interface, mocked in tests; no network. Update
docs in cloud/api/README.md and write the contract additions to cloud/api/M2-API.md.
Gate: `npx tsc --noEmit && npm test` green.
