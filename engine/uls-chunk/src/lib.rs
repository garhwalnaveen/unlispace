//! FastCDC 2020 chunking with a SHA-256 per chunk (M0 contract section 1).

use std::io::{self, Read};

use fastcdc::v2020::{FastCDC, StreamCDC};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MIN_SIZE: u32 = 262_144;
pub const AVG_SIZE: u32 = 2_097_152;
pub const MAX_SIZE: u32 = 16_777_216;

/// Length of the golden-vector input (32 MiB).
pub const GOLDEN_LEN: usize = 33_554_432;

/// One content-defined chunk: where it sits in the source, how long it is, and its hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chunk {
    pub offset: u64,
    pub length: usize,
    /// Lowercase hex SHA-256 of the chunk bytes.
    pub hash: String,
}

/// Lowercase hex SHA-256.
pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Chunk an in-memory buffer.
pub fn chunk_slice(data: &[u8]) -> Vec<Chunk> {
    FastCDC::new(data, MIN_SIZE, AVG_SIZE, MAX_SIZE)
        .map(|c| Chunk {
            offset: c.offset as u64,
            length: c.length,
            hash: sha256_hex(&data[c.offset..c.offset + c.length]),
        })
        .collect()
}

/// Streaming chunker over any `Read`. Yields each chunk together with its bytes, so memory
/// use is bounded by the maximum chunk size.
pub fn chunk_reader<R: Read>(reader: R) -> impl Iterator<Item = io::Result<(Chunk, Vec<u8>)>> {
    StreamCDC::new(reader, MIN_SIZE, AVG_SIZE, MAX_SIZE).map(|r| match r {
        Ok(c) => {
            let chunk = Chunk {
                offset: c.offset,
                length: c.length,
                hash: sha256_hex(&c.data),
            };
            Ok((chunk, c.data))
        }
        Err(fastcdc::v2020::Error::IoError(e)) => Err(e),
        Err(e) => Err(io::Error::other(e.to_string())),
    })
}

/// The contract's golden input: `b[i] = (i * 2654435761 >> 13) & 0xff`, u64 wrapping arithmetic.
pub fn golden_input() -> Vec<u8> {
    (0..GOLDEN_LEN as u64)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect()
}

/// Supplementary high-entropy vector (not in the contract): the same 32 MiB length, filled from
/// splitmix64 seeded with 0x756c73. The contract's own vector is periodic and degenerates into
/// two max-size chunks, so it does not exercise real cut-point selection.
pub fn golden_input_prng() -> Vec<u8> {
    let mut state: u64 = 0x756c73;
    let mut out = Vec::with_capacity(GOLDEN_LEN);
    while out.len() < GOLDEN_LEN {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        out.extend_from_slice(&z.to_le_bytes());
    }
    out.truncate(GOLDEN_LEN);
    out
}
