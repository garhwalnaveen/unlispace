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

    pub fn update(&self, f: impl FnOnce(&mut Persisted)) {
        let snapshot = {
            let mut g = self.lock();
            f(&mut g);
            g.version = 1;
            g.clone()
        };
        if let Err(e) = write_atomic(&self.path, &snapshot) {
            tracing::warn!("could not save state: {e}");
        }
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
