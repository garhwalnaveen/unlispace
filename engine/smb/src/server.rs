use crate::{SmbBackend, adapter::Adapter};
use smb_server::{Access, Share, ShutdownHandle, SmbServer};
use std::{io, net::SocketAddr, sync::Arc};
use tokio::task::JoinHandle;

/// Passwords are intentionally omitted from Debug and logs.
pub struct RunningServer {
    pub addr: SocketAddr,
    pub user: String,
    pub password: String,
    shutdown: ShutdownHandle,
    task: Option<JoinHandle<io::Result<()>>>,
}
/// Start an authenticated, signed share on an OS-assigned IPv4 loopback port.
pub async fn serve(backend: Arc<dyn SmbBackend>, encrypt: bool) -> io::Result<RunningServer> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let encode = |b: &[u8]| b.iter().map(|v| format!("{v:02x}")).collect::<String>();
    let user = format!("uls{}", encode(&random[..8]));
    let password = encode(&random[8..]);
    let server = SmbServer::builder()
        .listen("127.0.0.1:0".parse().unwrap())
        .user(&user, &password)
        .netbios_name("UNLISPACE")
        .require_signing(true)
        .encrypt_data(encrypt)
        .share_listing(false)
        .share(
            Share::new("ULS", Adapter::new(backend))
                .user(&user, Access::ReadWrite)
                .leases(false)
                .durable_handles(false),
        )
        .build()
        .map_err(io::Error::other)?;
    let addr = server.bind().await?;
    let shutdown = server.shutdown_handle();
    let task = tokio::spawn(server.serve());
    Ok(RunningServer {
        addr,
        user,
        password,
        shutdown,
        task: Some(task),
    })
}
impl RunningServer {
    pub async fn shutdown(mut self) -> io::Result<()> {
        self.shutdown.shutdown();
        if let Some(task) = self.task.take() {
            task.await.map_err(io::Error::other)??;
        }
        Ok(())
    }
}
impl Drop for RunningServer {
    fn drop(&mut self) {
        self.shutdown.shutdown();
    }
}
