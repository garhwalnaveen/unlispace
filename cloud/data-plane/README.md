# Unlispace data plane (M0)

One Cloudflare Worker plus a SQLite-backed Durable Object (`DriveAuthority`, one per drive) and an R2 bucket (`SHARDS`).
Implements `docs/design/m0-contract.md`. The Worker does auth, routing and shard I/O (SHA-256 verified while streaming into R2).
The DO does all metadata: commits, preconditions, versions, listing, change log and the WebSocket watch (hibernation API).

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars   # then edit ULS_DEV_TOKEN
npm run dev                      # wrangler dev on http://127.0.0.1:8787, local R2 + DO, nothing remote
npm run smoke                    # in another terminal (curl smoke test)
npm test                         # vitest in the Workers runtime (local R2 + DO)
npm run typecheck
```

`npm run deploy` runs `wrangler deploy`. It needs a real R2 bucket named `unlispace-shards-dev` and `wrangler secret put ULS_DEV_TOKEN`. It was not run.
`npm run types` regenerates `worker-configuration.d.ts` after editing `wrangler.jsonc`.

## Endpoints (all but `/healthz` need `Authorization: Bearer <ULS_DEV_TOKEN>`)

- `GET /healthz`
- `PUT /v0/drives/{id}`, `GET /v0/drives/{id}`
- `POST /v0/drives/{id}/shards/missing`, `PUT|GET /v0/drives/{id}/shards/{hash}` (GET supports one `Range`)
- `POST /v0/drives/{id}/commit`, `POST /v0/drives/{id}/restore`
- `GET /v0/drives/{id}/stat|list|manifest|versions|changes`
- `GET /v0/drives/{id}/watch?since=N` (WebSocket; `?token=` or header auth)

Deviations and interpretations of the contract are in `CONTRACT-NOTES.md`.

## Layout

- `src/index.ts` Worker: auth, routing, shard PUT/GET, missing-shard HEAD checks
- `src/drive.ts` `DriveAuthority` Durable Object
- `src/validate.ts`, `src/types.ts`, `src/ulid.ts` helpers
- `test/` vitest suite, `scripts/smoke.sh` curl smoke test
