//! The daemon's view of authentication: the desktop session (M1) or, for local testing, the
//! M0 static dev token handed over with `config.set`.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use uls_auth::{Access, AuthError, DriveTokenSource, Org, SecretStore, Session};
use uls_client::{ProviderToken, TokenProvider};

use crate::mount::NeedAccess;
use crate::protocol::{AuthSetParams, AuthStatus, ErrorBody, User, code};

struct Dev {
    endpoint: String,
    token: String,
}

pub struct SetOutcome {
    pub session: Arc<Session>,
    pub user: User,
    pub previous_user: Option<String>,
}

pub struct PreparedSet {
    pub session: Arc<Session>,
    pub user: User,
    previous: Option<Arc<Session>>,
    _refresh_guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl PreparedSet {
    pub async fn persist(&mut self) -> Result<(), ErrorBody> {
        self._refresh_guard = match &self.previous { Some(session) => Some(session.pause_refresh().await), None => None };
        self.session.persist_credentials().map_err(map_auth_err)
    }
}

pub struct AuthHub {
    secrets: Arc<dyn SecretStore>,
    session: Mutex<Option<Arc<Session>>>,
    dev: Mutex<Option<Dev>>,
    default_endpoint: String,
}

impl From<uls_auth::User> for User {
    fn from(u: uls_auth::User) -> User {
        User { id: u.id, email: u.email }
    }
}

pub fn map_auth_err(e: AuthError) -> ErrorBody {
    match e {
        AuthError::SignedOut => ErrorBody::new(code::UNAUTHORIZED, "signed out"),
        AuthError::Offline(m) => ErrorBody::new(code::OFFLINE, m),
        AuthError::Api { status: 401 | 403, .. } => ErrorBody::new(code::UNAUTHORIZED, "the api rejected the credentials"),
        AuthError::Api { status: 404, .. } => ErrorBody::new(code::NO_SUCH_DRIVE, "no such drive"),
        AuthError::Api { status, code: c } => ErrorBody::internal(format!("api error {status}: {c}")),
        AuthError::BadRequest(m) => ErrorBody::bad_request(m),
        AuthError::Store(m) | AuthError::Internal(m) => ErrorBody::internal(m),
    }
}

impl AuthHub {
    pub fn new(secrets: Arc<dyn SecretStore>, default_endpoint: String) -> AuthHub {
        AuthHub { secrets, session: Mutex::new(None), dev: Mutex::new(None), default_endpoint }
    }

    fn sess(&self) -> std::sync::MutexGuard<'_, Option<Arc<Session>>> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn devl(&self) -> std::sync::MutexGuard<'_, Option<Dev>> {
        self.dev.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn session(&self) -> Option<Arc<Session>> {
        self.sess().clone()
    }

    pub fn has_session(&self) -> bool {
        self.session().is_some_and(|s| s.is_signed_in())
    }

    pub fn has_dev(&self) -> bool {
        self.devl().is_some()
    }

    pub fn is_authenticated(&self) -> bool {
        self.has_session() || self.has_dev()
    }

    /// Read credentials without publishing them; the engine fences a late restore against account changes.
    pub fn load_saved(&self, api: &str, user: &User) -> Result<Option<Arc<Session>>, ErrorBody> {
        let (s, found) = Session::restore(api, uls_auth::User { id: user.id.clone(), email: user.email.clone() }, self.secrets.clone())
            .map_err(map_auth_err)?;
        if !found {
            return Ok(None);
        }
        Ok(Some(Arc::new(s)))
    }

    pub fn install_saved(&self, session: Arc<Session>) { *self.sess() = Some(session); }

    /// Validate a replacement; the engine drains old journals before persisting credentials.
    pub async fn prepare_set(&self, p: AuthSetParams) -> Result<PreparedSet, ErrorBody> {
        let previous = self.session();
        let s = Session::new(&p.api_endpoint, self.secrets.clone()).map_err(map_auth_err)?;
        let user: User = s
            .prepare_sign_in_with_tokens(&p.api_endpoint, p.access_token, p.refresh_token)
            .await
            .map_err(map_auth_err)?
            .into();
        Ok(PreparedSet { session: Arc::new(s), user, previous, _refresh_guard: None })
    }

    pub async fn install(&self, prepared: PreparedSet) -> SetOutcome {
        let PreparedSet { session, user, previous, _refresh_guard } = prepared;
        let previous_user = previous.as_ref().and_then(|old| old.user()).map(|u| u.id);
        if let Some(old) = previous {
            // Finish cleanup before a later switch can reuse this user's Keychain account.
            if let Err(error) = old.retire_replaced(previous_user.as_ref() == Some(&user.id)).await {
                tracing::warn!("could not clean up replaced session: {error}");
            }
        }
        *self.sess() = Some(session.clone());
        SetOutcome { session, user, previous_user }
    }

    pub async fn set(&self, p: AuthSetParams) -> Result<SetOutcome, ErrorBody> {
        let mut prepared = self.prepare_set(p).await?;
        prepared.persist().await?;
        Ok(self.install(prepared).await)
    }

    /// `config.set` dev-token path.
    pub fn set_dev(&self, endpoint: Option<String>, token: Option<String>) {
        let mut d = self.devl();
        let prev = d.take();
        let endpoint = endpoint.or(prev.as_ref().map(|p| p.endpoint.clone()));
        let token = token.or(prev.map(|p| p.token));
        *d = token.map(|token| Dev { endpoint: endpoint.unwrap_or_else(|| self.default_endpoint.clone()), token });
    }

    pub fn status(&self) -> AuthStatus {
        match self.session().filter(|s| s.is_signed_in()) {
            Some(s) => AuthStatus {
                signed_in: true,
                user: s.user().map(Into::into),
                api_endpoint: Some(s.api_endpoint()),
            },
            None => AuthStatus { signed_in: false, user: None, api_endpoint: None },
        }
    }

    pub async fn orgs(&self) -> Result<Vec<Org>, ErrorBody> {
        match self.session().filter(|s| s.is_signed_in()) {
            Some(s) => s.orgs().await.map_err(map_auth_err),
            None => Err(ErrorBody::new(code::UNAUTHORIZED, "not signed in")),
        }
    }

    pub async fn mount_access(&self, drive: &str) -> Result<NeedAccess, ErrorBody> {
        let Some(session) = self.session() else { return Ok(NeedAccess::Write); };
        let viewer = session.orgs().await.map_err(map_auth_err)?.iter().flat_map(|o| &o.drives)
            .any(|d| d.id == drive && d.access == Some(Access::Read));
        if viewer { return Ok(NeedAccess::Read); }
        match session.drive_token(drive, Access::Write).await {
            Ok(_) => Ok(NeedAccess::Write),
            Err(AuthError::Api {status:403,code}) if code == "over_quota" => {
                session.drive_token(drive, Access::Read).await.map_err(map_auth_err)?;
                Ok(NeedAccess::Read)
            },
            Err(e) => Err(map_auth_err(e)),
        }
    }

    pub fn token_provider(self: &Arc<Self>, drive: &str, access: NeedAccess) -> Arc<dyn TokenProvider> {
        Arc::new(DriveProvider { hub: self.clone(), drive: drive.into(), access })
    }

    pub fn clear_dev(&self) {
        *self.devl() = None;
    }
}

/// Resolve through the current session on every request, including after auth.set replaces it.
struct DriveProvider {
    hub: Arc<AuthHub>,
    drive: String,
    access: NeedAccess,
}

impl DriveProvider {
    async fn credentials(&self, refresh: bool) -> Result<ProviderToken, AuthError> {
        if let Some(session) = self.hub.session().filter(|s| s.is_signed_in()) {
            let source = DriveTokenSource {
                session,
                drive_id: self.drive.clone(),
                access: match self.access { NeedAccess::Read => Access::Read, NeedAccess::Write => Access::Write },
            };
            let mut read_only = false;
            let token = match if refresh { source.refresh_credentials().await } else { source.credentials().await } {
                Ok(token) => token,
                // Expiry must not cut off reads on an already mounted drive; writes still fail at the server.
                Err(AuthError::Api { status: 403, code }) if code == "over_quota" && self.access == NeedAccess::Write => {
                    read_only = true;
                    source.session.drive_token(&self.drive, Access::Read).await?
                },
                Err(e) => return Err(e),
            };
            let mut token = ProviderToken::with_endpoint(token.token, token.endpoint);
            token.read_only = read_only;
            return Ok(token);
        }
        match &*self.hub.devl() {
            Some(dev) => Ok(ProviderToken::with_endpoint(dev.token.clone(), dev.endpoint.clone())),
            None => Err(AuthError::SignedOut),
        }
    }
}

#[async_trait]
impl TokenProvider for DriveProvider {
    async fn token(&self) -> uls_client::Result<ProviderToken> {
        self.credentials(false).await.map_err(|e| uls_client::Error::Auth(e.to_string()))
    }

    async fn refresh(&self) -> uls_client::Result<ProviderToken> {
        self.credentials(true).await.map_err(|e| uls_client::Error::Auth(e.to_string()))
    }
}
