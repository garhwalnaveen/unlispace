# 16 · High stakes (gpt-6.1-sol): S3 gateway on real keys + drive extensions (Space protocol parity)  — write in: cloud/s3-gateway/
Spec: docs/design/m3-contract.md §1, §4 (normative); §3.3 is the `ControlPlane` interface you call.
Space protocol v1 (§1–§9) in /tmp/spacefs-docs-1025/llms-full.txt is the behavioural reference — read
"Model", "Standard S3 subset", "Object extensions", "Drive extensions", "Key routes", "Errors", "Limits".
1. `ControlPlaneKeyResolver` over service binding `CONTROL_PLANE` (entrypoint `ControlPlane`, service
   `unlispace-api`; add to wrangler.jsonc incl. production). Cache ≤ 30 s per isolate. `recordKeyUse`
   only after SigV4 + authorization. Keep `MemoryKeyResolver` for tests; production must not fall back to it.
2. Buckets by alias or id; ListBuckets/CreateBucket/DeleteBucket/HeadBucket via ControlPlane (drop the
   `S3State` bucket registry for ownership; multipart state may stay in S3State). Placement mapping,
   fork via `x-uls-fork-source`, hard delete, `?x-uls-drive`, `?x-uls-mount`, `x-uls-consistent`,
   `x-uls-protocol: 1` on every response, `QuotaExceeded` on writes when `writable:false`.
3. `?x-uls-versions` oldest→newest with `operation`/`restoredFrom`, rename versions omitted.
   Check every Space §4 rule against our implementation (write/patch/splice/rename/restore error codes,
   `x-uls-size` response header, 64 MiB extension cap, folder semantics §1.0, `PathConflict`) and fix gaps.
4. `/_uls/keys` routes (§4): session-forwarded list/create/revoke, and SigV4-signed child minting with
   the real-digest rule.
5. Port Space's 16 conformance case names (Reference → Conformance) to `test/conformance.test.ts`, one
   `describe` each, driven through the real `@aws-sdk/client-s3` against the fake data plane plus a fake
   ControlPlane that follows §3.3 (fork cases use a fake that implements fork in memory).
Gate: `cd cloud/s3-gateway && npx tsc --noEmit && npm test`. Update README.md routes + known gaps.
Report ≤ 300 words.
