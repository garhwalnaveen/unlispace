# 20 · High stakes (gpt-6.1-sol): history follows node identity across renames  — write in: cloud/data-plane/, cloud/s3-gateway/ (only to drop workarounds the data plane makes redundant)
Problem (from cloud/s3-gateway/NEEDS.md and engine/ulsd/NEEDS.md "moved directory descendants"):
`versions` is keyed by `path`. After a file or folder rename, `GET versions?path=<new>` loses the
pre-rename history, `manifest(versionId)` with the new path fails for old version ids, and a folder
rename moves descendant nodes without any row that lets a client find "what was at path P at time T".
Space reference: rename is one metadata-only version; content and history are untouched; it answers
at the new key immediately; rename versions are omitted from content history (llms-full.txt §4.7,
/tmp/spacefs-docs-1025/llms-full.txt — re-download from https://docs.spacefs.com/llms-full.txt into
/tmp if missing).
1. Add `node_id` to `versions` (migration for existing DOs and for fork-imported/snapshot-restored state:
   backfill by walking the log; keep `path` as "path at commit time"). History, manifest-by-version,
   restore and as-of resolve through node identity, so they work at the new path for old version ids.
2. Path history: a `path_log(seq, ts, node_id, path, op)` (or equivalent) written for every node whose
   path changes, including every descendant of a renamed folder, inserted set-based in the same
   transaction (keep the row budget sane: one INSERT…SELECT over the subtree, bounded by the existing
   subtree-count guard). New read route `GET /v0/drives/{id}/tree-at?path=<folder/>&ts=<ms>` (read access,
   paginated, cursor) returning `{entries:[{path, nodeId, versionId, size, type}], cursor}` = the subtree as
   it was at `ts`, with paths as they were then. Also `GET versions?path=` gains `includeRenames=1`.
3. Fork export, snapshots and GC marking must carry the new columns/tables (extend their tests).
4. In cloud/s3-gateway: if it keeps its own rename-history archive in S3State (see its NEEDS.md), switch
   `?x-uls-versions` and versionId reads to the data plane's node-identity history and delete the archive
   path; keep all 81 gateway tests + 16 conformance cases green.
5. Document the new route and semantics in cloud/data-plane/README.md (create a short section) and append
   the wire shape to docs/design/m3-contract.md as a new §2.3 (that one shared-file edit is allowed).
Tests: rename file then read/restore old version at new path; rename folder then tree-at before the
rename shows old paths; nested renames; rename + delete + recreate same path keeps histories separate;
fork after rename; snapshot round-trip. Gate: `cd cloud/data-plane && npx tsc --noEmit && npm test` and
`cd cloud/s3-gateway && npx tsc --noEmit && npm test`. Report ≤ 300 words.
