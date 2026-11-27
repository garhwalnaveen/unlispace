//! The seam between the daemon and the filesystem mount adapters.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use uls_client::Client;

use crate::protocol::{ErrorBody, code};

/// Which access level the adapter needs when it asks for a drive token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NeedAccess {
    Read,
    Write,
}

pub struct MountRequest {
    pub drive_id: String,
    pub drive_name: String,
    /// Directory to mount on. Prepared through the adapter before mounting.
    pub mountpoint: PathBuf,
    pub client: Client,
    pub vfs: uls_vfs::Vfs,
}

#[derive(Debug)]
pub struct MountError(pub ErrorBody);

impl std::fmt::Display for MountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.0.code, self.0.message)
    }
}

impl std::error::Error for MountError {}

pub(crate) const MOUNT_DISK_FULL: &str = "Not enough local disk space to mount the drive. Free up disk space and try again.";

pub(crate) fn mountpoint_error(error: std::io::Error, message: impl FnOnce() -> String) -> MountError {
    MountError(if error.kind() == std::io::ErrorKind::StorageFull {
        ErrorBody::internal(MOUNT_DISK_FULL)
    } else {
        ErrorBody::internal(message())
    })
}

/// Fail early, and without leaking anything, if the drive or token is wrong.
pub async fn check_drive(client: &Client, drive_id: &str) -> Result<(), MountError> {
    client.drive_info(drive_id).await.map(drop).map_err(|e| match e {
        uls_client::Error::NotFound { .. } => MountError(ErrorBody::new(code::NO_SUCH_DRIVE, "no such drive")),
        uls_client::Error::Unauthorized | uls_client::Error::Auth(_) => MountError(ErrorBody::new(code::UNAUTHORIZED, "the data plane rejected the drive token")),
        e if matches!(e, uls_client::Error::Transport(_)) || e.is_retryable() => MountError(ErrorBody::new(code::OFFLINE, "cannot reach the data plane")),
        _ => MountError(ErrorBody::internal("cannot open drive")),
    })
}

#[async_trait]
pub trait MountAdapter: Send + Sync {
    /// Token access level this adapter needs (the read-only NFS adapter needs `Read`).
    fn access(&self) -> NeedAccess;
    /// Prepare the target without probing an abandoned filesystem before its adapter can recover it.
    async fn prepare_mountpoint(&self, path: &Path) -> Result<(), MountError> {
        std::fs::create_dir_all(path).map_err(|error| {
            let kind = error.kind();
            mountpoint_error(error, || format!("cannot create {}: {}", path.display(), kind))
        })
    }
    /// Present the drive at `req.mountpoint`. Returns once it is usable.
    async fn mount(&self, req: MountRequest) -> Result<Arc<dyn MountHandle>, MountError>;
}

#[async_trait]
pub trait MountHandle: Send + Sync {
    /// Stop serving and detach from the filesystem. On error the mount stays usable and the
    /// caller may retry. Dropping the handle must stop any background serving task.
    async fn unmount(&self) -> Result<(), MountError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn default_preparation_creates_nested_mountpoint_and_rejects_files() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let path = dir.path().join("nested/Space");
        let adapter = crate::nfs_adapter::NfsAdapter::default();
        adapter.prepare_mountpoint(&path).await.unwrap();
        assert!(path.is_dir());
        adapter.prepare_mountpoint(&path).await.unwrap();
        let file = dir.path().join("file");
        std::fs::write(&file, b"data").unwrap();
        assert!(adapter.prepare_mountpoint(&file).await.is_err());
    }
}
