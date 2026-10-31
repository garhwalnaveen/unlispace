//! Daemon state that survives restarts: the signed-in user (not the tokens), remembered mounts,
//! per-drive watch cursors (last `ev`, not `seq`) and the cache cap. Tokens never go in here.

use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::protocol::User;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAuth {
    pub api_endpoint: String,
    pub user: User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MountRecord {
    pub drive_id: String,
    pub name: String,
    #[serde(default)]
    pub mount_path: Option<String>,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Persisted {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub auth: Option<PersistedAuth>,
    #[serde(default)]
    pub mounts: Vec<MountRecord>,
    /// Last change-feed event id processed, per drive.
    #[serde(default)]
    pub cursors: BTreeMap<String, i64>,
    #[serde(default)]
    pub cache_cap_bytes: Option<i64>,
    #[serde(default)]
    pub journal_cap_bytes: Option<u64>,
    #[serde(default)]
    pub pins: Vec<PinRecord>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub upload_drives: Vec<String>,
    /// Upload bandwidth limit in bytes per second; absent or 0 = unlimited.
    #[serde(default)]
    pub upload_bandwidth_bps: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRecord {
    pub drive_id: String,
    pub path: String,
    pub shards: BTreeMap<String, u64>,
}

pub struct StateStore {
    path: PathBuf,
    inner: Mutex<Persisted>,
}

impl StateStore {
    /// A missing or unreadable file starts empty (and is overwritten on the next change).
    pub fn load(path: PathBuf) -> StateStore {
        let inner = match std::fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|_| {
                tracing::warn!("state file is corrupt; starting empty");
                Persisted::default()
            }),
            Err(_) => Persisted::default(),
        };
        StateStore { path, inner: Mutex::new(inner) }
    }

    pub fn get(&self) -> Persisted {
        self.lock().clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Persisted> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Publish memory only after its durable snapshot is installed; serialize the whole write.
    pub fn try_update(&self, f: impl FnOnce(&mut Persisted)) -> std::io::Result<()> {
        let mut current = self.lock();
        let mut snapshot = current.clone();
        f(&mut snapshot);
        snapshot.version = 1;
        write_atomic(&self.path, &snapshot)?;
        *current = snapshot;
        // Rename committed the new snapshot; retain it in memory even if directory sync fails.
        std::fs::File::open(self.path.parent().ok_or_else(|| std::io::Error::other("state path has no parent"))?)?.sync_all()
    }

    /// Best effort is reserved for replayable progress, such as change-feed cursors.
    pub fn update(&self, f: impl FnOnce(&mut Persisted)) {
        if let Err(e) = self.try_update(f) { tracing::warn!("could not save state: {e}"); }
    }

    pub fn cursor(&self, drive: &str) -> Option<i64> {
        self.lock().cursors.get(drive).copied()
    }

    pub fn set_cursor(&self, drive: &str, ev: i64) {
        self.update(|p| {
            p.cursors.insert(drive.to_string(), ev);
        });
    }
}

fn write_atomic(path: &std::path::Path, p: &Persisted) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(&serde_json::to_vec_pretty(p).map_err(std::io::Error::other)?)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_corrupt_file() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("state.json");
        let s = StateStore::load(path.clone());
        s.update(|p| p.mounts.push(MountRecord { drive_id: "d-1".into(), name: "Space".into(), mount_path: None, read_only: false }));
        s.set_cursor("d-1", 42);
        let s2 = StateStore::load(path.clone());
        assert_eq!(s2.get().mounts.len(), 1);
        assert_eq!(s2.cursor("d-1"), Some(42));
        std::fs::write(&path, b"{nope").unwrap();
        assert_eq!(StateStore::load(path).get(), Persisted::default());
    }
}

#[cfg(test)]
mod persistence_regressions {
    use super::*;
    #[test]
    fn concurrent_updates_keep_memory_and_disk_in_the_same_order() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("state.json");let store=std::sync::Arc::new(StateStore::load(path.clone()));
        std::thread::scope(|scope| {
            for worker in 0..8 {
                let store=store.clone();scope.spawn(move || {
                    for change in 0..25 {store.try_update(|p| {p.cursors.insert(format!("{worker}:{change}"),change);}).unwrap();}
                });
            }
        });
        let disk=StateStore::load(path).get();assert_eq!(disk.cursors.len(),200);assert_eq!(store.get(),disk);
    }
    #[test]
    fn failed_snapshot_install_preserves_previous_memory_and_reports_error() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("state.json");std::fs::create_dir(&path).unwrap();let store=StateStore::load(path);
        assert!(store.try_update(|p|p.workspace=Some("must-not-acknowledge".into())).is_err());assert_eq!(store.get(),Persisted::default());
    }
}
