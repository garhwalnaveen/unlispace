# Orbit S3 failure reproduction and fixes — 3 November 2026

Two product defects were identified: the deployed gateway lacked the published SDK's wire
aliases, and concurrent uploads of identical content repeatedly wrote the same R2 chunk.
Both fixes were backported onto the deployed gateway source. Hosted checks confirm SDK edits and the 200-key fixture workload pass;
temporary-key revocation is recorded below. The interrupted original
49-scenario measurements remain unchanged.

## What changed

- The benchmark now has a real 120-second deadline covering both response headers and the
  response body, rather than Smithy's warning-only `requestTimeout`. Local socket tests prove
  stalled headers and a stalled body are aborted.
- It checks the gateway's public SDK protocol header before sending any benchmark writes.
  An incompatible deployment is refused without attempting uploads or cleanup mutations.
- Content-verification failures preserve received/expected byte counts and both SHA-256
  digests. Original fixture digests, failure phases, completed samples from partial rounds,
  request IDs, bounded validation reasons and missing SDK header names are retained.
- The gateway no longer discards input-validation explanations from the data plane. Only
  string messages for `400 bad_request`/`bad_path` are forwarded, capped at 512 characters;
  authentication and server-error messages remain generic.
- The shared chunk upload path checks the existing per-drive missing-chunk API before
  uploading. On R2 error 10058, it waits one second and checks whether the competing upload
  stored the chunk; otherwise it returns retryable `503 SlowDown`. Other validation errors
  still fail. This covers ordinary PUTs, edits, copies and multipart chunk uploads.
- The real-service parity gate now covers 200 nested uploads at concurrency eight, the
  published SDK's write/patch/insert/remove/truncate/rename operations, and eight concurrent
  reads of both 32 MiB and 64 MiB random objects. Every read checks length and upload-source hash.

## Evidence

The isolated local Worker/D1/Durable Object/R2-emulation gate passed **34 checks, zero failures**:

```sh
E2E_API_ONLY=1 E2E_PARITY=1 E2E_API_PORT=28788 E2E_DATA_PORT=28787 \
E2E_S3_PORT=28789 E2E_INSPECTOR_PORT=29230 bash tests/e2e/run.sh
```

The three added parity checks all passed, including the eight-reader 32/64 MiB test.
The complete gateway suite passed **120 tests across 20 files**. Eight benchmark-helper
tests passed. Worker and Node-ingress TypeScript checks passed. The health-entry regression
also requires both `x-uls-protocol: 1` and `x-s3sdk-protocol: 1`.

Before deployment, the public hosted `/healthz` returned HTTP 200 and `x-uls-protocol: 1`, but **no
`x-s3sdk-protocol` header**. The current source sets both on that response. This establishes
a live protocol mismatch. Authenticated source inspection confirmed the old Worker version
predated SDK aliases.
The hardened runner was also checked against that live endpoint with dummy credentials:
it returned `IncompatibleGateway`, recorded zero scenario rows, and attempted no benchmark
writes. The result is saved in `orbit-s3-fixes-2026-11-03-live-preflight.json`.

Local R2 emulation did not reproduce the rate limit. After the validation-message fix,
eight directly signed hosted PUTs of the same random 4 KiB content to different file names
produced two `400 InvalidArgument` responses with:

```
upload failed: put: Reduce your concurrent request rate for the same object. (10058)
```

Those files resolve to the same content-addressed R2 chunk. This matches Cloudflare's
documented [10058 same-key write-rate error](https://developers.cloudflare.com/r2/api/error-codes/).
The original generic 400s lost their messages, so their exact causes cannot all be proved
retroactively. The same-content upload workload now has a demonstrated cause and fix.

The initial hosted 32/64 MiB hash assertions remain unproven. Eight concurrent reads of
both sizes pass locally against the downloaded deployed data-plane script and the patched
gateway, with exact upload-source hashes. A new hosted attempt failed during fixture
upload (`EPIPE`/deadline), before the large reads ran; it neither reproduced nor disproved
the original assertions. The earlier same-version read-consistency evidence is preserved.

## Deployment and targeted verification

- Original version: `b95cca6d-a15e-4b0a-adc1-49bcb97286ca` (29 October).
- Compatibility backport: `1ba1ade2-6b68-4008-b70b-43b17e02f09a`.
- Compatibility plus chunk-upload fix: `5a1a9277-4a10-4edc-ba3d-13dd4fabaae3`.
- Worker: `unlispace-s3`; endpoint: `https://unlispace-s3.naveen-f3d.workers.dev`.
- Existing `unlispace-api`/`unlispace-data-plane` service bindings, variables, secret bindings
  and `S3State` namespace were preserved. No API/data-plane deployment or migration ran.
- The deployed-source backport passed **24 focused unit tests** and **six isolated
  integration checks**, including 200 nested uploads, SDK edits/rename and eight concurrent
  32/64 MiB reads against the downloaded deployed data-plane script. R2 is emulated locally.
- Hosted health now returns both protocol headers. Hosted SDK write/patch/insert/remove/
  truncate/rename preserves `aBCde`, and the old source path returns 404.
- After the fix, all **200/200** hosted nested uploads passed at concurrency eight, and
  listing returned exactly 200 keys. A fresh identical-chunk race passed **8/8** directly
  signed PUTs and **8/8** SDK PUTs; previously the directly signed round had two R2 10058 errors.
- Each post-fix test prefix was verified absent after scoped soft-delete. Multipart listings
  were empty. The live deployment API confirms the final version serves 100% of traffic.

The backport patch, deployment metadata, before/after hosted JSON and test logs accompany
this report as `orbit-s3-fixes-2026-11-03-*`. It preserves legacy listing/history and size
semantics; broader release features and full SDK conformance were not deployed. A broader
SDK fork/deletion-history assertion exposed an existing legacy listing difference outside
the benchmark fix; it was excluded from the focused compatibility gate, not called a pass.

## Cleanup and limits

The original benchmark key remains revoked. The separately approved Space-only key
`Orbit S3 fix verification 2026-11-03` is temporary; final revocation is pending below.
Hosted test folders use a generated `orbit-fix-verification-<UUID>/` prefix and are
recursively soft-deleted through the existing scoped native API, with absence verified.
Immutable history can retain quota. Credentials are excluded from reports and deleted
after revocation.

These are correctness checks, not replacement latency measurements. No full 49-scenario,
cold-cache, native SMB or desktop rerun was performed. The earlier DNS/power interruptions
and new transport errors still prevent a complete hosted performance conclusion. No billing,
entitlements, unrelated files or original benchmark samples were changed.
