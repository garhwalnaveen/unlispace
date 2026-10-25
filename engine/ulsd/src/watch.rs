//! Feed the mounted VFS from the shared client's resumable event stream.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::broadcast;
use uls_client::{Client, WatchEvent};
use uls_vfs::Vfs;

use crate::protocol::{ChangeEvent, Event};
use crate::state::StateStore;

pub struct WatchCtx {
    pub drive_id: String,
    pub client: Client,
    pub vfs: Vfs,
    pub events: broadcast::Sender<String>,
    pub state: Arc<StateStore>,
}

pub async fn run(ctx: WatchCtx) {
    // A new watcher starts at the current event head, never at a commit sequence number.
    let mut after = match ctx.state.cursor(&ctx.drive_id) {
        Some(ev) => ev,
        None => loop {
            match ctx.client.changes(&ctx.drive_id, 0, 1).await {
                Ok(head) => break head.last_ev,
                Err(uls_client::Error::NotFound { .. }) => return,
                Err(_) => tokio::time::sleep(Duration::from_secs(2)).await,
            }
        },
    };
    loop {
        let mut stream = ctx.client.watch(&ctx.drive_id, after);
        loop {
            let event = match stream.next().await {
                Some(Ok(event)) => event,
                Some(Err(_)) => {
                    // Auth providers can fail transiently while the network is offline.
                    // The stream owns reconnects; restart it only after a terminal error.
                    tracing::warn!(drive = %ctx.drive_id, "drive watch interrupted");
                    after = stream.last_ev();
                    break;
                }
                None => return, // Deleted drive (4404) ends the stream permanently.
            };
            let (seq, paths) = match &event {
                WatchEvent::Change(change) => (change.seq, vec![format!("/{}", change.path.trim_start_matches('/'))]),
                WatchEvent::Resync { head_seq, .. } => (*head_seq, vec!["/".into()]),
            };
            // Invalidate before persisting the delivered cursor, including on a full resync.
            ctx.vfs.apply_remote(event).await;
            ctx.state.set_cursor(&ctx.drive_id, stream.last_ev());
            let change = ChangeEvent {
                drive_id: ctx.drive_id.clone(),
                seq: i64::try_from(seq).unwrap_or(i64::MAX),
                paths,
            };
            let _ = ctx.events.send(Event::Change(change).to_line());
        }
        drop(stream);
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
