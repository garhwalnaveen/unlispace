use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uls_client::{Client, RetryPolicy};
use uls_mock::MockServer;
use uls_proto::{Op, ShardRef};
use uls_vfs::{Kind, Vfs, VfsOptions};

fn options() -> VfsOptions {
    VfsOptions { quiet_window: Duration::from_secs(3600), max_dirty_age: Duration::from_secs(3600),
        retry_initial: Duration::from_secs(3600), retry_max: Duration::from_secs(3600),
        ..VfsOptions::default() }
}

fn client(url: String) -> Client {
    Client::builder(url, "test").retry(RetryPolicy { max_attempts: 1,
        base_delay: Duration::from_millis(1), max_delay: Duration::from_millis(1) }).build().unwrap()
}

fn data(len: usize) -> Vec<u8> {
    let mut state = 0x756c73_u64;
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        out.extend_from_slice(&(z ^ (z >> 31)).to_le_bytes());
    }
    out.truncate(len); out
}

fn shards(data: &[u8]) -> Vec<ShardRef> {
    uls_chunk::chunk_slice(data).into_iter().map(|c| ShardRef { h: c.hash, n: c.length as u64 }).collect()
}

async fn seed(c: &Client, data: &[u8]) -> Vec<ShardRef> {
    c.create_drive("drive", None).await.unwrap();
    let refs = shards(data);
    let mut off = 0;
    for s in &refs {
        let end = off + s.n as usize;
        c.put_shard("drive", &s.h, Bytes::copy_from_slice(&data[off..end])).await.unwrap(); off = end;
    }
    c.commit("drive", vec![Op::Put { path: "a".into(), if_version: None, if_absent: true,
        size: data.len() as u64, content_type: "application/octet-stream".into(), mtime_ms: 0,
        shards: refs.clone() }]).await.unwrap();
    refs
}

#[derive(Default)]
struct Traffic {
    gets: Vec<(String, usize)>,
    puts: Vec<String>,
    missing: usize,
    fail_put: Option<(usize, bool)>,
}

// A loopback-only recording proxy keeps byte counts and upload interruption outside the VFS API.
struct Proxy {
    url: String,
    traffic: Arc<Mutex<Traffic>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Proxy {
    fn drop(&mut self) { self.task.abort(); }
}
impl Proxy {
    async fn start(server: &MockServer) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let upstream = server.url().trim_start_matches("http://").to_string();
        let traffic = Arc::new(Mutex::new(Traffic::default()));
        let record = traffic.clone();
        let task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (socket, _) = accepted.unwrap();
                        let (upstream, record) = (upstream.clone(), record.clone());
                        tasks.spawn(async move { proxy_request(socket, &upstream, record).await; });
                    }
                    Some(result) = tasks.join_next(), if !tasks.is_empty() => { result.unwrap(); }
                }
            }
        });
        Self { url, traffic, task }
    }
}

async fn proxy_request(mut socket: TcpStream, upstream: &str, traffic: Arc<Mutex<Traffic>>) {
    let mut request = Vec::new();
    let header_end = loop {
        let mut buf = [0; 8192];
        let n = socket.read(&mut buf).await.unwrap();
        if n == 0 { return; }
        request.extend_from_slice(&buf[..n]);
        if let Some(i) = request.windows(4).position(|w| w == b"\r\n\r\n") { break i + 4; }
    };
    let header = String::from_utf8(request[..header_end].to_vec()).unwrap();
    let length = header.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
    }).unwrap_or(0);
    while request.len() < header_end + length {
        let mut buf = [0; 8192];
        let n = socket.read(&mut buf).await.unwrap(); assert!(n > 0);
        request.extend_from_slice(&buf[..n]);
    }
    let mut first = header.lines().next().unwrap().split_whitespace();
    let method = first.next().unwrap(); let path = first.next().unwrap();
    let hash = path.rsplit('/').next().unwrap().to_string();
    let is_shard = path.contains("/shards/") && hash != "missing";
    let fail = {
        let mut t = traffic.lock().unwrap();
        if path.ends_with("/shards/missing") { t.missing += 1; }
        if method == "PUT" && is_shard {
            t.puts.push(hash.clone());
            t.fail_put.filter(|(i, _)| *i == t.puts.len())
        } else { None }
    };
    let response = if matches!(fail, Some((_, false))) {
        // Fail before forwarding the selected PUT.
        Vec::new()
    } else {
        let mut connection = TcpStream::connect(upstream).await.unwrap();
        let mut outgoing = header.lines().filter(|line| !line.is_empty()
            && !line.to_ascii_lowercase().starts_with("connection:"))
            .collect::<Vec<_>>().join("\r\n");
        outgoing.push_str("\r\nConnection: close\r\n\r\n");
        connection.write_all(outgoing.as_bytes()).await.unwrap();
        connection.write_all(&request[header_end..]).await.unwrap();
        let mut response = Vec::new(); connection.read_to_end(&mut response).await.unwrap();
        response
    };
    if method == "GET" && is_shard {
        let body = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        traffic.lock().unwrap().gets.push((hash, response.len() - body));
    }
    if fail.is_some() {
        socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    } else { socket.write_all(&response).await.unwrap(); }
}

async fn assert_manifest(c: &Client, expected: &[u8]) {
    let m = c.manifest("drive", "a", None).await.unwrap();
    assert_eq!(m.size, expected.len() as u64);
    assert_eq!(m.shards, shards(expected));
}

fn assert_no_scratch(dir: &std::path::Path) {
    assert!(std::fs::read_dir(dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with("fold-")));
}

#[tokio::test]
async fn four_kib_edit_in_64_mib_reads_at_most_three_base_shards() {
    let server = MockServer::start("test").await;
    let direct = client(server.url());
    let mut expected = data(64 << 20);
    let base = seed(&direct, &expected).await;
    let proxy = Proxy::start(&server).await;
    let c = client(proxy.url.clone());
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let v = Vfs::open(c.clone(), "drive", dir.path(), options()).await.unwrap();
    let off = expected.len() / 2;
    for b in &mut expected[off..off + 4096] { *b = !*b; }
    v.write("a", off as u64, &expected[off..off + 4096]).await.unwrap();
    v.shutdown().await.unwrap();
    {
        let t = proxy.traffic.lock().unwrap();
        let lengths: BTreeMap<_, _> = base.iter().map(|s| (s.h.as_str(), s.n)).collect();
        let bytes: u64 = t.gets.iter().map(|(_, n)| *n as u64).sum();
        let touched: u64 = t.gets.iter().map(|(h, _)| lengths[h.as_str()]).sum();
        assert!(t.gets.len() <= 3, "base requests: {:?}", t.gets);
        assert!(bytes <= touched, "base bytes exceed requested shard sizes");
        assert!(!t.puts.is_empty() && t.puts.len() <= 2, "new shards: {:?}", t.puts);
        println!("4 KiB / 64 MiB: {} base GETs, {bytes} base bytes, {} shard PUTs", t.gets.len(), t.puts.len());
    }
    assert_manifest(&c, &expected).await; assert_no_scratch(dir.path());
}

#[tokio::test]
async fn middle_insert_and_delete_match_full_cdc() {
    for insert in [true, false] {
        let server = MockServer::start("test").await;
        let c = client(server.url());
        let mut expected = data(8 << 20);
        seed(&c, &expected).await;
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let v = Vfs::open(c.clone(), "drive", dir.path(), options()).await.unwrap();
        let off = expected.len() / 2;
        if insert { expected.splice(off..off, [0x5a; 4096]); }
        else { expected.drain(off..off + 4096); }
        v.write("a", off as u64, &expected[off..]).await.unwrap();
        v.truncate("a", expected.len() as u64).await.unwrap();
        v.shutdown().await.unwrap(); assert_manifest(&c, &expected).await;
        assert_no_scratch(dir.path());
    }
}

#[tokio::test]
async fn append_reopens_the_eof_chunk_and_handles_max_size_boundary() {
    for mut expected in [data(8 << 20), vec![0; uls_chunk::MAX_SIZE as usize]] {
        let server = MockServer::start("test").await;
        let c = client(server.url());
        seed(&c, &expected).await;
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let v = Vfs::open(c.clone(), "drive", dir.path(), options()).await.unwrap();
        let off = expected.len(); expected.extend_from_slice(&[0x5a; 4097]);
        v.write("a", off as u64, &expected[off..]).await.unwrap();
        v.shutdown().await.unwrap(); assert_manifest(&c, &expected).await;
    }
}

#[tokio::test]
async fn truncate_at_and_inside_boundaries_then_regrow_does_not_restore_base_bytes() {
    for regrow in [false, true] {
        let server = MockServer::start("test").await;
        let c = client(server.url());
        let mut expected = data(8 << 20);
        let base = seed(&c, &expected).await;
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let v = Vfs::open(c.clone(), "drive", dir.path(), options()).await.unwrap();
        let size = base[0].n as usize + if regrow { 17 } else { 0 };
        v.truncate("a", size as u64).await.unwrap(); expected.truncate(size);
        if regrow {
            v.truncate("a", (size + 8193) as u64).await.unwrap(); expected.resize(size + 8193, 0);
        }
        v.write("a", 0, b"edit").await.unwrap(); expected[..4].copy_from_slice(b"edit");
        v.shutdown().await.unwrap(); assert_manifest(&c, &expected).await;
    }
}

#[tokio::test]
async fn truncation_on_an_old_boundary_reuses_prefix_without_reading_base() {
    let server = MockServer::start("test").await;
    let direct = client(server.url());
    let expected = data(8 << 20);
    let base = seed(&direct, &expected).await;
    let proxy = Proxy::start(&server).await;
    let c = client(proxy.url.clone());
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let v = Vfs::open(c.clone(), "drive", dir.path(), options()).await.unwrap();
    v.truncate("a", base[0].n).await.unwrap();
    v.shutdown().await.unwrap();
    let m = c.manifest("drive", "a", None).await.unwrap();
    assert_eq!(m.shards, &base[..1]);
    let t = proxy.traffic.lock().unwrap();
    assert!(t.gets.is_empty()); assert!(t.puts.is_empty());
}

#[tokio::test]
async fn interrupted_upload_reopens_and_probes_without_reuploading_stored_shards() {
    for lost_ack in [false, true] {
        let server = MockServer::start("test").await;
        let direct = client(server.url()); direct.create_drive("drive", None).await.unwrap();
        let proxy = Proxy::start(&server).await;
        proxy.traffic.lock().unwrap().fail_put = Some((2, lost_ack));
        let c = client(proxy.url.clone());
        let expected = data(8 << 20);
        assert!(shards(&expected).len() >= 3);
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let v = Vfs::open(c.clone(), "drive", dir.path(), options()).await.unwrap();
        v.create("a", Kind::File).await.unwrap(); v.write("a", 0, &expected).await.unwrap();
        assert!(v.shutdown().await.is_err()); assert_no_scratch(dir.path());
        let stored = {
            let mut t = proxy.traffic.lock().unwrap(); t.fail_put = None;
            assert_eq!(t.puts.len(), 2);
            t.puts[..if lost_ack { 2 } else { 1 }].to_vec()
        };
        let v = Vfs::open(c.clone(), "drive", dir.path(), options()).await.unwrap();
        v.shutdown().await.unwrap();
        {
            let t = proxy.traffic.lock().unwrap(); assert!(t.missing >= 2);
            for hash in stored { assert_eq!(t.puts.iter().filter(|h| **h == hash).count(), 1); }
        }
        assert_manifest(&c, &expected).await; assert_no_scratch(dir.path());
    }
}
