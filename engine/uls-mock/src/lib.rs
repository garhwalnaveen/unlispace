#![allow(clippy::result_large_err)] // test-support server: Response as the error type keeps handlers terse
//! A small in-memory server implementing the M0 wire contract. It exists so the client, the
//! CLI and the NFS mount can be tested without `wrangler dev`. It is not a reference
//! implementation: it favours simplicity over fidelity (no R2, no hibernation, no limits
//! beyond those the contract states).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Extension, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;
use uls_proto::{
    Change, CommitRequest, CommitResponse, CommitResult, ListEntry, ListResponse, MissingRequest,
    MissingResponse, NodeType, Op, RestoreRequest, ShardRef, VersionEntry,
};

type Resp = Response;

fn jerr(status: StatusCode, body: Value) -> Resp {
    (status, axum::Json(body)).into_response()
}
fn err(status: StatusCode, code: &str) -> Resp {
    jerr(status, json!({ "error": code }))
}

#[derive(Clone, Default)]
struct Node {
    is_folder: bool,
    head: Option<String>,
    size: u64,
    ctype: String,
    mtime: i64,
    seq: u64,
}

#[derive(Clone)]
struct Version {
    id: String,
    path: String,
    op: String,
    size: u64,
    ctype: String,
    mtime: i64,
    manifest: Vec<ShardRef>,
    seq: u64,
}

struct Drive {
    placement: Option<String>,
    created_at: i64,
    shards: HashMap<String, Bytes>,
    nodes: BTreeMap<String, Node>,
    versions: Vec<Version>,
    log: Vec<Change>,
    seq: u64,
    tx: broadcast::Sender<Change>,
}

impl Drive {
    /// Event id of the last event of commit `seq` (0 when there is none).
    fn ev_after_seq(&self, seq: u64) -> i64 {
        self.log.iter().rev().find(|c| c.seq <= seq).map_or(0, |c| c.ev)
    }
}

/// Counters and fault-injection switches that tests can poke at.
#[derive(Default)]
pub struct Stats {
    /// Shard PUT requests received (any outcome).
    pub shard_puts: AtomicU64,
    /// Shard PUTs that stored new bytes.
    pub shard_puts_stored: AtomicU64,
    /// Shard GETs served (full or ranged).
    pub shard_gets: AtomicU64,
    /// Ranged shard GETs served.
    pub shard_range_gets: AtomicU64,
    /// Number of upcoming shard PUTs that should fail with 503.
    pub fail_puts: AtomicU64,
    /// Next commit that references shards reports the first one as missing (and forgets it).
    pub report_missing_once: std::sync::atomic::AtomicBool,
    /// A `/watch` whose cursor is more than this many events behind gets `resync` and a close,
    /// like the real server's 100,000-event limit. 0 disables it.
    pub resync_backlog: AtomicU64,
    /// Close every watch socket (code 1012) after it has sent this many change frames. 0 disables.
    /// Lets tests exercise reconnects in the middle of a replay.
    pub watch_cut_after: AtomicU64,
    /// WebSocket upgrades accepted on `/watch`.
    pub watch_connects: AtomicU64,
    /// Requests rejected with 401.
    pub unauthorized: AtomicU64,
}

/// Out-of-band events pushed to open watch sockets.
#[derive(Clone, Debug)]
enum Ctl {
    /// This bearer token expired: close its sockets with 4401.
    Expire(String),
    /// This drive was deleted: close its sockets with 4404.
    Deleted(String),
}

/// The bearer token a request was authenticated with.
#[derive(Clone)]
struct Tok(String);

struct Inner {
    /// Bearer tokens currently accepted.
    tokens: Mutex<HashSet<String>>,
    ctl: broadcast::Sender<Ctl>,
    drives: Mutex<HashMap<String, Drive>>,
    counter: AtomicU64,
    stats: Arc<Stats>,
}

type Shared = Arc<Inner>;

pub struct MockServer {
    addr: SocketAddr,
    pub stats: Arc<Stats>,
    inner: Shared,
    task: tokio::task::JoinHandle<()>,
}

impl MockServer {
    pub async fn start(token: &str) -> MockServer {
        Self::start_on("127.0.0.1:0", token).await.expect("bind")
    }

    pub async fn start_on(addr: &str, token: &str) -> std::io::Result<MockServer> {
        let stats = Arc::new(Stats::default());
        let inner = Arc::new(Inner {
            tokens: Mutex::new(HashSet::from([token.to_string()])),
            ctl: broadcast::channel(64).0,
            drives: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            stats: stats.clone(),
        });
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let addr = listener.local_addr()?;
        let app = router(inner.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(MockServer { addr, stats, inner, task })
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Accept `token` as well (simulates minting a new drive token).
    pub fn add_token(&self, token: &str) {
        self.inner.tokens.lock().unwrap().insert(token.to_string());
    }

    /// Token expiry: `token` is rejected from now on (401), and open watch sockets that used it
    /// are closed with code 4401.
    pub fn expire_token(&self, token: &str) {
        self.inner.tokens.lock().unwrap().remove(token);
        let _ = self.inner.ctl.send(Ctl::Expire(token.to_string()));
    }

    /// Delete a drive: later requests get 404 `no_such_drive`, and open watch sockets are closed
    /// with code 4404.
    pub fn delete_drive(&self, id: &str) {
        self.inner.drives.lock().unwrap().remove(id);
        let _ = self.inner.ctl.send(Ctl::Deleted(id.to_string()));
    }

    /// See [`Stats::resync_backlog`].
    pub fn set_resync_backlog(&self, events: u64) {
        self.stats.resync_backlog.store(events, Ordering::SeqCst);
    }

    /// See [`Stats::watch_cut_after`].
    pub fn set_watch_cut_after(&self, frames: u64) {
        self.stats.watch_cut_after.store(frames, Ordering::SeqCst);
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn router(inner: Shared) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v0/drives/{id}", put(create_drive).get(get_drive))
        .route("/v0/drives/{id}/shards/missing", post(missing))
        .route("/v0/drives/{id}/shards/{hash}", put(put_shard).get(get_shard))
        .route("/v0/drives/{id}/commit", post(commit))
        .route("/v0/drives/{id}/stat", get(stat))
        .route("/v0/drives/{id}/list", get(list))
        .route("/v0/drives/{id}/manifest", get(manifest))
        .route("/v0/drives/{id}/versions", get(versions))
        .route("/v0/drives/{id}/restore", post(restore))
        .route("/v0/drives/{id}/changes", get(changes))
        .route("/v0/drives/{id}/watch", get(watch))
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(inner.clone(), auth))
        .with_state(inner)
}

async fn auth(State(s): State<Shared>, mut req: Request, next: Next) -> Resp {
    if req.uri().path() == "/healthz" {
        return next.run(req).await;
    }
    let hdr = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);
    let query_tok = req.uri().query().and_then(|q| {
        q.split('&')
            .find_map(|kv| kv.strip_prefix("token=").map(str::to_string))
    });
    let is_watch = req.uri().path().ends_with("/watch");
    let presented = hdr.or(if is_watch { query_tok } else { None });
    let ok = presented.as_ref().is_some_and(|t| s.tokens.lock().unwrap().contains(t));
    if let (true, Some(t)) = (ok, presented) {
        req.extensions_mut().insert(Tok(t));
        next.run(req).await
    } else {
        s.stats.unauthorized.fetch_add(1, Ordering::SeqCst);
        err(StatusCode::UNAUTHORIZED, "unauthorized")
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn with_drive<R>(s: &Shared, id: &str, f: impl FnOnce(&mut Drive) -> Result<R, Resp>) -> Result<R, Resp> {
    let mut g = s.drives.lock().unwrap();
    match g.get_mut(id) {
        Some(d) => f(d),
        None => Err(err(StatusCode::NOT_FOUND, "no_such_drive")),
    }
}

fn collapse(r: Result<Resp, Resp>) -> Resp {
    match r {
        Ok(v) | Err(v) => v,
    }
}

async fn create_drive(State(s): State<Shared>, Path(id): Path<String>, body: Bytes) -> Resp {
    let valid = id.len() >= 3
        && id.len() <= 63
        && id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return err(StatusCode::BAD_REQUEST, "bad_drive_id");
    }
    let placement = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("placement").and_then(|p| p.as_str().map(str::to_string)));
    let mut g = s.drives.lock().unwrap();
    if g.contains_key(&id) {
        return err(StatusCode::CONFLICT, "drive_exists");
    }
    let created_at = now_ms();
    let mut nodes = BTreeMap::new();
    nodes.insert(String::new(), Node { is_folder: true, ..Default::default() });
    g.insert(
        id.clone(),
        Drive {
            placement: placement.clone(),
            created_at,
            shards: HashMap::new(),
            nodes,
            versions: vec![],
            log: vec![],
            seq: 0,
            tx: broadcast::channel(1024).0,
        },
    );
    jerr(
        StatusCode::CREATED,
        json!({"driveId": id, "placement": placement, "createdAt": created_at}),
    )
}

async fn get_drive(State(s): State<Shared>, Path(id): Path<String>) -> Resp {
    collapse(with_drive(&s, &id, |d| {
        let files = d.nodes.values().filter(|n| !n.is_folder).count();
        let bytes: u64 = d.nodes.values().filter(|n| !n.is_folder).map(|n| n.size).sum();
        Ok(jerr(
            StatusCode::OK,
            json!({"driveId": id, "placement": d.placement, "createdAt": d.created_at,
                   "headSeq": d.seq, "fileCount": files, "bytes": bytes}),
        ))
    }))
}

async fn missing(State(s): State<Shared>, Path(id): Path<String>, axum::Json(req): axum::Json<MissingRequest>) -> Resp {
    if req.hashes.len() > uls_proto::MAX_MISSING_HASHES {
        return err(StatusCode::BAD_REQUEST, "too_many_hashes");
    }
    collapse(with_drive(&s, &id, |d| {
        let missing: Vec<String> = req.hashes.iter().filter(|h| !d.shards.contains_key(*h)).cloned().collect();
        Ok(jerr(StatusCode::OK, serde_json::to_value(MissingResponse { missing }).unwrap()))
    }))
}

async fn put_shard(State(s): State<Shared>, Path((id, hash)): Path<(String, String)>, body: Bytes) -> Resp {
    s.stats.shard_puts.fetch_add(1, Ordering::SeqCst);
    let pending = s.stats.fail_puts.load(Ordering::SeqCst);
    if pending > 0 {
        s.stats.fail_puts.store(pending - 1, Ordering::SeqCst);
        return err(StatusCode::SERVICE_UNAVAILABLE, "unavailable");
    }
    if body.len() as u64 > uls_proto::MAX_SHARD_BODY {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "too_large");
    }
    if uls_chunk::sha256_hex(&body) != hash {
        return err(StatusCode::BAD_REQUEST, "hash_mismatch");
    }
    collapse(with_drive(&s, &id, |d| {
        let size = body.len();
        let is_new = d.shards.insert(hash.clone(), body).is_none();
        if is_new {
            s.stats.shard_puts_stored.fetch_add(1, Ordering::SeqCst);
        }
        Ok(jerr(
            if is_new { StatusCode::CREATED } else { StatusCode::OK },
            json!({"hash": hash, "size": size, "stored": is_new}),
        ))
    }))
}

fn parse_range(v: &str, len: usize) -> Option<(usize, usize)> {
    let spec = v.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let start: usize = a.parse().ok()?;
    let end: usize = if b.is_empty() { len.checked_sub(1)? } else { b.parse().ok()? };
    (start <= end && start < len).then_some((start, end.min(len - 1)))
}

async fn get_shard(State(s): State<Shared>, Path((id, hash)): Path<(String, String)>, headers: HeaderMap) -> Resp {
    collapse(with_drive(&s, &id, |d| {
        let Some(data) = d.shards.get(&hash).cloned() else {
            return Ok(err(StatusCode::NOT_FOUND, "no_such_shard"));
        };
        s.stats.shard_gets.fetch_add(1, Ordering::SeqCst);
        let mut r = Response::builder()
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .header(header::ETAG, format!("\"{hash}\""))
            .header(header::ACCEPT_RANGES, "bytes");
        let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
        let resp = if let Some(rv) = range {
            match parse_range(rv, data.len()) {
                Some((a, b)) => {
                    s.stats.shard_range_gets.fetch_add(1, Ordering::SeqCst);
                    r = r
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(header::CONTENT_RANGE, format!("bytes {a}-{b}/{}", data.len()));
                    r.body(axum::body::Body::from(data.slice(a..=b)))
                }
                None => {
                    return Ok(Response::builder()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_RANGE, format!("bytes */{}", data.len()))
                        .body(axum::body::Body::empty())
                        .unwrap());
                }
            }
        } else {
            r.status(StatusCode::OK).body(axum::body::Body::from(data))
        };
        Ok(resp.unwrap())
    }))
}

fn push_log(d: &mut Drive, seq: u64, path: &str, op: &str, version: Option<&str>) {
    let ev = d.log.len() as i64 + 1;
    let ch = Change { ev, seq, path: path.to_string(), op: op.to_string(), version_id: version.map(str::to_string) };
    d.log.push(ch.clone());
    let _ = d.tx.send(ch);
}

fn ensure_parents(nodes: &mut BTreeMap<String, Node>, path: &str, seq: u64) -> Result<(), Resp> {
    let mut acc = String::new();
    let segs: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    for seg in &segs[..segs.len().saturating_sub(1)] {
        acc.push_str(seg);
        if nodes.get(&acc).is_some_and(|n| !n.is_folder) {
            return Err(jerr(StatusCode::CONFLICT, json!({"error":"path_conflict","path":acc})));
        }
        acc.push('/');
        nodes.entry(acc.clone()).or_insert(Node { is_folder: true, seq, ..Default::default() });
    }
    Ok(())
}

fn precondition(path: &str, current: Option<&str>) -> Resp {
    jerr(
        StatusCode::PRECONDITION_FAILED,
        json!({"error":"precondition_failed","path":path,"currentVersionId":current}),
    )
}

fn next_version(s: &Shared) -> String {
    format!("v_{:026}", s.counter.fetch_add(1, Ordering::SeqCst) + 1)
}

async fn commit(State(s): State<Shared>, Path(id): Path<String>, axum::Json(req): axum::Json<CommitRequest>) -> Resp {
    collapse(with_drive(&s, &id, |d| apply_commit(&s, d, req.ops).map(|r| jerr(StatusCode::OK, serde_json::to_value(r).unwrap()))))
}

fn apply_commit(s: &Shared, d: &mut Drive, ops: Vec<Op>) -> Result<CommitResponse, Resp> {
    if ops.is_empty() || ops.len() > uls_proto::MAX_COMMIT_OPS {
        return Err(err(StatusCode::BAD_REQUEST, "bad_ops"));
    }
    // Fault injection: pretend the first referenced shard vanished.
    if s.stats.report_missing_once.load(Ordering::SeqCst) {
        let first = ops.iter().find_map(|o| match o {
            Op::Put { shards, .. } => shards.first().map(|r| r.h.clone()),
            _ => None,
        });
        if let Some(h) = first {
            s.stats.report_missing_once.store(false, Ordering::SeqCst);
            d.shards.remove(&h);
        }
    }
    let mut nodes = d.nodes.clone();
    let seq = d.seq + 1;
    let ts = now_ms();
    let mut new_versions: Vec<Version> = vec![];
    let mut logs: Vec<(String, String, Option<String>)> = vec![];
    let mut results = vec![];
    let mut missing = vec![];
    for op in &ops {
        match op {
            Op::Put { path, if_version, if_absent, size, content_type, mtime_ms, shards } => {
                if uls_proto::validate_path(path).is_err() || path.is_empty() || path.ends_with('/') {
                    return Err(err(StatusCode::BAD_REQUEST, "bad_path"));
                }
                if shards.iter().map(|r| r.n).sum::<u64>() != *size {
                    return Err(err(StatusCode::BAD_REQUEST, "bad_manifest"));
                }
                for r in shards {
                    if !d.shards.contains_key(&r.h) && !missing.contains(&r.h) {
                        missing.push(r.h.clone());
                    }
                }
                let cur = nodes.get(path).and_then(|n| n.head.clone());
                if let Some(v) = if_version
                    && cur.as_deref() != Some(v.as_str())
                {
                    return Err(precondition(path, cur.as_deref()));
                }
                if *if_absent && nodes.contains_key(path) {
                    return Err(precondition(path, cur.as_deref()));
                }
                if nodes.contains_key(&format!("{path}/")) {
                    return Err(jerr(StatusCode::CONFLICT, json!({"error":"path_conflict","path":path})));
                }
                ensure_parents(&mut nodes, path, seq)?;
                let vid = next_version(s);
                nodes.insert(path.clone(), Node {
                    is_folder: false, head: Some(vid.clone()), size: *size,
                    ctype: content_type.clone(), mtime: *mtime_ms, seq,
                });
                new_versions.push(Version {
                    id: vid.clone(), path: path.clone(), op: "put".into(), size: *size,
                    ctype: content_type.clone(), mtime: *mtime_ms, manifest: shards.clone(), seq,
                });
                logs.push((path.clone(), "put".into(), Some(vid.clone())));
                results.push(CommitResult { path: path.clone(), version_id: vid, size: Some(*size) });
            }
            Op::Mkdir { path } => {
                if uls_proto::validate_path(path).is_err() || !path.ends_with('/') {
                    return Err(err(StatusCode::BAD_REQUEST, "bad_path"));
                }
                if nodes.contains_key(path.trim_end_matches('/')) {
                    return Err(jerr(StatusCode::CONFLICT, json!({"error":"path_conflict","path":path})));
                }
                ensure_parents(&mut nodes, path, seq)?;
                nodes.entry(path.clone()).or_insert(Node { is_folder: true, seq, ..Default::default() });
                let vid = next_version(s);
                new_versions.push(Version {
                    id: vid.clone(), path: path.clone(), op: "mkdir".into(), size: 0,
                    ctype: String::new(), mtime: ts, manifest: vec![], seq,
                });
                logs.push((path.clone(), "mkdir".into(), Some(vid.clone())));
                results.push(CommitResult { path: path.clone(), version_id: vid, size: None });
            }
            Op::Delete { path, if_version } => {
                let Some(node) = nodes.get(path).cloned() else {
                    return Err(err(StatusCode::NOT_FOUND, "no_such_path"));
                };
                if let Some(v) = if_version
                    && node.head.as_deref() != Some(v.as_str())
                {
                    return Err(precondition(path, node.head.as_deref()));
                }
                if node.is_folder {
                    nodes.retain(|k, _| !k.starts_with(path.as_str()));
                } else {
                    nodes.remove(path);
                }
                let vid = next_version(s);
                new_versions.push(Version {
                    id: vid.clone(), path: path.clone(), op: "delete".into(), size: 0,
                    ctype: String::new(), mtime: ts, manifest: vec![], seq,
                });
                logs.push((path.clone(), "delete".into(), Some(vid.clone())));
                results.push(CommitResult { path: path.clone(), version_id: vid, size: None });
            }
            Op::Rename { from, to, if_version } => {
                let Some(node) = nodes.get(from).cloned() else {
                    return Err(err(StatusCode::NOT_FOUND, "no_such_path"));
                };
                if let Some(v) = if_version
                    && node.head.as_deref() != Some(v.as_str())
                {
                    return Err(precondition(from, node.head.as_deref()));
                }
                if nodes.contains_key(to) || uls_proto::validate_path(to).is_err() || from.ends_with('/') != to.ends_with('/') {
                    return Err(jerr(StatusCode::CONFLICT, json!({"error":"path_conflict","path":to})));
                }
                ensure_parents(&mut nodes, to, seq)?;
                let moved: Vec<String> = if node.is_folder {
                    nodes.keys().filter(|k| k.starts_with(from.as_str())).cloned().collect()
                } else {
                    vec![from.clone()]
                };
                for k in moved {
                    if let Some(n) = nodes.remove(&k) {
                        nodes.insert(format!("{to}{}", &k[from.len()..]), n);
                    }
                }
                let vid = next_version(s);
                new_versions.push(Version {
                    id: vid.clone(), path: to.clone(), op: "rename".into(), size: node.size,
                    ctype: node.ctype.clone(), mtime: node.mtime, manifest: vec![], seq,
                });
                logs.push((to.clone(), "rename".into(), Some(vid.clone())));
                results.push(CommitResult { path: to.clone(), version_id: vid, size: None });
            }
        }
    }
    if !missing.is_empty() {
        return Err(jerr(StatusCode::CONFLICT, json!({"error":"missing_shards","hashes":missing})));
    }
    d.nodes = nodes;
    d.seq = seq;
    d.versions.extend(new_versions);
    for (p, o, v) in logs {
        push_log(d, seq, &p, &o, v.as_deref());
    }
    Ok(CommitResponse { seq, results })
}

#[derive(Deserialize)]
struct PathQ {
    #[serde(default)]
    path: String,
    #[serde(rename = "versionId")]
    version_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}

fn find_node<'a>(d: &'a Drive, path: &str) -> Option<(String, &'a Node)> {
    if let Some(n) = d.nodes.get(path) {
        return Some((path.to_string(), n));
    }
    let with_slash = format!("{path}/");
    d.nodes.get(&with_slash).map(|n| (with_slash, n))
}

async fn stat(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<PathQ>) -> Resp {
    collapse(with_drive(&s, &id, |d| {
        let Some((p, n)) = find_node(d, &q.path) else {
            return Ok(err(StatusCode::NOT_FOUND, "no_such_path"));
        };
        Ok(jerr(StatusCode::OK, if n.is_folder {
            json!({"path": p, "type": "folder", "versionId": n.head, "size": 0, "contentType": null, "mtimeMs": null, "seq": n.seq})
        } else {
            json!({"path": p, "type": "file", "versionId": n.head, "size": n.size, "contentType": n.ctype, "mtimeMs": n.mtime, "seq": n.seq})
        }))
    }))
}

async fn list(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<PathQ>) -> Resp {
    collapse(with_drive(&s, &id, |d| {
        let prefix = if q.path.is_empty() || q.path.ends_with('/') { q.path.clone() } else { format!("{}/", q.path) };
        if !d.nodes.get(&prefix).is_some_and(|n| n.is_folder) {
            return Ok(err(StatusCode::NOT_FOUND, "no_such_path"));
        }
        let mut entries: Vec<ListEntry> = vec![];
        for (k, n) in d.nodes.range(prefix.clone()..) {
            if !k.starts_with(&prefix) {
                break;
            }
            let rest = &k[prefix.len()..];
            if rest.is_empty() || rest.trim_end_matches('/').contains('/') {
                continue;
            }
            entries.push(ListEntry {
                name: rest.trim_end_matches('/').to_string(),
                node_type: if n.is_folder { NodeType::Folder } else { NodeType::File },
                version_id: n.head.clone(),
                size: Some(n.size),
                mtime_ms: Some(n.mtime),
            });
        }
        entries.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
        let limit = q.limit.unwrap_or(1000).clamp(1, 1000);
        let start = q.cursor.as_deref().and_then(|c| c.parse::<usize>().ok()).unwrap_or(0);
        let end = (start + limit).min(entries.len());
        let cursor = (end < entries.len()).then(|| end.to_string());
        let page = entries[start.min(end)..end].to_vec();
        Ok(jerr(StatusCode::OK, serde_json::to_value(ListResponse { entries: page, cursor }).unwrap()))
    }))
}

async fn manifest(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<PathQ>) -> Resp {
    collapse(with_drive(&s, &id, |d| {
        let v = match &q.version_id {
            Some(vid) => d.versions.iter().find(|v| &v.id == vid && v.path == q.path && v.op != "delete" && v.op != "mkdir"),
            None => {
                let Some(head) = d.nodes.get(&q.path).and_then(|n| n.head.clone()) else {
                    return Ok(err(StatusCode::NOT_FOUND, "no_such_path"));
                };
                d.versions.iter().find(|v| v.id == head)
            }
        };
        let Some(v) = v else { return Ok(err(StatusCode::NOT_FOUND, "no_such_path")) };
        Ok(jerr(StatusCode::OK, json!({
            "path": v.path, "versionId": v.id, "size": v.size, "contentType": v.ctype,
            "mtimeMs": v.mtime, "shards": v.manifest,
        })))
    }))
}

async fn versions(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<PathQ>) -> Resp {
    collapse(with_drive(&s, &id, |d| {
        let all: Vec<VersionEntry> = d.versions.iter().filter(|v| v.path == q.path).map(|v| VersionEntry {
            version_id: v.id.clone(), op: v.op.clone(), size: Some(v.size), seq: v.seq, ts: 0, actor: Some("dev".into()),
        }).collect();
        // The cursor is opaque to clients; here it is the index of the next entry.
        let limit = q.limit.unwrap_or(1000).clamp(1, 1000);
        let start = match q.cursor.as_deref() {
            None => 0,
            Some(c) => match c.parse::<usize>() {
                Ok(n) => n,
                Err(_) => return Ok(jerr(StatusCode::BAD_REQUEST, json!({"error":"bad_request","message":"invalid cursor"}))),
            },
        };
        let end = start.saturating_add(limit).min(all.len());
        let cursor = (end < all.len()).then(|| end.to_string());
        let page = all[start.min(end)..end].to_vec();
        Ok(jerr(StatusCode::OK, json!({"versions": page, "cursor": cursor})))
    }))
}

async fn restore(State(s): State<Shared>, Path(id): Path<String>, axum::Json(req): axum::Json<RestoreRequest>) -> Resp {
    collapse(with_drive(&s, &id, |d| {
        let Some(old) = d.versions.iter().find(|v| v.id == req.version_id && v.path == req.path && v.op != "delete").cloned() else {
            return Ok(err(StatusCode::NOT_FOUND, "no_such_version"));
        };
        let op = Op::Put {
            path: req.path.clone(), if_version: req.if_version.clone(), if_absent: false, size: old.size,
            content_type: old.ctype.clone(), mtime_ms: old.mtime, shards: old.manifest.clone(),
        };
        apply_commit(&s, d, vec![op]).map(|r| jerr(StatusCode::OK, serde_json::to_value(r).unwrap()))
    }))
}

#[derive(Deserialize)]
struct FeedQ {
    after: Option<i64>,
    since: Option<u64>,
    limit: Option<usize>,
}

/// Cursor of a feed request as an event id (`after` wins over `since`); `None` when neither is given.
fn feed_after(d: &Drive, q: &FeedQ) -> Option<i64> {
    q.after.map(|a| a.max(0)).or(q.since.map(|sn| d.ev_after_seq(sn)))
}

async fn changes(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<FeedQ>) -> Resp {
    collapse(with_drive(&s, &id, |d| {
        let limit = q.limit.unwrap_or(1000).clamp(1, 1000);
        let after = feed_after(d, &q).unwrap_or(0);
        let all: Vec<&Change> = d.log.iter().filter(|c| c.ev > after).collect();
        let more = all.len() > limit;
        let page: Vec<&Change> = all.into_iter().take(limit).collect();
        Ok(jerr(StatusCode::OK, json!({
            "changes": page, "headSeq": d.seq, "lastEv": d.log.len() as i64, "more": more,
        })))
    }))
}

enum Plan {
    Replay(Vec<Change>),
    Resync { head_seq: u64, last_ev: i64 },
}

async fn watch(
    State(s): State<Shared>,
    Path(id): Path<String>,
    Extension(Tok(tok)): Extension<Tok>,
    Query(q): Query<FeedQ>,
    ws: WebSocketUpgrade,
) -> Resp {
    let sub = with_drive(&s, &id, |d| {
        let last = d.log.len() as i64;
        let after = feed_after(d, &q).unwrap_or(last).min(last);
        let backlog = s.stats.resync_backlog.load(Ordering::SeqCst);
        let plan = if backlog > 0 && (last - after) as u64 > backlog {
            Plan::Resync { head_seq: d.seq, last_ev: last }
        } else {
            Plan::Replay(d.log[after as usize..].to_vec())
        };
        // Subscribe under the same lock as the replay snapshot so nothing falls in between.
        Ok((d.tx.subscribe(), plan))
    });
    match sub {
        Err(r) => r,
        Ok((rx, plan)) => {
            s.stats.watch_connects.fetch_add(1, Ordering::SeqCst);
            let ctl = s.ctl.subscribe();
            let cut = s.stats.watch_cut_after.load(Ordering::SeqCst);
            ws.on_upgrade(move |sock| watch_loop(sock, rx, plan, ctl, tok, id, cut))
        }
    }
}

async fn close_with(sock: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = sock.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
}

async fn watch_loop(
    mut sock: WebSocket,
    mut rx: broadcast::Receiver<Change>,
    plan: Plan,
    mut ctl: broadcast::Receiver<Ctl>,
    tok: String,
    drive: String,
    cut_after: u64,
) {
    let frame = |c: &Change| {
        Message::Text(
            json!({"type":"change","ev":c.ev,"seq":c.seq,"path":c.path,"op":c.op,"versionId":c.version_id})
                .to_string()
                .into(),
        )
    };
    let replay = match plan {
        Plan::Resync { head_seq, last_ev } => {
            let m = json!({"type":"resync","headSeq":head_seq,"lastEv":last_ev}).to_string();
            let _ = sock.send(Message::Text(m.into())).await;
            close_with(&mut sock, 1000, "resync").await;
            return;
        }
        Plan::Replay(r) => r,
    };
    let mut last = 0i64;
    let mut sent = 0u64;
    for c in &replay {
        if cut_after > 0 && sent >= cut_after {
            close_with(&mut sock, 1012, "cut").await;
            return;
        }
        last = last.max(c.ev);
        sent += 1;
        if sock.send(frame(c)).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            r = rx.recv() => match r {
                Ok(c) if c.ev > last => {
                    if cut_after > 0 && sent >= cut_after {
                        close_with(&mut sock, 1012, "cut").await;
                        return;
                    }
                    last = c.ev;
                    sent += 1;
                    if sock.send(frame(&c)).await.is_err() { return; }
                }
                Ok(_) => {}
                Err(_) => return,
            },
            c = ctl.recv() => match c {
                Ok(Ctl::Expire(t)) if t == tok => { close_with(&mut sock, 4401, "token expired").await; return; }
                Ok(Ctl::Deleted(d)) if d == drive => { close_with(&mut sock, 4404, "drive deleted").await; return; }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => return,
            },
            m = sock.recv() => match m {
                Some(Ok(_)) => {}
                _ => return,
            },
        }
    }
}
