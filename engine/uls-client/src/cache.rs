//! Content-addressed local shard cache with atomic writes, verify-on-read and LRU eviction.
//!
//! Layout: `<dir>/<sha256-hex>`. A file is only ever visible under its final name after it has
//! been fully written (temp file + rename). Reads re-hash the bytes; a corrupt entry is
//! deleted and reported as a miss. Recency is the file mtime, which `get` bumps.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use bytes::Bytes;
use uls_chunk::sha256_hex;

pub const DEFAULT_CAP_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const TMP_PREFIX: &str = ".tmp-";

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub struct ShardCache {
    dir: PathBuf,
    cap_bytes: u64,
    /// Approximate bytes on disk; resynchronised on every eviction scan.
    used: AtomicU64,
    scan_lock: Mutex<()>,
}

/// `~/Library/Caches/com.unlispace/shards` on macOS.
pub fn default_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("com.unlispace").join("shards"))
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl ShardCache {
    pub fn open(dir: impl Into<PathBuf>, cap_bytes: u64) -> io::Result<ShardCache> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        let cache = ShardCache { dir, cap_bytes, used: AtomicU64::new(0), scan_lock: Mutex::new(()) };
        cache.rescan();
        Ok(cache)
    }

    pub fn open_default() -> io::Result<ShardCache> {
        let dir = default_cache_dir()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no cache directory"))?;
        Self::open(dir, DEFAULT_CAP_BYTES)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path_for(&self, hash: &str) -> Option<PathBuf> {
        is_hash(hash).then(|| self.dir.join(hash))
    }

    pub fn contains(&self, hash: &str) -> bool {
        self.path_for(hash).is_some_and(|p| p.is_file())
    }

    /// Read and verify a shard. Corrupt entries are removed and reported as a miss.
    pub fn get(&self, hash: &str) -> Option<Bytes> {
        let path = self.path_for(hash)?;
        let data = fs::read(&path).ok()?;
        if sha256_hex(&data) != hash {
            let _ = fs::remove_file(&path);
            self.rescan();
            return None;
        }
        // Mark as recently used. Failure only degrades eviction order.
        if let Ok(f) = fs::OpenOptions::new().write(true).open(&path) {
            let _ = f.set_modified(SystemTime::now());
        }
        Some(Bytes::from(data))
    }

    /// Store a shard atomically. The bytes must hash to `hash`.
    pub fn put(&self, hash: &str, data: &[u8]) -> io::Result<()> {
        let final_path = self
            .path_for(hash)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad shard hash"))?;
        if sha256_hex(data) != hash {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "data does not match hash"));
        }
        if final_path.is_file() {
            return Ok(());
        }
        let tmp = self.dir.join(format!(
            "{TMP_PREFIX}{}-{}",
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(data)?;
            f.sync_all()?;
            fs::rename(&tmp, &final_path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
            return result;
        }
        let used = self.used.fetch_add(data.len() as u64, Ordering::Relaxed) + data.len() as u64;
        if used > self.cap_bytes {
            self.evict();
        }
        Ok(())
    }

    pub fn used_bytes(&self) -> u64 {
        self.used.load(Ordering::Relaxed)
    }

    fn entries(&self) -> Vec<(PathBuf, u64, SystemTime)> {
        let Ok(rd) = fs::read_dir(&self.dir) else { return vec![] };
        rd.filter_map(|e| {
            let e = e.ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            let md = e.metadata().ok()?;
            if !md.is_file() {
                return None;
            }
            if name.starts_with(TMP_PREFIX) {
                // Leftovers from a crashed writer; only reap old ones.
                let age = md.modified().ok().and_then(|m| m.elapsed().ok());
                if age.is_some_and(|a| a.as_secs() > 3600) {
                    let _ = fs::remove_file(e.path());
                }
                return None;
            }
            is_hash(&name).then(|| (e.path(), md.len(), md.modified().unwrap_or(SystemTime::UNIX_EPOCH)))
        })
        .collect()
    }

    fn rescan(&self) {
        let _g = self.scan_lock.lock().unwrap_or_else(|e| e.into_inner());
        let total: u64 = self.entries().iter().map(|e| e.1).sum();
        self.used.store(total, Ordering::Relaxed);
    }

    /// Delete least-recently-used entries until usage is at or below the cap.
    pub fn evict(&self) {
        let _g = self.scan_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = self.entries();
        let mut total: u64 = entries.iter().map(|e| e.1).sum();
        entries.sort_by_key(|e| e.2);
        for (path, size, _) in entries {
            if total <= self.cap_bytes {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total -= size;
            }
        }
        self.used.store(total, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn open(cap: u64) -> (tempfile::TempDir, ShardCache) {
        let d = tempfile::tempdir().unwrap();
        let c = ShardCache::open(d.path().join("shards"), cap).unwrap();
        (d, c)
    }

    #[test]
    fn put_get_roundtrip() {
        let (_d, c) = open(1 << 20);
        let data = b"hello shard".to_vec();
        let h = sha256_hex(&data);
        assert!(c.get(&h).is_none());
        c.put(&h, &data).unwrap();
        assert!(c.contains(&h));
        assert_eq!(c.get(&h).unwrap().as_ref(), data.as_slice());
        assert_eq!(c.used_bytes(), data.len() as u64);
    }

    #[test]
    fn put_rejects_wrong_hash_and_leaves_nothing() {
        let (_d, c) = open(1 << 20);
        let h = sha256_hex(b"right");
        assert!(c.put(&h, b"wrong").is_err());
        assert!(!c.contains(&h));
        assert!(c.put("../../etc/passwd", b"x").is_err());
        let leftovers = fs::read_dir(c.dir()).unwrap().count();
        assert_eq!(leftovers, 0, "no temp files may remain");
    }

    #[test]
    fn write_is_atomic_no_partial_file_visible() {
        let (_d, c) = open(1 << 30);
        let data = vec![7u8; 4 << 20];
        let h = sha256_hex(&data);
        c.put(&h, &data).unwrap();
        // After a put the directory holds exactly the final file, no temp files.
        let names: Vec<_> = fs::read_dir(c.dir())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![h]);
    }

    #[test]
    fn corrupt_entry_is_detected_and_removed() {
        let (_d, c) = open(1 << 20);
        let data = b"some bytes".to_vec();
        let h = sha256_hex(&data);
        c.put(&h, &data).unwrap();
        fs::write(c.dir().join(&h), b"tampered").unwrap();
        assert!(c.get(&h).is_none());
        assert!(!c.contains(&h), "corrupt file must be deleted");
    }

    #[test]
    fn truncated_entry_is_a_miss() {
        let (_d, c) = open(1 << 20);
        let data = vec![1u8; 1000];
        let h = sha256_hex(&data);
        c.put(&h, &data).unwrap();
        fs::write(c.dir().join(&h), &data[..500]).unwrap();
        assert!(c.get(&h).is_none());
    }

    #[test]
    fn lru_eviction_prefers_oldest() {
        let (_d, c) = open(250);
        let blobs: Vec<Vec<u8>> = (0u8..3).map(|i| vec![i; 100]).collect();
        let hashes: Vec<String> = blobs.iter().map(|b| sha256_hex(b)).collect();
        c.put(&hashes[0], &blobs[0]).unwrap();
        c.put(&hashes[1], &blobs[1]).unwrap();
        // Make entry 0 older than entry 1, then touch 0 via get so it becomes the newest.
        let old = SystemTime::now() - Duration::from_secs(100);
        for (i, h) in hashes.iter().take(2).enumerate() {
            let f = fs::OpenOptions::new().write(true).open(c.dir().join(h)).unwrap();
            f.set_modified(old + Duration::from_secs(i as u64)).unwrap();
        }
        assert!(c.get(&hashes[0]).is_some());
        c.put(&hashes[2], &blobs[2]).unwrap(); // 300 bytes > 250 cap: evicts the LRU (entry 1)
        assert!(c.contains(&hashes[0]));
        assert!(!c.contains(&hashes[1]));
        assert!(c.contains(&hashes[2]));
        assert!(c.used_bytes() <= 250);
    }
}
