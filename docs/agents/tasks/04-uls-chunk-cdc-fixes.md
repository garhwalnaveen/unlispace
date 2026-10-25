# 04 · Engine perf: windowed re-chunk + resumable upload  — write in: engine/uls-vfs/ (src/publisher.rs + new tests only; agent 03 only *uses* uls-vfs), engine/uls-chunk/
uls-vfs publisher currently re-chunks whole files on publish (see its README). Implement windowed
re-chunking: for dirty extents, re-chunk only from the start of the shard containing the first
dirty byte until the CDC boundary re-synchronises with the old shard list after the last dirty
byte, reusing all other shards. Prove with tests: 4 KiB edit in 64 MiB reads ≤ 3 shards' bytes from
base and uploads ≤ 2 new shards; insert/delete in the middle; append. Add resumable publishing:
a publish interrupted mid-upload resumes without re-uploading already-stored shards (use
`/shards/missing`). Add a criterion-free micro benchmark binary `uls-bench` printing MB/s for
chunk+hash. Do not change uls-vfs public API. Gate: build/clippy/test for uls-chunk and uls-vfs.
