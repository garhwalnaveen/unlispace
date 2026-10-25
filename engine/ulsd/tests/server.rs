use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use ulsd::engine::{Engine, EngineConfig};
use ulsd::mount::{MountAdapter, MountError, MountHandle, MountRequest, NeedAccess};
use ulsd::server;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

struct FakeAdapter {
    mounted: Arc<Mutex<Vec<String>>>,
}
struct FakeHandle {
    id: String,
    mounted: Arc<Mutex<Vec<String>>>,
}
#[async_trait]
impl MountAdapter for FakeAdapter {
    fn access(&self) -> NeedAccess {
        NeedAccess::Read
    }
    async fn mount(&self, req: MountRequest) -> Result<Arc<dyn MountHandle>, MountError> {
        self.mounted.lock().unwrap().push(req.drive_id.clone());
        Ok(Arc::new(FakeHandle { id: req.drive_id, mounted: self.mounted.clone() }))
    }
}
#[async_trait]
impl MountHandle for FakeHandle {
    async fn unmount(&self) -> Result<(), MountError> {
        self.mounted.lock().unwrap().retain(|d| *d != self.id);
        Ok(())
    }
}

struct Harness {
    sock: PathBuf,
    engine: Arc<Engine>,
    mounted: Arc<Mutex<Vec<String>>>,
    dir: tempfile::TempDir,
    _task: tokio::task::JoinHandle<()>,
}

fn secrets() -> Arc<dyn uls_auth::SecretStore> {
    Arc::new(uls_auth::MemoryStore::new())
}

async fn harness_with(uid_override: Option<u32>) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("run").join("ulsd.sock");
    let mounted = Arc::new(Mutex::new(Vec::new()));
    let cfg = EngineConfig {
        version: "0.1.0".into(),
        state_path: dir.path().join("state.json"),
        mount_root: dir.path().join("mnt"),
        cache_dir: Some(dir.path().join("cache")),
        secrets: secrets(),
        default_endpoint: "http://127.0.0.1:1".into(),
    };
    let engine = Engine::new(cfg, Arc::new(FakeAdapter { mounted: mounted.clone() }));
    engine.start().await;
    let (listener, uid) = server::bind(&sock).unwrap();
    let task = tokio::spawn(server::serve(listener, uid_override.unwrap_or(uid), engine.clone()));
    Harness { sock, engine, mounted, dir, _task: task }
}

async fn harness() -> Harness {
    harness_with(None).await
}

struct Conn {
    rd: Lines<BufReader<OwnedReadHalf>>,
    wr: OwnedWriteHalf,
}

impl Conn {
    async fn open(sock: &PathBuf) -> Conn {
        let s = UnixStream::connect(sock).await.unwrap();
        let (r, wr) = s.into_split();
        Conn { rd: BufReader::new(r).lines(), wr }
    }
    async fn send(&mut self, line: &str) {
        self.wr.write_all(line.as_bytes()).await.unwrap();
        self.wr.write_all(b"\n").await.unwrap();
    }
    async fn recv(&mut self) -> Value {
        let l = tokio::time::timeout(Duration::from_secs(5), self.rd.next_line()).await.expect("timeout").unwrap().expect("eof");
        serde_json::from_str(&l).unwrap()
    }
    /// Next line that is a response (skipping events).
    async fn recv_response(&mut self) -> Value {
        loop {
            let v = self.recv().await;
            if v.get("id").is_some() {
                return v;
            }
        }
    }
    async fn call(&mut self, id: i64, m: &str, params: Value) -> Value {
        self.send(&json!({"id": id, "method": m, "params": params}).to_string()).await;
        self.recv_response().await
    }
}

#[tokio::test]
async fn permissions_connect_and_status() {
    use std::os::unix::fs::PermissionsExt;
    let h = harness().await;
    let dir_mode = std::fs::metadata(h.sock.parent().unwrap()).unwrap().permissions().mode() & 0o777;
    let sock_mode = std::fs::metadata(&h.sock).unwrap().permissions().mode() & 0o777;
    assert_eq!((dir_mode, sock_mode), (0o700, 0o600));

    let mut c = Conn::open(&h.sock).await;
    // A state event arrives immediately on connect.
    let first = c.recv().await;
    assert_eq!(first, json!({"event":"state","data":{"state":"signed_out"}}));
    let r = c.call(1, "status", json!(null)).await;
    assert_eq!(r, json!({"id":1,"result":{"version":"0.1.0","state":"signed_out","pendingOps":0}}));
}

#[tokio::test]
async fn pipelined_requests_get_matching_ids() {
    let h = harness().await;
    let mut c = Conn::open(&h.sock).await;
    c.recv().await; // state
    // Send many without reading in between; responses may come in any order.
    for i in 10..30 {
        c.send(&json!({"id": i, "method": "status"}).to_string()).await;
    }
    c.send(r#"{"id":99,"method":"transfers"}"#).await;
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..21 {
        let v = c.recv_response().await;
        let id = v["id"].as_i64().unwrap();
        if id == 99 {
            assert_eq!(v["result"], json!({"transfers": []}));
        } else {
            assert_eq!(v["result"]["version"], "0.1.0");
        }
        assert!(seen.insert(id), "duplicate response for {id}");
    }
    assert_eq!(seen.len(), 21);
}

#[tokio::test]
async fn events_broadcast_to_two_clients() {
    let h = harness().await;
    let mut a = Conn::open(&h.sock).await;
    let mut b = Conn::open(&h.sock).await;
    assert_eq!(a.recv().await["event"], "state");
    assert_eq!(b.recv().await["event"], "state");
    // config.set with a dev token moves us from signed_out to idle for everyone.
    let r = a.call(1, "config.set", json!({"endpoint":"http://127.0.0.1:9","token":"dev-secret"})).await;
    assert_eq!(r, json!({"id":1,"result":{}}));
    assert_eq!(a.recv().await, json!({"event":"state","data":{"state":"idle"}}));
    assert_eq!(b.recv().await, json!({"event":"state","data":{"state":"idle"}}));
    // A late joiner sees the current state on connect.
    let mut c = Conn::open(&h.sock).await;
    assert_eq!(c.recv().await, json!({"event":"state","data":{"state":"idle"}}));
    // An engine event (as the watch task would emit) reaches everyone.
    h.engine.emit(&ulsd::protocol::Event::Change(ulsd::protocol::ChangeEvent { drive_id: "d".into(), seq: 3, paths: vec!["/x".into()] }));
    for conn in [&mut a, &mut b, &mut c] {
        assert_eq!(conn.recv().await, json!({"event":"change","data":{"driveId":"d","seq":3,"paths":["/x"]}}));
    }
}

#[tokio::test]
async fn bad_json_unknown_method_and_bad_params() {
    let h = harness().await;
    let mut c = Conn::open(&h.sock).await;
    c.recv().await;
    c.send("this is not json").await;
    let v = c.recv_response().await;
    assert_eq!(v["error"]["code"], "bad_request");
    // The connection survives, and empty lines are ignored.
    c.send("").await;
    let v = c.call(2, "nope.nothing", json!({})).await;
    assert_eq!((v["id"].as_i64(), v["error"]["code"].as_str()), (Some(2), Some("bad_request")));
    let v = c.call(3, "drive.mount", json!({})).await;
    assert_eq!(v["error"]["code"], "bad_request");
    let v = c.call(4, "drive.mount", json!({"driveId":"../../etc"})).await;
    assert_eq!(v["error"]["code"], "no_such_drive");
    let v = c.call(5, "drive.unmount", json!({"driveId":"d-x"})).await;
    assert_eq!(v["error"]["code"], "not_mounted");
    let v = c.call(6, "drives.list", json!({})).await;
    assert_eq!(v["error"]["code"], "unauthorized");
    let v = c.call(7, "status", json!({})).await;
    assert!(v["result"].is_object());
}

#[tokio::test]
async fn peer_uid_check_rejects_other_users() {
    let me = std::fs::metadata("/dev/null").map(|_| ()).ok();
    let _ = me;
    // Pretend the allowed uid is somebody else: our own connection must be dropped silently.
    let h = harness_with(Some(u32::MAX - 7)).await;
    let s = UnixStream::connect(&h.sock).await.unwrap();
    let (r, mut w) = s.into_split();
    let _ = w.write_all(b"{\"id\":1,\"method\":\"status\"}\n").await;
    let mut lines = BufReader::new(r).lines();
    let got = tokio::time::timeout(Duration::from_secs(5), lines.next_line()).await.unwrap();
    assert!(matches!(got, Ok(None) | Err(_)), "rejected peers get no data, got {got:?}");
}

#[tokio::test]
async fn stale_socket_is_replaced_and_live_one_is_not() {
    let d = tempfile::tempdir().unwrap();
    let sock = d.path().join("s").join("ulsd.sock");
    let (l, _) = server::bind(&sock).unwrap();
    assert!(server::bind(&sock).is_err(), "a live daemon's socket is not stolen");
    drop(l); // socket file remains, nobody listening
    assert!(sock.exists());
    let (_l2, _) = server::bind(&sock).unwrap();
    // Something that is not a socket is never deleted.
    let f = d.path().join("s").join("file");
    std::fs::write(&f, b"x").unwrap();
    assert!(server::bind(&f).is_err());
    assert!(f.exists());
}

fn jwt(exp: u64) -> String {
    let b = |v: Value| URL_SAFE_NO_PAD.encode(serde_json::to_vec(&v).unwrap());
    format!("{}.{}.sig", b(json!({"alg":"EdDSA"})), b(json!({"sub":"u_1","email":"a@b.c","exp":exp})))
}
fn now_s() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

#[tokio::test]
async fn auth_flow_mount_and_sign_out() {
    let api = MockServer::start().await;
    Mock::given(method("GET")).and(path("/orgs")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"orgs":[
        {"id":"o_1","name":"My Space","role":"viewer","tier":"individual","trialEndsAt":null,"drives":[
            {"id":"d-abc","orgId":"o_1","name":"Space","status":"ready","access":"read"}]}]}))).mount(&api).await;
    Mock::given(method("POST")).and(path("/drives/d-abc/token")).respond_with(ResponseTemplate::new(200).set_body_json(json!({
        "token":"dt_1","expiresAt":(now_s()+600)*1000,"endpoint":"http://127.0.0.1:1","driveId":"d-abc"}))).mount(&api).await;
    Mock::given(method("POST")).and(path("/auth/logout")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok":true}))).expect(1).mount(&api).await;

    let h = harness().await;
    let mut c = Conn::open(&h.sock).await;
    c.recv().await;
    let v = c.call(1, "auth.status", json!({})).await;
    assert_eq!(v["result"], json!({"signedIn":false}));

    let v = c.call(2, "auth.set", json!({"apiEndpoint":api.uri(),"accessToken":jwt(now_s()+900),"refreshToken":"rt_1"})).await;
    assert_eq!(v["result"], json!({"user":{"id":"u_1","email":"a@b.c"}}));
    assert_eq!(c.recv().await, json!({"event":"state","data":{"state":"idle"}}));
    let v = c.call(3, "auth.status", json!({})).await;
    assert_eq!(v["result"]["signedIn"], true);
    assert_eq!(v["result"]["user"]["email"], "a@b.c");

    let v = c.call(4, "drives.list", json!({})).await;
    assert_eq!(v["result"]["drives"], json!([{"driveId":"d-abc","name":"Space","mountState":"unmounted"}]));

    // The fake adapter does not need a reachable data plane.
    let v = c.call(5, "drive.mount", json!({"driveId":"d-abc"})).await;
    assert_eq!(v["result"], json!({}), "{v}");
    assert_eq!(*h.mounted.lock().unwrap(), vec!["d-abc".to_string()]);
    let v = c.call(6, "drive.mount", json!({"driveId":"d-abc"})).await;
    assert_eq!(v["error"]["code"], "already_mounted");
    let v = c.call(7, "drives.list", json!({})).await;
    let mp = h.dir.path().join("mnt").join("Space");
    assert_eq!(v["result"]["drives"][0]["mountState"], "mounted");
    assert_eq!(v["result"]["drives"][0]["mountPath"], mp.display().to_string());

    // The mount is remembered, but no token is in the state file.
    let state = std::fs::read_to_string(h.dir.path().join("state.json")).unwrap();
    assert!(state.contains("d-abc") && !state.contains("rt_1") && !state.contains("dt_1"));

    // The state event and the response may arrive in either order (DAEMON-PROTOCOL.md: events are unsolicited).
    c.send(&json!({"id":8,"method":"auth.signOut","params":{}}).to_string()).await;
    let (mut resp, mut signed_out) = (None, false);
    while resp.is_none() || !signed_out {
        let m = c.recv().await;
        if m.get("id").is_some() { resp = Some(m); }
        else if m == json!({"event":"state","data":{"state":"signed_out"}}) { signed_out = true; }
    }
    assert_eq!(resp.unwrap()["result"], json!({}));
    assert!(h.mounted.lock().unwrap().is_empty(), "sign-out unmounts everything");
    let v = c.call(9, "auth.status", json!({})).await;
    assert_eq!(v["result"], json!({"signedIn":false}));
    let state = std::fs::read_to_string(h.dir.path().join("state.json")).unwrap();
    assert!(!state.contains("d-abc"));
}

#[tokio::test]
async fn graceful_shutdown_unmounts_but_remembers_and_restart_restores() {
    let api = MockServer::start().await;
    Mock::given(method("GET")).and(path("/orgs")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"orgs":[
        {"id":"o_1","name":"My Space","role":"owner","tier":"individual","trialEndsAt":null,"drives":[
            {"id":"d-abc","orgId":"o_1","name":"Space","status":"ready","access":"write"}]}]}))).mount(&api).await;
    Mock::given(method("POST")).and(path("/drives/d-abc/token")).respond_with(ResponseTemplate::new(200).set_body_json(json!({
        "token":"dt_1","expiresAt":(now_s()+600)*1000,"endpoint":"http://127.0.0.1:1","driveId":"d-abc"}))).mount(&api).await;
    Mock::given(method("POST")).and(path("/auth/refresh")).respond_with(ResponseTemplate::new(200).set_body_json(json!({
        "accessToken":jwt(now_s()+900),"refreshToken":"rt_2","expiresIn":900,"user":{"id":"u_1","email":"a@b.c"},"accountCreated":false}))).expect(1).mount(&api).await;

    let dir = tempfile::tempdir().unwrap();
    let store: Arc<dyn uls_auth::SecretStore> = Arc::new(uls_auth::MemoryStore::new());
    let mounted = Arc::new(Mutex::new(Vec::new()));
    let mk = || {
        Engine::new(
            EngineConfig {
                version: "0.1.0".into(),
                state_path: dir.path().join("state.json"),
                mount_root: dir.path().join("mnt"),
                cache_dir: Some(dir.path().join("cache")),
                secrets: store.clone(),
                default_endpoint: "http://127.0.0.1:1".into(),
            },
            Arc::new(FakeAdapter { mounted: mounted.clone() }),
        )
    };
    let e1 = mk();
    e1.start().await;
    let req = |id, m: &str, p: Value| ulsd::protocol::parse_request(&json!({"id":id,"method":m,"params":p}).to_string()).unwrap();
    let r = e1.handle(req(1, "auth.set", json!({"apiEndpoint":api.uri(),"accessToken":jwt(now_s()+900),"refreshToken":"rt_1"}))).await;
    assert!(r.error.is_none(), "{r:?}");
    let r = e1.handle(req(2, "drive.mount", json!({"driveId":"d-abc"}))).await;
    assert!(r.error.is_none(), "{r:?}");
    assert_eq!(mounted.lock().unwrap().len(), 1);

    e1.shutdown().await; // what SIGTERM does
    assert!(mounted.lock().unwrap().is_empty());

    // New process: the refresh token comes back from the secret store and the mount is restored.
    let e2 = mk();
    e2.start().await;
    // Restoring reopens the journal; allow for a loaded machine (parallel test binaries).
    for _ in 0..500 {
        if !mounted.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(*mounted.lock().unwrap(), vec!["d-abc".to_string()]);
    assert_eq!(uls_auth::SecretStore::get(&*store, "u_1").unwrap().as_deref(), Some("rt_2"), "rotated token persisted after restart");
    let r = e2.handle(req(3, "auth.status", json!({}))).await;
    assert_eq!(r.result.unwrap()["signedIn"], true);
    assert_eq!(serde_json::from_str::<Value>(&e2.state_event_line()).unwrap(), json!({"event":"state","data":{"state":"idle"}}));
}
