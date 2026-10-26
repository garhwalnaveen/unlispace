# Integration needs for 16-s3-gateway-m3

- **API agent:** deploy the normative M3 `ControlPlane` entrypoint on `unlispace-api`, with all §3.3 methods and coded errors. The gateway binds `CONTROL_PLANE` to that entrypoint and `API` to its default fetch handler for session `/keys` forwarding. Real credentials never use `MemoryKeyResolver` or an S3 master secret in this Worker.
- **Coordinator:** exercise real ControlPlane/DataPlane service bindings, real D1 key revocation and ancestor/current-role changes, quota/placement/fork operations and native-client rename/history before declaring production parity. No deployment or remote-service calls were made here.

Rename history and historical manifests now come from data-plane node identity; the gateway's
history/archive storage paths have been removed. S3-specific operation annotations remain
separate S3State writes after commits, so their cross-DO atomicity is still unverified.
