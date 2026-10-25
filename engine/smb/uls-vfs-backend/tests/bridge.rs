use std::{sync::Arc, time::Duration};
use futures_util::StreamExt;
use tempfile::TempDir;
use uls_client::{Client, RetryPolicy};
use uls_mock::MockServer;
use uls_smb::{FsError, Kind, SmbBackend};
use uls_vfs::{Vfs, VfsOptions};
use uls_vfs_backend::VfsBackend;

struct Fixture {
    _mock: MockServer,
    dir: TempDir,
    client: Client,
    vfs: Vfs,
    backend: Arc<VfsBackend>,
}
impl Fixture {
    async fn new(cap: u64) -> Self {
        let mock = MockServer::start_on("127.0.0.1:0", "bridge-test").await.unwrap();
        let client = Client::builder(mock.url(), "bridge-test")
            .retry(RetryPolicy { max_attempts: 1, base_delay: Duration::from_millis(1), max_delay: Duration::from_millis(1) })
            .build().unwrap();
        client.create_drive("drive", None).await.unwrap();
        let dir = tempfile::Builder::new().prefix("uls-vfs-bridge-test-").tempdir_in("/tmp").unwrap();
        let opts = VfsOptions { quiet_window: Duration::from_millis(20), max_dirty_age: Duration::from_secs(5),
            journal_byte_cap: cap, hostname: "bridge-test".into(), ..VfsOptions::default() };
        let vfs = Vfs::open(client.clone(), "drive", dir.path(), opts).await.unwrap();
        let backend = Arc::new(VfsBackend::new(vfs.clone()));
        Self { _mock: mock, dir, client, vfs, backend }
    }
    async fn drained(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let pending = self.vfs.pending().await;
                if pending.files + pending.metadata_ops == 0 { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("mock commits drained");
    }
    async fn close(self) {
        drop(self.backend);
        self.vfs.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn delegates_bytes_attributes_namespace_xattrs_and_publishes_to_mock() {
    let f = Fixture::new(1024 * 1024).await;
    let b = &f.backend;
    b.create("docs", Kind::Directory).await.unwrap();
    let created = b.create("docs/draft", Kind::File).await.unwrap();
    assert_eq!(b.lookup("docs/draft").await.unwrap().created, created.created);
    assert_eq!(b.write("docs/draft", 3, b"abcdef").await.unwrap(), 6);
    b.truncate("docs/draft", 7).await.unwrap();
    assert_eq!(b.read("docs/draft", 0, 100).await.unwrap(), b"\0\0\0abcd"[..]);
    b.set_xattr("docs/draft", "com.apple.FinderInfo", &[7;32]).await.unwrap();
    b.set_xattr("docs/draft", "com.apple.ResourceFork", b"resource").await.unwrap();
    assert_eq!(b.get_xattr("docs/draft", "com.apple.FinderInfo").await.unwrap(), [7;32][..]);
    assert_eq!(b.list_xattr("docs/draft").await.unwrap(), vec!["com.apple.FinderInfo", "com.apple.ResourceFork"]);
    b.remove_xattr("docs/draft", "com.apple.FinderInfo").await.unwrap();
    assert_eq!(b.get_xattr("docs/draft", "com.apple.FinderInfo").await.unwrap_err(), FsError::NotFound);
    b.rename("docs/draft", "docs/saved", false).await.unwrap();
    assert_eq!(b.lookup("docs/saved").await.unwrap().id, created.id);
    assert_eq!(b.get_xattr("docs/saved", "com.apple.ResourceFork").await.unwrap(), b"resource"[..]);
    let listing = b.readdir("docs").await.unwrap();
    assert_eq!(listing.len(), 1);
    assert_eq!(listing[0].name, "saved");
    assert_eq!(listing[0].attr, b.lookup("docs/saved").await.unwrap());
    b.create("docs/replacement", Kind::File).await.unwrap();
    assert_eq!(b.rename("docs/saved", "docs/replacement", false).await.unwrap_err(), FsError::Exists);
    b.rename("docs/saved", "docs/replacement", true).await.unwrap();
    assert_eq!(b.lookup("docs/replacement").await.unwrap().id, created.id);
    b.flush("docs/replacement").await.unwrap();
    f.drained().await;
    assert_eq!(f.client.read_range("drive", "docs/replacement", 0, 100).await.unwrap(), b"\0\0\0abcd"[..]);
    assert!(!f.client.versions("drive", "docs/replacement").await.unwrap().is_empty());
    b.remove("docs/replacement").await.unwrap();
    b.remove("docs").await.unwrap();
    f.drained().await;
    assert!(matches!(f.client.stat("drive", "docs/").await, Err(uls_client::Error::NotFound { .. })));
    f.close().await;
}

#[tokio::test]
async fn returns_precise_supported_errors_and_preserves_rejected_bytes() {
    let f = Fixture::new(1024).await;
    let b = &f.backend;
    assert_eq!(b.lookup("missing").await.unwrap_err(), FsError::NotFound);
    assert_eq!(b.create("../escape", Kind::File).await.unwrap_err(), FsError::Invalid);
    b.create("file", Kind::File).await.unwrap();
    assert_eq!(b.create("file", Kind::File).await.unwrap_err(), FsError::Exists);
    assert_eq!(b.readdir("file").await.unwrap_err(), FsError::NotDirectory);
    assert_eq!(b.create("file/child", Kind::File).await.unwrap_err(), FsError::NotDirectory);
    b.create("dir", Kind::Directory).await.unwrap();
    assert_eq!(b.read("dir", 0, 10).await.unwrap_err(), FsError::IsDirectory);
    b.create("dir/child", Kind::File).await.unwrap();
    assert_eq!(b.remove("dir").await.unwrap_err(), FsError::NotEmpty);
    assert_eq!(b.write("file", 0, &[1; 2048]).await.unwrap_err(), FsError::NoSpace);
    assert_eq!(b.lookup("file").await.unwrap().size, 0);
    assert_eq!(b.set_metadata("file", [None;4], Some(true)).await.unwrap_err(), FsError::NotSupported);
    f.close().await;
}

#[tokio::test]
async fn remote_watch_invalidates_cached_bytes_and_delivers_changes_within_two_seconds() {
    let f = Fixture::new(1024 * 1024).await;
    let input = f.dir.path().join("remote-input");
    std::fs::write(&input, b"old").unwrap();
    f.client.upload_file("drive", &input, "remote.txt", None).await.unwrap();
    assert_eq!(f.backend.read("remote.txt", 0, 100).await.unwrap(), b"old"[..]);
    assert_eq!(f.backend.readdir("").await.unwrap().len(), 1);
    let cursor = f.client.changes("drive", 0, 100).await.unwrap().last_ev;
    let mut watch = f.client.watch("drive", cursor);
    let mut events = f.backend.subscribe();
    let core = f.vfs.clone();
    let watcher = tokio::spawn(async move {
        while let Some(event) = watch.next().await { core.apply_remote(event.unwrap()).await; }
    });
    std::fs::write(&input, b"new remote bytes").unwrap();
    f.client.upload_file("drive", &input, "remote.txt", None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.path == "remote.txt" {
                assert!(!event.is_directory);
                assert_eq!(f.backend.read("remote.txt", 0, 100).await.unwrap(), b"new remote bytes"[..]);
                break;
            }
        }
    }).await.expect("remote notification and byte refresh within two seconds");
    f.client.mkdir("drive", "arrived/").await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.path == "arrived" {
                assert!(event.is_directory);
                assert_eq!(f.backend.readdir("").await.unwrap().len(), 2);
                break;
            }
        }
    }).await.expect("remote directory kind");
    watcher.abort();
    let _ = watcher.await;
    f.close().await;
}

#[tokio::test]
async fn root_resync_requests_smb_directory_rescan_and_drop_releases_forwarder() {
    let f = Fixture::new(1024 * 1024).await;
    let mut events = f.backend.subscribe();
    f.vfs.apply_remote(uls_client::WatchEvent::Resync { head_seq: 0, last_ev: 0 }).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(matches!(events.try_recv(), Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_))));
    let Fixture { backend, vfs, .. } = f;
    drop(backend);
    while events.try_recv().is_ok() {}
    tokio::time::timeout(Duration::from_secs(1), events.recv()).await.unwrap().unwrap_err();
    vfs.shutdown().await.unwrap();
}
