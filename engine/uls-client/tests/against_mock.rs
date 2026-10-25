//! End-to-end client behaviour against the in-memory contract server.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use futures_util::StreamExt;
use uls_client::{Client, Error, ShardCache};
use uls_mock::MockServer;

const TOKEN: &str = "test-token";

/// Deterministic pseudo-random bytes (chunk boundaries need entropy).
fn data(len: usize, seed: u64) -> Vec<u8> {
    let mut s = seed;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        s = s.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = s;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        out.extend_from_slice(&(z ^ (z >> 31)).to_le_bytes());
    }
    out.truncate(len);
    out
}

async fn setup() -> (MockServer, Client, tempfile::TempDir) {
    let srv = MockServer::start(TOKEN).await;
    let c = Client::builder(srv.url(), TOKEN).build().unwrap();
    c.create_drive("demo", Some("wnam")).await.unwrap();
    (srv, c, tempfile::tempdir().unwrap())
}

#[tokio::test]
async fn reupload_sends_zero_shard_puts() {
    let (srv, c, dir) = setup().await;
    let f = dir.path().join("big.bin");
    std::fs::write(&f, data(12 << 20, 1)).unwrap();

    let first = c.upload_file("demo", &f, "big.bin", None).await.unwrap();
    assert!(first.shards_uploaded >= 2);
    let puts_after_first = srv.stats.shard_puts.load(Ordering::SeqCst);
    assert_eq!(puts_after_first as usize, first.shards_uploaded);

    let second = c.upload_file("demo", &f, "big.bin", Some(&first.version_id)).await.unwrap();
    assert_eq!(second.shards_uploaded, 0);
    assert_eq!(second.bytes_uploaded, 0);
    assert_eq!(srv.stats.shard_puts.load(Ordering::SeqCst), puts_after_first, "zero shard PUTs on re-upload");
    assert_ne!(second.version_id, first.version_id);
}

#[tokio::test]
async fn small_edit_uploads_at_most_two_shards() {
    let (_srv, c, dir) = setup().await;
    let mut bytes = data(24 << 20, 2);
    let f = dir.path().join("edit.bin");
    std::fs::write(&f, &bytes).unwrap();
    c.upload_file("demo", &f, "edit.bin", None).await.unwrap();

    let mid = bytes.len() / 2;
    for b in &mut bytes[mid..mid + 4096] {
        *b ^= 0xff;
    }
    std::fs::write(&f, &bytes).unwrap();
    let rep = c.upload_file("demo", &f, "edit.bin", None).await.unwrap();
    assert!((1..=2).contains(&rep.shards_uploaded), "uploaded {}", rep.shards_uploaded);
}

#[tokio::test]
async fn roundtrip_is_byte_identical_and_cached() {
    let (srv, _c, dir) = setup().await;
    let cache = Arc::new(ShardCache::open(dir.path().join("cache"), 1 << 30).unwrap());
    let c = Client::builder(srv.url(), TOKEN).cache(cache.clone()).build().unwrap();
    let src = data(20 << 20, 3);
    let f = dir.path().join("src.bin");
    std::fs::write(&f, &src).unwrap();
    c.upload_file("demo", &f, "dir/sub/src.bin", None).await.unwrap();

    let out = dir.path().join("out.bin");
    c.download_to_file("demo", "dir/sub/src.bin", None, &out).await.unwrap();
    assert_eq!(std::fs::read(&out).unwrap(), src);
    let gets = srv.stats.shard_gets.load(Ordering::SeqCst);
    assert!(gets > 0);

    // Second download is served from the cache.
    c.download_to_file("demo", "dir/sub/src.bin", None, &out).await.unwrap();
    assert_eq!(srv.stats.shard_gets.load(Ordering::SeqCst), gets);
}

#[tokio::test]
async fn read_range_matches_source_and_fetches_only_overlapping_shards() {
    let (srv, c, dir) = setup().await;
    let src = data(20 << 20, 4);
    let f = dir.path().join("r.bin");
    std::fs::write(&f, &src).unwrap();
    c.upload_file("demo", &f, "r.bin", None).await.unwrap();
    let m = c.manifest("demo", "r.bin", None).await.unwrap();
    assert!(m.shards.len() >= 3);

    // Small range inside one shard: exactly one GET, and it is a Range request.
    let before = srv.stats.shard_gets.load(Ordering::SeqCst);
    let got = c.read_range("demo", "r.bin", 1000, 4096).await.unwrap();
    assert_eq!(got.as_ref(), &src[1000..5096]);
    assert_eq!(srv.stats.shard_gets.load(Ordering::SeqCst) - before, 1);
    assert_eq!(srv.stats.shard_range_gets.load(Ordering::SeqCst), 1);

    // Range straddling the first shard boundary touches exactly two shards.
    let b0 = m.shards[0].n;
    let before = srv.stats.shard_gets.load(Ordering::SeqCst);
    let got = c.read_range("demo", "r.bin", b0 - 100, 200).await.unwrap();
    assert_eq!(got.as_ref(), &src[(b0 - 100) as usize..(b0 + 100) as usize]);
    assert_eq!(srv.stats.shard_gets.load(Ordering::SeqCst) - before, 2);

    // Past EOF is empty; a range hanging over EOF is clipped.
    assert!(c.read_range("demo", "r.bin", src.len() as u64 + 10, 10).await.unwrap().is_empty());
    let tail = c.read_range("demo", "r.bin", src.len() as u64 - 50, 1000).await.unwrap();
    assert_eq!(tail.as_ref(), &src[src.len() - 50..]);
}

#[tokio::test]
async fn concurrent_puts_with_same_if_version_one_wins() {
    let (_srv, c, dir) = setup().await;
    let f = dir.path().join("a.txt");
    std::fs::write(&f, b"v1").unwrap();
    let v1 = c.upload_file("demo", &f, "a.txt", None).await.unwrap();

    let g1 = dir.path().join("g1.txt");
    let g2 = dir.path().join("g2.txt");
    std::fs::write(&g1, b"writer one").unwrap();
    std::fs::write(&g2, b"writer two").unwrap();
    let (c1, c2) = (c.clone(), c.clone());
    let base = v1.version_id.clone();
    let base2 = base.clone();
    let t1 = tokio::spawn(async move { c1.upload_file("demo", &g1, "a.txt", Some(&base)).await });
    let t2 = tokio::spawn(async move { c2.upload_file("demo", &g2, "a.txt", Some(&base2)).await });
    let (r1, r2) = (t1.await.unwrap(), t2.await.unwrap());
    let oks = [&r1, &r2].iter().filter(|r| r.is_ok()).count();
    assert_eq!(oks, 1);
    let loser = if r1.is_err() { r1 } else { r2 };
    match loser.unwrap_err() {
        Error::PreconditionFailed { path, current_version_id } => {
            assert_eq!(path, "a.txt");
            assert!(current_version_id.is_some());
            assert_ne!(current_version_id.as_deref(), Some(v1.version_id.as_str()));
        }
        e => panic!("{e:?}"),
    }
}

#[tokio::test]
async fn missing_shards_after_dedup_check_recovers() {
    let (srv, c, dir) = setup().await;
    let f = dir.path().join("m.bin");
    std::fs::write(&f, data(3 << 20, 5)).unwrap();
    c.upload_file("demo", &f, "m.bin", None).await.unwrap();
    // The server will "lose" a shard after /missing said all present.
    srv.stats.report_missing_once.store(true, Ordering::SeqCst);
    let rep = c.upload_file("demo", &f, "m.bin", None).await.unwrap();
    assert_eq!(rep.shards_uploaded, 1, "only the lost shard is re-sent");
}

#[tokio::test]
async fn shard_put_survives_transient_failures() {
    let (srv, _c, dir) = setup().await;
    let c = Client::builder(srv.url(), TOKEN)
        .retry(uls_client::RetryPolicy {
            max_attempts: 5,
            base_delay: std::time::Duration::from_millis(5),
            max_delay: std::time::Duration::from_millis(20),
        })
        .build()
        .unwrap();
    srv.stats.fail_puts.store(2, Ordering::SeqCst);
    let f = dir.path().join("t.txt");
    std::fs::write(&f, b"transient").unwrap();
    let rep = c.upload_file("demo", &f, "t.txt", None).await.unwrap();
    assert_eq!(rep.shards_uploaded, 1);
    assert_eq!(srv.stats.shard_puts.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn empty_file_roundtrip() {
    let (_srv, c, dir) = setup().await;
    let f = dir.path().join("empty");
    std::fs::write(&f, b"").unwrap();
    let rep = c.upload_file("demo", &f, "empty", None).await.unwrap();
    assert_eq!((rep.size, rep.shards_total), (0, 0));
    let m = c.manifest("demo", "empty", None).await.unwrap();
    assert!(m.shards.is_empty());
    let out = dir.path().join("o");
    c.download_to_file("demo", "empty", None, &out).await.unwrap();
    assert_eq!(std::fs::read(out).unwrap().len(), 0);
}

#[tokio::test]
async fn versions_restore_list_rename_delete() {
    let (_srv, c, dir) = setup().await;
    let f = dir.path().join("x");
    std::fs::write(&f, b"one").unwrap();
    let v1 = c.upload_file("demo", &f, "docs/x.txt", None).await.unwrap();
    std::fs::write(&f, b"two").unwrap();
    c.upload_file("demo", &f, "docs/x.txt", Some(&v1.version_id)).await.unwrap();
    assert_eq!(c.versions("demo", "docs/x.txt").await.unwrap().len(), 2);

    c.restore("demo", "docs/x.txt", &v1.version_id, None).await.unwrap();
    let mut out = Vec::new();
    c.download("demo", "docs/x.txt", None, &mut out).await.unwrap();
    assert_eq!(out, b"one");
    let mut old = Vec::new();
    c.download("demo", "docs/x.txt", Some(&v1.version_id), &mut old).await.unwrap();
    assert_eq!(old, b"one");

    let root = c.list("demo", "").await.unwrap();
    assert_eq!(root.len(), 1);
    assert!(Client::is_folder(&root[0]));
    assert_eq!(c.list("demo", "docs").await.unwrap()[0].name, "x.txt");

    c.mkdir("demo", "empty-dir").await.unwrap();
    c.rename("demo", "docs/", "archive/docs/", None).await.unwrap();
    assert_eq!(c.stat("demo", "archive/docs/x.txt").await.unwrap().size, Some(3));
    c.delete("demo", "archive/docs/x.txt", None).await.unwrap();
    assert!(matches!(c.stat("demo", "archive/docs/x.txt").await.unwrap_err(), Error::NotFound { .. }));
    assert_eq!(c.drive_info("demo").await.unwrap().file_count, 0);
}

#[tokio::test]
async fn create_drive_twice_conflicts_and_bad_token_rejected() {
    let (srv, c, _d) = setup().await;
    assert!(matches!(c.create_drive("demo", None).await.unwrap_err(), Error::DriveExists));
    let bad = Client::builder(srv.url(), "wrong").build().unwrap();
    assert!(matches!(bad.drive_info("demo").await.unwrap_err(), Error::Unauthorized));
}

#[tokio::test]
async fn watch_replays_then_streams_and_resumes() {
    let (_srv, c, dir) = setup().await;
    let f = dir.path().join("w");
    std::fs::write(&f, b"w").unwrap();
    c.upload_file("demo", &f, "before.txt", None).await.unwrap(); // seq 1

    let mut w = c.watch("demo", 0);
    let ch = tokio::time::timeout(std::time::Duration::from_secs(5), w.next()).await.unwrap().unwrap().unwrap();
    assert_eq!((ch.seq, ch.path.as_str()), (1, "before.txt"));

    c.upload_file("demo", &f, "after.txt", None).await.unwrap(); // seq 2
    let ch = tokio::time::timeout(std::time::Duration::from_secs(5), w.next()).await.unwrap().unwrap().unwrap();
    assert_eq!((ch.seq, ch.op.as_str(), ch.path.as_str()), (2, "put", "after.txt"));
    drop(w);

    // A fresh watch resuming from seq 1 only sees what came after.
    let mut w = c.watch("demo", 1);
    let ch = tokio::time::timeout(std::time::Duration::from_secs(5), w.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(ch.seq, 2);
}
