# 14 · High stakes (gpt-6.1-sol): data plane forks, lineage, DO snapshots, CORS  — write in: cloud/data-plane/
Spec: docs/design/m3-contract.md §2 (normative), plus product-design §3.2/§3.3/§3.5. Space reference
behaviour: /tmp/spacefs-docs-1025/llms-full.txt ("Fork a drive", protocol §5.2).
1. Lineage: `meta.lineage` (default = own driveId, so every existing DO and R2 key is unchanged),
   `forkOf`, `depth`. Replace `shardKey(driveId, …)` and manifest R2 keys with the lineage. `/_blocks`
   serves only when the signature verifies and the drive's lineage matches the path (sig covers both).
2. `DataPlaneAdmin.forkDrive(sourceId, newId)`: copy-on-write fork exactly as §2 (paged RPC export of
   nodes/heads/reachable versions/shards_known marked inherited; waits for in-flight commits; 60 s →
   `slow_down`; depth ≤ 8; child inherits placement). No R2 byte copies. Parent and child diverge
   independently; parent history before the fork point is readable in the child; child watchers start
   at the fork seq.
3. `driveStats` gains `ownBytes`, `lineage`, `depth`, `forkOf`. `deleteDrive(id, {hard})`.
4. GC becomes lineage-safe: root DO keeps `lineage_members`; a shard referenced by any live member is
   never deleted; dry-run stays the default. Add race tests (fork during sweep, write in child during sweep).
5. DO snapshots: the alarm writes `snapshots/{driveId}/{seq}.ndjson.gz` to R2 at most every 6 h and only
   when seq advanced (reuse the fork export format), keeping the newest 7. Add
   `DataPlaneAdmin.restoreSnapshot(driveId, key)` into an *empty* DO, and a test that a drive rebuilt
   from its snapshot answers list/stat/manifest/versions identically.
6. CORS per §2.2 on every `/v0` and `/_blocks` response (env `ULS_WEB_ORIGINS`; add it to
   wrangler.jsonc vars for dev `http://localhost:5173` and production `https://unlispace-web.*` only if
   the existing production web origin is visible in repo config, else leave production empty + note).
Keep every existing test green; add tests for each item. Gate: `cd cloud/data-plane && npx tsc --noEmit && npm test`.
Report ≤ 300 words.
