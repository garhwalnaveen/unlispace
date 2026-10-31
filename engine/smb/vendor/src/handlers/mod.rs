//! Per-command handlers.
//!
//! Each function here builds a `HandlerResponse` for a specific SMB2 command.
//! Handlers receive the parsed request header and a slice of the body bytes;
//! they return either a successful body or `HandlerResponse::err(ntstatus)`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::proto::header::{Command, Smb2Header};

use crate::conn::pending::{AsyncOp, Stop, stopped};

use crate::conn::state::Connection;
use crate::dispatch::HandlerResponse;
use crate::ntstatus;
use crate::server::ServerState;

mod change_notify;
mod close;
pub(crate) mod create;
mod echo;
mod flush;
mod ioctl;
mod lock;
mod logoff;
pub(crate) mod negotiate;
mod oplock_break;
mod pipe;
mod query_directory;
mod query_info;
mod read;
mod reconnect;
mod session_setup;
mod set_info;
pub(crate) mod shared;
mod tree_connect;
mod tree_disconnect;
mod write;

pub(crate) use pipe::pipes;

/// What a handler produced: a response, or a request that completes later.
pub(crate) enum Outcome {
    Done(HandlerResponse),
    Pending(Pending),
}

/// A request answered asynchronously (MS-SMB2 3.3.4.2): its registration
/// and the work that produces its final response. The work owns what it
/// needs, so it runs after the frame that carried the request is done.
pub(crate) struct Pending {
    pub op: Arc<AsyncOp>,
    pub work: Pin<Box<dyn Future<Output = HandlerResponse> + Send>>,
}

/// Top-level command router. `encrypted` tells whether the request arrived
/// encrypted; `retained` is the size of the request and the requests
/// compounded after it, which a request that goes asynchronous keeps until
/// it completes.
pub(crate) async fn dispatch_command(
    server: &Arc<ServerState>,
    conn: &Arc<Connection>,
    hdr: &Smb2Header,
    body: &[u8],
    encrypted: bool,
    retained: usize,
) -> Outcome {
    if let Some(outcome) = pipe::route(server, conn, hdr, body, retained).await {
        return outcome;
    }
    // macOS rejects delayed metadata split from its related CREATE/query/CLOSE chain.
    if matches!(hdr.command, Command::QueryDirectory | Command::QueryInfo)
        && (hdr.flags & crate::proto::header::SMB2_FLAGS_RELATED_OPERATIONS != 0
            || hdr.next_command != 0)
    {
        return Outcome::Done(match hdr.command {
            Command::QueryDirectory => query_directory::handle(server, conn, hdr, body).await,
            _ => query_info::handle(server, conn, hdr, body).await,
        });
    }
    let response = match hdr.command {
        Command::Create => return create::handle(server, conn, hdr, body, retained).await,
        Command::SetInfo => return set_info::handle(server, conn, hdr, body, retained).await,
        Command::ChangeNotify => {
            return change_notify::handle(server, conn, hdr, body, retained).await;
        }
        Command::Close
        | Command::Flush
        | Command::Read
        | Command::Write
        | Command::QueryDirectory
        | Command::QueryInfo => {
            return run_backend_command(server, conn, hdr, body, retained).await;
        }
        Command::Negotiate => negotiate::handle(server, conn, hdr, body).await,
        Command::SessionSetup => session_setup::handle(server, conn, hdr, body).await,
        Command::Logoff => logoff::handle(server, conn, hdr, body).await,
        Command::TreeConnect => tree_connect::handle(server, conn, hdr, body, encrypted).await,
        Command::TreeDisconnect => tree_disconnect::handle(server, conn, hdr, body).await,
        Command::Lock => lock::handle(server, conn, hdr, body).await,
        Command::Ioctl => ioctl::handle(server, conn, hdr, body).await,
        Command::Echo => echo::handle(server, conn, hdr, body).await,
        Command::OplockBreak => oplock_break::handle(server, conn, hdr, body).await,
        Command::Cancel => HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER),
    };
    Outcome::Done(response)
}

/// How long a request that calls the backend may run before it is answered
/// with an interim response and finishes beside the reader. Requests that
/// finish sooner are answered in one step.
const BACKEND_GRACE: Duration = Duration::from_millis(200);

/// Runs a request whose handler calls the backend, which can take seconds
/// (a READ waiting on a shard fetched from the cloud). The handler runs in
/// its own task, so the reader goes on to the connection's other frames
/// (ECHO, other READs) instead of queueing them behind it. One that
/// outlasts [`BACKEND_GRACE`] goes asynchronous (MS-SMB2 3.3.4.2): the
/// interim response goes out now and the final one when the task is done.
/// The FileId a WRITE, FLUSH or CLOSE body names, for per-open ordering. All three carry it
/// at body offset 8 (MS-SMB2 2.2.15, 2.2.17, 2.2.21: WRITE puts it after Length and Offset).
fn mutating_file_id(hdr: &Smb2Header, body: &[u8]) -> Option<crate::proto::messages::FileId> {
    let at = match hdr.command {
        Command::Close | Command::Flush => 8,
        Command::Write => 16,
        _ => return None,
    };
    let bytes = body.get(at..at + 16)?;
    let persistent = u64::from_le_bytes(bytes[..8].try_into().ok()?);
    let volatile = u64::from_le_bytes(bytes[8..].try_into().ok()?);
    Some(crate::proto::messages::FileId::new(persistent, volatile))
}

async fn run_backend_command(
    server: &Arc<ServerState>,
    conn: &Arc<Connection>,
    hdr: &Smb2Header,
    body: &[u8],
    retained: usize,
) -> Outcome {
    // WRITE, FLUSH and CLOSE on one open complete in arrival order: a FLUSH must not report
    // durability before an earlier WRITE to the same open has reached the backend. The gate is
    // queued here, on the reader, so its order is the frames' order; tokio's Mutex is FIFO.
    let gate = mutating_file_id(hdr, body).map(|id| {
        let mut gates = conn.file_gates.lock().unwrap_or_else(|e| e.into_inner());
        if gates.len() > 4096 { gates.retain(|_, g| Arc::strong_count(g) > 1); }
        Arc::clone(gates.entry(id).or_default())
    });
    let queued = match gate {
        Some(g) => Some(g.lock_owned().await),
        None => None,
    };
    let (task_server, task_conn, task_hdr, task_body) =
        (Arc::clone(server), Arc::clone(conn), *hdr, body.to_vec());
    let mut task = tokio::spawn(async move {
        let _ordered = queued;
        let (server, conn, hdr, body) = (&task_server, &task_conn, &task_hdr, &task_body[..]);
        match hdr.command {
            Command::Close => close::handle(server, conn, hdr, body).await,
            Command::Flush => flush::handle(server, conn, hdr, body).await,
            Command::Read => read::handle(server, conn, hdr, body).await,
            Command::Write => write::handle(server, conn, hdr, body).await,
            Command::QueryDirectory => query_directory::handle(server, conn, hdr, body).await,
            _ => query_info::handle(server, conn, hdr, body).await,
        }
    });
    let finished = |joined: Result<HandlerResponse, tokio::task::JoinError>| match joined {
        Ok(response) => response,
        Err(_) => HandlerResponse::err(ntstatus::STATUS_INTERNAL_ERROR),
    };
    if let Ok(joined) = tokio::time::timeout(BACKEND_GRACE, &mut task).await {
        return Outcome::Done(finished(joined));
    }
    // Past the connection's limits the request keeps the reader, as it did
    // before it could wait beside it.
    let Some((op, mut stop)) = conn.pending.reserve(hdr, None, retained) else {
        return Outcome::Done(finished(task.await));
    };
    // CANCEL ends a request that only reads. A CLOSE, FLUSH or WRITE that
    // has started runs to its end, as on Windows, so a cancelled one is not
    // left half done. A request whose open, tree or session ends meanwhile
    // finishes the way it would have inline.
    let cancellable = matches!(
        hdr.command,
        Command::Read | Command::QueryDirectory | Command::QueryInfo
    );
    let work = async move {
        loop {
            tokio::select! {
                joined = &mut task => return finished(joined),
                why = stopped(&mut stop), if cancellable => {
                    if why == Stop::Cancelled {
                        task.abort();
                        return HandlerResponse::err(ntstatus::STATUS_CANCELLED);
                    }
                }
            }
        }
    };
    Outcome::Pending(Pending {
        op,
        work: Box::pin(work),
    })
}
