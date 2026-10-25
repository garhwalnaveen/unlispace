//! A bounded, atomic memory tree for the demo and contract tests.
use crate::backend::{now, validate};
use crate::{Attr, ChangeEvent, ChangeKind, DirEntry, FsError, Kind, SmbBackend};
use async_trait::async_trait;
use bytes::Bytes;
use std::collections::BTreeMap;
use tokio::sync::{RwLock, broadcast};

const MAX_FILE: usize = 50 * 1024 * 1024;
const MAX_MEMORY: usize = 128 * 1024 * 1024;

struct Node {
    attr: Attr,
    data: Vec<u8>,
    xattrs: BTreeMap<String, Bytes>,
}
struct Tree {
    nodes: BTreeMap<String, Node>,
    next: u64,
}
pub struct MemBackend {
    tree: RwLock<Tree>,
    events: broadcast::Sender<ChangeEvent>,
}

impl Default for MemBackend {
    fn default() -> Self {
        Self::new()
    }
}
impl MemBackend {
    pub fn new() -> Self {
        let t = now();
        let root = Node {
            attr: Attr {
                id: 1,
                kind: Kind::Directory,
                size: 0,
                created: t,
                accessed: t,
                modified: t,
                changed: t,
                readonly: false,
            },
            data: Vec::new(),
            xattrs: BTreeMap::new(),
        };
        Self {
            tree: RwLock::new(Tree {
                nodes: BTreeMap::from([(String::new(), root)]),
                next: 2,
            }),
            events: broadcast::channel(1024).0,
        }
    }
    fn emit(&self, path: &str, kind: ChangeKind, is_directory: bool) {
        let _ = self.events.send(ChangeEvent {
            path: path.into(),
            kind,
            is_directory,
        });
    }
}
fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(p, _)| p)
}
fn node<'a>(t: &'a Tree, path: &str) -> Result<&'a Node, FsError> {
    validate(path)?;
    if let Some(n) = t.nodes.get(path) {
        return Ok(n);
    }
    match t.nodes.get(parent(path)) {
        None => Err(FsError::PathNotFound),
        Some(n) if n.attr.kind != Kind::Directory => Err(FsError::NotDirectory),
        _ => Err(FsError::NotFound),
    }
}
fn writable<'a>(t: &'a mut Tree, path: &str) -> Result<&'a mut Node, FsError> {
    validate(path)?;
    let n = t.nodes.get_mut(path).ok_or(FsError::NotFound)?;
    if n.attr.readonly {
        return Err(FsError::AccessDenied);
    }
    Ok(n)
}
fn check_parent(t: &Tree, path: &str) -> Result<(), FsError> {
    match t.nodes.get(parent(path)) {
        None => Err(FsError::PathNotFound),
        Some(n) if n.attr.kind != Kind::Directory => Err(FsError::NotDirectory),
        Some(n) if n.attr.readonly => Err(FsError::AccessDenied),
        _ => Ok(()),
    }
}
fn usage(t: &Tree) -> usize {
    t.nodes
        .values()
        .map(|n| n.data.len() + n.xattrs.values().map(Bytes::len).sum::<usize>())
        .sum()
}

#[async_trait]
impl SmbBackend for MemBackend {
    async fn lookup(&self, path: &str) -> Result<Attr, FsError> {
        Ok(node(&*self.tree.read().await, path)?.attr.clone())
    }
    async fn readdir(&self, dir: &str) -> Result<Vec<DirEntry>, FsError> {
        let t = self.tree.read().await;
        if node(&t, dir)?.attr.kind != Kind::Directory {
            return Err(FsError::NotDirectory);
        }
        Ok(t.nodes
            .iter()
            .filter(|(p, _)| !p.is_empty() && parent(p) == dir)
            .map(|(p, n)| DirEntry {
                name: p.rsplit('/').next().unwrap().into(),
                attr: n.attr.clone(),
            })
            .collect())
    }
    async fn read(&self, path: &str, off: u64, len: u32) -> Result<Bytes, FsError> {
        let t = self.tree.read().await;
        let n = node(&t, path)?;
        if n.attr.kind == Kind::Directory {
            return Err(FsError::IsDirectory);
        }
        let start = usize::try_from(off).unwrap_or(usize::MAX).min(n.data.len());
        Ok(Bytes::copy_from_slice(
            &n.data[start..start.saturating_add(len as usize).min(n.data.len())],
        ))
    }
    async fn create(&self, path: &str, kind: Kind) -> Result<Attr, FsError> {
        validate(path)?;
        let mut t = self.tree.write().await;
        if t.nodes.contains_key(path) {
            return Err(FsError::Exists);
        }
        check_parent(&t, path)?;
        if t.nodes.len() >= 100_000 {
            return Err(FsError::NoSpace);
        }
        let time = now();
        let attr = Attr {
            id: t.next,
            kind,
            size: 0,
            created: time,
            accessed: time,
            modified: time,
            changed: time,
            readonly: false,
        };
        t.next += 1;
        t.nodes.insert(
            path.into(),
            Node {
                attr: attr.clone(),
                data: Vec::new(),
                xattrs: BTreeMap::new(),
            },
        );
        self.emit(path, ChangeKind::Added, kind == Kind::Directory);
        Ok(attr)
    }
    async fn write(&self, path: &str, off: u64, data: &[u8]) -> Result<u32, FsError> {
        let end = off
            .checked_add(data.len() as u64)
            .filter(|&n| n <= MAX_FILE as u64)
            .ok_or(FsError::NoSpace)? as usize;
        let mut t = self.tree.write().await;
        let old = node(&t, path)?.data.len();
        if usage(&t).saturating_add(end.saturating_sub(old)) > MAX_MEMORY {
            return Err(FsError::NoSpace);
        }
        let n = writable(&mut t, path)?;
        if n.attr.kind == Kind::Directory {
            return Err(FsError::IsDirectory);
        }
        n.data.resize(old.max(end), 0);
        n.data[off as usize..end].copy_from_slice(data);
        n.attr.size = n.data.len() as u64;
        n.attr.modified = now();
        n.attr.changed = n.attr.modified;
        self.emit(path, ChangeKind::Modified, false);
        Ok(data.len() as u32)
    }
    async fn truncate(&self, path: &str, size: u64) -> Result<(), FsError> {
        if size > MAX_FILE as u64 {
            return Err(FsError::NoSpace);
        }
        let mut t = self.tree.write().await;
        let old = node(&t, path)?.data.len();
        if usage(&t).saturating_add((size as usize).saturating_sub(old)) > MAX_MEMORY {
            return Err(FsError::NoSpace);
        }
        let n = writable(&mut t, path)?;
        if n.attr.kind == Kind::Directory {
            return Err(FsError::IsDirectory);
        }
        n.data.resize(size as usize, 0);
        n.attr.size = size;
        n.attr.modified = now();
        n.attr.changed = n.attr.modified;
        self.emit(path, ChangeKind::Modified, false);
        Ok(())
    }
    async fn rename(&self, from: &str, to: &str, replace: bool) -> Result<(), FsError> {
        validate(from)?;
        validate(to)?;
        if from.is_empty() || to.is_empty() || to.starts_with(&format!("{from}/")) {
            return Err(FsError::Invalid);
        }
        let mut t = self.tree.write().await;
        let dir = node(&t, from)?.attr.kind == Kind::Directory;
        if from == to {
            return Ok(());
        }
        check_parent(&t, from)?;
        check_parent(&t, to)?;
        if let Some(dest) = t.nodes.get(to) {
            if !replace {
                return Err(FsError::Exists);
            }
            if dest.attr.kind == Kind::Directory || dest.attr.readonly {
                return Err(FsError::AccessDenied);
            }
            if dir {
                return Err(FsError::NotDirectory);
            }
        }
        let paths: Vec<_> = t
            .nodes
            .keys()
            .filter(|p| p.as_str() == from || p.starts_with(&format!("{from}/")))
            .cloned()
            .collect();
        t.nodes.remove(to);
        for path in paths {
            let mut n = t.nodes.remove(&path).unwrap();
            n.attr.changed = now();
            t.nodes.insert(format!("{to}{}", &path[from.len()..]), n);
        }
        self.emit(to, ChangeKind::Renamed { from: from.into() }, dir);
        Ok(())
    }
    async fn remove(&self, path: &str) -> Result<(), FsError> {
        if path.is_empty() {
            return Err(FsError::AccessDenied);
        }
        let mut t = self.tree.write().await;
        let dir = node(&t, path)?.attr.kind == Kind::Directory;
        if t.nodes.keys().any(|p| p.starts_with(&format!("{path}/"))) {
            return Err(FsError::NotEmpty);
        }
        check_parent(&t, path)?;
        writable(&mut t, path)?;
        t.nodes.remove(path);
        self.emit(path, ChangeKind::Removed, dir);
        Ok(())
    }
    async fn flush(&self, path: &str) -> Result<(), FsError> {
        self.lookup(path).await.map(|_| ())
    }
    async fn get_xattr(&self, path: &str, name: &str) -> Result<Bytes, FsError> {
        node(&*self.tree.read().await, path)?
            .xattrs
            .get(name)
            .cloned()
            .ok_or(FsError::NotFound)
    }
    async fn set_xattr(&self, path: &str, name: &str, value: &[u8]) -> Result<(), FsError> {
        if name.is_empty()
            || name.len() > 255
            || name.chars().any(|c| c < ' ' || ":/\\".contains(c))
        {
            return Err(FsError::Invalid);
        }
        if value.len() > MAX_FILE {
            return Err(FsError::NoSpace);
        }
        let mut t = self.tree.write().await;
        let old = node(&t, path)?.xattrs.get(name).map_or(0, Bytes::len);
        if usage(&t).saturating_sub(old).saturating_add(value.len()) > MAX_MEMORY {
            return Err(FsError::NoSpace);
        }
        let n = writable(&mut t, path)?;
        n.xattrs.insert(name.into(), Bytes::copy_from_slice(value));
        n.attr.changed = now();
        self.emit(path, ChangeKind::Attributes, n.attr.kind == Kind::Directory);
        Ok(())
    }
    async fn list_xattr(&self, path: &str) -> Result<Vec<String>, FsError> {
        Ok(node(&*self.tree.read().await, path)?
            .xattrs
            .keys()
            .cloned()
            .collect())
    }
    async fn remove_xattr(&self, path: &str, name: &str) -> Result<(), FsError> {
        let mut t = self.tree.write().await;
        let n = writable(&mut t, path)?;
        n.xattrs.remove(name).ok_or(FsError::NotFound)?;
        n.attr.changed = now();
        self.emit(path, ChangeKind::Attributes, n.attr.kind == Kind::Directory);
        Ok(())
    }
    async fn set_metadata(
        &self,
        path: &str,
        times: [Option<u64>; 4],
        readonly: Option<bool>,
    ) -> Result<(), FsError> {
        validate(path)?;
        let mut t = self.tree.write().await;
        let n = t.nodes.get_mut(path).ok_or(FsError::NotFound)?;
        for (dest, src) in [
            &mut n.attr.created,
            &mut n.attr.accessed,
            &mut n.attr.modified,
            &mut n.attr.changed,
        ]
        .into_iter()
        .zip(times)
        {
            if let Some(time) = src {
                *dest = time;
            }
        }
        if let Some(ro) = readonly {
            n.attr.readonly = ro;
        }
        self.emit(path, ChangeKind::Attributes, n.attr.kind == Kind::Directory);
        Ok(())
    }
    fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        self.events.subscribe()
    }
}
