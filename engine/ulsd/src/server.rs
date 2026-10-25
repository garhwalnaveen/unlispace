//! Unix-socket server for the app protocol: newline-delimited JSON, pipelined requests with
//! out-of-order responses, events broadcast to every client.

use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};

use crate::engine::Engine;
use crate::protocol::{ErrorBody, MAX_LINE_BYTES, Response, UNATTRIBUTABLE_ID, parse_request};

/// Create the socket's directory (0700), remove a stale socket, bind, chmod the socket 0600.
/// Returns the listener and the uid that owns the directory (= the uid we run as).
pub fn bind(sock: &Path) -> Result<(UnixListener, u32)> {
    let dir = sock.parent().context("socket path has no parent")?;
    if !dir.exists() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    // Create-time modes are subject to the umask and recursive creation; set it explicitly.
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    let owner = std::fs::metadata(dir)?.uid();

    match std::fs::symlink_metadata(sock) {
        Ok(md) => {
            use std::os::unix::fs::FileTypeExt;
            if !md.file_type().is_socket() {
                bail!("{} exists and is not a socket", sock.display());
            }
            // A live daemon answers; a stale socket file refuses the connection.
            if std::os::unix::net::UnixStream::connect(sock).is_ok() {
                bail!("another ulsd is already listening on {}", sock.display());
            }
            std::fs::remove_file(sock).context("remove stale socket")?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let listener = UnixListener::bind(sock).with_context(|| format!("bind {}", sock.display()))?;
    std::fs::set_permissions(sock, std::fs::Permissions::from_mode(0o600))?;
    Ok((listener, owner))
}

/// Accept clients until the future is dropped. Connections from any uid other than `allowed_uid`
/// are closed without a reply.
pub async fn serve(listener: UnixListener, allowed_uid: u32, engine: Arc<Engine>) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!("accept failed: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        match stream.peer_cred() {
            Ok(c) if c.uid() == allowed_uid => {}
            Ok(c) => {
                tracing::warn!(peer_uid = c.uid(), "rejected connection from another user");
                continue;
            }
            Err(e) => {
                tracing::warn!("could not read peer credentials: {e}");
                continue;
            }
        }
        let engine = engine.clone();
        tokio::spawn(async move { client(stream, engine).await });
    }
}

async fn client(stream: UnixStream, engine: Arc<Engine>) {
    let (rd, mut wr) = stream.into_split();
    let (tx, mut rx) = mpsc::channel::<String>(1024);

    let writer = tokio::spawn(async move {
        while let Some(mut line) = rx.recv().await {
            line.push('\n');
            if wr.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
    });

    // Subscribe before sending the first state so no event can slip between the two.
    let mut events = engine.subscribe();
    let _ = tx.send(engine.state_event_line()).await;
    let ev_tx = tx.clone();
    let forward = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(line) => {
                    if ev_tx.try_send(line).is_err() && ev_tx.is_closed() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let mut reader = BufReader::new(rd).take(0);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        reader.set_limit(MAX_LINE_BYTES as u64 + 1);
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buf.last() != Some(&b'\n') && buf.len() > MAX_LINE_BYTES {
            let r = Response::err(UNATTRIBUTABLE_ID, ErrorBody::bad_request("request line too long"));
            let _ = tx.send(r.to_line()).await;
            break;
        }
        let line = match std::str::from_utf8(&buf) {
            Ok(s) => s.trim(),
            Err(_) => {
                let r = Response::err(UNATTRIBUTABLE_ID, ErrorBody::bad_request("request is not valid UTF-8"));
                let _ = tx.send(r.to_line()).await;
                continue;
            }
        };
        if line.is_empty() {
            continue;
        }
        match parse_request(line) {
            Ok(req) => {
                // Each request runs on its own task so a slow mount never blocks `status`.
                let engine = engine.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let resp = engine.handle(req).await;
                    let _ = tx.send(resp.to_line()).await;
                });
            }
            Err(resp) => {
                let _ = tx.send(resp.to_line()).await;
            }
        }
    }
    forward.abort();
    drop(tx);
    let _ = writer.await;
}
