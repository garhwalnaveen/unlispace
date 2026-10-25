use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::Duration;
use bytes::Bytes;
use uls_proto::{Change, CommitResponse, CommitResult, ManifestResponse, Op, ShardRef};
use crate::journal::{Action, Batch, Node, Prepared, moved_path};
use crate::types::*;
use crate::{Core, Inner};

pub(crate) async fn run(weak: Weak<Inner>, wake: Arc<tokio::sync::Notify>) {
    let mut delay = Duration::ZERO;
    let mut retrying = false;
    loop {
        if retrying { tokio::time::sleep(delay).await; }
        else { tokio::select! { _ = tokio::time::sleep(delay) => (), _ = wake.notified() => () } }
        let Some(inner) = weak.upgrade() else { return; };
        if inner.core.lock().await.closed { return; }
        let result = inner.publish(false).await;
        let mut c = inner.core.lock().await;
        match result {
            Ok(()) => { retrying = false; delay = next_delay(&c, &inner.opts); }
            Err(e) => {
                tracing::debug!("publisher retained journal after: {e}");
                if c.online != SyncState::Offline {
                    c.online = SyncState::Offline;
                    let _ = inner.events.send(VfsEvent::State(SyncState::Offline));
                }
                delay = if !retrying { inner.opts.retry_initial }
                    else { delay.saturating_mul(2).min(inner.opts.retry_max) };
                retrying = true;
            }
        }
    }
}
fn ready(n: &Node, opts: &VfsOptions, now: i64) -> bool {
    n.dirty_since.is_none_or(|since| now.saturating_sub(since) as u128 >= opts.max_dirty_age.as_millis()
        || (n.flushed && now.saturating_sub(n.modified_ms) as u128 >= opts.quiet_window.as_millis()))
}
fn ready_count(c: &Core, opts: &VfsOptions, force: bool) -> usize {
    let now = now_ms(); let mut count = 0;
    for a in c.state.actions.iter().take(uls_proto::MAX_COMMIT_OPS) {
        if let Action::File { id, .. } = a
            && !force && c.state.node(*id).is_some_and(|n| !ready(n, opts, now)) { break; }
        count += 1;
    }
    // Neighbouring closes coalesce at their latest quiet deadline, bounded by dirty age.
    if !force && count > 0 && count < uls_proto::MAX_COMMIT_OPS
        && let Some(Action::File { id, .. }) = c.state.actions.get(count)
        && c.state.node(*id).is_some_and(|n| n.flushed)
        && c.state.actions[..count].iter().all(|a| match a {
            Action::File { id, .. } => c.state.node(*id).is_some_and(|n| n.flushed
                && n.dirty_since.is_some_and(|since| (now.saturating_sub(since) as u128) < opts.max_dirty_age.as_millis())),
            _ => true,
        }) { return 0; }
    count
}
fn next_delay(c: &Core, opts: &VfsOptions) -> Duration {
    if c.state.batch.is_some() { return Duration::from_millis(1); }
    let mut quiet = 0_i64; let mut maximum = i64::MAX; let mut found = false;
    for action in c.state.actions.iter().take(uls_proto::MAX_COMMIT_OPS) {
        if let Action::File { id, .. } = action && let Some(n) = c.state.node(*id) {
            found = true;
            maximum = maximum.min(n.dirty_since.unwrap_or_else(now_ms).saturating_add(opts.max_dirty_age.as_millis() as i64));
            if !n.flushed { break; }
            quiet = quiet.max(n.modified_ms.saturating_add(opts.quiet_window.as_millis() as i64));
        }
    }
    if !found { return Duration::from_secs(3600); }
    let deadline = if quiet == 0 { maximum } else { quiet.min(maximum) };
    Duration::from_millis(deadline.saturating_sub(now_ms()).max(1) as u64)
}
impl Inner {
    pub(crate) async fn publish(&self, force: bool) -> Result<(), FsError> {
        let _publisher = self.publish_lock.lock().await;
        loop {
            let (mut batch, dir) = {
                let mut c = self.core.lock().await;
                if c.state.batch.is_none() {
                    let count = ready_count(&c, &self.opts, force);
                    if count == 0 { return Ok(()); }
                    let actions = c.state.actions[..count].to_vec();
                    let mut nodes: BTreeMap<_,_> = c.state.nodes.values().chain(c.state.retired.values())
                        .map(|n| (n.attr.id,n.clone())).collect();
                    let mut paths: BTreeMap<_,_> = c.state.nodes.iter().map(|(p,n)| (n.attr.id,n.base.as_ref().map_or_else(|| p.clone(), |m| m.path.clone()))).collect();
                    for action in &actions { if let Action::File { id, path } = action { paths.insert(*id,path.clone()); } }
                    // Pin only the nodes used by this prefix or moved by its metadata.
                    nodes.retain(|id,_| actions.iter().any(|a| matches!(a, Action::File { id: i, .. } if i == id))
                        || paths.get(id).is_some_and(|p| moved_path(p, &actions).as_ref() != Some(p)));
                    let mut s = c.state.clone();
                    s.batch = Some(Batch { actions, nodes, paths, prepared: vec![], conflicts: BTreeMap::new(),
                        conflict_attempt: 0, cursor: None, attempted: false });
                    c.install(s)?;
                }
                (c.state.batch.clone().ok_or(FsError::Stale)?, c.journal.dir.clone())
            };
            if batch.prepared.is_empty() {
                for action in &batch.actions {
                    match action {
                        Action::Meta(op) => batch.prepared.push(Prepared { op: op.clone(), file: None }),
                        Action::File { id, path } => {
                            let n = batch.nodes.get(id).ok_or(FsError::NotFound)?;
                            let shards = self.fold(&dir, n).await?;
                            batch.prepared.push(Prepared { file: Some(*id), op: Op::Put { path: path.clone(),
                                if_version: n.version.clone(), if_absent: n.version.is_none(), size: n.attr.size,
                                content_type: mime_guess::from_path(path).first_or_octet_stream().to_string(),
                                mtime_ms: n.modified_ms, shards } });
                        }
                    }
                }
                batch.cursor = Some(self.client.changes(&self.drive, 0, 1).await?.last_ev);
                self.save_batch(&batch).await?;
            }
            let response = self.commit_batch(&mut batch, &dir).await?;
            self.accept(batch, response).await?;
        }
    }
    async fn save_batch(&self, batch: &Batch) -> Result<(), FsError> {
        let mut c = self.core.lock().await;
        let mut s = c.state.clone(); s.batch = Some(batch.clone()); c.install(s)
    }
    async fn commit_batch(&self, batch: &mut Batch, dir: &Path) -> Result<CommitResponse, FsError> {
        if batch.attempted && let Some(response) = self.reconcile(batch).await? { return Ok(response); }
        loop {
            batch.attempted = true; self.save_batch(batch).await?;
            match self.client.commit(&self.drive, batch.prepared.iter().map(|p| p.op.clone()).collect()).await {
                Ok(response) => return Ok(response),
                Err(uls_client::Error::PreconditionFailed { path: failed, .. }) => {
                    let original = batch.conflicts.remove(&failed).unwrap_or_else(|| failed.clone());
                    let copy = self.conflict_path(&original, batch.conflict_attempt);
                    batch.conflict_attempt += 1;
                    if batch.conflict_attempt > 100 { return Err(FsError::Busy); }
                    uls_proto::validate_path(&copy).map_err(|_| FsError::Invalid)?;
                    let p = batch.prepared.iter_mut().find(|p| matches!(&p.op, Op::Put { path, .. } if path == &failed))
                        .ok_or(FsError::Stale)?;
                    if let Op::Put { path, if_version, if_absent, .. } = &mut p.op {
                        *path = copy.clone(); *if_version = None; *if_absent = true;
                    }
                    batch.conflicts.insert(copy, original); batch.attempted = false;
                    self.save_batch(batch).await?;
                }
                Err(uls_client::Error::MissingShards { .. }) => {
                    batch.attempted = false; self.save_batch(batch).await?;
                    for p in &batch.prepared { if let Some(id) = p.file { self.fold(dir, &batch.nodes[&id]).await?; } }
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
    /// A persisted cursor plus the ordered commit log resolves an ACK lost after server commit.
    /// Verify put manifests by immutable version, even if a later writer has changed the head.
    async fn reconcile(&self, batch: &Batch) -> Result<Option<CommitResponse>, FsError> {
        if batch.prepared.iter().all(|p| matches!(p.op, Op::Mkdir { .. })) {
            let mut results = vec![];
            for p in &batch.prepared {
                let (path, _) = op_key(&p.op);
                match self.client.stat(&self.drive, path).await {
                    Ok(stat) if stat.node_type == uls_proto::NodeType::Folder => results.push(CommitResult {
                        path: path.into(), version_id: stat.version_id.unwrap_or_default(), size: None }),
                    Err(uls_client::Error::NotFound { .. }) => return Ok(None),
                    Err(e) => return Err(e.into()),
                    _ => return Ok(None),
                }
            }
            return Ok(Some(CommitResponse { seq: self.client.drive_info(&self.drive).await?.head_seq, results }));
        }
        let mut cursor = batch.cursor.unwrap_or(0); let mut groups: BTreeMap<u64,Vec<Change>> = BTreeMap::new();
        loop {
            let page = self.client.changes(&self.drive, cursor, 1000).await?;
            for change in page.changes { cursor = change.ev; groups.entry(change.seq).or_default().push(change); }
            if !page.more { break; }
        }
        for (seq, changes) in groups {
            let mut pos = 0; let mut results = vec![]; let mut matches = true;
            for p in &batch.prepared {
                let (path, op) = op_key(&p.op);
                let found = changes[pos..].iter().position(|c| c.path == path && c.op == op).map(|i| i+pos);
                if let Some(i) = found {
                    let ch = &changes[i]; pos = i+1;
                    if let Op::Put { size, mtime_ms, shards, .. } = &p.op {
                        let Some(version) = &ch.version_id else { matches = false; break; };
                        let m = self.client.manifest(&self.drive, path, Some(version)).await?;
                        if m.size != *size || m.mtime_ms != Some(*mtime_ms) || m.shards != *shards { matches = false; break; }
                    }
                    results.push(CommitResult { path: path.into(), version_id: ch.version_id.clone().unwrap_or_default(), size: None });
                } else if matches!(p.op, Op::Mkdir { .. }) {
                    results.push(CommitResult { path: path.into(), version_id: String::new(), size: None });
                } else { matches = false; break; }
            }
            if matches { return Ok(Some(CommitResponse { seq, results })); }
        }
        Ok(None)
    }
    async fn accept(&self, batch: Batch, response: CommitResponse) -> Result<(), FsError> {
        if response.results.len() != batch.prepared.len() { return Err(FsError::Io("commit result count mismatch".into())); }
        let mut versions = BTreeMap::new();
        // Real servers create new heads for every renamed descendant; the mock retains heads.
        // Resolve the commit's version, rather than adopting a subsequent remote edit as our base.
        for (id, node) in &batch.nodes {
            let Some(start) = batch.paths.get(id) else { continue; };
            let start = batch.prepared.iter().find(|p| p.file == Some(*id)).and_then(|p| match &p.op {
                Op::Put { path,.. } if batch.conflicts.contains_key(path) => Some(path), _ => None,
            }).unwrap_or(start);
            if node.attr.kind != Kind::File { continue; }
            let Some(final_path) = moved_path(start, &batch.actions) else { continue; };
            if &final_path == start { continue; }
            let expected = batch.prepared.iter().find(|p| p.file == Some(*id)).and_then(|p| match &p.op {
                Op::Put { shards, .. } => Some(shards), _ => None,
            }).or_else(|| node.base.as_ref().map(|m| &m.shards));
            if let Some(expected) = expected {
                let history = self.client.versions(&self.drive, &final_path).await?;
                let version = history.iter().rev().find(|v| v.seq == response.seq).map(|v| v.version_id.as_str());
                let m = self.client.manifest(&self.drive, &final_path, version).await?;
                if m.shards == *expected { versions.insert(*id, m.version_id); }
            }
        }
        let mut c = self.core.lock().await; let mut s = c.state.clone();
        s.actions.drain(..batch.actions.len()); s.batch = None;
        let mut bytes = 0;
        for (p, result) in batch.prepared.iter().zip(&response.results) {
            let Some(id) = p.file else { continue; };
            let snapshot = &batch.nodes[&id];
            let Op::Put { path, size, mtime_ms, content_type, shards, .. } = &p.op else { return Err(FsError::Stale); };
            bytes += size;
            let original = batch.conflicts.get(path).unwrap_or(path);
            let final_path = moved_path(path, &batch.actions);
            if batch.conflicts.contains_key(path) {
                // Direct file operations follow the local conflict copy, preserving remote head.
                for action in &mut s.actions {
                    match action {
                        Action::File { id: i, path: p } if *i == id => *p = path.clone(),
                        Action::Meta(Op::Rename { from, .. }) if from == original => *from = path.clone(),
                        Action::Meta(Op::Delete { path: p, .. }) if p == original => *p = path.clone(),
                        _ => (),
                    }
                }
                let old_path = s.nodes.iter().find(|(_,n)| n.attr.id == id).map(|(p,_)| p.clone());
                if let Some(old) = old_path && let Some(new) = final_path.as_ref().and_then(|p| moved_path(p, &s.actions)) {
                    let n = s.nodes.remove(&old).ok_or(FsError::NotFound)?;
                    s.ids.remove(&old); s.ids.insert(new.clone(),id); s.hidden.remove(&new); s.nodes.insert(new,n);
                }
            }
            let version = versions.get(&id).cloned().unwrap_or_else(|| result.version_id.clone());
            let n = s.nodes.values_mut().find(|n| n.attr.id == id).or_else(|| s.retired.get_mut(&id));
            if let Some(n) = n {
                if n.revision == snapshot.revision {
                    clean(n, ManifestResponse { path: final_path.clone().unwrap_or_else(|| path.clone()), version_id: version,
                        size: *size, mtime_ms: Some(*mtime_ms), content_type: Some(content_type.clone()), shards: shards.clone() });
                } else {
                    // Retain the original base and all overlays: they still describe the latest
                    // local bytes, including a truncate that happened while uploading this snapshot.
                    n.version = Some(version);
                    if let Some(base) = &mut n.base { base.path = final_path.clone().unwrap_or_else(|| path.clone()); }
                }
            }
        }
        for (id, version) in versions {
            if let Some(n) = s.nodes.values_mut().find(|n| n.attr.id == id) {
                n.version = Some(version);
                if let Some(base) = &mut n.base && let Some(start) = batch.paths.get(&id)
                    && let Some(final_path) = moved_path(start, &batch.actions) { base.path = final_path; }
            }
        }
        for action in &mut s.actions {
            if let Action::File { id, path } = action && batch.nodes.contains_key(id) {
                // New writes were queued beyond the frozen prefix, so their destination is
                // already the namespace that prefix produces.
                if let Some(n) = s.nodes.values().find(|n| n.attr.id == *id)
                    && let Some(base) = &n.base { *path = base.path.clone(); }
            }
        }
        let had_meta = batch.actions.iter().any(|a| matches!(a, Action::Meta(_)));
        if had_meta {
            let stale: Vec<_> = s.nodes.keys().filter(|p| !p.is_empty() && !s.pinned(p)).cloned().collect();
            for p in stale { if let Some(n) = s.nodes.get_mut(&p) { n.valid = false; } }
        }
        if s.actions.is_empty() { s.retired.clear(); s.hidden.clear(); s.listings.clear(); }
        c.install(s)?; c.journal.collect(&c.state)?;
        if c.online != SyncState::Online { c.online = SyncState::Online; let _ = self.events.send(VfsEvent::State(SyncState::Online)); }
        drop(c);
        let paths = batch.prepared.iter().map(|p| op_key(&p.op).0.trim_end_matches('/').to_string()).collect::<Vec<_>>();
        let _ = self.events.send(VfsEvent::Transfer { paths: paths.clone(), bytes });
        let _ = self.events.send(VfsEvent::Changed { paths });
        for (copy, path) in batch.conflicts {
            let copy = moved_path(&copy, &batch.actions).unwrap_or(copy);
            let _ = self.events.send(VfsEvent::Conflict { path, copy });
        }
        Ok(())
    }
    /// Fold to disk in bounded ranges, then stream FastCDC; retain hashes and offsets only.
    async fn fold(&self, dir: &Path, n: &Node) -> Result<Vec<ShardRef>, FsError> {
        let scratch = dir.join(format!("fold-{}-{}.tmp", n.attr.id, n.revision));
        let mut f = File::create(&scratch)?; let mut off = 0;
        while off < n.attr.size {
            let bytes = self.read_node(dir, n, off, (1 << 20).min(n.attr.size-off)).await?;
            f.write_all(&bytes)?; off += bytes.len() as u64;
        }
        drop(f); let scan = scratch.clone();
        let chunks = tokio::task::spawn_blocking(move || {
            uls_chunk::chunk_reader(File::open(scan)?).map(|c| c.map(|(chunk,_)| chunk)).collect::<std::io::Result<Vec<_>>>()
        }).await.map_err(|e| FsError::Io(e.to_string()))??;
        let mut locations = BTreeMap::new();
        let shards = chunks.iter().map(|c| { locations.insert(c.hash.clone(),(c.offset,c.length));
            ShardRef { h: c.hash.clone(), n: c.length as u64 } }).collect();
        let hashes = locations.keys().cloned().collect::<Vec<_>>();
        let missing = self.client.missing(&self.drive, &hashes).await?;
        let mut f = File::open(&scratch)?;
        for hash in missing {
            let (off,len) = locations.get(&hash).ok_or_else(|| FsError::Io("unknown missing shard".into()))?;
            let mut data = vec![0; *len]; f.seek(SeekFrom::Start(*off))?; f.read_exact(&mut data)?;
            self.client.put_shard(&self.drive, &hash, Bytes::from(data)).await?;
        }
        drop(f); std::fs::remove_file(scratch)?; Ok(shards)
    }
    fn conflict_path(&self, path: &str, attempt: usize) -> String {
        let (dir,name) = path.rsplit_once('/').map_or(("",path), |(d,n)| (d,n));
        let (stem,ext) = name.rsplit_once('.').filter(|(s,_)| !s.is_empty()).map_or((name,String::new()), |(s,e)| (s,format!(".{e}")));
        let hostname = self.opts.hostname.chars().map(|c| if c == '/' || c == '\0' { '_' } else { c }).take(64).collect::<String>();
        let suffix = if attempt == 0 { String::new() } else { format!("-{attempt}") };
        let name = format!("{stem} (conflict, {hostname}{suffix}, {}){ext}", timestamp(now_ms()));
        if dir.is_empty() { name } else { format!("{dir}/{name}") }
    }
}
fn op_key(op: &Op) -> (&str, &str) {
    match op { Op::Put { path,.. } => (path,"put"), Op::Mkdir { path } => (path,"mkdir"),
        Op::Delete { path,.. } => (path,"delete"), Op::Rename { to,.. } => (to,"rename") }
}
fn clean(n: &mut Node, base: ManifestResponse) {
    n.version = Some(base.version_id.clone()); n.base_limit = base.size; n.base = Some(base);
    n.extents.clear(); n.dirty_since = None; n.flushed = false;
}
// Gregorian civil date from days since the Unix epoch (400-year era arithmetic).
fn timestamp(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let z = seconds.div_euclid(86400) + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096)/365;
    let mut y = yoe + era*400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp = (5*doy+2)/153;
    let d = doy - (153*mp+2)/5+1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += i64::from(m <= 2);
    let time = seconds.rem_euclid(86400);
    format!("{y:04}-{m:02}-{d:02} {:02}{:02}{:02}", time/3600, time/60%60, time%60)
}
#[cfg(test)]
mod tests {
    #[test]
    fn utc_conflict_timestamp() {
        assert_eq!(super::timestamp(0), "1970-01-01 000000");
        assert_eq!(super::timestamp(1_709_251_199_000), "2024-02-29 235959");
    }
    async fn committed_without_ack(v: &crate::Vfs) {
        use crate::journal::{Action, Batch, Prepared};
        use std::collections::BTreeMap;
        let (actions,nodes,mut paths,dir) = {
            let c = v.inner.core.lock().await;
            (c.state.actions.clone(), c.state.nodes.values().chain(c.state.retired.values())
                .map(|n| (n.attr.id,n.clone())).collect::<BTreeMap<_,_>>(),
                c.state.nodes.iter().map(|(p,n)| (n.attr.id,p.clone())).collect::<BTreeMap<_,_>>(),
                c.journal.dir.clone())
        };
        let mut prepared = vec![];
        for a in &actions {
            match a {
                Action::Meta(op) => prepared.push(Prepared { op: op.clone(), file: None }),
                Action::File { id,path } => {
                    paths.insert(*id,path.clone());
                    let n = &nodes[id]; let shards = v.inner.fold(&dir,n).await.unwrap();
                    prepared.push(Prepared { file: Some(*id), op: uls_proto::Op::Put { path: path.clone(),
                        if_version: n.version.clone(), if_absent: n.version.is_none(), size: n.attr.size,
                        content_type: "application/octet-stream".into(), mtime_ms: n.modified_ms, shards } });
                }
            }
        }
        let cursor = v.inner.client.changes("drive",0,1).await.unwrap().last_ev;
        let batch = Batch { actions,nodes,paths,prepared,conflicts: BTreeMap::new(), conflict_attempt: 0,
            cursor: Some(cursor),attempted: true };
        v.inner.save_batch(&batch).await.unwrap();
        // Deliberately leave the durable outbox untouched after a successful server commit.
        v.inner.client.commit("drive",batch.prepared.iter().map(|p| p.op.clone()).collect()).await.unwrap();
    }
    #[tokio::test]
    async fn recover_server_commit_with_lost_ack_and_newer_local_bytes() {
        use crate::{Kind,Vfs,VfsOptions};
        use std::time::Duration;
        for newer in [false,true] {
            let server = uls_mock::MockServer::start("test").await;
            let client = uls_client::Client::builder(server.url(),"test").build().unwrap();
            client.create_drive("drive",None).await.unwrap();
            let dir = tempfile::tempdir().unwrap();
            let v = Vfs::open(client.clone(),"drive",dir.path(), VfsOptions {
                quiet_window: Duration::from_secs(3600), max_dirty_age: Duration::from_secs(3600), ..VfsOptions::default()
            }).await.unwrap();
            v.create("a",Kind::File).await.unwrap(); v.write("a",0,b"initial").await.unwrap();
            v.rename("a","b",false).await.unwrap();
            committed_without_ack(&v).await;
            if newer { v.write("b",0,b"newest!").await.unwrap(); }
            drop(v);
            let v = Vfs::open(client.clone(),"drive",dir.path(),VfsOptions::default()).await.unwrap();
            v.shutdown().await.unwrap();
            assert_eq!(client.drive_info("drive").await.unwrap().head_seq, if newer { 2 } else { 1 });
            assert_eq!(client.read_range("drive","b",0,100).await.unwrap(),
                if newer { &b"newest!"[..] } else { &b"initial"[..] });
            assert_eq!(client.list("drive","").await.unwrap().len(),1);
        }
    }

}
