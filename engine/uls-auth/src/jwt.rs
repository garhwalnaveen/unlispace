//! Unverified JWT claim reading. The daemon is not a verifier: the api and data plane verify
//! signatures. We only read `sub`, `email` and `exp` from our own access token.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Claims {
    pub sub: Option<String>,
    pub email: Option<String>,
    /// Seconds since the epoch.
    pub exp: Option<u64>,
}

/// Decode the payload segment. Returns `None` for anything that is not a three-part JWT.
pub fn claims_unverified(jwt: &str) -> Option<Claims> {
    let mut parts = jwt.split('.');
    let (_h, payload, _s) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}
