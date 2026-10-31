//! Authenticated loopback SMB mount backed by the mounted drive's writable VFS.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use uls_smb::{RunningServer, SmbBackend};
use uls_vfs_backend::VfsBackend;

use crate::mount::{MountAdapter, MountError, MountHandle, MountRequest, NeedAccess};
use crate::protocol::{ErrorBody, code};

pub struct SmbAdapter;

struct SmbHandle {
    mountpoint: PathBuf,
    server: Mutex<Option<RunningServer>>,
}

fn err(message: &'static str) -> MountError {
    MountError(ErrorBody::internal(message))
}

fn owned_mount_address(source: &str) -> Option<SocketAddr> {
    let (user, address) = source.strip_prefix("//")?.split_once('@')?;
    let random = user.strip_prefix("uls")?;
    if random.len() != 16 || !random.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    let address: SocketAddr = address.strip_suffix("/ULS")?.parse().ok()?;
    (address.ip() == Ipv4Addr::LOCALHOST && address.port() != 0).then_some(address)
}

fn target_mounts(table: &str, target: &Path) -> Result<Vec<SocketAddr>, MountError> {
    let mut addresses = Vec::new();
    for line in table.lines() {
        let Some((source, rest)) = line.split_once(" on ") else { continue };
        let Some((path, options)) = rest.rsplit_once(" (") else { continue };
        if Path::new(path) != target { continue; }
        if options.trim_end_matches(')').split(',').next() != Some("smbfs") { return Err(err("SMB mountpoint is already in use")); }
        addresses.push(owned_mount_address(source).ok_or_else(|| err("SMB mountpoint is already in use"))?);
    }
    Ok(addresses)
}

async fn mount_table() -> Result<String, MountError> {
    let output = tokio::time::timeout(Duration::from_secs(3),
        tokio::process::Command::new("/sbin/mount").kill_on_drop(true).output())
        .await.map_err(|_| err("cannot inspect mounts within 3s"))?
        .map_err(|_| err("cannot inspect mounts"))?;
    if !output.status.success() { return Err(err("cannot inspect mounts")); }
    String::from_utf8(output.stdout).map_err(|_| err("cannot read mount table"))
}

async fn stale(address: SocketAddr) -> bool {
    matches!(tokio::time::timeout(Duration::from_secs(1), tokio::net::TcpStream::connect(address)).await,
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused)
}

/// A killed helper leaves its kernel mount behind; never mount another share over it.
async fn detach_stale_mounts(target: &Path) -> Result<(), MountError> {
    let mut mounts = target_mounts(&mount_table().await?, target)?;
    let original_count = mounts.len();
    for _ in 0..original_count {
        for address in &mounts {
            if !stale(*address).await { return Err(err("SMB mountpoint has a live or unreachable server")); }
        }
        if target_mounts(&mount_table().await?, target)? != mounts {
            return Err(err("SMB mountpoint changed during recovery"));
        }
        // Only a verified dead Unlispace share may be force-detached. A normal unmount can
        // wait for that dead server, leaving the recovery itself stuck in the kernel.
        let output = tokio::time::timeout(Duration::from_secs(5),
            tokio::process::Command::new("/sbin/umount").arg("-f").arg(target)
                .kill_on_drop(true).output()).await
            .map_err(|_| err("stale SMB mount did not detach within 5s; close apps using Space and retry"))?
            .map_err(|_| err("cannot detach stale SMB mount"))?;
        if !output.status.success() { return Err(err("cannot detach stale SMB mount")); }
        let remaining = target_mounts(&mount_table().await?, target)?;
        if remaining.len() >= mounts.len() { return Err(err("stale SMB mount is still attached")); }
        mounts = remaining;
        if mounts.is_empty() { return Ok(()); }
    }
    Ok(())
}

#[async_trait]
impl MountAdapter for SmbAdapter {
    fn access(&self) -> NeedAccess { NeedAccess::Write }

    async fn prepare_mountpoint(&self, path: &Path) -> Result<(), MountError> {
        // Resolve only the parent until a dead mount has been detached: stat/canonicalize
        // of the dead SMB root itself can wait on the terminated helper.
        let parent = path.parent().ok_or_else(|| err("invalid SMB mountpoint"))?;
        let name = path.file_name().ok_or_else(|| err("invalid SMB mountpoint"))?;
        std::fs::create_dir_all(parent).map_err(|_| err("cannot create SMB mountpoint parent"))?;
        let mountpoint = std::fs::canonicalize(parent).map_err(|_| err("cannot open SMB mountpoint parent"))?.join(name);
        detach_stale_mounts(&mountpoint).await?;
        if std::fs::read_link(&mountpoint).is_ok() {
            return Err(err("SMB mountpoint must not be a symlink"));
        }
        std::fs::create_dir_all(&mountpoint).map_err(|_| err("cannot create SMB mountpoint"))?;
        Ok(())
    }

    async fn mount(&self, req: MountRequest) -> Result<Arc<dyn MountHandle>, MountError> {
        req.client.drive_info(&req.drive_id).await.map_err(|error| match error {
            uls_client::Error::NotFound { .. } => MountError(ErrorBody::new(code::NO_SUCH_DRIVE, "no such drive")),
            uls_client::Error::Unauthorized | uls_client::Error::Auth(_) => MountError(ErrorBody::new(code::UNAUTHORIZED, "cannot authorize drive")),
            _ => MountError(ErrorBody::new(code::OFFLINE, "cannot reach the data plane")),
        })?;
        let mountpoint = std::fs::canonicalize(req.mountpoint).map_err(|_| err("cannot open SMB mountpoint"))?;
        let backend: Arc<dyn SmbBackend> = Arc::new(VfsBackend::new(req.vfs));
        let server = uls_smb::serve(backend, false).await.map_err(|_| err("cannot start SMB server"))?;
        let target = mountpoint.clone();
        // Credentials stay in memory and are never included in daemon errors or logs.
        let server = tokio::task::spawn_blocking(move || {
            uls_smb::mount(server.addr, &server.user, &server.password, target)
                .map_err(|_| err("cannot mount loopback SMB share"))?;
            Ok::<_, MountError>(server)
        }).await.map_err(|_| err("SMB mount task failed"))??;
        Ok(Arc::new(SmbHandle { mountpoint, server: Mutex::new(Some(server)) }))
    }
}

#[async_trait]
impl MountHandle for SmbHandle {
    async fn unmount(&self) -> Result<(), MountError> {
        let target = self.mountpoint.clone();
        tokio::task::spawn_blocking(move || uls_smb::unmount(target)).await
            .map_err(|_| err("SMB unmount task failed"))?
            .map_err(|_| err("cannot unmount SMB share"))?;
        let server = self.server.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(server) = server
            && server.shutdown().await.is_err()
        {
            tracing::warn!("SMB server stopped with an error after detaching the mount");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_our_exact_loopback_share_at_the_requested_path() {
        let target = Path::new("/tmp/Space on disk (test)");
        let table = "//spacefs123@space.localhost:1234/Space on /tmp/Other (smbfs, nodev)\n//uls0123456789abcdef@127.0.0.1:4321/ULS on /tmp/Space on disk (test) (smbfs, nodev)\n//ulsfedcba9876543210@127.0.0.1:5678/ULS on /tmp/Space on disk (test) (smbfs, nodev)\n";
        assert_eq!(target_mounts(table, target).unwrap(), vec!["127.0.0.1:4321".parse::<SocketAddr>().unwrap(), "127.0.0.1:5678".parse().unwrap()]);
        assert!(target_mounts(table, Path::new("/tmp/Space")).unwrap().is_empty());
        for source in [
            "//alice@127.0.0.1:4321/ULS",
            "//uls0123456789abcdef@192.0.2.1:4321/ULS",
            "//uls0123456789abcdef@127.0.0.1:0/ULS",
            "//uls0123456789abcdef@127.0.0.1:4321/Other",
            "//uls0123456789abcdeg@127.0.0.1:4321/ULS",
            "/dev/disk3s1",
        ] {
            let line = format!("{source} on {} (smbfs, nodev)", target.display());
            assert!(target_mounts(&line, target).is_err(), "{source}");
        }
        let line = format!("//uls0123456789abcdef@127.0.0.1:4321/ULS on {} (nfs, nodev)", target.display());
        assert!(target_mounts(&line, target).is_err());
    }

    #[tokio::test]
    async fn a_live_listener_is_never_stale() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(!stale(address).await);
        drop(listener);
        assert!(stale(address).await);
    }

    /// Exercises the kernel mount table; run explicitly on a development Mac.
    #[tokio::test]
    #[ignore]
    async fn a_dead_native_mount_is_detached_and_a_live_mount_is_preserved() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        // Leave a failed fixture available for targeted cleanup rather than traversing a dead mount.
        let target = std::fs::canonicalize(dir.keep()).unwrap();
        let server = uls_smb::serve(Arc::new(uls_smb::MemBackend::new()), false).await.unwrap();
        let (address, user, password) = (server.addr, server.user.clone(), server.password.clone());
        let path = target.clone();
        tokio::task::spawn_blocking(move || uls_smb::mount(address, &user, &password, path)).await.unwrap().unwrap();
        assert!(SmbAdapter.prepare_mountpoint(&target).await.is_err(), "live mount must be preserved");
        assert_eq!(target_mounts(&mount_table().await.unwrap(), &target).unwrap().len(), 1);
        server.shutdown().await.unwrap();
        assert!(stale(address).await);
        SmbAdapter.prepare_mountpoint(&target).await.unwrap();
        assert!(target_mounts(&mount_table().await.unwrap(), &target).unwrap().is_empty());
        std::fs::remove_dir(target).unwrap();
    }
}
