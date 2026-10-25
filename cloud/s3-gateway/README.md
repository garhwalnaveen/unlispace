# Unlispace S3 gateway (`unlispace-s3`)

S3-compatible Worker in front of the data plane. Bucket = drive id. SigV4 is verified with WebCrypto before dispatch;
object bytes pass through the `DATA_PLANE` service binding using short-lived (300 s) Ed25519 drive tokens minted per request.
Large bodies are chunked server-side with a TypeScript port of `engine/uls-chunk` (FastCDC v2020, 256 KiB / 2 MiB / 16 MiB).

## Routes

Addressing: path-style `/{bucket}/{key}` or virtual-host `{bucket}.{ULS_S3_HOST}/{key}`. `GET /healthz` is unauthenticated.

| Operation | Request |
|---|---|
| ListBuckets | `GET /` |
| CreateBucket / HeadBucket / DeleteBucket | `PUT` / `HEAD` / `DELETE /{bucket}` (create and delete need `admin`; delete answers `BucketNotEmpty`) |
| GetBucketVersioning (always `Enabled`), GetBucketLocation | `GET /{bucket}?versioning`, `?location` |
| ListObjectsV2 (+ v1 marker) | `GET /{bucket}?list-type=2&prefix&delimiter&max-keys&continuation-token&start-after&encoding-type` |
| ListObjectVersions | `GET /{bucket}?versions` (key-marker, version-id-marker, prefix, delimiter, delete markers) |
| ListMultipartUploads | `GET /{bucket}?uploads` |
| HeadObject / GetObject | `HEAD` / `GET /{bucket}/{key}`: single `Range`, `versionId`, `If-Match`, `If-None-Match`, `If-(Un)Modified-Since`, `response-*` overrides, `x-uls-as-of` |
| PutObject | `PUT /{bucket}/{key}`: `If-Match`, `If-None-Match: *`, `Content-MD5`, `x-amz-checksum-*`, 95 MB limit; a key ending in `/` makes a folder |
| CopyObject | `PUT` + `x-amz-copy-source: bucket/key[?versionId=]`: same drive, by reference, `x-amz-metadata-directive` |
| DeleteObject / DeleteObjects | `DELETE /{bucket}/{key}`, `POST /{bucket}?delete` |
| Multipart | `POST ?uploads`, `PUT ?partNumber&uploadId`, `GET ?uploadId` (ListParts), `POST ?uploadId` (complete), `DELETE ?uploadId` |
| Offset write / truncate | `PUT /{bucket}/{key}?x-uls-write` + `x-uls-offset`, optional `x-uls-size` |
| Batch patch | `PUT ?x-uls-patch`, `Content-Type: application/vnd.s3sdk.patch` (S3SP body) |
| Splice | `PUT ?x-uls-splice` + `x-uls-offset`, `x-uls-remove` (body = bytes to insert) |
| Rename | `PUT /{bucket}/{new}?x-uls-rename` + `x-uls-source: {old}` (folders: both end in `/`) |
| History | `GET ?x-uls-versions` (JSON, newest first) |
| Restore | `POST ?x-uls-restore&versionId=` |

Auth: header SigV4, presigned URLs, `UNSIGNED-PAYLOAD`, signed SHA-256 payload hash, `STREAMING-UNSIGNED-PAYLOAD-TRAILER`,
`STREAMING-AWS4-HMAC-SHA256-PAYLOAD[-TRAILER]` (per-chunk and trailer signatures), trailing `crc32/crc32c/crc64nvme/sha1/sha256`.
`x-uls-*` request headers must be in `SignedHeaders`. Errors are S3 XML (`<Error><Code>…`), `HEAD` and `304` have no body.

S3SP patch body (big-endian): `"S3SP" 01 00 00 00`, `u32 count` (1..10000), then per edit `u64 offset`, `u64 length`, bytes.
Edits apply in order; gaps zero-fill; partial edits reuse untouched shards by reference and always compare-and-swap on the head.

## Configuration

`ULS_S3_DEV_KEYS`: JSON array of key records `{keyId, subject, orgId, scope: read|write|admin, drives?: string[]}`.
`ULS_S3_MASTER_KEY` (secret): base64 of at least 32 bytes; secret access key = first 40 chars of `base64(HMAC(master, keyId))`.
Key ids look like `ULS` + 17 characters. `ULS_JWT_PRIVATE_JWK` (secret, Ed25519 with `kid`) and `ULS_ISSUER` sign the internal drive
tokens; the data plane's `ULS_JWT_PUBLIC_JWKS` must contain the matching public key. There are no default credentials.
`KeyResolver` is the seam for the M3 lookup against cloud/api.

## Run locally

```sh
npm install --legacy-peer-deps   # versions are pinned in package.json
npx tsc --noEmit
npm test                          # vitest + @cloudflare/vitest-plugin, no network, no deploy
```

Tests drive the router (`handle(request, deps)`) with the real `@aws-sdk/client-s3` through a custom `requestHandler`;
the data plane is an in-memory fake of `/v0/drives/{id}/…` (`test/fake-data-plane.ts`), while an inert auxiliary worker satisfies
the service bindings. `test/golden.test.ts` replays `engine/uls-chunk/tests/golden.json` and `golden_prng.json` through the TS chunker.
For `wrangler dev`, run cloud/data-plane alongside, put the secrets above in `.dev.vars`, and mint a key from `ULS_S3_MASTER_KEY`.

## Known gaps

- Cross-drive CopyObject, UploadPartCopy, GetObject `partNumber`, multi-range GETs, ACL/tagging/lifecycle/CORS APIs: `501`.
- `DeleteObject?versionId=` answers 501: history is immutable (use `?x-uls-restore`).
- ListObjectVersions rebuilds its key universe from the live tree plus the full change log (O(drive history)); fine for M2, needs an index for big drives.
- CreateBucket records ownership in `S3State` only; drive create/fork/describe extensions and the org-level drive registry arrive with the M3 API.
- Multipart upload parts and bucket records live in a single `S3State` Durable Object (`global`); unreferenced part shards are left to data-plane GC. No lifecycle expiry of abandoned uploads.
- Single PUT limit is 95 MB, patch/write bodies 64 MiB, per the Workers body cap.
- Not verified: behaviour against the real data plane through a live service binding (the fake follows its CONTRACT-NOTES), and real Workers memory/CPU limits on 95 MB uploads.
- Test-only vitest shims (`vitest.config.ts`): the AWS SDK's browser build is selected under workerd, so the XML parser and aws-chunked encoder are swapped for byte-correct equivalents. Production code is unaffected.
