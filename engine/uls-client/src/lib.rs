//! Async client for the Unlispace M0 wire contract (`docs/design/m0-contract.md`).

mod cache;
mod client;
mod error;
mod range;
mod watch;

pub use cache::{DEFAULT_CAP_BYTES, ShardCache, default_cache_dir};
pub use client::{Client, ClientBuilder, RetryPolicy, UploadReport};
pub use error::{Error, Result};
pub use range::{ShardSlice, map_range};
pub use watch::WatchStream;

pub use uls_proto as proto;
