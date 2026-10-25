//! Storage contract. Paths are share-relative UTF-8, with `/` separators; root is `""`.
use async_trait::async_trait;
use bytes::Bytes;
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    File,
    Directory,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attr {
    pub id: u64,
    pub kind: Kind,
    pub size: u64,
    /// Windows FILETIME: 100 ns ticks since 1601-01-01 UTC.
    pub created: u64,
    pub accessed: u64,
    pub modified: u64,
    pub changed: u64,
    pub readonly: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub attr: Attr,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Removed,
    Modified,
    Attributes,
    Renamed { from: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeEvent {
    pub path: String,
    pub kind: ChangeKind,
    pub is_directory: bool,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FsError {
    #[error("not found")]
    NotFound,
    #[error("parent not found")]
    PathNotFound,
    #[error("already exists")]
    Exists,
    #[error("not a directory")]
    NotDirectory,
    #[error("is a directory")]
    IsDirectory,
    #[error("directory not empty")]
    NotEmpty,
    #[error("access denied")]
    AccessDenied,
    #[error("invalid path or size")]
    Invalid,
    #[error("not supported")]
    NotSupported,
    #[error("storage full")]
    NoSpace,
    #[error("I/O: {0}")]
    Io(String),
}

/// Mutations must be atomic. Stable IDs survive renames. Publish events after commit.
/// `flush` must durably settle writes or return an error; close also calls it.
#[async_trait]
pub trait SmbBackend: Send + Sync + 'static {
    async fn lookup(&self, path: &str) -> Result<Attr, FsError>;
    async fn readdir(&self, dir: &str) -> Result<Vec<DirEntry>, FsError>;
    async fn read(&self, path: &str, off: u64, len: u32) -> Result<Bytes, FsError>;
    async fn create(&self, path: &str, kind: Kind) -> Result<Attr, FsError>;
    async fn write(&self, path: &str, off: u64, data: &[u8]) -> Result<u32, FsError>;
    async fn truncate(&self, path: &str, size: u64) -> Result<(), FsError>;
    async fn rename(&self, from: &str, to: &str, replace: bool) -> Result<(), FsError>;
    async fn remove(&self, path: &str) -> Result<(), FsError>;
    async fn flush(&self, path: &str) -> Result<(), FsError>;
    async fn get_xattr(&self, path: &str, name: &str) -> Result<Bytes, FsError>;
    async fn set_xattr(&self, path: &str, name: &str, value: &[u8]) -> Result<(), FsError>;
    async fn list_xattr(&self, path: &str) -> Result<Vec<String>, FsError>;
    async fn remove_xattr(&self, path: &str, name: &str) -> Result<(), FsError>;
    /// Optional persistent metadata support, needed to preserve copy timestamps.
    async fn set_metadata(
        &self,
        _path: &str,
        _times: [Option<u64>; 4],
        _readonly: Option<bool>,
    ) -> Result<(), FsError> {
        Err(FsError::NotSupported)
    }
    fn subscribe(&self) -> broadcast::Receiver<ChangeEvent>;
}

pub(crate) fn validate(path: &str) -> Result<(), FsError> {
    if path.len() > 32760
        || (!path.is_empty()
            && path.split('/').any(|p| {
                p.is_empty()
                    || p == "."
                    || p == ".."
                    || p.encode_utf16().count() > 255
                    || p.chars().any(|c| c < ' ' || "\\:*?\"<>|".contains(c))
            }))
    {
        return Err(FsError::Invalid);
    }
    Ok(())
}

pub(crate) fn now() -> u64 {
    116444736000000000
        + (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            / 100) as u64
}
