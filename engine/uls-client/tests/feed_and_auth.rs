//! Change feed (ev cursor, pagination, reconnects, resync, close codes), paginated versions and
//! the token provider, all against the in-memory contract server.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use uls_client::{Client, Error, ProviderToken, TokenProvider, WatchEvent, WatchStream};
use uls_mock::MockServer;
use uls_proto::Op;

const TOKEN: &str = "test-token";

async fn setup() -> (MockServer, Client) {
    let srv = MockServer::start(TOKEN).await;
    let c = Client::builder(srv.url(), TOKEN).build().unwrap();
    c.create_drive("demo", None).await.unwrap();
    (srv, c)
}

/// One commit with `n` events (each `mkdir` is one log entry).
async fn mkdirs(c: &Client, prefix: &str, n: usize) -> u64 {
    let ops = (0..n).map(|i| Op::Mkdir { path: format!("{prefix}{i:04}/") }).collect();
    c.commit("demo", ops).await.unwrap().seq
}

async fn next(w: &mut WatchStream) -> Option<WatchEvent> {
    tokio::time::timeout(Duration::from_secs(10), w.next()).await.expect("watch timed out").map(|r| r.unwrap())
}

async fn next_ev(w: &mut WatchStream) -> i64 {
    match next(w).await {
        Some(WatchEvent::Change(c)) => c.ev,
        other => panic!("expected a change, got {other:?}"),
    }
}

async fn take_evs(w: &mut WatchStream, n: usize) -> Vec<i64> {
    let mut v = Vec::new();
    while v.len() < n {
        v.push(next_ev(w).await);
    }
    v
}

#[derive(Default)]
struct Provider {
    current: Mutex<String>,
    after_refresh: Mutex<String>,
    endpoint: Mutex<Option<String>>,
    token_calls: AtomicUsize,
    refresh_calls: AtomicUsize,
}

impl Provider {
    fn new(current: &str, after_refresh: &str) -> Arc<Provider> {
        Arc::new(Provider {
            current: Mutex::new(current.into()),
            after_refresh: Mutex::new(after_refresh.into()),
            ..Default::default()
        })
    }
    fn tok(&self) -> ProviderToken {
        ProviderToken { token: self.current.lock().unwrap().clone(), endpoint: self.endpoint.lock().unwrap().clone() }
    }
}

#[async_trait]
impl TokenProvider for Provider {
    async fn token(&self) -> uls_client::Result<ProviderToken> {
        self.token_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.tok())
    }
    async fn refresh(&self) -> uls_client::Result<ProviderToken> {
        self.refresh_calls.fetch_add(1, Ordering::SeqCst);
        let next = self.after_refresh.lock().unwrap().clone();
        *self.current.lock().unwrap() = next;
        Ok(self.tok())
    }
}

#[tokio::test]
async fn changes_pages_by_ev_and_loses_nothing() {
    let (_srv, c) = setup().await;
    mkdirs(&c, "a", 1000).await; // one commit, 1000 events
    let seq2 = mkdirs(&c, "b", 5).await;

    let mut evs = Vec::new();
    let mut after = 0;
    let mut pages = 0;
    loop {
        let r = c.changes("demo", after, 300).await.unwrap();
        pages += 1;
        evs.extend(r.changes.iter().map(|ch| ch.ev));
        assert_eq!(r.last_ev, 1005);
        match r.changes.last() {
            Some(l) if r.more => after = l.ev,
            _ => break,
        }
    }
    assert_eq!(pages, 4, "1005 events at 300 per page");
    assert_eq!(evs, (1..=1005).collect::<Vec<i64>>());

    // `since=<seq>` still means "after the last event of that commit"; the typed API uses `after`.
    let r = c.changes("demo", 1000, 1000).await.unwrap();
    assert_eq!(r.changes.len(), 5);
    assert_eq!(r.changes[0].seq, seq2);
    assert_eq!(r.head_seq, seq2);
}

#[tokio::test]
async fn since_alias_is_served_by_the_mock() {
    let (srv, c) = setup().await;
    mkdirs(&c, "a", 3).await; // seq 1, ev 1..=3
    mkdirs(&c, "b", 2).await; // seq 2, ev 4..=5
    let url = format!("{}/v0/drives/demo/changes?since=1", srv.url());
    let v: serde_json::Value =
        reqwest::Client::new().get(url).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
    let evs: Vec<i64> = v["changes"].as_array().unwrap().iter().map(|c| c["ev"].as_i64().unwrap()).collect();
    assert_eq!(evs, vec![4, 5]);
    assert_eq!(v["lastEv"], 5);
}

#[tokio::test]
async fn watch_loses_nothing_across_pages_and_reconnects() {
    let (srv, c) = setup().await;
    srv.set_watch_cut_after(300); // every socket dies after 300 frames: 1000 events need 4 connects
    mkdirs(&c, "a", 1000).await;

    let mut w = c.watch("demo", 0);
    let evs = take_evs(&mut w, 1000).await;
    assert_eq!(evs, (1..=1000).collect::<Vec<i64>>(), "no event lost or repeated across reconnects");
    assert_eq!(w.last_ev(), 1000);
    assert!(srv.stats.watch_connects.load(Ordering::SeqCst) >= 4);

    // Live events keep flowing (and stay deduplicated) afterwards.
    mkdirs(&c, "b", 3).await;
    assert_eq!(take_evs(&mut w, 3).await, vec![1001, 1002, 1003]);
    assert_eq!(w.last_ev(), 1003);

    // Resuming from a persisted cursor skips what was already processed.
    drop(w);
    let mut w = c.watch("demo", 998);
    assert_eq!(take_evs(&mut w, 5).await, vec![999, 1000, 1001, 1002, 1003]);
}

#[tokio::test]
async fn token_expiry_4401_remints_and_resumes_without_loss_or_duplicates() {
    let (srv, _c) = setup().await;
    srv.add_token("t2");
    let prov = Provider::new("t1", "t2");
    srv.add_token("t1");
    let c = Client::builder(srv.url(), "unused").token_provider(prov.clone()).build().unwrap();

    mkdirs(&c, "a", 50).await;
    let mut w = c.watch("demo", 0);
    assert_eq!(take_evs(&mut w, 20).await, (1..=20).collect::<Vec<i64>>());
    assert_eq!(srv.stats.watch_connects.load(Ordering::SeqCst), 1);

    // The token t1 expires mid-stream; the server closes the socket with 4401.
    srv.expire_token("t1");
    mkdirs(&c, "b", 10).await; // the client's own requests must also move to t2 (via a 401 retry)
    let rest = take_evs(&mut w, 40).await;
    assert_eq!(rest, (21..=60).collect::<Vec<i64>>());
    assert_eq!(srv.stats.watch_connects.load(Ordering::SeqCst), 2, "one reconnect, no backoff loop");
    assert!(prov.refresh_calls.load(Ordering::SeqCst) >= 1);
    assert_eq!(*prov.current.lock().unwrap(), "t2");
}

#[tokio::test]
async fn resync_is_yielded_then_stream_continues_from_last_ev() {
    let (srv, c) = setup().await;
    srv.set_resync_backlog(10);
    mkdirs(&c, "a", 50).await;

    let mut w = c.watch("demo", 0);
    assert_eq!(next(&mut w).await, Some(WatchEvent::Resync { head_seq: 1, last_ev: 50 }));
    assert_eq!(w.last_ev(), 50);

    mkdirs(&c, "b", 2).await;
    assert_eq!(take_evs(&mut w, 2).await, vec![51, 52], "continues after last_ev; the 50 old events are not replayed");
}

#[tokio::test]
async fn drive_deleted_4404_ends_the_stream() {
    let (srv, c) = setup().await;
    mkdirs(&c, "a", 2).await;
    let mut w = c.watch("demo", 0);
    assert_eq!(take_evs(&mut w, 2).await, vec![1, 2]);

    srv.delete_drive("demo");
    assert!(next(&mut w).await.is_none(), "stream ends, it does not reconnect forever");
    assert_eq!(srv.stats.watch_connects.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn http_401_asks_the_provider_once_more_and_retries_once() {
    let (srv, _c) = setup().await;
    let prov = Provider::new("stale", TOKEN);
    let c = Client::builder(srv.url(), "unused").token_provider(prov.clone()).build().unwrap();

    let before = srv.stats.unauthorized.load(Ordering::SeqCst);
    let info = c.drive_info("demo").await.unwrap();
    assert_eq!(info.drive_id, "demo");
    assert_eq!(srv.stats.unauthorized.load(Ordering::SeqCst) - before, 1);
    assert_eq!(prov.refresh_calls.load(Ordering::SeqCst), 1);

    // Now the provider is good: no further refreshes, token resolved per request.
    c.drive_info("demo").await.unwrap();
    assert_eq!(prov.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prov.token_calls.load(Ordering::SeqCst), 2);

    // Bodies are resent on retry.
    *prov.current.lock().unwrap() = "stale".into();
    let r = c.mkdir("demo", "x/").await.unwrap();
    assert_eq!(r.seq, 1);
    assert_eq!(prov.refresh_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn persistent_401_gives_up_after_one_retry() {
    let (srv, _c) = setup().await;
    let prov = Provider::new("bad1", "bad2");
    let c = Client::builder(srv.url(), "unused").token_provider(prov.clone()).build().unwrap();
    let before = srv.stats.unauthorized.load(Ordering::SeqCst);
    assert!(matches!(c.drive_info("demo").await.unwrap_err(), Error::Unauthorized));
    assert_eq!(srv.stats.unauthorized.load(Ordering::SeqCst) - before, 2, "exactly one retry");
    assert_eq!(prov.refresh_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn provider_can_supply_the_endpoint() {
    let (srv, _c) = setup().await;
    let prov = Provider::new(TOKEN, TOKEN);
    *prov.endpoint.lock().unwrap() = Some(format!("{}/", srv.url()));
    let c = Client::builder("http://127.0.0.1:9", "unused").token_provider(prov).build().unwrap();
    assert_eq!(c.drive_info("demo").await.unwrap().drive_id, "demo");
    mkdirs(&c, "a", 1).await;
    let mut w = c.watch("demo", 0);
    assert_eq!(next_ev(&mut w).await, 1, "watch uses the provider's endpoint too");
}

#[tokio::test]
async fn static_token_still_rejects_without_retry() {
    let (srv, _c) = setup().await;
    let bad = Client::builder(srv.url(), "wrong").build().unwrap();
    let before = srv.stats.unauthorized.load(Ordering::SeqCst);
    assert!(matches!(bad.drive_info("demo").await.unwrap_err(), Error::Unauthorized));
    assert_eq!(srv.stats.unauthorized.load(Ordering::SeqCst) - before, 1);
}

#[tokio::test]
async fn versions_follows_the_cursor_to_the_end() {
    let (_srv, c) = setup().await;
    // 2500 versions of one path: more than two server pages of 1000.
    for n in [1000usize, 1000, 500] {
        let ops = (0..n)
            .map(|_| Op::Put {
                path: "f.txt".into(),
                if_version: None,
                if_absent: false,
                size: 0,
                content_type: "text/plain".into(),
                mtime_ms: 0,
                shards: vec![],
            })
            .collect();
        c.commit("demo", ops).await.unwrap();
    }
    let v = c.versions("demo", "f.txt").await.unwrap();
    assert_eq!(v.len(), 2500);
    let mut ids: Vec<&str> = v.iter().map(|e| e.version_id.as_str()).collect();
    let sorted = {
        let mut s = ids.clone();
        s.sort();
        s
    };
    assert_eq!(ids, sorted, "oldest first");
    ids.dedup();
    assert_eq!(ids.len(), 2500, "no duplicates across pages");
}
