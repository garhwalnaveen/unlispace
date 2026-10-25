#![allow(clippy::double_must_use, reason = "async_trait generated futures")]
//! SMB's path contract backed by the durable VFS journal.
use async_trait::async_trait;
use bytes::Bytes;
use tokio::sync::broadcast;
use uls_smb::{Attr, ChangeEvent, ChangeKind, DirEntry, FsError, Kind, SmbBackend};
use uls_vfs::{Vfs, VfsEvent};

const EVENT_CAPACITY: usize = 256;

pub struct VfsBackend {
    vfs: Vfs,
    events: broadcast::Sender<ChangeEvent>,
    forwarder: tokio::task::JoinHandle<()>,
}

impl VfsBackend {
    /// Call inside a Tokio runtime. The caller owns remote watch forwarding and shutdown.
    pub fn new(vfs: Vfs) -> Self {
        let mut source = vfs.subscribe();
        let events = broadcast::channel(EVENT_CAPACITY).0;
        let target = events.clone();
        let core = vfs.clone();
        let forwarder = tokio::spawn(async move {
            loop {
                match source.recv().await {
                    Ok(VfsEvent::Changed { paths }) => {
                        for path in paths {
                            if path.is_empty() {
                                rescan(&target);
                                continue;
                            }
                            let Ok(attr) = core.lookup(&path).await else {
                                // Deleted nodes have no old kind in VfsEvent. A rescan
                                // covers directory removals and offline lookup failures.
                                rescan(&target);
                                continue;
                            };
                            let event = ChangeEvent {
                                path,
                                // VfsEvent has no operation or old-kind field. Existing
                                // nodes are invalidations, not an invented add/rename.
                                kind: ChangeKind::Modified,
                                is_directory: attr.kind == uls_vfs::Kind::Directory,
                            };
                            let _ = target.send(event);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Propagate lag to the SMB adapter, which requests a rescan.
                        rescan(&target);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Ok(_) => (),
                }
            }
        });
        Self { vfs, events, forwarder }
    }
}

fn rescan(events: &broadcast::Sender<ChangeEvent>) {
    // The path contract has no Rescan variant. Overflow wakes directory watches
    // with Lagged, which the SMB adapter translates into a directory rescan.
    for _ in 0..=EVENT_CAPACITY {
        let _ = events.send(ChangeEvent {
            path: String::new(), kind: ChangeKind::Modified, is_directory: true,
        });
    }
}

impl Drop for VfsBackend {
    fn drop(&mut self) {
        self.forwarder.abort();
    }
}

fn attr(a: uls_vfs::Attr) -> Attr {
    Attr {
        id: a.id,
        kind: match a.kind {
            uls_vfs::Kind::File => Kind::File,
            uls_vfs::Kind::Directory => Kind::Directory,
        },
        size: a.size,
        created: a.created,
        accessed: a.accessed,
        modified: a.modified,
        changed: a.changed,
        readonly: a.readonly,
    }
}

fn error(e: uls_vfs::FsError) -> FsError {
    match e {
        uls_vfs::FsError::NotFound => FsError::NotFound,
        uls_vfs::FsError::Exists => FsError::Exists,
        uls_vfs::FsError::NotDir => FsError::NotDirectory,
        uls_vfs::FsError::IsDir => FsError::IsDirectory,
        uls_vfs::FsError::NotEmpty => FsError::NotEmpty,
        uls_vfs::FsError::NoSpace => FsError::NoSpace,
        uls_vfs::FsError::Invalid => FsError::Invalid,
        uls_vfs::FsError::Io(message) => FsError::Io(message),
        // shortcut: the SMB error contract cannot carry these statuses; see NEEDS.md.
        uls_vfs::FsError::ReadOnly => FsError::AccessDenied,
        uls_vfs::FsError::Busy => FsError::Io("VFS busy".into()),
        uls_vfs::FsError::Stale => FsError::Io("VFS stale version".into()),
    }
}

#[async_trait]
impl SmbBackend for VfsBackend {
    async fn lookup(&self, path: &str) -> Result<Attr, FsError> {
        self.vfs.lookup(path).await.map(attr).map_err(error)
    }
    async fn readdir(&self, dir: &str) -> Result<Vec<DirEntry>, FsError> {
        self.vfs.readdir(dir).await.map(|entries| entries.into_iter()
            .map(|e| DirEntry { name: e.name, attr: attr(e.attr) }).collect()).map_err(error)
    }
    async fn read(&self, path: &str, off: u64, len: u32) -> Result<Bytes, FsError> {
        self.vfs.read(path, off, len).await.map_err(error)
    }
    async fn create(&self, path: &str, kind: Kind) -> Result<Attr, FsError> {
        let kind = match kind {
            Kind::File => uls_vfs::Kind::File,
            Kind::Directory => uls_vfs::Kind::Directory,
        };
        self.vfs.create(path, kind).await.map(attr).map_err(error)
    }
    async fn write(&self, path: &str, off: u64, data: &[u8]) -> Result<u32, FsError> {
        self.vfs.write(path, off, data).await.map_err(error)
    }
    async fn truncate(&self, path: &str, size: u64) -> Result<(), FsError> {
        self.vfs.truncate(path, size).await.map_err(error)
    }
    async fn rename(&self, from: &str, to: &str, replace: bool) -> Result<(), FsError> {
        self.vfs.rename(from, to, replace).await.map_err(error)
    }
    async fn remove(&self, path: &str) -> Result<(), FsError> {
        self.vfs.remove(path).await.map_err(error)
    }
    async fn flush(&self, path: &str) -> Result<(), FsError> {
        self.vfs.flush(path).await.map_err(error)
    }
    async fn get_xattr(&self, path: &str, name: &str) -> Result<Bytes, FsError> {
        self.vfs.get_xattr(path, name).await.map_err(error)
    }
    async fn set_xattr(&self, path: &str, name: &str, value: &[u8]) -> Result<(), FsError> {
        self.vfs.set_xattr(path, name, value).await.map_err(error)
    }
    async fn list_xattr(&self, path: &str) -> Result<Vec<String>, FsError> {
        self.vfs.list_xattr(path).await.map_err(error)
    }
    async fn remove_xattr(&self, path: &str, name: &str) -> Result<(), FsError> {
        self.vfs.remove_xattr(path, name).await.map_err(error)
    }
    fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        self.events.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_vfs_error_without_losing_io_detail() {
        use uls_vfs::FsError as V;
        for (source, expected) in [
            (V::NotFound, FsError::NotFound), (V::Exists, FsError::Exists),
            (V::NotDir, FsError::NotDirectory), (V::IsDir, FsError::IsDirectory),
            (V::NotEmpty, FsError::NotEmpty), (V::NoSpace, FsError::NoSpace),
            (V::Invalid, FsError::Invalid), (V::Io("detail".into()), FsError::Io("detail".into())),
            (V::ReadOnly, FsError::AccessDenied),
            (V::Busy, FsError::Io("VFS busy".into())),
            (V::Stale, FsError::Io("VFS stale version".into())),
        ] {
            assert_eq!(error(source), expected);
        }
    }

    #[test]
    fn supported_errors_reach_the_expected_wire_status() {
        use uls_vfs::FsError as V;
        for (source, status) in [
            (V::NotFound, 0xC000_0034),
            (V::Exists, 0xC000_0035),
            (V::NotDir, 0xC000_0103),
            (V::IsDir, 0xC000_00BA),
            (V::NotEmpty, 0xC000_0101),
            (V::NoSpace, 0xC000_007F),
            (V::Invalid, 0xC000_0033),
            (V::Io("failed".into()), 0xC000_00E9),
        ] {
            assert_eq!(smb_server::SmbError::from(error(source)).to_nt_status(), status);
        }
    }
}
