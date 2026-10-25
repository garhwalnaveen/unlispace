use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use futures_util::StreamExt;
use uls_client::{Client, Error, ShardCache};
use uls_proto::NodeType;

const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:8787";

#[derive(Parser)]
#[command(version, about = "Unlispace engine and CLI", long_about = "Unlispace engine and CLI (M0).\n\nEnvironment:\n  ULS_ENDPOINT   Worker URL (default http://127.0.0.1:8787)\n  ULS_DEV_TOKEN  static bearer token (never printed)")]
pub struct Cli {
    #[command(subcommand)]
    /// Defaults to `daemon` when omitted (how the LaunchAgent runs it).
    pub cmd: Option<Cmd>,
}

#[derive(Subcommand)]
pub enum Cmd {
    /// Run the background daemon the Mac app talks to
    Daemon {
        /// Control socket path (default <state dir>/ulsd.sock)
        #[arg(long)]
        socket: Option<PathBuf>,
        /// Keep the state file, drive journals, shard cache, socket and mounts under this
        /// directory instead of ~/Library/Application Support/Unlispace
        #[arg(long)]
        state_dir: Option<PathBuf>,
        /// Where refresh tokens are kept. `memory` creates no Keychain item (for tests).
        #[arg(long, value_enum, default_value_t = SecretStoreKind::Keychain)]
        secret_store: SecretStoreKind,
        /// Mount drives read-only
        #[arg(long)]
        read_only: bool,
    },
    /// Sign in from a terminal (desktop PKCE flow)
    Login {
        /// Control-plane API (default $ULS_API or http://127.0.0.1:8788)
        #[arg(long)]
        api: Option<String>,
    },
    /// Upload a local file
    Put {
        drive: String,
        local: PathBuf,
        path: String,
        /// Only commit if the path's head is this version id
        #[arg(long)]
        if_version: Option<String>,
    },
    /// Download a file
    Get {
        drive: String,
        path: String,
        local: PathBuf,
        /// Download this version instead of the head
        #[arg(long)]
        version: Option<String>,
    },
    /// List a folder
    Ls { drive: String, path: Option<String> },
    /// Show metadata for a path
    Stat { drive: String, path: String },
    /// Show version history of a file (oldest first)
    Versions { drive: String, path: String },
    /// Make an old version the head again
    Restore { drive: String, path: String, version_id: String },
    /// Create a folder
    Mkdir { drive: String, path: String },
    /// Delete a file or folder
    Rm {
        drive: String,
        path: String,
        #[arg(long)]
        if_version: Option<String>,
    },
    /// Rename or move a file or folder (folder paths end with /)
    Mv {
        drive: String,
        from: String,
        to: String,
        #[arg(long)]
        if_version: Option<String>,
    },
    /// Manage drives
    Drive {
        #[command(subcommand)]
        cmd: DriveCmd,
    },
    /// Print changes as they happen
    Watch {
        drive: String,
        /// Resume after this seq (default 0 = replay everything)
        #[arg(long, default_value_t = 0)]
        since: u64,
    },
    /// Mount a drive over loopback NFSv3 (writable unless --read-only)
    Mount {
        drive: String,
        mountpoint: PathBuf,
        /// Serve and print the mount_nfs command, but do not run it
        #[arg(long)]
        no_mount: bool,
        /// TCP port for the NFS server (0 = pick a free one)
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Do not allow writes
        #[arg(long)]
        read_only: bool,
        /// Directory for this mount's write journal (default <support dir>/cli/<drive>)
        #[arg(long)]
        state_dir: Option<PathBuf>,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub enum SecretStoreKind {
    #[default]
    Keychain,
    Memory,
}

#[derive(Subcommand)]
pub enum DriveCmd {
    /// Create a drive
    Create {
        drive: String,
        /// wnam | enam | weur | eeur | apac | oc
        #[arg(long)]
        placement: Option<String>,
    },
    /// Show drive info
    Info { drive: String },
}

pub fn client(cache: bool, whole_shard_on_partial: bool) -> Result<Client> {
    let endpoint = std::env::var("ULS_ENDPOINT").unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string());
    let token = std::env::var("ULS_DEV_TOKEN").context("ULS_DEV_TOKEN is not set")?;
    let mut b = Client::builder(endpoint, token).whole_shard_on_partial(whole_shard_on_partial);
    if cache {
        match ShardCache::open_default() {
            Ok(c) => b = b.cache(Arc::new(c)),
            Err(e) => tracing::warn!("shard cache disabled: {e}"),
        }
    }
    Ok(b.build()?)
}

fn human(n: u64) -> String {
    const U: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{n} B") } else { format!("{v:.1} {}", U[i]) }
}

pub async fn run(cli: Cli) -> Result<()> {
    match cli.cmd.unwrap_or(Cmd::Daemon { socket: None, state_dir: None, secret_store: SecretStoreKind::Keychain, read_only: false }) {
        Cmd::Daemon { socket, state_dir, secret_store, read_only } => {
            return crate::daemon::run(crate::daemon::DaemonOptions { socket, state_dir, secret_store, read_only }).await;
        }
        Cmd::Login { api } => return crate::login::login(api).await,
        Cmd::Put { drive, local, path, if_version } => {
            let c = client(false, false)?;
            let started = std::time::Instant::now();
            let r = c.upload_file(&drive, &local, &path, if_version.as_deref()).await.map_err(explain)?;
            println!(
                "{path}  {}  version {}  seq {}  ({} of {} shards uploaded, {} sent, {:.1}s)",
                human(r.size), r.version_id, r.seq, r.shards_uploaded, r.shards_unique, human(r.bytes_uploaded),
                started.elapsed().as_secs_f64()
            );
        }
        Cmd::Get { drive, path, local, version } => {
            let c = client(true, false)?;
            let m = c.download_to_file(&drive, &path, version.as_deref(), &local).await.map_err(explain)?;
            println!("{path}  {}  version {}  -> {}", human(m.size), m.version_id, local.display());
        }
        Cmd::Ls { drive, path } => {
            let c = client(false, false)?;
            let entries = c.list(&drive, path.as_deref().unwrap_or("")).await.map_err(explain)?;
            for e in entries {
                match e.node_type {
                    NodeType::Folder => println!("{:>10}  {}/", "-", e.name),
                    NodeType::File => println!("{:>10}  {}", human(e.size.unwrap_or(0)), e.name),
                }
            }
        }
        Cmd::Stat { drive, path } => {
            let s = client(false, false)?.stat(&drive, &path).await.map_err(explain)?;
            println!("{}", format_stat(&s)?);
        }
        Cmd::Versions { drive, path } => {
            for v in client(false, false)?.versions(&drive, &path).await.map_err(explain)? {
                println!(
                    "{}  {:<8} {:>10}  seq {}  ts {}  {}",
                    v.version_id, v.op, v.size.map(human).unwrap_or_else(|| "-".into()), v.seq, v.ts,
                    v.actor.unwrap_or_default()
                );
            }
        }
        Cmd::Restore { drive, path, version_id } => {
            let r = client(false, false)?.restore(&drive, &path, &version_id, None).await.map_err(explain)?;
            if let Some(x) = r.results.first() {
                println!("{}  restored from {version_id}  new version {}  seq {}", x.path, x.version_id, r.seq);
            }
        }
        Cmd::Mkdir { drive, path } => {
            let r = client(false, false)?.mkdir(&drive, &path).await.map_err(explain)?;
            println!("created {}  seq {}", r.results.first().map(|x| x.path.as_str()).unwrap_or(&path), r.seq);
        }
        Cmd::Rm { drive, path, if_version } => {
            let r = client(false, false)?.delete(&drive, &path, if_version.as_deref()).await.map_err(explain)?;
            println!("deleted {path}  seq {}", r.seq);
        }
        Cmd::Mv { drive, from, to, if_version } => {
            let r = client(false, false)?.rename(&drive, &from, &to, if_version.as_deref()).await.map_err(explain)?;
            println!("moved {from} -> {to}  seq {}", r.seq);
        }
        Cmd::Drive { cmd: DriveCmd::Create { drive, placement } } => {
            let d = client(false, false)?.create_drive(&drive, placement.as_deref()).await.map_err(explain)?;
            println!("created drive {}  placement {}", d.drive_id, d.placement.as_deref().unwrap_or("auto"));
        }
        Cmd::Drive { cmd: DriveCmd::Info { drive } } => {
            let d = client(false, false)?.drive_info(&drive).await.map_err(explain)?;
            println!("{}  placement {}  headSeq {}  files {}  {}", d.drive_id, d.placement.as_deref().unwrap_or("-"), d.head_seq, d.file_count, human(d.bytes));
        }
        Cmd::Watch { drive, since } => {
            let c = client(false, false)?;
            let mut w = c.watch(&drive, since as i64);
            loop {
                tokio::select! {
                    ch = w.next() => match ch {
                        Some(Ok(uls_client::WatchEvent::Change(ch))) => println!("{}  {:<8} {}  {}", ch.seq, ch.op, ch.path, ch.version_id.unwrap_or_default()),
                        Some(Ok(uls_client::WatchEvent::Resync { head_seq, last_ev })) => println!("resync  headSeq {head_seq}  lastEv {last_ev}"),
                        Some(Err(e)) => bail!(e),
                        None => return Ok(()),
                    },
                    _ = tokio::signal::ctrl_c() => return Ok(()),
                }
            }
        }
        Cmd::Mount { drive, mountpoint, no_mount, port, read_only, state_dir } => {
            let state_dir = match state_dir {
                Some(d) => d,
                None => crate::daemon::support_dir()?.join("cli").join(&drive),
            };
            crate::nfs::mount(client(true, true)?, drive, mountpoint, no_mount, port, read_only, state_dir).await?;
        }
    }
    Ok(())
}

fn format_stat(s: &uls_proto::StatResponse) -> Result<String> {
    Ok(format!(
        "path:        {}\ntype:        {:?}\nversion:     {}\nsize:        {}\ncontentType: {}\nmtimeMs:     {}\nseq:         {}",
        s.path,
        s.node_type,
        s.version_id.as_deref().unwrap_or("-"),
        s.size.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
        s.content_type.as_deref().unwrap_or("-"),
        s.mtime_ms.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
        s.seq.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
    ))
}

/// The typed error's Display already carries the details (path, current version id).
fn explain(e: Error) -> anyhow::Error {
    anyhow::Error::new(e)
}
