# Codex orchestration rules (read before your TASK)

You are one of several Codex agents working in parallel on **Unlispace**, a versioned cloud
drive (a spacefs.com clone) on Cloudflare plus a native macOS client. Repo: `/Users/naveen/unlispace`,
branch `m0-spike`. The coordinator (Claude) reviews, integrates and commits your work.

## Hard rules
- Write ONLY inside the directories your task names. Read anything. Other agents are writing
  other directories right now. If you need a change elsewhere, describe it in a `NEEDS.md`
  inside your own directory.
- Never: `git commit`/`push`/`reset`/`checkout`, `sudo`, edit System Settings or `/etc`,
  `launchctl`, deploy (`wrangler deploy`), create remote Cloudflare/AWS resources, or call
  external services in tests.
- Disk is tight (about 3 GB free). No `cargo build --release`. Reuse `engine/target`. Keep test
  data ≤ 64 MiB, in tempdirs under `/tmp`, and delete it afterwards. Don't install new toolchains.
- Pin dependencies to exact versions. To add a Rust dependency, append one line to
  `[workspace.dependencies]` in `engine/Cargo.toml`. That's the only shared-file edit allowed.
  npm: exact versions.
- No secrets in committed files. Never print tokens.
- Specs are normative: `docs/design/product-design.md`, `docs/design/m0-contract.md` (with the
  amended §3.5–3.6), `docs/design/m1-contract.md`, `mac/DAEMON-PROTOCOL.md`. If a spec is wrong or
  ambiguous, follow the most reasonable reading and record it in your report.
- Finish with the build, lint and test commands your task lists, all green. Report honestly:
  paste the summary lines, and say what you did NOT verify.

## Repo map
- `cloud/data-plane`: Worker plus the DriveAuthority Durable Object (shards, commits, versions, watch). 64 tests.
- `cloud/api`: control plane on D1 (auth, orgs, drives, drive tokens). 48 tests.
- `web`: Vite/React SPA. 26 tests.
- `engine/` Rust workspace:
  - `uls-chunk`: FastCDC
  - `uls-proto`
  - `uls-client`: HTTP client, TokenProvider, ev-cursor watch
  - `uls-mock`: in-memory contract server
  - `uls-auth`: Keychain session
  - `uls-vfs`: writable FS core (journal, publisher, conflicts)
  - `ulsd`: daemon, socket protocol, CLI, NFS mount
  - `smb/`: a separate workspace with the SMB2/3 server and the `SmbBackend` trait. Its native mount passes 11 of 13 checks.
- `mac`: SwiftUI menu-bar app (SPM, CLT only). Test with `bash mac/scripts/test.sh`.
