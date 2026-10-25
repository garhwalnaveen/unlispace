# Unlispace S3 gateway (`unlispace-s3`)

S3-compatible Worker in front of the data plane. Bucket = drive alias or id. Keys and bucket ownership resolve through the control plane. SigV4 is verified with WebCrypto before dispatch;
object bytes pass through the `DATA_PLANE` service binding using short-lived (300 s) Ed25519 drive tokens minted per request.
Large bodies are chunked server-side with a TypeScript port of `engine/uls-chunk` (FastCDC v2020, 256 KiB / 2 MiB / 16 MiB).

## Routes

Addressing: path-style `/{bucket}/{key}` or virtual-host `{bucket}.{ULS_S3_HOST}/{key}`. `GET /healthz` is unauthenticated.

| Operation | Request |
|---|---|
| ListBuckets | `GET /` |
| CreateBucket / HeadBucket / DeleteBucket | `PUT` / `HEAD` / `DELETE /{bucket}` (create and delete need `admin`; soft delete accepts nonempty drives; `x-uls-hard-delete: true` requests hard delete) |
| Describe / mount | `GET /{bucket}?x-uls-drive`, `?x-uls-mount` (15-minute drive token + data-plane endpoint) |
| Key management | `GET/POST /_uls/keys`, `DELETE /_uls/keys/{id}` with a session; signed `POST` mints a child key |
| GetBucketVersioning (always `Enabled`), GetBucketLocation | `GET /{bucket}?versioning`, `?location` |
| ListObjectsV2 (+ v1 marker) | `GET /{bucket}?list-type=2&prefix&delimiter&max-keys&continuation-token&start-after&encoding-type` |
| ListObjectVersions | `GET /{bucket}?versions` (key-marker, version-id-marker, prefix, delimiter, delete markers) |
| ListMultipartUploads | `GET /{bucket}?uploads` |
| HeadObject / GetObject | `HEAD` / `GET /{bucket}/{key}`: single `Range`, `versionId`, `If-Match`, `If-None-Match`, `If-(Un)Modified-Since`, `response-*` overrides, `x-uls-as-of` |
| PutObject | `PUT /{bucket}/{key}`: `If-Match`, `If-None-Match: *`, `Content-MD5`, `x-amz-checksum-*`, 95 MB limit; a key ending in `/` makes a folder |
| CopyObject | `PUT` + `x-amz-copy-source: bucket/key[?versionId=]`: same drive by reference, cross-drive streaming copy, `x-amz-metadata-directive` |
| DeleteObject / DeleteObjects | `DELETE /{bucket}/{key}`, `POST /{bucket}?delete` |
| Multipart | `POST ?uploads`, `PUT ?partNumber&uploadId`, `GET ?uploadId` (ListParts), `POST ?uploadId` (complete), `DELETE ?uploadId` |
| Offset write / truncate | `PUT /{bucket}/{key}?x-uls-write` + `x-uls-offset`, optional `x-uls-size` |
| Batch patch | `POST ?x-uls-patch`, `Content-Type: application/vnd.s3sdk.patch` (S3SP body) |
| Splice | `PUT ?x-uls-splice` + `x-uls-offset`, `x-uls-remove` (body = bytes to insert) |
| Rename | `PUT /{bucket}/{new}?x-uls-rename` + `x-uls-source: {old}` (folders: both end in `/`) |
| History | `GET ?x-uls-versions` (JSON, oldest first; `operation`, `restoredFrom`, `isLatest`, `etag`, `lastModified`; rename rows omitted) |
| Restore | `POST ?x-uls-restore&versionId=` |

Auth: header SigV4, presigned URLs, `UNSIGNED-PAYLOAD`, signed SHA-256 payload hash, `STREAMING-UNSIGNED-PAYLOAD-TRAILER`,
`STREAMING-AWS4-HMAC-SHA256-PAYLOAD[-TRAILER]` (per-chunk and trailer signatures), trailing `crc32/crc32c/crc64nvme/sha1/sha256`.
`x-uls-*` request headers must be in `SignedHeaders`. Errors are S3 XML (`<Error><Code>…`), `HEAD` and `304` have no body.

S3SP patch body (big-endian): `"S3SP" 01 00 00 00`, `u32 count` (1..10000), then per edit `u64 offset`, `u64 length`, bytes.
Edits apply in order; gaps zero-fill; partial edits reuse untouched shards by reference and always compare-and-swap on the head.

## Configuration

`CONTROL_PLANE` binds service `unlispace-api`, entrypoint `ControlPlane` (M3 §3.3); `API` binds its default fetch handler.
`ControlPlaneKeyResolver` caches lookup results for at most 30 seconds per isolate, with a bounded cache. Successful authorized
requests call `recordKeyUse`; signature/scope refusals never do. Production has no memory-key fallback or master secret.
`MemoryKeyResolver` is retained for isolated fixtures. `ULS_JWT_PRIVATE_JWK` (secret, Ed25519 with `kid`) and `ULS_ISSUER` sign
internal drive tokens; the data plane must trust the matching public key. `DATA_PLANE` carries object traffic. S3State stores
multipart metadata, version annotations and archives for S3-originated renames; bucket ownership is never stored there.

Create accepts percent-encoded `x-uls-display-name`, `x-uls-placement` (`wnam/enam/weur/eeur/apac/oc`; `sam→enam`, `afr→weur`,
`me→eeur`), or `x-uls-fork-source`. Fork ignores placement and returns drive/source ids and RFC 3339 fork point headers.
`x-uls-consistent: true` is accepted on reads; the drive authority already provides consistent reads. Every response carries
`x-uls-protocol: 1`, including errors. `writable:false` refuses content writes with `403 QuotaExceeded`; deletes remain available.

Session key routes forward the bearer from `x-uls-login-authorization` or `Authorization` to the API's `/keys` routes. SigV4
child minting requires header auth, a real `x-amz-content-sha256`, and nonempty reachable drive ids; no presigning or unsigned
payloads. Workspace changes and authority escalation are refused. Key-route failures are JSON, while S3 failures are XML.

## Run locally

```sh
npm install --legacy-peer-deps   # versions are pinned in package.json
npx tsc --noEmit
npm test                          # vitest + @cloudflare/vitest-plugin, no network, no deploy
```

Tests drive the router (`handle(request, deps)`) with the real `@aws-sdk/client-s3` through a custom `requestHandler`;
the data plane is an in-memory fake of `/v0/drives/{id}/…` (`test/fake-data-plane.ts`), while an inert auxiliary worker satisfies
the service bindings. `test/golden.test.ts` replays `engine/uls-chunk/tests/golden.json` and `golden_prng.json` through the TS chunker.
For `wrangler dev`, run cloud/data-plane alongside, put the secrets above in `.dev.vars`, and run cloud/api with its `ControlPlane` entrypoint; mint a key through the API session route.

## Known gaps

- UploadPartCopy, GetObject `partNumber`, multi-range GETs, ACL/tagging/lifecycle/CORS APIs: `501`.
- `DeleteObject?versionId=` answers 501: history is immutable (use `?x-uls-restore`).
- ListObjectVersions rebuilds its key universe from the live tree plus the full change log (O(drive history)); fine for M2, needs an index for big drives.
- Multipart upload metadata and history annotations live in a single `S3State` Durable Object (`global`); unreferenced part shards are left to data-plane GC. No lifecycle expiry of abandoned uploads.
- Single PUT limit is 95 MB, patch/write bodies 64 MiB, per the Workers body cap.
- Not verified: behaviour against the real data plane through a live service binding (the fake follows its CONTRACT-NOTES), and real Workers memory/CPU limits on 95 MB uploads.
- Cross-client rename/history and atomic operation provenance still need data-plane support; see [NEEDS.md](NEEDS.md). The gateway archives content history for its own S3 renames, and copies annotations on S3-created forks. Archives are not atomic with data-plane commits and are not a large-history replacement for node-based history.
- Optional direct-upload extensions return `501 NotImplemented`. Standard ListObjectVersions retains the existing immutable-history/delete-marker behavior; the JSON content-history extension omits rename/delete rows.
- Test-only vitest shims (`vitest.config.ts`): the AWS SDK's browser build is selected under workerd, so the XML parser and aws-chunked encoder are swapped for byte-correct equivalents. Production code is unaffected.

`test/conformance.test.ts` ports all 16 Space conformance names to describes using the real AWS S3 SDK against an in-memory
ControlPlane + data-plane fake (including in-memory forks). `test/m3.test.ts` covers key cache expiry, post-authorization use
recording, quota deletes, cross-drive copy, fork guard errors, extension limits and session/SigV4 key trust boundaries.
