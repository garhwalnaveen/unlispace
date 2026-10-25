use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, Stream, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use uls_proto::{Change, WatchMessage};

use crate::client::Client;
use crate::error::{Error, Result};

/// Close code: the bearer token expired. Fetch a fresh one and reconnect immediately.
pub const CLOSE_TOKEN_EXPIRED: u16 = 4401;
/// Close code: the drive was deleted. The stream ends.
pub const CLOSE_DRIVE_DELETED: u16 = 4404;

/// One item of a [`WatchStream`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    Change(Change),
    /// The server's backlog for our cursor was too large to replay. Re-list the drive from
    /// scratch; the stream carries on from `last_ev`.
    Resync { head_seq: u64, last_ev: i64 },
}

/// A stream of change events. Dropping it stops the background task.
///
/// - Events are deduplicated on `ev`, so reconnect overlaps never repeat one.
/// - Close code 4401 gets a fresh token from the client's provider and reconnects at once.
/// - Close code 4404 (drive deleted) ends the stream.
/// - A `resync` frame is yielded as [`WatchEvent::Resync`], then the stream continues from `last_ev`.
/// - A provider failure that is not a network error is yielded as `Err` and ends the stream.
pub struct WatchStream {
    rx: mpsc::Receiver<Result<WatchEvent>>,
    task: tokio::task::JoinHandle<()>,
    last_ev: i64,
}

impl WatchStream {
    /// The cursor to persist: the `ev` of the last event handed out by this stream (or the
    /// starting cursor if none yet). Resume with `Client::watch(drive, cursor)`.
    pub fn last_ev(&self) -> i64 {
        self.last_ev
    }
}

impl Stream for WatchStream {
    type Item = Result<WatchEvent>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let p = self.rx.poll_recv(cx);
        if let Poll::Ready(Some(Ok(ev))) = &p {
            match ev {
                WatchEvent::Change(c) => self.last_ev = self.last_ev.max(c.ev),
                WatchEvent::Resync { last_ev, .. } => self.last_ev = *last_ev,
            }
        }
        p
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
const MIN_BACKOFF: Duration = Duration::from_millis(250);

impl WatchStream {
    pub(crate) fn spawn(client: Client, drive: String, after_ev: i64) -> WatchStream {
        let (tx, rx) = mpsc::channel(256);
        let task = tokio::spawn(async move { run(client, drive, after_ev, tx).await });
        WatchStream { rx, task, last_ev: after_ev }
    }
}

enum Exit {
    ConsumerGone,
    /// Stop for good (4404, or a fatal error already reported).
    Ended,
    Disconnected { made_progress: bool },
    /// Close 4401 / HTTP 401: get a fresh token and reconnect without waiting.
    TokenRejected { made_progress: bool },
}

type Tx = mpsc::Sender<Result<WatchEvent>>;

async fn run(client: Client, drive: String, mut last: i64, tx: Tx) {
    let mut backoff = MIN_BACKOFF;
    // Credentials for the next connection; `None` means ask the provider.
    let mut creds: Option<(String, String)> = None;
    loop {
        let (base, token) = match creds.take() {
            Some(c) => c,
            None => match client.creds().await {
                Ok(c) => c,
                Err(e) if e.is_retryable() => {
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue;
                }
                Err(e) => {
                    let _ = tx.send(Err(e)).await;
                    return;
                }
            },
        };
        match session(&base, &token, &drive, &mut last, &tx).await {
            Exit::ConsumerGone | Exit::Ended => return,
            Exit::TokenRejected { made_progress } => {
                if made_progress {
                    backoff = MIN_BACKOFF;
                }
                match client.refreshed_creds().await {
                    // A provider that hands back the same token would make us spin; back off then.
                    Ok(c) if c.1 != token => creds = Some(c),
                    Ok(c) => {
                        creds = Some(c);
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                    }
                    Err(e) if e.is_retryable() => {
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        return;
                    }
                }
            }
            Exit::Disconnected { made_progress } => {
                if made_progress {
                    backoff = MIN_BACKOFF;
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

async fn session(base: &str, token: &str, drive: &str, last: &mut i64, tx: &Tx) -> Exit {
    let url = Client::ws_url(base, drive, *last);
    let mut req = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            let _ = tx.send(Err(Error::Ws(e.to_string()))).await;
            return Exit::Ended;
        }
    };
    // Header auth keeps the token out of URLs and logs; the contract allows it.
    match format!("Bearer {token}").parse() {
        Ok(v) => {
            req.headers_mut().insert("authorization", v);
        }
        Err(_) => {
            let _ = tx.send(Err(Error::Ws("token is not a valid header value".into()))).await;
            return Exit::Ended;
        }
    }
    let mut ws = match tokio_tungstenite::connect_async(req).await {
        Ok((ws, _)) => ws,
        Err(WsError::Http(resp)) if resp.status().as_u16() == 401 => {
            return Exit::TokenRejected { made_progress: false };
        }
        Err(WsError::Http(resp)) if resp.status().as_u16() == 404 => return Exit::Ended,
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
                Ok(WatchMessage::Change { ev, seq, path, op, version_id }) => {
                    progress = true;
                    // Replays after a reconnect can overlap; deliver each ev once, in order.
                    if ev > *last {
                        *last = ev;
                        let ch = Change { ev, seq, path, op, version_id };
                        if tx.send(Ok(WatchEvent::Change(ch))).await.is_err() {
                            return Exit::ConsumerGone;
                        }
                    }
                }
                Ok(WatchMessage::Resync { head_seq, last_ev }) => {
                    // The server closes after this; we reconnect from last_ev.
                    *last = last_ev;
                    if tx.send(Ok(WatchEvent::Resync { head_seq, last_ev })).await.is_err() {
                        return Exit::ConsumerGone;
                    }
                    return Exit::Disconnected { made_progress: true };
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
            Message::Close(frame) => {
                return match frame.map(|f| u16::from(f.code)) {
                    Some(CLOSE_TOKEN_EXPIRED) => Exit::TokenRejected { made_progress: progress },
                    Some(CLOSE_DRIVE_DELETED) => Exit::Ended,
                    _ => Exit::Disconnected { made_progress: progress },
                };
            }
            _ => {}
        }
    }
}
