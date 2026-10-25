//! Mapping a byte range of a file onto the shards that cover it.

use uls_proto::ShardRef;

/// The part of one shard needed to satisfy a read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardSlice {
    /// Index into the manifest's shard list.
    pub index: usize,
    pub hash: String,
    /// Total length of the shard.
    pub shard_len: u64,
    /// First byte wanted, relative to the start of the shard.
    pub start: u64,
    /// Number of bytes wanted from this shard (> 0).
    pub len: u64,
}

impl ShardSlice {
    pub fn is_whole_shard(&self) -> bool {
        self.start == 0 && self.len == self.shard_len
    }
}

/// Map `[offset, offset+len)` onto shards. The range is clipped at EOF; a range that starts at
/// or past EOF (or has `len == 0`) maps to nothing. Zero-length shards are skipped.
pub fn map_range(shards: &[ShardRef], offset: u64, len: u64) -> Vec<ShardSlice> {
    let mut out = Vec::new();
    if len == 0 {
        return out;
    }
    let end = offset.saturating_add(len);
    let mut pos: u64 = 0;
    for (index, s) in shards.iter().enumerate() {
        let shard_end = pos + s.n;
        if shard_end > offset && s.n > 0 {
            if pos >= end {
                break;
            }
            let start = offset.saturating_sub(pos);
            let stop = (end - pos).min(s.n);
            out.push(ShardSlice {
                index,
                hash: s.h.clone(),
                shard_len: s.n,
                start,
                len: stop - start,
            });
        }
        pos = shard_end;
        if pos >= end {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shards(lens: &[u64]) -> Vec<ShardRef> {
        lens.iter()
            .enumerate()
            .map(|(i, n)| ShardRef { h: format!("h{i}"), n: *n })
            .collect()
    }

    #[test]
    fn within_one_shard() {
        let s = map_range(&shards(&[100, 100, 100]), 10, 20);
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].index, s[0].start, s[0].len), (0, 10, 20));
        assert!(!s[0].is_whole_shard());
    }

    #[test]
    fn offset_exactly_at_boundary() {
        let s = map_range(&shards(&[100, 100, 100]), 100, 10);
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].index, s[0].start, s[0].len), (1, 0, 10));
        // A range ending exactly on a boundary must not touch the next shard.
        let s = map_range(&shards(&[100, 100, 100]), 90, 10);
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].index, s[0].start, s[0].len), (0, 90, 10));
    }

    #[test]
    fn spans_three_shards() {
        let s = map_range(&shards(&[100, 100, 100]), 50, 200);
        assert_eq!(s.len(), 3);
        assert_eq!((s[0].index, s[0].start, s[0].len), (0, 50, 50));
        assert_eq!((s[1].index, s[1].start, s[1].len), (1, 0, 100));
        assert!(s[1].is_whole_shard());
        assert_eq!((s[2].index, s[2].start, s[2].len), (2, 0, 50));
        assert_eq!(s.iter().map(|x| x.len).sum::<u64>(), 200);
    }

    #[test]
    fn clipped_at_eof() {
        let s = map_range(&shards(&[100, 100]), 150, 1000);
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].index, s[0].start, s[0].len), (1, 50, 50));
    }

    #[test]
    fn past_eof_is_empty() {
        assert!(map_range(&shards(&[100, 100]), 200, 10).is_empty());
        assert!(map_range(&shards(&[100, 100]), 5000, 10).is_empty());
        assert!(map_range(&[], 0, 10).is_empty());
        assert!(map_range(&shards(&[100]), 0, 0).is_empty());
        assert!(map_range(&shards(&[100]), u64::MAX, u64::MAX).is_empty());
    }

    #[test]
    fn whole_file() {
        let s = map_range(&shards(&[10, 20, 30]), 0, 60);
        assert_eq!(s.len(), 3);
        assert!(s.iter().all(ShardSlice::is_whole_shard));
    }
}
