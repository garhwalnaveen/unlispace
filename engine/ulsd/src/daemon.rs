//! `ulsd daemon`: paths, startup and shutdown.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};

use crate::cli::SecretStoreKind;
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

/// Command-line overrides for `ulsd daemon`. All `None`/default = the per-user locations.
#[derive(Debug, Clone, Default)]
pub struct DaemonOptions {
    pub socket: Option<PathBuf>,
    pub state_dir: Option<PathBuf>,
    pub secret_store: SecretStoreKind,
    pub read_only: bool,
}

pub fn default_config() -> Result<EngineConfig> {
    config_for(&DaemonOptions::default())
}

/// With `state_dir`, everything the daemon writes (state file, `drives/<id>/` journals, shard
/// cache, socket default, mount root) lives under it; nothing under the user's home is touched.
pub fn config_for(o: &DaemonOptions) -> Result<EngineConfig> {
    let (state_path, mount_root, cache_dir) = match &o.state_dir {
        Some(d) => (d.join("state.json"), d.join("mnt"), Some(d.join("cache"))),
        None => (state_path()?, mount_root()?, None),
    };
    let secrets: Arc<dyn uls_auth::SecretStore> = match o.secret_store {
        SecretStoreKind::Keychain => uls_auth::default_store(),
        SecretStoreKind::Memory => Arc::new(uls_auth::MemoryStore::new()),
    };
    Ok(EngineConfig {
        version: env!("CARGO_PKG_VERSION").to_string(),
        state_path,
        mount_root,
        cache_dir,
        secrets,
        default_endpoint: std::env::var("ULS_ENDPOINT").unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string()),
    })
}

pub fn socket_for(o: &DaemonOptions) -> Result<PathBuf> {
    match (&o.socket, &o.state_dir) {
        (Some(s), _) => Ok(s.clone()),
        (None, Some(d)) => Ok(d.join("ulsd.sock")),
        (None, None) => socket_path(),
    }
}

pub async fn run(o: DaemonOptions) -> Result<()> {
    let cfg = config_for(&o)?;
    let sock = socket_for(&o)?;
    let dir = match &o.state_dir {
        Some(d) => Some(d.clone()),
        None if o.socket.is_none() => Some(support_dir()?),
        None => None,
    };
    if let Some(d) = dir {
        // The directory that holds our state is private to the user. (A custom socket's own
        // directory is left alone: it may be /tmp.)
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&d).with_context(|| format!("create {}", d.display()))?;
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700))?;
    }
    run_with(cfg, sock, adapter(o.read_only)).await
}

pub fn default_adapter() -> Arc<dyn MountAdapter> {
    adapter(false)
}

/// SMB (with the `smb` feature) or the NFS fallback. The SMB backend has no read-only mode, so
/// `--read-only` always selects the NFS adapter.
pub fn adapter(read_only: bool) -> Arc<dyn MountAdapter> {
    #[cfg(feature = "smb")]
    if !read_only {
        return Arc::new(crate::smb_adapter::SmbAdapter);
    }
    Arc::new(crate::nfs_adapter::NfsAdapter { read_only })
}

pub async fn run_with(cfg: EngineConfig, sock: PathBuf, adapter: Arc<dyn MountAdapter>) -> Result<()> {
    let (listener, uid) = server::bind(&sock)?;
    let engine = Engine::new(cfg, adapter);
    engine.start().await;
    tracing::info!(socket = %sock.display(), "ulsd listening");

    let serving = tokio::spawn(server::serve(listener, uid, engine.clone()));
    tokio::select! { _ = wait_for_signal() => {}, _ = engine.stop.notified() => {} }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_dir_holds_state_cache_mounts_and_socket() {
        let o = DaemonOptions { state_dir: Some("/x/s".into()), secret_store: SecretStoreKind::Memory, ..Default::default() };
        let c = config_for(&o).unwrap();
        assert_eq!(c.state_path, PathBuf::from("/x/s/state.json"));
        assert_eq!(c.cache_dir, Some(PathBuf::from("/x/s/cache")));
        assert_eq!(c.mount_root, PathBuf::from("/x/s/mnt"));
        assert_eq!(socket_for(&o).unwrap(), PathBuf::from("/x/s/ulsd.sock"));
        // The journals are at <state_path dir>/drives/<id>, i.e. under the state dir too.
        assert_eq!(c.state_path.parent().unwrap().join("drives"), PathBuf::from("/x/s/drives"));
    }

    #[test]
    fn explicit_socket_wins_and_defaults_are_unchanged() {
        let o = DaemonOptions { socket: Some("/y/z.sock".into()), state_dir: Some("/x/s".into()), ..Default::default() };
        assert_eq!(socket_for(&o).unwrap(), PathBuf::from("/y/z.sock"));
        let d = DaemonOptions::default();
        assert_eq!(socket_for(&d).unwrap(), socket_path().unwrap());
        let c = config_for(&d).unwrap();
        assert_eq!((c.state_path, c.mount_root, c.cache_dir), (state_path().unwrap(), mount_root().unwrap(), None));
    }

    #[tokio::test]
    async fn memory_secret_store_daemon_runs_under_state_dir_without_touching_home() {
        let d = tempfile::tempdir_in("/tmp").unwrap();
        let o = DaemonOptions { state_dir: Some(d.path().join("st")), secret_store: SecretStoreKind::Memory, ..Default::default() };
        let task = tokio::spawn(run(o.clone()));
        let sock = d.path().join("st/ulsd.sock");
        for _ in 0..100 {
            if sock.exists() { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(sock.exists(), "socket under the state dir");
        let s = tokio::net::UnixStream::connect(&sock).await.unwrap();
        drop(s);
        task.abort();
    }
}
