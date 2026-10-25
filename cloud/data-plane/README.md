# Unlispace data plane (M1 auth)

One Cloudflare Worker plus a SQLite-backed Durable Object (`DriveAuthority`, one per drive) and an R2 bucket (`SHARDS`).
Implements `docs/design/m0-contract.md` with the M1 auth and drive lifecycle of `docs/design/m1-contract.md` §2-§4. The Worker does auth, routing and shard I/O (SHA-256 verified while streaming into R2).
The DO does all metadata: commits, preconditions, versions, listing, change log and the WebSocket watch (hibernation API).

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars   # then edit ULS_DEV_TOKEN; ULS_JWT_PUBLIC_JWKS comes from cloud/scripts/dev-keys.mjs
npm run dev                      # wrangler dev on http://127.0.0.1:8787, local R2 + DO, nothing remote
npm run smoke                    # in another terminal (curl smoke test)
npm test                         # vitest in the Workers runtime (local R2 + DO)
npm run typecheck
```

`npm run deploy` runs `wrangler deploy`. It needs a real R2 bucket named `unlispace-shards-dev` and `wrangler secret put ULS_JWT_PUBLIC_JWKS`, and `ULS_ALLOW_DEV_TOKEN` must be overridden to `"0"` (it is `"1"` in `wrangler.jsonc` for local dev). It was not run.
`npm run types` regenerates `worker-configuration.d.ts` after editing `wrangler.jsonc`.

## Auth

`Authorization: Bearer <drive token>` (on `/watch` upgrades only, `?token=` is also accepted). A drive token is an
EdDSA (Ed25519) JWT issued by `cloud/api`; it is verified with WebCrypto against `ULS_JWT_PUBLIC_JWKS` (key picked by
`kid`), `iss == ULS_ISSUER`, `exp` (+-30 s), `typ == "drive"`.

- `read`: GET `stat|list|manifest|versions|changes|watch`, `GET /v0/drives/{id}`, shard GET, `POST shards/missing`.
  `write`: shard PUT, `commit`, `restore`. The drive must be in the token's `drives` claim with enough access, else
  `404 no_such_drive`. Bad, expired or missing token: `401 unauthorized`.
- `actor` on versions is the token `sub` (`dev` for the dev token).
- `ULS_DEV_TOKEN` is an admin on all drives only while `ULS_ALLOW_DEV_TOKEN == "1"` (dev only; off in production). The
  public `PUT /v0/drives/{id}` exists only for it. The api provisions drives through the `DataPlaneAdmin`
  WorkerEntrypoint (service binding `DATA_PLANE`, `entrypoint: "DataPlaneAdmin"`): `createDrive` (throws
  `DriveExistsError` on a duplicate), `deleteDrive` (soft; the DO answers 404 and closes sockets with 4404), `driveStats`.
- A WebSocket is closed with code `4401` when its token expires (the DO alarm, hibernation-safe); clients reconnect
  with a fresh token.

## Endpoints (all but `/healthz` need a bearer)

- `GET /healthz`
- `PUT /v0/drives/{id}` (dev token only), `GET /v0/drives/{id}`
- `POST /v0/drives/{id}/shards/missing`, `PUT|GET /v0/drives/{id}/shards/{hash}` (GET supports one `Range`)
- `POST /v0/drives/{id}/commit`, `POST /v0/drives/{id}/restore`
- `GET /v0/drives/{id}/stat|list|manifest|versions|changes` (`versions` and `changes` are paginated)
- `GET /v0/drives/{id}/watch?after=<ev>|since=<seq>` (WebSocket)

Deviations and interpretations of the contract are in `CONTRACT-NOTES.md`.

## Layout

- `src/jwt.ts` drive-token verification (WebCrypto Ed25519)
- `src/index.ts` Worker: auth, routing, `DataPlaneAdmin`, shard PUT/GET, missing-shard HEAD checks
- `src/drive.ts` `DriveAuthority` Durable Object
- `src/validate.ts`, `src/types.ts`, `src/ulid.ts` helpers
- `test/` vitest suite, `scripts/smoke.sh` curl smoke test
