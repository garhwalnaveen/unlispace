use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::json;
use ulsd::hub::AuthHub;
use ulsd::mount::NeedAccess;
use ulsd::protocol::AuthSetParams;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn drive_provider_refreshes_rejected_token_and_endpoint() {
    let server = MockServer::start().await;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let access = format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(json!({"sub":"u_1","email":"a@b.c","exp":now+900}).to_string()));
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    Mock::given(method("POST")).and(path("/drives/drive/token"))
        .respond_with(move |_: &wiremock::Request| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(200).set_body_json(json!({
                "token":format!("drive-{n}"), "endpoint":format!("http://127.0.0.1:{}",10000+n),
                "expiresAt":(now+900)*1000, "driveId":"drive"
            }))
        }).expect(2).mount(&server).await;
    let hub = Arc::new(AuthHub::new(Arc::new(uls_auth::MemoryStore::new()), "http://127.0.0.1:1".into()));
    hub.set(AuthSetParams { api_endpoint: server.uri(), access_token: access, refresh_token: "refresh".into() }).await.unwrap();
    let provider = hub.token_provider("drive", NeedAccess::Write);
    let first = provider.token().await.unwrap();
    assert_eq!(provider.token().await.unwrap(), first);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let second = provider.refresh().await.unwrap();
    assert_ne!(second.token, first.token);
    assert_ne!(second.endpoint, first.endpoint);
    assert_eq!(provider.token().await.unwrap(), second);
}

#[tokio::test]
async fn provider_maps_auth_failure_and_tracks_dev_credentials() {
    let hub = Arc::new(AuthHub::new(Arc::new(uls_auth::MemoryStore::new()), "http://127.0.0.1:1".into()));
    let provider = hub.token_provider("drive", NeedAccess::Read);
    assert!(matches!(provider.token().await, Err(uls_client::Error::Auth(_))));
    hub.set_dev(None, Some("one".into()));
    assert_eq!(provider.token().await.unwrap().token, "one");
    hub.set_dev(Some("http://127.0.0.1:2".into()), Some("two".into()));
    let next = provider.refresh().await.unwrap();
    assert_eq!(next.token, "two");
    assert_eq!(next.endpoint.as_deref(), Some("http://127.0.0.1:2"));
    hub.clear_dev();
    assert!(matches!(provider.refresh().await, Err(uls_client::Error::Auth(_))));
}

#[tokio::test]
async fn expired_entitlements_select_read_only_and_preserve_mounted_reads() {
    use wiremock::matchers::body_partial_json;
    let server = MockServer::start().await;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let access = format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(json!({"sub":"u_1","email":"a@b.c","exp":now+900}).to_string()));
    Mock::given(method("GET")).and(path("/orgs"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"orgs":[{"id":"o1","name":"Space","drives":[{"id":"drive","name":"Files","access":"admin"}]}]}))).mount(&server).await;
    Mock::given(method("POST")).and(path("/drives/drive/token")).and(body_partial_json(json!({"access":"write"})))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({"error":"over_quota"}))).mount(&server).await;
    Mock::given(method("POST")).and(path("/drives/drive/token")).and(body_partial_json(json!({"access":"read"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"token":"read-only","endpoint":server.uri(),"expiresAt":(now+900)*1000,"driveId":"drive"}))).mount(&server).await;
    let hub=Arc::new(AuthHub::new(Arc::new(uls_auth::MemoryStore::new()),server.uri()));
    hub.set(AuthSetParams{api_endpoint:server.uri(),access_token:access,refresh_token:"refresh".into()}).await.unwrap();
    assert_eq!(hub.mount_access("drive").await.unwrap(),NeedAccess::Read);
    let provider = hub.token_provider("drive",NeedAccess::Write);
    let token = provider.token().await.unwrap();
    assert_eq!(token.token,"read-only");
    assert!(token.read_only);
    let client = uls_client::Client::builder(server.uri(), "").token_provider(provider).build().unwrap();
    let denied = client.commit("drive", vec![uls_proto::Op::Mkdir {path:"blocked/".into()}]).await.unwrap_err();
    assert!(matches!(denied, uls_client::Error::WriteDenied));
    assert!(hub.has_session());
}

fn auth_params(api: &str, user: &str, refresh: &str, expires_in: u64) -> AuthSetParams {
    let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    AuthSetParams {api_endpoint:api.into(),access_token:format!("e30.{}.sig",URL_SAFE_NO_PAD.encode(json!({"sub":user,"email":format!("{user}@example.invalid"),"exp":now+expires_in}).to_string())),refresh_token:refresh.into()}
}

#[tokio::test]
async fn replacing_the_same_account_waits_for_old_refresh_and_retires_its_session() {
    use uls_auth::SecretStore;
    use std::time::Duration;
    let api=MockServer::start().await;
    let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    Mock::given(method("POST")).and(path("/auth/refresh"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(200)).set_body_json(json!({"accessToken":format!("e30.{}.sig",URL_SAFE_NO_PAD.encode(json!({"sub":"u_1","email":"u_1@example.invalid","exp":now+900}).to_string())),"refreshToken":"old-rotated","expiresIn":900,"user":{"id":"u_1","email":"u_1@example.invalid"}})))
        .expect(1).mount(&api).await;
    let store=Arc::new(uls_auth::MemoryStore::new());
    let hub=Arc::new(AuthHub::new(store.clone(),api.uri()));
    hub.set(auth_params(&api.uri(),"u_1","old",1)).await.unwrap();
    let old=hub.session().unwrap();
    let refreshing={let old=old.clone();tokio::spawn(async move {old.access_token().await})};
    for _ in 0..100 {
        if !api.received_requests().await.unwrap().is_empty(){break;}
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(!api.received_requests().await.unwrap().is_empty());
    hub.set(auth_params(&api.uri(),"u_1","new",900)).await.unwrap();
    refreshing.await.unwrap().unwrap();
    assert_eq!(store.get("u_1").unwrap().as_deref(),Some("new"));
    assert!(!old.is_signed_in(), "superseded session must no longer refresh or write credentials");
    assert!(matches!(old.access_token().await,Err(uls_auth::AuthError::SignedOut)));
}

#[tokio::test]
async fn switching_back_to_an_account_cannot_be_deleted_by_its_old_logout() {
    use uls_auth::SecretStore;
    use std::time::Duration;
    let api=MockServer::start().await;
    Mock::given(method("POST")).and(path("/auth/logout"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(150)))
        .expect(2).mount(&api).await;
    let store=Arc::new(uls_auth::MemoryStore::new());
    let hub=AuthHub::new(store.clone(),api.uri());
    hub.set(auth_params(&api.uri(),"u_1","first-a",900)).await.unwrap();
    hub.set(auth_params(&api.uri(),"u_2","b",900)).await.unwrap();
    hub.set(auth_params(&api.uri(),"u_1","new-a",900)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(store.get("u_1").unwrap().as_deref(),Some("new-a"));
    assert!(store.get("u_2").unwrap().is_none());
}
