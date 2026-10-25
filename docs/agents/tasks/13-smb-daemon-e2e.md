# 13 · High stakes (gpt-6.1-sol): writable SMB drive through the daemon, end to end  — write in: tests/e2e/, engine/ulsd/ (only if a real bug blocks the test)
Goal: prove the product's core promise locally. A daemon mounts a drive over **SMB** (default
adapter with `--features smb`), a user saves files in that folder, the bytes reach the cloud, and a
second client sees them.
Read: tests/e2e/README.md + harness.mjs (already starts api+data-plane Workers locally with ephemeral
keys, signs in via dev OTP, drives the CLI: last run 26/26), engine/ulsd/README.md (daemon flags
`--socket --state-dir --secret-store memory`), mac/DAEMON-PROTOCOL.md (`auth.set`, `drive.mount`,
events), engine/smb/README.md + VERIFICATION.md (native SMB smoke 16/16).
Add an `smb` phase to the harness (opt-in flag `E2E_SMB=1`, default on when `engine/target/debug/ulsd`
was built with `--features smb`; the runner may build it with `cargo build -p ulsd --features smb
--manifest-path engine/Cargo.toml` once, debug only):
1. start `ulsd daemon --state-dir <tmp> --socket <tmp>/ulsd.sock --secret-store memory` against the
   local Workers; speak the socket protocol (newline JSON) from Node: `auth.set` with the session
   from the OTP sign-in, `drives.list`, `drive.mount`.
2. in the SMB mountpoint: write a text file, `cp` an 8 MiB random file, `mkdir -p a/b`, `mv`,
   rename-over-existing (safe save), `rm`, set an xattr.
3. assert via a second independent client (the `uls` CLI with a fresh drive token, or the data plane
   HTTP API) that contents are byte-identical remotely within 10 s, and that removed files are gone.
4. remote → local: commit a file via the CLI; assert it appears in the SMB folder within 5 s
   (change-notify / watch invalidation).
5. conflict: edit the same file remotely and locally before publish; assert a conflict copy exists
   and both contents survive; capture the daemon's `conflict` event.
6. `drive.unmount`, daemon shutdown, no mounts left (trap on exit).
If a step fails because of a real bug in ulsd/uls-vfs/smb, fix it minimally in engine/ulsd/ (or
describe it in tests/e2e/NEEDS.md if it lives elsewhere) and add a regression test.
Gate: `bash tests/e2e/run.sh` → all PASS (existing 26 + new SMB checks); paste the table into
tests/e2e/last-run.txt. Never print tokens. No sudo, no deploy, no commit. Report ≤ 250 words.
