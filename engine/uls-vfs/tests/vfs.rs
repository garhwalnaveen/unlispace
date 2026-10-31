use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tempfile::TempDir;
use uls_client::{Client, RetryPolicy, WatchEvent};
use uls_mock::MockServer;
use uls_proto::Change;
use uls_vfs::{FsError, Kind, SyncState, Vfs, VfsEvent, VfsOptions};

fn options() -> VfsOptions {
    VfsOptions { quiet_window: Duration::from_millis(50), max_dirty_age: Duration::from_millis(150),
        retry_initial: Duration::from_millis(20), retry_max: Duration::from_millis(100),
        hostname: "test-host".into(), ..VfsOptions::default() }
}
fn slow() -> VfsOptions {
    VfsOptions { quiet_window: Duration::from_secs(3600), max_dirty_age: Duration::from_secs(3600), ..options() }
}
async fn setup(opts: VfsOptions) -> (MockServer, Client, TempDir, Vfs) {
    let server = MockServer::start("test").await;
    let client = Client::builder(server.url(), "test").retry(RetryPolicy { max_attempts: 1,
        base_delay: Duration::from_millis(1), max_delay: Duration::from_millis(1) }).build().unwrap();
    client.create_drive("drive", None).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let vfs = Vfs::open(client.clone(), "drive", dir.path(), opts).await.unwrap();
    (server, client, dir, vfs)
}
async fn drained(v: &Vfs) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while { let p = v.pending().await; p.files + p.metadata_ops > 0 } {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("publisher drained");
}
async fn remote_put(c: &Client, path: &str, bytes: &[u8]) {
    let dir = tempfile::tempdir().unwrap(); let file = dir.path().join("input");
    std::fs::write(&file, bytes).unwrap(); c.upload_file("drive", &file, path, None).await.unwrap();
}

#[tokio::test]
async fn create_write_flush_and_read_your_writes() {
    let (_s, c, _dir, v) = setup(options()).await;
    v.create("docs", Kind::Directory).await.unwrap();
    let a = v.create("docs/a.txt", Kind::File).await.unwrap();
    v.write("docs/a.txt", 3, b"abc").await.unwrap();
    assert_eq!(v.read("docs/a.txt", 0, 100).await.unwrap(), &b"\0\0\0abc"[..]);
    assert_eq!(v.lookup("docs/a.txt").await.unwrap().size, 6);
    assert_eq!(v.readdir("docs").await.unwrap()[0].attr.id, a.id);
    v.flush("docs/a.txt").await.unwrap(); drained(&v).await;
    assert_eq!(c.read_range("drive", "docs/a.txt", 0, 100).await.unwrap(), &b"\0\0\0abc"[..]);
    v.shutdown().await.unwrap();
}
#[tokio::test]
async fn truncate_shrink_extend_and_overlapping_writes() {
    let (_s, c, _dir, v) = setup(slow()).await;
    remote_put(&c, "a", b"abcdefghij").await;
    v.write("a", 2, b"XYZ123").await.unwrap();
    v.truncate("a", 5).await.unwrap(); v.truncate("a", 12).await.unwrap();
    v.write("a", 3, b"!").await.unwrap();
    let expected = b"abX!Z\0\0\0\0\0\0\0";
    assert_eq!(v.read("a", 0, 100).await.unwrap(), &expected[..]);
    assert!(v.read("a", u64::MAX, 100).await.unwrap().is_empty());
    v.clone().shutdown().await.unwrap();
    assert_eq!(c.read_range("drive", "a", 0, 100).await.unwrap(), &expected[..]);
}
#[tokio::test]
async fn rename_file_folder_replace_and_remove() {
    let (_s, c, _dir, v) = setup(slow()).await;
    v.create("d", Kind::Directory).await.unwrap();
    let a = v.create("d/a", Kind::File).await.unwrap(); v.write("d/a", 0, b"one").await.unwrap();
    v.rename("d/a", "d/b", false).await.unwrap();
    v.rename("d", "e", false).await.unwrap();
    assert_eq!(v.lookup("e/b").await.unwrap().id, a.id);
    assert_eq!(v.read("e/b", 0, 10).await.unwrap(), &b"one"[..]);
    assert_eq!(v.lookup("d/a").await.unwrap_err(), FsError::NotFound);
    assert_eq!(v.remove("e").await.unwrap_err(), FsError::NotEmpty);
    v.create("e/c", Kind::File).await.unwrap(); v.write("e/c", 0, b"two").await.unwrap();
    assert_eq!(v.rename("e/b", "e/c", false).await.unwrap_err(), FsError::Exists);
    v.rename("e/b", "e/c", true).await.unwrap();
    v.clone().shutdown().await.unwrap();
    assert_eq!(c.read_range("drive", "e/c", 0, 10).await.unwrap(), &b"one"[..]);
    let dir = tempfile::tempdir().unwrap(); let w = Vfs::open(c.clone(), "drive", dir.path(), slow()).await.unwrap();
    w.remove("e/c").await.unwrap(); w.remove("e").await.unwrap(); w.shutdown().await.unwrap();
    assert!(matches!(c.stat("drive", "e/").await, Err(uls_client::Error::NotFound { .. })));
}
#[tokio::test]
async fn drop_reopen_recovers_bytes_namespace_and_xattrs() {
    let (_s, c, dir, v) = setup(slow()).await;
    v.create("a", Kind::File).await.unwrap(); v.write("a", 0, b"durable").await.unwrap();
    v.set_xattr("a", "user.test", b"metadata").await.unwrap();
    v.rename("a", "b", false).await.unwrap();
    drop(v); tokio::task::yield_now().await;
    let w = Vfs::open(c.clone(), "drive", dir.path(), slow()).await.unwrap();
    assert_eq!(w.read("b", 0, 100).await.unwrap(), &b"durable"[..]);
    assert_eq!(w.get_xattr("b", "user.test").await.unwrap(), &b"metadata"[..]);
    assert_eq!(w.list_xattr("b").await.unwrap(), vec!["user.test"]);
    w.clone().shutdown().await.unwrap(); drop(w);
    let w = Vfs::open(c, "drive", dir.path(), slow()).await.unwrap();
    assert_eq!(w.get_xattr("b", "user.test").await.unwrap(), &b"metadata"[..]);
    w.remove_xattr("b", "user.test").await.unwrap(); w.shutdown().await.unwrap();
}
#[tokio::test]
async fn concurrent_remote_edit_creates_conflict_and_preserves_both() {
    let (_s, c, _dir, v) = setup(options()).await;
    remote_put(&c, "a.txt", b"base").await;
    v.write("a.txt", 0, b"ours").await.unwrap();
    remote_put(&c, "a.txt", b"theirs").await;
    v.apply_remote(WatchEvent::Change(Change { ev: 2, seq: 2, path: "a.txt".into(), op: "put".into(), version_id: None })).await;
    let mut events = v.subscribe(); v.flush("a.txt").await.unwrap(); drained(&v).await;
    let mut copy = None;
    while let Ok(e) = events.try_recv() { if let VfsEvent::Conflict { path, copy: p } = e { assert_eq!(path, "a.txt"); copy = Some(p); } }
    let copy = copy.expect("conflict event");
    assert!(copy.starts_with("a (conflict, test-host, ") && copy.ends_with(").txt"));
    assert_eq!(v.read("a.txt", 0, 100).await.unwrap(), &b"theirs"[..]);
    assert_eq!(v.read(&copy, 0, 100).await.unwrap(), &b"ours"[..]);
    assert_eq!(c.read_range("drive", &copy, 0, 100).await.unwrap(), &b"ours"[..]);
    v.shutdown().await.unwrap();
}
#[tokio::test]
async fn offline_queue_and_recovery() {
    let (s, c, dir, v) = setup(options()).await;
    v.create("a", Kind::File).await.unwrap(); v.write("a", 0, b"queued").await.unwrap();
    let url = s.url(); drop(s);
    v.flush("a").await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while v.pending().await.state != SyncState::Offline { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();
    assert_eq!(v.read("a", 0, 10).await.unwrap(), &b"queued"[..]);
    v.write("a", 6, b"!").await.unwrap();
    let _s = MockServer::start_on(url.strip_prefix("http://").unwrap(), "test").await.unwrap();
    c.create_drive("drive", None).await.unwrap();
    drained(&v).await;
    assert_eq!(c.read_range("drive", "a", 0, 100).await.unwrap(), &b"queued!"[..]);
    assert_eq!(v.pending().await.state, SyncState::Online);
    v.shutdown().await.unwrap(); assert!(dir.path().join("journal.db").exists());
}
#[tokio::test]
async fn journal_cap_rejects_without_changing_bytes() {
    let (_s, _c, _dir, v) = setup(VfsOptions { journal_byte_cap: 5, ..slow() }).await;
    v.create("a", Kind::File).await.unwrap(); v.write("a", 0, b"12345").await.unwrap();
    assert_eq!(v.write("a", 1, b"x").await.unwrap_err(), FsError::NoSpace);
    assert_eq!(v.read("a", 0, 10).await.unwrap(), &b"12345"[..]);
    assert_eq!(v.pending().await.bytes, 5); v.shutdown().await.unwrap();
}
#[tokio::test]
async fn remote_invalidation_and_resync() {
    let (_s, c, _dir, v) = setup(slow()).await;
    remote_put(&c, "a", b"old").await;
    assert_eq!(v.lookup("a").await.unwrap().size, 3); assert_eq!(v.readdir("").await.unwrap().len(), 1);
    remote_put(&c, "a", b"longer").await; remote_put(&c, "b", b"b").await;
    v.apply_remote(WatchEvent::Resync { head_seq: 3, last_ev: 3 }).await;
    assert_eq!(v.lookup("a").await.unwrap().size, 6); assert_eq!(v.readdir("").await.unwrap().len(), 2);
    v.shutdown().await.unwrap();
}
#[tokio::test]
async fn small_overwrite_in_32_mib_uploads_at_most_two_shards() {
    let (s, c, _dir, v) = setup(slow()).await;
    let mut bytes = uls_chunk::golden_input_prng();
    remote_put(&c, "big", &bytes).await;
    let puts = s.stats.shard_puts.load(Ordering::SeqCst);
    let mid = bytes.len()/2; for b in &mut bytes[mid..mid+4096] { *b ^= 255; }
    v.write("big", mid as u64, &bytes[mid..mid+4096]).await.unwrap();
    v.shutdown().await.unwrap();
    let added = s.stats.shard_puts.load(Ordering::SeqCst) - puts;
    assert!((1..=2).contains(&added), "uploaded {added} shards");
    // Check a bounded range around the edit and the complete manifest's size.
    assert_eq!(c.read_range("drive", "big", (mid-4096) as u64, 12288).await.unwrap(), &bytes[mid-4096..mid+8192]);
    assert_eq!(c.manifest("drive", "big", None).await.unwrap().size, 32 << 20);
}
#[tokio::test]
async fn randomized_200_operations_match_memory_model() {
    let (_s, c, _dir, v) = setup(slow()).await;
    let mut model: BTreeMap<String, Vec<u8>> = BTreeMap::new(); let mut seed = 42_u64;
    for step in 0..200 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let p = format!("f{}", (seed>>32)%8); let op = (seed>>16)%5;
        if !model.contains_key(&p) {
            v.create(&p, Kind::File).await.unwrap(); model.insert(p.clone(), vec![]);
        } else if op == 0 {
            v.remove(&p).await.unwrap(); model.remove(&p);
        } else if op == 1 {
            let size = (seed%128) as usize; v.truncate(&p, size as u64).await.unwrap(); model.get_mut(&p).unwrap().resize(size, 0);
        } else if op == 2 {
            let to = format!("f{}", (seed>>40)%8);
            v.rename(&p, &to, true).await.unwrap(); let data = model.remove(&p).unwrap(); model.insert(to, data);
        } else {
            let off = (seed%128) as usize; let bytes = [(seed>>8) as u8; 9];
            v.write(&p, off as u64, &bytes).await.unwrap(); let m = model.get_mut(&p).unwrap();
            if m.len() < off+bytes.len() { m.resize(off+bytes.len(), 0); } m[off..off+bytes.len()].copy_from_slice(&bytes);
        }
        for (p, expected) in &model {
            assert_eq!(&v.read(p, 0, 512).await.unwrap()[..], expected, "step {step}, {p}");
            assert_eq!(v.lookup(p).await.unwrap().size, expected.len() as u64);
        }
        assert_eq!(v.readdir("").await.unwrap().len(), model.len(), "step {step}");
    }
    v.shutdown().await.unwrap();
    for (p, expected) in model { assert_eq!(&c.read_range("drive", &p, 0, 512).await.unwrap()[..], expected); }
}

#[tokio::test]
async fn renamed_remote_files_can_be_written_before_and_after_publication() {
    let (_s, c, _dir, v) = setup(slow()).await;
    remote_put(&c, "d/a", b"original").await;
    v.rename("d", "e", false).await.unwrap();
    v.write("e/a", 0, b"changed!").await.unwrap();
    v.create("e/new", Kind::File).await.unwrap(); v.write("e/new", 0, b"new").await.unwrap();
    v.clone().shutdown().await.unwrap();
    assert_eq!(c.read_range("drive", "e/a", 0, 100).await.unwrap(), &b"changed!"[..]);
    assert_eq!(c.read_range("drive", "e/new", 0, 100).await.unwrap(), &b"new"[..]);
}
#[tokio::test]
async fn ready_files_share_a_commit_and_flush_waits_for_quiet() {
    // The quiet window must outlast creating both files, or a loaded machine publishes `a` alone.
    let (_s, c, _dir, v) = setup(VfsOptions { quiet_window: Duration::from_millis(500), max_dirty_age: Duration::from_secs(10), ..options() }).await;
    for p in ["a", "b"] { v.create(p, Kind::File).await.unwrap(); v.write(p, 0, p.as_bytes()).await.unwrap(); v.flush(p).await.unwrap(); }
    assert_eq!(c.drive_info("drive").await.unwrap().head_seq, 0);
    drained(&v).await;
    assert_eq!(c.drive_info("drive").await.unwrap().head_seq, 1);
    v.shutdown().await.unwrap();
}
#[tokio::test]
async fn dirty_age_publishes_without_flush() {
    let (_s, c, _dir, v) = setup(options()).await;
    v.create("a", Kind::File).await.unwrap(); v.write("a", 0, b"no flush").await.unwrap();
    drained(&v).await;
    assert_eq!(c.read_range("drive", "a", 0, 100).await.unwrap(), &b"no flush"[..]); v.shutdown().await.unwrap();
}
#[tokio::test]
async fn invalidation_preserves_xattrs_and_unrelated_dirty_state() {
    let (_s, c, dir, v) = setup(slow()).await;
    remote_put(&c, "remote", b"old").await;
    v.set_xattr("remote", "user.x", b"x").await.unwrap();
    // Metadata is now a real cloud mutation; publish it before testing clean invalidation.
    v.shutdown().await.unwrap();
    let v = Vfs::open(c.clone(), "drive", dir.path(), slow()).await.unwrap();
    assert_eq!(v.get_xattr("remote", "user.x").await.unwrap(), &b"x"[..]);
    v.create("local", Kind::File).await.unwrap(); v.write("local", 0, b"ours").await.unwrap();
    remote_put(&c, "remote", b"longer").await;
    v.apply_remote(WatchEvent::Change(Change { ev: 2, seq: 2, path: "remote".into(), op: "put".into(), version_id: None })).await;
    assert_eq!(v.lookup("remote").await.unwrap().size, 6);
    assert_eq!(v.get_xattr("remote", "user.x").await.unwrap(), &b"x"[..]);
    assert_eq!(v.read("local", 0, 100).await.unwrap(), &b"ours"[..]);
    c.delete("drive", "remote", None).await.unwrap();
    v.apply_remote(WatchEvent::Resync { head_seq: 3, last_ev: 3 }).await;
    assert_eq!(v.readdir("").await.unwrap().iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["local"]);
    v.shutdown().await.unwrap();
}
#[tokio::test]
async fn empty_files_directories_and_validation() {
    let (_s, c, dir, v) = setup(slow()).await;
    assert!(matches!(Vfs::open(c.clone(), "drive", dir.path(), options()).await, Err(FsError::Busy)));
    assert_eq!(v.create("/bad", Kind::File).await.unwrap_err(), FsError::Invalid);
    assert_eq!(v.create("a//b", Kind::File).await.unwrap_err(), FsError::Invalid);
    v.create("file", Kind::File).await.unwrap();
    assert_eq!(v.write("file", u64::MAX, b"x").await.unwrap_err(), FsError::Invalid);
    assert_eq!(v.create("file/child", Kind::File).await.unwrap_err(), FsError::NotDir);
    v.create("dir", Kind::Directory).await.unwrap();
    assert_eq!(v.write("dir", 0, b"x").await.unwrap_err(), FsError::IsDir);
    v.shutdown().await.unwrap();
    assert!(c.manifest("drive", "file", None).await.unwrap().shards.is_empty());
    assert_eq!(c.list("drive", "dir").await.unwrap().len(), 0);
}
#[tokio::test]
async fn failed_shutdown_keeps_queue_and_missing_shard_retry_recovers() {
    let (s, c, dir, v) = setup(slow()).await;
    v.create("a", Kind::File).await.unwrap(); v.write("a", 0, b"recover").await.unwrap();
    s.stats.fail_puts.store(1, Ordering::SeqCst);
    assert!(v.shutdown().await.is_err());
    assert_eq!(c.drive_info("drive").await.unwrap().head_seq, 0, "a failed shard PUT must never reach commit");
    let w = Vfs::open(c.clone(), "drive", dir.path(), options()).await.unwrap();
    s.stats.report_missing_once.store(true, Ordering::SeqCst);
    drained(&w).await;
    assert_eq!(c.read_range("drive", "a", 0, 100).await.unwrap(), &b"recover"[..]);
    w.shutdown().await.unwrap();
}

struct PausingToken {
    pause: std::sync::atomic::AtomicBool,
    entered: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}
impl uls_client::TokenProvider for PausingToken {
    fn token<'a, 'f>(&'a self) -> std::pin::Pin<Box<dyn std::future::Future<Output = uls_client::Result<uls_client::ProviderToken>> + Send + 'f>>
    where 'a: 'f, Self: 'f {
        Box::pin(async move {
            if self.pause.swap(false, Ordering::SeqCst) {
                self.entered.notify_one(); self.resume.notified().await;
            }
            Ok(uls_client::ProviderToken::new("test"))
        })
    }
}
async fn pausing_setup() -> (MockServer, Client, std::sync::Arc<PausingToken>, TempDir, Vfs) {
    let s = MockServer::start("test").await;
    let p = std::sync::Arc::new(PausingToken { pause: false.into(), entered: tokio::sync::Notify::new(), resume: tokio::sync::Notify::new() });
    let c = Client::builder(s.url(), "test").token_provider(p.clone()).build().unwrap();
    c.create_drive("drive", None).await.unwrap();
    let d = tempfile::tempdir().unwrap(); let v = Vfs::open(c.clone(), "drive", d.path(), options()).await.unwrap();
    (s,c,p,d,v)
}
#[tokio::test]
async fn writes_and_truncates_continue_during_a_stalled_publication() {
    let (_s, c, token, _d, v) = pausing_setup().await;
    v.create("a", Kind::File).await.unwrap(); v.write("a", 0, b"old bytes").await.unwrap();
    token.pause.store(true, Ordering::SeqCst); v.flush("a").await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), token.entered.notified()).await.unwrap();
    tokio::time::timeout(Duration::from_millis(300), async {
        v.truncate("a", 0).await.unwrap(); v.truncate("a", 16).await.unwrap();
        v.write("a", 8, b"new").await.unwrap(); v.flush("a").await.unwrap();
    }).await.expect("local journal must not wait for upload");
    let expected = b"\0\0\0\0\0\0\0\0new\0\0\0\0\0";
    assert_eq!(v.read("a", 0, 100).await.unwrap(), &expected[..]);
    token.resume.notify_one(); drained(&v).await;
    assert_eq!(c.read_range("drive", "a", 0, 100).await.unwrap(), &expected[..]);
    v.shutdown().await.unwrap();
}
#[tokio::test]
async fn writes_during_a_metadata_only_rename_rebase_onto_its_new_head() {
    let (_s, c, token, _d, v) = pausing_setup().await;
    remote_put(&c, "d/a", b"base").await;
    // Arm after hydrating the tree so the pause occurs inside the publisher, not validation.
    v.readdir("d").await.unwrap(); v.read("d/a", 0, 4).await.unwrap();
    v.rename("d", "e", false).await.unwrap();
    token.pause.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(3), token.entered.notified()).await.unwrap();
    tokio::time::timeout(Duration::from_millis(300), v.write("e/a", 0, b"ours")).await.unwrap().unwrap();
    token.resume.notify_one(); v.flush("e/a").await.unwrap(); drained(&v).await;
    assert_eq!(c.read_range("drive", "e/a", 0, 100).await.unwrap(), &b"ours"[..]);
    assert_eq!(c.list("drive", "e").await.unwrap().len(), 1);
    v.shutdown().await.unwrap();
}

#[tokio::test]
async fn drop_during_upload_recovers_frozen_and_newer_writes() {
    // Timing-sensitive (pauses mid-upload); generous waits keep it stable under parallel load.
    let (_s,c,token,dir,v) = pausing_setup().await;
    v.create("a",Kind::File).await.unwrap(); v.write("a",0,b"initial").await.unwrap();
    token.pause.store(true, Ordering::SeqCst); v.flush("a").await.unwrap();
    tokio::time::timeout(Duration::from_secs(15),token.entered.notified()).await.unwrap();
    v.truncate("a",0).await.unwrap(); v.write("a",0,b"recovered").await.unwrap();
    drop(v);
    let v = Vfs::open(c.clone(),"drive",dir.path(),options()).await.unwrap();
    assert_eq!(v.read("a",0,100).await.unwrap(), &b"recovered"[..]);
    v.shutdown().await.unwrap();
    assert_eq!(c.read_range("drive","a",0,100).await.unwrap(), &b"recovered"[..]);
}

#[tokio::test]
async fn regress_replace_rename_over_unpublished_file_drains() {
    let (_mock, client, _dir, vfs) = setup(options()).await;
    vfs.create("docs", Kind::Directory).await.unwrap();
    vfs.create("docs/a", Kind::File).await.unwrap();
    vfs.write("docs/a", 0, b"hello").await.unwrap();
    vfs.create("docs/b", Kind::File).await.unwrap();
    vfs.rename("docs/a", "docs/b", true).await.unwrap();
    vfs.flush("docs/b").await.unwrap();
    drained(&vfs).await;
    assert_eq!(client.read_range("drive", "docs/b", 0, 100).await.unwrap(), b"hello"[..]);
    vfs.shutdown().await.unwrap();
}

#[tokio::test]
async fn regress_bridge_sequence_drains() {
    let (_mock, client, _dir, vfs) = setup(VfsOptions { quiet_window: Duration::from_millis(20), max_dirty_age: Duration::from_secs(5), retry_initial: Duration::from_millis(20), retry_max: Duration::from_millis(100), journal_byte_cap: 1024*1024, hostname: "bridge-test".into() }).await;
    vfs.create("docs", Kind::Directory).await.unwrap();
    vfs.create("docs/draft", Kind::File).await.unwrap();
    vfs.write("docs/draft", 3, b"abcdef").await.unwrap();
    vfs.truncate("docs/draft", 7).await.unwrap();
    vfs.set_xattr("docs/draft", "com.apple.FinderInfo", &[7;32]).await.unwrap();
    vfs.set_xattr("docs/draft", "com.apple.ResourceFork", b"resource").await.unwrap();
    vfs.remove_xattr("docs/draft", "com.apple.FinderInfo").await.unwrap();
    vfs.rename("docs/draft", "docs/saved", false).await.unwrap();
    vfs.create("docs/replacement", Kind::File).await.unwrap();
    vfs.rename("docs/saved", "docs/replacement", true).await.unwrap();
    vfs.flush("docs/replacement").await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async { loop {
        let p = vfs.pending().await; if p.files + p.metadata_ops == 0 { break; }
        tokio::time::sleep(Duration::from_millis(10)).await; } }).await
        .unwrap_or_else(|_| panic!("STALL {:?}", futures_util::FutureExt::now_or_never(vfs.pending())));
    assert_eq!(client.read_range("drive", "docs/replacement", 0, 100).await.unwrap(), b"\0\0\0abcd"[..]);
}

#[tokio::test]
async fn budget_is_shared_across_drives_and_releases_after_publication() {
    let server = uls_mock::MockServer::start("local").await;
    let client = Client::builder(server.url(),"local").build().unwrap();
    client.create_drive("drive-a",None).await.unwrap(); client.create_drive("drive-b",None).await.unwrap();
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let budget = std::sync::Arc::new(uls_vfs::JournalBudget::new(5));
    let a = Vfs::open_with_budget(client.clone(),"drive-a",&dir.path().join("drive-a"),slow(),budget.clone()).await.unwrap();
    let b = Vfs::open_with_budget(client,"drive-b",&dir.path().join("drive-b"),slow(),budget.clone()).await.unwrap();
    a.create("f",Kind::File).await.unwrap(); b.create("f",Kind::File).await.unwrap();
    a.write("f",0,b"123").await.unwrap(); b.write("f",0,b"45").await.unwrap();
    assert_eq!(b.write("f",2,b"6").await.unwrap_err(),FsError::NoSpace);
    assert_eq!(budget.used(),5);
    a.shutdown().await.unwrap();
    assert_eq!(budget.used(),2);
    b.write("f",2,b"6").await.unwrap();
    b.shutdown().await.unwrap();assert_eq!(budget.used(),0);
}

#[tokio::test]
async fn rejected_writes_do_not_bypass_journal_disk_cap() {
    let (_server, _client, dir, v) = setup(VfsOptions { journal_byte_cap: 4, ..slow() }).await;
    v.create("file", Kind::File).await.unwrap();
    v.write("file", 0, b"1234").await.unwrap();
    for _ in 0..10 { assert_eq!(v.write("file", 0, b"5678").await.unwrap_err(), FsError::NoSpace); }
    let disk_bytes: u64 = std::fs::read_dir(dir.path().join("blobs")).unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len()).sum();
    assert_eq!(v.pending().await.bytes, 4);
    assert_eq!(disk_bytes, 4, "rejected writes must not leave unaccounted blobs");
    assert_eq!(v.read("file", 0, 4).await.unwrap(), b"1234"[..]);
    v.shutdown().await.unwrap();
}

#[tokio::test]
async fn rejected_write_cleanup_keeps_blobs_unknown_to_memory() {
    let (_server, _client, dir, v) = setup(VfsOptions { journal_byte_cap: 4, ..slow() }).await;
    v.create("file", Kind::File).await.unwrap();
    v.write("file", 0, b"1234").await.unwrap();
    // Stands in for a blob referenced by a save that reported failure after committing.
    let ambiguous = dir.path().join("blobs").join("999999");
    std::fs::write(&ambiguous, b"kept").unwrap();
    assert_eq!(v.write("file", 0, b"5678").await.unwrap_err(), FsError::NoSpace);
    assert!(ambiguous.exists(), "budget rejection must only remove blobs it created");
    assert_eq!(v.read("file", 0, 4).await.unwrap(), b"1234"[..]);
    v.shutdown().await.unwrap();
}

#[tokio::test]
async fn conflict_copy_keeps_unloaded_xattrs() {
    let (_s, c, _dir, v) = setup(options()).await;
    let first = tempfile::tempdir_in("/tmp").unwrap();
    let w = Vfs::open(c.clone(), "drive", first.path(), slow()).await.unwrap();
    w.create("a.txt", Kind::File).await.unwrap();
    w.write("a.txt", 0, b"base").await.unwrap();
    w.set_xattr("a.txt", "com.apple.ResourceFork", b"fork").await.unwrap();
    w.shutdown().await.unwrap();
    v.write("a.txt", 0, b"ours").await.unwrap();
    remote_put(&c, "a.txt", b"theirs").await;
    v.apply_remote(WatchEvent::Change(Change { ev: 2, seq: 2, path: "a.txt".into(), op: "put".into(), version_id: None })).await;
    let mut events = v.subscribe(); v.flush("a.txt").await.unwrap(); drained(&v).await;
    let mut copy = None;
    while let Ok(e) = events.try_recv() { if let VfsEvent::Conflict { copy: p, .. } = e { copy = Some(p); } }
    let copy = copy.expect("conflict event");
    v.shutdown().await.unwrap();
    let check = tempfile::tempdir_in("/tmp").unwrap();
    let x = Vfs::open(c.clone(), "drive", check.path(), slow()).await.unwrap();
    assert_eq!(x.read(&copy, 0, 100).await.unwrap(), &b"ours"[..]);
    assert_eq!(x.get_xattr(&copy, "com.apple.ResourceFork").await.unwrap(), b"fork"[..]);
    x.shutdown().await.unwrap();
}

#[tokio::test]
async fn prefetched_metadata_and_shards_allow_offline_read_and_reopen() {
    let (server, client, directory, vfs) = setup(slow()).await;
    remote_put(&client, "pinned.txt", b"available offline").await;
    vfs.warm_metadata("pinned.txt").await.unwrap();
    let manifest = client.manifest("drive", "pinned.txt", None).await.unwrap();
    for shard in manifest.shards { client.fetch_shard("drive", &shard.h).await.unwrap(); }
    drop(server);
    assert_eq!(vfs.lookup("._pinned.txt").await, Err(FsError::NotFound));
    let bytes = tokio::time::timeout(Duration::from_millis(500), vfs.read("pinned.txt", 0, 100)).await.unwrap().unwrap();
    assert_eq!(bytes, &b"available offline"[..]);
    vfs.shutdown().await.unwrap();
    let reopened = Vfs::open(client, "drive", directory.path(), slow()).await.unwrap();
    assert_eq!(reopened.read("pinned.txt", 0, 100).await.unwrap(), &b"available offline"[..]);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn slow_cloud_read_does_not_block_writes_or_lose_collected_overlay_bytes() {
    let (server, client, dir, vfs) = setup(slow()).await;
    remote_put(&client, "remote", b"abcdefghij").await;
    vfs.write("remote", 2, b"XYZ").await.unwrap();
    server.stats.shard_read_delay_ms.store(800, Ordering::SeqCst);
    let reader = vfs.clone();
    let read = tokio::spawn(async move { reader.read("remote", 0, 100).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while server.stats.shard_gets.load(Ordering::SeqCst) == 0 { tokio::task::yield_now().await; }
    }).await.expect("read reached the delayed cloud shard");
    tokio::time::timeout(Duration::from_millis(400), async {
        assert_eq!(vfs.pending().await.files, 1);
        vfs.truncate("remote", 0).await.unwrap();
        assert_eq!(std::fs::read_dir(dir.path().join("blobs")).unwrap().count(), 0);
        vfs.write("remote", 0, b"new").await.unwrap();
        vfs.flush("remote").await.unwrap();
    }).await.expect("local operations must not wait for cloud data");
    assert_eq!(read.await.unwrap().unwrap(), &b"abXYZfghij"[..]);
    assert_eq!(vfs.read("remote", 0, 100).await.unwrap(), &b"new"[..]);
    server.stats.shard_read_delay_ms.store(0, Ordering::SeqCst);
    vfs.shutdown().await.unwrap();
}

#[tokio::test]
async fn cached_reads_do_not_write_the_durable_journal() {
    let (_server, client, dir, vfs) = setup(slow()).await;
    remote_put(&client, "remote", b"immutable cloud version").await;
    assert_eq!(vfs.read("remote", 0, 100).await.unwrap(), &b"immutable cloud version"[..]);
    let journal = rusqlite::Connection::open(dir.path().join("journal.db")).unwrap();
    let version = || journal.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0)).unwrap();
    let before = version();
    assert_eq!(vfs.read("remote", 10, 5).await.unwrap(), &b"cloud"[..]);
    assert_eq!(version(), before, "a cache hit must not serialize/fsync the journal");
    vfs.shutdown().await.unwrap();
}

#[tokio::test]
async fn cached_lookup_and_readdir_do_not_rewrite_the_journal_but_cache_misses_survive_restart() {
    let (_server, client, dir, vfs) = setup(slow()).await;
    remote_put(&client, "folder/remote", b"cloud bytes").await;
    let journal = rusqlite::Connection::open(dir.path().join("journal.db")).unwrap();
    let version = || journal.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0)).unwrap();
    let before_lookup = version();
    assert_eq!(vfs.lookup("folder").await.unwrap().kind, Kind::Directory);
    assert_ne!(version(), before_lookup, "new metadata must be durable");
    let before_list = version();
    assert_eq!(vfs.readdir("folder").await.unwrap().len(), 1);
    assert_ne!(version(), before_list, "a new listing must be durable");
    let cached = version();
    assert_eq!(vfs.lookup("folder/remote").await.unwrap().size, 11);
    assert_eq!(vfs.readdir("folder").await.unwrap().len(), 1);
    assert_eq!(version(), cached, "cached SMB metadata probes must not serialize/fsync journal state");
    vfs.shutdown().await.unwrap();
    let reopened = Vfs::open(client, "drive", dir.path(), slow()).await.unwrap();
    assert_eq!(reopened.lookup("folder/remote").await.unwrap().size, 11);
    assert_eq!(reopened.readdir("folder").await.unwrap().len(), 1);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn growing_file_survives_max_dirty_age_publication_before_flush() {
    let (_server, client, _dir, vfs) = setup(VfsOptions {
        max_dirty_age: Duration::from_millis(10), quiet_window: Duration::from_secs(60), ..options()
    }).await;
    vfs.create("growing", Kind::File).await.unwrap();
    let mut expected = Vec::new();
    for i in 0..24u8 {
        let block = vec![i; 16 * 1024];
        vfs.write("growing", expected.len() as u64, &block).await.unwrap();
        expected.extend_from_slice(&block);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(client.drive_info("drive").await.unwrap().head_seq > 0, "dirty-age publication must overlap writes");
    vfs.flush("growing").await.unwrap();
    drained(&vfs).await;
    assert_eq!(vfs.read("growing", 0, expected.len() as u32).await.unwrap(), expected);
    assert_eq!(client.read_range("drive", "growing", 0, expected.len() as u64).await.unwrap(), expected);
    assert_eq!(client.list("drive", "").await.unwrap().len(), 1, "normal growth must not create conflict copies");
    vfs.shutdown().await.unwrap();
}

#[tokio::test]
async fn growing_local_writes_commit_one_snapshot_each_and_recover_all_bytes() {
    let (_server, client, dir, vfs) = setup(slow()).await;
    vfs.create("growing", Kind::File).await.unwrap();
    let db = rusqlite::Connection::open(dir.path().join("journal.db")).unwrap();
    db.execute_batch("CREATE TABLE saved_snapshots (id INTEGER PRIMARY KEY); CREATE TRIGGER count_snapshots AFTER UPDATE ON journal BEGIN INSERT INTO saved_snapshots VALUES (NULL); END;").unwrap();
    let mut expected = Vec::new();
    for i in 0_u8..32 {
        let bytes = vec![i; 4096];
        vfs.write("growing", expected.len() as u64, &bytes).await.unwrap(); expected.extend(bytes);
    }
    assert_eq!(db.query_row("SELECT count(*) FROM saved_snapshots", [], |r| r.get::<_, i64>(0)).unwrap(), 32,
        "each write should persist its data, extent and allocator in one snapshot, without a reservation snapshot");
    drop(db); drop(vfs); tokio::task::yield_now().await;
    let recovered = Vfs::open(client.clone(), "drive", dir.path(), slow()).await.unwrap();
    assert_eq!(recovered.read("growing", 0, expected.len() as u32).await.unwrap().as_ref(), expected);
    recovered.shutdown().await.unwrap();
    assert_eq!(client.read_range("drive", "growing", 0, expected.len() as u64).await.unwrap().as_ref(), expected);
}

#[tokio::test]
async fn failed_snapshot_keeps_acknowledged_bytes_and_orphan_recovery_is_safe() {
    let (_server, client, dir, vfs) = setup(slow()).await;
    vfs.create("file", Kind::File).await.unwrap();
    vfs.write("file", 0, b"acknowledged").await.unwrap();
    let db = rusqlite::Connection::open(dir.path().join("journal.db")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_snapshot BEFORE UPDATE ON journal BEGIN SELECT RAISE(FAIL, 'injected snapshot failure'); END;").unwrap();
    assert!(vfs.write("file", 0, b"not acknowledged").await.is_err());
    assert_eq!(vfs.read("file", 0, 100).await.unwrap().as_ref(), b"acknowledged");
    assert_eq!(std::fs::read_dir(dir.path().join("blobs")).unwrap().count(), 2,
        "an ambiguous journal error must not delete the freshly synced blob");
    db.execute_batch("DROP TRIGGER reject_snapshot;").unwrap(); drop(db); drop(vfs);
    tokio::task::yield_now().await;
    let recovered = Vfs::open(client.clone(), "drive", dir.path(), slow()).await.unwrap();
    assert_eq!(std::fs::read_dir(dir.path().join("blobs")).unwrap().count(), 1,
        "recovery may collect the orphan after loading the committed snapshot");
    assert_eq!(recovered.read("file", 0, 100).await.unwrap().as_ref(), b"acknowledged");
    recovered.truncate("file", 0).await.unwrap();
    recovered.write("file", 0, b"next safe write").await.unwrap();
    recovered.shutdown().await.unwrap();
    assert_eq!(client.read_range("drive", "file", 0, 100).await.unwrap().as_ref(), b"next safe write");
}

#[tokio::test]
async fn sequential_reads_overlap_shard_downloads() {
    // 24 MiB of incompressible bytes chunks into ~12 shards of ~2 MiB. A first file read with no
    // added latency measures local cost (hashing dominates in debug builds), so the assertion
    // covers network overlap only.
    let (server, c, _dir, v) = setup(slow()).await;
    let mut x = 0x9e3779b97f4a7c15u64;
    let mut file = || { let mut b = vec![0u8; 24 << 20]; for v in &mut b { x ^= x << 13; x ^= x >> 7; x ^= x << 17; *v = x as u8; } b };
    let (baseline_bytes, bytes) = (file(), file());
    remote_put(&c, "baseline", &baseline_bytes).await;
    remote_put(&c, "big", &bytes).await;
    let shards = c.manifest("drive", "big", None).await.unwrap().shards.len() as u64;
    assert!(shards >= 6, "need several shards, got {shards}");
    async fn read_all(v: &Vfs, name: &str, size: usize) -> (Vec<u8>, Duration) {
        let started = std::time::Instant::now();
        let mut out = Vec::with_capacity(size);
        // 1 MiB reads, like the kernel's sequential SMB reads.
        while out.len() < size { out.extend_from_slice(&v.read(name, out.len() as u64, 1 << 20).await.unwrap()); }
        (out, started.elapsed())
    }
    let (out, local) = read_all(&v, "baseline", baseline_bytes.len()).await;
    assert!(out == baseline_bytes, "baseline read returned different bytes");
    const DELAY: u64 = 150;
    server.stats.shard_read_delay_ms.store(DELAY, Ordering::SeqCst);
    let (out, elapsed) = read_all(&v, "big", bytes.len()).await;
    server.stats.shard_read_delay_ms.store(0, Ordering::SeqCst);
    assert!(out == bytes, "sequential read returned different bytes");
    // Serial fetches would add at least shards × DELAY; read-ahead must overlap most of it.
    let serial = Duration::from_millis(shards * DELAY);
    let added = elapsed.saturating_sub(local);
    assert!(added < serial / 2, "{shards} shards added {added:?} over a {local:?} local baseline; serial would add {serial:?}");
    v.shutdown().await.unwrap();
}

/// Our own commit echoes back through the drive watch; the file must stay visible throughout.
#[tokio::test]
async fn own_commit_echo_never_hides_published_file() {
    let (_s, _c, _dir, v) = setup(options()).await;
    let data = vec![7u8; 300_000];
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    v.create("x.bin", Kind::File).await.unwrap();
    v.write("x.bin", 0, &data).await.unwrap(); v.flush("x.bin").await.unwrap();
    let poll = { let (v, stop) = (v.clone(), stop.clone()); tokio::spawn(async move {
        let mut seen = false;
        while !stop.load(Ordering::SeqCst) {
            match v.lookup("x.bin").await {
                Ok(a) => { seen = true; assert_eq!(a.size, 300_000, "size changed"); }
                Err(e) => assert!(!seen, "file vanished: {e:?}"),
            }
            if seen {
                let names: Vec<_> = v.readdir("").await.unwrap().into_iter().map(|e| e.name).collect();
                assert!(names.contains(&"x.bin".to_string()), "missing from listing: {names:?}");
            }
            tokio::task::yield_now().await;
        }
        seen
    }) };
    let mut seq = 1;
    while { let p = v.pending().await; p.files + p.metadata_ops > 0 } {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    for _ in 0..50 {
        seq += 1;
        v.apply_remote(WatchEvent::Change(Change { ev: seq, seq: 1, path: "x.bin".into(), op: "put".into(), version_id: None })).await;
        tokio::time::sleep(Duration::from_millis(3)).await;
    }
    stop.store(true, Ordering::SeqCst);
    assert!(poll.await.unwrap());
    assert_eq!(v.read("x.bin", 0, 10).await.unwrap(), &data[..10]);
}

/// The daemon uploads via a staging name renamed over the destination (engine.rs upload path).
#[tokio::test]
async fn staged_rename_upload_never_hides_destination() {
    let (_s, c, _dir, v) = setup(options()).await;
    remote_put(&c, "x.bin", &vec![1u8; 1000]).await;
    let _ = v.lookup("x.bin").await.unwrap(); v.readdir("").await.unwrap();
    let data = vec![7u8; 300_000];
    v.create(".uls-upload-1", Kind::File).await.unwrap();
    v.write(".uls-upload-1", 0, &data).await.unwrap(); v.flush(".uls-upload-1").await.unwrap();
    v.rename(".uls-upload-1", "x.bin", true).await.unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let poll = { let (v, stop) = (v.clone(), stop.clone()); tokio::spawn(async move {
        while !stop.load(Ordering::SeqCst) {
            let a = v.lookup("x.bin").await.expect("destination vanished");
            assert!(a.size == 300_000 || a.size == 1000, "odd size {}", a.size);
            let names: Vec<_> = v.readdir("").await.unwrap().into_iter().map(|e| e.name).collect();
            assert!(names.contains(&"x.bin".to_string()), "missing from listing: {names:?}");
            tokio::task::yield_now().await;
        }
    }) };
    let mut seq = 1;
    while { let p = v.pending().await; p.files + p.metadata_ops > 0 } {
        seq += 1;
        v.apply_remote(WatchEvent::Change(Change { ev: seq, seq: 1, path: "x.bin".into(), op: "put".into(), version_id: None })).await;
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    for _ in 0..30 {
        seq += 1;
        v.apply_remote(WatchEvent::Change(Change { ev: seq, seq: 2, path: "x.bin".into(), op: "put".into(), version_id: None })).await;
        tokio::time::sleep(Duration::from_millis(3)).await;
    }
    stop.store(true, Ordering::SeqCst); poll.await.unwrap();
    assert_eq!(v.lookup("x.bin").await.unwrap().size, 300_000);
    assert_eq!(v.read("x.bin", 0, 10).await.unwrap(), &data[..10]);
}

/// A metadata batch invalidates cached nodes; with more work still queued the cached listings
/// must go too, or `load` mistakes "stale" for "known absent" and reports ENOENT.
#[tokio::test]
async fn metadata_batch_with_queued_work_never_hides_existing_files() {
    let (_s, c, _dir, v) = setup(options()).await;
    remote_put(&c, "keep.bin", &vec![3u8; 2000]).await;
    v.readdir("").await.unwrap(); v.lookup("keep.bin").await.unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let poll = { let (v, stop) = (v.clone(), stop.clone()); tokio::spawn(async move {
        while !stop.load(Ordering::SeqCst) {
            let a = v.lookup("keep.bin").await.expect("existing file reported missing");
            assert_eq!(a.size, 2000);
            tokio::task::yield_now().await;
        }
    }) };
    for i in 0..20 {
        let (a, b) = (format!("s{i}"), format!("d{i}"));
        v.create(&a, Kind::File).await.unwrap();
        v.write(&a, 0, &vec![1u8; 5000]).await.unwrap(); v.flush(&a).await.unwrap();
        v.rename(&a, &b, true).await.unwrap();
        // Keep a second write queued behind the metadata batch.
        v.write(&b, 5000, b"tail").await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    drained(&v).await;
    stop.store(true, Ordering::SeqCst); poll.await.unwrap();
}

#[tokio::test]
async fn cloud_xattrs_survive_independent_client_edits_rename_and_restore() {
    let (_server, client, _dir, v) = setup(slow()).await;
    v.create("art", Kind::File).await.unwrap();
    v.write("art", 0, b"data").await.unwrap();
    v.set_xattr("art", "com.apple.ResourceFork", b"resource").await.unwrap();
    v.set_xattr("art", "com.apple.FinderInfo", &[7; 32]).await.unwrap();
    v.shutdown().await.unwrap();
    let original = client.manifest("drive", "art", None).await.unwrap().version_id;
    let second = tempfile::tempdir_in("/tmp").unwrap();
    let w = Vfs::open(client.clone(), "drive", second.path(), slow()).await.unwrap();
    assert_eq!(w.get_xattr("art", "com.apple.ResourceFork").await.unwrap(), b"resource"[..]);
    assert_eq!(w.get_xattr("art", "com.apple.FinderInfo").await.unwrap(), [7;32][..]);
    // Attribute-only changes must create a cloud version; ordinary data edits preserve them.
    w.set_xattr("art", "com.apple.ResourceFork", b"changed").await.unwrap();
    w.write("art", 0, b"next").await.unwrap();
    w.truncate("art", 2).await.unwrap();
    w.remove_xattr("art", "com.apple.FinderInfo").await.unwrap();
    w.shutdown().await.unwrap();
    let third = tempfile::tempdir_in("/tmp").unwrap();
    let x = Vfs::open(client.clone(), "drive", third.path(), slow()).await.unwrap();
    assert_eq!(x.read("art", 0, 100).await.unwrap(), b"ne"[..]);
    assert_eq!(x.get_xattr("art", "com.apple.ResourceFork").await.unwrap(), b"changed"[..]);
    assert_eq!(x.get_xattr("art", "com.apple.FinderInfo").await.unwrap_err(), FsError::NotFound);
    x.set_xattr("art", "user.only-metadata", b"published").await.unwrap();
    x.shutdown().await.unwrap();
    let check = tempfile::tempdir_in("/tmp").unwrap();
    let y = Vfs::open(client.clone(), "drive", check.path(), slow()).await.unwrap();
    assert_eq!(y.get_xattr("art", "user.only-metadata").await.unwrap(), b"published"[..]);
    y.rename("art", "renamed", false).await.unwrap();
    y.shutdown().await.unwrap();
    let renamed = client.manifest("drive", "renamed", None).await.unwrap();
    assert!(renamed.xattrs.unwrap().contains_key("com.apple.ResourceFork"));
    // The mock's historical path is immutable; restore the original before rename under its old path.
    client.restore("drive", "art", &original, None).await.unwrap();
    let restored = tempfile::tempdir_in("/tmp").unwrap();
    let z = Vfs::open(client.clone(), "drive", restored.path(), slow()).await.unwrap();
    assert_eq!(z.get_xattr("art", "com.apple.ResourceFork").await.unwrap(), b"resource"[..]);
    assert_eq!(z.get_xattr("art", "com.apple.FinderInfo").await.unwrap(), [7;32][..]);
    z.shutdown().await.unwrap();
}

#[tokio::test]
async fn xattr_publication_refuses_old_servers_before_upload_and_recovers() {
    let (server, client, dir, v) = setup(slow()).await;
    server.stats.xattrs_disabled.store(true, Ordering::SeqCst);
    v.create("art", Kind::File).await.unwrap();
    v.write("art", 0, b"data").await.unwrap();
    v.set_xattr("art", "com.apple.ResourceFork", b"resource").await.unwrap();
    let err = v.clone().shutdown().await.unwrap_err();
    assert!(err.to_string().contains("Server upgrade required"));
    assert_eq!(server.stats.shard_puts.load(Ordering::SeqCst), 0);
    assert_eq!(v.pending().await.files, 1);
    drop(v); tokio::task::yield_now().await;
    server.stats.xattrs_disabled.store(false, Ordering::SeqCst);
    Vfs::open(client.clone(), "drive", dir.path(), slow()).await.unwrap().shutdown().await.unwrap();
    let cold = tempfile::tempdir_in("/tmp").unwrap();
    let w = Vfs::open(client, "drive", cold.path(), slow()).await.unwrap();
    assert_eq!(w.get_xattr("art", "com.apple.ResourceFork").await.unwrap(), b"resource"[..]);
    w.shutdown().await.unwrap();
}

#[tokio::test]
async fn folder_attributes_and_invalid_names_are_rejected_without_queueing() {
    let (_server, _client, _dir, v) = setup(slow()).await;
    v.create("folder", Kind::Directory).await.unwrap();
    assert_eq!(v.set_xattr("folder", "com.apple.FinderInfo", &[0;32]).await.unwrap_err(), FsError::IsDir);
    assert_eq!(v.set_xattr("folder", &"a".repeat(256), b"x").await.unwrap_err(), FsError::Invalid);
    assert!(v.list_xattr("folder").await.unwrap().is_empty());
    v.shutdown().await.unwrap();
}

#[tokio::test]
async fn byte_only_client_overwrite_preserves_cloud_attributes() {
    let (_server, client, _dir, v) = setup(slow()).await;
    v.create("art", Kind::File).await.unwrap();
    v.write("art", 0, b"base").await.unwrap();
    v.set_xattr("art", "com.apple.ResourceFork", b"resource").await.unwrap();
    v.shutdown().await.unwrap();
    // CLI/older clients omit attrs; overwriting bytes must preserve the current metadata.
    remote_put(&client, "art", b"new").await;
    let cold = tempfile::tempdir_in("/tmp").unwrap();
    let w = Vfs::open(client.clone(), "drive", cold.path(), slow()).await.unwrap();
    // A cold data-only edit also leaves attrs lazy and must preserve them.
    w.write("art", 0, b"mac").await.unwrap();
    w.shutdown().await.unwrap();
    let independent = tempfile::tempdir_in("/tmp").unwrap();
    let x = Vfs::open(client, "drive", independent.path(), slow()).await.unwrap();
    assert_eq!(x.read("art", 0, 10).await.unwrap(), b"mac"[..]);
    assert_eq!(x.get_xattr("art", "com.apple.ResourceFork").await.unwrap(), b"resource"[..]);
    x.remove_xattr("art", "com.apple.ResourceFork").await.unwrap();
    x.shutdown().await.unwrap();
}

#[tokio::test]
async fn confirmed_write_denial_blocks_new_writes_keeps_reads_and_recovers() {
    let (server, _client, _dir, v) = setup(options()).await;
    server.stats.deny_writes.store(true, Ordering::SeqCst);
    v.create("local", Kind::File).await.unwrap();
    v.write("local", 0, b"saved-locally").await.unwrap();
    v.flush("local").await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !v.lookup("local").await.unwrap().readonly { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();
    assert_eq!(v.write("local", 0, b"rejected").await.unwrap_err(), FsError::ReadOnly);
    assert_eq!(v.create("rejected", Kind::File).await.unwrap_err(), FsError::ReadOnly);
    assert_eq!(v.truncate("local", 0).await.unwrap_err(), FsError::ReadOnly);
    assert_eq!(v.remove("local").await.unwrap_err(), FsError::ReadOnly);
    assert_eq!(v.set_xattr("local", "user.x", b"no").await.unwrap_err(), FsError::ReadOnly);
    assert_eq!(v.read("local", 0, 100).await.unwrap(), b"saved-locally"[..]);
    assert_eq!(v.pending().await.files, 1);
    server.stats.deny_writes.store(false, Ordering::SeqCst);
    drained(&v).await;
    assert!(!v.lookup("local").await.unwrap().readonly);
    v.write("local", 0, b"restored").await.unwrap();
    v.shutdown().await.unwrap();
}
