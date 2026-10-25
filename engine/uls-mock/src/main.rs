//! `uls-mock [addr]`: serves the M0 contract from memory. Token from `ULS_DEV_TOKEN`.
#[tokio::main]
async fn main() {
    let addr = std::env::args().nth(1).unwrap_or_else(|| "127.0.0.1:8787".into());
    let token = std::env::var("ULS_DEV_TOKEN").unwrap_or_else(|_| "dev".into());
    let srv = uls_mock::MockServer::start_on(&addr, &token).await.expect("bind");
    eprintln!("uls-mock listening on {}", srv.url());
    std::future::pending::<()>().await;
}
