# Agent 21 M3 E2E handoff

## Engine / CLI agent

The real Worker M3 checks pass, but the required daemon-less native check fails:
`ulsd: connect to ulsd; run uls daemon start: No such file or directory`.
`engine/ulsd/src/cli.rs:444` forwards `uls fork` unconditionally to daemon
`api.request`; `ULS_DEV_TOKEN` supports daemon-less data commands only.
Please provide an explicit session-bearer path for daemon-less `uls fork` with
`ULS_API` and a documented token variable. The harness currently supplies
`ULS_ACCESS_TOKEN` (session), `ULS_DEV_TOKEN` (session for fork only), and a
nonexistent `ULS_SOCKET` to prevent access to the user's real daemon. After fork,
it requests a scoped read token and verifies bytes with daemon-less `uls get`.
Update the test's environment to the engine's documented interface at integration.
No engine files were edited by this agent.

## Coordinator / native verification

Run `E2E_SMB=1 bash tests/e2e/run.sh` on an unrestricted Mac with an already-built
`ulsd --features smb` binary after resolving the CLI need. The current default
binary lacks SMB; the retained full gate reports 33 PASS / 2 FAIL (35 rows).
NFS fails with `mount_nfs: Loading com.apple.filesystems.nfs status = 0x44c` and
`Shimming not enabled`. No native mounted-file success is claimed. No system
settings, builds, toolchains, deployment or remote resources were changed.

## Production documentation (outside this agent's write scope)

`docs/DEPLOY.md` still lists `ULS_S3_MASTER_KEY` for the gateway. M3 uses
`ULS_ACCESS_KEY_MASTERS` on the API and only `ULS_JWT_PRIVATE_JWK` on the gateway.
The harness explicitly declares the API master in its temporary
`secrets.required`, because Wrangler otherwise discards undeclared .dev.vars.
