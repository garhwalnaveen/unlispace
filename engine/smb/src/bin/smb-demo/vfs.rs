//! `--vfs`: serves a uls-vfs drive backed by an in-process uls-mock.
use crate::{Result, start, stop};
use futures_util::StreamExt;
use std::{io::Write, path::Path, sync::Arc, time::{Duration, Instant}};
use uls_client::Client;
use uls_mock::MockServer;
use uls_smb::VfsBackend;
use uls_vfs::{Vfs, VfsOptions};

pub async fn run(drive: &str, mountpoint: &Path, encrypt: bool, serve_only: bool, native: bool) -> Result<()> {
    if std::fs::read_dir(mountpoint)?.next().is_some() {
        return Err("mountpoint must be empty".into());
    }
    let state = tempfile::Builder::new().prefix("uls-smb-vfs-").tempdir_in("/tmp")?;
    let mock = MockServer::start_on("127.0.0.1:0", "in-process-demo").await?;
    let client = Client::builder(mock.url(), "in-process-demo").build()?;
    client.create_drive(drive, None).await?;
    let vfs = Vfs::open(client.clone(), drive, state.path(), VfsOptions::default()).await?;
    let backend = Arc::new(VfsBackend::new(vfs.clone()));
    let mut watch = client.watch(drive, 0);
    let watching = vfs.clone();
    let watcher = tokio::spawn(async move {
        while let Some(event) = watch.next().await {
            match event {
                Ok(event) => watching.apply_remote(event).await,
                Err(e) => { eprintln!("watch failed: {e}"); break; }
            }
        }
    });
    let outcome = match start(backend.clone(), mountpoint, encrypt, serve_only).await {
        Err(error) => Err(format!("BLOCKED: native SMB {error}").into()),
        Ok(server) => {
            let outcome = if native {
                native_checks(&client, drive, mountpoint, state.path()).await
            } else {
                tokio::signal::ctrl_c().await.map_err(Into::into)
            };
            // Retain the server while applications still hold the volume open.
            let stopped = stop(server, mountpoint, serve_only).await;
            outcome.and(stopped)
        }
    };
    watcher.abort();
    let _ = watcher.await;
    drop(backend);
    if let Err(error) = vfs.shutdown().await {
        let retained = state.keep();
        return Err(format!("VFS shutdown failed: {error}; journal retained at {}", retained.display()).into());
    }
    outcome?;
    println!("PASS unmounted and VFS drained");
    Ok(())
}

async fn native_checks(client: &Client, drive: &str, mount: &Path, scratch: &Path) -> Result<()> {
    // A local directory must never substitute for a mounted SMB filesystem.
    let table = std::process::Command::new("/sbin/mount").output()?;
    let needle = format!(" on {} (smbfs", mount.display());
    if !String::from_utf8_lossy(&table.stdout).contains(&needle) {
        return Err("FAIL: path is not an SMB mount".into());
    }
    let path = mount.to_owned();
    tokio::task::spawn_blocking(move || -> Result<()> {
        std::fs::create_dir(path.join("Documents"))?;
        std::fs::write(path.join("Documents/saved.txt"), b"previous contents")?;
        let draft = path.join("Documents/.draft");
        let mut file = std::fs::File::create(&draft)?;
        file.write_all(b"hello from the mounted VFS\n")?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&draft, path.join("Documents/saved.txt"))?;
        std::fs::copy(path.join("Documents/saved.txt"), path.join("Documents/duplicate.txt"))?;
        let mut file = std::fs::OpenOptions::new().write(true).open(path.join("Documents/duplicate.txt"))?;
        file.set_len(5)?;
        file.write_all(b"HELLO")?;
        file.sync_all()?;
        drop(file);
        std::fs::write(path.join("Documents/deleted.txt"), b"delete me")?;
        std::fs::remove_file(path.join("Documents/deleted.txt"))?;
        assert_eq!(std::fs::read(path.join("Documents/saved.txt"))?, b"hello from the mounted VFS\n");
        assert_eq!(std::fs::read(path.join("Documents/duplicate.txt"))?, b"HELLO");
        Ok(())
    }).await??;
    println!("PASS Finder-style create/write/fsync/rename/copy/truncate/delete");
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let saved = client.read_range(drive, "Documents/saved.txt", 0, 100).await;
            let copy = client.read_range(drive, "Documents/duplicate.txt", 0, 100).await;
            let deleted = client.stat(drive, "Documents/deleted.txt").await;
            if saved.is_ok_and(|b| b == b"hello from the mounted VFS\n"[..])
                && copy.is_ok_and(|b| b == b"HELLO"[..])
                && matches!(deleted, Err(uls_client::Error::NotFound { .. })) { break; }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }).await.map_err(|_| "FAIL: mock commits did not contain the mounted bytes")?;
    assert!(!client.versions(drive, "Documents/saved.txt").await?.is_empty());
    println!("PASS mock commits contain correct bytes and version history");
    // Cache the listing before injecting an independent remote write.
    let path = mount.to_owned();
    tokio::task::spawn_blocking(move || std::fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()).await??;
    let input = scratch.join("remote-input");
    std::fs::write(&input, b"remote mock bytes\n")?;
    client.upload_file(drive, &input, "remote-arrival.txt", None).await?;
    let start = Instant::now();
    let path = mount.join("remote-arrival.txt");
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let path = path.clone();
            if tokio::task::spawn_blocking(move || std::fs::read(path)).await?
                .is_ok_and(|b| b == b"remote mock bytes\n") { return Ok::<_, tokio::task::JoinError>(()); }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.map_err(|_| "FAIL: remote change was not visible in mount within 2 s")??;
    println!("PASS remote mock change visible within 2 s ({} ms)", start.elapsed().as_millis());
    Ok(())
}
