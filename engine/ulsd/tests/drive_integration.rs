//! Local-only integration of daemon mounts, writable VFS publication and remote watches.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use nfsserve::nfs::nfsstat3;
use nfsserve::vfs::NFSFileSystem;
use serde_json::{Value, json};
use uls_client::Client;
use uls_vfs::{Kind, Vfs};
use ulsd::engine::{Engine, EngineConfig};
use ulsd::mount::{MountAdapter, MountError, MountHandle, MountRequest, NeedAccess};
use ulsd::nfs::UlsFs;
use ulsd::protocol::{Response, parse_request};

#[derive(Default)]
struct Captured {
    vfs: Mutex<Option<Vfs>>,
    nfs: Mutex<Option<Arc<UlsFs>>>,
}
struct Adapter { captured: Arc<Captured>, native: bool }
struct Handle;
#[async_trait]
impl MountHandle for Handle {
    async fn unmount(&self) -> Result<(), MountError> { Ok(()) }
}
#[async_trait]
impl MountAdapter for Adapter {
    fn access(&self) -> NeedAccess { NeedAccess::Read }
    async fn mount(&self, req: MountRequest) -> Result<Arc<dyn MountHandle>, MountError> {
        *self.captured.vfs.lock().unwrap() = Some(req.vfs.clone());
        *self.captured.nfs.lock().unwrap() = Some(Arc::new(UlsFs::new(req.vfs.clone(), 501, 20, true)));
        if self.native { ulsd::nfs_adapter::NfsAdapter { read_only: true }.mount(req).await }
        else { Ok(Arc::new(Handle)) }
    }
}

async fn call(engine: &Arc<Engine>, method: &str, params: Value) -> Response {
    engine.handle(parse_request(&json!({"id":1,"method":method,"params":params}).to_string()).unwrap()).await
}
async fn ok(engine: &Arc<Engine>, method: &str, params: Value) -> Value {
    let response = call(engine, method, params).await;
    assert!(response.error.is_none(), "{response:?}");
    response.result.unwrap()
}
async fn change(events: &mut tokio::sync::broadcast::Receiver<String>, path: &str) {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let event: Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            if event["event"] == "change" && event["data"]["paths"].as_array().unwrap().contains(&json!(path)) { break; }
        }
    }).await.expect("watch change");
}
fn config(dir: &std::path::Path, endpoint: String) -> EngineConfig {
    EngineConfig { version: "test".into(), state_path: dir.join("state.json"), mount_root: dir.join("mnt"),
        cache_dir: Some(dir.join("cache")), secrets: Arc::new(uls_auth::MemoryStore::new()), default_endpoint: endpoint }
}
struct NativeCleanup(Option<std::path::PathBuf>);
impl Drop for NativeCleanup {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::process::Command::new("/sbin/umount").arg(path).output();
        }
    }
}

async fn exercise(native: bool) {
    let server = uls_mock::MockServer::start("local").await;
    let client = Client::builder(server.url(), "local").build().unwrap();
    client.create_drive("drive", None).await.unwrap();
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let _cleanup = NativeCleanup(native.then(|| dir.path().join("mnt/drive")));
    let file = dir.path().join("seed");
    std::fs::write(&file, b"old").unwrap();
    client.upload_file("drive", &file, "seed", None).await.unwrap();
    let captured = Arc::new(Captured::default());
    let engine = Engine::new(config(dir.path(), server.url()), Arc::new(Adapter { captured: captured.clone(), native }));
    ok(&engine, "config.set", json!({"token":"local"})).await;
    let mounted = call(&engine, "drive.mount", json!({"driveId":"drive"})).await;
    if let Some(error) = mounted.error {
        engine.shutdown().await;
        panic!("NFS mount failed: {error:?}");
    }
    let mountpoint = dir.path().join("mnt/drive");
    let vfs = captured.vfs.lock().unwrap().clone().unwrap();
    let nfs = captured.nfs.lock().unwrap().clone().unwrap();
    let mut events = engine.subscribe();
    // Wait for the initial head snapshot before injecting changes.
    tokio::time::timeout(Duration::from_secs(5), async {
        while server.stats.watch_connects.load(std::sync::atomic::Ordering::SeqCst) == 0 { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();
    assert_eq!(vfs.read("seed", 0, 100).await.unwrap().as_ref(), b"old");
    let id = nfs.lookup(nfs.root_dir(), &b"seed"[..].into()).await.unwrap();
    assert_eq!(nfs.read(id, 0, 100).await.unwrap().0, b"old");
    assert!(matches!(nfs.write(id, 0, b"denied").await, Err(nfsstat3::NFS3ERR_ROFS)));
    if native {
        assert_eq!(tokio::fs::read(mountpoint.join("seed")).await.unwrap(), b"old");
        assert!(tokio::fs::write(mountpoint.join("denied"), b"no").await.is_err());
    }
    // Direct writable VFS path shares the same mounted drive, even with the NFS fallback.
    vfs.create("local", Kind::File).await.unwrap();
    vfs.write("local", 0, b"journal bytes").await.unwrap();
    vfs.flush("local").await.unwrap();
    let transfers = ok(&engine, "transfers", json!({})).await;
    assert_eq!(transfers["transfers"][0]["driveId"], "drive");
    assert_eq!(transfers["transfers"][0]["status"], "queued");
    assert_eq!(transfers["transfers"][0]["bytesTotal"], 13);
    assert!(ok(&engine, "status", json!({})).await["pendingOps"].as_i64().unwrap() > 0);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event: Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            if event["event"] == "transfer" && event["data"]["status"] == "done" {
                assert_eq!(event["data"]["bytesDone"], 13);
                break;
            }
        }
    }).await.unwrap();
    assert_eq!(client.read_range("drive", "local", 0, 100).await.unwrap().as_ref(), b"journal bytes");
    assert_eq!(ok(&engine, "transfers", json!({})).await, json!({"transfers":[]}));
    assert_eq!(nfs.getattr(id).await.unwrap().size, 3);
    std::fs::write(&file, b"remote replacement").unwrap();
    client.upload_file("drive", &file, "seed", None).await.unwrap();
    change(&mut events, "/seed").await;
    assert_eq!(vfs.read("seed", 0, 100).await.unwrap().as_ref(), b"remote replacement");
    tokio::time::timeout(Duration::from_millis(500), async {
        while nfs.getattr(id).await.unwrap().size != 18 { tokio::task::yield_now().await; }
    }).await.expect("watch invalidates NFS attributes before their one-second TTL");
    let state: Value = serde_json::from_slice(&std::fs::read(dir.path().join("state.json")).unwrap()).unwrap();
    assert_eq!(state["cursors"]["drive"], client.changes("drive", 0, 1).await.unwrap().last_ev);
    assert!(dir.path().join("drives/drive").is_dir());
    engine.shutdown().await;
    captured.vfs.lock().unwrap().take();
    captured.nfs.lock().unwrap().take();
}

#[tokio::test]
async fn nfs_read_only_core_vfs_writes_transfers_and_watch() { exercise(false).await; }

#[tokio::test]
#[ignore = "requires macOS native mount_nfs privileges; run explicitly"]
async fn native_nfs_mount_vfs_writes_and_watch() { exercise(true).await; }

#[tokio::test]
async fn resync_invalidates_cached_tree_and_persists_event_cursor() {
    let server = uls_mock::MockServer::start("local").await;
    let client = Client::builder(server.url(), "local").build().unwrap();
    client.create_drive("drive", None).await.unwrap();
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let seed = dir.path().join("seed");
    std::fs::write(&seed, b"old").unwrap();
    client.upload_file("drive", &seed, "seed", None).await.unwrap();
    let vfs = Vfs::open(client.clone(), "drive", &dir.path().join("journal"), Default::default()).await.unwrap();
    assert_eq!(vfs.read("seed", 0, 100).await.unwrap().as_ref(), b"old");
    std::fs::write(&seed, b"new").unwrap();
    client.upload_file("drive", &seed, "seed", None).await.unwrap();
    server.set_resync_backlog(1);
    let state = Arc::new(ulsd::state::StateStore::load(dir.path().join("state.json")));
    state.set_cursor("drive", 0);
    let (events, mut rx) = tokio::sync::broadcast::channel(16);
    let task = tokio::spawn(ulsd::watch::run(ulsd::watch::WatchCtx {
        drive_id: "drive".into(), client: client.clone(), vfs: vfs.clone(), events, state: state.clone(),
    }));
    change(&mut rx, "/").await;
    assert_eq!(state.cursor("drive"), Some(2));
    assert_eq!(vfs.read("seed", 0, 100).await.unwrap().as_ref(), b"new");
    task.abort();
    let _ = task.await;
    vfs.shutdown().await.unwrap();
}

#[tokio::test]
async fn vfs_conflict_is_broadcast_with_leading_slash_paths() {
    let server = uls_mock::MockServer::start("local").await;
    let client = Client::builder(server.url(), "local").build().unwrap();
    client.create_drive("drive", None).await.unwrap();
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let file = dir.path().join("seed");
    std::fs::write(&file, b"base").unwrap();
    client.upload_file("drive", &file, "docs/a.txt", None).await.unwrap();
    let captured = Arc::new(Captured::default());
    let engine = Engine::new(config(dir.path(), server.url()), Arc::new(Adapter { captured: captured.clone(), native: false }));
    ok(&engine, "config.set", json!({"token":"local"})).await;
    assert!(call(&engine, "drive.mount", json!({"driveId":"drive"})).await.error.is_none());
    let vfs = captured.vfs.lock().unwrap().clone().unwrap();
    let mut events = engine.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        while server.stats.watch_connects.load(std::sync::atomic::Ordering::SeqCst) == 0 { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();

    vfs.write("docs/a.txt", 0, b"ours").await.unwrap();
    std::fs::write(&file, b"theirs").unwrap();
    client.upload_file("drive", &file, "docs/a.txt", None).await.unwrap();
    change(&mut events, "/docs/a.txt").await;
    vfs.flush("docs/a.txt").await.unwrap();

    let data = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event: Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            if event["event"] == "conflict" { break event["data"].clone(); }
        }
    }).await.expect("conflict event");
    assert_eq!(data["driveId"], "drive");
    assert_eq!(data["path"], "/docs/a.txt");
    let copy = data["copy"].as_str().unwrap();
    assert!(copy.starts_with("/docs/a (conflict, ") && copy.ends_with(").txt"), "{copy}");
    assert_eq!(data.as_object().unwrap().len(), 3);
    // The preserved local edit exists remotely under the announced name.
    assert_eq!(client.read_range("drive", copy.trim_start_matches('/'), 0, 100).await.unwrap().as_ref(), b"ours");
    engine.shutdown().await;
    captured.vfs.lock().unwrap().take();
    captured.nfs.lock().unwrap().take();
}

#[tokio::test]
async fn shared_journal_cap_emits_journal_full_and_can_be_raised() {
    let server = uls_mock::MockServer::start("local").await;
    let client = Client::builder(server.url(), "local").build().unwrap();
    client.create_drive("drive", None).await.unwrap();
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let captured = Arc::new(Captured::default());
    let engine = Engine::new(config(dir.path(),server.url()),Arc::new(Adapter {captured:captured.clone(),native:false}));
    ok(&engine,"config.set",json!({"token":"local","journalCapBytes":3})).await;
    ok(&engine,"drive.mount",json!({"driveId":"drive"})).await;
    let vfs = captured.vfs.lock().unwrap().clone().unwrap();
    vfs.create("cap",Kind::File).await.unwrap();vfs.write("cap",0,b"abc").await.unwrap();
    let mut events = engine.subscribe();
    assert_eq!(vfs.write("cap",0,b"d").await.unwrap_err(),uls_vfs::FsError::NoSpace);
    tokio::time::timeout(Duration::from_secs(2),async {
        loop { let ev:Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            if ev["event"]=="state" && ev["data"]["message"]=="journal_full" { break; }
        }
    }).await.unwrap();
    assert_eq!(vfs.read("cap",0,10).await.unwrap().as_ref(),b"abc");
    ok(&engine,"config.set",json!({"journalCapBytes":4})).await;
    assert_eq!(vfs.write("cap",0,b"d").await.unwrap(),1);
    assert_eq!(ok(&engine,"uploads",json!({})).await["journalBytes"],4);
    engine.shutdown().await;
}
