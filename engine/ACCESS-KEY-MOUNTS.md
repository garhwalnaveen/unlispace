# Programmatic mounts with an S3 key

A drive-scoped Orbit S3 access key can open a native filesystem mount without a login session. The native engine exchanges the key for a short-lived drive token, renews it before expiry, and refuses a grant that changes the resolved drive ID. Read-only grants force a read-only filesystem and are also checked by the data client before writes.

```sh
export ULS_S3_ENDPOINT=https://your-orbit-s3-endpoint
export ULS_S3_ACCESS_KEY_ID=your-access-key-id
export ULS_S3_SECRET_ACCESS_KEY=your-secret
mkdir -p /path/to/mount
uls mount drive-alias /path/to/mount --foreground
```

Credentials come from environment variables and are never command-line arguments or log output. The mount runs until interrupted; renewal never creates a login session. A revoked key prevents the next renewal. The current token remains valid until its expiry, as for other native drive tokens.

The exchange verifies the original SigV4 request, disables HTTP redirects, bounds credential responses, and keeps the resolved drive identity fixed across renewals. A permission downgrade applies when the grant refreshes; subsequent data-client writes are refused locally as well as by the data plane.

The same provider is public in the Rust client:

```rust,no_run
use uls_client::{AccessKeyTokenProvider, Client};
# async fn example() -> uls_client::Result<()> {
let provider = AccessKeyTokenProvider::new(
    "https://your-orbit-s3-endpoint",
    "drive-alias",
    std::env::var("ULS_S3_ACCESS_KEY_ID").unwrap(),
    std::env::var("ULS_S3_SECRET_ACCESS_KEY").unwrap(),
)?;
let grant = provider.grant().await?;
let client = Client::builder(grant.endpoint, "")
    .token_provider(provider)
    .build()?;
let info = client.drive_info(&grant.drive_id).await?;
# Ok(())
# }
```

This adapter uses Orbit's authoritative metadata and existing native NFS/VFS implementation. Space's proprietary `supervised-mount` process consumes a different metadata engine format; raw access to the shared R2 shard lineage would neither implement that format nor safely isolate forks. The native adapter therefore uses the authenticated drive API and never gives clients broad R2 credentials.

CLI mounts currently use the existing macOS NFS adapter. Linux FUSE and Windows drive mounting are separate adapters, not provided by this change.

The real local gateway handshake can be checked without mounting a kernel filesystem:

```sh
# Install spacefs-s3sdk==0.4.0 in a Python environment first.
cd cloud/s3-gateway
ULS_SDK_RUST=1 ULS_SDK_PYTHON=/absolute/path/to/python node node/sdk-test.mjs
```

This runs the published Python SDK and the Rust mount provider against a local HTTP fixture with real gateway authentication. It checks writable/read-only grants and renewal, but does not establish hosted connectivity or kernel mount acceptance.
