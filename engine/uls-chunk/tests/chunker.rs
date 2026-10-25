use std::io::Cursor;

use serde_json::Value;
use uls_chunk::{
    AVG_SIZE, MAX_SIZE, MIN_SIZE, chunk_reader, chunk_slice, golden_input, golden_input_prng,
};

fn check_golden(json: &str, data: &[u8]) {
    let g: Value = serde_json::from_str(json).unwrap();
    assert_eq!(g["min"], MIN_SIZE);
    assert_eq!(g["avg"], AVG_SIZE);
    assert_eq!(g["max"], MAX_SIZE);
    assert_eq!(g["inputLength"], data.len());
    assert_eq!(g["inputSha256"], uls_chunk::sha256_hex(data));
    let expected: Vec<(u64, String)> = g["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["n"].as_u64().unwrap(), c["h"].as_str().unwrap().to_string()))
        .collect();
    let got: Vec<(u64, String)> = chunk_slice(data)
        .into_iter()
        .map(|c| (c.length as u64, c.hash))
        .collect();
    assert_eq!(got, expected);
    assert_eq!(got.iter().map(|c| c.0).sum::<u64>(), data.len() as u64);
}

#[test]
fn contract_golden_vector() {
    check_golden(include_str!("golden.json"), &golden_input());
}

#[test]
fn prng_golden_vector() {
    check_golden(include_str!("golden_prng.json"), &golden_input_prng());
}

#[test]
fn deterministic() {
    let data = golden_input_prng();
    assert_eq!(chunk_slice(&data), chunk_slice(&data));
}

#[test]
fn chunk_bounds_respected() {
    let data = golden_input_prng();
    let chunks = chunk_slice(&data);
    let last = chunks.len() - 1;
    for (i, c) in chunks.iter().enumerate() {
        assert!(c.length <= MAX_SIZE as usize);
        if i != last {
            assert!(c.length >= MIN_SIZE as usize);
        }
    }
}

#[test]
fn streaming_matches_slice() {
    let data = golden_input_prng();
    let streamed: Vec<_> = chunk_reader(Cursor::new(&data))
        .map(|r| {
            let (c, bytes) = r.unwrap();
            assert_eq!(bytes.len(), c.length);
            c
        })
        .collect();
    assert_eq!(streamed, chunk_slice(&data));
}

#[test]
fn empty_input_has_no_chunks() {
    assert!(chunk_slice(&[]).is_empty());
    assert_eq!(chunk_reader(Cursor::new(Vec::<u8>::new())).count(), 0);
}

#[test]
fn small_edit_changes_at_most_two_chunks() {
    let mut data = golden_input_prng();
    let before = chunk_slice(&data);
    let mid = data.len() / 2;
    for b in &mut data[mid..mid + 4096] {
        *b = !*b;
    }
    let after = chunk_slice(&data);
    let old: std::collections::HashSet<_> = before.iter().map(|c| c.hash.clone()).collect();
    let changed = after.iter().filter(|c| !old.contains(&c.hash)).count();
    assert!(changed >= 1, "edit must change something");
    assert!(changed <= 2, "4 KiB edit changed {changed} chunks");
}
