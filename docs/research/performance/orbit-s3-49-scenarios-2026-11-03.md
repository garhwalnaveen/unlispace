# Orbit hosted S3: 49-scenario benchmark

**All 49 scenario names were attempted. Only five yielded verified two-round timings.**

The other 44 rows failed verification, protocol handling, fixture setup, or transport. A targeted repeat of 37 transport-affected cases also failed. Many failures happened before a measured operation; they do not establish the speed or correctness of that operation. This is an incomplete, interrupted run, not a reliable full comparison with the supplied s3sdk article.

## Verified timings

| Operation | Orbit median |
|---|---:|
| get 4 KiB | 1.92 s |
| head | 1.49 s |
| get 1 MiB | 7.33 s |
| put 1 MiB | 10.38 s |
| put 4 KiB | 3.94 s |

## Failures and diagnostic limits

- Initial 32 MiB and 64 MiB GETs passed sequential warm-ups, then failed SHA-256 assertions in two and eight concurrent reads, respectively. The first harness did not retain their expected/actual digests or received lengths. These failures remain unresolved; storage corruption is not established.
- Some 200-key listing, directory-move, and fanout-read scenarios failed with `400 InvalidArgument` while uploading fixtures. Their named list/move/read operation was not measured.
- The 64 MiB rename returned HTTP 200 but the published SDK raised `InvalidResponse`; it did not yield a valid timing.
- Timeouts, EPIPE, ETIMEDOUT and DNS ENOTFOUND affected writes, multipart, streaming, edits and cleanup. The Mac reached 1% battery, had power/network interruptions, later charged, and returned to battery. One process disappeared without completing cleanup. Its completed results were preserved and only unattempted names resumed.
- The targeted 32 MiB PUT repeat completed one round before its second round failed. Its lone p50 remains in raw JSON and is not presented as a complete timing.

### Same-version read diagnostic

- sequential baseline: 33,554,432 bytes, SHA-256 `7158889ccf390c4ff43756ea52d7b160893d60a27b4eec445034111ca60d86c3`, 66.17 s.
- concurrent 1: 33,554,432 bytes, SHA-256 `7158889ccf390c4ff43756ea52d7b160893d60a27b4eec445034111ca60d86c3`, 133.95 s.
- concurrent 2: 33,554,432 bytes, SHA-256 `7158889ccf390c4ff43756ea52d7b160893d60a27b4eec445034111ca60d86c3`, 133.76 s.

These diagnostic reads request the same immutable version through signed HTTP. The original random source digest was lost with the process, so matching repeat digests cannot prove the original source was stored correctly. They also differ from the published SDK/concurrency-eight workload.

## Method

- Mac16,12, Apple silicon, 16 GiB RAM, macOS 27.0.1; Node 26.12.1. Client source commit `fde681a4baa8246d168368e6c905adaede7549d2`; this does not establish the deployed server revision.
- Hosted endpoint `https://unlispace-s3.naveen-f3d.workers.dev`; Luckas account, read/write key limited to the Space drive. Started 3 November 2026 at 06:42 IST. No deployments, billing or entitlements changed.
- Installed `@spacefs/s3sdk` 0.4.0 and AWS SDK 3.1156.0. Two rounds, three warm-ups per round, eight samples at concurrency eight. Fanout rows use the named 200/1,000 requests and concurrency 32/64. Median of round p50s.
- Bounded waves; setup and full-content verification outside measured waves. Random payloads, fresh data for measured whole-object writes. Multipart initiation, up to eight concurrent parts and completion are timed. Streaming includes SHA-256 hashing.
- No client content cache; server caches uncontrolled. No cold-cache or native macOS/SMB measurements. The pasted article omitted sample count and detailed scheduling; this harness reconstructs its 49 scenarios.
- The standard AWS SDK `requestTimeout` was warning-only. Explicit request/extension aborts do not establish one uniform body deadline. The published extension SDK can internally retry 503 responses even though the underlying AWS client uses maxAttempts=1.
- Historical AWS bare-bucket and s3sdk figures are retained as labelled reference data only. Different client, backend, network and cache behavior mean no Orbit speedup factors can be inferred.

## Every scenario

| Scenario | Result | Verified Orbit ms | Error(s) |
|---|---|---:|---|
| range 64 KiB of 64 MiB | failed/inconclusive | — | TimeoutError |
| get 4 KiB | passed | 1922.0 | — |
| move dir 200 × 64 KiB | failed/inconclusive | — | S3SDKError/InvalidArgument/400 |
| get 64 MiB | failed/inconclusive | — | AssertionError/ERR_ASSERTION |
| stream get 256 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| stream get 64 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| append 4 KiB to 64 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| head | passed | 1488.1 | — |
| truncate 4 KiB, end of 64 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| get 32 MiB | failed/inconclusive | — | AssertionError/ERR_ASSERTION |
| delete 4 KiB, middle of 64 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| insert 4 KiB, middle of 64 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| list 200 keys | failed/inconclusive | — | S3SDKError/InvalidArgument/400 |
| append 4 KiB to 32 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| rename 64 MiB | failed/inconclusive | — | S3SDKError/InvalidResponse/200 |
| delete 4 KiB, start of 64 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| insert 4 KiB, start of 64 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| write at 4 KiB in 64 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| fanout get 200 × 256 KiB, 32 at once | failed/inconclusive | — | TimeoutError/EPIPE; TimeoutError |
| truncate 4 KiB, end of 32 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| fanout get 1000 × 4 KiB, 32 at once | failed/inconclusive | — | S3SDKError/InvalidArgument/400 |
| write at 4 KiB in 32 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| delete 4 KiB, middle of 32 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| delete 4 KiB, start of 32 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| get 1 MiB | passed | 7331.9 | — |
| insert 4 KiB, middle of 32 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| insert 4 KiB, start of 32 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| fanout get 1000 × 4 KiB, 64 at once | failed/inconclusive | — | S3SDKError/InvalidArgument/400 |
| patch 16 × 4 KiB in 64 MiB | failed/inconclusive | — | Error/ENOTFOUND |
| patch 16 × 4 KiB in 32 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| append 4 KiB to 1 MiB | failed/inconclusive | — | TimeoutError |
| put 64 MiB | failed/inconclusive | — | TimeoutError/EPIPE; TimeoutError |
| put 32 MiB | failed/inconclusive | — | TimeoutError/EPIPE |
| delete 4 KiB, middle of 1 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| insert 4 KiB, middle of 1 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| patch 16 × 4 KiB in 1 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| delete 4 KiB, start of 1 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| write at 4 KiB in 1 MiB | failed/inconclusive | — | TimeoutError |
| insert 4 KiB, start of 1 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| put 1 MiB | passed | 10381.4 | — |
| multipart put 256 MiB × 16 MiB | failed/inconclusive | — | Error/ENOTFOUND; TimeoutError |
| overwrite 1 MiB | failed/inconclusive | — | TimeoutError/EPIPE; TimeoutError |
| put 4 KiB | passed | 3938.5 | — |
| truncate 4 KiB, end of 1 MiB | failed/inconclusive | — | TimeoutError |
| fanout put 1000 × 4 KiB, 32 at once | failed/inconclusive | — | TimeoutError/ETIMEDOUT; TimeoutError |
| fanout put 1000 × 4 KiB, 64 at once | failed/inconclusive | — | TimeoutError/ETIMEDOUT; TimeoutError |
| multipart put 64 MiB × 8 MiB | failed/inconclusive | — | AbortError; TimeoutError |
| fanout put 200 × 256 KiB, 32 at once | failed/inconclusive | — | TimeoutError/ETIMEDOUT; TimeoutError |
| overwrite 4 KiB | failed/inconclusive | — | TimeoutError |

## Cleanup and key

- `orbit-benchmark-e438ba06-bea5-4076-aada-36518b88913c/`: live benchmark folder and descendants removed; verified absent: True; 1 incomplete uploads aborted; multipart listing verified empty: True.
- `orbit-benchmark-60d0d348-2736-46ce-b1a0-a519743493dc/`: live benchmark folder and descendants removed; verified absent: True; 0 incomplete uploads aborted; multipart listing verified empty: True.
- `orbit-benchmark-1b3282f3-a004-4dab-8214-c5964f2112c1/`: live benchmark folder and descendants removed; verified absent: True; 0 incomplete uploads aborted; multipart listing verified empty: True.
- Key revocation: revoked; verified in Orbit access-keys UI.
- Deletes affect only generated run prefixes. Immutable historical versions and retained shards may still consume quota.

Raw attempts, timings, context and cleanup diagnostics are retained in the accompanying JSON files. The CSV has one row per scenario and labels historical figures as a different environment.
