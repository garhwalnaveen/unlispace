#[cfg(feature = "demo")]
mod vfs;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use uls_smb::{Kind, MemBackend, RunningServer, SmbBackend};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

const USAGE: &str = "usage: smb-demo MOUNTPOINT [--encrypt] [--serve-only] \
    [--backend-event-after SECONDS | --vfs DRIVE [--native-test]]";

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "smb_server=info,uls_smb=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let mut args = std::env::args().skip(1);
    let mountpoint = PathBuf::from(args.next().ok_or(USAGE)?);
    let mut encrypt = false;
    let mut after = None;
    let mut serve_only = false;
    let mut drive = None;
    let mut native = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--encrypt" => encrypt = true,
            "--serve-only" => serve_only = true,
            "--backend-event-after" => {
                after = Some(args.next().ok_or("missing seconds")?.parse::<u64>()?)
            }
            "--vfs" => drive = Some(args.next().ok_or("missing drive")?),
            "--native-test" => native = true,
            _ => return Err(format!("unknown argument {arg}\n{USAGE}").into()),
        }
    }
    if native && (drive.is_none() || serve_only) {
        return Err("--native-test requires --vfs and a mount".into());
    }
    if after.is_some() && drive.is_some() {
        return Err("--backend-event-after applies to the in-memory backend only".into());
    }
    let created = !mountpoint.exists();
    std::fs::create_dir_all(&mountpoint)?;
    let mountpoint = std::fs::canonicalize(mountpoint)?;
    let outcome = match drive {
        None => mem_demo(&mountpoint, encrypt, serve_only, after).await,
        #[cfg(feature = "demo")]
        Some(drive) => vfs::run(&drive, &mountpoint, encrypt, serve_only, native).await,
        #[cfg(not(feature = "demo"))]
        Some(_) => Err("--vfs requires building with --features demo".into()),
    };
    if created {
        let removed = std::fs::remove_dir(&mountpoint);
        outcome?;
        removed?;
    } else {
        outcome?;
    }
    Ok(())
}

async fn mem_demo(
    mountpoint: &Path,
    encrypt: bool,
    serve_only: bool,
    after: Option<u64>,
) -> Result<()> {
    let backend = Arc::new(MemBackend::new());
    backend.create("hello.txt", Kind::File).await?;
    backend
        .write("hello.txt", 0, b"Hello from Orbit SMB.\n")
        .await?;
    backend.create("Documents", Kind::Directory).await?;
    backend.create("Documents/readme.txt", Kind::File).await?;
    backend
        .write(
            "Documents/readme.txt",
            0,
            b"Files live in memory for this demo.\n",
        )
        .await?;
    let server = start(backend.clone(), mountpoint, encrypt, serve_only).await?;
    let event = after.map(|delay| {
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            backend.create("backend-arrival.txt", Kind::File).await?;
            backend
                .write(
                    "backend-arrival.txt",
                    0,
                    b"Created directly in the backend.\n",
                )
                .await?;
            eprintln!("BACKEND_EVENT backend-arrival.txt");
            Ok::<_, uls_smb::FsError>(())
        })
    });
    tokio::signal::ctrl_c().await?;
    let stopped = stop(server, mountpoint, serve_only).await;
    if let Some(event) = event {
        event.abort();
    }
    stopped?;
    println!("Unmounted; server stopped.");
    Ok(())
}

/// Serves `backend` on loopback and mounts it at `mountpoint` unless `serve_only`.
async fn start(
    backend: Arc<dyn SmbBackend>,
    mountpoint: &Path,
    encrypt: bool,
    serve_only: bool,
) -> Result<RunningServer> {
    let server = uls_smb::serve(backend, encrypt).await?;
    println!(
        "SMB listening on {} (share ULS, signing required, encryption {})",
        server.addr, encrypt
    );
    if serve_only {
        return Ok(server);
    }
    let (addr, user, pass, path) = (
        server.addr,
        server.user.clone(),
        server.password.clone(),
        mountpoint.to_owned(),
    );
    let mounted =
        tokio::task::spawn_blocking(move || uls_smb::mount(addr, &user, &pass, path)).await?;
    if let Err(e) = mounted {
        server.shutdown().await?;
        return Err(format!("mount failed: {e}").into());
    }
    println!("Mounted at {}", mountpoint.display());
    Ok(server)
}

/// Unmounts (retrying on Ctrl-C while files are still open), then stops the server.
async fn stop(server: RunningServer, mountpoint: &Path, serve_only: bool) -> Result<()> {
    if !serve_only {
        loop {
            let path = mountpoint.to_owned();
            match tokio::task::spawn_blocking(move || uls_smb::unmount(path)).await? {
                Ok(()) => break,
                Err(error) => {
                    eprintln!(
                        "Unmount failed: {error}; still serving. Release open files and press Ctrl-C to retry."
                    );
                    tokio::signal::ctrl_c().await?;
                }
            }
        }
    }
    server.shutdown().await?;
    Ok(())
}
