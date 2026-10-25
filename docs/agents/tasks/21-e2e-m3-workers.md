# 21 · High stakes (gpt-6.1-sol): E2E phase across the three real Workers — forks, SigV4 keys, child keys, revocation, quota  — write in: tests/e2e/ (fix real bugs minimally in cloud/api/ or cloud/s3-gateway/ only if they block a check; NOT cloud/data-plane/, another agent is editing it)
Today the M3 features are tested only against fakes. Read tests/e2e/README.md and harness.mjs (it already
starts data-plane + api with `wrangler dev --local`, ephemeral keys, dev OTP sign-in; last run 36/36),
docs/design/m3-contract.md §3–§4, cloud/api/M3-API.md, cloud/s3-gateway/README.md + NEEDS.md, docs/DEPLOY.md.
Add an opt-out phase `m3` (E2E_M3=0 disables) that:
1. Starts `cloud/s3-gateway` as a third local Worker wired by the local service registry to the real
   `ControlPlane` (api) and `DataPlaneAdmin`/fetch (data-plane) entrypoints, apply migration 0003. Pick
   ports like the others, with an `E2E_S3_PORT` override. Fix the config copy logic for its bindings.
2. Creates an access key through `POST /keys` (session) and drives the gateway with the official AWS CLI
   v2 if `aws` is on PATH, else with `@aws-sdk/client-s3` from cloud/s3-gateway/node_modules (no installs).
   Checks: ListBuckets shows the drive by alias; PutObject/GetObject byte-identical (8 MiB random, ≥ 1
   aws-chunked upload); `?x-uls-write` + `?x-uls-patch` + `?x-uls-splice` change exactly the right bytes;
   `?x-uls-versions` oldest→newest; restore.
3. Fork: `CreateBucket` with `x-uls-fork-source`; fork sees parent bytes; writes in fork are invisible to
   parent and vice versa; `?x-uls-drive` shows forkOf/forks; parent hard delete → 409 DriveHasForks;
   fork of fork works; no shard bytes are re-uploaded for the fork (check the data plane shard count or
   R2 object listing in the local persist dir does not grow).
4. Keys: child key minted with SigV4 on `/_uls/keys` scoped to one drive + read; it can read that drive,
   gets NoSuchBucket on the other, AccessDenied on write; UNSIGNED-PAYLOAD mint refused (400); revoking
   the parent kills the child within the ≤ 30 s cache window (poll; assert ≤ 35 s).
5. Quota: force the org over quota (drive_usage row via a dev-only path that already exists, or by running
   the metering cron with `wrangler dev --test-scheduled` + `/__scheduled`, and a tiny quota through an
   existing test hook; if no hook exists, add a minimal `ULS_DEV_*`-guarded one in cloud/api, off in
   production config) → S3 PutObject 403 QuotaExceeded, `POST /drives/{id}/token` write → 403 over_quota,
   reads still work, delete still works.
6. Native CLI over a fork: `uls fork` then `uls get` from the fork through the daemon-less CLI.
All existing 36 checks must still pass. Never print secrets/keys; scrub them in failure messages.
Gate: `bash tests/e2e/run.sh` → all PASS; paste the table into tests/e2e/last-run.txt. Report ≤ 300 words,
listing every bug you fixed outside tests/e2e with file:line.
