//! Runs requests that carry tokens with the most verbose logging on and checks no token value is
//! ever written to the log, a response, or an event.

use std::io;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tracing_subscriber::fmt::MakeWriter;
use ulsd::engine::{Engine, EngineConfig};
use ulsd::mount::{MountAdapter, MountError, MountHandle, MountRequest, NeedAccess};
use ulsd::protocol::parse_request;

#[derive(Clone, Default)]
struct Buf(Arc<Mutex<Vec<u8>>>);
impl io::Write for Buf {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl<'a> MakeWriter<'a> for Buf {
    type Writer = Buf;
    fn make_writer(&'a self) -> Buf {
        self.clone()
    }
}

struct Nop;
#[async_trait::async_trait]
impl MountAdapter for Nop {
    fn access(&self) -> NeedAccess {
        NeedAccess::Read
    }
    async fn mount(&self, _: MountRequest) -> Result<Arc<dyn MountHandle>, MountError> {
        Err(MountError(ulsd::protocol::ErrorBody::internal("not in this test")))
    }
}

const SECRETS: [&str; 4] = ["ACCESS-SECRET-aaa", "REFRESH-SECRET-bbb", "DEVTOKEN-SECRET-ccc", "BADTYPE-SECRET-ddd"];

#[tokio::test]
async fn no_tokens_in_logs_responses_or_events() {
    let buf = Buf::default();
    let sub = tracing_subscriber::fmt().with_max_level(tracing::Level::TRACE).with_ansi(false).with_writer(buf.clone()).finish();
    // Thread-local default + current-thread runtime: every task below logs into `buf`.
    let _g = tracing::subscriber::set_default(sub);

    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::new(
        EngineConfig {
            version: "0.1.0".into(),
            state_path: dir.path().join("state.json"),
            mount_root: dir.path().join("mnt"),
            cache_dir: Some(dir.path().join("cache")),
            secrets: Arc::new(uls_auth::MemoryStore::new()),
            default_endpoint: "http://127.0.0.1:1".into(),
        },
        Arc::new(Nop),
    );
    let mut ev = engine.subscribe();
    engine.start().await;

    let mut wire = String::new();
    let call = |id: i64, m: &str, p: Value| parse_request(&json!({"id": id, "method": m, "params": p}).to_string()).unwrap();
    // auth.set fails (nothing listens at port 1) -- the error path must not echo the tokens.
    for (i, r) in [
        call(1, "auth.set", json!({"apiEndpoint":"http://127.0.0.1:1","accessToken":SECRETS[0],"refreshToken":SECRETS[1]})),
        call(2, "config.set", json!({"endpoint":"http://127.0.0.1:1","token":SECRETS[2]})),
        call(3, "config.set", json!({"token":5, "cacheCapBytes": SECRETS[3]})),
        call(4, "auth.set", json!({"apiEndpoint": 5, "accessToken":SECRETS[0], "refreshToken":SECRETS[1]})),
        call(5, "drive.mount", json!({"driveId":"d-abc"})),
        call(6, "auth.signOut", json!({})),
    ]
    .into_iter()
    .enumerate()
    {
        let resp = engine.handle(r).await;
        wire.push_str(&resp.to_line());
        assert_eq!(resp.id, i as i64 + 1);
    }
    while let Ok(l) = ev.try_recv() {
        wire.push_str(&l);
    }
    let logs = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
    assert!(!logs.is_empty(), "the test must actually capture logs");
    assert!(logs.contains("request"), "request logging is on, so the check is meaningful");
    for s in SECRETS {
        assert!(!logs.contains(s), "token leaked into logs: {s}\n{logs}");
        assert!(!wire.contains(s), "token leaked into a response or event: {s}\n{wire}");
    }
    // Debug-printing the param types is also safe.
    let r = call(7, "auth.set", json!({"apiEndpoint":"http://x","accessToken":SECRETS[0],"refreshToken":SECRETS[1]}));
    let p: ulsd::protocol::AuthSetParams = ulsd::protocol::parse_params(&r).unwrap();
    assert!(!format!("{p:?} {r:?}").contains("SECRET"));
}
