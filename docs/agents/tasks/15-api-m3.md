# 15 · High stakes (gpt-6.1-sol): control plane M3 — aliases, forks, ControlPlane entrypoint, metering, quota  — write in: cloud/api/
Spec: docs/design/m3-contract.md §1, §3 (normative); cloud/api/M2-API.md; Space key rules §9.2 in
/tmp/spacefs-docs-1025/llms-full.txt ("Key routes").
IMPORTANT: `src/google.ts` and `src/index.ts` contain the user's uncommitted Google sign-in fix. Do not
touch `google.ts`. In `index.ts` keep those lines exactly (the `fetch.bind(globalThis)` change); add
your routes around them.
1. Migration `migrations/0003_m3.sql` (§3.1) + alias derivation/validation (§1) on create/patch.
2. `POST /drives/{id}/fork`, `DELETE /drives/{id}?hard=1`, Drive JSON additions, plan limits (§3.2).
   Call `DATA_PLANE.forkDrive` / `deleteDrive(id,{hard})` / `driveStats` (contract §2.1; tests use fakes).
3. Named export `ControlPlane extends WorkerEntrypoint` with every method of §3.3. `mintChildKey`
   enforces Space §9.2 rules 1–3 (same workspace, access cannot rise, non-empty drives ⊆ parent's reach)
   and stores `parent`; revocation is already transitive. `mintMountToken` reuses the drive-token minter.
   Every method re-resolves the key (revocation, ancestor chain, membership) — no trust in the caller.
4. Hourly `scheduled` metering into `drive_usage` (§3.4, add `triggers.crons` to wrangler.jsonc incl.
   production env), `usedBytes` from `own_bytes`, over-quota → 403 `over_quota` on write tokens and
   `writable:false` in BucketInfo.
5. Update README.md / M2-API.md (or add M3-API.md) for the new surface.
Tests for every route/method including authorization negatives (other org, viewer, revoked parent,
child widening attempts, alias collisions, fork of a fork to depth 9). Gate:
`cd cloud/api && npx tsc --noEmit && npm test`. Report ≤ 300 words.
