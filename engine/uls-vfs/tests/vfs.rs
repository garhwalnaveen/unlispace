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
    let (_s, c, _dir, v) = setup(VfsOptions { max_dirty_age: Duration::from_secs(10), ..options() }).await;
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
    let (_s, c, _dir, v) = setup(slow()).await;
    remote_put(&c, "remote", b"old").await;
    v.set_xattr("remote", "user.x", b"x").await.unwrap();
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
