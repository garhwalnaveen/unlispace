# Orbit

Cloud drives that mount in Finder, with version history, forks, a web file browser and an
S3-compatible API. Hosted at [orbitfs.io](https://orbitfs.io).

## Layout

| Path | What it is |
| --- | --- |
| [`web/`](web/README.md) | React/Vite single-page app: sign-in, file browser, billing, team and access keys |
| [`cloud/api/`](cloud/api/README.md) | Control-plane Worker on D1: accounts, sessions, workspaces, drives, billing, access keys |
| [`cloud/data-plane/`](cloud/data-plane/README.md) | Storage Worker: one Durable Object per drive, content-addressed blocks in R2 |
| [`cloud/s3-gateway/`](cloud/s3-gateway/README.md) | S3-compatible Worker in front of the data plane |
| `cloud/shared/` | TypeScript shared by the Workers (JWT, chunking, contract types) |
| [`engine/`](engine/README.md) | Rust workspace: `uls` CLI, `ulsd` daemon, SMB/NFS mount adapters |
| [`mac/`](mac/README.md) | SwiftUI macOS app that drives the daemon |
| [`tests/e2e/`](tests/e2e/README.md) | End-to-end harness against local Workers and the engine |
| `docs/design/` | Wire and control-plane contracts, product design |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Production deployment |

Each package installs and builds on its own; there is no root package.

## How requests flow

1. A client signs in through `cloud/api` and receives a short-lived access token and a rotating
   refresh token.
2. For each drive it opens, the client asks `cloud/api` for a drive token scoped to that drive
   and access level.
3. The client talks to `cloud/data-plane` directly with the drive token. The control plane is
   not on the file read/write path.
4. S3 clients go through `cloud/s3-gateway`, which resolves an access key with `cloud/api` and
   then uses the data plane like any other client.

Per-drive state lives in its own Durable Object and file content in R2, so storage load spreads
across drives. `cloud/api` keeps only metadata in D1; a 15-minute cron meters usage and prunes
expired rows.

## Develop

Requires Node 22 or later and a stable Rust toolchain. The Mac app needs macOS 14 and Xcode.

```sh
# Control plane (http://127.0.0.1:8788) and data plane (http://127.0.0.1:8787)
cd cloud/data-plane && npm ci && npm run dev
cd cloud/api && npm ci && npm run db:migrate:local && npm run dev

# Web app (http://127.0.0.1:5173)
cd web && npm ci && cp .env.example .env.local && npm run dev
```

Local signing keys and `.dev.vars` setup are described in the package READMEs.

## Check

CI (`.github/workflows/ci.yml`) runs these on every pull request:

```sh
cd web && npm run typecheck && npm test
cd cloud/<worker> && npm run types && npm run typecheck && npm test   # api, data-plane, s3-gateway
cd engine && cargo check --workspace --all-features && cargo test --workspace
node --test tests/e2e/*.test.mjs   # needs cloud/s3-gateway installed
```

## License

GPL-3.0. See [LICENSE](LICENSE).
