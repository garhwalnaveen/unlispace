//! The NFS fallback [`MountAdapter`]: the loopback NFSv3 server from `nfs.rs` over the drive's
//! Vfs, mounted with `mount_nfs`.

use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::Mutex;

use async_trait::async_trait;
use nfsserve::tcp::{NFSTcp, NFSTcpListener};
use tokio::task::JoinHandle;

use crate::mount::{MountAdapter, MountError, MountHandle, MountRequest, NeedAccess};
use crate::nfs::{UlsFs, mount_args};
use crate::protocol::ErrorBody;

#[derive(Default)]
pub struct NfsAdapter {
    /// Serve and mount read-only.
    pub read_only: bool,
}

struct NfsHandle {
    mountpoint: PathBuf,
    server: Mutex<Option<JoinHandle<()>>>,
}

fn err(msg: impl Into<String>) -> MountError {
    MountError(ErrorBody::internal(msg))
}

#[async_trait]
impl MountAdapter for NfsAdapter {
    fn access(&self) -> NeedAccess {
        if self.read_only { NeedAccess::Read } else { NeedAccess::Write }
    }

    async fn mount(&self, req: MountRequest) -> Result<std::sync::Arc<dyn MountHandle>, MountError> {
        // macOS refuses mounts reached through a symlink.
        let mountpoint = std::fs::canonicalize(&req.mountpoint).map_err(|_| err("mountpoint is not an existing directory"))?;
        let md = std::fs::metadata(&mountpoint).map_err(|_| err("cannot stat mountpoint"))?;
        if !md.is_dir() {
            return Err(err("mountpoint is not a directory"));
        }
        // Fail early, and without leaking anything, if the drive or token is wrong.
        req.client.drive_info(&req.drive_id).await.map_err(|e| match e {
            uls_client::Error::NotFound { .. } => MountError(ErrorBody::new(crate::protocol::code::NO_SUCH_DRIVE, "no such drive")),
            uls_client::Error::Unauthorized | uls_client::Error::Auth(_) => MountError(ErrorBody::new(crate::protocol::code::UNAUTHORIZED, "the data plane rejected the drive token")),
            uls_client::Error::Transport(_) => MountError(ErrorBody::new(crate::protocol::code::OFFLINE, "cannot reach the data plane")),
            _ => err("cannot open drive"),
        })?;

        let fs = UlsFs::new(req.vfs, md.uid(), md.gid(), self.read_only);
        let listener = NFSTcpListener::bind("127.0.0.1:0", fs).await.map_err(|_| err("cannot bind NFS server"))?;
        let port = listener.get_listen_port();
        let server = tokio::spawn(async move {
            let _ = listener.handle_forever().await;
        });

        let out = tokio::process::Command::new("/sbin/mount_nfs")
            .args(mount_args(port, &mountpoint, self.read_only))
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        let out = match tokio::time::timeout(std::time::Duration::from_secs(30), out).await {
            Ok(Ok(o)) => o,
            Ok(Err(_)) => {
                server.abort();
                return Err(err("cannot run mount_nfs"));
            }
            Err(_) => {
                server.abort();
                return Err(err("mount_nfs did not finish within 30s"));
            }
        };
        if !out.status.success() {
            server.abort();
            return Err(err(format!("mount_nfs failed: {}", String::from_utf8_lossy(&out.stderr).trim())));
        }
        Ok(std::sync::Arc::new(NfsHandle { mountpoint, server: Mutex::new(Some(server)) }))
    }
}

#[async_trait]
impl MountHandle for NfsHandle {
    async fn unmount(&self) -> Result<(), MountError> {
        crate::nfs::unmount(&self.mountpoint).await.map_err(|e| err(e.to_string()))?;
        if let Some(s) = self.server.lock().unwrap_or_else(|e| e.into_inner()).take() {
            s.abort();
        }
        Ok(())
    }
}

impl Drop for NfsHandle {
    fn drop(&mut self) {
        if let Some(s) = self.server.lock().unwrap_or_else(|e| e.into_inner()).take() {
            s.abort();
        }
    }
}
