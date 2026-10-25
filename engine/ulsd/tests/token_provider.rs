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
