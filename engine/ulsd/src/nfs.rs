//! Loopback NFSv3 server on top of the drive's [`uls_vfs::Vfs`], and the `mount_nfs` plumbing.
//!
//! Every operation goes through the Vfs, so the NFS fallback sees the same journal, read-your-
//! writes view and publisher as the SMB adapter. File ids are the Vfs attr ids, which survive
//! rename; only the id -> path table here has to follow renames.
//!
//! nfsserve 0.11 does not dispatch NFSPROC3_COMMIT and always answers WRITE with `FILE_SYNC`,
//! so each WRITE/CREATE/SETATTR(size) calls [`UlsFs::commit`] (= `Vfs::flush`) itself: the data
//! is already durable in the journal and the publisher uploads it after the quiet window.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use futures_util::StreamExt;
use nfsserve::nfs::{
    fattr3, fileid3, filename3, ftype3, nfspath3, nfsstat3, nfstime3, sattr3, set_size3, specdata3,
};
use nfsserve::tcp::{NFSTcp, NFSTcpListener};
use nfsserve::vfs::{DirEntry, NFSFileSystem, ReadDirResult, VFSCapabilities};
use uls_client::Client;
use uls_vfs::{Attr, FsError, Kind, Vfs, VfsOptions};

const ROOT: fileid3 = 1;
/// 100 ns ticks between 1601-01-01 and the Unix epoch (Vfs timestamps are FILETIME).
const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;

pub struct UlsFs {
    vfs: Vfs,
    uid: u32,
    gid: u32,
    read_only: bool,
    /// id -> path (no leading or trailing slash; the root is ""). Ids come from the Vfs.
    paths: Mutex<HashMap<fileid3, String>>,
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

fn within(p: &str, dir: &str) -> bool {
    p == dir || p.strip_prefix(dir).is_some_and(|s| s.starts_with('/'))
}

fn time(filetime: u64) -> nfstime3 {
    let ticks = filetime.saturating_sub(FILETIME_UNIX_EPOCH);
    nfstime3 { seconds: (ticks / 10_000_000).min(u64::from(u32::MAX)) as u32, nseconds: ((ticks % 10_000_000) * 100) as u32 }
}

fn map_err(e: FsError) -> nfsstat3 {
    match e {
        FsError::NotFound => nfsstat3::NFS3ERR_NOENT,
        FsError::Exists => nfsstat3::NFS3ERR_EXIST,
        FsError::NotDir => nfsstat3::NFS3ERR_NOTDIR,
        FsError::IsDir => nfsstat3::NFS3ERR_ISDIR,
        FsError::NotEmpty => nfsstat3::NFS3ERR_NOTEMPTY,
        FsError::NoSpace => nfsstat3::NFS3ERR_NOSPC,
        FsError::ReadOnly => nfsstat3::NFS3ERR_ROFS,
        FsError::Busy => nfsstat3::NFS3ERR_JUKEBOX,
        FsError::Stale => nfsstat3::NFS3ERR_STALE,
        FsError::Invalid => nfsstat3::NFS3ERR_INVAL,
        FsError::Io(m) => {
            tracing::warn!("backend error: {m}");
            nfsstat3::NFS3ERR_IO
        }
    }
}

/// A handle whose object is gone is stale, not "no such file".
fn handle_err(e: FsError) -> nfsstat3 {
    match e {
        FsError::NotFound => nfsstat3::NFS3ERR_STALE,
        other => map_err(other),
    }
}

fn name_of(n: &filename3) -> Result<&str, nfsstat3> {
    let s = std::str::from_utf8(&n.0).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
    if s.is_empty() || s.contains('/') || s.contains('\0') {
        return Err(nfsstat3::NFS3ERR_INVAL);
    }
    Ok(s)
}

impl UlsFs {
    pub fn new(vfs: Vfs, uid: u32, gid: u32, read_only: bool) -> UlsFs {
        let mut paths = HashMap::new();
        paths.insert(ROOT, String::new());
        UlsFs { vfs, uid, gid, read_only, paths: Mutex::new(paths) }
    }

    fn paths(&self) -> std::sync::MutexGuard<'_, HashMap<fileid3, String>> {
        self.paths.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn path_of(&self, id: fileid3) -> Result<String, nfsstat3> {
        self.paths().get(&id).cloned().ok_or(nfsstat3::NFS3ERR_STALE)
    }

    fn remember(&self, id: fileid3, path: &str) {
        self.paths().insert(id, path.to_string());
    }

    fn writable(&self) -> Result<(), nfsstat3> {
        if self.read_only { Err(nfsstat3::NFS3ERR_ROFS) } else { Ok(()) }
    }

    fn fattr(&self, a: &Attr) -> fattr3 {
        let dir = a.kind == Kind::Directory;
        let mode = match (dir, self.read_only) {
            (true, true) => 0o555,
            (true, false) => 0o755,
            (false, true) => 0o444,
            (false, false) => 0o644,
        };
        fattr3 {
            ftype: if dir { ftype3::NF3DIR } else { ftype3::NF3REG },
            mode,
            nlink: if dir { 2 } else { 1 },
            uid: self.uid,
            gid: self.gid,
            size: if dir { 4096 } else { a.size },
            used: if dir { 4096 } else { a.size },
            rdev: specdata3::default(),
            fsid: 0x756c73,
            fileid: a.id,
            atime: time(a.accessed),
            mtime: time(a.modified),
            ctime: time(a.changed),
        }
    }

    /// Current attributes of the object a handle names. A path now owned by another object
    /// (replaced, renamed over) makes the handle stale.
    async fn attr_of(&self, id: fileid3) -> Result<(String, Attr), nfsstat3> {
        let path = self.path_of(id)?;
        let a = self.vfs.lookup(&path).await.map_err(handle_err)?;
        if a.id != id {
            return Err(nfsstat3::NFS3ERR_STALE);
        }
        Ok((path, a))
    }

    async fn dir_path(&self, dirid: fileid3) -> Result<String, nfsstat3> {
        let (path, a) = self.attr_of(dirid).await?;
        if a.kind != Kind::Directory {
            return Err(nfsstat3::NFS3ERR_NOTDIR);
        }
        Ok(path)
    }

    /// NFS COMMIT (and the implicit commit after every stable write): the bytes are already in the
    /// journal, this marks the file ready to publish after the quiet window.
    pub async fn commit(&self, id: fileid3) -> Result<(), nfsstat3> {
        let path = self.path_of(id)?;
        self.vfs.flush(&path).await.map_err(handle_err)
    }

    async fn commit_path(&self, path: &str) {
        if let Err(e) = self.vfs.flush(path).await {
            tracing::warn!("flush failed: {e}");
        }
    }
}

#[async_trait]
impl NFSFileSystem for UlsFs {
    fn capabilities(&self) -> VFSCapabilities {
        if self.read_only { VFSCapabilities::ReadOnly } else { VFSCapabilities::ReadWrite }
    }

    fn root_dir(&self) -> fileid3 {
        ROOT
    }

    async fn lookup(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        let dir = self.dir_path(dirid).await?;
        let name = std::str::from_utf8(&filename.0).map_err(|_| nfsstat3::NFS3ERR_NOENT)?;
        let path = match name {
            "." => return Ok(dirid),
            ".." => parent_of(&dir).to_string(),
            n if n.is_empty() || n.contains('/') => return Err(nfsstat3::NFS3ERR_NOENT),
            n => join(&dir, n),
        };
        let a = self.vfs.lookup(&path).await.map_err(map_err)?;
        self.remember(a.id, &path);
        Ok(a.id)
    }

    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        let (_, a) = self.attr_of(id).await?;
        Ok(self.fattr(&a))
    }

    async fn setattr(&self, id: fileid3, setattr: sattr3) -> Result<fattr3, nfsstat3> {
        self.writable()?;
        let (path, a) = self.attr_of(id).await?;
        // Mode, ownership and times are not stored; only a size change has an effect.
        if let set_size3::size(n) = setattr.size {
            if a.kind == Kind::Directory {
                return Err(nfsstat3::NFS3ERR_ISDIR);
            }
            self.vfs.truncate(&path, n).await.map_err(map_err)?;
            self.commit_path(&path).await;
        }
        let (_, a) = self.attr_of(id).await?;
        Ok(self.fattr(&a))
    }

    async fn read(&self, id: fileid3, offset: u64, count: u32) -> Result<(Vec<u8>, bool), nfsstat3> {
        let (path, a) = self.attr_of(id).await?;
        if a.kind == Kind::Directory {
            return Err(nfsstat3::NFS3ERR_ISDIR);
        }
        if offset >= a.size {
            return Ok((Vec::new(), true));
        }
        let data = self.vfs.read(&path, offset, count).await.map_err(map_err)?;
        let eof = offset + data.len() as u64 >= a.size;
        Ok((data.to_vec(), eof))
    }

    async fn write(&self, id: fileid3, offset: u64, data: &[u8]) -> Result<fattr3, nfsstat3> {
        self.writable()?;
        let (path, a) = self.attr_of(id).await?;
        if a.kind == Kind::Directory {
            return Err(nfsstat3::NFS3ERR_ISDIR);
        }
        self.vfs.write(&path, offset, data).await.map_err(map_err)?;
        self.commit_path(&path).await;
        let (_, a) = self.attr_of(id).await?;
        Ok(self.fattr(&a))
    }

    async fn create(&self, dirid: fileid3, filename: &filename3, attr: sattr3) -> Result<(fileid3, fattr3), nfsstat3> {
        self.writable()?;
        let dir = self.dir_path(dirid).await?;
        let path = join(&dir, name_of(filename)?);
        let a = match self.vfs.create(&path, Kind::File).await {
            Ok(a) => a,
            // UNCHECKED create of an existing file succeeds (GUARDED was rejected by the server).
            Err(FsError::Exists) => {
                let a = self.vfs.lookup(&path).await.map_err(map_err)?;
                if a.kind == Kind::Directory {
                    return Err(nfsstat3::NFS3ERR_ISDIR);
                }
                a
            }
            Err(e) => return Err(map_err(e)),
        };
        self.remember(a.id, &path);
        if let set_size3::size(n) = attr.size {
            self.vfs.truncate(&path, n).await.map_err(map_err)?;
        }
        self.commit_path(&path).await;
        let a = self.vfs.lookup(&path).await.map_err(map_err)?;
        Ok((a.id, self.fattr(&a)))
    }

    async fn create_exclusive(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        self.writable()?;
        let dir = self.dir_path(dirid).await?;
        let path = join(&dir, name_of(filename)?);
        let a = self.vfs.create(&path, Kind::File).await.map_err(map_err)?;
        self.remember(a.id, &path);
        self.commit_path(&path).await;
        Ok(a.id)
    }

    async fn mkdir(&self, dirid: fileid3, dirname: &filename3) -> Result<(fileid3, fattr3), nfsstat3> {
        self.writable()?;
        let dir = self.dir_path(dirid).await?;
        let path = join(&dir, name_of(dirname)?);
        let a = self.vfs.create(&path, Kind::Directory).await.map_err(map_err)?;
        self.remember(a.id, &path);
        Ok((a.id, self.fattr(&a)))
    }

    /// REMOVE and RMDIR share this entry point in nfsserve.
    async fn remove(&self, dirid: fileid3, filename: &filename3) -> Result<(), nfsstat3> {
        self.writable()?;
        let dir = self.dir_path(dirid).await?;
        let path = join(&dir, name_of(filename)?);
        self.vfs.remove(&path).await.map_err(map_err)?;
        self.paths().retain(|_, p| !within(p, &path));
        Ok(())
    }

    async fn rename(&self, from_dirid: fileid3, from_filename: &filename3, to_dirid: fileid3, to_filename: &filename3) -> Result<(), nfsstat3> {
        self.writable()?;
        let from_dir = self.dir_path(from_dirid).await?;
        let to_dir = self.dir_path(to_dirid).await?;
        let from = join(&from_dir, name_of(from_filename)?);
        let to = join(&to_dir, name_of(to_filename)?);
        self.vfs.rename(&from, &to, true).await.map_err(map_err)?;
        // The Vfs keeps attr ids across rename; only the path table needs to follow.
        let mut p = self.paths();
        if from != to {
            p.retain(|_, v| !within(v, &to));
            for v in p.values_mut() {
                if within(v, &from) {
                    *v = format!("{to}{}", &v[from.len()..]);
                }
            }
        }
        Ok(())
    }

    async fn readdir(&self, dirid: fileid3, start_after: fileid3, max_entries: usize) -> Result<ReadDirResult, nfsstat3> {
        let dir = self.dir_path(dirid).await?;
        let entries = self.vfs.readdir(&dir).await.map_err(map_err)?;
        for e in &entries {
            self.remember(e.attr.id, &join(&dir, &e.name));
        }
        let start = if start_after == 0 {
            0
        } else {
            entries.iter().position(|e| e.attr.id == start_after).map(|i| i + 1).ok_or(nfsstat3::NFS3ERR_BAD_COOKIE)?
        };
        let end = (start + max_entries).min(entries.len());
        let out = entries[start..end]
            .iter()
            .map(|e| DirEntry { fileid: e.attr.id, name: e.name.as_bytes().into(), attr: self.fattr(&e.attr) })
            .collect();
        Ok(ReadDirResult { entries: out, end: end >= entries.len() })
    }

    async fn symlink(&self, _d: fileid3, _n: &filename3, _s: &nfspath3, _a: &sattr3) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(if self.read_only { nfsstat3::NFS3ERR_ROFS } else { nfsstat3::NFS3ERR_NOTSUPP })
    }

    async fn readlink(&self, _id: fileid3) -> Result<nfspath3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_INVAL)
    }
}

/// The exact `mount_nfs` argument list, shared by the real call and the printed hint.
pub fn mount_args(port: u16, mountpoint: &Path, read_only: bool) -> Vec<String> {
    let access = if read_only { ",rdonly" } else { "" };
    vec![
        "-o".into(),
        format!("port={port},mountport={port},nolocks,vers=3,tcp{access},actimeo=1"),
        "localhost:/".into(),
        mountpoint.display().to_string(),
    ]
}

pub async fn mount(
    client: Client,
    drive: String,
    mountpoint: PathBuf,
    no_mount: bool,
    port: u16,
    read_only: bool,
    state_dir: PathBuf,
) -> Result<()> {
    // macOS refuses mounts reached through a symlink (e.g. /tmp -> /private/tmp).
    let mountpoint = std::fs::canonicalize(&mountpoint)
        .with_context(|| format!("mountpoint {} must be an existing directory", mountpoint.display()))?;
    let md = std::fs::metadata(&mountpoint)?;
    if !md.is_dir() {
        bail!("{} is not a directory", mountpoint.display());
    }
    // Fail early (and without leaking anything) if the drive or token is wrong.
    client.drive_info(&drive).await.with_context(|| format!("cannot open drive {drive}"))?;

    // Writes go through the drive's journal; a second process on the same journal is refused.
    let vfs = Vfs::open(client.clone(), &drive, &state_dir, VfsOptions::default())
        .await
        .map_err(|e| anyhow::anyhow!("cannot open the write journal in {}: {e}", state_dir.display()))?;
    let events = spawn_remote_watch(client, drive.clone(), vfs.clone());
    let fs = UlsFs::new(vfs.clone(), md.uid(), md.gid(), read_only);
    let listener = NFSTcpListener::bind(&format!("127.0.0.1:{port}"), fs).await.context("bind NFS server")?;
    let port = listener.get_listen_port();
    let server = tokio::spawn(async move { listener.handle_forever().await });

    let args = mount_args(port, &mountpoint, read_only);
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
    let result = unmount(&mountpoint).await;
    events.abort();
    // Publish everything still queued before exiting.
    if let Err(e) = vfs.shutdown().await {
        eprintln!("warning: unpublished writes remain in {}: {e}", state_dir.display());
    }
    result
}

/// Standalone `ulsd mount` has no daemon, so feed remote changes into the Vfs here.
fn spawn_remote_watch(client: Client, drive: String, vfs: Vfs) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut after = match client.changes(&drive, 0, 1).await {
            Ok(h) => h.last_ev,
            Err(_) => 0,
        };
        loop {
            let mut stream = client.watch(&drive, after);
            while let Some(ev) = stream.next().await {
                let Ok(ev) = ev else { break };
                vfs.apply_remote(ev).await;
                after = stream.last_ev();
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
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

    fn fname(s: &str) -> filename3 {
        s.as_bytes().into()
    }

    async fn setup(read_only: bool) -> (uls_mock::MockServer, Client, tempfile::TempDir, Vfs, UlsFs) {
        let srv = uls_mock::MockServer::start("t").await;
        let c = Client::builder(srv.url(), "t").whole_shard_on_partial(true).build().unwrap();
        c.create_drive("demo", None).await.unwrap();
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let opts = VfsOptions { quiet_window: Duration::from_millis(50), max_dirty_age: Duration::from_millis(200), ..VfsOptions::default() };
        let vfs = Vfs::open(c.clone(), "demo", &dir.path().join("j"), opts).await.unwrap();
        let fs = UlsFs::new(vfs.clone(), 501, 20, read_only);
        (srv, c, dir, vfs, fs)
    }

    async fn drained(v: &Vfs) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while { let p = v.pending().await; p.files + p.metadata_ops > 0 } {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("publisher drained");
    }

    #[tokio::test]
    async fn read_only_serves_remote_content_and_refuses_writes() {
        let (_s, c, dir, vfs, fs) = setup(true).await;
        let f = dir.path().join("f");
        let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&f, &body).unwrap();
        c.upload_file("demo", &f, "a/b/f.bin", None).await.unwrap();

        assert!(matches!(fs.capabilities(), VFSCapabilities::ReadOnly));
        let a = fs.lookup(ROOT, &fname("a")).await.unwrap();
        let b = fs.lookup(a, &fname("b")).await.unwrap();
        let file = fs.lookup(b, &fname("f.bin")).await.unwrap();
        assert_eq!(fs.lookup(b, &fname("f.bin")).await.unwrap(), file, "ids are stable");
        assert_eq!(fs.lookup(b, &fname("..")).await.unwrap(), a);
        assert_eq!(fs.getattr(file).await.unwrap().size, 300_000);
        assert_eq!(fs.getattr(file).await.unwrap().mode, 0o444);
        assert!(matches!(fs.lookup(b, &fname("nope")).await, Err(nfsstat3::NFS3ERR_NOENT)));
        let (d, eof) = fs.read(file, 1000, 5000).await.unwrap();
        assert_eq!((d.as_slice(), eof), (&body[1000..6000], false));
        let (d, eof) = fs.read(file, 299_000, 5000).await.unwrap();
        assert_eq!((d.as_slice(), eof), (&body[299_000..], true));
        assert_eq!(fs.read(file, 400_000, 10).await.unwrap(), (vec![], true));
        let r = fs.readdir(b, 0, 10).await.unwrap();
        assert_eq!((r.entries.len(), r.end), (1, true));

        assert!(matches!(fs.write(file, 0, b"x").await, Err(nfsstat3::NFS3ERR_ROFS)));
        assert!(matches!(fs.remove(b, &fname("f.bin")).await, Err(nfsstat3::NFS3ERR_ROFS)));
        assert!(matches!(fs.mkdir(b, &fname("d")).await, Err(nfsstat3::NFS3ERR_ROFS)));
        assert!(matches!(fs.create(b, &fname("n"), sattr3::default()).await, Err(nfsstat3::NFS3ERR_ROFS)));
        assert!(matches!(fs.rename(b, &fname("f.bin"), b, &fname("g")).await, Err(nfsstat3::NFS3ERR_ROFS)));
        vfs.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn writes_commit_remotely_and_ids_survive_rename() {
        let (_s, c, _dir, vfs, fs) = setup(false).await;
        assert!(matches!(fs.capabilities(), VFSCapabilities::ReadWrite));

        // mkdir + create + write + commit
        let (d, _) = fs.mkdir(ROOT, &fname("dir")).await.unwrap();
        let (f, attr) = fs.create(d, &fname("a.txt"), sattr3::default()).await.unwrap();
        assert_eq!((attr.size, attr.mode), (0, 0o644));
        let at = fs.write(f, 0, b"hello ").await.unwrap();
        assert_eq!(at.size, 6);
        fs.write(f, 6, b"world").await.unwrap();
        fs.commit(f).await.unwrap();
        assert_eq!(fs.read(f, 0, 100).await.unwrap(), (b"hello world".to_vec(), true));

        // truncate through setattr
        let sa = sattr3 { size: set_size3::size(5), ..Default::default() };
        assert_eq!(fs.setattr(f, sa).await.unwrap().size, 5);
        drained(&vfs).await;
        assert_eq!(c.read_range("demo", "dir/a.txt", 0, 100).await.unwrap().as_ref(), b"hello");

        // rename across directories keeps the id and the content
        let (d2, _) = fs.mkdir(ROOT, &fname("other")).await.unwrap();
        fs.rename(d, &fname("a.txt"), d2, &fname("b.txt")).await.unwrap();
        assert_eq!(fs.lookup(d2, &fname("b.txt")).await.unwrap(), f, "file id survives rename");
        assert_eq!(fs.read(f, 0, 100).await.unwrap().0, b"hello");
        assert!(matches!(fs.lookup(d, &fname("a.txt")).await, Err(nfsstat3::NFS3ERR_NOENT)));
        // renaming a directory moves the ids below it
        fs.rename(ROOT, &fname("other"), ROOT, &fname("moved")).await.unwrap();
        assert_eq!(fs.lookup(ROOT, &fname("moved")).await.unwrap(), d2);
        assert_eq!(fs.getattr(f).await.unwrap().size, 5);
        drained(&vfs).await;
        assert_eq!(c.read_range("demo", "moved/b.txt", 0, 100).await.unwrap().as_ref(), b"hello");
        assert!(c.stat("demo", "dir/a.txt").await.is_err());

        // remove: non-empty dir is refused, then file, then dirs
        assert!(matches!(fs.remove(ROOT, &fname("moved")).await, Err(nfsstat3::NFS3ERR_NOTEMPTY)));
        fs.remove(d2, &fname("b.txt")).await.unwrap();
        assert!(matches!(fs.getattr(f).await, Err(nfsstat3::NFS3ERR_STALE)));
        fs.remove(ROOT, &fname("moved")).await.unwrap();
        fs.remove(ROOT, &fname("dir")).await.unwrap();
        drained(&vfs).await;
        assert!(c.list("demo", "").await.unwrap().is_empty());

        // exclusive create and a bad name
        let id = fs.create_exclusive(ROOT, &fname("x")).await.unwrap();
        assert!(matches!(fs.create_exclusive(ROOT, &fname("x")).await, Err(nfsstat3::NFS3ERR_EXIST)));
        assert!(matches!(fs.create(ROOT, &fname("a/b"), sattr3::default()).await, Err(nfsstat3::NFS3ERR_INVAL)));
        assert_eq!(fs.lookup(ROOT, &fname("x")).await.unwrap(), id);
        vfs.shutdown().await.unwrap();
    }

    #[test]
    fn mount_command_matches_spec() {
        let a = mount_args(1234, Path::new("/mnt/x"), true);
        assert_eq!(a[1], "port=1234,mountport=1234,nolocks,vers=3,tcp,rdonly,actimeo=1");
        assert_eq!(&a[2..], ["localhost:/", "/mnt/x"]);
        assert_eq!(mount_args(1, Path::new("/m"), false)[1], "port=1,mountport=1,nolocks,vers=3,tcp,actimeo=1");
    }
}
