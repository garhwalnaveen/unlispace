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
        && let Some(user) = try_daemon(&sock, api, &tokens).await?
    {
        return Ok(user);
    }
    let store = StateStore::load(daemon::state_path()?);
    let session = Session::new(api, uls_auth::default_store())?;
    let user: User = session.sign_in(tokens)?.into();
    store.try_update(|s| s.auth = Some(PersistedAuth { api_endpoint: api.trim_end_matches('/').to_string(), user: user.clone() }))?;
    Ok(user)
}

async fn try_daemon(sock: &std::path::Path, api: &str, t: &uls_auth::SessionTokens) -> Result<Option<User>> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let stream = match tokio::net::UnixStream::connect(sock).await { Ok(stream) => stream, Err(_) => return Ok(None) };
    let (rd, mut wr) = stream.into_split();
    let p = serde_json::json!({"apiEndpoint": api, "accessToken": t.access_token, "refreshToken": t.refresh_token});
    let mut line = serde_json::to_string(&serde_json::json!({"id": 1, "method": "auth.set", "params": p}))?;
    line.push('\n');
    wr.write_all(line.as_bytes()).await.context("send session to engine")?;
    let mut lines = BufReader::new(rd).lines();
    while let Some(line) = lines.next_line().await.context("read engine sign-in response")? {
        let response: serde_json::Value = serde_json::from_str(&line).context("invalid engine sign-in response")?;
        if response.get("id").and_then(|v|v.as_i64()) != Some(1) { continue; }
        if let Some(error) = response.get("error") { anyhow::bail!("Engine could not save sign-in: {}", error.get("message").and_then(|v|v.as_str()).unwrap_or("unknown error")); }
        let user = response.get("result").and_then(|v|v.get("user")).cloned().context("engine sign-in response missing user")?;
        return Ok(Some(serde_json::from_value(user)?));
    }
    anyhow::bail!("Engine disconnected before acknowledging sign-in")
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    #[tokio::test]
    async fn a_live_engine_rejection_does_not_fall_back_to_writing_its_state_file() {
        use tokio::io::{AsyncBufReadExt,AsyncWriteExt,BufReader};
        let dir=tempfile::tempdir().unwrap();let socket=dir.path().join("test.sock");let listener=tokio::net::UnixListener::bind(&socket).unwrap();
        let server=tokio::spawn(async move {
            let (mut stream,_)=listener.accept().await.unwrap();let mut line=String::new();BufReader::new(&mut stream).read_line(&mut line).await.unwrap();
            stream.write_all(b"{\"id\":1,\"error\":{\"code\":\"internal\",\"message\":\"Cannot save local state\"}}\n").await.unwrap();
        });
        let session=uls_auth::SessionTokens{access_token:"access-test".into(),refresh_token:"refresh-test".into(),expires_in:900,user:uls_auth::User{id:"test".into(),email:"test@example.invalid".into()},account_created:false};
        let error=try_daemon(&socket,"http://127.0.0.1",&session).await.unwrap_err();assert!(error.to_string().contains("Cannot save local state"));server.await.unwrap();
    }
}
