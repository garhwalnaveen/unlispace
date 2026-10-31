use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, broadcast};

use crate::REFRESH_MARGIN_MS;
use crate::error::AuthError;
use crate::jwt::claims_unverified;
use crate::store::SecretStore;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub email: String,
}

/// `Session` object returned by the api (contract §5.1). `Debug` redacts both tokens.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokens {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default = "default_expires_in")]
    pub expires_in: u64,
    pub user: User,
    #[serde(default)]
    pub account_created: bool,
}

fn default_expires_in() -> u64 {
    900
}

impl fmt::Debug for SessionTokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionTokens").field("user", &self.user).finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Read,
    Write,
    Admin,
}

impl Access {
    fn as_str(self) -> &'static str {
        match self {
            Access::Read => "read",
            Access::Write => "write",
            Access::Admin => "admin",
        }
    }
}

/// Response of `POST /drives/{id}/token`. `Debug` redacts the token.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveToken {
    pub token: String,
    /// Epoch milliseconds.
    pub expires_at: u64,
    pub endpoint: String,
    pub drive_id: String,
}

impl fmt::Debug for DriveToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DriveToken")
            .field("drive_id", &self.drive_id)
            .field("endpoint", &self.endpoint)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

/// `Drive` from `GET /orgs` (contract §5.2). Unknown fields are ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveSummary {
    pub id: String,
    #[serde(default)]
    pub org_id: String,
    pub name: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub access: Option<Access>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Org {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub drives: Vec<DriveSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthEvent {
    /// The session was cleared because the refresh token was rejected (or `sign_out` ran).
    SignedOut,
}

/// Something that can hand out a currently valid bearer token. This is the shape
/// `uls_client::Client` needs (see `engine/ulsd/NEEDS.md`).
#[async_trait]
pub trait TokenProvider: Send + Sync {
    async fn token(&self) -> Result<String, AuthError>;
}

struct Access_ {
    token: String,
    expires_at_ms: u64,
}

struct Inner {
    api: String,
    user: Option<User>,
    access: Option<Access_>,
    refresh: Option<String>,
    drive_tokens: HashMap<(String, Access), DriveToken>,
}

/// The desktop session. Cheap to share behind an `Arc`.
pub struct Session {
    http: reqwest::Client,
    store: Arc<dyn SecretStore>,
    inner: Mutex<Inner>,
    /// Serialises refreshes so concurrent callers share one `POST /auth/refresh`.
    refresh_gate: Arc<AsyncMutex<()>>,
    events: broadcast::Sender<AuthEvent>,
    /// Waits between retries of a transient failure (one retry per entry).
    backoff: Vec<Duration>,
}

/// Per-request cap for token calls, so a hung connection still leaves room for every retry
/// inside the server's lost-response grace window (60 s).
const TOKEN_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_BACKOFF_MS: [u64; 3] = [500, 1000, 2000];

/// Outcome of one attempt at a token call. Only `Revoked` may end the session.
enum Attempt {
    /// Transport error, timeout, 5xx, 429, or an unreadable/unparseable body after the request
    /// was sent. The server may have processed it, so the same request is safe to repeat.
    Transient(String),
    /// `401 invalid_refresh`: the refresh token is definitively dead.
    Revoked,
    /// `401` from an authenticated call: the access token was rejected.
    Unauthorized,
    Fatal(AuthError),
}

fn transient_status(status: u16) -> bool {
    status == 429 || status >= 500
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session").field("user", &self.user()).finish_non_exhaustive()
    }
}

pub(crate) async fn parse_session_response(resp: reqwest::Response) -> Result<SessionTokens, AuthError> {
    let status = resp.status();
    if status.is_success() {
        let bytes = resp.bytes().await?;
        return serde_json::from_slice(&bytes).map_err(|_| AuthError::Internal("malformed session response".into()));
    }
    Err(api_error(status.as_u16(), resp).await)
}

async fn api_error(status: u16, resp: reqwest::Response) -> AuthError {
    #[derive(Deserialize)]
    struct E {
        error: Option<String>,
    }
    let bytes = resp.bytes().await.unwrap_or_default();
    let code = serde_json::from_slice::<E>(&bytes).ok().and_then(|e| e.error).unwrap_or_else(|| format!("http_{status}"));
    AuthError::Api { status, code }
}

impl Session {
    /// A signed-out session. Call [`Session::sign_in`] to start one.
    pub fn new(api_endpoint: impl Into<String>, store: Arc<dyn SecretStore>) -> Result<Session, AuthError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| AuthError::Internal(e.without_url().to_string()))?;
        let (events, _) = broadcast::channel(16);
        Ok(Session {
            http,
            store,
            inner: Mutex::new(Inner {
                api: api_endpoint.into().trim_end_matches('/').to_string(),
                user: None,
                access: None,
                refresh: None,
                drive_tokens: HashMap::new(),
            }),
            refresh_gate: Arc::new(AsyncMutex::new(())),
            events,
            backoff: DEFAULT_BACKOFF_MS.iter().map(|&m| Duration::from_millis(m)).collect(),
        })
    }

    /// Override the retry schedule for transient failures (tests use short delays).
    #[must_use]
    pub fn with_retry_backoff(mut self, backoff: Vec<Duration>) -> Session {
        self.backoff = backoff;
        self
    }

    /// Resume a session after a restart: the refresh token is read from the store. Returns the
    /// session and whether a token was found. No network call is made; the first
    /// `access_token()` refreshes.
    pub fn restore(
        api_endpoint: impl Into<String>,
        user: User,
        store: Arc<dyn SecretStore>,
    ) -> Result<(Session, bool), AuthError> {
        let s = Session::new(api_endpoint, store)?;
        let found = s.store.get(&user.id)?;
        let mut i = s.lock();
        let ok = found.is_some();
        if ok {
            i.user = Some(user);
            i.refresh = found;
        }
        drop(i);
        Ok((s, ok))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AuthEvent> {
        self.events.subscribe()
    }

    pub fn api_endpoint(&self) -> String {
        self.lock().api.clone()
    }

    pub fn user(&self) -> Option<User> {
        self.lock().user.clone()
    }

    pub fn is_signed_in(&self) -> bool {
        let i = self.lock();
        i.user.is_some() && i.refresh.is_some()
    }

    /// Adopt tokens obtained elsewhere (desktop PKCE exchange, or `auth.set` from the app).
    /// Persists the refresh token. The user is read from the session response when available.
    pub fn sign_in(&self, t: SessionTokens) -> Result<User, AuthError> {
        let exp = claims_unverified(&t.access_token).and_then(|c| c.exp).map(|s| s * 1000).unwrap_or_else(|| now_ms() + t.expires_in * 1000);
        self.adopt(t.user.clone(), t.access_token, exp, t.refresh_token, true)?;
        Ok(t.user)
    }

    /// `auth.set`: only the raw tokens are known. The user comes from the access token's `sub`
    /// and `email` claims, falling back to `GET /me`.
    pub async fn sign_in_with_tokens(
        &self,
        api_endpoint: &str,
        access_token: String,
        refresh_token: String,
    ) -> Result<User, AuthError> {
        self.adopt_tokens(api_endpoint, access_token, refresh_token, true).await
    }

    /// Validate a replacement without changing the stored credential until its old session drains.
    pub async fn prepare_sign_in_with_tokens(&self, api_endpoint: &str, access_token: String, refresh_token: String) -> Result<User, AuthError> {
        self.adopt_tokens(api_endpoint, access_token, refresh_token, false).await
    }

    async fn adopt_tokens(&self, api_endpoint: &str, access_token: String, refresh_token: String, persist: bool) -> Result<User, AuthError> {
        if access_token.is_empty() || refresh_token.is_empty() {
            return Err(AuthError::BadRequest("accessToken and refreshToken are required".into()));
        }
        let api = api_endpoint.trim_end_matches('/').to_string();
        if !(api.starts_with("http://") || api.starts_with("https://")) {
            return Err(AuthError::BadRequest("apiEndpoint must be an http(s) URL".into()));
        }
        let claims = claims_unverified(&access_token);
        let (user, exp) = match &claims {
            Some(c) if c.sub.is_some() && c.email.is_some() => (
                User { id: c.sub.clone().unwrap_or_default(), email: c.email.clone().unwrap_or_default() },
                c.exp.map(|s| s * 1000).unwrap_or_else(|| now_ms() + 900_000),
            ),
            _ => {
                #[derive(Deserialize)]
                struct Me {
                    id: String,
                    email: String,
                }
                let resp = self.http.get(format!("{api}/me")).bearer_auth(&access_token).send().await?;
                if !resp.status().is_success() {
                    let status = resp.status().as_u16();
                    return Err(if status == 401 { AuthError::Api { status, code: "unauthorized".into() } } else { api_error(status, resp).await });
                }
                let me: Me = resp.json().await?;
                (User { id: me.id, email: me.email }, claims.and_then(|c| c.exp).map(|s| s * 1000).unwrap_or_else(|| now_ms() + 900_000))
            }
        };
        self.lock().api = api;
        self.adopt(user.clone(), access_token, exp, refresh_token, persist)?;
        Ok(user)
    }

    fn adopt(&self, user: User, access: String, exp_ms: u64, refresh: String, persist: bool) -> Result<(), AuthError> {
        // Persist first: if the Keychain write fails we do not pretend to be signed in.
        if persist { self.store.set(&user.id, &refresh)?; }
        let old = {
            let mut i = self.lock();
            let old = i.user.as_ref().filter(|u| u.id != user.id).map(|u| u.id.clone());
            i.user = Some(user);
            i.access = Some(Access_ { token: access, expires_at_ms: exp_ms });
            i.refresh = Some(refresh);
            i.drive_tokens.clear();
            old
        };
        if persist && let Some(old) = old {
            let _ = self.store.delete(&old);
        }
        Ok(())
    }

    /// Commit a prepared replacement while its previous session's refresh is paused.
    pub fn persist_credentials(&self) -> Result<(), AuthError> {
        let inner = self.lock();
        let (Some(user), Some(refresh)) = (&inner.user, &inner.refresh) else { return Err(AuthError::SignedOut); };
        self.store.set(&user.id, refresh)?;
        Ok(())
    }

    fn cached_access(&self) -> Option<String> {
        let i = self.lock();
        let a = i.access.as_ref()?;
        (a.expires_at_ms > now_ms() + REFRESH_MARGIN_MS).then(|| a.token.clone())
    }

    /// A bearer token for the control-plane api, valid for at least 60 s.
    pub async fn access_token(&self) -> Result<String, AuthError> {
        if let Some(t) = self.cached_access() {
            return Ok(t);
        }
        self.refresh(false).await
    }

    /// Refresh under the single-flight gate. With `force`, an existing token is not reused
    /// (used after the api answered 401 to a token we thought was fine).
    async fn refresh(&self, force: bool) -> Result<String, AuthError> {
        let stale = if force { self.lock().access.as_ref().map(|a| a.token.clone()) } else { None };
        let _gate = self.refresh_gate.lock().await;
        // Another caller may have refreshed while we waited.
        if let Some(t) = self.cached_access()
            && stale.as_deref() != Some(t.as_str())
        {
            return Ok(t);
        }
        let (api, user, refresh) = {
            let i = self.lock();
            match (i.user.clone(), i.refresh.clone()) {
                (Some(u), Some(r)) => (i.api.clone(), u, r),
                _ => return Err(AuthError::SignedOut),
            }
        };
        // Retry the same refresh token: if an earlier attempt reached the server but its response
        // was lost, the server accepts the replay for a grace window and hands out a fresh token.
        let mut delays = self.backoff.iter();
        let s = loop {
            match self.refresh_once(&api, &refresh).await {
                Ok(s) => break s,
                Err(Attempt::Revoked) => {
                    if let Err(error) = self.clear_local() { tracing::warn!("could not remove rejected credentials: {error}"); }
                    let _ = self.events.send(AuthEvent::SignedOut);
                    return Err(AuthError::SignedOut);
                }
                Err(Attempt::Transient(msg)) => match delays.next() {
                    Some(d) => tokio::time::sleep(*d).await,
                    None => return Err(AuthError::Offline(msg)),
                },
                Err(Attempt::Unauthorized) => unreachable!("only authed_once reports Unauthorized"),
                Err(Attempt::Fatal(e)) => return Err(e),
            }
        };
        let exp = claims_unverified(&s.access_token)
            .and_then(|c| c.exp)
            .map(|x| x * 1000)
            .unwrap_or_else(|| now_ms() + s.expires_in * 1000);
        // Persist the rotated token before anyone can use the new access token: the old
        // refresh token is dead on the server now. `set` updates the item in place.
        self.store.set(&user.id, &s.refresh_token)?;
        let mut i = self.lock();
        i.access = Some(Access_ { token: s.access_token.clone(), expires_at_ms: exp });
        i.refresh = Some(s.refresh_token);
        i.drive_tokens.clear();
        Ok(s.access_token)
    }

    async fn refresh_once(&self, api: &str, refresh: &str) -> Result<SessionTokens, Attempt> {
        let resp = self
            .http
            .post(format!("{api}/auth/refresh"))
            .timeout(TOKEN_REQUEST_TIMEOUT)
            .json(&serde_json::json!({ "refreshToken": refresh }))
            .send()
            .await
            .map_err(|e| Attempt::Transient(e.without_url().to_string()))?;
        let status = resp.status().as_u16();
        if resp.status().is_success() {
            let bytes = resp.bytes().await.map_err(|e| Attempt::Transient(e.without_url().to_string()))?;
            return serde_json::from_slice(&bytes).map_err(|_| Attempt::Transient("malformed session response".into()));
        }
        if transient_status(status) {
            return Err(Attempt::Transient(format!("refresh answered http {status}")));
        }
        match api_error(status, resp).await {
            AuthError::Api { status: 401, code } if code == "invalid_refresh" => Err(Attempt::Revoked),
            e => Err(Attempt::Fatal(e)),
        }
    }

    fn clear_local(&self) -> Result<(), AuthError> {
        let user = {
            let mut i = self.lock();
            i.access = None;
            i.refresh = None;
            i.drive_tokens.clear();
            i.user.take()
        };
        if let Some(u) = user { self.store.delete(&u.id)?; }
        Ok(())
    }

    /// Authenticated request with one retry after a forced refresh on `401`.
    async fn authed_json<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, AuthError> {
        let mut forced = false;
        loop {
            let token = if forced { self.refresh(true).await? } else { self.access_token().await? };
            let mut delays = self.backoff.iter();
            loop {
                match self.authed_once::<T>(&method, path, body.as_ref(), &token).await {
                    Ok(v) => return Ok(v),
                    Err(Attempt::Transient(msg)) => match delays.next() {
                        Some(d) => tokio::time::sleep(*d).await,
                        None => return Err(AuthError::Offline(msg)),
                    },
                    Err(Attempt::Unauthorized) if !forced => break,
                    Err(Attempt::Unauthorized) => return Err(AuthError::Api { status: 401, code: "unauthorized".into() }),
                    Err(Attempt::Revoked) => unreachable!("only refresh_once reports Revoked"),
                    Err(Attempt::Fatal(e)) => return Err(e),
                }
            }
            forced = true;
        }
    }

    async fn authed_once<T: serde::de::DeserializeOwned>(
        &self,
        method: &reqwest::Method,
        path: &str,
        body: Option<&serde_json::Value>,
        token: &str,
    ) -> Result<T, Attempt> {
        let url = format!("{}{path}", self.api_endpoint());
        let mut rb = self.http.request(method.clone(), url).timeout(TOKEN_REQUEST_TIMEOUT).bearer_auth(token);
        if let Some(b) = body {
            rb = rb.json(b);
        }
        let resp = rb.send().await.map_err(|e| Attempt::Transient(e.without_url().to_string()))?;
        let status = resp.status().as_u16();
        if resp.status().is_success() {
            let bytes = resp.bytes().await.map_err(|e| Attempt::Transient(e.without_url().to_string()))?;
            return serde_json::from_slice(&bytes).map_err(|_| Attempt::Transient("malformed api response".into()));
        }
        if transient_status(status) {
            return Err(Attempt::Transient(format!("api answered http {status}")));
        }
        if status == 401 {
            return Err(Attempt::Unauthorized);
        }
        Err(Attempt::Fatal(api_error(status, resp).await))
    }

    /// `GET /orgs`
    pub async fn orgs(&self) -> Result<Vec<Org>, AuthError> {
        #[derive(Deserialize)]
        struct R {
            orgs: Vec<Org>,
        }
        Ok(self.authed_json::<R>(reqwest::Method::GET, "/orgs", None).await?.orgs)
    }

    /// Drop cached drive tokens for a drive (the data plane said the token expired, e.g. close
    /// code 4401, so our clock-based cache is wrong).
    pub fn forget_drive_token(&self, drive_id: &str) {
        self.lock().drive_tokens.retain(|(d, _), _| d != drive_id);
    }

    /// `POST /drives/{id}/token`, cached until 60 s before `expiresAt`.
    pub async fn drive_token(&self, drive_id: &str, access: Access) -> Result<DriveToken, AuthError> {
        let key = (drive_id.to_string(), access);
        if let Some(t) = self.lock().drive_tokens.get(&key)
            && t.expires_at > now_ms() + REFRESH_MARGIN_MS
        {
            return Ok(t.clone());
        }
        if drive_id.is_empty() || !drive_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(AuthError::BadRequest("invalid drive id".into()));
        }
        let t: DriveToken = self
            .authed_json(
                reqwest::Method::POST,
                &format!("/drives/{drive_id}/token"),
                Some(serde_json::json!({ "access": access.as_str() })),
            )
            .await?;
        self.lock().drive_tokens.insert(key, t.clone());
        Ok(t)
    }

    /// Hold while replacing a session so its refresh cannot overwrite the new credential.
    pub async fn pause_refresh(self: &Arc<Self>) -> tokio::sync::OwnedMutexGuard<()> {
        self.refresh_gate.clone().lock_owned().await
    }

    /// Called under `pause_refresh` when another session takes ownership of the stored item.
    pub async fn retire_replaced(&self, same_account: bool) -> Result<(), AuthError> {
        if !same_account { return self.sign_out_locked().await; }
        let mut inner = self.lock();
        inner.user = None;
        inner.access = None;
        inner.refresh = None;
        inner.drive_tokens.clear();
        Ok(())
    }

    /// `POST /auth/logout`, then wipe local state and the Keychain item. The local wipe happens
    /// even if revocation or Keychain deletion fails; failures are reported to the caller.
    pub async fn sign_out(&self) -> Result<(), AuthError> {
        let _gate = self.refresh_gate.lock().await;
        self.sign_out_locked().await
    }

    async fn sign_out_locked(&self) -> Result<(), AuthError> {
        let (api, refresh) = {
            let i = self.lock();
            (i.api.clone(), i.refresh.clone())
        };
        let mut result = Ok(());
        if let Some(r) = refresh {
            let sent = self.http.post(format!("{api}/auth/logout")).timeout(TOKEN_REQUEST_TIMEOUT).json(&serde_json::json!({ "refreshToken": r })).send().await;
            result = match sent {
                Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 401 => Ok(()),
                Ok(resp) => Err(api_error(resp.status().as_u16(), resp).await),
                Err(e) => Err(e.into()),
            };
        }
        let local = self.clear_local();
        let _ = self.events.send(AuthEvent::SignedOut);
        local.and(result)
    }
}

/// A [`TokenProvider`] for one drive's data-plane token.
pub struct DriveTokenSource {
    pub session: Arc<Session>,
    pub drive_id: String,
    pub access: Access,
}

impl DriveTokenSource {
    /// Current credentials, including the endpoint assigned to this drive.
    pub async fn credentials(&self) -> Result<DriveToken, AuthError> {
        self.session.drive_token(&self.drive_id, self.access).await
    }

    /// Invalidate a server-rejected token before minting its replacement.
    pub async fn refresh_credentials(&self) -> Result<DriveToken, AuthError> {
        self.session.forget_drive_token(&self.drive_id);
        self.credentials().await
    }
}

#[async_trait]
impl TokenProvider for DriveTokenSource {
    async fn token(&self) -> Result<String, AuthError> {
        Ok(self.credentials().await?.token)
    }
}

#[async_trait]
impl TokenProvider for Session {
    async fn token(&self) -> Result<String, AuthError> {
        self.access_token().await
    }
}
