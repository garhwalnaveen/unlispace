use std::sync::Arc;

use async_trait::async_trait;

use crate::error::Result;

/// A bearer token, optionally with the endpoint it is valid for (a drive token's endpoint can
/// change when the token is re-minted).
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderToken {
    pub token: String,
    /// `None` keeps the endpoint the client was built with.
    pub endpoint: Option<String>,
}

impl ProviderToken {
    pub fn new(token: impl Into<String>) -> Self {
        ProviderToken { token: token.into(), endpoint: None }
    }
    pub fn with_endpoint(token: impl Into<String>, endpoint: impl Into<String>) -> Self {
        ProviderToken { token: token.into(), endpoint: Some(endpoint.into()) }
    }
}

// Never print the token.
impl std::fmt::Debug for ProviderToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderToken").field("endpoint", &self.endpoint).finish_non_exhaustive()
    }
}

/// Source of bearer tokens, consulted for every request.
#[async_trait]
pub trait TokenProvider: Send + Sync {
    /// The current token. Implementations should cache and refresh it as needed.
    async fn token(&self) -> Result<ProviderToken>;

    /// Called after the server rejected the token (HTTP 401, or WebSocket close 4401). Return a
    /// freshly minted token. The default just asks `token()` again.
    async fn refresh(&self) -> Result<ProviderToken> {
        self.token().await
    }
}

#[derive(Clone)]
pub(crate) enum Auth {
    Static(String),
    Provider(Arc<dyn TokenProvider>),
}
