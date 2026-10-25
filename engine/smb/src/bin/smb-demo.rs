use std::{path::PathBuf, sync::Arc};
use uls_smb::{Kind, MemBackend, SmbBackend};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "smb_server=info,uls_smb=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let mut args = std::env::args().skip(1);
    let mountpoint = PathBuf::from(args.next().ok_or(
        "usage: smb-demo MOUNTPOINT [--encrypt] [--backend-event-after SECONDS] [--serve-only]",
    )?);
    let mut encrypt = false;
    let mut after = None;
    let mut serve_only = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--encrypt" => encrypt = true,
            "--serve-only" => serve_only = true,
            "--backend-event-after" => {
                after = Some(args.next().ok_or("missing seconds")?.parse::<u64>()?)
            }
            _ => return Err(format!("unknown argument {arg}").into()),
        }
    }
    let created = !mountpoint.exists();
    std::fs::create_dir_all(&mountpoint)?;
    let mountpoint = std::fs::canonicalize(mountpoint)?;
    let backend = Arc::new(MemBackend::new());
    backend.create("hello.txt", Kind::File).await?;
    backend
        .write("hello.txt", 0, b"Hello from Unlispace SMB.\n")
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
    let server = uls_smb::serve(backend.clone(), encrypt).await?;
    println!(
        "SMB listening on {} (share ULS, signing required, encryption {})",
        server.addr, encrypt
    );
    if !serve_only {
        let addr = server.addr;
        let user = server.user.clone();
        let pass = server.password.clone();
        let path = mountpoint.clone();
        let mounted =
            tokio::task::spawn_blocking(move || uls_smb::mount(addr, &user, &pass, path)).await?;
        if let Err(e) = mounted {
            server.shutdown().await?;
            if created {
                std::fs::remove_dir(&mountpoint)?;
            }
            return Err(format!("mount failed: {e}").into());
        }
        println!("Mounted at {}", mountpoint.display());
    }
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
    loop {
        tokio::signal::ctrl_c().await?;
        if serve_only {
            break;
        }
        let path = mountpoint.clone();
        match tokio::task::spawn_blocking(move || uls_smb::unmount(path)).await? {
            Ok(()) => break,
            Err(error) => eprintln!(
                "Unmount failed: {error}; still serving. Release open files and press Ctrl-C to retry."
            ),
        }
    }
    if let Some(event) = event {
        event.abort();
    }
    server.shutdown().await?;
    if created {
        std::fs::remove_dir(&mountpoint)?;
    }
    println!("Unmounted; server stopped.");
    Ok(())
}
