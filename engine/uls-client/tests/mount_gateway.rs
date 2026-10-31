//! Run by the local HTTP SDK fixture to check the Rust signer against the real gateway.
use uls_client::{AccessKeyTokenProvider, TokenProvider};

#[tokio::test]
#[ignore = "requires the local gateway fixture and ULS_TEST_* credentials"]
async fn mount_provider_authenticates_against_gateway_and_renews() {
    let endpoint = std::env::var("ULS_TEST_ENDPOINT").expect("local fixture endpoint");
    let id = std::env::var("ULS_TEST_ACCESS_KEY").expect("local fixture key");
    let secret = std::env::var("ULS_TEST_SECRET").expect("local fixture secret");
    let drive = std::env::var("ULS_TEST_DRIVE").expect("local fixture drive");
    let provider = AccessKeyTokenProvider::new(&endpoint, &drive, id, secret).unwrap();
    let grant = provider.grant().await.expect("SigV4 mount exchange");
    assert_eq!(grant.drive_id, drive);
    let token = provider.token().await.unwrap();
    assert_eq!(token.read_only, !grant.can_write);
    assert_eq!(token.endpoint.as_deref(), Some(grant.endpoint.as_str()));
    let renewed = provider.refresh().await.expect("fresh SigV4 mount exchange");
    assert_eq!(renewed.read_only, token.read_only);
    assert_eq!(provider.grant().await.unwrap().drive_id, drive);
    let read_id = std::env::var("ULS_TEST_READ_ACCESS_KEY").expect("local fixture read key");
    let read_secret = std::env::var("ULS_TEST_READ_SECRET").expect("local fixture read secret");
    let read_provider = AccessKeyTokenProvider::new(&endpoint, &drive, read_id, read_secret).unwrap();
    assert!(!read_provider.grant().await.unwrap().can_write);
    assert!(read_provider.token().await.unwrap().read_only);
    assert!(read_provider.refresh().await.unwrap().read_only);
}
