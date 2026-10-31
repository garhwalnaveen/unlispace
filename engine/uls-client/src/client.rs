use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use bytes::{Bytes, BytesMut};
use futures_util::stream::{self, StreamExt, TryStreamExt};
use reqwest::{RequestBuilder, Response, StatusCode, header};
use serde::de::DeserializeOwned;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use uls_chunk::{Chunk, chunk_reader, sha256_hex};
use uls_proto::{
    ChangesResponse, CommitResponse, CreateDriveRequest, DriveCreated, DriveInfo,
    ListEntry, ListResponse, ManifestResponse, MissingRequest, MissingResponse, NodeType, Op,
    PutShardResponse, RestoreRequest, ShardRef, StatResponse, VersionEntry, VersionsResponse,
    validate_path,
};

use crate::auth::{Auth, TokenProvider};
use crate::cache::ShardCache;
use crate::error::{Error, Result};
use crate::range::{ShardSlice, map_range};
use crate::watch::WatchStream;

fn encode_commit(ops: &[Op], request_id: Option<&str>) -> Result<(Vec<u8>, bool)> {
    if ops.is_empty() || ops.len() > uls_proto::MAX_COMMIT_OPS {
        return Err(Error::InvalidResponse("commit must contain 1..1000 operations".into()));
    }
    if request_id.is_some_and(|id| id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-:_".contains(&b))) {
        return Err(Error::InvalidResponse("invalid commit request id".into()));
    }
    let mut value = serde_json::json!({"ops": ops});
    if let Some(id) = request_id { value["requestId"] = id.into(); }
    let json = serde_json::to_vec(&value).map_err(|e| Error::InvalidResponse(e.to_string()))?;
    if json.len() <= 1024 * 1024 { return Ok((json, false)); }
    let mut body = Vec::new();
    for op in ops {
        serde_json::to_writer(&mut body, op).map_err(|e| Error::InvalidResponse(e.to_string()))?;
        body.push(b'\n');
        if body.len() > 8 * 1024 * 1024 {
            return Err(Error::InvalidResponse("file manifest exceeds the supported 8 MiB commit limit".into()));
        }
    }
    Ok((body, true))
}

/// Exponential backoff for retryable failures (network errors, 429, 5xx).
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy {
            max_attempts: 5,
            base_delay: Duration::from_millis(250),
            max_delay: Duration::from_secs(8),
        }
    }
}

impl RetryPolicy {
    pub(crate) fn delay(&self, attempt: u32) -> Duration {
        let exp = self.base_delay.saturating_mul(1u32 << attempt.min(16));
        let capped = exp.min(self.max_delay);
        // Cheap jitter (0-25%) without a RNG dependency.
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        capped + capped / 4 * (nanos % 100) / 100
    }
}

/// One connection pool per process. Clients are built per request in the daemon; sharing the
/// pool keeps TCP/TLS sessions warm across them (a fresh handshake to the edge costs ~0.5 s).
/// The pool holds no credentials: auth headers are set per request.
fn shared_http() -> Result<reqwest::Client> {
    static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(c) = HTTP.get() { return Ok(c.clone()); }
    let c = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .tcp_nodelay(true)
        .user_agent(concat!("uls-client/", env!("CARGO_PKG_VERSION")))
        .build()?;
    Ok(HTTP.get_or_init(|| c).clone())
}

pub struct ClientBuilder {
    endpoint: String,
    token: String,
    provider: Option<Arc<dyn TokenProvider>>,
    parallelism: usize,
    retry: RetryPolicy,
    cache: Option<Arc<ShardCache>>,
    whole_shard_on_partial: bool,
    upload_limiter: Option<Arc<UploadLimiter>>,
}

/// Shared upload bandwidth limit, in bytes per second (0 = unlimited). Cloned handles share one
/// budget, so every shard PUT from every client holding it draws from the same bucket. The rate
/// can be changed at any time and applies to the next reservation.
#[derive(Debug, Default)]
pub struct UploadLimiter {
    bps: std::sync::atomic::AtomicU64,
    /// Instant (ms since `epoch`) at which the already-reserved bytes will have been sent.
    next_free_ms: std::sync::atomic::AtomicU64,
    epoch: std::sync::OnceLock<std::time::Instant>,
}

impl UploadLimiter {
    pub fn new(bps: u64) -> Arc<Self> {
        let l = UploadLimiter::default();
        l.bps.store(bps, std::sync::atomic::Ordering::SeqCst);
        Arc::new(l)
    }
    pub fn set_bps(&self, bps: u64) {
        self.bps.store(bps, std::sync::atomic::Ordering::SeqCst);
        if bps == 0 { self.next_free_ms.store(0, std::sync::atomic::Ordering::SeqCst); }
    }
    pub fn bps(&self) -> u64 {
        self.bps.load(std::sync::atomic::Ordering::SeqCst)
    }
    /// How long a sender of `bytes` must wait before starting, reserving its slot. The
    /// reservation is a leaky bucket with a one-second burst allowance.
    pub fn reserve(&self, bytes: u64) -> Duration {
        use std::sync::atomic::Ordering::SeqCst;
        let bps = self.bps();
        if bps == 0 { return Duration::ZERO; }
        let epoch = *self.epoch.get_or_init(std::time::Instant::now);
        let now = epoch.elapsed().as_millis() as u64;
        let cost = bytes.saturating_mul(1000) / bps;
        let mut cur = self.next_free_ms.load(SeqCst);
        loop {
            // Idle time earns at most one second of burst.
            let start = cur.max(now.saturating_sub(1000));
            let end = start.saturating_add(cost);
            match self.next_free_ms.compare_exchange(cur, end, SeqCst, SeqCst) {
                Ok(_) => return Duration::from_millis(start.saturating_sub(now)),
                Err(v) => cur = v,
            }
        }
    }
    async fn acquire(&self, bytes: u64) {
        let d = self.reserve(bytes);
        if !d.is_zero() { tokio::time::sleep(d).await; }
    }
}

impl ClientBuilder {
    pub fn new(endpoint: impl Into<String>, token: impl Into<String>) -> Self {
        ClientBuilder {
            endpoint: endpoint.into(),
            token: token.into(),
            provider: None,
            parallelism: 8,
            retry: RetryPolicy::default(),
            cache: None,
            whole_shard_on_partial: false,
            upload_limiter: None,
        }
    }
    /// Throttle shard PUT bodies through a shared limiter.
    pub fn upload_limiter(mut self, l: Arc<UploadLimiter>) -> Self {
        self.upload_limiter = Some(l);
        self
    }
    /// Resolve the bearer token (and optionally the endpoint) per request instead of using the
    /// static token. On a 401 the provider's `refresh()` is consulted once and the request is
    /// retried once; watch reconnects also take a fresh token from it.
    pub fn token_provider(mut self, p: Arc<dyn TokenProvider>) -> Self {
        self.provider = Some(p);
        self
    }
    /// Concurrent shard transfers (default 8).
    pub fn parallelism(mut self, n: usize) -> Self {
        self.parallelism = n.max(1);
        self
    }
    pub fn retry(mut self, r: RetryPolicy) -> Self {
        self.retry = r;
        self
    }
    pub fn cache(mut self, c: Arc<ShardCache>) -> Self {
        self.cache = Some(c);
        self
    }
    /// When a read needs only part of an uncached shard, fetch and cache the whole shard
    /// instead of issuing an HTTP Range request. Good for sequential readers (the NFS mount).
    pub fn whole_shard_on_partial(mut self, yes: bool) -> Self {
        self.whole_shard_on_partial = yes;
        self
    }
    pub fn build(self) -> Result<Client> {
        Ok(Client {
            http: shared_http()?,
            base: self.endpoint.trim_end_matches('/').to_string(),
            auth: match self.provider {
                Some(p) => Auth::Provider(p),
                None => Auth::Static(self.token),
            },
            parallelism: self.parallelism,
            retry: self.retry,
            cache: self.cache,
            whole_shard_on_partial: self.whole_shard_on_partial,
            ram: Arc::new(Ram::default()),
            blocks: Arc::new(BlockUrls::default()),
            upload_limiter: self.upload_limiter,
        })
    }
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    auth: Auth,
    parallelism: usize,
    retry: RetryPolicy,
    cache: Option<Arc<ShardCache>>,
    whole_shard_on_partial: bool,
    ram: Arc<Ram>,
    blocks: Arc<BlockUrls>,
    upload_limiter: Option<Arc<UploadLimiter>>,
}

/// Signed edge-cache URLs learned from manifests, keyed by (drive, shard hash). Never persisted.
#[derive(Default)]
struct BlockUrls {
    map: std::sync::Mutex<HashMap<(String, String), (String, i64)>>,
}

/// URLs this close to expiry are not used (clock skew, transfer time).
const BLOCK_URL_MARGIN_SECS: i64 = 30;
const BLOCK_URL_MAX_ENTRIES: usize = 20_000;

fn unix_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl BlockUrls {
    fn remember(&self, drive: &str, m: &ManifestResponse) {
        let Some(exp) = m.block_urls_expire_at else { return };
        if m.block_urls.is_empty() || exp <= unix_secs() + BLOCK_URL_MARGIN_SECS { return; }
        let mut g = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let now = unix_secs();
        if g.len() + m.block_urls.len() > BLOCK_URL_MAX_ENTRIES {
            g.retain(|_, (_, e)| *e > now + BLOCK_URL_MARGIN_SECS);
            if g.len() + m.block_urls.len() > BLOCK_URL_MAX_ENTRIES { g.clear(); }
        }
        for (h, u) in &m.block_urls {
            g.insert((drive.to_string(), h.clone()), (u.clone(), exp));
        }
    }
    fn get(&self, drive: &str, hash: &str) -> Option<String> {
        let mut g = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let key = (drive.to_string(), hash.to_string());
        match g.get(&key) {
            Some((u, exp)) if *exp > unix_secs() + BLOCK_URL_MARGIN_SECS => Some(u.clone()),
            Some(_) => { g.remove(&key); None }
            None => None,
        }
    }
    fn forget(&self, drive: &str, hash: &str) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(&(drive.to_string(), hash.to_string()));
    }
}

// Deliberately does not print the token.
impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client").field("base", &self.base).finish_non_exhaustive()
    }
}

/// Outcome of `upload_file`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadReport {
    pub seq: u64,
    pub version_id: String,
    pub size: u64,
    /// Shards in the manifest (with repeats).
    pub shards_total: usize,
    /// Distinct shard hashes.
    pub shards_unique: usize,
    /// Shard PUTs that completed.
    pub shards_uploaded: usize,
    pub bytes_uploaded: u64,
}

fn check_hash(h: &str) -> Result<()> {
    if h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(())
    } else {
        Err(Error::InvalidResponse(format!("bad shard hash {h:?}")))
    }
}

fn norm_file_path(p: &str) -> Result<String> {
    let p = p.trim_start_matches('/');
    validate_path(p).map_err(Error::InvalidPath)?;
    if p.is_empty() || p.ends_with('/') {
        return Err(Error::InvalidPath(format!("{p:?} is not a file path")));
    }
    Ok(p.to_string())
}

fn norm_folder_path(p: &str) -> Result<String> {
    let p = p.trim_start_matches('/');
    let mut s = p.to_string();
    if !s.is_empty() && !s.ends_with('/') {
        s.push('/');
    }
    validate_path(&s).map_err(Error::InvalidPath)?;
    Ok(s)
}

impl Client {
    pub fn builder(endpoint: impl Into<String>, token: impl Into<String>) -> ClientBuilder {
        ClientBuilder::new(endpoint, token)
    }

    /// Configured concurrent shard transfer bound (always at least 1).
    pub fn parallelism(&self) -> usize {
        self.parallelism
    }

    /// Control-plane request with this client's bearer, without data-plane path rewriting.
    /// Mutations are never retried after an ambiguous transport failure.
    pub async fn control_request(&self, method: &str, path: &str, body: Option<&serde_json::Value>) -> Result<serde_json::Value> {
        if !path.starts_with('/') || path.starts_with("//") || path.contains("..") {
            return Err(Error::InvalidPath("invalid control path".into()));
        }
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| Error::InvalidPath("invalid method".into()))?;
        let (base,token) = self.creds().await?;
        let mut request = self.http.request(method,format!("{base}{path}")).bearer_auth(token);
        if let Some(body) = body { request = request.json(body); }
        let response = Self::check(request.send().await?).await?;
        if response.status() == StatusCode::NO_CONTENT { return Ok(serde_json::json!({})); }
        Self::json(response).await
    }

    pub fn cache(&self) -> Option<&Arc<ShardCache>> {
        self.cache.as_ref()
    }

    pub(crate) fn ws_url(base: &str, drive: &str, after_ev: i64) -> String {
        let base = if let Some(r) = base.strip_prefix("https://") {
            format!("wss://{r}")
        } else if let Some(r) = base.strip_prefix("http://") {
            format!("ws://{r}")
        } else {
            base.to_string()
        };
        format!("{base}/v0/drives/{drive}/watch?after={after_ev}")
    }

    fn resolve(&self, t: crate::auth::ProviderToken) -> (String, String) {
        let base = t.endpoint.map_or_else(|| self.base.clone(), |e| e.trim_end_matches('/').to_string());
        (base, t.token)
    }

    /// `(endpoint, bearer token)` to use right now.
    pub(crate) async fn creds(&self) -> Result<(String, String)> {
        match &self.auth {
            Auth::Static(t) => Ok((self.base.clone(), t.clone())),
            Auth::Provider(p) => Ok(self.resolve(p.token().await?)),
        }
    }

    /// Like `creds`, after the server rejected the previous token.
    pub(crate) async fn refreshed_creds(&self) -> Result<(String, String)> {
        match &self.auth {
            Auth::Static(t) => Ok((self.base.clone(), t.clone())),
            Auth::Provider(p) => Ok(self.resolve(p.refresh().await?)),
        }
    }

    async fn request_creds(&self, write: bool, refresh: bool) -> Result<(String, String)> {
        match &self.auth {
            Auth::Static(t) => Ok((self.base.clone(), t.clone())),
            Auth::Provider(p) => {
                let token = if refresh { p.refresh().await? } else { p.token().await? };
                if write && token.read_only { return Err(Error::WriteDenied); }
                Ok(self.resolve(token))
            }
        }
    }

    /// Send a request to `/v0/drives/{drive}{rest}`. With a token provider, a 401 triggers one
    /// refresh and one retry (a 401 means the request was not processed, so this is safe even
    /// for commits). `f` adds query, headers and body, and may run twice.
    async fn send(
        &self,
        m: reqwest::Method,
        drive: &str,
        rest: &str,
        f: impl Fn(RequestBuilder) -> RequestBuilder,
    ) -> Result<Response> {
        let build = |base: &str, tok: &str| f(self.http.request(m.clone(), format!("{base}/v0/drives/{drive}{rest}")).bearer_auth(tok));
        let write = m != reqwest::Method::GET && rest != "/shards/missing";
        let (base, tok) = self.request_creds(write, false).await?;
        let resp = build(&base, &tok).send().await?;
        if resp.status() == StatusCode::UNAUTHORIZED && matches!(self.auth, Auth::Provider(_)) {
            let (base, tok) = self.request_creds(write, true).await?;
            return Ok(build(&base, &tok).send().await?);
        }
        Ok(resp)
    }

    async fn check(resp: Response) -> Result<Response> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let body = resp.bytes().await.unwrap_or_default();
        Err(Error::from_response(status.as_u16(), &body))
    }

    async fn json<T: DeserializeOwned>(resp: Response) -> Result<T> {
        let resp = Self::check(resp).await?;
        let body = resp.bytes().await?;
        serde_json::from_slice(&body).map_err(|e| Error::InvalidResponse(e.to_string()))
    }

    /// Run `f` until it succeeds, fails with a non-retryable error, or attempts run out.
    async fn retrying<T, F, Fut>(&self, mut f: F) -> Result<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let mut attempt = 0;
        loop {
            match f().await {
                Err(e) if e.is_retryable() && attempt + 1 < self.retry.max_attempts => {
                    tracing::debug!("retrying after error: {e}");
                    tokio::time::sleep(self.retry.delay(attempt)).await;
                    attempt += 1;
                }
                other => return other,
            }
        }
    }

    async fn get_json<T: DeserializeOwned>(&self, drive: &str, rest: &str, q: &[(&str, String)]) -> Result<T> {
        self.retrying(|| async {
            let r = self.send(reqwest::Method::GET, drive, rest, |b| b.query(q)).await?;
            Self::json(r).await
        })
        .await
    }

    // ---- drives -----------------------------------------------------------------------------

    pub async fn create_drive(&self, drive: &str, placement: Option<&str>) -> Result<DriveCreated> {
        let body = CreateDriveRequest { placement: placement.map(str::to_string) };
        let r = self.send(reqwest::Method::PUT, drive, "", |b| b.json(&body)).await?;
        Self::json(r).await
    }

    pub async fn drive_info(&self, drive: &str) -> Result<DriveInfo> {
        self.get_json(drive, "", &[]).await
    }

    // ---- shards -----------------------------------------------------------------------------

    /// Hashes the server does not yet have. Batches of 1000 are handled internally.
    pub async fn missing(&self, drive: &str, hashes: &[String]) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for batch in hashes.chunks(uls_proto::MAX_MISSING_HASHES) {
            let body = MissingRequest { hashes: batch.to_vec() };
            let resp: MissingResponse = self
                .retrying(|| async {
                    let r = self.send(reqwest::Method::POST, drive, "/shards/missing", |b| b.json(&body)).await?;
                    Self::json(r).await
                })
                .await?;
            out.extend(resp.missing);
        }
        Ok(out)
    }

    pub async fn put_shard(&self, drive: &str, hash: &str, data: Bytes) -> Result<PutShardResponse> {
        check_hash(hash)?;
        self.retrying(|| async {
            if let Some(l) = &self.upload_limiter { l.acquire(data.len() as u64).await; }
            let r = self
                .send(reqwest::Method::PUT, drive, &format!("/shards/{hash}"), |b| {
                    b.header(header::CONTENT_TYPE, "application/octet-stream").body(data.clone())
                })
                .await?;
            Self::json(r).await
        })
        .await
    }

    /// Fetch a whole shard (no cache, no verification).
    async fn get_shard_raw(&self, drive: &str, hash: &str, range: Option<(u64, u64)>) -> Result<(StatusCode, Bytes)> {
        check_hash(hash)?;
        self.retrying(|| async {
            let started = std::time::Instant::now();
            let r = self
                .send(reqwest::Method::GET, drive, &format!("/shards/{hash}"), |rb| match range {
                    Some((a, b)) => rb.header(header::RANGE, format!("bytes={a}-{b}")),
                    None => rb,
                })
                .await?;
            let r = Self::check(r).await?;
            let status = r.status();
            let first_byte_ms = started.elapsed().as_millis() as u64;
            let server = r.headers().get("server-timing").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let body = r.bytes().await?;
            // Timings and sizes only; the hash is content-addressed, not secret, but is shortened.
            tracing::debug!(target: "uls_client::shard_get", shard = &hash[..12], bytes = body.len(),
                first_byte_ms, total_ms = started.elapsed().as_millis() as u64, server = %server, "shard GET");
            Ok((status, body))
        })
        .await
    }

    /// Whole-shard GET through a signed edge-cache URL from the manifest, without a bearer token.
    /// Returns bytes that match `hash`, or `None` on any problem (no URL, expired, 401/403/404,
    /// network error, wrong bytes) so the caller falls back to the authenticated route.
    async fn fetch_via_block(&self, drive: &str, hash: &str) -> Option<Bytes> {
        let url = self.blocks.get(drive, hash)?;
        let started = std::time::Instant::now();
        let resp = match self.http.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!(target: "uls_client::shard_get", "block GET failed: {}", e.without_url());
                return None;
            }
        };
        let status = resp.status();
        if status != StatusCode::OK {
            if matches!(status.as_u16(), 401 | 403 | 404) { self.blocks.forget(drive, hash); }
            return None;
        }
        let body = resp.bytes().await.ok()?;
        if sha256_hex(&body) != hash {
            self.blocks.forget(drive, hash);
            return None;
        }
        tracing::debug!(target: "uls_client::shard_get", shard = &hash[..12], bytes = body.len(),
            total_ms = started.elapsed().as_millis() as u64, "shard GET via block url");
        Some(body)
    }

    /// Whole shard, verified. Looks in RAM, then the disk cache, then the network. Concurrent
    /// requests for the same shard share one download.
    pub async fn fetch_shard(&self, drive: &str, hash: &str) -> Result<Bytes> {
        self.fetch_shard_with(drive, hash, false).await
    }

    /// `fetch_shard`, but only returns once the shard is durable in the disk cache. Used for
    /// offline pins, whose contract is that pinned bytes survive a restart once reported cached.
    pub async fn fetch_shard_durable(&self, drive: &str, hash: &str) -> Result<Bytes> {
        let data = self.fetch_shard_with(drive, hash, true).await?;
        if let Some(c) = &self.cache && !c.contains(hash) {
            let (c, h, d) = (c.clone(), hash.to_string(), data.clone());
            tokio::task::spawn_blocking(move || c.put_verified(&h, &d)).await
                .map_err(|e| Error::Io(std::io::Error::other(e.to_string())))??;
        }
        Ok(data)
    }

    async fn fetch_shard_with(&self, drive: &str, hash: &str, durable: bool) -> Result<Bytes> {
        check_hash(hash)?;
        if let Some(b) = self.ram.get(hash) {
            return Ok(b);
        }
        let gate = self.ram.gate(hash);
        let _held = gate.lock().await;
        let res = self.fetch_shard_locked(drive, hash, durable).await;
        drop(_held);
        self.ram.release_gate(hash, gate);
        res
    }

    async fn fetch_shard_locked(&self, drive: &str, hash: &str, durable: bool) -> Result<Bytes> {
        if let Some(b) = self.ram.get(hash) {
            return Ok(b);
        }
        if let Some(c) = &self.cache {
            let c = c.clone();
            let h = hash.to_string();
            if let Ok(Some(b)) = tokio::task::spawn_blocking(move || c.get(&h)).await {
                self.ram.insert(hash, b.clone());
                return Ok(b);
            }
        }
        // `fetch_via_block` returns only bytes it already verified against `hash`.
        let data = match self.fetch_via_block(drive, hash).await {
            Some(b) => b,
            None => {
                let data = self.get_shard_raw(drive, hash, None).await?.1;
                let actual = sha256_hex(&data);
                if actual != hash {
                    return Err(Error::HashMismatch { expected: hash.to_string(), actual });
                }
                data
            }
        };
        // Insert into RAM before the disk write so concurrent readers are served immediately.
        self.ram.insert(hash, data.clone());
        if let Some(c) = &self.cache {
            let c = c.clone();
            let (h, d) = (hash.to_string(), data.clone());
            // Ordinary reads persist in the background: an fsync per shard must not sit on the read
            // path, and a crash only loses a cache entry. Durable (pin) fetches wait and report errors.
            let write = tokio::task::spawn_blocking(move || c.put_verified(&h, &d));
            if durable {
                write.await.map_err(|e| Error::Io(std::io::Error::other(e.to_string())))??;
            } else {
                tokio::spawn(async move {
                    if let Ok(Err(e)) = write.await { tracing::warn!("shard cache write failed: {e}"); }
                });
            }
        }
        Ok(data)
    }

    /// Start fetching shards a sequential reader will want next, without waiting for them.
    /// Bounded by `parallelism`; already-cached or in-flight shards are skipped.
    pub fn prefetch(&self, drive: &str, shards: &[ShardRef], from_index: usize, count: usize) {
        let mut started = 0;
        for s in shards.iter().skip(from_index) {
            if started >= count.min(self.parallelism) { break; }
            if self.ram.contains(&s.h) || self.ram.inflight(&s.h) { continue; }
            if self.cache.as_ref().is_some_and(|c| c.contains(&s.h)) { continue; }
            let (me, drive, hash) = (self.clone(), drive.to_string(), s.h.clone());
            tokio::spawn(async move { let _ = me.fetch_shard(&drive, &hash).await; });
            started += 1;
        }
    }

    // ---- commit -----------------------------------------------------------------------------

    /// Not retried automatically: a retry after an ambiguous failure could double-apply.
    pub async fn commit(&self, drive: &str, ops: Vec<Op>) -> Result<CommitResponse> {
        self.commit_with_id(drive, ops, None).await
    }

    pub fn preflight_commit(ops: &[Op]) -> Result<()> {
        encode_commit(ops, None).map(|_| ())
    }

    pub async fn commit_with_id(&self, drive: &str, ops: Vec<Op>, request_id: Option<&str>) -> Result<CommitResponse> {
        let (body, streamed) = encode_commit(&ops, request_id)?;
        if ops.iter().any(|o| matches!(o, Op::Put {xattrs: Some(_), ..}))
            && !self.drive_info(drive).await?.features.iter().any(|f| f == "xattrs") {
            return Err(Error::InvalidResponse("Server upgrade required to save Mac extended attributes; local changes are retained".into()));
        }
        let r = self.send(reqwest::Method::POST, drive, "/commit", |b| {
            let b = b.header(header::CONTENT_TYPE, if streamed { "application/x-ndjson" } else { "application/json" });
            let b = if streamed { if let Some(id) = request_id { b.header("x-uls-request-id", id) } else { b } } else { b };
            b.body(body.clone())
        }).await?;
        Self::json(r).await
    }

    pub async fn mkdir(&self, drive: &str, path: &str) -> Result<CommitResponse> {
        let path = norm_folder_path(path)?;
        self.commit(drive, vec![Op::Mkdir { path }]).await
    }

    pub async fn delete(&self, drive: &str, path: &str, if_version: Option<&str>) -> Result<CommitResponse> {
        let p = path.trim_start_matches('/');
        validate_path(p).map_err(Error::InvalidPath)?;
        self.commit(drive, vec![Op::Delete { path: p.to_string(), if_version: if_version.map(str::to_string) }])
            .await
    }

    pub async fn rename(&self, drive: &str, from: &str, to: &str, if_version: Option<&str>) -> Result<CommitResponse> {
        let (from, to) = (from.trim_start_matches('/'), to.trim_start_matches('/'));
        validate_path(from).map_err(Error::InvalidPath)?;
        validate_path(to).map_err(Error::InvalidPath)?;
        self.commit(
            drive,
            vec![Op::Rename { from: from.to_string(), to: to.to_string(), if_version: if_version.map(str::to_string) }],
        )
        .await
    }

    // ---- metadata ---------------------------------------------------------------------------

    pub async fn stat(&self, drive: &str, path: &str) -> Result<StatResponse> {
        let p = path.trim_start_matches('/').to_string();
        validate_path(&p).map_err(Error::InvalidPath)?;
        self.get_json(drive, "/stat", &[("path", p)]).await
    }

    /// One page of indexed filename matches, including full current paths.
    pub async fn search(&self, drive: &str, query: &str, cursor: Option<&str>) -> Result<serde_json::Value> {
        let mut params = vec![("q", query.to_string()), ("limit", "50".to_string())];
        if let Some(cursor) = cursor { params.push(("cursor", cursor.to_string())); }
        self.get_json(drive, "/search", &params).await
    }

    /// One page of a folder listing.
    pub async fn list_page(&self, drive: &str, path: &str, cursor: Option<&str>, limit: usize) -> Result<ListResponse> {
        let mut q = vec![("path", norm_folder_path(path)?), ("limit", limit.clamp(1, 1000).to_string())];
        if let Some(c) = cursor {
            q.push(("cursor", c.to_string()));
        }
        self.get_json(drive, "/list", &q).await
    }

    /// A whole folder, following cursors.
    pub async fn list(&self, drive: &str, path: &str) -> Result<Vec<ListEntry>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = self.list_page(drive, path, cursor.as_deref(), 1000).await?;
            out.extend(page.entries);
            match page.cursor {
                Some(c) => cursor = Some(c),
                None => return Ok(out),
            }
        }
    }

    pub async fn manifest(&self, drive: &str, path: &str, version: Option<&str>) -> Result<ManifestResponse> {
        let p = norm_file_path(path)?;
        #[derive(serde::Deserialize)]
        struct Page {
            #[serde(flatten)]
            manifest: ManifestResponse,
            #[serde(rename = "nextShardCursor")]
            next: Option<u64>,
        }
        let mut q = vec![("path", p.clone()), ("shardCursor", "0".into())];
        if let Some(v) = version {
            q.push(("versionId", v.to_string()));
        }
        let first: Page = self.get_json(drive, "/manifest", &q).await?;
        let mut manifest = first.manifest;
        if manifest.path != p || manifest.version_id.is_empty() || version.is_some_and(|v| v != manifest.version_id) {
            return Err(Error::InvalidResponse("manifest identity changed".into()));
        }
        let mut total = 0u64;
        let mut count = 0usize;
        let mut validate = |page: &ManifestResponse| -> Result<()> {
            for shard in &page.shards {
                check_hash(&shard.h).map_err(|_| Error::InvalidResponse("invalid manifest shard hash".into()))?;
                if shard.n == 0 || shard.n > 16 * 1024 * 1024 { return Err(Error::InvalidResponse("invalid manifest shard length".into())); }
                total = total.checked_add(shard.n).ok_or_else(|| Error::InvalidResponse("manifest size overflow".into()))?;
            }
            count += page.shards.len();
            if total > page.size || count > 400_000 { return Err(Error::InvalidResponse("manifest exceeds supported size".into())); }
            Ok(())
        };
        validate(&manifest)?;
        self.blocks.remember(drive, &manifest);
        let mut cursor = 0;
        let mut next = first.next;
        while let Some(current) = next {
            if current <= cursor || current > 1_000_000 {
                return Err(Error::InvalidResponse("invalid manifest cursor".into()));
            }
            let page: Page = self.get_json(drive, "/manifest", &[
                ("path", p.clone()), ("versionId", manifest.version_id.clone()), ("shardCursor", current.to_string()),
            ]).await?;
            if page.manifest.path != p || page.manifest.version_id != manifest.version_id || page.manifest.size != manifest.size ||
                page.manifest.content_type != manifest.content_type || page.manifest.mtime_ms != manifest.mtime_ms || page.manifest.xattrs != manifest.xattrs || page.manifest.shards.is_empty() {
                return Err(Error::InvalidResponse("manifest identity changed between pages".into()));
            }
            validate(&page.manifest)?;
            self.blocks.remember(drive, &page.manifest);
            manifest.shards.extend(page.manifest.shards);
            cursor = current;
            next = page.next;
        }
        if total != manifest.size { return Err(Error::InvalidResponse("manifest shard lengths do not match file size".into())); }
        Ok(manifest)
    }

    /// Full history of `path`, oldest first. Follows the server's cursor until it is exhausted.
    pub async fn versions(&self, drive: &str, path: &str) -> Result<Vec<VersionEntry>> {
        let p = path.trim_start_matches('/').to_string();
        validate_path(&p).map_err(Error::InvalidPath)?;
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut q = vec![("path", p.clone()), ("limit", "1000".to_string())];
            if let Some(c) = &cursor {
                q.push(("cursor", c.clone()));
            }
            let r: VersionsResponse = self.get_json(drive, "/versions", &q).await?;
            out.extend(r.versions);
            match r.cursor {
                None => return Ok(out),
                Some(c) if cursor.as_deref() == Some(c.as_str()) => {
                    return Err(Error::InvalidResponse("versions cursor did not advance".into()));
                }
                Some(c) => cursor = Some(c),
            }
        }
    }

    pub async fn restore(&self, drive: &str, path: &str, version_id: &str, if_version: Option<&str>) -> Result<CommitResponse> {
        let path = norm_file_path(path)?;
        let body = RestoreRequest { path, version_id: version_id.to_string(), if_version: if_version.map(str::to_string) };
        let r = self.send(reqwest::Method::POST, drive, "/restore", |b| b.json(&body)).await?;
        Self::json(r).await
    }

    /// One page of the change log: events with `ev > after_ev`. Pages are cut by `ev`, so
    /// continue from the last returned `ev` while `more` is set.
    pub async fn changes(&self, drive: &str, after_ev: i64, limit: usize) -> Result<ChangesResponse> {
        self.get_json(drive, "/changes", &[("after", after_ev.max(0).to_string()), ("limit", limit.clamp(1, 1000).to_string())])
            .await
    }

    /// Live change feed. Connects with `?after=<after_ev>`, delivers each event once (dedup on
    /// `ev`), and reconnects with backoff, taking a fresh token from the provider each time.
    /// See [`WatchStream`] for close-code and resync handling.
    pub fn watch(&self, drive: &str, after_ev: i64) -> WatchStream {
        WatchStream::spawn(self.clone(), drive.to_string(), after_ev.max(0))
    }

    // ---- upload -----------------------------------------------------------------------------

    /// Chunk `local_path`, upload the shards the server lacks, then commit one `put`.
    ///
    /// Memory use is bounded: the file is chunked in a streaming pass that keeps only hashes and
    /// offsets, and missing shards are re-read from disk by offset when uploaded.
    pub async fn upload_file(
        &self,
        drive: &str,
        local_path: &Path,
        remote_path: &str,
        if_version: Option<&str>,
    ) -> Result<UploadReport> {
        let remote = norm_file_path(remote_path)?;
        let local = local_path.to_path_buf();
        let (chunks, size, mtime_ms) = tokio::task::spawn_blocking(move || -> Result<(Vec<Chunk>, u64, i64)> {
            let f = std::fs::File::open(&local)?;
            let md = f.metadata()?;
            let mut chunks = Vec::new();
            for c in chunk_reader(std::io::BufReader::with_capacity(1 << 20, f)) {
                chunks.push(c?.0);
            }
            let mtime = md
                .modified()
                .ok()
                .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Ok((chunks, md.len(), mtime))
        })
        .await
        .map_err(|e| Error::Io(std::io::Error::other(e)))??;

        if chunks.iter().map(|c| c.length as u64).sum::<u64>() != size {
            return Err(Error::Io(std::io::Error::other("file changed while being read")));
        }

        // hash -> (offset, len) for one occurrence of each distinct shard.
        let mut locs: HashMap<String, (u64, usize)> = HashMap::new();
        let mut unique: Vec<String> = Vec::new();
        for c in &chunks {
            if locs.insert(c.hash.clone(), (c.offset, c.length)).is_none() {
                unique.push(c.hash.clone());
            }
        }

        let mut uploaded = 0usize;
        let mut bytes_uploaded = 0u64;
        Self::preflight_commit(&[Op::Put { path: remote.clone(), if_version: if_version.map(str::to_string),
            if_absent: false, size, content_type: "application/octet-stream".into(), mtime_ms,
            shards: chunks.iter().map(|c| ShardRef { h: c.hash.clone(), n: c.length as u64 }).collect(), xattrs: None }])?;
        let mut to_upload = self.missing(drive, &unique).await?;

        let ctype = mime_guess::from_path(&remote).first_or_octet_stream().essence_str().to_string();
        let shards: Vec<ShardRef> = chunks.iter().map(|c| ShardRef { h: c.hash.clone(), n: c.length as u64 }).collect();

        let mut rounds = 0;
        let resp = loop {
            let (n, b) = self.upload_shards(drive, local_path, &locs, &to_upload).await?;
            uploaded += n;
            bytes_uploaded += b;
            let op = Op::Put {
                path: remote.clone(),
                if_version: if_version.map(str::to_string),
                if_absent: false,
                size,
                content_type: ctype.clone(),
                mtime_ms,
                shards: shards.clone(),
                xattrs: None,
            };
            match self.commit(drive, vec![op]).await {
                Err(Error::MissingShards { hashes }) if rounds < 3 => {
                    rounds += 1;
                    tracing::debug!("commit reported {} missing shard(s); re-uploading", hashes.len());
                    to_upload = hashes;
                }
                other => break other?,
            }
        };
        let result = resp
            .results
            .first()
            .ok_or_else(|| Error::InvalidResponse("commit returned no results".into()))?;
        Ok(UploadReport {
            seq: resp.seq,
            version_id: result.version_id.clone(),
            size,
            shards_total: chunks.len(),
            shards_unique: unique.len(),
            shards_uploaded: uploaded,
            bytes_uploaded,
        })
    }

    async fn upload_shards(
        &self,
        drive: &str,
        local: &Path,
        locs: &HashMap<String, (u64, usize)>,
        hashes: &[String],
    ) -> Result<(usize, u64)> {
        let results: Vec<Result<u64>> = stream::iter(hashes.iter().cloned())
            .map(|h| async move {
                let &(offset, len) = locs
                    .get(&h)
                    .ok_or_else(|| Error::InvalidResponse(format!("server asked for unknown shard {h}")))?;
                let path = local.to_path_buf();
                let data = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
                    let mut f = std::fs::File::open(path)?;
                    f.seek(SeekFrom::Start(offset))?;
                    let mut buf = vec![0u8; len];
                    f.read_exact(&mut buf)?;
                    Ok(buf)
                })
                .await
                .map_err(|e| Error::Io(std::io::Error::other(e)))??;
                if sha256_hex(&data) != h {
                    return Err(Error::Io(std::io::Error::other("file changed while being uploaded")));
                }
                let n = data.len() as u64;
                self.put_shard(drive, &h, Bytes::from(data)).await?;
                Ok(n)
            })
            .buffer_unordered(self.parallelism)
            .collect()
            .await;
        let mut count = 0;
        let mut bytes = 0;
        for r in results {
            bytes += r?;
            count += 1;
        }
        Ok((count, bytes))
    }

    // ---- download / range reads -------------------------------------------------------------

    /// Stream a file (optionally an older version) into `out`, fetching shards in parallel and
    /// verifying each one. Returns the manifest that was downloaded.
    pub async fn download<W>(&self, drive: &str, path: &str, version: Option<&str>, out: &mut W) -> Result<ManifestResponse>
    where
        W: AsyncWrite + Unpin + Send,
    {
        let m = self.manifest(drive, path, version).await?;
        if m.shards.iter().map(|s| s.n).sum::<u64>() != m.size {
            return Err(Error::InvalidResponse("manifest shard sizes do not add up to size".into()));
        }
        let mut shards = stream::iter(m.shards.clone())
            .map(|s| async move {
                let data = self.fetch_shard(drive, &s.h).await?;
                if data.len() as u64 != s.n {
                    return Err(Error::InvalidResponse(format!("shard {} has length {}, manifest says {}", s.h, data.len(), s.n)));
                }
                Ok::<_, Error>(data)
            })
            .buffered(self.parallelism);
        while let Some(data) = shards.try_next().await? {
            out.write_all(&data).await?;
        }
        out.flush().await?;
        Ok(m)
    }

    /// `download` into a local file, atomically (temp file + rename).
    pub async fn download_to_file(&self, drive: &str, path: &str, version: Option<&str>, dest: &Path) -> Result<ManifestResponse> {
        let tmp = dest.with_file_name(format!(
            ".{}.uls-part",
            dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        ));
        let mut f = tokio::fs::File::create(&tmp).await?;
        let res = self.download(drive, path, version, &mut f).await;
        drop(f);
        match res {
            Ok(m) => {
                tokio::fs::rename(&tmp, dest).await?;
                Ok(m)
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    /// Read `[offset, offset+len)` of the current head of `path`. Clipped at EOF.
    pub async fn read_range(&self, drive: &str, path: &str, offset: u64, len: u64) -> Result<Bytes> {
        let m = self.manifest(drive, path, None).await?;
        self.read_manifest_range(drive, &m.shards, offset, len).await
    }

    /// Same as `read_range` for a manifest the caller already holds.
    pub async fn read_manifest_range(&self, drive: &str, shards: &[ShardRef], offset: u64, len: u64) -> Result<Bytes> {
        let slices = map_range(shards, offset, len);
        let parts: Vec<Bytes> = stream::iter(slices)
            .map(|s| self.fetch_slice(drive, s))
            .buffered(self.parallelism)
            .try_collect()
            .await?;
        if parts.len() == 1 {
            return Ok(parts.into_iter().next().unwrap_or_default());
        }
        let mut out = BytesMut::with_capacity(parts.iter().map(Bytes::len).sum());
        for p in parts {
            out.extend_from_slice(&p);
        }
        Ok(out.freeze())
    }

    async fn fetch_slice(&self, drive: &str, s: ShardSlice) -> Result<Bytes> {
        let (start, len) = (s.start as usize, s.len as usize);
        if let Some(b) = self.ram.get(&s.hash) {
            return slice_checked(&b, s.shard_len, start, len);
        }
        let cached = match &self.cache {
            Some(c) => {
                let (c, h) = (c.clone(), s.hash.clone());
                tokio::task::spawn_blocking(move || c.get(&h)).await.ok().flatten()
            }
            None => None,
        };
        if let Some(b) = cached {
            let slice = slice_checked(&b, s.shard_len, start, len)?;
            self.ram.insert(&s.hash, b);
            return Ok(slice);
        }
        if s.is_whole_shard() || self.whole_shard_on_partial {
            let b = self.fetch_shard(drive, &s.hash).await?;
            return slice_checked(&b, s.shard_len, start, len);
        }
        // Partial and uncached: ask for just those bytes. The slice cannot be verified against
        // the shard hash, so it is not cached.
        let (status, body) = self.get_shard_raw(drive, &s.hash, Some((s.start, s.start + s.len - 1))).await?;
        if status == StatusCode::PARTIAL_CONTENT {
            if body.len() != len {
                return Err(Error::InvalidResponse(format!("range returned {} bytes, wanted {len}", body.len())));
            }
            Ok(body)
        } else {
            // Server ignored Range and sent the whole shard: verify it and slice locally.
            let actual = sha256_hex(&body);
            if actual != s.hash {
                return Err(Error::HashMismatch { expected: s.hash, actual });
            }
            slice_checked(&body, s.shard_len, start, len)
        }
    }

    /// Convenience: is this entry a folder?
    pub fn is_folder(e: &ListEntry) -> bool {
        e.node_type == NodeType::Folder
    }
}

fn slice_checked(b: &Bytes, shard_len: u64, start: usize, len: usize) -> Result<Bytes> {
    if b.len() as u64 != shard_len || start + len > b.len() {
        return Err(Error::InvalidResponse("shard length differs from manifest".into()));
    }
    Ok(b.slice(start..start + len))
}

/// Small in-memory LRU of verified shards plus per-shard download gates.
const RAM_CAP_BYTES: usize = 128 * 1024 * 1024;

#[derive(Default)]
struct Ram {
    inner: std::sync::Mutex<RamInner>,
}

#[derive(Default)]
struct RamInner {
    order: std::collections::VecDeque<String>,
    map: HashMap<String, Bytes>,
    bytes: usize,
    gates: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

impl Ram {
    fn lock(&self) -> std::sync::MutexGuard<'_, RamInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, hash: &str) -> Option<Bytes> {
        let mut g = self.lock();
        let b = g.map.get(hash).cloned()?;
        if let Some(h) = g.order.iter().position(|h| h == hash).and_then(|pos| g.order.remove(pos)) {
            g.order.push_back(h);
        }
        Some(b)
    }

    fn insert(&self, hash: &str, data: Bytes) {
        let mut g = self.lock();
        if g.map.contains_key(hash) || data.len() > RAM_CAP_BYTES {
            return;
        }
        g.bytes += data.len();
        g.map.insert(hash.to_string(), data);
        g.order.push_back(hash.to_string());
        while g.bytes > RAM_CAP_BYTES {
            let Some(old) = g.order.pop_front() else { break };
            if let Some(b) = g.map.remove(&old) {
                g.bytes -= b.len();
            }
        }
    }

    fn gate(&self, hash: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.lock().gates.entry(hash.to_string()).or_default().clone()
    }

    fn contains(&self, hash: &str) -> bool {
        self.lock().map.contains_key(hash)
    }

    fn inflight(&self, hash: &str) -> bool {
        self.lock().gates.contains_key(hash)
    }

    fn release_gate(&self, hash: &str, gate: Arc<tokio::sync::Mutex<()>>) {
        let mut g = self.lock();
        // Two refs left (map + ours) means nobody else is waiting.
        if Arc::strong_count(&gate) <= 2 {
            g.gates.remove(hash);
        }
    }
}
