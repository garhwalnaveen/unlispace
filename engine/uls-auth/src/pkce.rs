//! PKCE (RFC 7636, S256) helpers for the desktop sign-in flow, used by `uls login`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use crate::error::AuthError;
use crate::session::SessionTokens;

/// `n` random bytes from the OS, base64url without padding.
pub fn random_token(n: usize) -> Result<String, AuthError> {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| AuthError::Internal(format!("cannot read OS randomness: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// `base64url(sha256(verifier))`
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Everything needed to start and finish one desktop sign-in.
#[derive(Debug, Clone)]
pub struct DesktopFlow {
    pub api: String,
    pub state: String,
    pub verifier: String,
}

impl DesktopFlow {
    pub fn new(api: &str) -> Result<DesktopFlow, AuthError> {
        Ok(DesktopFlow {
            api: api.trim_end_matches('/').to_string(),
            state: random_token(16)?,
            verifier: random_token(32)?,
        })
    }

    /// The URL the user opens in a browser.
    pub fn start_url(&self) -> String {
        format!(
            "{}/auth/desktop/start?state={}&code_challenge={}&code_challenge_method=S256",
            self.api,
            self.state,
            challenge(&self.verifier)
        )
    }

    /// Parse `uls://auth/callback#code=..&state=..` (a bare `code=..&state=..` fragment or query
    /// also works), check the state, and return the one-time code.
    pub fn parse_callback(&self, pasted: &str) -> Result<String, AuthError> {
        let pasted = pasted.trim();
        let frag = pasted.split_once('#').map(|x| x.1).or_else(|| pasted.split_once('?').map(|x| x.1)).unwrap_or(pasted);
        let (mut code, mut state) = (None, None);
        for kv in frag.split('&') {
            match kv.split_once('=') {
                Some(("code", v)) => code = Some(v.to_string()),
                Some(("state", v)) => state = Some(v.to_string()),
                _ => {}
            }
        }
        match (code, state) {
            (Some(c), Some(s)) if s == self.state && !c.is_empty() => Ok(c),
            (Some(_), Some(_)) => Err(AuthError::BadRequest("callback state does not match this sign-in".into())),
            _ => Err(AuthError::BadRequest("callback must contain code and state".into())),
        }
    }

    /// `POST /auth/desktop/exchange`
    pub async fn exchange(&self, code: &str) -> Result<SessionTokens, AuthError> {
        let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build()?;
        let resp = http
            .post(format!("{}/auth/desktop/exchange", self.api))
            .json(&serde_json::json!({ "code": code, "codeVerifier": self.verifier }))
            .send()
            .await?;
        crate::session::parse_session_response(resp).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7636_appendix_b_vector() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn callback_parsing() {
        let f = DesktopFlow { api: "http://x".into(), state: "st".into(), verifier: "v".into() };
        assert_eq!(f.parse_callback("uls://auth/callback#code=abc&state=st\n").unwrap(), "abc");
        assert_eq!(f.parse_callback("code=abc&state=st").unwrap(), "abc");
        assert!(f.parse_callback("uls://auth/callback#code=abc&state=other").is_err());
        assert!(f.parse_callback("uls://auth/callback").is_err());
        assert!(f.start_url().starts_with("http://x/auth/desktop/start?state=st&code_challenge="));
        assert!(f.start_url().ends_with("&code_challenge_method=S256"));
    }

    #[test]
    fn random_tokens_differ() {
        assert_ne!(random_token(32).unwrap(), random_token(32).unwrap());
        assert_eq!(random_token(32).unwrap().len(), 43);
    }
}
