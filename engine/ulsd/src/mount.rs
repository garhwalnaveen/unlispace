//! The seam between the protocol layer and whatever actually presents a drive as a folder.
//! M1 ships the read-only NFS adapter; the SMB adapter (`engine/smb`, `SmbBackend`) and the
//! writable VFS (`engine/uls-vfs`) implement [`MountAdapter`] later without touching the
//! protocol or engine code.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use uls_client::Client;

use crate::protocol::ErrorBody;

/// A `uls_client::Client` that can be replaced underneath running filesystem code. Drive tokens
/// last at most 15 minutes, and `Client` holds a static token (see NEEDS.md), so the daemon
/// builds a fresh client on every rotation and swaps it in here.
#[derive(Clone)]
pub struct SharedClient(Arc<Mutex<Client>>);

impl SharedClient {
    pub fn new(c: Client) -> SharedClient {
        SharedClient(Arc::new(Mutex::new(c)))
    }
    pub fn get(&self) -> Client {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn set(&self, c: Client) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = c;
    }
}

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
    pub client: SharedClient,
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
