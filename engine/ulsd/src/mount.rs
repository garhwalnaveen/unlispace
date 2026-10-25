//! The seam between the daemon and the filesystem mount adapters.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use uls_client::Client;

use crate::protocol::ErrorBody;

/// Which access level the adapter needs when it asks for a drive token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NeedAccess {
    Read,
    Write,
}

pub struct MountRequest {
    pub drive_id: String,
    pub drive_name: String,
    /// Directory to mount on. Already created by the daemon.
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

#[async_trait]
pub trait MountAdapter: Send + Sync {
    /// Token access level this adapter needs (the read-only NFS adapter needs `Read`).
    fn access(&self) -> NeedAccess;
    /// Present the drive at `req.mountpoint`. Returns once it is usable.
    async fn mount(&self, req: MountRequest) -> Result<Arc<dyn MountHandle>, MountError>;
}

#[async_trait]
pub trait MountHandle: Send + Sync {
    /// Stop serving and detach from the filesystem. On error the mount stays usable and the
    /// caller may retry. Dropping the handle must stop any background serving task.
    async fn unmount(&self) -> Result<(), MountError>;
}
