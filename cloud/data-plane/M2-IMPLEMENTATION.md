# M2 data plane implementation

Scope: `cloud/data-plane/` only. No dependencies or remote resources.

Plan:
- Migrate path-keyed nodes transactionally to stable IDs and indexed parent/name edges.
  Resolve paths by walking edges; detach a subtree root to delete, update its edge to rename.
  Keep the contract's subtree-count and path-length guards (read scans, constant row mutations).
- Spill compact manifests strictly larger than 256 KiB to content-addressed R2 objects.
  Keep legacy 1 MiB JSON commits; add bounded streamed NDJSON commits for larger manifests.
- Sign drive-scoped, expiring block URLs with ULS_BLOCK_KEY; validate before zone-cache reads.
- Share the existing alarm with a paged, generation-checked GC mark/sweep. All historical
  versions remain retained until a retention contract exists; deletion is explicitly opt-in.
- Add migration, tree, large-manifest, signed-cache, and GC/race coverage, then run
  `npx tsc --noEmit && npm test`.
