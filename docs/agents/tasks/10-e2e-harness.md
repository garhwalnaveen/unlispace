# 10 · End-to-end harness  — write in: tests/e2e/ (new, repo root)
Build a reproducible local E2E runner (`tests/e2e/run.sh` + a Node/TS or bash harness, no new
global installs) that: starts cloud/api (8788) and cloud/data-plane (8787, `--inspector-port 9230`)
with `wrangler@4 dev --local` (applying D1 migrations), signs a user in via OTP (dev email log —
see how docs/agents/m1-cloud-e2e.sh parsed the miniflare email output), mints drive tokens, then exercises
the Rust CLI (`engine/target/debug/ulsd`, multicall) put/get/versions/restore/watch and a
read-only NFS mount (mountpoint under /tmp) against the real Workers, with a second client
watching changes. Include the 16 cloud checks from docs/agents/m1-cloud-e2e.sh plus engine checks (dedup,
4 KiB edit uploads 1 shard, concurrent ifVersion one winner, watch latency < 1 s, NFS read
byte-identical). Must clean up processes, mounts and temp data on exit (trap). Produce a
PASS/FAIL table and exit non-zero on failure. Document in tests/e2e/README.md. Run it and report
the real table.
