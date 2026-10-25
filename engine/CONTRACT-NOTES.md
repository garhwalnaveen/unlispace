# Contract notes (engine side)

Where `docs/design/m0-contract.md` was ambiguous, wrong, or where the engine had to choose.

## Golden vectors
- Contract vector: `engine/uls-chunk/tests/golden.json` (chunk lengths `n` and SHA-256 `h`, plus input length and input SHA-256).
- **Problem:** the contract's input `b[i] = (i * 2654435761 >> 13) & 0xff` is periodic, so FastCDC finds no cut point
  and the result is two identical 16 MiB max-size chunks. It passes as a vector but exercises neither cut-point
  selection nor normalization. Cloud-side ports should pass it and also pass the supplementary vector below.
- **Supplementary vector:** `engine/uls-chunk/tests/golden_prng.json`, 32 MiB from splitmix64 seeded `0x756c73`
  (little-endian u64 stream truncated to 33554432 bytes). Generator: `engine/uls-chunk/src/lib.rs::golden_input_prng`.
- Operator precedence: `i * 2654435761 >> 13` is read as `((i * 2654435761) >> 13) & 0xff` with u64 wrapping multiply (`*` binds tighter than `>>`).
- Crate version used: `fastcdc` **3.2.1** (v5 exists; the contract says v3). `Normalization::Level1` is the default of `FastCDC::new` / `StreamCDC::new`.

## Wire details I had to decide
1. **Precondition error key casing.** The 412 body uses `currentVersionId` (camelCase) per the contract; the task brief wrote `current_version_id`. The client parses `currentVersionId`.
2. **`put` op field names are camelCase** (`ifVersion`, `ifAbsent`, `contentType`, `mtimeMs`); the shard refs use `h` / `n`. `ifVersion` is always serialized (as `null` when unset), matching the example; `delete`/`rename` accept it missing or null.
3. **Commit result `size`** is shown only for puts in the example. The client treats it as optional.
4. **`stat` on a folder:** the contract lists `versionId`, `size`, `contentType`, `mtimeMs`, `seq` without saying what a folder returns. All are optional in the client. For paths, the client sends file paths without a trailing slash and folders as given; for `stat`/`manifest` it does not append `/`. The mock tries both forms. **Open question for cloud:** should `stat` of `docs` resolve folder `docs/`?
5. **Folder listing path.** `list?path=` is sent with a trailing `/` for non-root folders (contract: `path=<folder/>`). Root is `path=` (empty).
6. **`list` entries**: the client does not rely on `versionId`/`size`/`mtimeMs` being present for folders.
7. **Shard GET `Range`.** The client sends a single `bytes=a-b`. If a server answers 200 (ignores Range), the client verifies the whole body against the hash and slices locally. Partial (206) bytes cannot be verified against the shard hash, so they are **not cached**. The NFS mount avoids this by fetching whole shards (`whole_shard_on_partial`) so every read is verified and cached.
8. **Retry policy.** Retried with exponential backoff (250 ms base, 8 s cap, 5 attempts, plus jitter): network errors, 429, 5xx on idempotent calls (reads, `/missing`, shard PUT, shard GET). **Commit and restore are never auto-retried**: a retry after an ambiguous failure could double-apply.
9. **`missing_shards` on commit.** The client re-uploads exactly the hashes listed and re-commits, up to 3 rounds. This covers `shards_known` being stale relative to R2.
10. **WebSocket auth.** The client sends `Authorization: Bearer` on the upgrade (the contract allows it) so the token never appears in a URL. `?token=` is not used by the engine.
11. **Watch dedup.** After a reconnect, changes with `seq <= last seen` are dropped. If a commit contains several ops that share one `seq` (contract: "one commit gives one seq"), only the **first** op's change is delivered to a stream that resumes mid-commit. **Ambiguity:** the contract's `changes` rows have no per-op ordinal, so `since=<seq>` cannot resume mid-commit. Suggest `seq` be unique per change row, or add an `idx` field in M1.
12. **Content type** on upload is guessed from the file extension (`mime_guess`), default `application/octet-stream`.
13. **Drive ids** are validated server-side only. `ulsd` passes them through untouched.
14. **Empty files:** `shards: []`, `size: 0`, no shard uploads.
15. **No `Content-Length` assumptions** on shard PUT: reqwest sets it from the in-memory buffer.

## NFS notes
- nfsserve **0.11.0** (`huggingface/nfsserve`). It has `static mut` + `unsafe` inside the crate; our code stays `#![forbid(unsafe_code)]`.
- Mount flags used exactly as specified: `port=<p>,mountport=<p>,nolocks,vers=3,tcp,rdonly,actimeo=1`.
- NFS ids are assigned from an in-memory path table and never reused within a process; they are not stable across restarts (nfsserve file handles embed a per-process generation number, so a restart makes old handles `STALE` by design).
