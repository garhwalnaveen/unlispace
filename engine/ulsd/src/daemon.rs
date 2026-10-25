//! `ulsd daemon`: paths, startup and shutdown.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};

use crate::engine::{Engine, EngineConfig};
use crate::mount::MountAdapter;
use crate::server;

pub fn support_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().context("cannot find Application Support")?; // ~/Library/Application Support
    Ok(base.join("Unlispace"))
}

pub fn socket_path() -> Result<PathBuf> {
    Ok(support_dir()?.join("ulsd.sock"))
}

pub fn state_path() -> Result<PathBuf> {
    Ok(support_dir()?.join("state.json"))
}

pub fn mount_root() -> Result<PathBuf> {
    Ok(dirs::home_dir().context("cannot find the home directory")?.join("Unlispace"))
}

pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:8787";

pub fn default_config() -> Result<EngineConfig> {
    Ok(EngineConfig {
        version: env!("CARGO_PKG_VERSION").to_string(),
        state_path: state_path()?,
        mount_root: mount_root()?,
        cache_dir: None,
        secrets: uls_auth::default_store(),
        default_endpoint: std::env::var("ULS_ENDPOINT").unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string()),
    })
}

pub async fn run() -> Result<()> {
    let cfg = default_config()?;
    let sock = socket_path()?;
    run_with(cfg, sock, default_adapter()).await
}

pub fn default_adapter() -> Arc<dyn MountAdapter> {
    #[cfg(feature = "smb")]
    { Arc::new(crate::smb_adapter::SmbAdapter) }
    #[cfg(not(feature = "smb"))]
    { Arc::new(crate::nfs_adapter::NfsAdapter) }
}

pub async fn run_with(cfg: EngineConfig, sock: PathBuf, adapter: Arc<dyn MountAdapter>) -> Result<()> {
    let (listener, uid) = server::bind(&sock)?;
    let engine = Engine::new(cfg, adapter);
    engine.start().await;
    tracing::info!(socket = %sock.display(), "ulsd listening");

    let serving = tokio::spawn(server::serve(listener, uid, engine.clone()));
    wait_for_signal().await;
    tracing::info!("shutting down");
    serving.abort();
    engine.shutdown().await;
    let _ = std::fs::remove_file(&sock);
    Ok(())
}

async fn wait_for_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
        tracing::warn!("cannot install signal handlers");
        std::future::pending::<()>().await;
        return;
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}
