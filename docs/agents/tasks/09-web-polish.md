# 09 · Web app M2 screens  — write in: web/
Add: access keys page (`/settings/access-keys`: list, create with access level + drive allowlist,
one-time secret reveal with copy-as-env-vars, revoke) and billing page (`/orgs/:id/billing`: plan,
trial days, checkout redirect, invoices, portal) against the M2 endpoints being added in
cloud/api/M2-API.md by another agent — if that file doesn't exist yet, code against the routes in
docs/agents/tasks/06-api-keys-billing.md and mock them. Upload in the file browser: chunk with a
TS FastCDC (copy approach: must match engine/uls-chunk/tests/golden*.json), `/shards/missing`,
parallel shard PUTs with progress, commit with ifAbsent/ifVersion, conflict message on 412.
Drag-and-drop. Move refresh token from localStorage to an in-memory+BroadcastChannel design with a
documented HttpOnly-cookie migration note. Gate: `npm run typecheck && npm test && npm run build`.
