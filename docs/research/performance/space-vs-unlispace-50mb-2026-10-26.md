# Space vs Unlispace — 50 MB performance comparison

26 October 2026. **Winner for transfer speed in this run: Space.** Both uploaded fixtures were retrieved in full through fresh native SMB mounts and passed SHA-256 verification, with no write, sync, close or read errors in the final run.

This compares the current installations. **Space uses a shipped release; Unlispace uses a debug engine and requires SMB signing.** It is not a matched release-build comparison or a general verdict about the architectures.

## Results

| Measurement | Space | Unlispace | Interpretation |
|---|---:|---:|---|
| Local write + fsync + close | 0.76 s | 37.17 s | Space 48.6× faster |
| File left upload queue, from copy start | 39.40 s | 96.24 s | Space 2.44× faster |
| Effective upload rate over that interval | 1.27 MB/s | 0.52 MB/s | Includes local acceptance and publication delay |
| Cold-data native retrieval + SHA-256 | 10.51 s | 66.60 s | Space 6.34× faster |
| Cold-data read throughput | 4.76 MB/s | 0.75 MB/s | Both read exactly 50,000,000 bytes |
| Time to first 4 MiB block | 2.75 s | 7.41 s | Not first-byte latency |
| Fresh-mount/cache preparation | 6.03 s | 2.46 s | Recorded separately from data-read time |
| Preparation + cold read | 16.54 s | 69.07 s | Different preparation procedures, described below |
| Warm native read median, three trials | 0.055 s | 0.049 s | Cache speed; small timing difference is not a meaningful cloud-speed winner |
| Integrity | PASS | PASS | Exact byte count and identical source SHA-256 |

The per-file queue was still occupied at **37.34 s** for Space and **94.18 s** for Unlispace. The first empty observations above give upper bounds; publication occurred between those samples. These are file-queue observations, not exact server commit timestamps. Space's overall queue depth still showed background work at the first empty-file observation; its full data availability was independently confirmed by the fresh-cloud read. Both queues were empty at cleanup.

All throughput figures use decimal MB (1,000,000 bytes). Save speed and cloud publication are separate: a successful local `fsync` does not establish cloud completion.

## Setup and fairness

- MacBook Air M4 (`Mac16,12`), 16 GiB memory, macOS 26.5.1.
- Space 0.2.407 / build 407; Unlispace app 0.2.0 / build 1, engine 0.0.1.
- The installed Unlispace engine matches `engine/target/debug/ulsd` by Mach-O UUID `DAFFA86A-5874-39A9-B2DC-9D342C03EB29`. A release-engine comparison has not been run.
- Both use SMB 3.1.1. Unlispace reports signing required and active. Space's share does not report signing on. Encryption was off for both. Existing security and bandwidth settings were preserved; Space remained on Default/adaptive upload bandwidth.
- Exactly **50,000,000 bytes** per file: 50 MB decimal, approximately 47.68 MiB. Generated using `os.urandom`, allocated normally, with incompressible data and a new content hash for this run.
- Same exact source bytes uploaded sequentially to both apps' existing drives; no simultaneous benchmark transfers. Different service accounts, regions and backend deployments were not equalized.
- Space upload started at 13:10:22 IST; Unlispace at 13:11:20 IST. Both phases ran on battery; the battery profile was configured for Low Power Mode. Battery was 69% when the final run began, 67% at cleanup. That change is not an app-specific energy measurement.
- `caffeinate -di` held temporary idle/display-sleep assertions for the final run and exited with the runner. Maximum upload observation gaps were 2.10 s and 3.25 s. No sleep-sized gaps occurred. Read/write wall durations also matched monotonic durations within 0.1 s.

An earlier 50 MB run was interrupted by **clamshell sleep**, including a 1,015-second observation gap. Its upload timings are excluded. This final repeat used a new filename and fresh random content to avoid upload deduplication from that attempt.

Fixture name in each drive: `performance-comparison-20261026-50MB-awake.bin`.

SHA-256:

```
85d955e73778e989dbdbb58b65e2c24ab91a0766ac9f347568ce254509033b1d
```

## What the timings include

The copy uses 4 MiB unbuffered writes, an explicit `fsync`, then close. Space spent 0.014 s in the write loop and 0.750 s in `fsync`; Unlispace spent 0.083 s and 37.074 s respectively. Most of Unlispace's save delay was in synchronization, rather than accepting bytes into the macOS write cache.

A native read streams the entire file into SHA-256, avoiding another downloaded-file copy on local disk. Its time includes hashing and close. Both full reads returned the exact source hash. This is data retrieval through the mounted filesystem, not an application launch or Finder UI-response benchmark.

Cold-data preparation:

- **Space:** a separate read-only retained-v1 SMB peer, using the installed engine and existing account, with an empty independent state/cache and the same 20 GiB disk budget. It fetched the file from cloud storage and was unmounted afterward. This read-only peer differs from the original writable app mount, which limits generalization about authorization or renewal behavior.
- **Unlispace:** with uploads drained, preserve only cache objects named in the exact benchmark manifest, unmount/remount the drive to invalidate kernel/client caches, and read with the original signing configuration. All 20 manifest shards were absent from the disk cache before mounting. Restore or verify any preserved cache objects afterward. Other files' cache entries were untouched.

Cached repeats, in seconds:

| Trial | Space | Unlispace |
|---|---:|---:|
| 1 | 0.268 | 7.663 |
| 2 | 0.053 | 0.049 |
| 3 | 0.055 | 0.043 |

All repeats passed integrity. The variable first repeat and near-memory-speed later reads show why cached reads should be reported separately from cloud retrieval. Three repeats do not establish a statistically robust cache-performance ranking.

## CPU and memory

These are **filesystem-engine** process measurements, not whole-application energy or total app-family memory. GUI/search/Finder helper samples are retained in the raw data. Two Unlispace GUI builds were open and are excluded from these engine comparisons.

| Measurement | Space | Unlispace |
|---|---:|---:|
| Engine CPU time over upload window | 3.58 CPU s | 38.05 CPU s |
| Mean upload-window utilization | 9.1% of one core | 39.5% of one core |
| Sampled peak upload RSS | 683.8 MiB | 75.2 MiB |
| Engine CPU time during cold read | 1.37 CPU s | 47.42 CPU s |
| Mean cold-read utilization | 12.8% of one core | 71.1% of one core |
| Sampled peak cold-read RSS | 167.7 MiB | 101.1 MiB |

Unlispace used more engine CPU, but had lower sampled RSS. **Do not treat the RSS peaks as a matched-lifecycle memory ranking:** Space's engine stayed running through the earlier stress tests, while Unlispace's engine was restarted to cancel the prior long-running CLI download. RSS also includes mapped/shared pages and sampling can miss peaks.

Earlier CPU samples showed SMB signature verification/creation and software AES on Unlispace's active I/O stacks. Its debug profile and active signing are material differences. Measure a release engine under equivalent security/power conditions before attributing the gap to architecture. No signing protections were weakened for this benchmark.

## Interpretation and limits

Space is faster for the measured 50 MB save, publication and cold-data read in the current configurations. **Both apps succeeded at 50 MB**, so the earlier large-file failures should not be generalized to every transfer.

This is one new-file upload and one isolated read per app, fixed order, on the current connection. It does not measure sustained large-file behavior, many-small-file performance, random I/O, concurrent clients, offline recovery, app startup, energy per GB or server-side latency breakdown. Interface byte counters contain internal retries/reads and possible unrelated traffic; they are not used as exact app bandwidth or storage bills.

The earlier [1 GB stress test](space-vs-unlispace-1gb-2026-10-26.md) is separate evidence. It encountered native I/O failures; Space eventually passed a cache-assisted full-file recovery. The remaining Unlispace CLI verification was **cancelled when the user changed the requested size to 50 MB**, and that cancellation is not counted as an application failure.

## Artifacts and cleanup

- [Machine-readable results](space-vs-unlispace-50mb-2026-10-26.json) include byte counts, hashes, timings, queue bounds, resource costs and binary hashes.
- Raw samples/scripts: `mac/.build/performance-50mb-awake-2026-10-26/`. Earlier interrupted and stress runs remain in their separate directories.
- Temporary peer mounts and generated peer payload caches were removed. Unlispace cache backups were restored/verified. About 2.06 GB of generated temporary local payloads across the attempts was removed.
- Original mount states restored: Space unmounted; Unlispace mounted and idle, zero pending operations/uploads. Temporary sleep assertions ended with the benchmark.
- Generated benchmark files remain in both cloud drives. Existing personal files, permissions, credentials, app implementations and deployment settings were preserved.
