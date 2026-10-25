use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use uls_auth::{Access, AuthError, AuthEvent, MemoryStore, SecretStore, Session, SessionTokens, User};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

fn now_s() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

fn jwt(exp: u64) -> String {
    let b = |v: Value| URL_SAFE_NO_PAD.encode(serde_json::to_vec(&v).unwrap());
    format!("{}.{}.sig", b(json!({"alg":"EdDSA"})), b(json!({"sub":"u_1","email":"a@b.c","exp":exp})))
}

fn user() -> User {
    User { id: "u_1".into(), email: "a@b.c".into() }
}

fn tokens(access: String, refresh: &str) -> SessionTokens {
    serde_json::from_value(json!({"accessToken":access,"refreshToken":refresh,"expiresIn":900,"user":{"id":"u_1","email":"a@b.c"},"accountCreated":false})).unwrap()
}

fn session_json(access: &str, refresh: &str) -> Value {
    json!({"accessToken":access,"refreshToken":refresh,"expiresIn":900,"user":{"id":"u_1","email":"a@b.c"},"accountCreated":false})
}

/// Each refresh returns rt_{n+1}, and checks the caller presented the previous one.
struct Rotating(AtomicUsize);
impl Respond for Rotating {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        let body: Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["refreshToken"], format!("rt_{n}"), "rotation order");
        std::thread::sleep(std::time::Duration::from_millis(50)); // widen the race window
        ResponseTemplate::new(200).set_body_json(session_json(&jwt(now_s() + 900), &format!("rt_{}", n + 1)))
    }
}

#[tokio::test]
async fn single_flight_refresh_under_20_callers_and_rotation_persisted() {
    let srv = MockServer::start().await;
    let calls = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST")).and(path("/auth/refresh")).respond_with(Rotating(AtomicUsize::new(0))).mount(&srv).await;
    let _ = &calls;

    let store = Arc::new(MemoryStore::new());
    store.set("u_1", "rt_0").unwrap();
    let (s, found) = Session::restore(srv.uri(), user(), store.clone()).unwrap();
    assert!(found);
    let s = Arc::new(s);
    let hs: Vec<_> = (0..20).map(|_| { let s = s.clone(); tokio::spawn(async move { s.access_token().await.unwrap() }) }).collect();
    let mut toks = Vec::new();
    for h in hs { toks.push(h.await.unwrap()); }
    assert!(toks.windows(2).all(|w| w[0] == w[1]), "all callers get the same token");
    assert_eq!(srv.received_requests().await.unwrap().len(), 1, "exactly one refresh");
    assert_eq!(store.get("u_1").unwrap().as_deref(), Some("rt_1"), "rotated token persisted");
    // Cached afterwards.
    s.access_token().await.unwrap();
    assert_eq!(srv.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn near_expiry_token_refreshes_proactively() {
    let srv = MockServer::start().await;
    Mock::given(method("POST")).and(path("/auth/refresh"))
        .respond_with(ResponseTemplate::new(200).set_body_json(session_json(&jwt(now_s() + 900), "rt_2")))
        .expect(1).mount(&srv).await;
    let store = Arc::new(MemoryStore::new());
    let s = Session::new(srv.uri(), store.clone()).unwrap();
    // 30 s left: inside the 60 s margin.
    s.sign_in(tokens(jwt(now_s() + 30), "rt_1")).unwrap();
    let t = s.access_token().await.unwrap();
    assert_ne!(t, jwt(now_s() + 30));
    assert_eq!(store.get("u_1").unwrap().as_deref(), Some("rt_2"));
}

#[tokio::test]
async fn fresh_token_does_not_hit_network() {
    let srv = MockServer::start().await;
    let s = Session::new(srv.uri(), Arc::new(MemoryStore::new())).unwrap();
    let a = jwt(now_s() + 600);
    s.sign_in(tokens(a.clone(), "rt_1")).unwrap();
    assert_eq!(s.access_token().await.unwrap(), a);
    assert!(srv.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn invalid_refresh_clears_everything() {
    let srv = MockServer::start().await;
    Mock::given(method("POST")).and(path("/auth/refresh"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error":"invalid_refresh"})))
        .mount(&srv).await;
    let store = Arc::new(MemoryStore::new());
    let s = Session::new(srv.uri(), store.clone()).unwrap();
    s.sign_in(tokens(jwt(now_s() + 10), "rt_1")).unwrap();
    let mut ev = s.subscribe();
    assert!(matches!(s.access_token().await, Err(AuthError::SignedOut)));
    assert_eq!(ev.recv().await.unwrap(), AuthEvent::SignedOut);
    assert!(!s.is_signed_in());
    assert!(s.user().is_none());
    assert_eq!(store.get("u_1").unwrap(), None);
    assert!(matches!(s.access_token().await, Err(AuthError::SignedOut)));
}

#[tokio::test]
async fn transient_refresh_failure_keeps_session() {
    let srv = MockServer::start().await;
    Mock::given(method("POST")).and(path("/auth/refresh")).respond_with(ResponseTemplate::new(503)).mount(&srv).await;
    let store = Arc::new(MemoryStore::new());
    let s = Session::new(srv.uri(), store.clone()).unwrap();
    s.sign_in(tokens(jwt(now_s() + 10), "rt_1")).unwrap();
    assert!(matches!(s.access_token().await, Err(AuthError::Api { status: 503, .. })));
    assert!(s.is_signed_in());
    assert_eq!(store.get("u_1").unwrap().as_deref(), Some("rt_1"));
}

#[tokio::test]
async fn drive_token_cached_until_60s_before_expiry() {
    let srv = MockServer::start().await;
    let access = jwt(now_s() + 3600);
    let n = Arc::new(AtomicUsize::new(0));
    struct Mint(Arc<AtomicUsize>);
    impl Respond for Mint {
        fn respond(&self, req: &Request) -> ResponseTemplate {
            let i = self.0.fetch_add(1, Ordering::SeqCst);
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            assert_eq!(body, json!({"access":"write"}));
            // 1st token: inside the margin (expires in 30 s) so it must not be reused. Later ones last 10 min.
            let ttl_ms = if i == 0 { 30_000 } else { 600_000 };
            let exp = (now_s() * 1000) + ttl_ms;
            ResponseTemplate::new(200).set_body_json(json!({"token":format!("dt_{i}"),"expiresAt":exp,"endpoint":"http://data","driveId":"d-abc"}))
        }
    }
    Mock::given(method("POST")).and(path("/drives/d-abc/token")).and(header("authorization", format!("Bearer {access}").as_str()))
        .respond_with(Mint(n.clone())).mount(&srv).await;
    let s = Session::new(srv.uri(), Arc::new(MemoryStore::new())).unwrap();
    s.sign_in(tokens(access, "rt_1")).unwrap();

    assert_eq!(s.drive_token("d-abc", Access::Write).await.unwrap().token, "dt_0");
    assert_eq!(s.drive_token("d-abc", Access::Write).await.unwrap().token, "dt_1", "30 s left is re-minted");
    assert_eq!(s.drive_token("d-abc", Access::Write).await.unwrap().token, "dt_1", "cached");
    assert_eq!(n.load(Ordering::SeqCst), 2);
    assert!(matches!(s.drive_token("../x", Access::Read).await, Err(AuthError::BadRequest(_))));
}

#[tokio::test]
async fn orgs_parse_and_401_retries_after_forced_refresh() {
    let srv = MockServer::start().await;
    let old = jwt(now_s() + 3600);
    let new = jwt(now_s() + 7200);
    Mock::given(method("GET")).and(path("/orgs")).and(header("authorization", format!("Bearer {old}").as_str()))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error":"unauthorized"}))).mount(&srv).await;
    Mock::given(method("GET")).and(path("/orgs")).and(header("authorization", format!("Bearer {new}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"orgs":[{"id":"o_1","name":"My Space","role":"owner","tier":"individual","trialEndsAt":null,
            "drives":[{"id":"d-abc","orgId":"o_1","name":"Space","placement":null,"status":"ready","createdAt":1,"access":"write"}]}]})))
        .mount(&srv).await;
    Mock::given(method("POST")).and(path("/auth/refresh")).respond_with(ResponseTemplate::new(200).set_body_json(session_json(&new, "rt_2"))).expect(1).mount(&srv).await;
    let s = Session::new(srv.uri(), Arc::new(MemoryStore::new())).unwrap();
    s.sign_in(tokens(old, "rt_1")).unwrap();
    let orgs = s.orgs().await.unwrap();
    assert_eq!(orgs[0].drives[0].name, "Space");
    assert_eq!(orgs[0].drives[0].access, Some(Access::Write));
}

#[tokio::test]
async fn sign_out_calls_logout_and_wipes_store() {
    let srv = MockServer::start().await;
    Mock::given(method("POST")).and(path("/auth/logout")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok":true}))).expect(1).mount(&srv).await;
    let store = Arc::new(MemoryStore::new());
    let s = Session::new(srv.uri(), store.clone()).unwrap();
    s.sign_in(tokens(jwt(now_s() + 900), "rt_1")).unwrap();
    assert_eq!(store.get("u_1").unwrap().as_deref(), Some("rt_1"));
    s.sign_out().await.unwrap();
    assert_eq!(store.get("u_1").unwrap(), None);
    assert!(!s.is_signed_in());
    let body: Value = serde_json::from_slice(&srv.received_requests().await.unwrap()[0].body).unwrap();
    assert_eq!(body, json!({"refreshToken":"rt_1"}));
}

#[tokio::test]
async fn sign_in_with_tokens_reads_user_from_claims() {
    let srv = MockServer::start().await;
    let store = Arc::new(MemoryStore::new());
    let s = Session::new("http://unused", store.clone()).unwrap();
    let u = s.sign_in_with_tokens(&srv.uri(), jwt(now_s() + 900), "rt_9".into()).await.unwrap();
    assert_eq!(u, user());
    assert_eq!(s.api_endpoint(), srv.uri());
    assert_eq!(store.get("u_1").unwrap().as_deref(), Some("rt_9"));
    assert!(srv.received_requests().await.unwrap().is_empty());
    assert!(s.sign_in_with_tokens("ftp://x", "a".into(), "b".into()).await.is_err());
}

#[test]
fn debug_output_redacts_tokens() {
    let t = tokens("ACCESS-SECRET".into(), "REFRESH-SECRET");
    let d = format!("{t:?}");
    assert!(!d.contains("SECRET"));
    let s = Session::new("http://x", Arc::new(MemoryStore::new())).unwrap();
    s.sign_in(t).unwrap();
    assert!(!format!("{s:?}").contains("SECRET"));
}

/// Real Keychain round trip. Writing a generic password item in the login keychain from an
/// unsigned test binary can raise a user-approval prompt, so this is opt-in:
/// `cargo test -p uls-auth -- --ignored keychain`
#[cfg(target_os = "macos")]
#[test]
#[ignore = "touches the real login Keychain; may prompt the user"]
fn keychain_round_trip() {
    use uls_auth::KeychainStore;
    let k = KeychainStore::with_service("com.unlispace.ulsd.test");
    let acct = format!("test-{}", now_s());
    assert_eq!(k.get(&acct).unwrap(), None);
    k.set(&acct, "one").unwrap();
    k.set(&acct, "two").unwrap();
    assert_eq!(k.get(&acct).unwrap().as_deref(), Some("two"));
    k.delete(&acct).unwrap();
    k.delete(&acct).unwrap();
    assert_eq!(k.get(&acct).unwrap(), None);
}

#[tokio::test]
async fn orgs_accepts_viewer_role() {
    let srv = MockServer::start().await;
    Mock::given(method("GET")).and(path("/orgs"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"orgs":[{"id":"o_2","name":"Team","role":"viewer","tier":"teams","trialEndsAt":123,
            "drives":[{"id":"d-xyz","orgId":"o_2","name":"Shared","status":"ready","access":"read","somethingNew":1}]}]})))
        .mount(&srv).await;
    let s = Session::new(srv.uri(), Arc::new(MemoryStore::new())).unwrap();
    s.sign_in(tokens(jwt(now_s() + 3600), "rt_1")).unwrap();
    let orgs = s.orgs().await.unwrap();
    assert_eq!(orgs[0].role.as_deref(), Some("viewer"));
    assert_eq!(orgs[0].drives[0].access, Some(Access::Read));
}
