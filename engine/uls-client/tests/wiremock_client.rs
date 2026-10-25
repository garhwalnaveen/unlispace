//! Client behaviour against scripted responses (wiremock).

use std::io::Write;

use serde_json::json;
use uls_client::{Client, Error, RetryPolicy};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

fn client(url: &str) -> Client {
    Client::builder(url, "tok")
        .retry(RetryPolicy {
            max_attempts: 4,
            base_delay: std::time::Duration::from_millis(5),
            max_delay: std::time::Duration::from_millis(20),
        })
        .build()
        .unwrap()
}

fn temp_file(bytes: &[u8]) -> tempfile::NamedTempFile {
    let mut f = tempfile::NamedTempFile::new().unwrap();
    f.write_all(bytes).unwrap();
    f
}

#[tokio::test]
async fn precondition_failed_is_typed_with_current_version() {
    let srv = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v0/drives/demo/commit"))
        .and(header("authorization", "Bearer tok"))
        .respond_with(ResponseTemplate::new(412).set_body_json(json!({
            "error": "precondition_failed", "path": "a.txt", "currentVersionId": "v_CURRENT"
        })))
        .mount(&srv)
        .await;
    let err = client(&srv.uri())
        .commit(
            "demo",
            vec![uls_client::proto::Op::Delete { path: "a.txt".into(), if_version: Some("v_OLD".into()) }],
        )
        .await
        .unwrap_err();
    match err {
        Error::PreconditionFailed { path, current_version_id } => {
            assert_eq!(path, "a.txt");
            assert_eq!(current_version_id.as_deref(), Some("v_CURRENT"));
        }
        other => panic!("wrong error: {other:?}"),
    }
}

#[tokio::test]
async fn precondition_failed_with_null_current_version() {
    let srv = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v0/drives/demo/commit"))
        .respond_with(ResponseTemplate::new(412).set_body_json(json!({
            "error": "precondition_failed", "path": "a.txt", "currentVersionId": null
        })))
        .mount(&srv)
        .await;
    let f = temp_file(b"hello");
    // The upload needs /missing and the shard PUT before it reaches the commit.
    Mock::given(method("POST")).and(path("/v0/drives/demo/shards/missing"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"missing": []})))
        .mount(&srv).await;
    let err = client(&srv.uri()).upload_file("demo", f.path(), "a.txt", Some("v_X")).await.unwrap_err();
    assert!(matches!(err, Error::PreconditionFailed { current_version_id: None, .. }), "{err:?}");
}

#[tokio::test]
async fn unauthorized_and_not_found_are_typed() {
    let srv = MockServer::start().await;
    Mock::given(method("GET")).and(path("/v0/drives/demo/stat"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error":"unauthorized"})))
        .mount(&srv).await;
    Mock::given(method("GET")).and(path("/v0/drives/demo/manifest"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error":"no_such_path"})))
        .mount(&srv).await;
    let c = client(&srv.uri());
    assert!(matches!(c.stat("demo", "a").await.unwrap_err(), Error::Unauthorized));
    assert!(matches!(c.manifest("demo", "a", None).await.unwrap_err(), Error::NotFound { code } if code == "no_such_path"));
}

/// Fails the first commit with missing_shards, then succeeds.
struct FlakyCommit(std::sync::atomic::AtomicUsize, String);
impl Respond for FlakyCommit {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            ResponseTemplate::new(409)
                .set_body_json(json!({"error":"missing_shards","hashes":[self.1.clone()]}))
        } else {
            ResponseTemplate::new(200).set_body_json(json!({
                "seq": 1, "results": [{"path":"a.txt","versionId":"v_1","size":5}]
            }))
        }
    }
}

#[tokio::test]
async fn missing_shards_on_commit_triggers_reupload_then_retry() {
    let srv = MockServer::start().await;
    let hash = uls_chunk::sha256_hex(b"hello");
    // /missing claims the server already has it (stale shards_known), so only the commit
    // rejection can reveal the truth.
    Mock::given(method("POST")).and(path("/v0/drives/demo/shards/missing"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"missing": []})))
        .mount(&srv).await;
    let put = Mock::given(method("PUT")).and(path(format!("/v0/drives/demo/shards/{hash}")))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({"hash":hash,"size":5,"stored":true})))
        .expect(1)
        .mount_as_scoped(&srv).await;
    Mock::given(method("POST")).and(path("/v0/drives/demo/commit"))
        .respond_with(FlakyCommit(Default::default(), hash.clone()))
        .expect(2)
        .mount(&srv).await;

    let f = temp_file(b"hello");
    let rep = client(&srv.uri()).upload_file("demo", f.path(), "a.txt", None).await.unwrap();
    assert_eq!(rep.shards_uploaded, 1);
    assert_eq!(rep.version_id, "v_1");
    drop(put); // verifies expect(1)
}

/// 503 twice, then 201.
struct FlakyPut(std::sync::atomic::AtomicUsize, String);
impl Respond for FlakyPut {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2 {
            ResponseTemplate::new(503).set_body_json(json!({"error":"unavailable"}))
        } else {
            ResponseTemplate::new(201).set_body_json(json!({"hash":self.1.clone(),"size":5,"stored":true}))
        }
    }
}

#[tokio::test]
async fn shard_put_retries_with_backoff_on_5xx() {
    let srv = MockServer::start().await;
    let hash = uls_chunk::sha256_hex(b"hello");
    Mock::given(method("POST")).and(path("/v0/drives/demo/shards/missing"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"missing":[hash.clone()]})))
        .mount(&srv).await;
    Mock::given(method("PUT")).and(path(format!("/v0/drives/demo/shards/{hash}")))
        .respond_with(FlakyPut(Default::default(), hash.clone()))
        .expect(3)
        .mount(&srv).await;
    Mock::given(method("POST")).and(path("/v0/drives/demo/commit"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "seq": 1, "results": [{"path":"a.txt","versionId":"v_1","size":5}]})))
        .mount(&srv).await;
    let f = temp_file(b"hello");
    let rep = client(&srv.uri()).upload_file("demo", f.path(), "a.txt", None).await.unwrap();
    assert_eq!(rep.shards_uploaded, 1);
}

#[tokio::test]
async fn does_not_retry_client_errors() {
    let srv = MockServer::start().await;
    Mock::given(method("GET")).and(path("/v0/drives/demo"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error":"no_such_drive"})))
        .expect(1)
        .mount(&srv).await;
    let err = client(&srv.uri()).drive_info("demo").await.unwrap_err();
    assert!(matches!(err, Error::NotFound { .. }));
}

#[tokio::test]
async fn corrupt_shard_from_server_is_rejected() {
    let srv = MockServer::start().await;
    let hash = uls_chunk::sha256_hex(b"expected");
    Mock::given(method("GET")).and(path(format!("/v0/drives/demo/shards/{hash}")))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"tampered".to_vec()))
        .mount(&srv).await;
    let err = client(&srv.uri()).fetch_shard("demo", &hash).await.unwrap_err();
    assert!(matches!(err, Error::HashMismatch { .. }), "{err:?}");
}

#[tokio::test]
async fn token_never_appears_in_debug_output() {
    let c = Client::builder("http://x", "super-secret-token").build().unwrap();
    assert!(!format!("{c:?}").contains("super-secret-token"));
}
