# Contract interpretation notes (M0)

Where `docs/design/m0-contract.md` was ambiguous, this is what the data plane does.

1. **Rename version/log shape.** A rename creates a new version (`op: "rename"`, same manifest) at the destination
   path and a `delete` version at the source. For folders, every descendant gets the same pair. The change log has
   `delete <from>` then `rename <to>` for the top-level path only (not one entry per descendant), so watchers
   re-list the folder. Commit `results` has one entry per op, with `path` = destination.
2. **Result `path` form.** Results echo folders with a trailing `/` (`mkdir`, folder `delete`/`rename`), files without.
3. **mkdir on an existing folder** is idempotent (returns its current version id, no new version, no log entry).
   `ifAbsent: true` on an existing folder gives 412.
4. **Auto-created parents** get their own `mkdir` version and log entry in the same seq.
5. **`delete`** of a missing path is `404 no_such_path` (after the precondition check, so `ifVersion` on a missing
   path gives 412 with `currentVersionId: null`). Folder delete removes the subtree and writes a delete version per node.
   A trailing `/` must match the node type.
6. **`rename`** requires both paths to be folders (trailing `/`) or both files, rejects renaming a folder into
   itself, and returns `409 path_conflict` if the destination exists. Missing parents of the destination are created.
7. **`restore`** accepts versions with content (`put`, `restore`, `rename`). Deleted or mkdir versions give
   `400 not_restorable`. Unknown version id or one belonging to another path gives `404 no_such_version`.
   Restoring over a deleted path works (head is absent; `ifVersion` omitted/null).
8. **`/changes` and watch ordering** are by `seq`, then insertion order within a commit. `since` is exclusive.
   `watch` without `since` starts at the current head. The path in log entries uses the external form
   (trailing `/` for folders).
9. **List cursor** is an opaque base64url of the last returned path. `limit` default and max are 1000.
   Names sort bytewise by full path, which equals bytewise order of the name within one parent.
10. **`/missing`** HEADs R2 for hashes unknown to `shards_known`, and records the ones found, so it is also a
    repair path. Duplicates in the request are collapsed.
11. **Shard PUT requires `Content-Length`** (R2 needs a known length for a stream); a missing one gives `411`.
    The 16 MiB cap is checked on the header and also enforced on the byte stream. An over-cap stream gives 413.
12. **Shard keys** are `shards/{driveId}/{hash}` (lineage = driveId). Shard GET/PUT on an unknown drive gives
    `404 no_such_drive`, since the drive must exist to own a lineage.
13. **`shards_known` size check.** Commit also verifies `n` equals the recorded shard size and returns
    `400 bad_manifest` on disagreement.
14. **Schema additions** (reference schema otherwise as written): `nodes.parent` (+ index) for paginated listing,
    `versions.ctype`/`versions.mtime` so historical manifests return their own content type and mtime.
15. **Large manifests (> 1 MiB, R2 `manifests/...`) are not implemented.** A commit body is capped at 1 MiB and a
    manifest entry is about 70 bytes of JSON, so inline manifests fit well under the 2 MB DO row cap. Needed for M1.
16. **Folder `stat`** returns `size: 0`, `contentType: null`. Root stat (`path=`) returns a synthetic folder.
17. **Errors beyond the contract:** `400 bad_request`, `404 not_found`/`no_such_version`, `405`, `411`, `426`.
