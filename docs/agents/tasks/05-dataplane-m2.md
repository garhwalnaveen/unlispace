# 05 · Data plane M2: node-id tree, R2 manifests, edge block cache, GC sweep  — write in: cloud/data-plane/
1) Replace the path-keyed `nodes` table with a node-id tree (id, parent_id, name, type, head) so
folder rename/delete are O(1) rows (keep all external behaviour and the 64 tests green; add a
migration path from the M0 schema for existing DOs). 2) Manifests > 256 KiB stored in R2 at
`manifests/{lineage}/{sha256}` with `manifest = "r2:<sha>"`; commit accepts large file
manifests in a streamed body. 3) `GET /_blocks/{lineage}/{sha}?d=<drive>&exp=<s>&sig=<hmac>`
served via the zone cache (`Cache-Control: immutable`, Cache API on miss), HMAC key secret
`ULS_BLOCK_KEY`; `/manifest` responses include signed block URLs. 4) GC: a Workflow or alarm-driven
mark-and-sweep per lineage that deletes R2 shards unreferenced by any live/retained version and
older than 7 days (dry-run mode default). Tests for all; `npx tsc --noEmit && npm test` green.
