# Release evidence — 2026-11-05

All four Workers are live. Google sign-in, drive setup, a file round trip, Team, and Dodo checkout passed in the in-app browser. Paid subscription activation and the macOS browser handoff remain open.

## Baseline

Before the release, the following Worker versions served 100% of traffic:

| Worker | Version ID |
| --- | --- |
| `unlispace-api` | `4f7f093e-0a9c-42f8-86ef-1bfec566acf3` |
| `unlispace-data-plane` | `c943b8a4-a548-42ee-baf8-120ab3b4abea` |
| `unlispace-s3` | `5a1a9277-4a10-4edc-ba3d-13dd4fabaae3` |
| `unlispace-web` | `3fdadec3-cbdf-44bb-82a6-2c384de0ac53` |

Worker deployment and version metadata and the API, data-plane and S3 script contents were saved in `/tmp/orbit-launch-backup` with private permissions. The assets-only web Worker returned no script content; its retained Cloudflare version is the rollback reference. A private SQL export was saved at `/tmp/orbit-control-before-launch-20261105.sql` before migrations.

## Deployed versions

| Worker | Version ID |
| --- | --- |
| `unlispace-data-plane` | `0c9b3cf7-069b-4268-b5f8-5c0a1f46f4a2` |
| `unlispace-api` | `d6f009b0-f324-486f-aab2-c7f39b583ea5` |
| `unlispace-s3` | `0cf83895-8df7-42b5-bc56-20a3aa13dae5` |
| `unlispace-web` | `9dbd6477-7f9c-4485-805b-4032ecdae496` |

Post-deployment settings confirmed the original D1 and R2 bindings, all three Durable Object namespace IDs, production service bindings, and existing secret names were preserved.

## Validation and migrations

- API: 136 tests passed.
- Data plane: 133 tests and a focused existing-index test passed.
- Web: 109 tests passed before the Billing fix; seven focused tests passed afterward.
- macOS: the full Swift suite passed, including the sign-in cancellation regression. The opt-in live browser-to-daemon test was skipped.
- End-to-end: 50 tests passed.
- Wrangler applied `0008_billing_grace.sql`, `0008_drive_recovery.sql` and `0009_ai_usage.sql` to the production D1 database after the SQL export. Earlier migrations through `0007_checkout_subscription.sql` were already applied.

## Production acceptance and remaining work

- A fresh Google sign-in created an account and a ready drive. A 41-byte file uploaded and downloaded with identical hashes. Billing showed trial and storage usage. Team displayed the plan requirement for invites.
- The OrbitFS brand under Nuvi has four recurring products and two add-ons. The OrbitFS Plans collection applies prorated upgrades immediately and downgrades at renewal. Subscription updates are enabled for the shared business as authorized.
- The API Worker uses the scoped Dodo live runtime key. Webhook `ep_3LfuPlLcjlHlnfWMeDaBw95WHB3` subscribes to 12 subscription events. Dodo's signed `subscription.active` sample returned HTTP 200 in 632 ms.
- Cloudflare Workers rejected the original Dodo request's `redirect: "error"` option before sending. The adapter now uses `redirect: "manual"` and rejects non-success responses. Two locks from failed pre-send requests were removed. The retest opened branded Individual Monthly checkout. Dodo confirmed the first successful session had no payment. A live charge, subscription activation and plan change remain unverified.
- The authorized account reset removed four users, 905 sessions, three keys, and four memberships, while retaining four drives and billing data. The new account added one drive. A final read returned one user, five drives, and zero paid subscriptions. The pre-release SQL export remains at the private backup path above.
- The local macOS `0.2.8-preview` DMG was cleanly installed. First-run Google sign-in reached the desktop connection page with the account and drive ready. The in-app browser's Open Orbit action left the installed app waiting, so native sign-in completion and a Finder mount remain unverified. Canceling exposed a misleading engine error. A fix shipped to the locally installed `0.2.9-preview` DMG and the same cancel action returned to the normal signed-out screen. The local build is ad hoc signed. This Mac has no Developer ID signing identity for a notarized distribution. The prior installation backup is `/Users/naveen/Orbit-deploy-backup-2026-11-05-102956`.
- Production email OTP and Ask AI require provider configuration. Google sign-in is verified.
- The unused, broadly scoped OrbitFS Production API credential remains active at the user's direction. Its value appeared in the earlier tool transcript. The deployed API uses a separate scoped credential.

