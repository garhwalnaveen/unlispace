# Local Worker + Rust CLI/SMB daemon E2E gate

From the repository root:

```sh
bash tests/e2e/run.sh
```

Requires Node 22+, the existing pinned `cloud/api/node_modules` dependencies (Wrangler
4 and TypeScript), and an already-built `engine/target/debug/ulsd`. Build that binary
with `cargo build -p ulsd --features smb --manifest-path engine/Cargo.toml` to include SMB; the runner
never installs packages, rebuilds the engine, or changes the repository's Workers,
configuration, keys, or local databases. It copies the executable into its temporary
directory so concurrent builds cannot change adapters mid-run. On macOS, native NFS requires the system
`mount_nfs` permission. The runner never uses sudo or changes system settings.

It generates ephemeral Ed25519 and block-signing keys, copies the current JSONC Worker configuration
to a private `/tmp/unlispace-e2e.*` directory, points entrypoints and migrations back
at the real source, applies D1 migrations with `--local`, then starts two installed
Wrangler v4 processes. The data plane listens on 8787 with `--inspector-port 9230`;
the API uses 8788 and inspector 9231. Their isolated local service registry connects
the real `DataPlaneAdmin` service binding. Static dev-token authentication is disabled.
OTP delivery is forced to the dev email log, and the parser supports both current
`[email:dev] to=` and historical Miniflare `To:` output. OTPs and credentials are
never printed by the harness.

Occupied ports fail setup without touching their owners. To run alongside another
agent's local Workers, explicitly override all three ports:

```sh
E2E_API_PORT=18788 E2E_DATA_PORT=18787 E2E_INSPECTOR_PORT=19230 bash tests/e2e/run.sh
```

On an ordinary Mac the CLI is wrapped with `sandbox-exec` to deny writes to its
hard-coded `~/Library/Caches/com.unlispace` cache; downloads still work with the
cache disabled. A managed filesystem sandbox may forbid nesting `sandbox-exec`.
**Only when that parent sandbox already denies writes to this cache**, use
`E2E_MANAGED_SANDBOX=1` to acknowledge that protection. This does not change `HOME`,
touch Keychain, or run the persistent per-user daemon. On Linux `XDG_CACHE_HOME` redirects
the CLI cache to the temp directory; the native macOS NFS check fails explicitly.

## Assertions

The 16 numbered cloud checks retain the coverage of
`docs/agents/m1-cloud-e2e.sh`: OTP start/log/wrong-code/session; personal org and
drive provisioning; token minting/verification; shard PUT/commit/actor attribution;
drive isolation/read-only scope/wrong token type; and refresh rotation/reuse/family
revocation. The wrong OTP is chosen to differ from the actual code, including when
the real code happens to be `000000`.

Eight engine checks use the multicall CLI against those real Workers:

1. Upload and download a deterministic 8 MiB fixture; compare every byte.
2. Upload it again; require zero uploaded shards and a new version.
3. Change exactly the last 4096 bytes; require exactly one uploaded shard, one new
   manifest hash, and a byte-identical download. Editing the tail keeps unaffected
   FastCDC boundaries stable. This is a full CLI put, not the VFS journal publisher.
4. List three ordered versions and download the first version explicitly.
5. Restore the first version; require a new head and original bytes.
6. Run two concurrent CLI puts against the same `--if-version`; require exit codes
   0 and 2, a precondition error for the loser, exactly one additional version,
   and the winner's bytes at head.
7. Start a second CLI process with a separately minted read token. Wait for replay
   to prove the watcher is connected, then require the exact new path/version in
   less than 1000 ms from writer invocation. This includes process launch, upload,
   commit and delivery; it is stricter than timing from commit acknowledgment.
8. Restore the large fixture, mount it through the CLI with the read token at a
   canonical `/private/tmp/.../mount` path, verify a read-only NFS kernel mount,
   compare all 8 MiB with `cmp`, and require a write to fail. Explicit `--read-only`
   and `--state-dir` keep this check read-only with an isolated journal.

## SMB daemon phase

SMB runs automatically when the copied `engine/target/debug/ulsd` contains the
compiled SMB adapter. `E2E_SMB=1` requires the phase (and fails if the binary lacks
that feature); `E2E_SMB=0` explicitly disables it. Detection uses the adapter's
compiled mount error string; no daemon is started to probe features.

```sh
cargo build -p ulsd --features smb --manifest-path engine/Cargo.toml
E2E_SMB=1 bash tests/e2e/run.sh
```

Ten additional checks exercise the actual daemon and macOS kernel SMB mount:

1. Sign in again via dev OTP (the cloud auth checks revoked their session family),
   mint a separate write token for the second CLI client, and start the daemon with
   a temporary `--state-dir`, `--socket`, and `--secret-store memory`. Send newline
   JSON `auth.set`, `drives.list`, and `drive.mount`. Verify `smbfs` in the kernel
   mount table before any filesystem writes.
2. Save text and compare the remote bytes through the independent CLI within 10 s.
3. `cp` an 8 MiB random file and compare every remote byte within 10 s.
4. `mkdir -p a/b`, move the text into it, compare remote contents, and verify the
   old path is absent.
5. Rename a temporary file over a previously published destination; verify the
   replacement bytes and absence of the temporary path remotely.
6. Remove the previously published large file; require remote absence within 10 s.
7. Set and read back an xattr; verify file bytes remain intact remotely. This does
   not assert cross-client xattr persistence.
8. Warm the local directory/negative lookup, commit a new file through the second
   CLI, then require identical mounted bytes and a daemon `change` event within
   5 s, including the CLI invocation.
9. Save locally, then commit remotely with the original `--if-version` during the
   VFS's 2 s quiet window. Require a daemon `conflict` event, a listed conflict copy,
   the remote head unchanged by publication, and both edits byte-identical remotely.
   If the remote writer misses this race, the assertion fails rather than retries
   hiding it.
10. Send `drive.unmount`, verify unmounted protocol state, terminate the daemon
    gracefully, and require zero remaining mounts under its isolated mount root.

The socket parser has dependency-free local tests for frame fragmentation,
interleaved events, pipelined/out-of-order responses, errors, deadlines, and close.
Native macOS filesystem permissions are required. Mount failures remain FAILs;
plain local-directory writes never stand in for SMB results.

Each assertion produces a PASS/FAIL row. Failures do not suppress independent
checks; dependent checks fail with their missing prerequisite. Setup failure stops
the workload and still runs cleanup. Any failed row returns exit status 1. There
are 26 rows without SMB, or 36 with SMB: setup + 16 cloud + 8 engine +
10 SMB + cleanup.

Workers, CLI subprocesses and their descendants run in owned process groups. The
runner has bounded startup/HTTP/CLI/mount waits; EXIT/INT/TERM traps stop children,
unmount before stopping filesystem servers, and delete temporary keys, logs, fixtures, databases
and caches. If unmount fails, cleanup fails and preserves the mount directory
instead of recursively deleting through a mounted filesystem. Fixture and shard
data stay below 64 MiB. No external test service, deployment, global install, or
remote Cloudflare resource is used. Wrangler telemetry, update banners and
Miniflare's external `cf.json` fetch are disabled. SIGKILL cannot be trapped.

## Harness checks

No build step or additional dependency is needed. Syntax checks are the lint gate:

```sh
bash -n tests/e2e/run.sh
node --check tests/e2e/harness.mjs
node --check tests/e2e/helpers.mjs
node --check tests/e2e/helpers.test.mjs
node --check tests/e2e/daemon-socket.mjs
node --check tests/e2e/daemon-socket.test.mjs
node --test tests/e2e/helpers.test.mjs tests/e2e/daemon-socket.test.mjs
bash tests/e2e/run.sh
```

Parser/fixture self-tests run without Workers or network access. They verify both
OTP log layouts, recipient isolation, upload metric parsing, exact watch matching,
and deterministic fixture/edit generation. The end-to-end gate does not verify
the GUI, Google login, Keychain sessions, writable NFS, offline/reconnect
recovery, deployment, or production latency. Without the SMB phase it also does
not verify writable SMB, VFS publication, or daemon conflict events.
