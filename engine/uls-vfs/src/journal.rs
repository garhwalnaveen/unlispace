use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use uls_proto::{ManifestResponse, Op};
use crate::types::*;

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Extent { pub off: u64, pub len: u64, pub stored_len: u64, pub blob: u64 }
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Node {
    pub attr: Attr,
    pub valid: bool,
    pub revision: u64,
    pub version: Option<String>,
    pub base: Option<ManifestResponse>,
    pub base_limit: u64,
    pub extents: Vec<Extent>,
    pub dirty_since: Option<i64>,
    pub modified_ms: i64,
    pub flushed: bool,
    pub xattrs: BTreeMap<String, Vec<u8>>,
}
impl Node {
    pub fn new(attr: Attr, version: Option<String>) -> Self {
        let base_limit = attr.size;
        Self { attr, valid: true, revision: 0, version, base: None, base_limit, extents: vec![], dirty_since: None,
            modified_ms: now_ms(), flushed: false, xattrs: BTreeMap::new() }
    }
    pub fn touch(&mut self) {
        let ms = now_ms();
        self.revision += 1;
        self.dirty_since.get_or_insert(ms);
        self.modified_ms = ms;
        self.attr.modified = filetime(ms);
        self.attr.changed = filetime(ms);
        self.flushed = false;
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) enum Action { File { id: u64, path: String }, Meta(Op) }
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Prepared { pub op: Op, pub file: Option<u64> }
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Batch {
    pub actions: Vec<Action>,
    pub nodes: BTreeMap<u64, Node>,
    pub paths: BTreeMap<u64, String>,
    pub prepared: Vec<Prepared>,
    pub conflicts: BTreeMap<String, String>,
    pub conflict_attempt: usize,
    pub cursor: Option<i64>,
    pub attempted: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct State {
    pub drive: String,
    pub batch: Option<Batch>,
    pub nodes: BTreeMap<String, Node>,
    pub retired: BTreeMap<u64, Node>,
    pub hidden: BTreeSet<String>,
    pub listings: BTreeSet<String>,
    pub ids: BTreeMap<String, u64>,
    pub actions: Vec<Action>,
    pub next_id: u64,
    pub next_blob: u64,
}
impl State {
    pub fn node(&self, id: u64) -> Option<&Node> {
        self.nodes.values().find(|n| n.attr.id == id).or_else(|| self.retired.get(&id))
    }
    pub fn blob_ids(&self) -> BTreeMap<u64, u64> {
        self.nodes.values().chain(self.retired.values())
            .chain(self.batch.iter().flat_map(|b| b.nodes.values()))
            .flat_map(|n| n.extents.iter().map(|e| (e.blob,e.stored_len))).collect()
    }
    pub fn bytes(&self) -> u64 { self.blob_ids().values().sum() }
    pub fn usage(&self) -> u64 {
        self.bytes().saturating_add(self.nodes.values().chain(self.retired.values())
            .flat_map(|n| &n.xattrs).map(|(k,v)| (k.len()+v.len()) as u64).sum::<u64>())
    }
    pub fn allocate_id(&mut self, path: &str) -> u64 {
        if let Some(id) = self.ids.get(path) { return *id; }
        let id = self.next_id; self.next_id += 1;
        self.ids.insert(path.into(), id); id
    }
    pub fn pinned(&self, path: &str) -> bool {
        self.nodes.get(path).is_some_and(|n| n.dirty_since.is_some()) ||
        self.actions.iter().any(|a| match a {
            Action::Meta(Op::Mkdir { path: p }) => path == p.trim_end_matches('/'),
            Action::Meta(Op::Rename { from, to, .. }) => within(path, from.trim_end_matches('/')) || within(path, to.trim_end_matches('/')),
            _ => false,
        })
    }
    pub fn queue_file(&mut self, path: &str) {
        let id = self.nodes[path].attr.id;
        let frozen = self.batch.as_ref().map_or(0, |b| b.actions.len());
        if self.actions[frozen..].iter().any(|a| matches!(a, Action::File { id: i, .. } if *i == id)) { return; }
        let node = &self.nodes[path];
        let mut original = node.base.as_ref().map_or(path, |m| m.path.as_str()).to_string();
        let prior = self.batch.as_ref().and_then(|b| b.actions.iter().find_map(|a| match a {
            Action::File { id: i, path } if *i == id => Some(path.as_str()), _ => None,
        }));
        if let Some(p) = prior { original = p.into(); }
        let existing = node.version.is_some() || prior.is_some();
        if existing { original = moved_path(&original, &self.actions[..frozen]).unwrap_or(original); }
        let position = if existing {
            self.actions[frozen..].iter().position(|a| matches!(a,
                Action::Meta(Op::Rename { from, .. }) if within(&original, from.trim_end_matches('/'))))
                .map_or(self.actions.len(), |i| i+frozen)
        } else { self.actions.len() };
        self.actions.insert(position, Action::File { id, path: original });
    }
}
pub(crate) struct Journal { db: Connection, pub dir: PathBuf, _lock: File }
impl Journal {
    pub fn open(dir: &Path, drive: &str) -> Result<(Self, State), FsError> {
        std::fs::create_dir_all(dir.join("blobs"))?;
        // File locks are released by the OS on process death, unlike lock-file sentinels.
        let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(dir.join("lock"))?;
        // A dropped Vfs in this process releases the lock when its publisher task exits, which can
        // lag the drop slightly. Wait briefly before reporting another live owner.
        let mut tries = 0;
        while lock.try_lock().is_err() {
            tries += 1;
            if tries > 50 { return Err(FsError::Busy); }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let db = Connection::open(dir.join("journal.db"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL);")?;
        let mut journal = Self { db, dir: dir.into(), _lock: lock };
        let existing: Option<String> = journal.db.query_row("SELECT state FROM journal WHERE id=1", [], |r| r.get(0))
            .optional()?;
        let state = if let Some(json) = existing {
            let s: State = serde_json::from_str(&json)?;
            if s.drive != drive { return Err(FsError::Invalid); }
            s
        } else {
            let mut s = State { drive: drive.into(), batch: None, nodes: BTreeMap::new(), retired: BTreeMap::new(),
                hidden: BTreeSet::new(), listings: BTreeSet::new(), ids: BTreeMap::new(),
                actions: vec![], next_id: 2, next_blob: 1 };
            s.ids.insert("".into(), 1);
            s.nodes.insert("".into(), Node::new(attr(1, Kind::Directory, 0, now_ms()), None));
            journal.save(&s)?; s
        };
        journal.collect(&state)?;
        File::open(dir)?.sync_all()?;
        Ok((journal, state))
    }
    pub fn save(&mut self, state: &State) -> Result<(), FsError> {
        let json = serde_json::to_string(state)?;
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO journal VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET state=excluded.state", params![json])?;
        tx.commit()?;
        Ok(())
    }
    pub fn blob_path(&self, id: u64) -> PathBuf { self.dir.join("blobs").join(id.to_string()) }
    pub fn write_blob(&self, id: u64, data: &[u8]) -> Result<(), FsError> {
        let mut f = OpenOptions::new().write(true).create_new(true).open(self.blob_path(id))?;
        f.write_all(data)?; f.sync_all()?;
        File::open(self.dir.join("blobs"))?.sync_all()?;
        Ok(())
    }
    pub fn overlay(dir: &Path, n: &Node, off: u64, buf: &mut [u8]) -> Result<(), FsError> {
        let end = off + buf.len() as u64;
        for e in &n.extents {
            let a = off.max(e.off); let b = end.min(e.off + e.len);
            if a < b {
                let mut f = File::open(dir.join("blobs").join(e.blob.to_string()))?;
                f.seek(SeekFrom::Start(a - e.off))?;
                f.read_exact(&mut buf[(a-off) as usize..(b-off) as usize])?;
            }
        }
        Ok(())
    }
    pub fn collect(&self, s: &State) -> Result<(), FsError> {
        let live: BTreeSet<_> = s.blob_ids().keys().map(u64::to_string).collect();
        for entry in std::fs::read_dir(self.dir.join("blobs"))? {
            let entry = entry?;
            if !live.contains(&entry.file_name().to_string_lossy().to_string()) {
                std::fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}
use rusqlite::OptionalExtension;

/// Track a path through an ordered metadata prefix. File replacements are separate identities.
pub(crate) fn moved_path(path: &str, actions: &[Action]) -> Option<String> {
    let mut path = path.to_string();
    for action in actions {
        match action {
            Action::Meta(Op::Rename { from, to, .. }) if path == from.trim_end_matches('/')
                || (from.ends_with('/') && within(&path, from.trim_end_matches('/'))) => {
                let from = from.trim_end_matches('/');
                path = format!("{}{}", to.trim_end_matches('/'), &path[from.len()..]);
            }
            Action::Meta(Op::Delete { path: deleted, .. }) if path == deleted.trim_end_matches('/')
                || (deleted.ends_with('/') && within(&path, deleted.trim_end_matches('/'))) => return None,
            _ => (),
        }
    }
    Some(path)
}
