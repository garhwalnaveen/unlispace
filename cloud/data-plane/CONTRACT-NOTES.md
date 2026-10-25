# Contract interpretation notes (M0 + M1 auth)

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
15. (M0) **Large manifests (> 1 MiB, R2 `manifests/...`) are not implemented.** A commit body is capped at 1 MiB and a
    manifest entry is about 70 bytes of JSON, so inline manifests fit well under the 2 MB DO row cap. Needed for M1.
16. **Folder `stat`** returns `size: 0`, `contentType: null`. Root stat (`path=`) returns a synthetic folder.
17. **Errors beyond the contract:** `400 bad_request`, `404 not_found`/`no_such_version`, `405`, `411`, `426`.

## M1 (auth, lifecycle) and review amendments

18. **JWT format verified** (`src/jwt.ts`): `b64url(header).b64url(payload).b64url(sig)`, header `{alg:"EdDSA",typ:"JWT",kid}`,
    signature = raw 64-byte Ed25519 over the ASCII `header.payload`, JWKS `{"keys":[{kty:"OKP",crv:"Ed25519",kid,x}]}`.
    Claims checked: `iss == ULS_ISSUER`, `typ == "drive"`, `exp` (seconds, +30 s leeway), `nbf` if present, `sub` non-empty
    string, `drives[]` of `{id, access}`. Anything else fails closed with 401. Entries with an unknown `access` are ignored.
19. **Access** is ordered read < write < admin; the highest grant for a drive id wins. A route/method outside the §3 table
    gets `405`/`404 not_found` after auth. Unknown drive, drive not in claim, or too little access are all `404 no_such_drive`
    (before any DO call), so existence is not probeable. The dev token skips the claim check.
20. **Expiry and `4401`.** The Worker passes the token `exp` to the DO in an internal header (client copies are stripped);
    the DO stores it in the socket attachment and an alarm closes with `4401 token_expired` at `exp`. A token inside its
    30 s verification leeway can still open a socket; the first alarm tick (immediately) closes it with 4401. Dev-token sockets never expire.
21. **Soft delete**: DO `meta.deleted=1`; every DO method answers `404 no_such_drive`, sockets are closed with `4404 drive_deleted`,
    `deleteDrive` is idempotent (also for absent ids), and the id can **not** be re-created (`createDrive` gives `drive_exists`).
    R2 shards and DO data are kept (no hard purge in M1).
22. **`createDrive` error**: a thrown `DriveExistsError` (`name`, `message` = `drive_exists: <id>`; `code`/`status` properties
    may not survive every RPC boundary, so match on `name` or the `drive_exists` message prefix). Invalid ids or placements throw `TypeError`.
23. **Existence**: shard and commit calls on a never-created drive are `404 no_such_drive` for every principal (M0 behaviour kept).
24. **Review fixes** (see `m0-contract.md` §3.5/§3.6): shard PUT passes `sha256` to R2 (checksum failure -> `400 hash_mismatch`, no
    delete path); log entries carry `ev` (rowid), `/changes` and `/watch` take `after=<ev>` and `since=<seq>`, watch replays in bounded
    alarm-driven batches with live events withheld until caught up, backlog > 100k events -> `resync` + close; JSON bodies are
    stream-capped (413); `/versions` is paginated (opaque cursor = last version rowid); folder delete/rename page through the
    subtree, > 100,000 nodes -> `400 subtree_too_large`; descendants of a folder rename > 1024 bytes -> `400 path_too_long`; lone
    surrogates -> `400 bad_path`; shard registration happens in the commit transaction; query tokens only for GET watch upgrades;
    dev-token compare uses `crypto.subtle.timingSafeEqual` over SHA-256 digests; existing-folder mkdir stays idempotent.
25. **Shard PUT size** is `Content-Length` (R2 enforces the stream length via `FixedLengthStream`); if the object already existed, its R2 size is recorded.
