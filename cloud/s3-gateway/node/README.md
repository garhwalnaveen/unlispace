# Streaming S3 ingress

The Node ingress runs the same SigV4 router, checksum verifier and data-plane client as the Worker. Its HTTP socket avoids
the Worker's inbound body limit. Use it as the public S3 endpoint when accepting large PUTs or upload parts. Chunk bytes go
to the authenticated data plane; control operations and workspace multipart state cross a private, allowlisted Worker bridge.

Build and run from `cloud/s3-gateway`:

```sh
npm ci --ignore-scripts
npm run build:ingress
npm run typecheck:ingress
npm run test:ingress
node node/dist/main.mjs
```

Configure these environment variables before starting:

| Variable | Value |
| --- | --- |
| `ULS_INGRESS_BRIDGE_URL` | HTTPS origin of the S3 Worker |
| `ULS_DATA_PLANE_URL` | HTTPS origin of the data-plane Worker |
| `ULS_INGRESS_SECRET` | Random secret of at least 32 characters; also set on the S3 Worker |
| `ULS_S3_HOST` | Public S3 hostname, without a scheme or path |
| `ULS_ISSUER` | Exact issuer already trusted by the data plane |
| `ULS_JWT_PRIVATE_JWK` | Ed25519 signing JWK, with `kid`; matching public key must be trusted by the data plane |
| `PORT` | Local listener port; default `8080` |
| `ULS_LISTEN_HOST` | Listener address; default `127.0.0.1` |
| `ULS_INGRESS_PROTOCOL` | Scheme clients use for signing; default `https`, `http` for local tests |

Backend origins require HTTPS except loopback HTTP. Redirects are refused. Use a separate ingress bridge secret rather than
a customer's S3 key. The bridge can resolve derived key secrets and update multipart state, so restrict access to the ingress
host and keep its secret outside images, source control and logs.

For a container, build with `docker build -f node/Dockerfile .` from `cloud/s3-gateway`. The container runs as an unprivileged
user and contains only the bundled server. Supply secrets at runtime. A TLS reverse proxy must preserve the original `Host`,
disable request buffering and permit the intended body size. For nginx, the relevant location settings are:

```nginx
client_max_body_size 6g;
proxy_request_buffering off;
proxy_buffering off;
proxy_http_version 1.1;
proxy_set_header Host $http_host;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_pass http://127.0.0.1:8080;
```

Keep the listener private behind TLS. Point SDK clients at this endpoint explicitly; the ordinary Worker endpoint retains
its platform body limit. Deploy matching data-plane, API, S3 Worker and ingress versions before routing customer traffic.

The socket regression streams generated data through the real HTTP server and verifies shard checksums, publication and
bounded buffering. Logical-size manifest tests establish metadata handling separately; they do not measure a hosted multi-TiB
transfer or establish a production throughput guarantee.
