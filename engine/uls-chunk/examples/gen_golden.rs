//! Regenerates the golden files. Only run this when the contract changes:
//! `cargo run --release -p uls-chunk --example gen_golden -- contract > uls-chunk/tests/golden.json`
//! `cargo run --release -p uls-chunk --example gen_golden -- prng > uls-chunk/tests/golden_prng.json`

use uls_chunk::{
    AVG_SIZE, MAX_SIZE, MIN_SIZE, chunk_slice, golden_input, golden_input_prng, sha256_hex,
};

fn main() {
    let which = std::env::args().nth(1).unwrap_or_else(|| "contract".into());
    let (data, desc) = match which.as_str() {
        "contract" => (
            golden_input(),
            "contract section 1: b[i] = ((i * 2654435761) >> 13) & 0xff, i in 0..33554432, u64 wrapping",
        ),
        "prng" => (
            golden_input_prng(),
            "supplementary: splitmix64 seed 0x756c73, little-endian u64 stream truncated to 33554432 bytes",
        ),
        other => panic!("unknown vector {other}"),
    };
    let chunks = chunk_slice(&data);
    let out = serde_json::json!({
        "description": format!("{desc}; fastcdc v3.2.1 v2020 normalization level 1"),
        "min": MIN_SIZE,
        "avg": AVG_SIZE,
        "max": MAX_SIZE,
        "inputLength": data.len(),
        "inputSha256": sha256_hex(&data),
        "chunks": chunks.iter().map(|c| serde_json::json!({"n": c.length, "h": c.hash})).collect::<Vec<_>>(),
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
