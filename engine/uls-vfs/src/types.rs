use std::time::{Duration, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind { File, Directory }

/// Timestamps use Windows FILETIME (100 ns ticks since 1601), as does SmbBackend.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attr {
    pub id: u64,
    pub kind: Kind,
    pub size: u64,
    pub created: u64,
    pub accessed: u64,
    pub modified: u64,
    pub changed: u64,
    pub readonly: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry { pub name: String, pub attr: Attr }
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncState { Online, Offline }
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VfsEvent {
    Changed { paths: Vec<String> },
    Transfer { paths: Vec<String>, bytes: u64 },
    Conflict { path: String, copy: String },
    State(SyncState),
}
#[derive(Clone, Debug)]
pub struct VfsOptions {
    pub quiet_window: Duration,
    pub max_dirty_age: Duration,
    pub journal_byte_cap: u64,
    pub retry_initial: Duration,
    pub retry_max: Duration,
    pub hostname: String,
}
impl Default for VfsOptions {
    fn default() -> Self {
        Self {
            quiet_window: Duration::from_secs(2), max_dirty_age: Duration::from_secs(30),
            journal_byte_cap: 10 * 1024 * 1024 * 1024,
            retry_initial: Duration::from_millis(250), retry_max: Duration::from_secs(30),
            hostname: std::env::var("HOSTNAME").ok()
                .or_else(|| std::process::Command::new("hostname").output().ok()
                    .filter(|o| o.status.success()).and_then(|o| String::from_utf8(o.stdout).ok()))
                .unwrap_or_else(|| "localhost".into()).trim().to_string(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingSummary {
    pub files: usize,
    pub metadata_ops: usize,
    pub bytes: u64,
    pub state: SyncState,
}
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FsError {
    #[error("not found")] NotFound,
    #[error("already exists")] Exists,
    #[error("not a directory")] NotDir,
    #[error("is a directory")] IsDir,
    #[error("directory not empty")] NotEmpty,
    #[error("journal full")] NoSpace,
    #[error("I/O: {0}")] Io(String),
    #[error("read only")] ReadOnly,
    #[error("busy")] Busy,
    #[error("stale version")] Stale,
    #[error("invalid path or size")] Invalid,
}
impl FsError {
    /// POSIX errno values for the macOS/Linux mount adapters.
    pub fn errno(&self) -> i32 {
        match self {
            Self::NotFound => 2, Self::Exists => 17, Self::NotDir => 20, Self::IsDir => 21,
            Self::NotEmpty => if cfg!(target_os = "macos") { 66 } else { 39 },
            Self::NoSpace => 28, Self::Io(_) => 5, Self::ReadOnly => 30,
            Self::Busy => 16, Self::Stale => if cfg!(target_os = "macos") { 70 } else { 116 },
            Self::Invalid => 22,
        }
    }
}
impl From<std::io::Error> for FsError {
    fn from(e: std::io::Error) -> Self {
        if e.raw_os_error() == Some(28) { Self::NoSpace } else { Self::Io(e.to_string()) }
    }
}
impl From<rusqlite::Error> for FsError {
    fn from(e: rusqlite::Error) -> Self {
        if matches!(&e, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::DiskFull) {
            Self::NoSpace
        } else { Self::Io(e.to_string()) }
    }
}
impl From<serde_json::Error> for FsError {
    fn from(e: serde_json::Error) -> Self { Self::Io(e.to_string()) }
}
impl From<uls_client::Error> for FsError {
    fn from(e: uls_client::Error) -> Self {
        match e {
            uls_client::Error::NotFound { .. } => Self::NotFound,
            uls_client::Error::PreconditionFailed { .. } => Self::Stale,
            uls_client::Error::Unauthorized => Self::ReadOnly,
            uls_client::Error::InvalidPath(_) => Self::Invalid,
            other => Self::Io(other.to_string()),
        }
    }
}
pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}
pub(crate) fn filetime(ms: i64) -> u64 { 116_444_736_000_000_000 + ms.max(0) as u64 * 10_000 }
pub(crate) fn attr(id: u64, kind: Kind, size: u64, ms: i64) -> Attr {
    let t = filetime(ms);
    Attr { id, kind, size, created: t, accessed: t, modified: t, changed: t, readonly: false }
}
pub(crate) fn path(p: &str) -> Result<String, FsError> {
    uls_proto::validate_path(p).map_err(|_| FsError::Invalid)?;
    Ok(p.trim_end_matches('/').to_string())
}
pub(crate) fn parent(p: &str) -> &str { p.rsplit_once('/').map_or("", |(a, _)| a) }
pub(crate) fn wire(p: &str, kind: Kind) -> String {
    if kind == Kind::Directory && !p.is_empty() { format!("{p}/") } else { p.to_string() }
}
pub(crate) fn within(p: &str, dir: &str) -> bool {
    p == dir || p.strip_prefix(dir).is_some_and(|s| s.starts_with('/'))
}
