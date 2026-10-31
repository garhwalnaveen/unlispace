# Native publication and local-save changes — 27 October 2026

This implements the remaining publisher/journal targets from `latency-analysis-2026-10-26.md` in the existing restored product worktree. Earlier uncommitted fixes are preserved. There is no new hosted throughput claim.

## Native shard transfers

- The publisher still freezes the same snapshot and stages a CDC/hash fold in a temporary file. It probes missing hashes on every attempt and does not commit until every missing shard PUT succeeds.
- Missing shards now upload concurrently, bounded by the client transfer limit and a native cap of eight. A client configured for three transfers is therefore limited to three native uploads. At most eight maximum-sized shard buffers are in flight (128 MiB with the current 16 MiB maximum), rather than retaining the whole file in RAM.
- Each staged range is read through its own file handle on the blocking pool so offsets cannot race and local disk reads do not monopolize the async socket executor.
- Existing immutable shard retries, lost-ACK reconciliation, precondition/conflict handling, suffix reuse and missing-shard re-probing remain in place. A failed PUT prevents commit and leaves the journal retryable; already accepted immutable shards are reused on retry.
- Debug-level structured events separate scheduler wait, publisher-lock wait, fold/hash/disk staging, missing lookup, individual shard PUTs, total uploads and commit attempts. Fields are timings, counts, internal file IDs/revisions and success flags, not paths, tokens or URLs. Fold staging includes base reads where a dirty window needs them; it is not isolated CPU time.

## One durable snapshot per write

The preliminary SQLite blob-ID reservation snapshot was redundant with the existing `create_new` blob creation and orphan recovery. Each accepted write now:

1. Reserves an ID in memory while holding the existing VFS mutex.
2. Creates the blob without replacement and synchronizes its bytes and blob directory.
3. Publishes the new extent and allocator together in one SQLite FULL-synchronous transaction.

A failure before step 3 leaves an unreferenced blob; reopening reads the committed snapshot and collects it before reusing its ID. An existing blob is never overwritten. A journal commit error retains the new blob because the commit outcome may be ambiguous; recovery decides whether it is referenced. The memory allocator advances even on failure so subsequent live-process writes do not collide with that blob.

The journal schema is unchanged. File and directory fsyncs, SQLite WAL/FULL synchronization, snapshot ordering, journal caps and acknowledged-write durability remain. This cuts whole-state serialization/SQLite commits from two to one per local write; it does not remove the remaining one whole-state serialization, clone or blob/directory synchronization. A larger incremental-journal migration is not needed for this reduction and remains a separate measured design change.

## Validation

The interrupted session left the publisher calling a missing `Client::parallelism()` accessor and borrowing per-shard data in the concurrent upload closure; both are fixed. The interrupted-upload regression now pins `parallelism(1)` because its "which shards reached the server" assertions are only deterministic sequentially; concurrent bounds are covered separately.

`cargo test --workspace --all-features` passed with zero failures (2 tests ignored by the repository). Added coverage checks overlapping uploads at a configured bound of three, no commit before PUT completion, failed-PUT publication prevention/retry, pre-snapshot crash orphans and non-overwrite, committed blob/counter reopen, one snapshot per growing write, and injected SQLite failure followed by recovery. The local E2E harness was then rerun; see the benchmark below.

## Local 1 GB benchmark — 27 October 2026

Full E2E gate (`E2E_SMB=1 E2E_STRESS_BYTES=1000000000`) with pinned binaries via `E2E_ENGINE_BIN`. New = release SMB `ulsd` built from this tree. Baseline = the `ulsd` bundled in the 26 October review app, which already contains the 26 October fixes. Runs were alternated on the same Mac. Every run passed 53 of 53 checks. "Drain" is the time from native close until the daemon reports zero pending uploads and ops. It is now recorded separately from the independent CLI download in `tests/e2e/stress.mjs`.

| Phase (seconds) | New, 3 runs | New median | Baseline, 3 runs | Baseline median |
| --- | --- | --- | --- | --- |
| Native write + fsync + close | 6.77, 7.42, 7.41 | 7.41 | 5.48, 8.00, 7.31 | 7.31 |
| Publication drain | 16.6, 17.3, 16.5 | 16.6 | 19.5, 17.6, 16.6 | 17.6 |
| Cold remount read | 8.07, 6.49, 6.15 | 6.49 | 6.07, 6.19, 6.14 | 6.14 |

At this sample size there is no measurable difference against local loopback Workers. The spread between runs exceeds the gap between medians. This is expected for parallel uploads: with near-zero request latency, per-shard round trips are not the bottleneck, so overlapping them buys little. The benefit of this change should appear only where each shard PUT waits on real network latency. That needs a hosted or latency-injected measurement before any speed claim. The halved snapshot commits did not move local-accept time measurably either. The earlier "140 s" figure in `comparison-implementation-status.md` combined drain with the independent download and is not comparable to these rows.

Not verified here: hosted transfer speed, individual phase percentages, kernel mount throughput, power-failure simulation at the hardware/storage-controller level, or production deployment. Existing local tests use the loopback mock server and generated files under the repository's 64 MiB test-data limit.

## Hosted latency findings and fixes — 27 October 2026

Measured from this Mac against the production Workers (`*.naveen-f3d.workers.dev`):

| Observation | Measurement |
| --- | --- |
| Edge routing | Our `workers.dev` hosts terminate at Cloudflare CDG (Paris), ~100 ms RTT. `www.cloudflare.com` terminates at NAG, ~43 ms. Space's gateway: 110 ms TTFB warm, ours 230 ms. |
| Control calls through the installed daemon | `/orgs` median 3.6 s (2.0–8.6 s); drive resolution 1.9–3.2 s; `stat` ~2 s. Health check on a warm connection: 0.23 s. |
| Cold CLI download, 20 MB | 13.5 s (1.5 MB/s). Path baseline to Cloudflare: 4.3–6.0 MB/s. |
| Upload, 20 MB | 42.9 s (0.47 MB/s). Path baseline: 0.46–1.06 MB/s, so uploads were uplink-bound in this session. |

Causes found in source, and the changes made:

- **New TCP+TLS handshake per daemon request.** `ClientBuilder::build` created a new `reqwest` pool per client, and the daemon builds a client per request. There is now one process-wide pool with keep-alive.
- **`/orgs` refetched on every drive lookup.** The daemon now caches it for 30 s per user. The cache is cleared on any non-GET API call, on `auth.set`, and on sign-out.
- **`/orgs` was an N+1 D1 waterfall.** It ran 1 + 2 queries per org, plus 2 per drive. It is now one `db.batch` of four queries. The lazy provisioning retry is preserved.
- **No sequential read-ahead.** `Vfs::read` now prefetches the next 4 shards (bounded by client parallelism). Publisher folds do not prefetch. With 150 ms injected per-shard latency, a 24 MiB sequential read takes under half the serial time; without the change it takes 3.76 s, against 1.5 s serial (test `sequential_reads_overlap_shard_downloads`).
- **Cache fsync and a second SHA-256 on the read path.** Verified shards go into RAM first, then persist in the background without re-hashing. `get` still verifies every disk entry. Offline pins use `fetch_shard_durable` and remain synchronous.
- **Whole-tree aggregate on every shard request.** Shard PUT, GET, `missing`, commit, manifest and block routes called `describe()`, which runs a recursive COUNT/SUM over the drive. They now call `locate()`, which returns existence and lineage only.
- **Serial R2 HEADs in the Durable Object.** `markShards` and the commit recheck now issue HEADs in parallel (batches of 50). The recheck still runs under the IO lock, so the GC-race protection is unchanged.

Local gate after these changes: workspace Rust tests, API (93) and data-plane (97) tests passed. The 1 GB E2E passed 53/53. Cold remount read: 4.51 s, against a 6.14–6.49 s median earlier today. That is one run, so treat it as indicative.

Not yet verified: no hosted rerun with the new daemon (that needs a separate signed-in daemon or replacing the installed one), and no deployment of the API or data-plane changes (`wrangler` is not authenticated here). The edge-routing gap needs a custom domain or Smart Placement, which are untested.

## Hosted 50 MB, installed app, 27 October 2026

Same procedure as the 26 October Space comparison: 4 MiB unbuffered writes, fsync and close through the SMB mount; upload-queue polling; three warm reads; then a cold read after unmounting, setting aside this file's cache shards and remounting. Every passing read matched the source SHA-256. Script: `/tmp/uls-bench/bench50.py`. Production Workers were **not** redeployed, so only the daemon changed. Space figures are from 26 October, on a different day and network, and were not rerun.

| Run | Daemon | Local accept (fsync) | Queue empty from copy start | Cold read | First 4 MiB | Result |
| --- | --- | --- | --- | --- | --- | --- |
| old-1 | 26 Oct | not recorded | not recorded | — | — | cold open timed out (`ETIMEDOUT`) |
| old-2 | 26 Oct | 0.99 s (0.97) | 53.95 s | — | — | cold read failed after 74 s (`ENXIO` "Device not configured") |
| new-1 | 27 Oct | 0.58 s (0.53) | 57.22 s | — | — | **first warm read after publication failed (`ENXIO`)** |
| new-2 | 27 Oct | 0.47 s (0.47) | 35.05 s | 6.03 s (8.29 MB/s) | 2.17 s | pass |
| new-3 | 27 Oct | 0.47 s (0.46) | 51.01 s | 8.14 s (6.14 MB/s) | 3.73 s | pass |
| new-4 | 27 Oct | 0.50 s (0.49) | 24.39 s | 8.48 s (5.89 MB/s) | 2.45 s | pass |
| Space, 26 Oct | — | 0.765 s (0.750) | 39.40 s | 10.51 s (4.76 MB/s) | 2.75 s | pass |

Three additional cold reads of the new-1 file passed in 5.8–6.8 s, and two write-publish-read probes passed. The `ENXIO` failure is intermittent and its root cause is **not yet identified**. It reproduced on both daemons, and it is a release blocker independent of speed.
