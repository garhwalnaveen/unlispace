# SpaceFS API comparison and implemented fixes — 31 October 2026

Compared the current Unlispace storage platform with [SpaceFS's complete documentation](https://docs.spacefs.com/llms-full.txt)
(generated 30 October 2026, s3sdk 0.4.0). Three agents investigated object operations, drives and credentials in parallel;
the coordinator implemented compatibility routing and integrated the fixes. Existing uncommitted product work was preserved.

Product checkout: `/Users/naveen/.codex/worktrees/unlispace-engine/unlispace`.
The chat's `Documents/Codex/2026-10-26/se/projects/unlispace` checkout is an older subscription starter, not the storage implementation.

## API coverage

| Area | Unlispace after this change | Status |
| --- | --- | --- |
| Standard S3 object operations | List, get/head, ranges, put, copy, delete, multipart and conditionals already existed | Implemented; capacity differences below |
| In-place edits | Offset writes, truncate/extend, ordered S3SP patches, splice, guarded rename | Already implemented |
| History | Historical reads, valid timestamp reads, content history and rollback | Implemented; timestamp and conditional-restore fixes added |
| Extension namespace | Original signed `x-s3sdk-*` request names; both response header prefixes | Added, keeping `x-uls-*` clients working |
| Drive lifecycle | Create, describe, fork, delete, aliases/IDs, placement and fork guards | Already implemented; compatibility regression coverage added |
| Drive readiness | Provisioning/forking drives report `writable:false`; renewed mounts respect current roles | Readiness fixed; role checks verified |
| Credentials | Session mint/list/revoke, signed narrower child keys, ancestral authority and cascading revocation | Already implemented; compatibility route/defaults fixed |
| Signature/checksum handling | Header and query SigV4, streaming modes, chunk/trailer signatures, supported checksum algorithms | Already implemented; compatibility headers must also be signed |
| Unsupported operations | Unsupported object subresources return 501 before any file mutation | Fixed accidental fall-through |
| Version-targeted batch delete | Per-item 501 with the requested VersionId; current content preserved | Fixed data-loss behavior |

The baseline for supported S3 calls is the [standard subset](https://docs.spacefs.com/protocol/standard-s3-subset/);
extension behavior follows the [object protocol](https://docs.spacefs.com/protocol/object-extensions/).

## Concrete changes

- The router authenticates the original signed URL and headers before translating extension names. Supplying a parameter
  or header in both namespaces is rejected. Unknown extension operations remain 501.
- `/_s3sdk/keys` supports session management and digest-bound signed child minting. Its child response is flat; successful
  revoke returns 204. The native route retains its existing shape. All key-route responses prohibit caching.
- Session-created keys default to `write` when access is omitted; invalid values and authority escalation remain rejected.
  Supplied workspace declarations must be valid and match the signing key. See the [key protocol](https://docs.spacefs.com/protocol/key-routes-s3sdk-keys/).
- A create-only restore carries `ifAbsent` through the gateway, validation and storage transaction. A competing restoration
  cannot be overwritten by a stale restore request. Existing callers can omit the new optional field.
- Historical reads reject empty, timezone-free and impossible calendar timestamps instead of silently reading a different instant.
- Bulk deletion rejects requested immutable versions per item, while still processing other permitted deletions. Unsupported
  ACL, tagging, retention and similar subresources cannot fall through to ordinary file writes/deletes.

No dependencies, database migrations, public credential formats, native mount behavior or deployed settings were changed.

## Remaining gaps and deliberate differences

Full SpaceFS parity is **not achieved**. These require storage architecture, product-policy or packaging work beyond route translation.

| Gap | Current behavior | Work needed to close it |
| --- | --- | --- |
| Large uploads | PUT and upload parts are capped at 95,000,000 bytes; commit manifests at 8 MiB | Introduce an upload ingress that supports the larger body contract, then verify memory, checksums, quotas, retries and representative large files. Multipart alone does not establish the published capacity. |
| Programmatic storage mounts | `x-uls-mount` issues a scoped native JWT; `x-s3sdk-mount` explicitly returns 501 | Implement provider credentials or an SDK mount adapter that preserves drive authorization and quota enforcement. A native token cannot substitute for the documented storage credential schema. |
| Fork complexity | Chunks are shared, but fork metadata is exported/imported across the tree | Introduce metadata snapshot/overlay references before promising constant-time forks. |
| Drive recovery | Soft-deleted metadata/content are retained; no public drive undelete/retention contract | Define retention and quota policy, then implement authorized recovery and expiry together. |
| Optional direct uploads | Direct plan/commit return 501 | Add scoped upload plans plus verified commit/quota accounting if this optional feature is needed. |
| Standard version listings | Includes retained deleted history and delete markers | This differs from SpaceFS's live-key content-only listing. Preserve existing callers until an explicit versioned contract is selected. |
| SDK distribution | Native Rust client/CLI exist; no matching four-language Unlispace package suite | Package and run language-level conformance. This change tests wire requests and AWS SDK interoperability, not published SpaceFS SDK binaries. |

Compare capacity with [SpaceFS's limits](https://docs.spacefs.com/reference/limits/) and mount/fork semantics with its
[drive protocol](https://docs.spacefs.com/protocol/drive-extensions/). No performance equivalence was measured.

## Verification

- API: complete suite, **118/118 tests passed** across 14 files; TypeScript check passed.
- Data plane: complete suite, **120/120 tests passed** across 12 files; TypeScript check passed.
- Gateway: final complete suite, **107/107 tests passed** across 16 files; TypeScript check passed.
- Gateway tests use real SigV4 and the AWS SDK with fake control/data-plane bindings. The conditional-restore regression also
  runs against the actual local storage authority through the data-plane suite.
- Fixture startup warnings about absent deployment secrets do not establish anything about production configuration.

Not verified: deployment, live secrets, hosted service bindings, published third-party SDK binaries, provider mount credentials,
large-object capacity, constant-time forks or production performance. No production data was touched.
