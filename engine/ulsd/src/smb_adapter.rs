//! Authenticated loopback SMB mount backed by the mounted drive's writable VFS.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use uls_smb::{RunningServer, SmbBackend};
use uls_vfs_backend::VfsBackend;

use crate::mount::{MountAdapter, MountError, MountHandle, MountRequest, NeedAccess};
use crate::protocol::{ErrorBody, code};

pub struct SmbAdapter;

struct SmbHandle {
    mountpoint: PathBuf,
    server: Mutex<Option<RunningServer>>,
}

fn err(message: &'static str) -> MountError {
    MountError(ErrorBody::internal(message))
}

#[async_trait]
impl MountAdapter for SmbAdapter {
    fn access(&self) -> NeedAccess { NeedAccess::Write }

    async fn mount(&self, req: MountRequest) -> Result<Arc<dyn MountHandle>, MountError> {
        let mountpoint = std::fs::canonicalize(req.mountpoint).map_err(|_| err("cannot open SMB mountpoint"))?;
        req.client.drive_info(&req.drive_id).await.map_err(|error| match error {
            uls_client::Error::NotFound { .. } => MountError(ErrorBody::new(code::NO_SUCH_DRIVE, "no such drive")),
            uls_client::Error::Unauthorized | uls_client::Error::Auth(_) => MountError(ErrorBody::new(code::UNAUTHORIZED, "cannot authorize drive")),
            _ => MountError(ErrorBody::new(code::OFFLINE, "cannot reach the data plane")),
        })?;
        let backend: Arc<dyn SmbBackend> = Arc::new(VfsBackend::new(req.vfs));
        let server = uls_smb::serve(backend, false).await.map_err(|_| err("cannot start SMB server"))?;
        let target = mountpoint.clone();
        // Credentials stay in memory and are never included in daemon errors or logs.
        let server = tokio::task::spawn_blocking(move || {
            uls_smb::mount(server.addr, &server.user, &server.password, target)
                .map_err(|_| err("cannot mount loopback SMB share"))?;
            Ok::<_, MountError>(server)
        }).await.map_err(|_| err("SMB mount task failed"))??;
        Ok(Arc::new(SmbHandle { mountpoint, server: Mutex::new(Some(server)) }))
    }
}

#[async_trait]
impl MountHandle for SmbHandle {
    async fn unmount(&self) -> Result<(), MountError> {
        let target = self.mountpoint.clone();
        tokio::task::spawn_blocking(move || uls_smb::unmount(target)).await
            .map_err(|_| err("SMB unmount task failed"))?
            .map_err(|_| err("cannot unmount SMB share"))?;
        let server = self.server.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(server) = server
            && server.shutdown().await.is_err()
        {
            tracing::warn!("SMB server stopped with an error after detaching the mount");
        }
        Ok(())
    }
}
