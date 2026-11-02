//! Upload phases, upload bandwidth config, plan capacity, readiness route and offline handling.
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use uls_client::Client;
use ulsd::engine::{Engine, EngineConfig, allowed_api_request, capacities_in_orgs};
use ulsd::mount::{MountAdapter, MountError, MountHandle, MountRequest, NeedAccess};
use ulsd::protocol::{Response, parse_request};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer as Wire, ResponseTemplate};

struct Handle;
#[async_trait]
impl MountHandle for Handle { async fn unmount(&self) -> Result<(), MountError> { Ok(()) } }
#[derive(Default, Clone)]
struct Adapter { mounted: Arc<Mutex<Vec<String>>> }
#[async_trait]
impl MountAdapter for Adapter {
    fn access(&self) -> NeedAccess { NeedAccess::Read }
    async fn mount(&self, req: MountRequest) -> Result<Arc<dyn MountHandle>, MountError> {
        self.mounted.lock().unwrap().push(req.drive_id);
        Ok(Arc::new(Handle))
    }
}

async fn raw(e: &Arc<Engine>, method: &str, params: Value) -> Response {
    e.handle(parse_request(&json!({"id":1,"method":method,"params":params}).to_string()).unwrap()).await
}
async fn call(e: &Arc<Engine>, method: &str, params: Value) -> Value {
    let r = raw(e, method, params).await;
    assert!(r.error.is_none(), "{r:?}");
    r.result.unwrap()
}
fn config(dir: &std::path::Path, endpoint: String) -> EngineConfig {
    EngineConfig { version: "test".into(), state_path: dir.join("state.json"), mount_root: dir.join("mnt"),
        cache_dir: Some(dir.join("cache")), secrets: Arc::new(uls_auth::MemoryStore::new()), default_endpoint: endpoint }
}

#[tokio::test]
async fn uploads_report_phase_bytes_and_a_done_event_per_file() {
    let server = uls_mock::MockServer::start("local").await;
    Client::builder(server.url(), "local").build().unwrap().create_drive("drive", None).await.unwrap();
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let e = Engine::new(config(dir.path(), server.url()), Arc::new(Adapter::default()));
    call(&e, "config.set", json!({"token":"local"})).await;
    let mut events = e.subscribe();
    let local = dir.path().join("f.bin");
    std::fs::write(&local, vec![7u8; 1234]).unwrap();
    call(&e, "upload.queue", json!({"driveId":"drive","files":[{"local":local,"path":"f.bin"}]})).await;
    let up = call(&e, "uploads", json!({})).await;
    let item = up["pending"].as_array().unwrap().iter().find(|p| p["path"] == "/f.bin").expect("pending item").clone();
    assert_eq!(item["driveId"], "drive");
    assert_eq!(item["bytes"], 1234);
    assert_eq!(item["bytesTotal"], 1234);
    assert_eq!(item["bytesSent"], 0);
    assert_eq!(item["phase"], "saved_locally");
    assert!(up["journalBytes"].is_u64() && up["journalCapBytes"].is_u64());
    // The publisher commits after the quiet window; the commit must announce the file as done.
    let mut saw = false;
    let _ = tokio::time::timeout(Duration::from_secs(20), async {
        while let Ok(line) = events.recv().await {
            let ev: Value = serde_json::from_str(&line).unwrap();
            if ev["event"] == "transfer" && ev["data"]["path"] == "/f.bin" && ev["data"]["status"] == "done" {
                assert_eq!(ev["data"]["direction"], "upload");
                assert_eq!(ev["data"]["bytesDone"], 1234);
                saw = true;
                break;
            }
        }
    }).await;
    e.shutdown().await;
    assert!(saw, "no per-file done transfer event");
}

#[tokio::test]
async fn upload_bandwidth_is_validated_persisted_and_reported() {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let e = Engine::new(config(dir.path(), "http://127.0.0.1:1".into()), Arc::new(Adapter::default()));
    assert_eq!(call(&e, "status", json!({})).await["uploadBandwidthBps"], 0);
    call(&e, "config.set", json!({"uploadBandwidthBps": 2_000_000})).await;
    assert_eq!(call(&e, "status", json!({})).await["uploadBandwidthBps"], 2_000_000);
    for bad in [json!(-1), json!("fast"), json!(1.5), json!(null_free_big()), json!(true)] {
        let r = raw(&e, "config.set", json!({"uploadBandwidthBps": bad})).await;
        assert_eq!(r.error.expect("error").code, "bad_request");
    }
    assert_eq!(call(&e, "status", json!({})).await["uploadBandwidthBps"], 2_000_000, "invalid values change nothing");
    let state: Value = serde_json::from_slice(&std::fs::read(dir.path().join("state.json")).unwrap()).unwrap();
    assert_eq!(state["uploadBandwidthBps"], 2_000_000);
    // A restarted daemon applies the persisted limit.
    let e2 = Engine::new(config(dir.path(), "http://127.0.0.1:1".into()), Arc::new(Adapter::default()));
    assert_eq!(call(&e2, "status", json!({})).await["uploadBandwidthBps"], 2_000_000);
    call(&e2, "config.set", json!({"uploadBandwidthBps": 0})).await;
    assert_eq!(call(&e2, "status", json!({})).await["uploadBandwidthBps"], 0);
}
fn null_free_big() -> u64 { 2_000_000_000_000 }

#[test]
fn readiness_route_is_allowed_get_only() {
    assert!(allowed_api_request("GET", "/me/access"));
    for m in ["POST", "PUT", "DELETE", "PATCH"] { assert!(!allowed_api_request(m, "/me/access")); }
    assert!(!allowed_api_request("GET", "/me"));
    assert!(!allowed_api_request("GET", "/me/access/x"));
}

#[test]
fn web_handoff_route_is_allowed_post_only() {
    assert!(allowed_api_request("POST", "/auth/web-handoff"));
    assert!(!allowed_api_request("GET", "/auth/web-handoff"));
    assert!(!allowed_api_request("POST", "/auth/refresh"));
    assert!(!allowed_api_request("POST", "/auth/handoff/exchange"));
    assert!(allowed_api_request("GET", "/ai/models"));
    assert!(!allowed_api_request("POST", "/ai/chat"));
}

#[test]
fn plan_capacity_is_read_per_drive_from_orgs() {
    let orgs = json!({"orgs":[
        {"id":"o1","quotaBytes":1000,"usedBytes":250,"drives":[{"id":"d1"},{"id":"d2"}]},
        {"id":"o2","drives":[{"id":"d3"}]},
        {"id":"o3","quotaBytes":5,"usedBytes":9,"drives":[{"id":"d4"}]}]});
    let m = capacities_in_orgs(&orgs);
    assert_eq!(m.get("d1"), Some(&(1000, 250)));
    assert_eq!(m.get("d2"), Some(&(1000, 250)));
    assert_eq!(m.get("d3"), None);
    assert_eq!(m.get("d4"), Some(&(5, 9)));
}

#[tokio::test]
async fn offline_session_keeps_mounts_and_recovers_without_signing_out() {
    let mock = uls_mock::MockServer::start("local").await;
    Client::builder(mock.url(), "local").build().unwrap().create_drive("drive", None).await.unwrap();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let fresh = format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(json!({"sub":"u_1","email":"a@b.c","exp":now+900}).to_string()));
    let api = Wire::start().await;
    // `/orgs` is unreachable for one whole call (first attempt plus every retry), then recovers.
    Mock::given(method("GET")).and(path("/orgs")).respond_with(ResponseTemplate::new(503)).up_to_n_times(4).with_priority(1).mount(&api).await;
    Mock::given(method("GET")).and(path("/orgs")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"orgs":[
        {"id":"o1","name":"Acme","quotaBytes":1000,"usedBytes":10,"drives":[{"id":"drive","name":"Demo","orgId":"o1"}]}]}))).with_priority(2).mount(&api).await;
    Mock::given(method("POST")).and(path("/drives/drive/token")).respond_with(ResponseTemplate::new(200).set_body_json(json!({
        "token":"local","endpoint":mock.url(),"expiresAt":(now+900)*1000,"driveId":"drive"}))).mount(&api).await;

    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let adapter = Adapter::default();
    let e = Engine::new(config(dir.path(), mock.url()), Arc::new(adapter.clone()));
    let r = raw(&e, "auth.set", json!({"apiEndpoint":api.uri(),"accessToken":fresh,"refreshToken":"r1"})).await;
    assert!(r.error.is_none(), "{r:?}");
    let mut events = e.subscribe();

    let first = raw(&e, "drives.list", json!({})).await;
    assert_eq!(first.error.expect("offline error").code, "offline");
    assert_eq!(call(&e, "status", json!({})).await["state"], "offline");
    assert_eq!(call(&e, "auth.status", json!({})).await["signedIn"], true, "transient failure must not sign out");

    // The next call succeeds: back to idle, mount works, nothing was torn down.
    let listed = call(&e, "drives.list", json!({})).await;
    assert_eq!(listed["drives"][0]["driveId"], "drive");
    assert_eq!(call(&e, "status", json!({})).await["state"], "idle");
    call(&e, "drive.mount", json!({"driveId":"drive"})).await;
    assert_eq!(adapter.mounted.lock().unwrap().len(), 1);

    let mut states = vec![];
    while let Ok(line) = events.try_recv() {
        let ev: Value = serde_json::from_str(&line).unwrap();
        if ev["event"] == "state" { states.push(ev["data"]["state"].as_str().unwrap().to_string()); }
    }
    assert!(!states.contains(&"signed_out".to_string()), "{states:?}");
    assert!(states.iter().position(|s| s == "offline") < states.iter().rposition(|s| s == "idle"), "{states:?}");
    let _ = Duration::ZERO;
    e.shutdown().await;
}
