# Space comparison implementation status — 26 October 2026

Work is in the restored `m0-spike` checkout at
`/Users/naveen/.codex/worktrees/unlispace-engine/unlispace`. The older `main` checkout contains
the original billing application, not the native/cloud product reviewed by Claude.

## What was already complete

The persistent workspace, categorized settings, transfers, offline pins, appearance,
permissions guidance, shortcuts, browser sign-in/daemon handoff, native file operations,
recovery and development packaging were present. Previous acceptance and benchmark reports
remain historical evidence; a reset installation is not assumed to retain their sessions.

## Added in this pass

| Gap | Implementation | Limits |
| --- | --- | --- |
| Search | Search files page, authenticated daemon bridge, derived SQLite trigram filename index, bounded pagination, current paths after renames, Finder actions | Filename substring search, at least 3 characters. No full-content, semantic, Mail, Calendar or local-disk indexing |
| Drive creation | Workspace page creates drives through the existing role-checked API; My drives exposes New drive | Requires a signed-in real daemon and appropriate organization role |
| Teams | Member list, invitations by email, explicit recipient acceptance, revoke/change/remove, seat reservations and final-owner protection; web and desktop navigation | Active paid Teams plan and configured email delivery required for invitations |
| Billing | Desktop workspace links to the existing organization billing page using the API's configured web origin | Billing remains in the browser; payment provider configuration is required for checkout |
| AI | Ask AI is one shadcn AI Elements chat (Conversation, Message, PromptInput, ModelSelector, Reasoning) in the web app at `/ai`, embedded in the Mac app through a WebView signed in by a one-time PKCE handoff. Managed Kimi K3 and K3.1 Pro models run on the Unlispace Moonshot key with a free per-user daily cap | Requires `MOONSHOT_API_KEY` on the API. Only typed text is sent. No file attachments, autonomous file tools or whole-drive RAG. "Sign in with ChatGPT" is deferred until OpenAI approves eligibility |
| Transfer implementation | Hardware AES on Apple Silicon; release VFS journal lock before cloud reads; skip redundant cached-metadata journal fsyncs; reuse verified disk shards in bounded RAM cache; yield during large publication folds to keep SMB requests responsive | Signing remains enforced. Original hosted 50 MB/1 GB timings are not replaced by theoretical speed claims |
| Desktop concurrency | Cancelled socket calls release their continuations, late responses are ignored, and request writes are serialized; workspace requests guard account changes | Cancelling a UI request cannot roll back a mutation already accepted by the server |

## Deployment and setup

- Apply `cloud/api/migrations/0004_team_invitations.sql` using the existing deployment
  workflow; the local E2E harness discovers it automatically.
- Deploy updated API, data-plane and web together for teams, search and desktop web links.
  No production deployment or billing/email mutation is part of the local validation.
- Rebuild the daemon from `engine/` so its Cargo configuration enables runtime-detected ARM AES.
  Build an SMB-enabled daemon and bundle it with the macOS client.
- Ask AI uses managed Kimi models with a free daily allowance; no provider setup is needed.

## Validation

- API: typecheck and 89 tests passed, including transactional seat admission and concurrent
  final-owner protection. No actual invitation email was sent.
- Web: production build and 58 tests passed, including team navigation, invitation acceptance
  and role controls.
- Data plane: typecheck and 97 tests passed, including indexed search authorization,
  Unicode/literal matching, detached-node pagination, renamed paths, fork imports and
  snapshot restoration.
- Client/VFS: 77 tests passed in the initial gate; the final focused VFS gate passed 36 tests,
  including publisher fairness and growing-file regressions. Signed SMB/vendor/bridge suites
  passed, including a 50 MiB
  FLUSH/CLOSE/reopen wire roundtrip; see the performance follow-up for exact boundaries.
- Rust daemon: SMB-enabled build and its test suites passed; native mount tests gated by the
  repository are independently covered by the local E2E run when available.
- Swift: 69 library/protocol tests, 17 app tests, and the isolated daemon integration gate
  passed. Default Keychain/Handoff tests remain opt-in; the external browser-worker fixture
  is skipped by the default gate. Socket cancellation/concurrent framing tests passed.
- The final development app and DMG rebuilt with the optimized SMB daemon and passed deep
  signature verification and read-only installer mount checks. Live inspection
  confirmed Search files, Workspace and Ask AI navigation/keyboard entry points and readable
  controls. The existing hosted API lacks the new client-config endpoint and displays an
  update-required message; this local rebuild does not deploy its backend.
- Local E2E with 50,000,000 random bytes: **53 checks passed, zero failed**, including native
  NFS/SMB, search/workspace daemon bridges, cold remount integrity, offline pin reads during
  data-plane suspension, S3/key/fork/quota tests, and cleanup.
- Final optimized local E2E with 1,000,000,000 random bytes: **53 checks passed, zero failed**.
  Native write/fsync/close completed in **15.11 s** (fsync **2.82 s**, close **0.01 s**).
  Publication plus independent length/SHA-256 verification took **140 s** after native
  acceptance. Cold remount retrieval from an empty isolated disk shard cache matched in
  **20.19 s**. This validates the reproduced failure locally; it is not a matched hosted
  comparison against Space. The retained table is `tests/e2e/last-run.txt`.

Membership removal stops new grants immediately; existing drive JWTs can remain valid for
up to 15 minutes and warmed gateway caches may lag by 30 seconds.

## Outstanding acceptance

A successful configured-provider response, real invitation email delivery, production
migration/deployment, complete VoiceOver use, Developer ID/notarization/update publishing,
and a matched release-engine hosted comparison require their own live acceptance.
The reports' larger content-search/source-integration and autonomous AI behavior remain
product expansions beyond the implemented filename search and explicit text assistant.


## Review artifacts

- `mac/build/Unlispace.app`
- `mac/build/Unlispace-0.2.0.dmg`

These artifacts embed the tested release SMB engine. They are ad hoc signed for review;
the installed app/daemon and hosted deployment were not replaced. All source changes remain
uncommitted in the checkout named above.
