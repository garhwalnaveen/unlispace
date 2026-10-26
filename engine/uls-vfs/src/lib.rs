//! Durable, path-based writable drive core. See the crate README for lifecycle and guarantees.
mod journal;
mod publisher;
mod types;
pub use types::*;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use bytes::Bytes;
use journal::{Action, Extent, Journal, Node, State};
use tokio::sync::{Mutex, Notify, broadcast};
use uls_client::{Client, WatchEvent};
use uls_proto::{NodeType, Op};
use types::{attr, filetime, now_ms, parent, path, wire, within};

/// A shared byte budget lets a daemon cap all drive journals together.
pub struct JournalBudget { cap: AtomicU64, used: AtomicU64 }
impl JournalBudget {
    pub fn new(cap: u64) -> Self { Self {cap: AtomicU64::new(cap),used: AtomicU64::new(0)} }
    pub fn set_cap(&self,cap:u64) {self.cap.store(cap,Ordering::SeqCst);}
    pub fn used(&self)->u64 {self.used.load(Ordering::SeqCst)}
    fn update(&self,old:u64,new:u64)->Result<(),FsError> {
        if new <= old { self.used.fetch_sub(old-new,Ordering::SeqCst); return Ok(()); }
        let extra = new-old;
        self.used.try_update(Ordering::SeqCst,Ordering::SeqCst,|used|used.checked_add(extra).filter(|n|*n <= self.cap.load(Ordering::SeqCst))).map(|_|()).map_err(|_|FsError::NoSpace)
    }
}

#[derive(Clone)]
pub struct Vfs { inner: Arc<Inner>, _lease: Arc<Lease> }
struct Lease(std::sync::Weak<Inner>);
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(inner) = self.0.upgrade()
            && let Some(task) = inner.task.lock().unwrap_or_else(|e| e.into_inner()).take() { task.abort(); }
    }
}
struct Inner {
    client: Client, drive: String, opts: VfsOptions,
    budget: Arc<JournalBudget>,
    publish_lock: Mutex<()>,
    core: Mutex<Core>, events: broadcast::Sender<VfsEvent>, wake: Arc<Notify>,
    task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}
struct Core { journal: Journal, state: State, online: SyncState, closed: bool,
    budget: Arc<JournalBudget>, accounted:u64, events:broadcast::Sender<VfsEvent> }
impl Drop for Core { fn drop(&mut self) { self.budget.used.fetch_sub(self.accounted,Ordering::SeqCst); } }
impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(t) = self.task.get_mut().unwrap_or_else(|e| e.into_inner()).take() { t.abort(); }
    }
}
impl Vfs {
    pub async fn open(client: Client, drive: &str, state_dir: &Path, opts: VfsOptions) -> Result<Self, FsError> {
        let budget = Arc::new(JournalBudget::new(opts.journal_byte_cap));
        Self::open_with_budget(client,drive,state_dir,opts,budget).await
    }
    pub async fn open_with_budget(client:Client,drive:&str,state_dir:&Path,opts:VfsOptions,budget:Arc<JournalBudget>)->Result<Self,FsError> {
        if drive.is_empty() || opts.quiet_window.is_zero() || opts.max_dirty_age.is_zero()
            || opts.quiet_window.as_millis() > i64::MAX as u128
            || opts.max_dirty_age.as_millis() > i64::MAX as u128
            || opts.retry_initial.is_zero() || opts.retry_max < opts.retry_initial { return Err(FsError::Invalid); }
        // Give an aborted publisher a chance to release its SQLite connection on drop/reopen.
        tokio::task::yield_now().await;
        let (journal, state) = Journal::open(state_dir, drive)?;
        let events = broadcast::channel(256).0;
        let accounted = state.usage(); budget.used.fetch_add(accounted,Ordering::SeqCst);
        let inner = Arc::new(Inner { client, drive: drive.into(), budget:budget.clone(), opts, publish_lock: Mutex::new(()),
            core: Mutex::new(Core { journal, state, online: SyncState::Online, closed: false, budget, accounted, events:events.clone() }),
            events, wake: Arc::new(Notify::new()), task: std::sync::Mutex::new(None) });
        let weak = Arc::downgrade(&inner);
        let task = tokio::spawn(publisher::run(weak, inner.wake.clone()));
        *inner.task.lock().unwrap_or_else(|e| e.into_inner()) = Some(task);
        let lease = Arc::new(Lease(Arc::downgrade(&inner)));
        Ok(Self { inner, _lease: lease })
    }
    pub fn set_journal_cap(&self, cap: u64) { self.inner.budget.set_cap(cap); }
    pub async fn pending_paths(&self) -> Vec<(String, u64)> {
        let c = self.inner.core.lock().await;
        let mut paths: std::collections::BTreeMap<String,u64> = c.state.nodes.iter().filter(|(_, n)| n.dirty_since.is_some()).map(|(p,n)| (p.clone(), n.attr.size)).collect();
        for action in &c.state.actions { if let Action::Meta(op) = action { let p = match op { Op::Mkdir {path} | Op::Delete {path,..} | Op::Put {path,..} => path, Op::Rename {to,..} => to }; paths.entry(p.clone()).or_insert(0); } }
        paths.into_iter().collect()
    }
    pub fn subscribe(&self) -> broadcast::Receiver<VfsEvent> { self.inner.events.subscribe() }
    fn changed(&self, paths: Vec<String>) { let _ = self.inner.events.send(VfsEvent::Changed { paths }); }
    async fn core(&self) -> Result<tokio::sync::MutexGuard<'_, Core>, FsError> {
        let c = self.inner.core.lock().await;
        if c.closed { Err(FsError::Busy) } else { Ok(c) }
    }
    /// Cache the namespace and manifests as well as shard bytes before going offline.
    pub async fn warm_metadata(&self, p: &str) -> Result<(), FsError> {
        let p = path(p)?;
        let mut c = self.core().await?;
        let mut ancestor = String::new();
        if !p.is_empty() {
            self.inner.list(&mut c.state, "").await?;
            for component in parent(&p).split('/').filter(|part| !part.is_empty()) {
                if !ancestor.is_empty() { ancestor.push('/'); }
                ancestor.push_str(component);
                self.inner.list(&mut c.state, &ancestor).await?;
            }
        }
        self.inner.load(&mut c.state, &p).await?;
        self.inner.tree(&mut c.state, &p).await?;
        c.persist()
    }
    pub async fn lookup(&self, p: &str) -> Result<Attr, FsError> {
        let p = path(p)?; let mut c = self.core().await?;
        self.inner.load(&mut c.state, &p).await?;
        c.persist()?;
        Ok(c.state.nodes[&p].attr.clone())
    }
    pub async fn readdir(&self, dir: &str) -> Result<Vec<DirEntry>, FsError> {
        let p = path(dir)?; let mut c = self.core().await?;
        self.inner.list(&mut c.state, &p).await?;
        c.persist()?;
        Ok(entries(&c.state, &p))
    }
    pub async fn read(&self, p: &str, off: u64, len: u32) -> Result<Bytes, FsError> {
        let p = path(p)?; let mut c = self.core().await?;
        self.inner.load(&mut c.state, &p).await?;
        self.inner.base(&mut c.state, &p).await?;
        c.persist()?;
        let n = c.state.nodes[&p].clone();
        let dir = c.journal.dir.clone();
        self.inner.read_node(&dir, &n, off, u64::from(len)).await
    }
    pub async fn create(&self, p: &str, kind: Kind) -> Result<Attr, FsError> {
        let p = path(p)?; if p.is_empty() { return Err(FsError::Exists); }
        uls_proto::validate_path(&wire(&p, kind)).map_err(|_| FsError::Invalid)?;
        let mut c = self.core().await?;
        match self.inner.load(&mut c.state, &p).await {
            Ok(()) => return Err(FsError::Exists), Err(FsError::NotFound) => (), Err(e) => return Err(e),
        }
        self.inner.load(&mut c.state, parent(&p)).await?;
        if c.state.nodes[parent(&p)].attr.kind != Kind::Directory { return Err(FsError::NotDir); }
        let mut s = c.state.clone();
        // A recreated path is a new identity; open handles keep the retired identity.
        s.ids.remove(&p);
        let a = attr(s.allocate_id(&p), kind, 0, now_ms());
        let mut n = Node::new(a.clone(), None);
        if kind == Kind::File { n.touch(); }
        s.nodes.insert(p.clone(), n); s.hidden.remove(&p);
        if kind == Kind::File { s.queue_file(&p); } else {
            s.listings.insert(p.clone()); s.actions.push(Action::Meta(Op::Mkdir { path: wire(&p, kind) }));
        }
        c.install(s)?; drop(c); self.changed(vec![p]); self.inner.wake.notify_one(); Ok(a)
    }
    pub async fn write(&self, p: &str, off: u64, data: &[u8]) -> Result<u32, FsError> {
        let p = path(p)?;
        let len = u32::try_from(data.len()).map_err(|_| FsError::Invalid)?;
        let end = off.checked_add(data.len() as u64).filter(|n| *n <= i64::MAX as u64).ok_or(FsError::Invalid)?;
        let mut c = self.core().await?;
        self.inner.load(&mut c.state, &p).await?;
        self.inner.base(&mut c.state, &p).await?;
        if data.is_empty() { return Ok(0); }
        let mut s = c.state.clone(); let blob = s.next_blob; s.next_blob += 1;
        // Reserve blob IDs durably before creation so even an interrupted write cannot reuse one.
        c.install(s.clone())?;
        if let Err(e) = c.journal.write_blob(blob, data) { let _ = c.journal.collect(&c.state); return Err(e); }
        let n = s.nodes.get_mut(&p).ok_or(FsError::NotFound)?;
        n.extents.push(Extent { off, len: data.len() as u64, stored_len: data.len() as u64, blob });
        n.attr.size = n.attr.size.max(end); n.touch(); s.queue_file(&p);
        if let Err(e) = c.install(s) { let _ = c.journal.collect(&c.state); return Err(e); }
        drop(c); self.changed(vec![p]); self.inner.wake.notify_one(); Ok(len)
    }
    pub async fn truncate(&self, p: &str, size: u64) -> Result<(), FsError> {
        if size > i64::MAX as u64 { return Err(FsError::Invalid); }
        let p = path(p)?; let mut c = self.core().await?;
        self.inner.load(&mut c.state, &p).await?; self.inner.base(&mut c.state, &p).await?;
        let mut s = c.state.clone(); let n = s.nodes.get_mut(&p).ok_or(FsError::NotFound)?;
        if size == n.attr.size { return Ok(()); }
        n.base_limit = n.base_limit.min(size);
        n.extents.retain(|e| e.off < size);
        for e in &mut n.extents { e.len = e.len.min(size - e.off); }
        n.attr.size = size; n.touch(); s.queue_file(&p);
        c.install(s)?; c.journal.collect(&c.state)?;
        drop(c); self.changed(vec![p]); self.inner.wake.notify_one(); Ok(())
    }
    pub async fn rename(&self, from: &str, to: &str, replace: bool) -> Result<(), FsError> {
        let from = path(from)?; let to = path(to)?;
        if from.is_empty() || to.is_empty() { return Err(FsError::Invalid); }
        let mut c = self.core().await?; self.inner.load(&mut c.state, &from).await?;
        if from == to { return Ok(()); }
        if within(&to, &from) { return Err(FsError::Invalid); }
        self.inner.load(&mut c.state, parent(&to)).await?;
        if c.state.nodes[parent(&to)].attr.kind != Kind::Directory { return Err(FsError::NotDir); }
        self.inner.tree(&mut c.state, &from).await?;
        let kind = c.state.nodes[&from].attr.kind;
        let target = match self.inner.load(&mut c.state, &to).await {
            Ok(()) => Some(c.state.nodes[&to].clone()), Err(FsError::NotFound) => None, Err(e) => return Err(e),
        };
        if let Some(n) = &target {
            if !replace { return Err(FsError::Exists); }
            if n.attr.kind != kind { return Err(if n.attr.kind == Kind::Directory { FsError::IsDir } else { FsError::NotDir }); }
            if kind == Kind::Directory { self.inner.list(&mut c.state, &to).await?;
                if !entries(&c.state, &to).is_empty() { return Err(FsError::NotEmpty); } }
        }
        let moved: Vec<_> = c.state.nodes.keys().filter(|p| within(p, &from)).cloned().collect();
        for p in &moved {
            uls_proto::validate_path(&wire(&format!("{to}{}", &p[from.len()..]), c.state.nodes[p].attr.kind))
                .map_err(|_| FsError::Invalid)?;
        }
        let mut s = c.state.clone();
        if target.is_some() { retire(&mut s, &to); s.actions.push(Action::Meta(Op::Delete { path: wire(&to, kind), if_version: None })); }
        for p in moved {
            let n = s.nodes.remove(&p).ok_or(FsError::NotFound)?;
            let dest = format!("{to}{}", &p[from.len()..]);
            s.hidden.insert(p.clone()); s.hidden.remove(&dest);
            s.ids.remove(&p); s.ids.insert(dest.clone(), n.attr.id);
            s.nodes.insert(dest.clone(), n);
            if s.listings.remove(&p) { s.listings.insert(dest); }
        }
        s.actions.push(Action::Meta(Op::Rename { from: wire(&from, kind), to: wire(&to, kind), if_version: None }));
        c.install(s)?; drop(c); self.changed(vec![from, to]); self.inner.wake.notify_one(); Ok(())
    }
    pub async fn remove(&self, p: &str) -> Result<(), FsError> {
        let p = path(p)?; if p.is_empty() { return Err(FsError::Invalid); }
        let mut c = self.core().await?; self.inner.load(&mut c.state, &p).await?;
        let n = c.state.nodes[&p].clone();
        if n.attr.kind == Kind::Directory { self.inner.list(&mut c.state, &p).await?;
            if !entries(&c.state, &p).is_empty() { return Err(FsError::NotEmpty); } }
        let mut s = c.state.clone(); retire(&mut s, &p);
        s.actions.push(Action::Meta(Op::Delete { path: wire(&p, n.attr.kind), if_version: None }));
        c.install(s)?; drop(c); self.changed(vec![p]); self.inner.wake.notify_one(); Ok(())
    }
    /// Local fsync/close barrier. Publication follows the configured quiet window.
    pub async fn flush(&self, p: &str) -> Result<(), FsError> {
        let p = path(p)?; let mut c = self.core().await?; self.inner.load(&mut c.state, &p).await?;
        let mut s = c.state.clone(); s.nodes.get_mut(&p).ok_or(FsError::NotFound)?.flushed = true;
        c.install(s)?; drop(c); self.inner.wake.notify_one(); Ok(())
    }
    pub async fn get_xattr(&self, p: &str, name: &str) -> Result<Bytes, FsError> {
        let p = path(p)?; let mut c = self.core().await?; self.inner.load(&mut c.state, &p).await?;
        c.state.nodes[&p].xattrs.get(name).cloned().map(Bytes::from).ok_or(FsError::NotFound)
    }
    pub async fn list_xattr(&self, p: &str) -> Result<Vec<String>, FsError> {
        let p = path(p)?; let mut c = self.core().await?; self.inner.load(&mut c.state, &p).await?;
        Ok(c.state.nodes[&p].xattrs.keys().cloned().collect())
    }
    pub async fn set_xattr(&self, p: &str, name: &str, value: &[u8]) -> Result<(), FsError> {
        self.xattr(p, name, Some(value)).await
    }
    pub async fn remove_xattr(&self, p: &str, name: &str) -> Result<(), FsError> {
        self.xattr(p, name, None).await
    }
    async fn xattr(&self, p: &str, name: &str, value: Option<&[u8]>) -> Result<(), FsError> {
        if name.is_empty() || name.contains('\0') { return Err(FsError::Invalid); }
        let p = path(p)?; let mut c = self.core().await?; self.inner.load(&mut c.state, &p).await?;
        let mut s = c.state.clone(); let n = s.nodes.get_mut(&p).ok_or(FsError::NotFound)?;
        if let Some(v) = value { n.xattrs.insert(name.into(), v.into()); }
        else if n.xattrs.remove(name).is_none() { return Err(FsError::NotFound); }
        n.attr.changed = filetime(now_ms());
        c.install(s)?; drop(c); self.changed(vec![p]); Ok(())
    }
    pub async fn apply_remote(&self, ev: WatchEvent) {
        let mut c = self.inner.core.lock().await;
        let paths = match ev { WatchEvent::Change(ch) => vec![ch.path.trim_end_matches('/').into()],
            WatchEvent::Resync { .. } => vec![String::new()] };
        let stale: Vec<_> = c.state.nodes.keys().filter(|p| !p.is_empty()
            && !c.state.pinned(p) && paths.iter().any(|v| v.is_empty() || within(p, v))).cloned().collect();
        for p in stale { if let Some(n) = c.state.nodes.get_mut(&p) { n.valid = false; } }
        let preserve: std::collections::BTreeSet<_> = c.state.listings.iter()
            .filter(|p| c.state.pinned(p)).cloned().collect();
        c.state.listings = preserve;
        if let Err(e) = c.persist() { tracing::warn!("remote invalidation journal: {e}"); }
        drop(c); self.changed(paths);
    }
    pub async fn pending(&self) -> PendingSummary {
        let c = self.inner.core.lock().await;
        PendingSummary { files: c.state.actions.iter().filter(|a| matches!(a, Action::File { .. })).count(),
            metadata_ops: c.state.actions.iter().filter(|a| matches!(a, Action::Meta(_))).count(),
            bytes: c.state.bytes(), state: c.online.clone() }
    }
    /// Drain immediately. On failure, return the error with the journal intact for reopening.
    pub async fn shutdown(self) -> Result<(), FsError> {
        { let mut c = self.inner.core.lock().await; c.closed = true; }
        let task = self.inner.task.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(task) = task { task.abort(); let _ = task.await; }
        self.inner.publish(true).await
    }
}
impl Core {
    fn persist(&mut self) -> Result<(), FsError> { self.journal.save(&self.state) }
    fn install(&mut self, s: State) -> Result<(), FsError> {
        let next = s.usage();
        if let Err(e) = self.budget.update(self.accounted,next) { let _ = self.events.send(VfsEvent::JournalFull); return Err(e); }
        if let Err(e) = self.journal.save(&s) {
            // Roll back a reservation, even if the cap was lowered during the disk write.
            if next > self.accounted { self.budget.used.fetch_sub(next-self.accounted,Ordering::SeqCst); }
            else { self.budget.used.fetch_add(self.accounted-next,Ordering::SeqCst); }
            return Err(e);
        }
        self.accounted = next; self.state = s; Ok(())
    }
}
fn retire(s: &mut State, p: &str) {
    if let Some(n) = s.nodes.remove(p) { s.retired.insert(n.attr.id, n); }
    s.hidden.insert(p.into()); s.listings.remove(p); s.ids.remove(p);
}
fn entries(s: &State, p: &str) -> Vec<DirEntry> {
    s.nodes.iter().filter(|(k, n)| n.valid && !k.is_empty() && parent(k) == p)
        .map(|(k, n)| DirEntry { name: k.rsplit('/').next().unwrap_or(k).into(), attr: n.attr.clone() }).collect()
}
impl Inner {
    async fn load(&self, s: &mut State, p: &str) -> Result<(), FsError> {
        if s.hidden.iter().any(|h| within(p, h)) { return Err(FsError::NotFound); }
        if s.nodes.get(p).is_some_and(|n| n.valid) { return Ok(()); }
        // A complete listing also caches absence (including macOS metadata probes).
        if !p.is_empty() && s.listings.contains(parent(p)) { return Err(FsError::NotFound); }
        let stat = match self.client.stat(&self.drive, p).await {
            Err(uls_client::Error::NotFound { .. }) if !p.is_empty() => self.client.stat(&self.drive, &format!("{p}/")).await?,
            other => other?,
        };
        let kind = if stat.node_type == NodeType::Folder { Kind::Directory } else { Kind::File };
        let id = s.allocate_id(p);
        let mut n = Node::new(attr(id, kind, stat.size.unwrap_or(0), stat.mtime_ms.unwrap_or(0)), stat.version_id);
        if let Some(old) = s.nodes.get(p) { n.xattrs = old.xattrs.clone(); }
        s.nodes.insert(p.into(), n); Ok(())
    }
    async fn list(&self, s: &mut State, p: &str) -> Result<(), FsError> {
        self.load(s, p).await?;
        if s.nodes[p].attr.kind != Kind::Directory { return Err(FsError::NotDir); }
        if s.listings.contains(p) { return Ok(()); }
        let remote = self.client.list(&self.drive, p).await?;
        let mut present = std::collections::BTreeSet::new();
        for e in remote {
            let name = e.name.trim_end_matches('/');
            let full = if p.is_empty() { name.into() } else { format!("{p}/{name}") };
            if s.hidden.iter().any(|h| within(&full, h)) { continue; }
            present.insert(full.clone());
            if s.pinned(&full) { continue; }
            let id = s.allocate_id(&full);
            let kind = if e.node_type == NodeType::Folder { Kind::Directory } else { Kind::File };
            let mut node = Node::new(attr(id, kind, e.size.unwrap_or(0), e.mtime_ms.unwrap_or(0)), e.version_id);
            if let Some(old) = s.nodes.get(&full) { node.xattrs = old.xattrs.clone(); }
            s.nodes.insert(full, node);
        }
        let missing: Vec<_> = s.nodes.keys().filter(|k| !k.is_empty() && parent(k) == p
            && !present.contains(*k) && !s.pinned(k)).cloned().collect();
        for p in missing { if let Some(n) = s.nodes.get_mut(&p) { n.valid = false; } }
        s.listings.insert(p.into()); Ok(())
    }
    async fn tree(&self, s: &mut State, p: &str) -> Result<(), FsError> {
        let mut todo = vec![p.to_string()];
        while let Some(p) = todo.pop() {
            if s.nodes[&p].attr.kind == Kind::Directory {
                self.list(s, &p).await?;
                todo.extend(s.nodes.iter().filter(|(k,n)| n.valid && !k.is_empty() && parent(k) == p).map(|(k,_)| k.clone()));
            } else { self.base(s, &p).await?; }
        }
        Ok(())
    }
    async fn base(&self, s: &mut State, p: &str) -> Result<(), FsError> {
        let n = s.nodes.get_mut(p).ok_or(FsError::NotFound)?;
        if n.attr.kind == Kind::Directory { return Err(FsError::IsDir); }
        if n.base.is_none() && n.version.is_some() {
            n.base = Some(self.client.manifest(&self.drive, p, n.version.as_deref()).await?);
        }
        Ok(())
    }
    async fn read_node(&self, dir: &Path, n: &Node, off: u64, len: u64) -> Result<Bytes, FsError> {
        let len = len.min(n.attr.size.saturating_sub(off));
        let mut out = vec![0; usize::try_from(len).map_err(|_| FsError::Invalid)?];
        if let Some(base) = &n.base {
            let end = off.saturating_add(len).min(n.base_limit);
            if off < end {
                // Fetch only gaps: an entirely local overwrite remains readable while offline.
                let mut gaps = vec![(off, end)];
                for e in &n.extents {
                    gaps = gaps.into_iter().flat_map(|(a,b)| {
                        let mut v = Vec::new();
                        if a < e.off { v.push((a,b.min(e.off))); }
                        if b > e.off + e.len { v.push((a.max(e.off+e.len),b)); }
                        v
                    }).collect();
                }
                for (a,b) in gaps {
                    let bytes = self.client.read_manifest_range(&self.drive, &base.shards, a, b-a).await?;
                    if bytes.len() as u64 != b-a { return Err(FsError::Io("short base read".into())); }
                    out[(a-off) as usize..(b-off) as usize].copy_from_slice(&bytes);
                }
            }
        }
        Journal::overlay(dir, n, off, &mut out)?; Ok(Bytes::from(out))
    }
}
