/// Errors never contain token values.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    /// No session, or the session was revoked (`401 invalid_refresh`). Everything was cleared.
    #[error("signed out")]
    SignedOut,
    /// Could not reach the api.
    #[error("offline: {0}")]
    Offline(String),
    /// The api answered with an error.
    #[error("api error {status}: {code}")]
    Api { status: u16, code: String },
    #[error("{0}")]
    BadRequest(String),
    #[error("secret store: {0}")]
    Store(String),
    #[error("{0}")]
    Internal(String),
}

impl From<reqwest::Error> for AuthError {
    fn from(e: reqwest::Error) -> Self {
        // `without_url` keeps query strings out of messages.
        AuthError::Offline(e.without_url().to_string())
    }
}

impl From<crate::store::StoreError> for AuthError {
    fn from(e: crate::store::StoreError) -> Self {
        AuthError::Store(e.0)
    }
}
