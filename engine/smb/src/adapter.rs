//! Translation between the path backend and the vendor's per-open interface.
use crate::{Attr, ChangeEvent, ChangeKind, FsError, Kind, SmbBackend};
use async_trait::async_trait;
use bytes::Bytes;
use smb_server::{
    BackendCapabilities, DirChange, DirChangeKind, DirWatch, FileInfo, FileTimes, Handle,
    OpenAction, OpenIntent, OpenOptions, ShareBackend, SmbError, SmbPath, SmbResult,
};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Mutex, RwLock, broadcast};

pub(crate) struct Adapter {
    shared: Arc<Shared>,
}
struct Shared {
    backend: Arc<dyn SmbBackend>,
    /// Serializes CREATE/rename and stream read-modify-write transactions.
    mutations: Mutex<()>,
    paths: std::sync::Mutex<Vec<Weak<RwLock<String>>>>,
}
struct Open {
    shared: Arc<Shared>,
    path: Arc<RwLock<String>>,
    stream: Option<String>,
    dirty: AtomicBool,
}
impl Adapter {
    pub(crate) fn new(backend: Arc<dyn SmbBackend>) -> Self {
        Self {
            shared: Arc::new(Shared {
                backend,
                mutations: Mutex::new(()),
                paths: std::sync::Mutex::new(Vec::new()),
            }),
        }
    }
}
impl From<FsError> for SmbError {
    fn from(e: FsError) -> Self {
        match e {
            FsError::NotFound => Self::NotFound,
            FsError::PathNotFound => Self::PathNotFound,
            FsError::Exists => Self::Exists,
            FsError::NotDirectory => Self::NotADirectory,
            FsError::IsDirectory => Self::IsDirectory,
            FsError::NotEmpty => Self::NotEmpty,
            FsError::AccessDenied => Self::AccessDenied,
            FsError::Invalid => Self::NameInvalid,
            FsError::NotSupported => Self::NotSupported,
            FsError::NoSpace => Self::DiskFull,
            FsError::Io(s) => Self::Io(std::io::Error::other(s)),
        }
    }
}
fn split(path: &SmbPath) -> (String, Option<String>) {
    let p = path.components().join("/");
    match p.split_once(':') {
        Some((base, tail)) => {
            let name = tail
                .rsplit_once(':')
                .filter(|(_, kind)| kind.eq_ignore_ascii_case("$DATA"))
                .map_or(tail, |(name, _)| name);
            (base.into(), (!name.is_empty()).then(|| name.into()))
        }
        None => (p, None),
    }
}
fn info(path: &str, a: Attr) -> FileInfo {
    let mut i = FileInfo::new(path.rsplit('/').next().unwrap_or("ULS"));
    i.end_of_file = a.size;
    i.allocation_size = a.size.div_ceil(4096) * 4096;
    i.creation_time = a.created;
    i.last_access_time = a.accessed;
    i.last_write_time = a.modified;
    i.change_time = a.changed;
    i.is_directory = a.kind == Kind::Directory;
    i.read_only = a.readonly;
    i.file_index = a.id;
    i
}
fn xname(stream: &str) -> &str {
    match stream {
        "AFP_AfpInfo" => "com.apple.FinderInfo",
        "AFP_Resource" => "com.apple.ResourceFork",
        other => other,
    }
}
fn stream_name(xattr: &str) -> &str {
    match xattr {
        "com.apple.FinderInfo" => "AFP_AfpInfo",
        "com.apple.ResourceFork" => "AFP_Resource",
        other => other,
    }
}
async fn get_stream(b: &dyn SmbBackend, path: &str, stream: &str) -> Result<Bytes, FsError> {
    let data = b.get_xattr(path, xname(stream)).await?;
    if stream != "AFP_AfpInfo" {
        return Ok(data);
    }
    let mut out = vec![0; 60];
    out[..4].copy_from_slice(b"AFP\0");
    out[4..8].copy_from_slice(&0x00010000u32.to_le_bytes());
    out[12..16].copy_from_slice(&0x80000000u32.to_le_bytes());
    let n = data.len().min(32);
    out[16..16 + n].copy_from_slice(&data[..n]);
    Ok(out.into())
}
async fn set_stream(
    b: &dyn SmbBackend,
    path: &str,
    stream: &str,
    data: &[u8],
) -> Result<(), FsError> {
    if stream == "AFP_AfpInfo" {
        if data.len() != 60 || &data[..4] != b"AFP\0" {
            return Err(FsError::Invalid);
        }
        b.set_xattr(path, xname(stream), &data[16..48]).await
    } else {
        b.set_xattr(path, xname(stream), data).await
    }
}
#[async_trait]
impl ShareBackend for Adapter {
    async fn open(
        &self,
        path: &SmbPath,
        opts: OpenOptions,
    ) -> SmbResult<(Box<dyn Handle>, OpenAction)> {
        let _guard = self.shared.mutations.lock().await;
        let (base, stream) = split(path);
        let b = &self.shared.backend;
        let existing = if let Some(s) = &stream {
            b.lookup(&base).await?;
            get_stream(b.as_ref(), &base, s).await.map(|_| ())
        } else {
            b.lookup(&base).await.map(|_| ())
        };
        let exists = match existing {
            Ok(()) => true,
            Err(FsError::NotFound) => false,
            Err(e) => return Err(e.into()),
        };
        let (create, truncate) = match opts.intent {
            OpenIntent::Open if !exists => return Err(SmbError::NotFound),
            OpenIntent::Create if exists => return Err(SmbError::Exists),
            OpenIntent::Truncate if !exists => return Err(SmbError::NotFound),
            OpenIntent::Open => (false, false),
            OpenIntent::Create => (true, false),
            OpenIntent::OpenOrCreate => (!exists, false),
            OpenIntent::Truncate => (false, true),
            OpenIntent::OverwriteOrCreate => (!exists, exists),
            _ => return Err(SmbError::NotSupported),
        };
        if create {
            if let Some(s) = &stream {
                if opts.directory {
                    return Err(SmbError::NotADirectory);
                }
                if s == "AFP_AfpInfo" {
                    let mut data = vec![0; 60];
                    data[..4].copy_from_slice(b"AFP\0");
                    data[4..8].copy_from_slice(&0x10000u32.to_le_bytes());
                    data[12..16].copy_from_slice(&0x80000000u32.to_le_bytes());
                    set_stream(b.as_ref(), &base, s, &data).await?;
                } else {
                    b.set_xattr(&base, xname(s), &[]).await?;
                }
            } else {
                b.create(
                    &base,
                    if opts.directory {
                        Kind::Directory
                    } else {
                        Kind::File
                    },
                )
                .await?;
            }
        }
        let a = b.lookup(&base).await?;
        let directory = stream.is_none() && a.kind == Kind::Directory;
        if opts.directory && !directory {
            return Err(SmbError::NotADirectory);
        }
        if opts.non_directory && directory {
            return Err(SmbError::IsDirectory);
        }
        if truncate {
            if let Some(s) = &stream {
                if s == "AFP_AfpInfo" {
                    return Err(SmbError::NotSupported);
                }
                b.set_xattr(&base, xname(s), &[]).await?;
            } else {
                b.truncate(&base, 0).await?;
            }
        }
        let path = Arc::new(RwLock::new(base));
        let mut paths = self.shared.paths.lock().unwrap();
        paths.retain(|p| p.strong_count() > 0);
        paths.push(Arc::downgrade(&path));
        drop(paths);
        Ok((
            Box::new(Open {
                shared: self.shared.clone(),
                path,
                stream,
                dirty: AtomicBool::new(create || truncate),
            }),
            if create {
                OpenAction::Created
            } else if truncate {
                OpenAction::Overwritten
            } else {
                OpenAction::Opened
            },
        ))
    }
    async fn unlink(&self, path: &SmbPath) -> SmbResult<()> {
        let _guard = self.shared.mutations.lock().await;
        let (p, s) = split(path);
        if let Some(s) = s {
            self.shared.backend.remove_xattr(&p, xname(&s)).await?;
        } else {
            self.shared.backend.remove(&p).await?;
        }
        Ok(())
    }
    async fn rename(&self, from: &SmbPath, to: &SmbPath, replace: bool) -> SmbResult<()> {
        let _guard = self.shared.mutations.lock().await;
        let (from, fs) = split(from);
        let (to, ts) = split(to);
        if fs.is_some() || ts.is_some() {
            return Err(SmbError::NotSupported);
        }
        let paths: Vec<_> = self
            .shared
            .paths
            .lock()
            .unwrap()
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        // Hold every live path across the backend rename so in-flight reads cannot
        // see an old path after the backend has moved it.
        let mut guards = Vec::new();
        for path in paths {
            guards.push(path.write_owned().await);
        }
        if from != to && guards.iter().any(|p| **p == to) {
            return Err(SmbError::Sharing);
        }
        self.shared.backend.rename(&from, &to, replace).await?;
        for mut path in guards {
            if *path == from || path.starts_with(&format!("{from}/")) {
                *path = format!("{to}{}", &path[from.len()..]);
            }
        }

        Ok(())
    }
    fn capabilities(&self) -> BackendCapabilities {
        let mut c = BackendCapabilities::default();
        c.case_sensitive = true;
        c.named_streams = true;
        c
    }
}
#[async_trait]
impl Handle for Open {
    async fn read(&self, off: u64, len: u32) -> SmbResult<Bytes> {
        let p = self.path.read().await;
        if let Some(s) = &self.stream {
            let data = get_stream(self.shared.backend.as_ref(), &p, s).await?;
            let start = usize::try_from(off).unwrap_or(usize::MAX).min(data.len());
            let end = start.saturating_add(len as usize).min(data.len());
            Ok(data.slice(start..end))
        } else {
            Ok(self.shared.backend.read(&p, off, len).await?)
        }
    }
    async fn write(&self, off: u64, data: &[u8]) -> SmbResult<u32> {
        let _guard = self.shared.mutations.lock().await;
        let p = self.path.read().await;
        let n = if let Some(s) = &self.stream {
            let end = off
                .checked_add(data.len() as u64)
                .filter(|&n| n <= 50 * 1024 * 1024)
                .ok_or(SmbError::DiskFull)? as usize;
            let mut value = get_stream(self.shared.backend.as_ref(), &p, s)
                .await?
                .to_vec();
            value.resize(value.len().max(end), 0);
            value[off as usize..end].copy_from_slice(data);
            set_stream(self.shared.backend.as_ref(), &p, s, &value).await?;
            data.len() as u32
        } else {
            self.shared.backend.write(&p, off, data).await?
        };
        self.dirty.store(true, Ordering::Release);
        Ok(n)
    }
    async fn flush(&self) -> SmbResult<()> {
        self.shared.backend.flush(&self.path.read().await).await?;
        self.dirty.store(false, Ordering::Release);
        Ok(())
    }
    async fn stat(&self) -> SmbResult<FileInfo> {
        let p = self.path.read().await;
        let mut i = info(&p, self.shared.backend.lookup(&p).await?);
        if let Some(s) = &self.stream {
            let mut hash = DefaultHasher::new();
            i.file_index.hash(&mut hash);
            s.hash(&mut hash);
            i.file_index = hash.finish();
            i.is_directory = false;
            i.end_of_file = get_stream(self.shared.backend.as_ref(), &p, s).await?.len() as u64;
            i.allocation_size = i.end_of_file.div_ceil(4096) * 4096;
        }
        Ok(i)
    }
    async fn set_times(&self, t: FileTimes) -> SmbResult<()> {
        self.shared
            .backend
            .set_metadata(
                &self.path.read().await,
                [
                    t.creation_time,
                    t.last_access_time,
                    t.last_write_time,
                    t.change_time,
                ],
                None,
            )
            .await?;
        Ok(())
    }
    async fn set_attributes(&self, a: u32) -> SmbResult<()> {
        if a & !(0x1 | 0x10 | 0x20 | 0x80) != 0 {
            return Err(SmbError::NotSupported);
        }
        self.shared
            .backend
            .set_metadata(&self.path.read().await, [None; 4], Some(a & 1 != 0))
            .await?;
        Ok(())
    }
    async fn truncate(&self, len: u64) -> SmbResult<()> {
        let _guard = self.shared.mutations.lock().await;
        let p = self.path.read().await;
        if let Some(s) = &self.stream {
            if len > 50 * 1024 * 1024 {
                return Err(SmbError::DiskFull);
            }
            let mut data = get_stream(self.shared.backend.as_ref(), &p, s)
                .await?
                .to_vec();
            data.resize(len as usize, 0);
            set_stream(self.shared.backend.as_ref(), &p, s, &data).await?;
        } else {
            self.shared.backend.truncate(&p, len).await?;
        }
        self.dirty.store(true, Ordering::Release);
        Ok(())
    }
    async fn list_dir(&self, pattern: Option<&str>) -> SmbResult<Vec<smb_server::DirEntry>> {
        if self.stream.is_some() {
            return Err(SmbError::NotADirectory);
        }
        Ok(self
            .shared
            .backend
            .readdir(&self.path.read().await)
            .await?
            .into_iter()
            .filter(|e| pattern.is_none_or(|p| smb_server::matches_pattern(p, &e.name, true)))
            .map(|e| smb_server::DirEntry {
                info: info(&e.name, e.attr),
            })
            .collect())
    }
    async fn streams(&self) -> SmbResult<Vec<(String, u64)>> {
        let p = self.path.read().await;
        let mut out = Vec::new();
        for name in self.shared.backend.list_xattr(&p).await? {
            let stream = stream_name(&name);
            let data = get_stream(self.shared.backend.as_ref(), &p, stream).await?;
            out.push((format!(":{stream}:$DATA"), data.len() as u64));
        }
        Ok(out)
    }
    async fn close(self: Box<Self>) -> SmbResult<()> {
        if self.dirty.load(Ordering::Acquire) {
            self.flush().await?;
        }
        Ok(())
    }
    async fn watch(&self) -> SmbResult<Option<Box<dyn DirWatch>>> {
        Ok(Some(Box::new(Watch {
            receiver: self.shared.backend.subscribe(),
            path: self.path.clone(),
        })))
    }
}
struct Watch {
    receiver: broadcast::Receiver<ChangeEvent>,
    path: Arc<RwLock<String>>,
}
#[async_trait]
impl DirWatch for Watch {
    async fn next(&mut self) -> Option<Vec<DirChange>> {
        loop {
            let event = match self.receiver.recv().await {
                Ok(e) => e,
                Err(broadcast::error::RecvError::Closed) => return None,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    return Some(vec![DirChange::new("", DirChangeKind::Lost, false)]);
                }
            };
            let dir = self.path.read().await.clone();
            let parent = |p: &str| p.rsplit_once('/').map_or("".to_string(), |(d, _)| d.into());
            let name = |p: &str| p.rsplit('/').next().unwrap_or("").to_string();
            let mut out = Vec::new();
            if let ChangeKind::Renamed { from } = &event.kind {
                let was = parent(from) == dir;
                let is = parent(&event.path) == dir;
                if was && is {
                    out.push(DirChange::new(
                        name(&event.path),
                        DirChangeKind::Renamed { from: name(from) },
                        event.is_directory,
                    ));
                } else {
                    if was {
                        out.push(DirChange::new(
                            name(from),
                            DirChangeKind::Removed,
                            event.is_directory,
                        ));
                    }
                    if is {
                        out.push(DirChange::new(
                            name(&event.path),
                            DirChangeKind::Added,
                            event.is_directory,
                        ));
                    }
                }
            } else if parent(&event.path) == dir && !event.path.is_empty() {
                let kind = match event.kind {
                    ChangeKind::Added => DirChangeKind::Added,
                    ChangeKind::Removed => DirChangeKind::Removed,
                    ChangeKind::Modified => DirChangeKind::Modified,
                    _ => DirChangeKind::AttributesChanged,
                };
                out.push(DirChange::new(name(&event.path), kind, event.is_directory));
            }
            if !out.is_empty() {
                return Some(out);
            }
        }
    }
}
