# Orbit S3 performance rerun — 17 November 2026

All **49 scenarios were attempted**. The initial optimized attempt passed 16 and failed 33. Recovery passed 23, failed 6, and left 4 interrupted/unstarted cases when repeated maintenance CPU failures prompted a deployment. The final index-fix rerun covered all 10 unresolved cases: 9 passed and 1 failed. Across separate attempts, **49/49 scenarios have two complete, verified rounds**. The first four recovery cases ran separately; later work used up to two concurrent scenarios as requested. Parallel timings share traffic and cannot be compared to the isolated baseline. These attempts span different deployments and loads; they are not a single clean 49-case run. The remaining concurrent timeout received an isolated recheck: 1/1 passed; its separate results appear below.

## Changes deployed

- Read-only bucket resolution skips write/quota accounting while retaining key, membership, ancestry and drive-scope checks. Worker key-use tracking runs through waitUntil; Node/test callers retain the awaited fallback.
- Listings resolve up to eight manifests concurrently for the exact listed versions, preserving order, pagination and ETags.
- Ordinary CDC uploads grow from 256 KiB and overlap up to four stores with at most 16 MiB queued upload bytes. Golden chunk boundaries are preserved; failed stores settle before return and never commit an object.
- Downloads prefetch one shard, forward partial-shard ranges, validate range headers and truncation, and cancel unused reads.
- Follow-up: known-length Worker GET responses use FixedLengthStream, so the wire advertises Content-Length and short streams reject. R2 internal connectivity error 10001 returns retryable 503; checksum/input errors remain 400.
- Maintenance fix: key-first indexes make branch-visibility shadow checks use row-key lookups rather than repeated full reference scans. Existing databases install the indexes when their authority restarts; fork boundaries and history are covered by regression checks.
- Benchmark requests use an explicit pooled HTTPS agent, real deadlines, exact byte/SHA-256 verification and exact UUID-root cleanup.

## Fresh baseline comparison

Both runs used the same Space drive and host, explicit pooled HTTPS agent, two rounds, three warmups per round, eight measured samples and concurrency eight for ordinary cases. Fanout cases use their stated counts and concurrency. The reported figure is the median of the two round medians. Server caches and network conditions were uncontrolled.

Baseline deadline was 120 seconds; the optimized and recovery deadlines were 300 seconds. Successful timings can be compared, but completion with the longer deadline does not demonstrate reliability at 120 seconds. Baseline PUT 32/64 MiB failed and have no valid medians. The historical November 3 experiment is not used to claim speedups.

| Scenario | Baseline | Initial optimized | Latency change |
|---|---:|---:|---:|
| get 4 KiB | 2.478 s | 1.320 s | -46.7% |
| put 4 KiB | 5.206 s | 4.408 s | -15.3% |
| get 1 MiB | 2.595 s | 1.423 s | -45.2% |
| put 1 MiB | 5.126 s | 4.936 s | -3.7% |
| get 32 MiB | 20.485 s | 21.278 s | +3.9% |
| get 64 MiB | 43.676 s | 38.328 s | -12.2% |
| range 64 KiB of 64 MiB | 2.309 s | 1.658 s | -28.2% |
| head | 2.050 s | 0.765 s | -62.7% |
| list 200 keys | 11.035 s | 8.159 s | -26.1% |

Negative changes mean lower latency.

## All 49 scenarios

| Scenario | Initial attempt | Recovery attempt | Verified median, initial / recovery |
|---|---|---|---:|
| get 4 KiB | passed | not repeated | 1.320 s / — |
| put 4 KiB | passed | not repeated | 4.408 s / — |
| get 1 MiB | passed | not repeated | 1.423 s / — |
| put 1 MiB | passed | not repeated | 4.936 s / — |
| get 32 MiB | passed | not repeated | 21.278 s / — |
| put 32 MiB | failed | passed (serial) | — / 50.109 s |
| get 64 MiB | passed | not repeated | 38.328 s / — |
| put 64 MiB | failed | passed (serial) | — / 116.264 s |
| overwrite 4 KiB | passed | not repeated | 4.573 s / — |
| overwrite 1 MiB | passed | not repeated | 6.255 s / — |
| multipart put 64 MiB × 8 MiB | passed | not repeated | 63.726 s / — |
| stream get 64 MiB | passed | not repeated | 41.384 s / — |
| multipart put 256 MiB × 16 MiB | failed | passed (serial) | — / 220.429 s |
| stream get 256 MiB | passed | not repeated | 161.699 s / — |
| range 64 KiB of 64 MiB | passed | not repeated | 1.658 s / — |
| head | passed | not repeated | 0.765 s / — |
| list 200 keys | passed | not repeated | 8.159 s / — |
| rename 64 MiB | failed | passed (serial) | — / 2.944 s |
| move dir 200 × 64 KiB | passed | not repeated | 2.494 s / — |
| fanout get 1000 × 4 KiB, 32 at once | passed | not repeated | 1.791 s / — |
| fanout put 1000 × 4 KiB, 32 at once | failed | passed (parallel) | — / 14.005 s |
| fanout get 1000 × 4 KiB, 64 at once | failed | passed (parallel) | — / 7.460 s |
| fanout put 1000 × 4 KiB, 64 at once | failed | passed (parallel) | — / 29.387 s |
| fanout get 200 × 256 KiB, 32 at once | failed | passed (parallel) | — / 7.907 s |
| fanout put 200 × 256 KiB, 32 at once | failed | passed (parallel) | — / 15.354 s |
| append 4 KiB to 1 MiB | failed | passed (parallel) | — / 6.742 s |
| truncate 4 KiB, end of 1 MiB | failed | passed (parallel) | — / 6.869 s |
| write at 4 KiB in 1 MiB | failed | passed (parallel) | — / 16.580 s |
| patch 16 × 4 KiB in 1 MiB | failed | passed (parallel) | — / 15.387 s |
| insert 4 KiB, start of 1 MiB | failed | passed (parallel) | — / 4.346 s |
| insert 4 KiB, middle of 1 MiB | failed | passed (parallel) | — / 4.459 s |
| delete 4 KiB, start of 1 MiB | failed | passed (parallel) | — / 4.893 s |
| delete 4 KiB, middle of 1 MiB | failed | passed (parallel) | — / 4.946 s |
| append 4 KiB to 32 MiB | failed | passed (parallel) | — / 4.750 s |
| truncate 4 KiB, end of 32 MiB | failed | failed (parallel) | — / — |
| write at 4 KiB in 32 MiB | failed | passed (parallel) | — / 5.931 s |
| patch 16 × 4 KiB in 32 MiB | failed | failed (parallel) | — / — |
| insert 4 KiB, start of 32 MiB | failed | passed (parallel) | — / 4.431 s |
| insert 4 KiB, middle of 32 MiB | failed | failed (parallel) | — / — |
| delete 4 KiB, start of 32 MiB | failed | passed (parallel) | — / 5.110 s |
| delete 4 KiB, middle of 32 MiB | failed | failed (parallel) | — / — |
| append 4 KiB to 64 MiB | failed | passed (parallel) | — / 5.220 s |
| truncate 4 KiB, end of 64 MiB | failed | interrupted (parallel) | — / — |
| write at 4 KiB in 64 MiB | failed | passed (parallel) | — / 6.221 s |
| patch 16 × 4 KiB in 64 MiB | failed | not_run (parallel) | — / — |
| insert 4 KiB, start of 64 MiB | failed | failed (parallel) | — / — |
| insert 4 KiB, middle of 64 MiB | failed | not_run (parallel) | — / — |
| delete 4 KiB, start of 64 MiB | failed | failed (parallel) | — / — |
| delete 4 KiB, middle of 64 MiB | failed | not_run (parallel) | — / — |

Only complete, verified rounds receive final medians. Raw JSON preserves partial rounds and their errors; the CSV labels every attempt. Samples from separate attempts are never combined.

## Failures and diagnosis

The initial run passed 16 cases before a connection/DNS interruption. PUT 32 MiB failed with EPIPE in its second measured round; PUT 64 MiB encountered an R2 10001 connectivity error during its second warmup round. Multipart PUT 256 MiB completed eight measured uploads but one verification GET returned 218,910,720 of 268,435,456 bytes. Rename 64 MiB failed with AbortError. Fanout PUT 1000 at concurrency 32 completed one round, then 32 verification timeouts. The remaining 28 scenarios failed immediately with ENOTFOUND, and cleanup failed during the same outage. Those immediate failures are not useful latency measurements.

Completed PUT 32 MiB server traces returned 200 without Worker exceptions, up to 26.106 seconds wall time and 712 ms CPU, while one client upload took 155.249 seconds. This does not identify the cause of the failed request. Both 256 MiB streaming GET rounds passed byte/digest checks. IPv4 and IPv6 one-MiB range probes both passed; no address-family change was made.

Archived multipart diagnosis: a fixed-version 256 MiB object read in 16 MiB ranges matched the failed verification's expected SHA-256. Its first 218,910,720 bytes also matched the original received hash. Full stored bytes were correct for that object. The underlying response interruption remains unproved; FixedLengthStream prevents a short Worker response from being accepted as a successful body.

Recovery failed, interrupted, and unstarted cases:

- **truncate 4 KiB, end of 32 MiB**, status failed, phase verify: {"name":"AggregateError","causes":[{"name":"AbortError","code":"ABORT_ERR"},{"name":"AbortError","code":"ABORT_ERR"},{"name":"AbortError","code":"ABORT_ERR"},{"name":"AbortError","code":"ABORT_ERR"},{"name":"AbortError","code":"ABORT_ERR"},{"name":"AbortError","code":"ABORT_ERR"},{"name":"AbortError","code":"ABORT_ERR"}]}.
- **patch 16 × 4 KiB in 32 MiB**, status failed, phase warmup: {"name":"S3SDKError","code":"ServiceUnavailable","status":500,"requestId":"846d118b-377a-45ef-9356-2d948b9d9dbc"}.
- **insert 4 KiB, middle of 32 MiB**, status failed, phase warmup: {"name":"Error","status":502}.
- **delete 4 KiB, middle of 32 MiB**, status failed, phase warmup: {"name":"S3SDKError","code":"ServiceUnavailable","status":503,"requestId":"9612fc4f-6b07-48c3-b87f-0d3b3fd18560"}.
- **truncate 4 KiB, end of 64 MiB**, status interrupted, phase warmup: {"name":"InterruptedForCpuBudgetDeployment"}.
- **patch 16 × 4 KiB in 64 MiB**, status not_run, phase not_started: null.
- **insert 4 KiB, start of 64 MiB**, status failed, phase warmup: {"name":"S3SDKError","code":"ServiceUnavailable","status":503,"requestId":"59a7a23f-3788-498c-b20c-5fc47d0f5de7"}.
- **insert 4 KiB, middle of 64 MiB**, status not_run, phase not_started: null.
- **delete 4 KiB, start of 64 MiB**, status failed, phase warmup: {"name":"S3SDKError","code":"ServiceUnavailable","status":503,"requestId":"688af4e3-8b2f-44f6-85ff-34d7ea6377cc"}.
- **delete 4 KiB, middle of 64 MiB**, status not_run, phase not_started: null.

## Maintenance failure and final repair

DriveAuthority alarms repeatedly exhausted the default 30-second CPU limit, alongside foreground failures. Raising the CPU budget to 300 seconds was insufficient: an alarm used about 186 seconds CPU before termination, and both cleanup retries returned 503. The default 30-second CPU budget was restored with the index fix.

A local SQLite reproduction found one reference-index scan per visible row. With 10,000 synthetic references, the same count took 4.5813 seconds before a key-first index and 0.0064 seconds afterward. This is a synthetic query measurement, not a hosted speedup claim. The regression checks row-read counts and index installation after eviction.

The same previously failing scheduled alarm completed on the index-fix deployment in 6.332 seconds wall time and 2.819 seconds CPU, inside the restored 30-second CPU budget. This is one successful maintenance invocation, not a scalability guarantee. After the key-first index deployment, both exact benchmark trees were removed and verified absent in about nine seconds. The earlier failed cleanup evidence remains attached. Snapshot/export and GC work still share per-invocation limits; further history growth remains a scaling concern.

| Final rerun scenario | Status | Verified median |
|---|---|---:|
| truncate 4 KiB, end of 32 MiB | passed | 3.805 s |
| insert 4 KiB, middle of 32 MiB | passed | 5.201 s |
| truncate 4 KiB, end of 64 MiB | failed | — |
| insert 4 KiB, start of 64 MiB | passed | 3.144 s |
| delete 4 KiB, start of 64 MiB | passed | 3.686 s |
| patch 16 × 4 KiB in 32 MiB | passed | 21.893 s |
| delete 4 KiB, middle of 32 MiB | passed | 4.231 s |
| patch 16 × 4 KiB in 64 MiB | passed | 20.582 s |
| insert 4 KiB, middle of 64 MiB | passed | 4.628 s |
| delete 4 KiB, middle of 64 MiB | passed | 4.159 s |

Final rerun failure: **truncate 4 KiB, end of 64 MiB**, phase warmup: {"name":"AbortError"}. No final median is assigned to this case.

Final rerun cleanup: All Index-fix recovery benchmark trees verified absent; no incomplete multipart uploads; retained history/shards may still consume quota.

## Isolated timeout recheck

Only the case still failing in the final concurrent batch was repeated, after both workers finished, on the same deployment with the same rounds, warmups, samples and 300-second deadline. This recheck tests persistence without a second scenario; it does not prove what caused the earlier timeout.

| Scenario | Status | Verified median |
|---|---|---:|
| truncate 4 KiB, end of 64 MiB | passed | 3.606 s |

Isolated recheck cleanup: Benchmark tree soft-deleted and verified absent; no incomplete multipart uploads; immutable history and retained shards may still consume quota.


The diagnostic capture includes 7 truncate-verification GETs near the 300-second deadline, with 4 Worker records reporting ‘Network connection lost.’ CPU time for these requests was at most 113 ms. These observations coincide with client cancellation and do not establish its cause. The capture began after the earlier long warmup. Data-plane timings include all Space-drive traffic during the window; sanitized trace metadata is attached.


## Final 256 MiB streaming check

Separate response-framing-deployment check: passed; verified median 175.674 s; cleanup: passed after cleanup recovery; original failure preserved. This extra check ran alongside another scenario during the two-worker recovery workload, with the same rounds, samples and deadline. Its timestamps belong to the enclosing worker run; per-case timestamps were not collected.

## Deployments and validation

Baseline commit: 1fc3125d77fea2569ca71d24c58465c34988e02d. Deployments use the uncommitted working tree. Separate initial/final patches and source SHA-256 files identify the two optimized versions; unrelated web edits were excluded.

| Worker | Baseline | Initial optimized | Recovery | Final index fix |
|---|---|---|---|---|
| api | 3850c695-7a11-47d2-a79a-0f15423b84ef | 9091b01f-3df7-43e8-b730-43c557206edc | 9091b01f-3df7-43e8-b730-43c557206edc | 9091b01f-3df7-43e8-b730-43c557206edc |
| s3 | 54e96eea-1211-45c4-bd8c-353fdd02410f | d13a5239-f5c0-4797-a301-3a72f7fe4d65 | f485c16d-5ce6-41e7-878f-a277a6670c8d | f485c16d-5ce6-41e7-878f-a277a6670c8d |
| dataPlane | 4525e6a7-cb28-4207-b088-d69da709bcf6 | 4525e6a7-cb28-4207-b088-d69da709bcf6 | 7058a6df-6229-44de-a74e-e483f00e4342 | 397c83ad-807a-4f79-9260-34f9d07b2f85 |
| web | 136c03b9-8dd0-4cbb-9288-825e1cd5a77e | 136c03b9-8dd0-4cbb-9288-825e1cd5a77e | 136c03b9-8dd0-4cbb-9288-825e1cd5a77e | 136c03b9-8dd0-4cbb-9288-825e1cd5a77e |

Production settings were preserved with --keep-vars. Final checks: API typecheck and 133 tests; gateway and Node ingress typechecks; gateway 131 tests; data-plane typecheck and 135 tests with one worker; benchmark-helper 10 tests. Two five-second data-plane tests timed out in parallel runs, then the full serial suite passed without deadline changes. A real signed 128 MiB socket upload passed the 256 MiB RSS-growth cap (191,174,392 bytes growth). The final index-fix build and updated real Worker/D1/Durable Object/R2-emulation integration gate passed all 34 checks, including concurrent 32/64 MiB exact hashes, nested uploads, SDK edits, rename, permissions and quota. Injected R2-failure and short-stream regression tests passed. The post-deployment signed range framing check is attached.

## Cleanup and limits

Baseline cleanup: Benchmark tree soft-deleted and verified absent; no incomplete multipart uploads; immutable history and retained shards may still consume quota.

Initial recorded cleanup: failed: Error. Recovery of that cleanup: passed; tree verified absent: True; incomplete multipart uploads: 0.

Combined recovery cleanup: All worker benchmark trees verified absent; no incomplete multipart uploads; interrupted serial tree cleanup also passed; retained history/shards may still consume quota.

The approved temporary key was restricted to the Space drive and revoked after cleanup. A signed HEAD using the revoked credential was rejected. Local credentials, signed curl configuration and key-creation screenshots were deleted after scanning published artifacts for both credential values; private tail logs were redacted.

No desktop/SMB or deliberately cold-cache measurements were run. Live network/cache conditions vary; 16 samples per ordinary scenario do not establish tail-latency guarantees. Soft deletion removes benchmark folders from the live tree; immutable history and retained shards may still consume quota. Listings still need one manifest lookup per file. Source changes remain uncommitted and unpushed.
