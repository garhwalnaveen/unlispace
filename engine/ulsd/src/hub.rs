//! The daemon's view of authentication: the desktop session (M1) or, for local testing, the
//! M0 static dev token handed over with `config.set`.

use std::sync::{Arc, Mutex};

use uls_auth::{Access, AuthError, Org, SecretStore, Session};

use crate::mount::NeedAccess;
use crate::protocol::{AuthSetParams, AuthStatus, ErrorBody, User, code};

/// What a data-plane caller needs. Never logged, never `Debug`-printed.
pub struct Creds {
    pub endpoint: String,
    pub token: String,
    pub expires_at_ms: u64,
}

struct Dev {
    endpoint: String,
    token: String,
}

pub struct SetOutcome {
    pub session: Arc<Session>,
    pub user: User,
    pub previous_user: Option<String>,
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

    /// Resume after a restart. Returns the session if a refresh token was found.
    pub fn restore(&self, api: &str, user: &User) -> Result<Option<Arc<Session>>, ErrorBody> {
        let (s, found) = Session::restore(api, uls_auth::User { id: user.id.clone(), email: user.email.clone() }, self.secrets.clone())
            .map_err(map_auth_err)?;
        if !found {
            return Ok(None);
        }
        let s = Arc::new(s);
        *self.sess() = Some(s.clone());
        Ok(Some(s))
    }

    /// `auth.set`
    pub async fn set(&self, p: AuthSetParams) -> Result<SetOutcome, ErrorBody> {
        let s = Session::new(&p.api_endpoint, self.secrets.clone()).map_err(map_auth_err)?;
        let user: User = s
            .sign_in_with_tokens(&p.api_endpoint, p.access_token, p.refresh_token)
            .await
            .map_err(map_auth_err)?
            .into();
        let s = Arc::new(s);
        let old = self.sess().replace(s.clone());
        let previous_user = old.as_ref().and_then(|o| o.user()).map(|u| u.id);
        if let (Some(old), Some(prev)) = (old, previous_user.as_ref())
            && *prev != user.id
        {
            // A different account: revoke it and wipe its Keychain item. (Same account: the new
            // session already wrote its refresh token under the same Keychain account, and
            // signing the old one out would delete that item.)
            tokio::spawn(async move {
                let _ = old.sign_out().await;
            });
        }
        Ok(SetOutcome { session: s, user, previous_user })
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

    pub async fn drive_creds(&self, drive: &str, access: NeedAccess) -> Result<Creds, ErrorBody> {
        if let Some(s) = self.session().filter(|s| s.is_signed_in()) {
            let a = match access {
                NeedAccess::Read => Access::Read,
                NeedAccess::Write => Access::Write,
            };
            let t = s.drive_token(drive, a).await.map_err(map_auth_err)?;
            return Ok(Creds { endpoint: t.endpoint, token: t.token, expires_at_ms: t.expires_at });
        }
        match &*self.devl() {
            Some(d) => Ok(Creds { endpoint: d.endpoint.clone(), token: d.token.clone(), expires_at_ms: u64::MAX }),
            None => Err(ErrorBody::new(code::UNAUTHORIZED, "not signed in")),
        }
    }

    pub fn forget(&self, drive: &str) {
        if let Some(s) = self.session() {
            s.forget_drive_token(drive);
        }
    }

    pub fn clear_dev(&self) {
        *self.devl() = None;
    }
}
