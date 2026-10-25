//! Async client for the Unlispace M0 wire contract (`docs/design/m0-contract.md`).

mod auth;
mod cache;
mod client;
mod error;
mod range;
mod watch;

pub use auth::{ProviderToken, TokenProvider};
pub use cache::{DEFAULT_CAP_BYTES, ShardCache, default_cache_dir};
pub use client::{Client, ClientBuilder, RetryPolicy, UploadReport};
pub use error::{Error, Result};
pub use range::{ShardSlice, map_range};
pub use watch::{CLOSE_DRIVE_DELETED, CLOSE_TOKEN_EXPIRED, WatchEvent, WatchStream};

pub use uls_proto as proto;
