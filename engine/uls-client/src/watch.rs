use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{Stream, StreamExt, SinkExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use uls_proto::{Change, WatchMessage};

use crate::client::Client;
use crate::error::{Error, Result};

/// A stream of changes. Dropping it stops the background task.
pub struct WatchStream {
    rx: mpsc::Receiver<Result<Change>>,
    task: tokio::task::JoinHandle<()>,
}

impl Stream for WatchStream {
    type Item = Result<Change>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

impl Drop for WatchStream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Server pings every 30 s; if nothing arrives for this long the link is considered dead.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_BACKOFF: Duration = Duration::from_secs(15);

impl WatchStream {
    pub(crate) fn spawn(client: Client, drive: String, since: u64) -> WatchStream {
        let (tx, rx) = mpsc::channel(256);
        let task = tokio::spawn(async move { run(client, drive, since, tx).await });
        WatchStream { rx, task }
    }
}

enum Exit {
    ConsumerGone,
    Disconnected { made_progress: bool },
}

async fn run(client: Client, drive: String, mut last: u64, tx: mpsc::Sender<Result<Change>>) {
    let mut backoff = Duration::from_millis(250);
    loop {
        match session(&client, &drive, &mut last, &tx).await {
            Exit::ConsumerGone => return,
            Exit::Disconnected { made_progress } => {
                if made_progress {
                    backoff = Duration::from_millis(250);
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

async fn session(client: &Client, drive: &str, last: &mut u64, tx: &mpsc::Sender<Result<Change>>) -> Exit {
    let url = client.ws_url(drive, *last);
    let mut req = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            let _ = tx.send(Err(Error::Ws(e.to_string()))).await;
            return Exit::ConsumerGone;
        }
    };
    // Header auth keeps the token out of URLs and logs; the contract allows it.
    match format!("Bearer {}", client.token()).parse() {
        Ok(v) => {
            req.headers_mut().insert("authorization", v);
        }
        Err(_) => {
            let _ = tx.send(Err(Error::Ws("token is not a valid header value".into()))).await;
            return Exit::ConsumerGone;
        }
    }
    let mut ws = match tokio_tungstenite::connect_async(req).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            tracing::debug!("watch connect failed: {e}");
            return Exit::Disconnected { made_progress: false };
        }
    };
    let mut progress = false;
    loop {
        let frame = match tokio::time::timeout(IDLE_TIMEOUT, ws.next()).await {
            Ok(Some(Ok(f))) => f,
            Ok(Some(Err(e))) => {
                tracing::debug!("watch socket error: {e}");
                return Exit::Disconnected { made_progress: progress };
            }
            Ok(None) | Err(_) => return Exit::Disconnected { made_progress: progress },
        };
        match frame {
            Message::Text(t) => match serde_json::from_str::<WatchMessage>(&t) {
                Ok(WatchMessage::Change { seq, path, op, version_id }) => {
                    progress = true;
                    // Replays after a reconnect can overlap; deliver each seq once, in order.
                    if seq > *last {
                        *last = seq;
                        let ch = Change { seq, path, op, version_id };
                        if tx.send(Ok(ch)).await.is_err() {
                            return Exit::ConsumerGone;
                        }
                    }
                }
                Ok(WatchMessage::Ping) => {
                    let pong = serde_json::to_string(&WatchMessage::Pong).unwrap_or_default();
                    if ws.send(Message::Text(pong.into())).await.is_err() {
                        return Exit::Disconnected { made_progress: progress };
                    }
                }
                Ok(WatchMessage::Pong) => {}
                Err(e) => tracing::debug!("ignoring unparseable watch frame: {e}"),
            },
            Message::Ping(p) => {
                if ws.send(Message::Pong(p)).await.is_err() {
                    return Exit::Disconnected { made_progress: progress };
                }
            }
            Message::Close(_) => return Exit::Disconnected { made_progress: progress },
            _ => {}
        }
    }
}
