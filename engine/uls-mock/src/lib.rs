#![allow(clippy::result_large_err)] // test-support server: Response as the error type keeps handlers terse
//! A small in-memory server implementing the M0 wire contract. It exists so the client, the
//! CLI and the NFS mount can be tested without `wrangler dev`. It is not a reference
//! implementation: it favours simplicity over fidelity (no R2, no hibernation, no limits
//! beyond those the contract states).

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
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
}

struct Inner {
    token: String,
    drives: Mutex<HashMap<String, Drive>>,
    counter: AtomicU64,
    stats: Arc<Stats>,
}

type Shared = Arc<Inner>;

pub struct MockServer {
    addr: SocketAddr,
    pub stats: Arc<Stats>,
    task: tokio::task::JoinHandle<()>,
}

impl MockServer {
    pub async fn start(token: &str) -> MockServer {
        Self::start_on("127.0.0.1:0", token).await.expect("bind")
    }

    pub async fn start_on(addr: &str, token: &str) -> std::io::Result<MockServer> {
        let stats = Arc::new(Stats::default());
        let inner = Arc::new(Inner {
            token: token.to_string(),
            drives: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            stats: stats.clone(),
        });
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let addr = listener.local_addr()?;
        let app = router(inner);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(MockServer { addr, stats, task })
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
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

async fn auth(State(s): State<Shared>, req: Request, next: Next) -> Resp {
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
    let ok = hdr.as_deref() == Some(&s.token) || (is_watch && query_tok.as_deref() == Some(&s.token));
    if ok {
        next.run(req).await
    } else {
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
    let ch = Change { seq, path: path.to_string(), op: op.to_string(), version_id: version.map(str::to_string) };
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
        let list: Vec<VersionEntry> = d.versions.iter().filter(|v| v.path == q.path).map(|v| VersionEntry {
            version_id: v.id.clone(), op: v.op.clone(), size: Some(v.size), seq: v.seq, ts: 0, actor: Some("dev".into()),
        }).collect();
        Ok(jerr(StatusCode::OK, json!({"versions": list})))
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
struct SinceQ {
    #[serde(default)]
    since: u64,
    limit: Option<usize>,
}

async fn changes(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<SinceQ>) -> Resp {
    collapse(with_drive(&s, &id, |d| {
        let limit = q.limit.unwrap_or(1000).clamp(1, 1000);
        let all: Vec<&Change> = d.log.iter().filter(|c| c.seq > q.since).collect();
        let more = all.len() > limit;
        let page: Vec<&Change> = all.into_iter().take(limit).collect();
        Ok(jerr(StatusCode::OK, json!({"changes": page, "headSeq": d.seq, "more": more})))
    }))
}

async fn watch(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<SinceQ>, ws: WebSocketUpgrade) -> Resp {
    let sub = with_drive(&s, &id, |d| {
        let rx = d.tx.subscribe();
        let replay: Vec<Change> = d.log.iter().filter(|c| c.seq > q.since).cloned().collect();
        Ok((rx, replay))
    });
    match sub {
        Err(r) => r,
        Ok((rx, replay)) => ws.on_upgrade(move |sock| watch_loop(sock, rx, replay)),
    }
}

async fn watch_loop(mut sock: WebSocket, mut rx: broadcast::Receiver<Change>, replay: Vec<Change>) {
    let mut last = 0;
    let frame = |c: &Change| {
        Message::Text(
            json!({"type":"change","seq":c.seq,"path":c.path,"op":c.op,"versionId":c.version_id})
                .to_string()
                .into(),
        )
    };
    for c in &replay {
        last = last.max(c.seq);
        if sock.send(frame(c)).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            r = rx.recv() => match r {
                Ok(c) if c.seq >= last => {
                    last = c.seq;
                    if sock.send(frame(&c)).await.is_err() { return; }
                }
                Ok(_) => {}
                Err(_) => return,
            },
            m = sock.recv() => match m {
                Some(Ok(_)) => {}
                _ => return,
            },
        }
    }
}
