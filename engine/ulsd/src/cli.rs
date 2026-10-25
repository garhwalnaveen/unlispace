// The same data command runs in the daemon's session without exporting bearer tokens.
macro_rules! println { ($($arg:tt)*) => { crate::cli::line(format_args!($($arg)*)) }; }

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use futures_util::StreamExt;
use uls_client::{Client, Error, ShardCache};
use uls_proto::NodeType;

const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:8787";

#[derive(Parser, serde::Serialize, serde::Deserialize)]
#[command(version, about = "Unlispace engine and CLI", long_about = "Unlispace engine and CLI (M0).\n\nEnvironment:\n  ULS_ENDPOINT   Worker URL (default http://127.0.0.1:8787)\n  ULS_DEV_TOKEN  static bearer token (never printed)")]
pub struct Cli {
    #[command(subcommand)]
    /// Defaults to `daemon` when omitted (how the LaunchAgent runs it).
    pub cmd: Option<Cmd>,
    #[arg(long, global = true)]
    pub json: bool,
}

#[derive(Subcommand, serde::Serialize, serde::Deserialize)]
pub enum Cmd {
    /// Run the background daemon the Mac app talks to
    Daemon {
        #[command(subcommand)]
        action: Option<DaemonAction>,
        /// Control socket path (default <state dir>/ulsd.sock)
        #[arg(long, global = true)]
        socket: Option<PathBuf>,
        /// Keep the state file, drive journals, shard cache, socket and mounts under this
        /// directory instead of ~/Library/Application Support/Unlispace
        #[arg(long, global = true)]
        state_dir: Option<PathBuf>,
        /// Where refresh tokens are kept. `memory` creates no Keychain item (for tests).
        #[arg(long, global = true, value_enum, default_value_t = SecretStoreKind::Keychain)]
        secret_store: SecretStoreKind,
        /// Mount drives read-only
        #[arg(long, global = true)]
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
    Restore { drive: String, path: String, #[arg(required_unless_present = "at", conflicts_with = "at")] version_id: Option<String>, #[arg(long)] at: Option<String>, #[arg(long)] dry_run: bool },
    Drives,
    Use { workspace: String },
    Mounts,
    Unmount { drive: String },
    Status,
    Uploads { #[arg(long)] watch: bool },
    Pin { drive: String, path: String },
    Unpin { drive: String, path: String },
    History { drive: String, path: String },
    Show { drive: String, path: String, #[arg(long, conflicts_with = "version")] at: Option<String>, #[arg(long)] version: Option<String> },
    Fork { drive: String, new_name: String },
    Keys { #[command(subcommand)] action: Option<KeyAction> },
    Upload { #[arg(required = true, num_args = 2..)] paths: Vec<String> },
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
        mountpoint: Option<PathBuf>,
        #[arg(long)]
        foreground: bool,
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

#[derive(Subcommand, serde::Serialize, serde::Deserialize)]
pub enum DaemonAction { Start, Stop, Status }

#[derive(Subcommand, serde::Serialize, serde::Deserialize)]
pub enum KeyAction {
    List,
    Create { #[arg(long)] name: String, #[arg(long)] org: String, #[arg(long)] drive: Vec<String>, #[arg(long, default_value = "read")] access: String },
    Revoke { id: String },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum, serde::Serialize, serde::Deserialize)]
pub enum SecretStoreKind {
    #[default]
    Keychain,
    Memory,
}

#[derive(Subcommand, serde::Serialize, serde::Deserialize)]
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
    if std::env::var_os("ULS_DEV_TOKEN").is_none() && cli.cmd.as_ref().and_then(data_drive).is_some() {
        let value = crate::control::call("cli.run",serde_json::to_value(&cli)?).await?;
        let output: Vec<u8> = serde_json::from_value(value["output"].clone())?;
        use std::io::Write;
        std::io::stdout().write_all(&output)?;
        return Ok(());
    }
    run_inner(cli).await
}

fn run_inner(cli: Cli) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
    Box::pin(async move {
    let json = cli.json;
    let mut cmd = cli.cmd.unwrap_or(Cmd::Daemon { action: None, socket: None, state_dir: None, secret_store: SecretStoreKind::Keychain, read_only: false });
    let drive = match &mut cmd {
        Cmd::Put {drive,..} | Cmd::Get {drive,..} | Cmd::Ls {drive,..} | Cmd::Stat {drive,..} | Cmd::Versions {drive,..} | Cmd::History {drive,..} | Cmd::Restore {drive,..} | Cmd::Show {drive,..} | Cmd::Mkdir {drive,..} | Cmd::Rm {drive,..} | Cmd::Mv {drive,..} | Cmd::Watch {drive,..} | Cmd::Mount {drive,..} | Cmd::Pin {drive,..} | Cmd::Unpin {drive,..} | Cmd::Fork {drive,..} | Cmd::Drive {cmd: DriveCmd::Info {drive}} => Some(drive),
        _ => None,
    };
    if let Some(drive) = drive && REQUEST_CLIENT.try_with(|_|()).is_err() && crate::control::socket()?.exists() {
        let value = crate::control::call("drive.resolve", serde_json::json!({"driveId":drive})).await?;
        *drive = value["driveId"].as_str().context("missing driveId")?.to_string();
    }
    match cmd {
        Cmd::Daemon { action, socket, state_dir, secret_store, read_only } => {
            let opts = crate::daemon::DaemonOptions { socket, state_dir, secret_store, read_only };
            let socket = crate::daemon::socket_for(&opts)?;
            match action {
                None => return crate::daemon::run(opts).await,
                Some(DaemonAction::Status) => print_value(crate::control::call_at(&socket,"status",serde_json::json!({})).await?,json)?,
                Some(DaemonAction::Stop) => { crate::control::call_at(&socket,"daemon.stop",serde_json::json!({})).await?; }
                Some(DaemonAction::Start) => {
                    if crate::control::call_at(&socket,"status",serde_json::json!({})).await.is_ok() { return Ok(()); }
                    let mut command = std::process::Command::new(std::env::current_exe()?);
                    command.arg("daemon").arg("--socket").arg(&socket);
                    if let Some(dir) = opts.state_dir { command.arg("--state-dir").arg(dir); }
                    command.arg("--secret-store").arg(if secret_store == SecretStoreKind::Memory {"memory"} else {"keychain"});
                    if read_only { command.arg("--read-only"); }
                    use std::os::unix::process::CommandExt;
                    command.process_group(0);
                    let mut child = command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn()?;
                    for _ in 0..100 {
                        if crate::control::call_at(&socket,"status",serde_json::json!({})).await.is_ok() { println!("daemon started"); return Ok(()); }
                        if child.try_wait()?.is_some() { bail!("daemon exited before starting"); }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    bail!("daemon did not become ready");
                }
            }
        }
        Cmd::Login { api } => return crate::login::login(api).await,
        Cmd::Put { drive, local, path, if_version } => {
            let c = drive_client(&drive, false, false)?;
            let started = std::time::Instant::now();
            let r = c.upload_file(&drive, &local, &path, if_version.as_deref()).await.map_err(explain)?;
            println!(
                "{path}  {}  version {}  seq {}  ({} of {} shards uploaded, {} sent, {:.1}s)",
                human(r.size), r.version_id, r.seq, r.shards_uploaded, r.shards_unique, human(r.bytes_uploaded),
                started.elapsed().as_secs_f64()
            );
        }
        Cmd::Get { drive, path, local, version } => {
            let c = drive_client(&drive, true, false)?;
            let m = c.download_to_file(&drive, &path, version.as_deref(), &local).await.map_err(explain)?;
            if json { print_value(serde_json::json!({"path":path,"size":m.size,"versionId":m.version_id,"local":local}),true)?; }
            else { println!("{path}  {}  version {}  -> {}", human(m.size), m.version_id, local.display()); }
        }
        Cmd::Ls { drive, path } => {
            let c = drive_client(&drive, false, false)?;
            let entries = c.list(&drive, path.as_deref().unwrap_or("")).await.map_err(explain)?;
            if json { print_value(serde_json::to_value(entries)?,true)?; return Ok(()); }
            for e in entries {
                match e.node_type {
                    NodeType::Folder => println!("{:>10}  {}/", "-", e.name),
                    NodeType::File => println!("{:>10}  {}", human(e.size.unwrap_or(0)), e.name),
                }
            }
        }
        Cmd::Stat { drive, path } => {
            let s = drive_client(&drive, false, false)?.stat(&drive, &path).await.map_err(explain)?;
            if json { print_value(serde_json::to_value(s)?,true)?; } else { println!("{}", format_stat(&s)?); }
        }
        Cmd::Versions { drive, path } | Cmd::History { drive, path } => {
            let versions = drive_client(&drive, false, false)?.versions(&drive, &path).await.map_err(explain)?;
            if json { print_value(serde_json::to_value(versions)?,true)?; return Ok(()); }
            for v in versions {
                println!(
                    "{}  {:<8} {:>10}  seq {}  ts {}  {}",
                    v.version_id, v.op, v.size.map(human).unwrap_or_else(|| "-".into()), v.seq, v.ts,
                    v.actor.unwrap_or_default()
                );
            }
        }
        Cmd::Restore { drive, path, version_id, at, dry_run } => {
            let c = drive_client(&drive,false,false)?;
            if let Some(at) = at {
                let ts = crate::history::instant(&at)?;
                let folder = crate::history::is_folder(&c,&drive,&path).await?;
                if folder {
                    let ops = crate::history::plan(&c,&drive,&path,ts).await?;
                    if dry_run { print_value(serde_json::to_value(ops)?,true)?; }
                    else if !ops.is_empty() { print_value(serde_json::to_value(c.commit(&drive,ops).await?)?,json)?; }
                } else {
                    let v = crate::history::at(&c,&drive,&path,ts).await?.filter(|v| v.op != "delete").context("path did not exist at that instant")?;
                    if dry_run { print_value(serde_json::json!({"path":path,"versionId":v.version_id}),true)?; }
                    else { print_value(serde_json::to_value(c.restore(&drive,&path,&v.version_id,None).await?)?,json)?; }
                }
            } else {
                let version = version_id.context("version or --at required")?;
                if dry_run { print_value(serde_json::json!({"path":path,"versionId":version}),true)?; }
                else { let r = c.restore(&drive,&path,&version,None).await?; println!("{path}  restored from {version}  seq {}",r.seq); }
            }
        }
        Cmd::Show { drive, path, at, version } => {
            let c = drive_client(&drive,true,false)?;
            let version = if let Some(at) = at {
                Some(crate::history::at(&c,&drive,&path,crate::history::instant(&at)?).await?.filter(|v|v.op != "delete").context("path did not exist at that instant")?.version_id)
            } else { version };
            if json { let mut data = Vec::new(); let manifest = c.download(&drive,&path,version.as_deref(),&mut data).await?;
                print_value(serde_json::json!({"manifest":manifest,"bytes":data}),true)?;
            } else if CAPTURE.try_with(|_|()).is_ok() {
                let mut bytes = Vec::new(); c.download(&drive,&path,version.as_deref(),&mut bytes).await?;
                CAPTURE.with(|out|out.borrow_mut().extend(bytes));
            } else { let mut out = tokio::io::stdout(); c.download(&drive,&path,version.as_deref(),&mut out).await?; }
        }
        Cmd::Drives => print_value(crate::control::call("drives.list",serde_json::json!({})).await?,json)?,
        Cmd::Use {workspace} => print_value(crate::control::call("workspace.use",serde_json::json!({"workspace":workspace})).await?,json)?,
        Cmd::Mounts => print_value(crate::control::call("mounts.list",serde_json::json!({})).await?,json)?,
        Cmd::Status => print_value(crate::control::call("status",serde_json::json!({})).await?,json)?,
        Cmd::Unmount {drive} => { crate::control::call("drive.unmount",serde_json::json!({"driveId":drive})).await?; }
        Cmd::Pin {drive,path} => { crate::control::call("drive.pin",serde_json::json!({"driveId":drive,"path":path,"pinned":true})).await?; }
        Cmd::Unpin {drive,path} => { crate::control::call("drive.pin",serde_json::json!({"driveId":drive,"path":path,"pinned":false})).await?; }
        Cmd::Uploads {watch} => loop {
            print_value(crate::control::call("uploads",serde_json::json!({})).await?,json)?;
            if !watch { break; }
            tokio::select! { _ = tokio::signal::ctrl_c() => break, _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {} }
        },
        Cmd::Fork {drive,new_name} => print_value(api("POST",format!("/drives/{drive}/fork"),serde_json::json!({"name":new_name})).await?,json)?,
        Cmd::Keys {action} => {
            let (method,path,body) = match action.unwrap_or(KeyAction::List) {
                KeyAction::List => ("GET","/keys".into(),serde_json::Value::Null),
                KeyAction::Create {name,org,drive,access} => ("POST","/keys".into(),serde_json::json!({"label":name,"workspaceId":org,"drives":if drive.is_empty() {None} else {Some(drive)},"access":access})),
                KeyAction::Revoke {id} => { if !id.bytes().all(|b|b.is_ascii_alphanumeric() || b == b'_' || b == b'-') { bail!("invalid key id"); } ("DELETE",format!("/keys/{id}"),serde_json::Value::Null) },
            };
            print_value(api(method,path,body).await?,json)?;
        }
        Cmd::Upload {mut paths} => {
            let destination = paths.pop().context("destination required")?;
            let (drive,folder) = destination.split_once(':').context("destination must be drive:folder")?;
            let mut files = Vec::new();
            let mut todo = Vec::new();
            for local in paths { let local = std::fs::canonicalize(local)?; let name = local.file_name().context("source needs a name")?.to_string_lossy(); let path = format!("{}/{}",folder.trim_matches('/'),name).trim_start_matches('/').to_string(); todo.push((local,path)); }
            while let Some((local,path)) = todo.pop() {
                let md = std::fs::symlink_metadata(&local)?;
                if md.file_type().is_symlink() { bail!("upload does not follow symlinks"); }
                if md.is_dir() { files.push(serde_json::json!({"local":local,"path":path,"directory":true})); for child in std::fs::read_dir(local)? { let child = child?; let path = format!("{}/{}",path,child.file_name().to_string_lossy()); todo.push((child.path(),path)); } }
                else if md.is_file() { files.push(serde_json::json!({"local":local,"path":path})); }
                else { bail!("upload source must be a regular file or directory"); }
            }
            crate::control::call("upload.queue",serde_json::json!({"driveId":drive,"files":files})).await?;
        }
        Cmd::Mkdir { drive, path } => {
            let r = drive_client(&drive, false, false)?.mkdir(&drive, &path).await.map_err(explain)?;
            println!("created {}  seq {}", r.results.first().map(|x| x.path.as_str()).unwrap_or(&path), r.seq);
        }
        Cmd::Rm { drive, path, if_version } => {
            let r = drive_client(&drive, false, false)?.delete(&drive, &path, if_version.as_deref()).await.map_err(explain)?;
            println!("deleted {path}  seq {}", r.seq);
        }
        Cmd::Mv { drive, from, to, if_version } => {
            let r = drive_client(&drive, false, false)?.rename(&drive, &from, &to, if_version.as_deref()).await.map_err(explain)?;
            println!("moved {from} -> {to}  seq {}", r.seq);
        }
        Cmd::Drive { cmd: DriveCmd::Create { drive, placement } } => {
            let d = drive_client(&drive, false, false)?.create_drive(&drive, placement.as_deref()).await.map_err(explain)?;
            println!("created drive {}  placement {}", d.drive_id, d.placement.as_deref().unwrap_or("auto"));
        }
        Cmd::Drive { cmd: DriveCmd::Info { drive } } => {
            let d = drive_client(&drive, false, false)?.drive_info(&drive).await.map_err(explain)?;
            if json { print_value(serde_json::to_value(d)?,true)?; } else { println!("{}  placement {}  headSeq {}  files {}  {}", d.drive_id, d.placement.as_deref().unwrap_or("-"), d.head_seq, d.file_count, human(d.bytes)); }
        }
        Cmd::Watch { drive, since } => {
            if std::env::var_os("ULS_DEV_TOKEN").is_none() {
                let mut cursor = since as i64;
                loop {
                    let page:uls_proto::ChangesResponse = serde_json::from_value(crate::control::call("changes",serde_json::json!({"driveId":drive,"after":cursor})).await?)?;
                    for ch in page.changes { cursor = cursor.max(ch.ev);
                        if json { print_value(serde_json::to_value(ch)?,true)?; }
                        else { println!("{}  {:<8} {}  {}",ch.seq,ch.op,ch.path,ch.version_id.unwrap_or_default()); }
                    }
                    if page.more { continue; }
                    tokio::select! { _ = tokio::signal::ctrl_c() => return Ok(()), _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {} }
                }
            }
            let c = drive_client(&drive, false, false)?;
            let mut w = c.watch(&drive, since as i64);
            loop {
                tokio::select! {
                    ch = w.next() => match ch {
                        Some(Ok(uls_client::WatchEvent::Change(ch))) if json => print_value(serde_json::to_value(ch)?,true)?,
                        Some(Ok(uls_client::WatchEvent::Change(ch))) => println!("{}  {:<8} {}  {}", ch.seq, ch.op, ch.path, ch.version_id.unwrap_or_default()),
                        Some(Ok(uls_client::WatchEvent::Resync { head_seq, last_ev })) if json => print_value(serde_json::json!({"type":"resync","headSeq":head_seq,"lastEv":last_ev}),true)?,
                        Some(Ok(uls_client::WatchEvent::Resync { head_seq, last_ev })) => println!("resync  headSeq {head_seq}  lastEv {last_ev}"),
                        Some(Err(e)) => bail!(e),
                        None => return Ok(()),
                    },
                    _ = tokio::signal::ctrl_c() => return Ok(()),
                }
            }
        }
        Cmd::Mount { drive, mountpoint, foreground, no_mount, port, read_only, state_dir } => {
            // Legacy standalone flags retain the foreground behaviour used by the E2E harness.
            if !foreground && !no_mount && port == 0 && state_dir.is_none() {
                print_value(crate::control::call("drive.mount",serde_json::json!({"driveId":drive,"mountpoint":mountpoint,"readOnly":read_only})).await?,json)?;
                return Ok(());
            }
            let mountpoint = mountpoint.unwrap_or(crate::daemon::mount_root()?.join(crate::engine::safe_dir_name(&drive)));
            let state_dir = match state_dir {
                Some(d) => d,
                None => crate::daemon::support_dir()?.join("cli").join(&drive),
            };
            crate::nfs::mount(drive_client(&drive, true, true)?, drive, mountpoint, no_mount, port, read_only, state_dir).await?;
        }
    }
    Ok(())
    })
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

fn print_value(value: serde_json::Value, json: bool) -> Result<()> {
    if json { println!("{}",serde_json::to_string(&value)?); } else { println!("{}",serde_json::to_string_pretty(&value)?); } Ok(())
}

async fn api(method: &str, path: String, body: serde_json::Value) -> Result<serde_json::Value> {
    crate::control::call("api.request",serde_json::json!({"method":method,"path":path,"body":body})).await
}

fn drive_client(_drive: &str, cache: bool, whole: bool) -> Result<Client> {
    if let Ok(client) = REQUEST_CLIENT.try_with(Clone::clone) { return Ok(client); }
    if std::env::var_os("ULS_DEV_TOKEN").is_some() { return client(cache,whole); }
    REQUEST_CLIENT.try_with(Clone::clone).context("run `uls daemon start` before using the signed-in CLI")
}

tokio::task_local! {
    static REQUEST_CLIENT: Client;
    static CAPTURE: std::cell::RefCell<Vec<u8>>;
}

pub(crate) fn line(args: std::fmt::Arguments<'_>) {
    use std::io::Write;
    if CAPTURE.try_with(|out| { let _ = writeln!(out.borrow_mut(),"{args}"); }).is_err() {
        let _ = writeln!(std::io::stdout(),"{args}");
    }
}

pub(crate) fn data_drive(cmd: &Cmd) -> Option<&str> {
    match cmd {
        Cmd::Put {drive,..} | Cmd::Get {drive,..} | Cmd::Ls {drive,..} | Cmd::Stat {drive,..} | Cmd::Versions {drive,..} | Cmd::History {drive,..} | Cmd::Restore {drive,..} | Cmd::Show {drive,..} | Cmd::Mkdir {drive,..} | Cmd::Rm {drive,..} | Cmd::Mv {drive,..} | Cmd::Drive {cmd:DriveCmd::Info {drive}} => Some(drive),
        _ => None,
    }
}

pub(crate) fn set_data_drive(cmd: &mut Cmd,id:String) {
    match cmd {
        Cmd::Put {drive,..} | Cmd::Get {drive,..} | Cmd::Ls {drive,..} | Cmd::Stat {drive,..} | Cmd::Versions {drive,..} | Cmd::History {drive,..} | Cmd::Restore {drive,..} | Cmd::Show {drive,..} | Cmd::Mkdir {drive,..} | Cmd::Rm {drive,..} | Cmd::Mv {drive,..} | Cmd::Drive {cmd:DriveCmd::Info {drive}} => *drive=id,
        _ => {},
    }
}

pub(crate) async fn execute(cli:Cli,client:Client)->Result<Vec<u8>> {
    REQUEST_CLIENT.scope(client,CAPTURE.scope(std::cell::RefCell::new(Vec::new()),async {
        run_inner(cli).await?;
        Ok(CAPTURE.with(|out|out.take()))
    })).await
}
