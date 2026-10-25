//! `uls login`: headless desktop sign-in with PKCE.
//!
//! The contract (m1-contract §5.1) ends the browser flow at the custom-scheme URL
//! `uls://auth/callback#code=..&state=..`, which a terminal can't receive, so we print the start
//! URL and ask for that URL to be pasted back. (A loopback redirect would need a contract change.)

use std::io::{BufRead, Write};

use anyhow::{Context, Result};
use uls_auth::{DesktopFlow, Session};

use crate::daemon;
use crate::protocol::User;
use crate::state::{PersistedAuth, StateStore};

pub const DEFAULT_API: &str = "http://127.0.0.1:8788";

pub async fn login(api: Option<String>) -> Result<()> {
    let api = api.or_else(|| std::env::var("ULS_API").ok()).unwrap_or_else(|| DEFAULT_API.to_string());
    let flow = DesktopFlow::new(&api)?;
    eprintln!("Open this URL in your browser and sign in:\n\n  {}\n", flow.start_url());
    eprintln!("When the browser tries to open uls://auth/callback#code=..., copy that full URL and paste it here.");
    eprint!("callback> ");
    std::io::stderr().flush().ok();
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).context("read callback")?;
    let code = flow.parse_callback(&line)?;
    let tokens = flow.exchange(&code).await?;
    let user = store_session(&api, tokens).await?;
    eprintln!("signed in as {}", user.email);
    Ok(())
}

/// Hand the session to a running daemon (`auth.set`), or store it directly (Keychain + state file)
/// for the daemon to pick up on its next start.
async fn store_session(api: &str, tokens: uls_auth::SessionTokens) -> Result<User> {
    if let Ok(sock) = daemon::socket_path()
        && let Some(user) = try_daemon(&sock, api, &tokens).await
    {
        return Ok(user);
    }
    let store = StateStore::load(daemon::state_path()?);
    let session = Session::new(api, uls_auth::default_store())?;
    let user: User = session.sign_in(tokens)?.into();
    store.update(|s| s.auth = Some(PersistedAuth { api_endpoint: api.trim_end_matches('/').to_string(), user: user.clone() }));
    Ok(user)
}

async fn try_daemon(sock: &std::path::Path, api: &str, t: &uls_auth::SessionTokens) -> Option<User> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let stream = tokio::net::UnixStream::connect(sock).await.ok()?;
    let (rd, mut wr) = stream.into_split();
    let p = serde_json::json!({"apiEndpoint": api, "accessToken": t.access_token, "refreshToken": t.refresh_token});
    let mut line = serde_json::to_string(&serde_json::json!({"id": 1, "method": "auth.set", "params": p})).ok()?;
    line.push('\n');
    wr.write_all(line.as_bytes()).await.ok()?;
    let mut lines = BufReader::new(rd).lines();
    while let Ok(Some(l)) = lines.next_line().await {
        let v: serde_json::Value = serde_json::from_str(&l).ok()?;
        if v.get("id").and_then(|i| i.as_i64()) == Some(1) {
            return serde_json::from_value(v.get("result")?.get("user")?.clone()).ok();
        }
    }
    None
}
