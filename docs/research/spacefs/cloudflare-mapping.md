# Space (spacefs.com) clone on Cloudflare: platform mapping and constraints

Researched 2026-10-25 against developers.cloudflare.com. Each "last updated" date below is what the page showed when fetched. Figures marked *estimate* are my own arithmetic or engineering judgement and are not documented. I ran no benchmarks.

---

## 0. Component to service map

| Space component | Cloudflare service | Notes |
|---|---|---|
| Shard store (content-addressed, SHA-256) | R2 (Standard class), one bucket per placement region | `If-None-Match: *` on PUT gives atomic first-writer-wins. Egress is free. |
| Per-drive authority (commit ordering, CAS, preconditions, version index) | Durable Object (SQLite-backed), one per drive, created with `locationHint` | Space's hint list is the DO hint list (§1.2). |
| Manifests | DO SQLite rows for small versions. Large manifests go in R2 as content-addressed blobs. | 2 MB row cap (§1.1). |
| Multi-region reads (about 2 s stale) | No DO read replicas. Use the Cache API per colo with short TTLs, or regional mirror DOs. | §1.7 |
| S3 gateway (`s3sdk.*`) | Worker on a route `*.s3sdk.example.com/*` with a proxied wildcard DNS record, plus Advanced Certificate Manager | Request body cap depends on the zone plan (§3.1). |
| SigV4 verification | Write it yourself with Web Crypto HMAC and `crypto.subtle.timingSafeEqual` | §3.4 |
| Mount credentials | R2 temporary credentials (REST API or a locally signed JWT) | Response shape matches Space's (§2.4). |
| Edge shard cache | `fetch()` through the zone cache with Tiered Cache, plus the Cache API for Worker-built responses | Cache Reserve is not useful here (§4). |
| Change fan-out (replaces NATS) | DO Hibernatable WebSockets in a per-drive notify DO and a per-user DO | §1.6 |
| Control plane DB | D1 (with Sessions API and replicas) or Hyperdrive with Postgres | §5 |
| Key revocation propagation (about 1 min) | Authoritative row in D1 or a DO, cached per colo for 30 s or less with the Cache API | KV takes "60 s or more", which is too slow. |
| OTP email | Email Service (`send_email` binding), beta, Workers Paid | §6 |
| Google OAuth | Hand-written OIDC code flow in a Worker. `workers-oauth-provider` is only for the provider side. | §6 |
| GC, fork-copy, metering, billing sync | Queues, Workflows, Cron Triggers, DO alarms, R2 event notifications | §7 |
| Video transcoding | Stream, or Containers running ffmpeg. Media Transformations only for short clips and thumbnails. | §8 |
| Space Search / AI | Workers AI embeddings with Vectorize, or AI Search fed from a search-mirror bucket | §9 |

---

## 1. Per-drive authority on Durable Objects

### 1.1 Storage limits (SQLite backend)
Source: https://developers.cloudflare.com/durable-objects/platform/limits/ (updated Jun 1, 2026)

- **10 GB per object.** The FAQ says 10 GB on Paid and 1 GB on Free (https://developers.cloudflare.com/durable-objects/reference/faq/). When full, writes fail with `SQLITE_FULL`, but reads and deletes still work.
- Storage per account and number of objects: unlimited on Paid.
- **Key plus value at most 2 MB. A string, BLOB or row is also capped at 2 MB.** 100 columns per table. 100 KB per SQL statement. **100 bound parameters per query.** LIKE/GLOB patterns are capped at 50 bytes.
- 500 DO classes per account on Paid.
- APIs (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): `ctx.storage.sql.exec`, `transactionSync()`, synchronous KV `ctx.storage.kv`, and **PITR** (`getCurrentBookmark`, `getBookmarkForTime`, `onNextSessionRestoreBookmark`). Writes with no intervening `await` are coalesced into one atomic transaction by the input/output gates (https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

**Design impact**
- *Manifest size.* A 5 TiB object at an average shard size of 2 MiB has about 2.6 M shards. At roughly 40 B per entry that is about 100 MB of manifest, far above the 2 MB row cap (*estimate*). Two options:
  - Keep a manifest as rows (`version_id, seq, shard_hash, offset, len`) and page through them. Batched inserts are bounded by the 100-parameter limit, so expect about 20 rows per statement at 5 columns.
  - Store large manifests in R2 as content-addressed chunked blobs (a Merkle-style manifest of manifests), with the DO holding only the root hash.
- *Version history.* Each drive's history has to fit in 10 GB. Keep cold versions in R2, keep only the index in the DO, and use PITR for operational recovery.
- *Global GC refcounts cannot live in one DO.* That would be a singleton bottleneck at about 1,000 rps (see §7).

### 1.2 Location hints and jurisdictions
Source: https://developers.cloudflare.com/durable-objects/reference/data-location/

- Hints: `wnam, enam, sam, weur, eeur, apac, apac-ne, apac-se, oc, afr, me`. **Space's list (wnam/enam/sam/weur/eeur/apac/oc/afr/me) is exactly the DO hint set.** Space only leaves out the newer `apac-ne`/`apac-se` sub-regions. This strongly supports the theory that the authority is a DO.
- **`sam`, `afr` and `me` are hints only. "Durable Objects currently do not spawn in this location."** They land in a nearby region; for example, `sam` lands in Eastern North America.
- Hints are "a best effort and not a guarantee". "Only the first call to `get()` for a particular Object will respect the hint." **Objects never relocate after creation** ("planned for the future"). That matches Space fixing placement at creation.
- Jurisdictions: `eu`, `us` and `fedramp`, set with `env.NS.jurisdiction("eu")`. The same name produces different IDs in different jurisdictions. The DO ID itself is logged outside the jurisdiction.
- R2 location hints are a smaller set: `wnam, enam, weur, eeur, apac, oc`. There are no `sam/afr/me` hints. R2 jurisdictions are `eu`, `us` and `fedramp` (https://developers.cloudflare.com/r2/reference/data-location/). Bucket location is also fixed at first creation. So the shard bucket for a `sam`/`afr`/`me` drive has to be the nearest R2 region. Turn on **R2 Local Uploads** (https://developers.cloudflare.com/r2/buckets/local-uploads/, no extra cost, not available on jurisdictional buckets) to bring write latency down for far-away clients.

### 1.3 Request and response bodies into a DO
- The DO docs give **no separate body limit**. Inbound requests are capped by the Worker request limit at the edge (§3.1).
- Worker-to-DO RPC: "The maximum serialized RPC limit is 32 MiB". `ReadableStream`, `Request` and `Response` bodies stream past that limit, as long as they are byte streams (https://developers.cloudflare.com/workers/runtime-apis/rpc/).
- **Design rule: never stream shard bytes through the authority.** The gateway Worker writes shards to R2, then sends the DO a small commit message (manifest delta plus preconditions). The DO is single-threaded, and every byte it handles costs time on the commit path.

### 1.4 CPU and duration
- CPU defaults to 30 s per invocation, and every HTTP request, WebSocket message or alarm resets the budget. It can be raised to 5 min with `limits.cpu_ms`.
- Wall time is unlimited while the caller stays connected. Alarms are capped at 15 min.
- Soft limit of **about 1,000 requests per second per object**. Past that, requests queue and then get an "overloaded" error. The rules page says "500-1,000 rps" for simple work.
- One drive therefore tops out at roughly 1k commits plus metadata lookups per second. Very hot drives need read caching in front of the DO (§1.7). Write batching inside the DO (group commit) is possible because of output gates.
- Global uniqueness can be broken briefly during partitions or code updates. A stale instance throws when it touches storage (https://developers.cloudflare.com/durable-objects/platform/known-issues/). Do every CAS inside SQLite, not in memory.

### 1.5 Alarms
Source: https://developers.cloudflare.com/durable-objects/api/alarms/

- One alarm per object, at-least-once delivery, exponential backoff from 2 s with up to 6 retries, 15 min wall time.
- Keep a schedule table in SQLite and re-arm for the earliest item. This works for per-drive housekeeping: expiring multipart uploads, compaction, pushing usage deltas.

### 1.6 WebSocket hibernation as the NATS replacement
Sources: https://developers.cloudflare.com/durable-objects/api/state/, https://developers.cloudflare.com/durable-objects/best-practices/websockets/, https://developers.cloudflare.com/durable-objects/platform/pricing/

- `ctx.acceptWebSocket(ws, tags)`: **at most 32,768 hibernatable WebSockets per DO**, up to 10 tags per socket, 256 characters per tag.
- `getWebSockets(tag)` filters sockets by tag. `setWebSocketAutoResponse` handles pings without waking the object.
- Attachments are capped at 16 KiB.
- Received messages can be up to 32 MiB.
- Billing:
  - Outgoing messages are free.
  - Incoming messages are billed at 20:1.
  - Idle hibernatable objects are not billed for duration.
  - Plain `ws.accept()` bills duration for the entire time the socket is connected.
- **Gotchas**
  - "Code updates disconnect all WebSockets." Every deploy forces every desktop client to reconnect, so clients need a resume cursor (last-seen commit sequence) and an idempotent resync.
  - Outbound WebSockets from a DO do not hibernate.
  - Send in batches, flushing every 50–100 ms or every 50–100 messages.
- Topology:
  - **A per-drive "notify" DO**, separate from the authority so that fan-out CPU does not slow commits. The authority calls it by RPC after each commit.
  - **A per-user DO** for "access-change" events.
  - A desktop client opens one socket per drive it watches, or one socket to its per-user DO, which subscribes to drives on its behalf.

### 1.7 Multi-region reads and read replicas
I checked the limits page, the data-location page, the SQLite API page, the release notes and the full DO llms.txt index. **None of them document read replicas for user-defined Durable Objects.** D1 has read replicas, which are built from DOs internally, but that mechanism is not exposed as a DO feature (https://developers.cloudflare.com/d1/best-practices/read-replication/).

Space's "~2 s stale unless `x-s3sdk-consistent: true`" fits an edge metadata cache with a short TTL. Two workarounds:
- **(a)** The gateway caches HEAD/metadata responses from the authority in the local colo with the Cache API (`Cache-Control: max-age=2`). The `x-s3sdk-consistent` header bypasses the cache. The Cache API is per colo and not tiered (§4).
- **(b)** Per-region "mirror" DOs (hint = reader region) that the authority pushes record heads to after each commit. This is more work, but it also handles listings.

KV is not suitable for this: writes "may take up to 60 seconds or more" to propagate (https://developers.cloudflare.com/kv/concepts/how-kv-works/).

---

## 2. R2

### 2.1 Conditional writes
Source: https://developers.cloudflare.com/r2/api/s3/api/

- PutObject supports If-Match, If-None-Match, If-Modified-Since and If-Unmodified-Since. They are "evaluated atomically against the committed bucket state". With concurrent `If-None-Match: *`, "at most one write succeeds and the others fail with 412".
- Workers binding: `put(key, body, { onlyIf })` returns `null` when the precondition fails (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
- **CompleteMultipartUpload has no conditional headers.** CopyObject only has source-side conditionals.
- **Concurrent writes to the same key are limited to 1 per second** and return 429 above that (https://developers.cloudflare.com/r2/platform/limits/). That rules out R2 as the home of the record head (which is fine, because it lives in the DO). For content-addressed shards, treat a 412 or 429 on an existing hash as success.
- R2 does not support S3 bucket versioning or object lock. Space implements both itself, so this doesn't matter.

### 2.2 Multipart and object limits
Sources: https://developers.cloudflare.com/r2/objects/multipart-objects/, https://developers.cloudflare.com/r2/platform/limits/ (updated Jun 8, 2026)

- Parts must be 5 MiB to 5 GiB, and **all parts except the last must be the same size**. Up to 10,000 parts.
- Objects can be up to 4.995 TiB. A single PUT can be up to 4.995 GiB.
- Incomplete uploads are aborted after 7 days.
- Key length is 1,024 bytes. Metadata is capped at 8,192 bytes.
- **The equal-size rule conflicts with variable-size CDC shards**, so do not map S3 multipart parts directly onto R2 multipart. The gateway should cut parts into CDC shards and store each shard as its own R2 object (256 KiB to 16 MiB, so a single PUT each). The S3 multipart upload becomes a gateway-level construct whose state lives in the drive DO.
- Checksums: SHA256 is only supported as COMPOSITE (multipart). FULL_OBJECT is only supported for CRC64NVME. The gateway therefore has to verify client `x-amz-checksum-*` and aws-chunked trailers itself. The R2 S3 page does not mention aws-chunked at all.

### 2.3 Presigned URLs
Source: https://developers.cloudflare.com/r2/api/s3/presigned-urls/

- Supported methods: GET, HEAD, PUT and DELETE. POST form uploads are not supported.
- Expiry can be 1 s to 7 days.
- **"Presigned URLs cannot be used with custom domains."** They only work against `<account>.r2.cloudflarestorage.com`, which bypasses your zone cache.
- For web file browsing through per-block GETs, either presign directly against R2 (no edge cache, but egress is still free) or serve blocks from the gateway Worker with its own HMAC token. The second option gets the edge cache, and I recommend it.

### 2.4 Temporary scoped credentials (mount)
**This exists.**
- API: `POST /accounts/{account_id}/r2/temp-access-credentials` (https://developers.cloudflare.com/api/resources/r2/subresources/temporary_credentials/methods/create/).
- Request body:
  - `bucket` (required)
  - `parentAccessKeyId` (required)
  - `permission`: `admin-read-write`, `admin-read-only`, `object-read-write` or `object-read-only`
  - `ttlSeconds`: **at most 604,800 (7 days)**
  - optional `prefixes[]` and `objects[]`
- Response: `accessKeyId`, `secretAccessKey`, `sessionToken`. This is exactly the shape of Space's mount response, and the `backend:"r2"` field strongly suggests Space calls this API.

Docs page: https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
- **Local minting.** You can mint credentials without an API call by signing an **HS256 JWT** with the parent token's secret.
  - The session token is `base64("jwt/" + jwt)`.
  - The secret is the SHA-256 hex of the JWT.
  - The access key ID is the parent's.
  - Local minting is the only way to get action-level scoping (`actions: ["GetObject", ...]`).
- One bucket per credential. Prefix scoping matches "keys starting with any listed prefix". The credential cannot exceed the parent token's permissions.
- Clients send the session token in `X-Amz-Security-Token`.

**Gotchas**
- *Rate limits.* The account-wide R2 REST API limit is **1,200 requests per 5 minutes** (https://developers.cloudflare.com/r2/platform/limits/), about 4 per second. Minting through the API caps mount logins at that rate. **Mint locally with a JWT** inside a Worker that holds the parent secret.
- *Revocation.* No per-credential revocation is documented. Revoking the parent token "stop[s] working immediately" for **every** credential derived from it.
  - Space's "revocation within about a minute" cannot reach already-issued mount credentials unless TTLs are short.
  - Use about 15 min TTLs with client refresh. The refresh checks key status.
  - Optionally split parent tokens into cohorts (for example per workspace or per day) so you can revoke one in an emergency. That needs one R2 API token per cohort, created through the API tokens API (https://developers.cloudflare.com/r2/api/tokens/).
- *Endpoint.* The endpoint is `https://<account>.r2.cloudflarestorage.com` with region `auto`. Clients therefore see the account ID and bucket name.
- *Shared shards.* Prefix scoping assumes a per-drive key prefix. Space shards are shared across forks and drives, so a client writing directly into its drive prefix gives up cross-drive dedup at the storage layer. Choose one:
  - (a) Accept per-drive (or per-workspace) shard namespaces, with forks referencing the parent's prefix read-only. A credential can list several prefixes.
  - (b) Have the client write into a staging prefix and let a server-side promote step copy into the global CAS. CopyObject costs Class A and doubles writes.

### 2.5 Account and bucket limits
- 1,000,000 buckets per account. Unlimited storage and objects. 100 custom domains per bucket. Bucket management is limited to 50 operations per second (https://developers.cloudflare.com/r2/platform/limits/).
- Event notifications: up to 100 rules per bucket, delivered to a Queue, with prefix/suffix filters and no overlapping rules. Event types are `object-create` (PutObject, CopyObject, CompleteMultipartUpload) and `object-delete` (DeleteObject, LifecycleDeletion). A queue handles up to 5,000 messages per second (https://developers.cloudflare.com/r2/buckets/event-notifications/). This is useful for usage metering of direct-to-R2 writes from mounted clients, because those bypass the gateway.

### 2.6 Pricing
Source: https://developers.cloudflare.com/r2/pricing/ (updated Oct 1, 2026)

| | Standard | Infrequent Access |
|---|---|---|
| Storage | $0.015/GB-month | $0.01/GB-month (30-day minimum, $0.01/GB retrieval) |
| Class A | $4.50/M | $9.00/M |
| Class B | $0.36/M | $0.90/M |
| Egress | free | free |

- Free tier: 10 GB-month, 1 M Class A and 10 M Class B.
- **ListObjects counts as Class A**, which matters for GC sweeps. Delete is free.

### 2.7 R2 Data Catalog
It has been renamed **Basin Catalog** and is now GA. It is a managed Apache Iceberg REST catalog (https://developers.cloudflare.com/r2/data-catalog/). It has no role in the filesystem path. It could hold analytics tables (usage events, audit log) for billing and BI.

### 2.8 Workers binding vs the S3 API from a Worker
- **Use the binding.** It avoids SigV4 signing, has no public-endpoint hop, and supports `onlyIf` conditionals, range reads, checksums (md5/sha1/sha256/sha384/sha512, one at a time), `storageClass`, SSE-C and multipart (`createMultipartUpload` / `resumeMultipartUpload`). It is strongly consistent globally (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
- Use the S3 API only to hand out presigned URLs or temporary credentials.
- Batch `delete()` accepts 1,000 keys.

---

## 3. Worker as the S3 gateway

### 3.1 Request body size
Source: https://developers.cloudflare.com/workers/platform/limits/ (updated Oct 12, 2026)

- The cap depends on the **zone plan**, not the Workers plan:
  - Free and Pro: 100 MB
  - Business: 200 MB
  - **Enterprise: up to 5 GB self-serve**
- Response size: no enforced limit. The CDN cache caps objects at 512 MB on Free, Pro and Business, and 5 GB on Enterprise.
- **Design impact.** Without Enterprise, a single-request `PutObject` above 100 MB (or 200 MB on Business) cannot reach the gateway. The S3 limit for a single PUT is 5 GiB.
  - Most SDKs switch to multipart at about 8–16 MB by default, so it mostly works in practice.
  - Document "PUT at most 100 MB; use multipart above that" or buy Enterprise.
  - The 64 MiB patch batch fits on every plan.

### 3.2 CPU and memory for hashing and CDC of 64 MiB
- Paid plan: CPU defaults to 30 s and can be set to 5 min. **Memory is 128 MB per isolate**, shared by every concurrent request in that isolate.
- SHA-256: `crypto.DigestStream` is native, streaming, and does not retain data (https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).
- FastCDC in JS or WASM: no Cloudflare figure exists. *My estimate* is a few hundred MB/s for a WASM gear-hash plus native SHA-256, so 64 MiB costs on the order of 0.1–0.5 s of CPU. That is well within 30 s and costs roughly $0.00001 per request at $0.02 per M CPU-ms.
- **Feasible server-side if fully streamed.** Never buffer the 64 MiB body: 128 MB is shared and you also hold shard buffers of up to 16 MiB. Plan for at most about 2–3 in-flight large uploads per isolate.
- Recommendation:
  - Desktop and mount clients chunk on the client and upload shards directly (dedup saves bandwidth).
  - The gateway chunks only for third-party S3 clients, and streams.
  - The patch batch (up to 10k edits) is metadata-heavy. Apply it in the gateway as manifest surgery, and re-chunk only the affected byte ranges.

### 3.3 Subrequests and connections
- Paid: 10,000 subrequests per request by default, configurable up to 10 M. Free: 50.
- **6 simultaneous open connections** per request. Only connections still waiting for headers count.
- One 64 MiB upload is about 32 shards, so 32 R2 puts plus 1 DO call is fine. A 10k-edit patch that touches many shards is still under 10k, but uploads are throttled to 6 in flight. Pipeline them.

### 3.4 SigV4 verification
- Cloudflare documents no SigV4 *verification* library. The R2 docs use `aws4fetch` for *signing* only.
- Implement it yourself: canonical request, string-to-sign, HMAC chain with `crypto.subtle`, and `crypto.subtle.timingSafeEqual` for the comparison. Cover:
  - presigned query-string auth (`X-Amz-Expires` up to 7 days)
  - `UNSIGNED-PAYLOAD`
  - `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` and `STREAMING-UNSIGNED-PAYLOAD-TRAILER`, which means parsing aws-chunked frames and verifying per-chunk signatures and trailing `x-amz-checksum-*`
- I did not check any third-party npm verifier, so treat any you find as unvetted.
- Key derivation as in Space (secret = HMAC(master, keyId), never stored) works directly. Keep the master in a Worker secret (env var limit is 5 KB) or in Secrets Store.

### 3.5 Custom domains and wildcard virtual-host buckets
Sources: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/, https://developers.cloudflare.com/workers/configuration/routing/routes/, https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/, https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/, https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/

- **Workers Custom Domains do not support wildcards.** Use a **route** `*.s3sdk.example.com/*` (plus `s3sdk.example.com/*` for path-style) with a **proxied wildcard DNS record**. Proxied wildcards work on all plans.
- **Universal SSL covers only the apex and first-level subdomains.** `bucket.s3sdk.example.com` is second level and "will not serve a valid certificate". You need **Advanced Certificate Manager**, either Total TLS or an advanced certificate for `*.s3sdk.example.com`. Total TLS issues per-hostname certificates and has a 64-character CN limit.
- Alternatives: put the gateway at the first level (`*.example-s3.com`), which Universal SSL covers, or support only path-style addressing.

---

## 4. Edge shard cache

| Option | Verdict | Facts |
|---|---|---|
| `fetch()` through the zone cache with Tiered Cache | **Primary choice** | "To take advantage of tiered caching, use the fetch API". Cache key is the subrequest URL (https://developers.cloudflare.com/workers/reference/how-the-cache-works/). Serve shards from an R2 custom domain or an internal hostname with `Cache-Control: public, max-age=31536000, immutable`. Smart Tiered Cache puts the upper tier next to the bucket (https://developers.cloudflare.com/r2/buckets/public-buckets/). |
| Cache API (`caches.default`) | Secondary, for Worker-built responses (assembled ranges, metadata with 2 s TTL) | Per colo only, "not compatible with tiered caching", `cache.delete` purges only locally. Can't store 206 responses, but `match()` with Range returns 206. Objects up to 512 MB (https://developers.cloudflare.com/workers/runtime-apis/cache/). |
| Workers KV | No | Values up to 25 MiB, 1 write/s per key, writes $5/M, eventual consistency of 60 s or more (https://developers.cloudflare.com/kv/platform/limits/). Pointless for immutable blobs already in R2. |
| Cache Reserve | No | Built on R2 at the same prices, requires TTL of at least 10 h, and "Requests to R2 public buckets linked to a zone's domain will not use Cache Reserve" (https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/). With free R2 egress it just duplicates storage. |

Gotchas:
- The CDN caches only some file types by default, so a Cache Everything rule is needed for shard keys.
- An R2 custom domain on the shard bucket makes those objects public by URL. Put a Worker in front, or use unguessable keys plus WAF/HMAC.
- Hashes are not secrets. Anyone holding a shard hash could fetch it, so authorize in the gateway.

---

## 5. Control plane database

**D1** (https://developers.cloudflare.com/d1/platform/limits/, updated Oct 24, 2026)
- **10 GB per database, and this "cannot be further increased"**. 50,000 databases per account. 1,000 queries per invocation. 30 s per query. 100 bound parameters. 2 MB rows.
- Single-threaded: 1 ms queries give at most about 1,000 queries/s.
- Read replication covers ENAM, WNAM, WEUR, EEUR, APAC and OC, with no extra charge. It uses the Sessions API (`withSession("first-primary" | bookmark)`), which gives sequential consistency and read-your-writes. The **release notes still list it only as "Public Beta" (2025-04-10)**, and the Sessions API is binding-only, not available over REST (https://developers.cloudflare.com/d1/best-practices/read-replication/, https://developers.cloudflare.com/d1/platform/release-notes/).
- Pricing: 25 B rows read and 50 M rows written included, then $0.001 per M reads and $1 per M writes. 5 GB included, then $0.75/GB-month (https://developers.cloudflare.com/workers/platform/pricing/).

**Hyperdrive with Postgres** (https://developers.cloudflare.com/hyperdrive/platform/limits/)
- Included in Workers Paid with unlimited queries. About 100 origin connections per config. 60 s query cap. Caches responses up to 50 MB.
- You still run Postgres yourself (Neon, PlanetScale and so on) in one region, so far-away regions see cross-region latency.

**Recommendation:** use **D1** for users, orgs, members, invites, access keys and their parent chain, review threads and public links. The data is small and relational, and read replicas help global key lookups.
- Stripe webhooks should land in a Worker and write to D1 idempotently, keyed on the Stripe event ID.
- Choose Hyperdrive with Postgres only if you expect more than 10 GB of control-plane data or need Postgres features.
- Don't use DOs for the control plane except for per-workspace hot counters and quotas.
- **Key revocation in about 1 min:**
  - The authoritative `revoked_at` lives in D1. Child-key revocation is transitive: walk the parent chain, keeping the chain in the key row.
  - The gateway caches key status in the Cache API with `max-age=30` per colo, which gives about 30–60 s of worst-case propagation.
  - The derived-secret scheme means the gateway never needs to store secrets.

---

## 6. Auth

**OTP email:** Cloudflare Email Service
- Overview: https://developers.cloudflare.com/email-service/. Binding API: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
- Configured as a `send_email` binding and called as `env.EMAIL.send({to, from, subject, text, html})`.
- **Sending is in beta and requires Workers Paid** for arbitrary recipients. The `from` domain must be onboarded and verified.
- Limits (https://developers.cloudflare.com/email-service/platform/limits/): 5 MiB per message, 50 recipients. The **daily quota starts "conservative" and grows** with sending reputation, which is a launch-day risk for OTP volume.
- Pricing: 3,000 emails per month included, then $0.35 per 1,000 (https://developers.cloudflare.com/email-service/platform/pricing/).
- Keep a fallback provider until the quota has grown.

**Google OAuth:** no dedicated Cloudflare library for consumer login exists.
- `workers-oauth-provider` implements the *provider* side of OAuth 2.1 (for MCP). Google can only be plugged in as an upstream (https://developers.cloudflare.com/agents/model-context-protocol/authorization/).
- Implement the standard OIDC authorization-code flow with PKCE in a Worker:
  - redirect to Google
  - exchange the code with `fetch`
  - verify the ID-token JWT against Google's JWKS with `crypto.subtle` RS256, caching the JWKS with the Cache API
  - issue your own session cookie and bearer tokens
- Store OTP codes hashed in D1 or a DO with a TTL. Rate-limit per email and IP (Workers Rate Limiting binding, or a per-email DO).
- Cloudflare Access is for workforce SSO, not consumer signup.

---

## 7. Queues, Workflows and Cron for background jobs

- **Queues** (https://developers.cloudflare.com/queues/platform/limits/):
  - 128 KB messages, batches of up to 100, 5,000 msg/s per queue, 250 concurrent consumers, 100 retries, delays up to 24 h, retention up to 14 days, 25 GB backlog
  - **at-least-once delivery** (https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
  - $0.40 per M operations, where each 64 KB counts as one operation and a typical message is 3 operations
- **Workflows** (https://developers.cloudflare.com/workflows/reference/limits/, updated Sep 21, 2026):
  - 10k steps by default, up to 25k
  - 1 MiB step return value
  - 1 GB of state per instance
  - 50,000 concurrent instances (the prose says 10,000)
  - 100 creations/s per workflow
  - sleep up to 365 days
  - steps billed at $0.80 per 100k after 500k per month
- **Cron**: 250 triggers per account on Paid, 1-minute granularity, 15 min wall time for intervals of an hour or more.

Job mapping:
- **Fork-copy.** A Workflow per fork pages through the source drive's manifests (each step reads a batch from the source DO and inserts into the new DO). Steps are idempotent and keyed by `(fork_id, page)`. Shards are never copied.
- **GC.** A global refcount cannot sit in one DO.
  - Shard the refcount by hash prefix into N "shard-registry" DOs, for example 4,096 keyed by the first 3 hex characters.
  - On commit or version delete, the authority enqueues `(version_id, shard_hash, ±1)`. Queues are at-least-once, so the registry stores the `(version_id, shard_hash)` pairs themselves rather than a bare counter, which makes the operation idempotent.
  - When a shard's reference set is empty, schedule deletion after a grace period (registry DO alarm). This protects in-flight commits that uploaded a shard but haven't committed yet.
  - Delete through the R2 binding with batches of 1,000 keys.
  - Avoid full-bucket mark-and-sweep: ListObjects is Class A at $4.50/M.
  - Use R2 event notifications on `object-create` to register orphan candidates for shards that mounted clients uploaded directly.
- **Usage metering.** Authorities send per-drive byte deltas to a Queue, and a consumer aggregates them into D1. Direct-to-R2 writes are counted from R2 event notifications.
- **Billing sync.** An hourly Cron reports Stripe usage (seats, 500 GB storage blocks) and reconciles subscription state. Stripe webhooks write directly to D1.

---

## 8. Containers and Sandbox SDK (only where Workers fall short)

- **Video review product.**
  - **Cloudflare Stream** is the low-effort path:
    - $5 per 1,000 minutes stored per month
    - $1 per 1,000 minutes delivered
    - free ingest and encoding
    - files up to 30 GB
    - details: https://developers.cloudflare.com/stream/pricing/ (updated Oct 15, 2026)
  - Stream stores its own copy of the video, separate from R2 and the drive's versions.
  - **Media Transformations** handle only inputs of **at most 100 MB and 10 minutes**, H.264 MP4 only. They're good for thumbnails, spritesheets and short previews, at $0.50 per 1,000 after 5,000 per month (https://developers.cloudflare.com/stream/transform-videos/).
- **Containers running ffmpeg** for full control over HLS proxies from drive content.
  - Instance types go up to `standard-4`: 4 vCPU, 12 GiB, **20 GB disk** (https://developers.cloudflare.com/containers/platform-details/limits/, updated Oct 21, 2026).
  - The disk limit means sources over about 15 GB must be streamed, for example over a tigrisfs FUSE mount of R2 (https://developers.cloudflare.com/containers/examples/r2-fuse-mount/). FUSE "does not restrict credentials to that prefix".
  - Pricing: $0.000020 per vCPU-s, $0.0000025 per GiB-s, $0.00000007 per GB-s of disk. **Egress from containers is billed**: $0.025/GB in North America and Europe after 1 TB (https://developers.cloudflare.com/containers/pricing/). Write outputs to R2 through the Worker or binding path.
- **Sandbox SDK** (https://developers.cloudflare.com/sandbox/) runs on Containers and is Workers Paid only. It has `exec`, file APIs and R2 mounting. It is useful for "AI over drive contents" agents running tools, but plain Containers are enough for transcoding.
- **Search indexing** does not need Containers. Text extraction plus embeddings fit in Workers and Queues, with Workers AI `toMarkdown` and AI Search's converters.

---

## 9. Space Search and Space AI

- **Workers AI** (https://developers.cloudflare.com/workers-ai/platform/pricing/, updated Oct 20, 2026):
  - $0.011 per 1,000 neurons, 10k neurons per day free
  - `bge-m3` and `qwen3-embedding-0.6b`: $0.012 per M input tokens
  - `gpt-oss-120b`: $0.35 input / $0.75 output per M tokens
  - Whisper: $0.0005 per audio minute, useful for transcribing review videos
- **Vectorize** (https://developers.cloudflare.com/vectorize/platform/limits/):
  - 50k indexes per account, **20 M vectors per index**, 1,536 dimensions
  - **50k namespaces per index** (one per drive or workspace)
  - 10 metadata indexes, topK of 50 with metadata
  - Pricing: $0.01 per M queried dimensions and $0.05 per 100 M stored dimensions (https://developers.cloudflare.com/vectorize/platform/pricing/)
- **AI Search** (https://developers.cloudflare.com/ai-search/platform/limits-pricing/):
  - Data sources: R2 bucket, built-in storage, or website, with include/exclude path globs and up to 5 custom metadata fields read from `x-amz-meta-*` (https://developers.cloudflare.com/ai-search/configuration/data-source/r2/)
  - 1 M files per instance (500k with hybrid), 5,000 instances per account
  - File size caps of 4–10 MiB
  - **Billing starts Nov 1, 2026**: $0.75 per M ingestion tokens, $2/GB-month, $0.75 per 1k semantic queries
- **Gotcha: AI Search cannot index the shard bucket.** Shards are CDC fragments named by hash, not files with extensions or Content-Type. Options:
  - (a) A Queue consumer reassembles each committed file version, at most 10 MiB, into a **search-mirror** bucket at `ws/<ws>/drive/<d>/<path>` with metadata (`drive`, `version`), and points an AI Search instance per workspace at it. This duplicates storage, but only for text-like files.
  - (b) Build your own pipeline: extract, chunk, embed with Workers AI, store in Vectorize with a namespace per drive, and filter by ACL at query time. This is cheaper at scale and handles versions and forks exactly.
- In both cases, forks should **reuse embeddings by content hash** rather than re-embedding.

---

## 10. Rough monthly cost: 1 TB stored, 5 TB egress, 10 M writes

Prices come from https://developers.cloudflare.com/r2/pricing/, https://developers.cloudflare.com/durable-objects/platform/pricing/ (updated Oct 18, 2026) and https://developers.cloudflare.com/workers/platform/pricing/ (updated Oct 2, 2026).

*Assumptions (mine)*:
- Each write is one commit, which costs 1 Worker request, 1 DO request, about 1 shard PUT (small files dominate) and about 10 SQLite rows written.
- Manifests stay in the DO.
- About 20 M read requests in total, each with 1 DO metadata lookup.
- The 5 TB of egress is shard bytes, about 2.5 M shard GETs at 2 MiB. That is the worst case with no cache hits; for small files, reads could reach 25 M GETs.
- About 10 GB of DO SQLite metadata.

| Line | Calculation | $/month |
|---|---|---|
| Workers Paid base | minimum charge | 5.00 |
| R2 storage | (1,000 − 10 free) GB × $0.015 | 14.85 |
| R2 Class A (shard PUTs) | (10 M − 1 M) × $4.50/M | 40.50 |
| R2 Class B (GETs) | 2.5–25 M against 10 M free × $0.36/M | 0–5.40 |
| R2 egress, 5 TB | free | 0.00 |
| Workers requests | 30 M − 10 M included × $0.30/M | 6.00 |
| Workers CPU | about 90 M ms − 30 M included × $0.02/M | 1.20 |
| DO requests | 30 M − 1 M × $0.15/M | 4.35 |
| DO duration | about 30 M × 20 ms × 0.128 GB = 77k GB-s, under the 400k included | 0–13 |
| DO SQLite rows written | 100 M − 50 M × $1/M | 50.00 |
| DO SQLite rows read | under 25 B included | 0.00 |
| DO SQLite storage | (10 − 5) GB × $0.20 | 1.00 |
| Queues (GC and metering, about 10 M messages × 3 ops) | 29 M × $0.40/M | 11.60 |
| **Total** | | **about $135–150** |

Sensitivities:
- **SQLite rows written** is the largest DO line. Fewer rows per commit (pack the manifest delta into one BLOB row) cuts it.
- **DO duration for hot drives.** A DO that is never idle is billed for wall time: 2.63 M s × 0.128 GB ≈ 337k GB-s, about $4.20 per always-busy drive per month. A thousand constantly busy drives adds about $4k per month.
- **Zone plan.** Bodies over 100 MB need Business or Enterprise, which these pages don't price. ACM for second-level wildcard TLS is also extra and not priced on the pages I read.
- **Egress comparison.** The same 5 TB from S3 would cost hundreds of dollars. On R2 it's $0, which is the main reason to build this on Cloudflare.
- Use Cloudflare's dashboard and pricing pages for real estimates. These rates were current on the dates shown.

---

## 11. Where Cloudflare can't match Space directly, and workarounds

1. **No DO read replicas.** Multi-region metadata reads hit the single authority. *Workaround:* a per-colo Cache API metadata cache with 2 s TTL and a `x-s3sdk-consistent` bypass, or authority-pushed mirror DOs per region.
2. **`sam`/`afr`/`me` placement is nominal.** DOs don't spawn there, and R2 has no hints for those regions. *Workaround:* accept the nearest region, turn on R2 Local Uploads, and rely on edge caching for reads.
3. **Single-request PUTs are capped at 100 MB (Free/Pro) or 200 MB (Business).** *Workaround:* Enterprise (up to 5 GB), or require multipart above the cap.
4. **R2 multipart needs equal part sizes and has no conditional complete.** *Workaround:* implement S3 multipart in the gateway on top of CDC shards plus DO state. Never use R2 multipart for user objects.
5. **No per-credential revocation of R2 temporary credentials.** Revoking the parent kills all of them. *Workaround:* short TTLs (about 15 min) with refresh, a parent-token per cohort, and local JWT minting to avoid the REST API cap of 1,200 requests per 5 min.
6. **Presigned URLs don't work on custom domains.** *Workaround:* a gateway-issued HMAC block URL served through the zone cache.
7. **Second-level wildcard hosts need ACM, and Custom Domains don't take wildcards.** *Workaround:* a route plus a proxied wildcard DNS record plus Total TLS, or move the gateway to a first-level hostname.
8. **AI Search can't read CDC shards.** *Workaround:* a search-mirror bucket, or Workers AI with Vectorize.
9. **WebSockets drop on every deploy.** NATS connections survive app deploys; DO sockets do not. *Workaround:* clients reconnect with a cursor, and you deploy less often to the notify DO's Worker (a separate script).
10. **10 GB per DO and 2 MB per row.** *Workaround:* chunked manifests in R2 and offloading cold versions.
