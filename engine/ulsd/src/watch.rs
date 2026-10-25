//! Per-drive change watch for the daemon. `uls_client::WatchStream` resumes by `seq` with a
//! static token and cannot see `ev`, `resync` or close codes (see NEEDS.md), so the daemon runs
//! its own loop over the same endpoint: `?after=<ev>`, header auth, fresh drive token on
//! close 4401, stop on 4404, re-list on `resync`. The cursor persisted is the last `ev`.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::{Error as WsError, Message, client::IntoClientRequest};

use crate::hub::AuthHub;
use crate::mount::NeedAccess;
use crate::protocol::{ChangeEvent, Event, code};
use crate::state::StateStore;

const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const FLUSH_AFTER: Duration = Duration::from_millis(100);
const MAX_BACKOFF: Duration = Duration::from_secs(15);

/// Where to start. A first-ever watch starts at the drive's current head (`since=<headSeq>`)
/// instead of replaying history; afterwards the cursor is an `ev` (`after=<ev>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Start {
    After(i64),
    Since(i64),
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Msg {
    Change {
        #[serde(default)]
        ev: Option<i64>,
        seq: i64,
        path: String,
    },
    Ping,
    Resync {
        #[serde(rename = "headSeq")]
        head_seq: i64,
        #[serde(rename = "lastEv")]
        last_ev: i64,
    },
    #[serde(other)]
    Other,
}

pub struct WatchCtx {
    pub drive_id: String,
    pub auth: Arc<AuthHub>,
    pub access: NeedAccess,
    pub events: broadcast::Sender<String>,
    pub state: Arc<StateStore>,
}

pub fn ws_url(endpoint: &str, drive: &str, start: Start) -> String {
    let base = endpoint.trim_end_matches('/');
    let base = if let Some(r) = base.strip_prefix("https://") {
        format!("wss://{r}")
    } else if let Some(r) = base.strip_prefix("http://") {
        format!("ws://{r}")
    } else {
        base.to_string()
    };
    match start {
        Start::After(ev) => format!("{base}/v0/drives/{drive}/watch?after={ev}"),
        Start::Since(seq) => format!("{base}/v0/drives/{drive}/watch?since={seq}"),
    }
}

enum Exit {
    /// Stop watching this drive (deleted, or nobody is listening).
    Gone,
    Retry { immediate: bool, progress: bool },
}

pub async fn run(ctx: WatchCtx, mut start: Start) {
    let mut backoff = Duration::from_millis(250);
    loop {
        let creds = match ctx.auth.drive_creds(&ctx.drive_id, ctx.access).await {
            Ok(c) => c,
            Err(e) if e.code == code::NO_SUCH_DRIVE || e.code == code::UNAUTHORIZED => {
                tracing::warn!(drive = %ctx.drive_id, "watch stopped: {}", e.code);
                return;
            }
            Err(_) => {
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
        };
        match session(&ctx, &creds.endpoint, &creds.token, &mut start).await {
            Exit::Gone => return,
            Exit::Retry { immediate, progress } => {
                if progress {
                    backoff = Duration::from_millis(250);
                }
                if !immediate {
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
    }
}

struct Pending {
    seq: i64,
    paths: Vec<String>,
    last_ev: i64,
}

fn flush(ctx: &WatchCtx, pending: &mut Option<Pending>, start: &mut Start) {
    if let Some(p) = pending.take() {
        *start = Start::After(p.last_ev);
        ctx.state.set_cursor(&ctx.drive_id, p.last_ev);
        let ev = Event::Change(ChangeEvent { drive_id: ctx.drive_id.clone(), seq: p.seq, paths: p.paths });
        let _ = ctx.events.send(ev.to_line());
    }
}

fn normalize(path: &str) -> String {
    if path.starts_with('/') { path.to_string() } else { format!("/{path}") }
}

async fn session(ctx: &WatchCtx, endpoint: &str, token: &str, start: &mut Start) -> Exit {
    let url = ws_url(endpoint, &ctx.drive_id, *start);
    let mut req = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(_) => return Exit::Gone,
    };
    // Header auth keeps the token out of URLs and logs.
    match format!("Bearer {token}").parse() {
        Ok(v) => {
            req.headers_mut().insert("authorization", v);
        }
        Err(_) => return Exit::Gone,
    }
    let mut ws = match tokio_tungstenite::connect_async(req).await {
        Ok((ws, _)) => ws,
        Err(WsError::Http(resp)) => {
            return match resp.status().as_u16() {
                404 => Exit::Gone,
                401 => {
                    ctx.auth.forget(&ctx.drive_id);
                    Exit::Retry { immediate: false, progress: false }
                }
                _ => Exit::Retry { immediate: false, progress: false },
            };
        }
        Err(_) => return Exit::Retry { immediate: false, progress: false },
    };
    let mut pending: Option<Pending> = None;
    let mut progress = false;
    loop {
        let wait = if pending.is_some() { FLUSH_AFTER } else { IDLE_TIMEOUT };
        let frame = match tokio::time::timeout(wait, ws.next()).await {
            Err(_) if pending.is_some() => {
                flush(ctx, &mut pending, start);
                continue;
            }
            Err(_) | Ok(None) | Ok(Some(Err(_))) => {
                flush(ctx, &mut pending, start);
                return Exit::Retry { immediate: false, progress };
            }
            Ok(Some(Ok(f))) => f,
        };
        match frame {
            Message::Text(t) => match serde_json::from_str::<Msg>(&t) {
                Ok(Msg::Change { ev, seq, path }) => {
                    let ev = ev.unwrap_or(seq);
                    let cursor = match *start {
                        Start::After(a) => a,
                        Start::Since(_) => i64::MIN,
                    };
                    let seen = pending.as_ref().map(|p| p.last_ev).unwrap_or(cursor);
                    // Replays after a reconnect can overlap. Deliver each ev once.
                    if ev <= seen {
                        continue;
                    }
                    progress = true;
                    if pending.as_ref().is_some_and(|p| p.seq != seq) {
                        flush(ctx, &mut pending, start);
                    }
                    let p = pending.get_or_insert(Pending { seq, paths: Vec::new(), last_ev: ev });
                    p.last_ev = ev;
                    let path = normalize(&path);
                    if !p.paths.contains(&path) {
                        p.paths.push(path);
                    }
                }
                Ok(Msg::Ping) => {
                    if ws.send(Message::Text("{\"type\":\"pong\"}".into())).await.is_err() {
                        flush(ctx, &mut pending, start);
                        return Exit::Retry { immediate: false, progress };
                    }
                }
                Ok(Msg::Resync { head_seq, last_ev }) => {
                    flush(ctx, &mut pending, start);
                    // The backlog was too large to replay: tell the app to re-list the whole
                    // drive, and resume from the server's lastEv.
                    let ev = Event::Change(ChangeEvent { drive_id: ctx.drive_id.clone(), seq: head_seq, paths: vec!["/".into()] });
                    let _ = ctx.events.send(ev.to_line());
                    *start = Start::After(last_ev);
                    ctx.state.set_cursor(&ctx.drive_id, last_ev);
                    return Exit::Retry { immediate: true, progress: true };
                }
                Ok(Msg::Other) | Err(_) => {}
            },
            Message::Ping(p) => {
                if ws.send(Message::Pong(p)).await.is_err() {
                    flush(ctx, &mut pending, start);
                    return Exit::Retry { immediate: false, progress };
                }
            }
            Message::Close(frame) => {
                flush(ctx, &mut pending, start);
                return match frame.map(|f| u16::from(f.code)) {
                    // Drive token expired while the socket was open: mint a fresh one now.
                    Some(4401) => {
                        ctx.auth.forget(&ctx.drive_id);
                        Exit::Retry { immediate: true, progress }
                    }
                    // Drive was deleted.
                    Some(4404) => Exit::Gone,
                    _ => Exit::Retry { immediate: false, progress },
                };
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(ws_url("http://h:1/", "d-a", Start::After(5)), "ws://h:1/v0/drives/d-a/watch?after=5");
        assert_eq!(ws_url("https://h", "d-a", Start::Since(2)), "wss://h/v0/drives/d-a/watch?since=2");
    }

    #[test]
    fn messages() {
        let m: Msg = serde_json::from_str(r#"{"type":"change","ev":9,"seq":3,"path":"a/b","op":"put","versionId":"v"}"#).unwrap();
        assert!(matches!(m, Msg::Change { ev: Some(9), seq: 3, .. }));
        let m: Msg = serde_json::from_str(r#"{"type":"change","seq":3,"path":"a","op":"put"}"#).unwrap();
        assert!(matches!(m, Msg::Change { ev: None, .. }));
        let m: Msg = serde_json::from_str(r#"{"type":"resync","headSeq":10,"lastEv":99}"#).unwrap();
        assert!(matches!(m, Msg::Resync { head_seq: 10, last_ev: 99 }));
        assert!(matches!(serde_json::from_str::<Msg>(r#"{"type":"future"}"#).unwrap(), Msg::Other));
    }
}
