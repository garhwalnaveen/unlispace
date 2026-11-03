# Orbit S3: 49-scenario benchmark preparation

Status on 3 November 2026: **hosted run in progress**, started at 06:42 IST.
The random 4 KiB publish/retrieve preflight passed.

First checkpoint: four scenarios passed; the 32 MiB GET failed SHA-256 verification
in two concurrent reads. Its sequential warm-ups had passed. The remaining scenarios
continue; the read failure is not published as a passing latency. Cause is not yet established.
A quiet completion check in this chat runs every 15 minutes to finish reporting and key revocation.

The deployed endpoint `https://unlispace-s3.naveen-f3d.workers.dev` responds with Orbit's
`x-uls-protocol: 1` header. The first signed-in workspace reported “Trial ended”.
At the user's request, switched to Luckas's Gmail account on 3 November; its workspace
shows three trial days remaining and 465.7 GiB capacity. It has no existing S3 keys.
A read/write key was created with only the Space drive selected after the user's explicit
confirmation. It will be revoked after the run. Billing, entitlements and deployments were not changed.

## Runner

[`tests/e2e/s3-benchmark.mjs`](../../../tests/e2e/s3-benchmark.mjs) implements all 49 scenario
names in the supplied “s3sdk against a bare bucket” table. It uses the already-installed
`@spacefs/s3sdk` 0.4.0 and AWS SDK 3.1156.0 against Orbit's S3 API. No additional packages
or product changes are required.

Keep a private JSON credentials file outside the repository, containing `endpoint`,
`bucket` (an existing writable Orbit drive ID or alias), `accessKeyId`, `secretAccessKey`,
and optionally `region` (default `us-east-1`). Run from the repository root:

```sh
node --test tests/e2e/s3-benchmark.test.mjs
node tests/e2e/s3-benchmark.mjs /absolute/private/credentials.json /absolute/path/results.json
```

After an interrupted pass finishes, retest only affected cases by appending their exact
scenario names, each as a separate quoted argument. Use a new results file: the original
attempts must remain intact. The default still runs all 49 cases. This selection support
was added while the first process was already running; it does not alter that process.

The runner first publishes and verifies a random 4 KiB probe. If it fails, no scenarios
run. Every object lives under a fresh UUID prefix. The runner saves results after every
round and scenario, includes failed rows, and returns a failing exit status for partial
results or cleanup failure. It never writes credentials into the report. Failed multipart
uploads are aborted. In-flight workers settle before cleanup starts.

Cleanup deletes only live objects inside the run's prefix. **Orbit retains immutable
versions and shards, which may continue consuming quota.** Use a dedicated benchmark
drive with enough free storage. A full run can transfer and retain many gigabytes; it
does not permanently purge any drive or change storage limits. An interrupted process
can leave generated objects behind; the report records their prefix.

## Measurement choices and limits

- Two rounds, three warm-up operations per round, eight measured operations at concurrency
  eight for ordinary rows. Fanout rows measure each of their 200/1,000 requests at the
  named concurrency. Requests run in bounded waves. The figure is the median of round p50s;
  raw sample latencies are retained. No retries. Extensions and explicit AWS command calls
  use 120-second abort signals; the standard SDK handler's 120-second `requestTimeout`
  is warning-only in the installed Smithy version. Full response bodies do not have a
  uniform hard deadline.
- The pasted article omits its measured sample count, patch offsets, range offset and
  detailed scheduling. Its relative methodology link could not be retrieved from
  `spacefs.com` (404). These are reconstructed workloads, not an execution of its original
  Rust harness. The eight samples per ordinary round are an explicit choice here.
- Inputs are random bytes. Whole-object measured writes use fresh content to avoid warm
  deduplication. Read fixtures are reused. Edits begin from the original content each time
  and preserve untouched shards. Setup and full SHA-256 verification run outside measured
  waves, so their network requests do not overlap measurements.
- Patch offsets are evenly spaced from zero through file-size minus 4 KiB. The 64 KiB
  range starts at 32 MiB. List fixtures contain 200 keys; move fixtures contain 200 files
  of 64 KiB. Multipart uploads use eight concurrent parts, including initiation and completion
  in the measured duration.
- Reads consume the complete response. Streaming reads include incremental SHA-256 in their
  measured duration; other reads are hashed afterward. Rename verifies destination bytes
  and source absence. Directory moves verify every destination file and source-prefix absence.
- The TypeScript client has no object-content cache. Orbit's server caches are uncontrolled;
  there is no honest equivalent to clearing the article's 512 MB in-process shard cache.
  No cold-cache figures are claimed.
- The client is this Mac and its current network, rather than the article's Google Cloud VM.
  There is no credentialed bare-bucket endpoint available for the same backing storage.
  The September AWS/s3sdk figures in the pasted article are historical context, not a
  matched baseline from which to claim Orbit speedup factors.
- This measures the hosted S3 API. It does not measure the native macOS app, SMB mounts,
  sustained throughput, p99 latency or production hardware limits.

Validation: five local tests cover the 49-case inventory, exact-name retest selection, edit byte oracle, median calculation,
concurrency limits, draining workers on failure, and refusal-before-workload behavior through
a real local HTTP socket. All 49 scenario names were also checked against the supplied table.
