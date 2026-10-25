# 07 · S3-compatible gateway (SigV4)  — write in: cloud/s3-gateway/ (new Worker)
New Worker `unlispace-s3` implementing the S3 subset + extensions in product-design §4.2 and
docs/research/spacefs (Space's s3sdk protocol: llms-full sections on Standard S3 subset, Object
extensions, Drive extensions, Errors). Auth: SigV4 (header, presigned, UNSIGNED-PAYLOAD,
aws-chunked incl. STREAMING-UNSIGNED-PAYLOAD-TRAILER with trailing checksums) verified with
WebCrypto against access keys (secret = HMAC(master, keyId); key lookup via a service binding to
cloud/api is M3 — for now a `KeyResolver` interface with a dev in-memory impl). Bucket = drive;
talk to the data plane via a service binding (`DATA_PLANE`, HTTP fetch with internal drive tokens
minted from a shared Ed25519 key — define `InternalTokenMinter` interface). Implement:
ListBuckets, Head/Create/DeleteBucket, GetBucketVersioning, ListObjectsV2 (prefix/delimiter/
continuation), ListObjectVersions, Head/GetObject (single Range, versionId, conditionals),
PutObject (If-Match/If-None-Match), CopyObject (same-drive by reference), DeleteObject(s),
multipart (our own construct over shards), plus `?x-uls-write|patch|splice|rename|versions|restore`
with the S3SP patch body format. Chunk PUT bodies server-side with FastCDC (port uls-chunk to TS;
must match `engine/uls-chunk/tests/golden.json` and `golden_prng.json`). Tests with the official
`@aws-sdk/client-s3` against the worker in vitest (pinned). Gate: tsc + tests green.
