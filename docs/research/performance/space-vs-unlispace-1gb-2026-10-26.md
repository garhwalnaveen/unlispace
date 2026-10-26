# Space vs Unlispace: 1 GB Mac transfer benchmark

26 October 2026. All times are measured on this Mac; start times below use Asia/Kolkata.

**Space won the upload comparison in this run. Neither app passed its first isolated native cloud retrieval.** Both uploads eventually drained, but native reads encountered I/O failures. Space's cache-assisted recovery returned the complete file and passed SHA-256. Unlispace's remaining HTTP/CLI verification was cancelled when the user requested a 50 MB benchmark; this cancellation is not an application failure.

This is a comparison of the actual installed configurations, **not a matched release-build experiment**. Unlispace's engine is a debug build, the SMB signing settings differ, the Mac changed power conditions, and host network traffic was not isolated. These results must not be generalized to every workload or to an optimized production Unlispace build.

## Test conditions

| Item | Recorded condition |
|---|---|
| Hardware | Apple M4 MacBook Air, 16 GiB RAM (`Mac16,12`) |
| Operating system | macOS 26.5.1 |
| Space | App 0.2.407 / build 407; shipped engine; retained-v1 SMB mount |
| Unlispace | App 0.2.0 / build 1; engine 0.0.1; SMB mount |
| Engine profile proof | Installed Unlispace daemon and `engine/target/debug/ulsd` have matching Mach-O UUID `DAFFA86A-5874-39A9-B2DC-9D342C03EB29` |
| File size | Exactly **1,000,000,000 bytes**: 1 GB decimal, about 953.67 MiB; not 1 GiB |
| Contents | Generated with `os.urandom`; ordinary allocated file; no zero-filled or sparse-file shortcut |
| File name | `performance-comparison-20261026-1GB-87be52a6.bin` in each account's existing Space-named drive |
| Transfer order | Space upload and native reads, then Unlispace upload and first native read; isolated downloads afterward, sequentially |
| Power | Initial copies on battery with Low Power Mode enabled; AC power observed later; AC cached-read and isolated-download phases identified separately |
| Network | Existing connection; no bandwidth shaping introduced; host traffic and internal retries not isolated |
| Space bandwidth | Existing Default/adaptive setting retained |
| SMB | Both SMB 3.1.1; encryption off; Unlispace reports `SIGNING_REQUIRED` and `SIGNING_ON`; Space does not report signing on |

Source SHA-256:

```
87be52a6d162727f43e0b4482fe136a0b0c68cd572a07128b931ba5b6f7e49ad
```

Copies used 4 MiB unbuffered Python reads/writes and an explicit `fsync`, followed by close. Reads stream to SHA-256 rather than producing another 1 GB native-download copy. Read times include hashing. There are no simultaneous benchmark transfers from the two apps.

## Upload results

| Measurement | Space | Unlispace |
|---|---|---|
| Copy started | 10:43:38 IST | 11:03:36 IST |
| Local copy + sync + close returned | 5.76 s, success | 688.38 s, `Bad file descriptor` |
| File size after local copy | 1,000,000,000 B | 1,000,000,000 B, verified by separate reopen probe |
| Last observation still pending | 1175.14 s | 2164.20 s |
| First observation queue empty | 1180.21 s | 2169.27 s |
| Effective GB / queue-drain duration | 0.847 MB/s | 0.461 MB/s |
| Independent cloud metadata | Legacy history command returned `[]`; it does not prove persistence | Final remote stat confirmed 1,000,000,000 B, version `v_01M5VD8FFBNF0AFM93TE8V2RRS` |

Space's queue drained approximately **1.84 times faster**. A queue-drain observation is bounded by the preceding pending sample, not a precise server commit timestamp. The first Space read and the isolated cloud read are separate checks of data, below.

The Unlispace local-copy result is an error, not a successful throughput result. A separate zero-write probe reopened the generated file, confirmed its full size and successfully called `fsync`; **close returned errno 9 again**. Publication later drained despite that close error. There was no retry upload that could benefit from deduplication.

## Retrieval and integrity

| Measurement | Space | Unlispace |
|---|---|---|
| First post-upload native read | 5.31 s; 188.27 MB/s; SHA-256 passed | Failed after 143.57 s: `OSError(6, 'Device not configured')` |
| AC cached native reads | median 0.440 s / 2275.27 MB/s; 3 successful trials | Unavailable |
| Isolated native cloud retrieval | Failed after 515.57 s; 973,078,528 B read: `{'errno': 5, 'message': '[Errno 5] Input/output error'}` | Failed after 1132.99 s; 616,562,688 B read: `{'errno': 6, 'message': '[Errno 6] Device not configured'}` |
| Cache-assisted native recovery | 30.23 s; 33.09 MB/s; SHA-256 passed | First remount attempt is the failed isolated read above |
| Separate HTTP/CLI diagnostic fallback | Not used for the native comparison | Cancelled after 485.94 s when user requested 50 MB; excluded from failure counts |

The isolated native Space read failed after 973,078,528 B, with read and close errno 5 (`Input/output error`). Its peer log also recorded an authorization-refresh timeout. Restarting that same read-only peer while retaining its downloaded cache later produced a full 1 GB read in 30.23 s with a matching SHA-256. **This is recovery using an already-populated cache, not 33 MB/s fresh-cloud throughput.**

Unlispace's isolated remount read failed after 616,562,688 B and 1,132.99 s: read errno 6 (`Device not configured`) and close errno 60 (`Operation timed out`). Partial hashes are not classified as corruption; neither failed read obtained all bytes.

The original Space read received only about 33 KB on the external interface while reading 1 GB, so it is a **cached** result. Its very high repeated-read speed is not Internet download speed.

Cold-data isolation:

- Space: a new read-only retained-v1 SMB peer with a fresh state directory and empty cache, using the existing account and bucket. It uses the existing 20 GiB budget. Preparation/authentication/bootstrap time is recorded separately from the read.
- Unlispace: after the journal drains, use the exact final benchmark manifest to set aside only its shard cache objects, unmount and remount the same drive to invalidate kernel and client caches, and read through SMB with the original signing settings. Restore or verify every set-aside shard afterward. No unrelated cache entries are selected.
- Every successful full read must return exactly 1,000,000,000 bytes and match the source SHA-256. Partial reads and exceptions do not pass.

The first Unlispace read failed with `Device not configured` after 143.57 s. The kernel mount and daemon mount listing were still present afterward. This is a user-facing native retrieval failure, not a demonstrated checksum mismatch.

## Engine resource cost during upload

CPU time comes from process counters spanning the upload observation window. One core at full utilization is 100%. RSS is sampled resident memory, not physical memory attributable exclusively to that process.

| Engine measurement | Space | Unlispace |
|---|---:|---:|
| Engine CPU seconds | 102.41 | 705.16 |
| Mean utilization over queue-drain window | 8.68% of one core | 32.51% of one core |
| Sampled peak RSS | 323.20 MiB | 127.39 MiB |

| Isolated native-read attempt engine cost (both incomplete) | Space | Unlispace |
|---|---|---|
| CPU and sampled memory | 32.43 CPU s; 6.29% of one core; peak 343.73 MiB RSS | 475.45 CPU s; 41.96% of one core; peak 179.16 MiB RSS |

Two Unlispace GUI builds were open, so engine costs are reported separately. Space search/Finder helpers and both GUI processes are retained in raw samples but excluded from this engine-only table.

Three-second Unlispace process samples during writing and isolated native reading showed a prominent active stack in SMB signature verification and software AES (`verify_request_signature` → `compute_mac_zeroed_signature` → `aes::soft::fixslice`). Journal serialization also appears. This supports a CPU-bound local write path in this debug configuration; it does not quantify the improvement from release optimization or hardware AES, which were not tested.

Space's upload logs contain chunk timeout/transport retries, stall reports, prepared-GET deadline failures and an object-storage `ServiceUnavailable` error. The UI reached 100% while still showing Saving and while the upload queue remained occupied. Local-copy completion, byte progress and publication completion are different milestones.

The initial Space peer launch omitted its mandatory explicit disk budget and exited before mounting. It was retried with the same 20 GiB budget as the installed app. That harness setup error is excluded from performance and app failure counts. The measured Space cold read used read-only mode; the original app's mount was writable, so its authorization/refresh behavior may differ.

## Measurement limits

- One upload per service, fixed order, different accounts/backend deployments and existing plan/region settings. No statistically general cloud-speed winner follows from one trial.
- A shipped release and a debug daemon, plus different signing behavior, are not matched implementations. No security settings were weakened to improve a score. Space's isolated peer was read-only; Unlispace was remounted with its original writable configuration.
- Battery Low Power Mode and later AC operation differ. Compare the explicitly AC phases for matched-power cached reads and isolated downloads; upload end-to-end durations span the observed conditions.
- External-interface counters include unrelated applications. They are not exact app-attributable network bills or upload amplification figures. Substantial incoming traffic occurred during an upload; these counters cannot separate internal reads/retries from unrelated host traffic.
- The original Unlispace read harness did not retain a partial-byte count on error. The isolated retries record partial bytes and separate read/close errors.
- The first idle sample overlapped the initial Space copy and is excluded from idle conclusions. A clean idle sample is repeated at the end when available.
- Timing of the first block refers to a 4 MiB read, not first-byte latency. Sampling may miss transient RSS peaks.
- No many-small-file test, directory-tree benchmark, concurrent-client stress, random-I/O sweep, offline fault injection, server-side profiling, or energy-per-GB measurement was performed in this 1 GB transfer baseline.

## Follow-up priorities

1. Reproduce Unlispace's close error and native mount failure and verify file-handle and long-read behavior.
2. Repeat on a release-built Unlispace engine with the same power/network conditions. Preserve signing and use the CPU sample to investigate software-AES cost.
3. Profile large-file publication/chunk staging separately from SMB acceptance, including the effects of publishing a growing file and version/commit latency.
4. For Space, investigate the observed storage timeout/retry path and the long Saving phase; the fast local copy did not predict cloud completion.

## Evidence and retained state

Raw JSON, process samples, scripts and logs are under `mac/.build/performance-2026-10-26/` (ignored build artifacts). The concise machine-readable export is `comparison-results.json` there. The benchmark uses generated data only. Existing application/source edits and personal files are preserved. No app implementation, remote configuration, credentials, permissions or security setting was changed by this benchmark.

The generated source file was hashed and removed locally to preserve disk reserve; its SHA-256 and exact source chunk inventory remain. The cloud benchmark files are retained in both drives. Temporary peer mounts and cache backups are verified and cleaned after the tests; final cleanup status is recorded separately.
