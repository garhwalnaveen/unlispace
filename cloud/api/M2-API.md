# M2 control-plane additions

This extends `docs/design/m1-contract.md`. JSON responses are `Cache-Control: no-store`;
errors retain `{error, message?}`. Authenticated routes use the existing bearer access token
and live session-family check. Unknown orgs are 404; members without a management role get 403
on billing management routes. Timestamps are epoch milliseconds unless stated otherwise.

## Access keys

| Route | Contract |
| --- | --- |
| `GET /keys?workspaceId=<orgId>` | `{keys:[Key]}`. Filter optional; otherwise all visible orgs. Owners/admins see every key in their org, other members see their own. Revoked keys remain visible. |
| `POST /keys` | `{workspaceId, access:"read"\|"write"\|"admin", drives?:string[]\|null, label?:string\|null, parent?:string\|null}` → 201 `{...Key, secretAccessKey}`. |
| `DELETE /keys/{accessKeyId}` | `{ok:true}`; idempotent for an already revoked, visible key. Atomically revokes its entire descendant tree. Missing/hidden key → 404. |

`Key` has `{accessKeyId, workspaceId, access, drives, label, parent, createdAt, lastUsedAt,
revokedAt}`. The workspace is an org. `drives:null` grants all its current/future drives;
`[]` grants none. All allowlisted drives must belong to the org and not be deleted.
Labels have 1–100 characters when supplied; a scope can contain at most 100 unique IDs.
Owners/admins may issue admin keys, members up to write, viewers only read. Members can revoke
their own keys; owners/admins may revoke any key in their org.

Parent keys must be live in the same org and either owned by the caller or accessible to an
org owner/admin. Children cannot increase the parent's access or widen its drive scope.
`resolveAccessKey` rechecks every ancestor's revocation and current org membership, and caps
access at the lowest current role in the chain. Removing membership invalidates the chain.

IDs are exactly 20 uppercase characters: `ULS` + one version character `[A-Z0-9]` + sixteen
random base32 characters (80 random bits). Secrets are the first 40 characters of standard
base64 encoding of `HMAC-SHA256(masterForVersion, UTF8(accessKeyId))` (30 bytes / 240 bits).
D1 stores metadata only. The secret appears once in the public POST response, never GET.
`ULS_ACCESS_KEY_MASTERS` is a JSON version-to-base64-secret map; every master must have at least
32 bytes. `ULS_ACCESS_KEY_VERSION` selects the issuing version (default `1`). Retain old
versions to verify existing keys during rotation. Missing/bad key config → 503
`keys_not_configured`; invalid or revoked credentials → 401 `invalid_key`.

Gateway integration functions in `src/access-keys.ts` are **internal**, with no public lookup
route: `resolveAccessKey(ctx,id)` returns metadata + derived secret + owner user ID;
`recordAccessKeyUse(ctx,id)` updates last-use monotonically. The verifier must call the latter
only after a successful SigV4 check and scope authorization. Resolving a key alone is not
authorization for an arbitrary drive or operation. SigV4 transport/service-binding integration
belongs to the gateway (M3 in agent 07's task).

## Billing routes

| Route | Contract |
| --- | --- |
| `GET /billing/catalog` | Public; `{provider:"dodo",trialDays:7,trialRequiresCard:false,plans,storageAddon,cadences,checkoutAvailable}`. |
| `GET /orgs/{id}/billing` | Any org member; `{orgId,provider,state,writable,trialEndsAt,plan,seats,storageAddons,quotaBytes,usedBytes,overQuota,status,cadence,currentPeriodEnd,cancelAtPeriodEnd}`. |
| `POST /orgs/{id}/billing/checkout` | Owner/admin; `{plan:"individual"\|"teams",cadence?:"monthly"\|"annual",seats?:number,storageAddons?:number}` → `{url}`. Defaults: monthly, 1 seat, 0 add-ons. |
| `GET /orgs/{id}/billing/invoices?page=0` | Owner/admin; `{invoices:[{paymentId,status,amount,currency,createdAt}],nextPage:number\|null}`. Amount is integer currency minor units; `createdAt` is Dodo's ISO timestamp. Empty before the first customer is attached. Pages contain up to 100 payment/invoice summaries; PDF downloads remain available in the hosted customer portal. |
| `POST /orgs/{id}/billing/portal` | Owner/admin; `{url}`. No customer yet → 409 `no_billing_customer`. Does not send an email. |
| `POST /webhooks/dodo` | Public transport, mandatory Dodo signature; `{ok:true,ignored?:true}` after durable handling. |

Individual allows exactly one seat and 1 TB. Teams allows 1–1000 seats with 1 TB per seat
pooled across org drives. Add-on quantity is 0–1000, each adding 500 GB. Units are decimal
(1 TB = 10^12 bytes). Checkout seat count cannot be below current membership count.
Prices remain undecided in product design: no Space pricing or made-up amounts are advertised.
Dodo product configuration is authoritative for prices/taxes; checkout displays them.

`DODO_PRODUCTS` is this JSON shape, with four distinct recurring seat product IDs and
recurring storage addon IDs matched to each cadence:

```json
{
  "individual": { "monthly": "p_ind_monthly", "annual": "p_ind_annual" },
  "teams": { "monthly": "p_team_monthly", "annual": "p_team_annual" },
  "storage": { "monthly": "addon_storage_monthly", "annual": "addon_storage_annual" }
}
```

Required Dodo secrets/config: `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`,
`DODO_PAYMENTS_ENVIRONMENT` (`test_mode` or `live_mode`, explicit to avoid accidental charges).
Missing config → 503 `billing_not_configured`; upstream errors → 502 `billing_unavailable`.
`handle(req,env,{dodo})` injects the `DodoPayments` interface; tests use fakes exclusively.
The REST adapter also accepts the existing injected fetch function.

Checkout uses Dodo's `POST /checkouts` with one recurring seat product, quantity = seats,
and recurring `addons` for storage. A server-created checkout intent stored in D1 is sent in
metadata `{org_id,checkout_intent}`. The API ignores caller-supplied return URLs and product
IDs. It uses the configured web origin as the checkout/portal return location. It does not
grant entitlements on redirect or session creation. Checkout explicitly sets
`subscription_data.trial_period_days=0`: purchasing converts immediately; the original
seven-day no-card trial is already recorded by `orgs.trial_ends_at`.
An existing nonterminal subscription returns 409 `subscription_exists`; manage it via portal.

## Webhook verification and persistence

Verified against [Dodo's webhook documentation](https://docs.dodopayments.com/developer-resources/webhooks)
and the [Standard Webhooks implementation](https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/javascript/src/index.ts)
on 2026-10-25. The implementation uses WebCrypto, without new dependencies:

- Read the bounded raw UTF-8 body before parsing JSON (64 KiB maximum, enforced while streaming).
- Require `webhook-id`, `webhook-timestamp` (seconds), and `webhook-signature`.
- Strip optional `whsec_` from the configured secret, base64-decode it, calculate
  HMAC-SHA256 over `id.timestamp.rawBody`, then base64-encode the result.
- Compare `v1,<signature>` in constant time. Space-separated candidates support key rotation.
- Reject timestamps more than five minutes old or in the future; failures → 401
  `invalid_webhook_signature`. Invalid JSON/schema → 400 `invalid_webhook`.
- Persist delivery IDs in `dodo_events`. Duplicate deliveries do not mutate entitlements.
- Apply subscription state, org tier/trial conversion, and delivery receipt in one D1 batch
  transaction. Newer event timestamps win; equal timestamps use delivery-ID lexical order.

Handled lifecycle events: `subscription.active`, `.renewed`, `.updated`, `.plan_changed`,
`.on_hold`, `.cancelled`, `.expired`, `.failed`. The signed subscription payload's status,
product ID, quantity, addons, customer and next billing date determine entitlements.
New subscriptions attach only through a known org-bound checkout intent. Later events can
use the stored subscription/customer mapping without metadata. Unrelated events/subscriptions
are acknowledged with `ignored:true` and cannot grant access. Bad products/quantities are
rejected without storing a receipt, allowing corrected configuration and retry.
Portal changes must continue to use products from this configured catalog.

## Entitlements and limits

The preexisting signup flow starts seven days of no-card access. At `trialEndsAt` a new
write-token request is capped to **read**, retaining download access. A valid paid subscription
requires status `active` and a future `next_billing_date`; an active scheduled cancellation
retains access until that date. Effective cancellation, expiry, failure or hold removes paid
write access. Activation consumes the local trial; subsequent cancellation cannot revive it.
A failed initial conversion preserves the original trial until its original expiry.

For each write-token request, the API sums `DATA_PLANE.driveStats(...).bytes` across every
ready org drive. Usage strictly greater than quota → 403 `{error:"quota_exceeded"}`. Usage
exactly at quota can obtain a token. Read requests and viewer-capped requests bypass quota
checks. Missing/invalid stats fail closed with 503 `usage_unavailable`. Deleted drives do not
count. `GET .../billing` uses the same usage and sets `writable:false` when over quota.

The current RPC measures logical current-head bytes, not deduplicated retained-lineage bytes.
This task enforces entitlement/quota when issuing tokens. Tokens already issued keep their
M1 lifetime (up to 15 minutes), and concurrent writes can outgrow a quota before the next token
request. Gateway/DO write-path quota checks, grant invalidation, physical retained-byte
metering and nightly billing metering require other owners; see `NEEDS.md`.

API references checked: [checkout](https://docs.dodopayments.com/api-reference/checkout-sessions/create),
[portal](https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session),
[payments](https://docs.dodopayments.com/api-reference/payments/get-payments).
