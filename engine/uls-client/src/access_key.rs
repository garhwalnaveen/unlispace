//! A drive-scoped S3 key can mount through the native protocol without a login session.
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use ring::{digest, hmac};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::{Error, ProviderToken, Result, TokenProvider};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MountGrant {
    pub drive_id: String,
    pub can_write: bool,
    pub endpoint: String,
    pub expires_at: u64,
    token: String,
}

/// Secrets and grants deliberately do not implement Debug.
pub struct AccessKeyTokenProvider {
    http: reqwest::Client,
    url: reqwest::Url,
    access_key_id: String,
    secret: String,
    cached: Mutex<Option<MountGrant>>,
}

impl AccessKeyTokenProvider {
    pub fn new(endpoint: &str, bucket: &str, access_key_id: String, secret: String) -> Result<Arc<Self>> {
        if bucket.is_empty() || !bucket.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') || access_key_id.is_empty() || secret.is_empty() {
            return Err(Error::Auth("S3 endpoint, bucket and credentials are required".into()));
        }
        let mut url = reqwest::Url::parse(endpoint).map_err(|_| Error::Auth("invalid S3 endpoint".into()))?;
        validate_endpoint(&url)?;
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || !matches!(url.path(), "" | "/") {
            return Err(Error::Auth("S3 endpoint must be an origin without credentials".into()));
        }
        url.set_path(&format!("/{bucket}"));
        url.set_query(Some("x-uls-mount="));
        let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(30)).build()?;
        Ok(Arc::new(Self { http, url, access_key_id, secret, cached: Mutex::new(None) }))
    }

    pub async fn grant(&self) -> Result<MountGrant> { self.exchange(false).await }

    async fn exchange(&self, force: bool) -> Result<MountGrant> {
        let mut cached = self.cached.lock().await;
        let now = SystemTime::now();
        let now_ms = now.duration_since(UNIX_EPOCH).map_err(|_| Error::Auth("invalid system clock".into()))?.as_millis() as u64;
        if !force && let Some(grant) = cached.as_ref() && grant.expires_at > now_ms + 30_000 { return Ok(grant.clone()); }
        let stamp = timestamp(now);
        let hash = sha256(b"");
        let host = self.url.authority();
        let headers = format!("host:{host}\nx-amz-content-sha256:{hash}\nx-amz-date:{stamp}\n");
        let names = "host;x-amz-content-sha256;x-amz-date";
        let canonical = format!("GET\n{}\nx-uls-mount=\n{headers}\n{names}\n{hash}", self.url.path());
        let scope = format!("{}/auto/s3/aws4_request", &stamp[..8]);
        let key = sign(&sign(&sign(&sign(format!("AWS4{}", self.secret).as_bytes(), &stamp[..8]), "auto"), "s3"), "aws4_request");
        let signature = hex(&sign(&key, &format!("AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{}", sha256(canonical.as_bytes()))));
        let mut response = self.http.get(self.url.clone())
            .header("x-amz-date", stamp)
            .header("x-amz-content-sha256", hash)
            .header("authorization", format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={names}, Signature={signature}", self.access_key_id))
            .send().await?;
        if !response.status().is_success() { return Err(Error::Auth(format!("mount credential exchange refused ({})", response.status().as_u16()))); }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if body.len() + chunk.len() > 64 * 1024 { return Err(Error::Auth("mount credential response is too large".into())); }
            body.extend_from_slice(&chunk);
        }
        let grant: MountGrant = serde_json::from_slice(&body).map_err(|_| Error::Auth("invalid mount credential response".into()))?;
        let endpoint = reqwest::Url::parse(&grant.endpoint).map_err(|_| Error::Auth("invalid mount data endpoint".into()))?;
        validate_endpoint(&endpoint)?;
        if grant.token.is_empty() || grant.token.len() > 8192 || grant.drive_id.is_empty() || grant.drive_id.len() > 128 || !grant.drive_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') || grant.expires_at <= now_ms || !endpoint.username().is_empty() || endpoint.password().is_some() || endpoint.query().is_some() || endpoint.fragment().is_some() || cached.as_ref().is_some_and(|old| old.drive_id != grant.drive_id) {
            return Err(Error::Auth("invalid or changed mount credential scope".into()));
        }
        *cached = Some(grant.clone());
        Ok(grant)
    }
}

#[async_trait]
impl TokenProvider for AccessKeyTokenProvider {
    async fn token(&self) -> Result<ProviderToken> { Ok(provider_token(self.exchange(false).await?)) }
    async fn refresh(&self) -> Result<ProviderToken> { Ok(provider_token(self.exchange(true).await?)) }
}

fn provider_token(grant: MountGrant) -> ProviderToken { ProviderToken { token: grant.token, endpoint: Some(grant.endpoint), read_only: !grant.can_write } }
fn sign(key: &[u8], value: &str) -> Vec<u8> { hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), value.as_bytes()).as_ref().to_vec() }
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn sha256(bytes: &[u8]) -> String { hex(digest::digest(&digest::SHA256, bytes).as_ref()) }
fn validate_endpoint(url: &reqwest::Url) -> Result<()> {
    if url.scheme() == "https" || (url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))) { return Ok(()); }
    Err(Error::Auth("credential endpoints require HTTPS (loopback HTTP is allowed)".into()))
}
fn timestamp(time: SystemTime) -> String {
    let date = httpdate::fmt_http_date(time);
    let month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].iter().position(|m| *m == &date[8..11]).unwrap() + 1;
    format!("{}{:02}{}T{}{}{}Z", &date[12..16], month, &date[5..7], &date[17..19], &date[20..22], &date[23..25])
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{Mock, MockServer, ResponseTemplate, matchers::{method, path, query_param, header_exists}};

    #[test]
    fn formats_sigv4_date_and_refuses_insecure_endpoints() {
        assert_eq!(timestamp(UNIX_EPOCH + Duration::from_secs(1_700_000_000)), "20231114T221320Z");
        assert!(AccessKeyTokenProvider::new("http://example.com", "drive", "id".into(), "secret".into()).is_err());
        assert!(AccessKeyTokenProvider::new("https://example.com", "../other", "id".into(), "secret".into()).is_err());
    }

    #[tokio::test]
    async fn caches_and_renews_readonly_grants_and_refuses_scope_changes() {
        let server = MockServer::start().await;
        let expiry = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 900_000;
        let response = |drive: &str| ResponseTemplate::new(200).set_body_json(serde_json::json!({"driveId":drive,"canWrite":false,"endpoint":server.uri(),"token":"drive-token","expiresAt":expiry}));
        Mock::given(method("GET")).and(path("/drive")).and(query_param("x-uls-mount", "")).and(header_exists("authorization")).respond_with(response("d-original")).mount(&server).await;
        let provider = AccessKeyTokenProvider::new(&server.uri(), "drive", "id".into(), "secret".into()).unwrap();
        assert_eq!(provider.grant().await.unwrap().drive_id, "d-original");
        assert!(provider.token().await.unwrap().read_only);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        let client = crate::Client::builder(server.uri(), "").token_provider(provider.clone()).build().unwrap();
        assert!(matches!(client.mkdir("d-original", "blocked").await, Err(Error::WriteDenied)));
        provider.refresh().await.unwrap();
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
        server.reset().await;
        Mock::given(method("GET")).respond_with(response("d-reassigned")).mount(&server).await;
        assert!(provider.refresh().await.is_err());
    }

    #[tokio::test]
    async fn refuses_expired_grants_and_invalid_endpoint_without_exposing_response_tokens() {
        let server = MockServer::start().await;
        for endpoint in [server.uri(), "http://untrusted.example".into()] {
            server.reset().await;
            Mock::given(method("GET")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"driveId":"d-original","canWrite":true,"endpoint":endpoint,"token":"secret-never-print","expiresAt":1}))).mount(&server).await;
            let provider = AccessKeyTokenProvider::new(&server.uri(), "drive", "id".into(), "secret".into()).unwrap();
            let error = provider.grant().await.err().unwrap().to_string();
            assert!(!error.contains("secret-never-print"));
        }
    }

    #[tokio::test]
    async fn renewal_applies_permission_downgrades_and_bounds_untrusted_grants() {
        let server = MockServer::start().await;
        let expiry = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 900_000;
        let response = |can_write: bool| ResponseTemplate::new(200).set_body_json(serde_json::json!({"driveId":"d-original","canWrite":can_write,"endpoint":server.uri(),"token":"drive-token","expiresAt":expiry}));
        Mock::given(method("GET")).respond_with(response(true)).mount(&server).await;
        let provider = AccessKeyTokenProvider::new(&server.uri(), "drive", "id".into(), "secret".into()).unwrap();
        assert!(!provider.token().await.unwrap().read_only);
        server.reset().await;
        Mock::given(method("GET")).respond_with(response(false)).mount(&server).await;
        assert!(provider.refresh().await.unwrap().read_only);
        assert!(provider.token().await.unwrap().read_only);
        server.reset().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(200).set_body_string("x".repeat(65 * 1024))).mount(&server).await;
        assert!(provider.refresh().await.err().unwrap().to_string().contains("too large"));
        server.reset().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(302).insert_header("location", "http://untrusted.example/credentials")).mount(&server).await;
        assert!(provider.refresh().await.is_err());
    }
}
