//! Read-only loopback NFSv3 server on top of `uls-client`, and the `mount_nfs` plumbing.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use nfsserve::nfs::{
    fattr3, fileid3, filename3, ftype3, nfspath3, nfsstat3, nfstime3, sattr3, specdata3,
};
use nfsserve::tcp::{NFSTcp, NFSTcpListener};
use nfsserve::vfs::{DirEntry, NFSFileSystem, ReadDirResult, VFSCapabilities};
use uls_client::{Client, Error};
use crate::mount::SharedClient;
use uls_proto::{ListEntry, ManifestResponse, NodeType};

const ROOT: fileid3 = 1;
/// Metadata is cached this long. Matches the `actimeo=1` mount option.
const TTL: Duration = Duration::from_secs(1);

#[derive(Clone)]
struct Node {
    /// Path without a trailing slash; the root is "".
    path: String,
    is_dir: bool,
}

#[derive(Default)]
struct Tables {
    by_path: HashMap<String, fileid3>,
    nodes: Vec<Node>, // index = id - 1
    lists: HashMap<String, (Instant, Vec<ListEntry>)>,
    attrs: HashMap<fileid3, (Instant, fattr3)>,
    manifests: HashMap<String, ManifestResponse>, // keyed by version id (immutable)
}

pub struct UlsFs {
    client: SharedClient,
    drive: String,
    uid: u32,
    gid: u32,
    t: Mutex<Tables>,
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

fn time(ms: i64) -> nfstime3 {
    let ms = ms.max(0) as u64;
    nfstime3 { seconds: (ms / 1000) as u32, nseconds: ((ms % 1000) * 1_000_000) as u32 }
}

fn map_err(e: Error) -> nfsstat3 {
    match e {
        Error::NotFound { .. } => nfsstat3::NFS3ERR_NOENT,
        other => {
            tracing::warn!("backend error: {other}");
            nfsstat3::NFS3ERR_IO
        }
    }
}

impl UlsFs {
    pub fn new(client: Client, drive: String, uid: u32, gid: u32) -> UlsFs {
        UlsFs::with_shared(SharedClient::new(client), drive, uid, gid)
    }

    /// Like `new`, but the client can be swapped underneath (drive tokens rotate every ~15 min).
    pub fn with_shared(client: SharedClient, drive: String, uid: u32, gid: u32) -> UlsFs {
        let mut t = Tables::default();
        t.nodes.push(Node { path: String::new(), is_dir: true });
        t.by_path.insert(String::new(), ROOT);
        UlsFs { client, drive, uid, gid, t: Mutex::new(t) }
    }

    fn client(&self) -> Client {
        self.client.get()
    }

    fn tables(&self) -> std::sync::MutexGuard<'_, Tables> {
        self.t.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn node(&self, id: fileid3) -> Result<Node, nfsstat3> {
        let t = self.tables();
        id.checked_sub(1)
            .and_then(|i| t.nodes.get(i as usize))
            .cloned()
            .ok_or(nfsstat3::NFS3ERR_STALE)
    }

    /// Stable id for a path: assigned once, never reused for the life of the process.
    fn id_for(&self, path: &str, is_dir: bool) -> fileid3 {
        let mut t = self.tables();
        if let Some(&id) = t.by_path.get(path) {
            if let Some(n) = t.nodes.get_mut(id as usize - 1) {
                n.is_dir = is_dir;
            }
            return id;
        }
        t.nodes.push(Node { path: path.to_string(), is_dir });
        let id = t.nodes.len() as fileid3;
        t.by_path.insert(path.to_string(), id);
        id
    }

    fn attr(&self, id: fileid3, is_dir: bool, size: u64, mtime_ms: i64) -> fattr3 {
        let t = time(mtime_ms);
        fattr3 {
            ftype: if is_dir { ftype3::NF3DIR } else { ftype3::NF3REG },
            mode: if is_dir { 0o555 } else { 0o444 },
            nlink: if is_dir { 2 } else { 1 },
            uid: self.uid,
            gid: self.gid,
            size: if is_dir { 4096 } else { size },
            used: if is_dir { 4096 } else { size },
            rdev: specdata3::default(),
            fsid: 0x756c73,
            fileid: id,
            atime: t,
            mtime: t,
            ctime: t,
        }
    }

    async fn list_cached(&self, dir_path: &str) -> Result<Vec<ListEntry>, nfsstat3> {
        if let Some((at, v)) = self.tables().lists.get(dir_path)
            && at.elapsed() < TTL
        {
            return Ok(v.clone());
        }
        let entries = self.client().list(&self.drive, dir_path).await.map_err(map_err)?;
        self.tables().lists.insert(dir_path.to_string(), (Instant::now(), entries.clone()));
        Ok(entries)
    }

    fn entry_attr(&self, id: fileid3, e: &ListEntry) -> fattr3 {
        self.attr(id, e.node_type == NodeType::Folder, e.size.unwrap_or(0), e.mtime_ms.unwrap_or(0))
    }

    async fn manifest_for(&self, node: &Node) -> Result<ManifestResponse, nfsstat3> {
        let st = self.client().stat(&self.drive, &node.path).await.map_err(map_err)?;
        let vid = st.version_id.ok_or(nfsstat3::NFS3ERR_IO)?;
        if let Some(m) = self.tables().manifests.get(&vid) {
            return Ok(m.clone());
        }
        let m = self.client().manifest(&self.drive, &node.path, Some(&vid)).await.map_err(map_err)?;
        let mut t = self.tables();
        if t.manifests.len() > 256 {
            t.manifests.clear();
        }
        t.manifests.insert(vid, m.clone());
        Ok(m)
    }
}

#[async_trait]
impl NFSFileSystem for UlsFs {
    fn capabilities(&self) -> VFSCapabilities {
        VFSCapabilities::ReadOnly
    }

    fn root_dir(&self) -> fileid3 {
        ROOT
    }

    async fn lookup(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        let dir = self.node(dirid)?;
        if !dir.is_dir {
            return Err(nfsstat3::NFS3ERR_NOTDIR);
        }
        let name = std::str::from_utf8(&filename.0).map_err(|_| nfsstat3::NFS3ERR_NOENT)?;
        match name {
            "." => return Ok(dirid),
            ".." => return Ok(self.id_for(parent_of(&dir.path), true)),
            _ => {}
        }
        let entries = self.list_cached(&dir.path).await?;
        let e = entries.iter().find(|e| e.name == name).ok_or(nfsstat3::NFS3ERR_NOENT)?;
        Ok(self.id_for(&join(&dir.path, name), e.node_type == NodeType::Folder))
    }

    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        if let Some((at, a)) = self.tables().attrs.get(&id)
            && at.elapsed() < TTL
        {
            return Ok(*a);
        }
        let node = self.node(id)?;
        let attr = if node.path.is_empty() {
            self.attr(id, true, 0, 0)
        } else {
            let st = self.client().stat(&self.drive, &node.path).await.map_err(map_err)?;
            let is_dir = st.node_type == NodeType::Folder;
            if is_dir != node.is_dir {
                // Changed type since we last listed it; the old id no longer names this object.
                return Err(nfsstat3::NFS3ERR_STALE);
            }
            self.attr(id, is_dir, st.size.unwrap_or(0), st.mtime_ms.unwrap_or(0))
        };
        self.tables().attrs.insert(id, (Instant::now(), attr));
        Ok(attr)
    }

    async fn setattr(&self, _id: fileid3, _setattr: sattr3) -> Result<fattr3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn read(&self, id: fileid3, offset: u64, count: u32) -> Result<(Vec<u8>, bool), nfsstat3> {
        let node = self.node(id)?;
        if node.is_dir {
            return Err(nfsstat3::NFS3ERR_ISDIR);
        }
        let m = self.manifest_for(&node).await?;
        if offset >= m.size {
            return Ok((Vec::new(), true));
        }
        let len = u64::from(count).min(m.size - offset);
        let data = self
            .client()
            .read_manifest_range(&self.drive, &m.shards, offset, len)
            .await
            .map_err(map_err)?;
        let eof = offset + data.len() as u64 >= m.size;
        Ok((data.to_vec(), eof))
    }

    async fn write(&self, _id: fileid3, _offset: u64, _data: &[u8]) -> Result<fattr3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn create(&self, _d: fileid3, _n: &filename3, _a: sattr3) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn create_exclusive(&self, _d: fileid3, _n: &filename3) -> Result<fileid3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn mkdir(&self, _d: fileid3, _n: &filename3) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn remove(&self, _d: fileid3, _n: &filename3) -> Result<(), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn rename(&self, _fd: fileid3, _fn: &filename3, _td: fileid3, _tn: &filename3) -> Result<(), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn readdir(&self, dirid: fileid3, start_after: fileid3, max_entries: usize) -> Result<ReadDirResult, nfsstat3> {
        let dir = self.node(dirid)?;
        if !dir.is_dir {
            return Err(nfsstat3::NFS3ERR_NOTDIR);
        }
        let entries = self.list_cached(&dir.path).await?;
        // (id, entry) in the server's bytewise order, which is stable between calls.
        let with_ids: Vec<(fileid3, &ListEntry)> = entries
            .iter()
            .map(|e| (self.id_for(&join(&dir.path, &e.name), e.node_type == NodeType::Folder), e))
            .collect();
        let start = if start_after == 0 {
            0
        } else {
            with_ids
                .iter()
                .position(|(id, _)| *id == start_after)
                .map(|i| i + 1)
                .ok_or(nfsstat3::NFS3ERR_BAD_COOKIE)?
        };
        let end = (start + max_entries).min(with_ids.len());
        let out = with_ids[start..end]
            .iter()
            .map(|(id, e)| DirEntry { fileid: *id, name: e.name.as_bytes().into(), attr: self.entry_attr(*id, e) })
            .collect();
        Ok(ReadDirResult { entries: out, end: end >= with_ids.len() })
    }

    async fn symlink(&self, _d: fileid3, _n: &filename3, _s: &nfspath3, _a: &sattr3) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn readlink(&self, _id: fileid3) -> Result<nfspath3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_INVAL)
    }
}

/// The exact `mount_nfs` argument list, shared by the real call and the printed hint.
pub fn mount_args(port: u16, mountpoint: &Path) -> Vec<String> {
    vec![
        "-o".into(),
        format!("port={port},mountport={port},nolocks,vers=3,tcp,rdonly,actimeo=1"),
        "localhost:/".into(),
        mountpoint.display().to_string(),
    ]
}

pub async fn mount(client: Client, drive: String, mountpoint: PathBuf, no_mount: bool, port: u16) -> Result<()> {
    // macOS refuses mounts reached through a symlink (e.g. /tmp -> /private/tmp).
    let mountpoint = std::fs::canonicalize(&mountpoint)
        .with_context(|| format!("mountpoint {} must be an existing directory", mountpoint.display()))?;
    let md = std::fs::metadata(&mountpoint)?;
    if !md.is_dir() {
        bail!("{} is not a directory", mountpoint.display());
    }
    // Fail early (and without leaking anything) if the drive or token is wrong.
    client.drive_info(&drive).await.with_context(|| format!("cannot open drive {drive}"))?;

    let fs = UlsFs::new(client, drive.clone(), md.uid(), md.gid());
    let listener = NFSTcpListener::bind(&format!("127.0.0.1:{port}"), fs).await.context("bind NFS server")?;
    let port = listener.get_listen_port();
    let server = tokio::spawn(async move { listener.handle_forever().await });

    let args = mount_args(port, &mountpoint);
    let printable = format!("mount_nfs {}", args.iter().map(|a| shell_word(a)).collect::<Vec<_>>().join(" "));
    eprintln!("NFS server for drive {drive} listening on 127.0.0.1:{port}");
    eprintln!("mount command: {printable}");

    if no_mount {
        eprintln!("--no-mount: serving only. Run the command above in another terminal. Ctrl-C to stop.");
        tokio::select! {
            r = server => bail!("NFS server stopped: {r:?}"),
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
    }

    let out = tokio::process::Command::new("/sbin/mount_nfs")
        .args(&args)
        .stdin(std::process::Stdio::null())
        .output();
    let out = match tokio::time::timeout(Duration::from_secs(30), out).await {
        Ok(r) => r.context("run mount_nfs")?,
        Err(_) => bail!("mount_nfs did not finish within 30s (a system prompt may be waiting). Server was left running on port {port}; stopping."),
    };
    if !out.status.success() {
        eprintln!("mount_nfs failed ({}): {}", out.status, String::from_utf8_lossy(&out.stderr).trim());
        eprintln!("The server is stopping. To retry by hand, start with --no-mount and run:\n  {printable}");
        bail!("mount failed");
    }
    eprintln!("mounted at {}  (Ctrl-C to unmount)", mountpoint.display());

    tokio::select! {
        r = server => eprintln!("NFS server stopped unexpectedly: {r:?}"),
        _ = tokio::signal::ctrl_c() => {}
    }
    unmount(&mountpoint).await
}

pub async fn unmount(mountpoint: &Path) -> Result<()> {
    let out = tokio::process::Command::new("/sbin/umount").arg(mountpoint).output().await.context("run umount")?;
    if out.status.success() {
        eprintln!("unmounted {}", mountpoint.display());
        Ok(())
    } else {
        bail!(
            "umount {} failed: {}. Close anything using it, then run `umount {}`",
            mountpoint.display(),
            String::from_utf8_lossy(&out.stderr).trim(),
            mountpoint.display()
        )
    }
}

fn shell_word(s: &str) -> String {
    if s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_=,./:@".contains(&b)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_only_vfs_over_mock_server() {
        let srv = uls_mock::MockServer::start("t").await;
        let c = Client::builder(srv.url(), "t").whole_shard_on_partial(true).build().unwrap();
        c.create_drive("demo", None).await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("f");
        let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&f, &body).unwrap();
        c.upload_file("demo", &f, "a/b/f.bin", None).await.unwrap();

        let fs = UlsFs::new(c, "demo".into(), 501, 20);
        let a = fs.lookup(ROOT, &b"a"[..].into()).await.unwrap();
        let b = fs.lookup(a, &b"b"[..].into()).await.unwrap();
        let file = fs.lookup(b, &b"f.bin"[..].into()).await.unwrap();
        assert_eq!(fs.lookup(b, &b"f.bin"[..].into()).await.unwrap(), file, "ids are stable");
        assert_eq!(fs.lookup(b, &b".."[..].into()).await.unwrap(), a);
        assert_eq!(fs.getattr(file).await.unwrap().size, 300_000);
        assert!(matches!(fs.lookup(b, &b"nope"[..].into()).await, Err(nfsstat3::NFS3ERR_NOENT)));

        let (d, eof) = fs.read(file, 1000, 5000).await.unwrap();
        assert_eq!(d, &body[1000..6000]);
        assert!(!eof);
        let (d, eof) = fs.read(file, 299_000, 5000).await.unwrap();
        assert_eq!(d, &body[299_000..]);
        assert!(eof);
        assert_eq!(fs.read(file, 400_000, 10).await.unwrap(), (vec![], true));

        let r = fs.readdir(b, 0, 10).await.unwrap();
        assert_eq!(r.entries.len(), 1);
        assert!(r.end);
        assert!(matches!(fs.write(file, 0, b"x").await, Err(nfsstat3::NFS3ERR_ROFS)));
        assert!(matches!(fs.remove(b, &b"f.bin"[..].into()).await, Err(nfsstat3::NFS3ERR_ROFS)));
    }

    #[test]
    fn mount_command_matches_spec() {
        let a = mount_args(1234, Path::new("/mnt/x"));
        assert_eq!(a[1], "port=1234,mountport=1234,nolocks,vers=3,tcp,rdonly,actimeo=1");
        assert_eq!(&a[2..], ["localhost:/", "/mnt/x"]);
    }
}
