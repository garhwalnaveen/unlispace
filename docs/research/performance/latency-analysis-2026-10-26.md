# Where Orbit loses time against Space

Reviewed 27 October 2026 against the retained comparison, native follow-up logs, and current source in this checkout. This is an analysis; no product code or deployment changed, and no new hosted transfer was run.

## Measured hosted gaps

The successful 50 MB comparison is the clearest baseline because both applications completed the write and full cold read with matching SHA-256.

| Phase | Space | Orbit | Extra time for Orbit |
| --- | ---: | ---: | ---: |
| Local write + fsync + close | 0.765 s | 37.171 s | 36.406 s; 48.6× duration |
| Of that, fsync | 0.750 s | 37.074 s | 36.324 s |
| Copy start to first empty file queue | 39.398 s | 96.236 s | 56.839 s; 2.44× duration |
| Remaining interval after local acceptance | 38.633 s | 59.066 s | 20.433 s |
| Cold native read + SHA-256 | 10.513 s | 66.604 s | 56.090 s; 6.34× duration |
| First 4 MiB read completed | 2.753 s | 7.414 s | 4.661 s |
| Warm read median | 0.055 s | 0.049 s | No material gap in these three trials |

**About 64% of the observed upload-completion gap is the difference in local acceptance time.** This is a decomposition of elapsed milestones, not proof that network publication waited until fsync returned. Queue observations are sampled upper bounds, and the remaining interval includes whatever publication work was still outstanding plus observation delay. It is not pure network time.

The original 1 GB queue-drain observations were 1,180.21 s for Space and 2,169.27 s for Orbit: an extra 989.06 s, or about 16 min 29 s. Orbit's local operation failed after 688.38 s with `EBADF`; this is a reliability failure, not a valid successful-save speed. Both initial isolated native 1 GB cloud reads failed, so there is no successful cold-download speed ratio for that workload.

Baseline limitations: Space shipped release versus Orbit debug; signing active on Orbit and not reported active on Space; different hosted accounts/deployments; fixed test order; one payload per size. These measurements describe those installations, not current release parity.

## What caused the original delays, and what changed

1. **Local SMB processing was expensive.** The original samples showed signature work through software AES in the debug engine. At 50 MB, engine upload CPU was 38.05 CPU s versus 3.58, and cold-read CPU was 47.42 CPU s versus 1.37. The excess is substantial local processing, although process counters cannot assign every wall-clock second to an individual function. Current Apple Silicon Cargo configuration enables runtime-detected hardware AES, and the follow-up sampled that accelerated path in use. See `engine/.cargo/config.toml:1`.

2. **Large-file chunking could starve socket handling.** A later debug reproduction showed a WRITE stalled for 16.680 s; macOS reconnected after about 10 s, replacing the session and leaving requests with deleted-session/closed-file errors. A sample placed 431/858 observations in publisher folding, including 329 in SHA-256 and 92 in chunk-boundary scanning. Current folding yields cooperatively at `engine/uls-vfs/src/publisher.rs:328`. CLOSE handlers themselves were quick; swallowing a CLOSE error would not fix this chain.

3. **Reads held the journal lock across cloud retrieval, persisted cached metadata unnecessarily, and repeatedly hashed disk shards.** The current implementation releases the lock before fetching base bytes (`engine/uls-vfs/src/lib.rs:122`), persists only metadata misses for read/lookup/list paths, and retains verified disk shards in RAM (`engine/uls-client/src/client.rs:738`). The follow-up records targeted regression coverage for these changes.

The changes were made together and under different build/environment conditions. Their individual speedups have not been isolated.

## Current remaining costs in the source

These are verified code paths and optimization candidates. The reports do not measure their individual contribution to hosted latency.

### 1. Native publication uploads missing shards serially

`engine/uls-vfs/src/publisher.rs:296–368` reconstructs/chunks/hashes the dirty window into a temporary file before probing missing hashes. It then rereads each missing shard and awaits each PUT inside a sequential loop at line 356. Uploads do not overlap one another in this path, nor does its initial chunking overlap these PUTs. A slow shard or retry delays every shard after it and the final commit.

This differs from CLI upload, which already uses bounded parallel transfers at `engine/uls-client/src/client.rs:624–654`; the client default is eight. Increasing the client parallelism setting alone will not parallelize the VFS publisher's explicit loop.

**First implementation candidate:** reuse the bounded-transfer approach for native publication, then measure staging, missing lookup, PUTs and commit separately. Preserve the existing snapshot, retry, conflict and commit semantics. No numeric speedup is established yet.

### 2. Each native write performs expensive durable journal work

`engine/uls-vfs/src/lib.rs:158–174` holds the per-VFS mutex, clones state and calls `install` twice: once to reserve a blob ID durably and once to publish the new extent. Each install serializes the entire state as JSON and commits a SQLite transaction (`engine/uls-vfs/src/journal.rs:132–157`, synchronous FULL). Between them, a new blob is written and synced, and its directory is synced (`journal.rs:161–164`). The growing extent list makes whole-state work increase during a large write.

This remains in current code and is a strong candidate for residual local save cost. Cached-read persistence was removed; write persistence was not. Investigate incremental journaling or safe batching with crash-recovery validation, rather than weakening the durability guarantee.

### 3. Native cold reads wait for shard verification and disk-cache persistence

The daemon requests whole shards for partial reads (`engine/ulsd/src/engine.rs:710–717`). An uncached read waits for the entire shard body, SHA-256 verification, then an awaited disk-cache insertion before returning (`engine/uls-client/src/client.rs:381–407`). Cache insertion hashes the same bytes again and syncs the cache file (`engine/uls-client/src/cache.rs:90–110`). The manifest supports shards up to 16 MiB, so a small native read can wait on much more data than requested.

Range reads parallelize shards intersecting the requested range (`client.rs:721–735`), but there is no explicit prefetch of subsequent manifest shards. Actual concurrency therefore depends on requested ranges and kernel outstanding reads; it is incorrect to call every download serial. Metadata/manifest misses also still occur under the VFS mutex before the read unlocks.

Measure shard fetch, verification and cache-write time separately. Potential changes are bounded sequential read-ahead and avoiding duplicate verification through an internal verified-data cache API; keep integrity checks at trust boundaries.

### 4. Every shard upload waits on additional cloud metadata work

`cloud/data-plane/src/index.ts:130–178` waits for drive description, the checked R2 PUT, then `markShards`. `cloud/data-plane/src/drive.ts:440–451` performs another R2 HEAD before recording the shard; this uses the metadata mutation queue at `drive.ts:128–132`. Those round trips lie inside each awaited publisher PUT.

Native GETs use the authenticated `/shards/` route, which describes the drive and reads R2 (`index.ts:273–280`, `blocks.ts:6–19`). The separate signed-block route has an explicit edge-cache lookup (`blocks.ts:63–90`), which the native client's `get_shard_raw` does not use.

These are additional sources of latency, not measured evidence that Cloudflare/R2 is the dominant cause. Add request spans before changing the authentication, lineage, existence or cache design.

### 5. Intentional publication delay

Default scheduling waits for a 2 s quiet window after flush, or a 30 s maximum dirty age while edits continue (`engine/uls-vfs/src/types.rs:40–45`, `publisher.rs:38–76`). This affects how quickly a save becomes visible remotely. It cannot explain the original 37 s local fsync by itself: `Vfs::flush` persists locally and wakes the publisher without awaiting cloud commit (`lib.rs:236–240`).

## Latest local evidence: the large stalls are no longer present in the successful release run

The retained optimized 1 GB test passed 53 checks, including full integrity, cold remount and cleanup:

- Native write/fsync/close: 15.11 s; fsync 2.82 s; close 0.01 s.
- Publication plus independent CLI download/hash verification after local acceptance: 140 s. This combines two transfer directions and verification; it is **not upload-only time**.
- Cold native read from a fresh mount and empty isolated disk cache: 20.19 s.

I independently paired timestamped dispatch starts/responses in the three retained sanitized SMB traces by command/message/session/tree. Every parsed request had a matching response. Nearest-rank percentiles below include all commands of that type across each harness run, not just the stress fixture:

| Trace/run | Completed WRITEs | Median WRITE | p95 WRITE | Maximum WRITE | WRITEs over 10 s |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reproduced failing debug, `1793035605365` | 1,452 | 53.062 ms | 84.529 ms | 19,274.228 ms | 4 |
| Post-yield debug, `1793036459672` | 1,358 | 97.143 ms | 314.630 ms | 5,153.164 ms | 0 |
| Successful release, `1793038642902` | 1,241 | 11.126 ms | 16.411 ms | 29.354 ms | 0 |

In the release trace, READ p95 was 60.387 ms and maximum 168.667 ms (1,196 requests); CLOSE maximum was 3.137 ms (190 requests). Dispatch spans exclude work outside dispatch, including portions of transport/signing, and concurrent durations must not be added to estimate elapsed transfer time. Debug post-yield still failed its native-copy deadline; its lower maximum is not a successful transfer result.

The release results use local Workers on macOS 27.0.1, while the original hosted comparison recorded macOS 26.5.1. They establish acceptance for that local release workload, not a new speed ratio against Space.

## Recommended next measurement

Run the same hosted 50 MB and 1 GB workloads with the current release daemon, controlled power conditions, original security protections, unique incompressible content, cold benchmark caches and exact SHA-256 checks. Record local open/write/fsync/close, publisher wait, chunk/hash/staging, missing lookup, individual PUT/GET attempts, cache persistence and final commit separately. Record server-side auth/drive metadata/R2 spans with correlation IDs and no credentials. Repeat with alternating order.

The strongest current target is native serial publication, followed by durable per-write whole-state persistence and the cold-read pipeline. We can identify those mechanisms now; exact percentages of the remaining hosted gap require those spans.

## Evidence

- [50 MB report](space-vs-orbit-50mb-2026-10-26.md) and [machine-readable results](space-vs-orbit-50mb-2026-10-26.json).
- [Original 1 GB comparison](space-vs-orbit-1gb-2026-10-26.md).
- [Implementation and native follow-up](follow-up-2026-10-26.md).
- [Retained successful local release run](../../../tests/e2e/last-run.txt).
- Local sanitized traces: `/tmp/orbit-smb-diagnostic-1793035605365.log`, `/tmp/orbit-smb-diagnostic-1793036459672.log`, `/tmp/orbit-smb-diagnostic-1793038642902.log`; process sample `/tmp/orbit-large-close-flush-sample.txt`. Temporary artifacts may not survive cleanup/reboot.
