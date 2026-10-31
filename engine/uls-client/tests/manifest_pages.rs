use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use uls_client::{Client, Error};
use wiremock::{Mock, MockServer, ResponseTemplate, matchers::{method, path, query_param}};

#[tokio::test]
async fn freezes_the_version_and_remembers_block_urls_from_every_page() {
    let server = MockServer::start().await;
    let a = uls_chunk::sha256_hex(b"a");
    let b = uls_chunk::sha256_hex(b"b");
    Mock::given(method("GET")).and(path("/v0/drives/demo/manifest")).and(query_param("shardCursor", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"path":"file","versionId":"v_frozen","size":2,"shards":[{"h":a,"n":1}],"nextShardCursor":1})))
        .expect(1).mount(&server).await;
    let expiry = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() + 900;
    Mock::given(method("GET")).and(path("/v0/drives/demo/manifest")).and(query_param("shardCursor", "1")).and(query_param("versionId", "v_frozen"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"path":"file","versionId":"v_frozen","size":2,"shards":[{"h":b,"n":1}],"nextShardCursor":null,"blockUrls":{b.clone():format!("{}/edge/b",server.uri())},"blockUrlsExpireAt":expiry})))
        .expect(1).mount(&server).await;
    Mock::given(method("GET")).and(path("/edge/b")).respond_with(ResponseTemplate::new(200).set_body_bytes(b"b"))
        .expect(1).mount(&server).await;
    let client = Client::builder(server.uri(), "token").build().unwrap();
    let manifest = client.manifest("demo", "file", None).await.unwrap();
    assert_eq!(manifest.shards.len(), 2);
    assert_eq!(manifest.size, 2);
    assert_eq!(&client.fetch_shard("demo", &b).await.unwrap()[..], b"b");
    assert!(server.received_requests().await.unwrap().iter().all(|r| !r.url.path().contains("/shards/")));
}

#[tokio::test]
async fn refuses_changed_identity_repeated_cursors_and_incomplete_manifests() {
    let server = MockServer::start().await;
    let hash = uls_chunk::sha256_hex(b"a");
    for second in [
        json!({"path":"other","versionId":"v_one","size":2,"shards":[{"h":hash,"n":1}]}),
        json!({"path":"file","versionId":"v_other","size":2,"shards":[{"h":hash,"n":1}]}),
        json!({"path":"file","versionId":"v_one","size":2,"shards":[{"h":hash,"n":1}],"nextShardCursor":1}),
        json!({"path":"file","versionId":"v_one","size":2,"shards":[]}),
        json!({"path":"file","versionId":"v_one","size":3,"shards":[{"h":hash,"n":1}]}),
        json!({"path":"file","versionId":"v_one","size":2,"shards":[{"h":hash,"n":0}]}),
        json!({"path":"file","versionId":"v_one","size":2,"shards":[{"h":"bad","n":1}]}),
    ] {
        server.reset().await;
        Mock::given(method("GET")).and(query_param("shardCursor", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"path":"file","versionId":"v_one","size":2,"shards":[{"h":hash,"n":1}],"nextShardCursor":1})))
            .mount(&server).await;
        Mock::given(method("GET")).and(query_param("shardCursor", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(second)).mount(&server).await;
        assert!(matches!(Client::builder(server.uri(), "token").build().unwrap().manifest("demo", "file", None).await, Err(Error::InvalidResponse(_))));
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }
    server.reset().await;
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"path":"file","versionId":"v_one","size":2,"shards":[{"h":hash,"n":1}]}))).mount(&server).await;
    assert!(matches!(Client::builder(server.uri(), "token").build().unwrap().manifest("demo", "file", None).await, Err(Error::InvalidResponse(_))));
}

#[tokio::test]
async fn accepts_legacy_flat_responses_without_a_pagination_field() {
    let server = MockServer::start().await;
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"path":"empty","versionId":"v_empty","size":0,"shards":[]}))).expect(1).mount(&server).await;
    let manifest = Client::builder(server.uri(), "token").build().unwrap().manifest("demo", "empty", Some("v_empty")).await.unwrap();
    assert!(manifest.shards.is_empty());
}
