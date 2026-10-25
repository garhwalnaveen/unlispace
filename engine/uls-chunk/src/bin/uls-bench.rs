//! Run with `cargo run -p uls-chunk --bin uls-bench -- [iterations]` (no external data).
use std::hint::black_box;
use std::time::Instant;

fn main() {
    let iterations = std::env::args().nth(1).map_or(Ok(10), |s| s.parse::<u32>())
        .expect("iterations must be a positive integer");
    assert!(iterations > 0, "iterations must be positive");
    let data = uls_chunk::golden_input_prng();
    let start = Instant::now();
    let mut chunks = 0;
    for _ in 0..iterations {
        chunks += black_box(uls_chunk::chunk_slice(black_box(&data))).len();
    }
    let elapsed = start.elapsed().as_secs_f64();
    let mb = data.len() as f64 * iterations as f64 / 1_000_000.0;
    println!("chunk+hash: {:.2} MB/s ({mb:.2} MB, {chunks} chunks, {elapsed:.3} s)", mb / elapsed);
}
