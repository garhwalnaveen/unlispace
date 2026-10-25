# Space: signed-in observations (2026-10-25, read-only)

## Session
- Bearer JWT, HS256, claims {sub:userId, email, iss:"spacedb-auth", iat, exp}. exp = 4946511671 (~year 2126): effectively non-expiring session token.
- Stored in localStorage spaceBearer / spaceBearerGeneration; other keys: space-drive.user.v1.<userId>, space-drive.onboarding.allowed.v1.<userId>.
- Gateway CORS: allow-origin https://app.spacefs.com, credentials true. Same bearer works on s3sdk `/_s3sdk/keys` via header `x-s3sdk-login-authorization: Bearer …`.

## Identity: GET /me
{userId, workosUserId:null, legacySpaceUserId, identityVersion:1, identitySource:"space", email, developerAccess:false, reviewEnabled:true, reviewNotificationsEnabled:true, firstName, lastName, displayName, avatarUrl}
- WorkOS migration in progress (workosUserId field).

## Onboarding: POST /onboarding/access (empty body)
{allowed, entry_allowed, storage_ready, reason:"workspace_included", account_type:"standard", billing_enforced:true,
 access_workspace_id, entry_workspace_id, checkout_workspace_id:null, signup_attempts_supported, requires_tier_selection:false,
 selected_product_tier:"individual",
 signup_attempt:{schema_version:1, attempt_id:"signup_<sha256 hex>", free_trial_reserved:true, workspace_id, product_tier, state:"active", created_at, updated_at, activated_at, abandoned_at, checkout_contract_version:0},
 available_product_tiers:["individual","teams"], individual_acquisition_reason:"available", access_expires_at:<signup+7d>}
- Trial without card: activation happened 10 s after signup; access expires exactly 7 days later.
- After the trial, /orgs/{id}/billing shows a hard paywall: "Your card is charged US$180.00 today and your trial ends now".

## Workspaces: GET /orgs  (and ?include=volumes → adds drive_projection_version:1 + volumes[])
org: {id(uuid v5-looking), name:"My Space", slug, role:"owner", pending_role, my_drive_status:"active", my_drive_id, provisioning_source:"authoritative", provisioning_state:"active", emoji, color, description, image, product_tier, capabilities{additional_members, workspace_invites, shared_workspace_visibility, member_acl, outbound_drive_sharing, direct_sharing, public_file_links, upload_requests}}
- Signup auto-creates org "My Space" + personal drive "Space".

## Drives: GET /orgs/{id}/volumes, GET /volumes/{id}
{id:"spacedb-<orgId>-data", bucket (same), name:"Space", region:"auto", status:"ready", backend:"r2", org_id, owner_user_id, drive_kind:"my_drive", visibility:"private",
 authorization_generation:1, lifecycle:"active", lifecycle_generation:1, can_read, can_write, can_mount, can_manage_visibility, can_share, can_delete, admin_metadata_only}
- Drive id = bucket name = "spacedb-{orgUUID}-data" → one logical bucket/prefix per workspace on R2.
- GET /shared-volumes → {volumes:[]}; GET /orgs/{id}/profiles → {profiles:[{user_id, display_name, avatar_url}]}

## Items (web file browser)
- GET /volumes/{v}/items/root → {item:{id:"root", name, item_type:"folder", parent_id, size, content_type, block_size, layout, storage_key, upload_state, current_revision_id, content_version, etag, content_hash, manifest_sha, manifest_size, modified_at(ms), created_at, updated_at}}
- GET /volumes/{v}/items?parent=root → {items:[], observed:[]}
- Items have id-based tree (parent_id), revisions (uuid), manifest_sha/manifest_size, block_size+layout → file = manifest of blocks.
- Then /items/{id}/manifest + POST /presign-blocks {storage_key, indices, method:"GET"} → per-block presigned R2 URLs.

## Billing: GET /billing/pricing (authed) / GET /orgs/{id}/billing
- Exposes Stripe price ids: seat_monthly/annual, storage_monthly/annual, seat_promotion_2026_*, storage_promotion_2026_*, individual_2026_seat_*, individual_2026_storage_*; stripe_price_config_hash; publishable key; custom_offers_enabled:false; trial_period_days:7.
- /orgs/{id}/billing/invoices → {invoices:[]}
- /orgs/{id}/billing/ai-usage → {addon_rule:null, addons:[], outstanding_keys:[], windows:[{definition:"free_annual", limit_usd:"2.0000", available_usd, consumed_usd, spent_usd, forfeited_usd, remaining_usd, keys:0, reset_at:null, balance_stale, state:"not_anchored"}]}
  → AI is metered in USD with a $2/yr free allowance; "keys" = AI provider keys issued per org (LLM proxy keys).

## Access keys: GET s3sdk/_s3sdk/keys
{keys:[{accessKeyId:"S3SDK…" (uppercase, 20 chars), workspaceId, access:"admin", drives:null, label, parent:null, createdAt, lastUsedAt, revokedAt}]}
- UI: Settings › Access keys — New key, endpoint copy, table (Key / Access / Last used), Revoke.

## Deep links
- "Show in Finder" → space://share?d=<driveId>&w=<workspaceId>
- Desktop sign-in → space://auth/callback#code=…&state=…

## Mac app state on this machine
- Running: /Applications/Space/Space.app (Space), Contents/Resources/space-launcher-search, PlugIns/SpaceFinderSync.appex; fskitd + fskit_agent running.
- Drive NOT mounted at time of check (no FSKit volume in `mount`); likely FSKit extension not yet enabled in System Settings.
- Local: ~/Library/Application Support/SpaceLauncherDemo-Primary (tantivy search index, frecency RocksDB, search.sock, space-agent.toml, space-agent-provider.json), group.com.spacefs.launcher/spacefs-config/config.json, Team ID 24J8HFD297.
