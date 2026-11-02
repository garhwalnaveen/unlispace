//! Async client for the Orbit M0 wire contract (`docs/design/m0-contract.md`).

mod auth;
mod access_key;
mod cache;
mod client;
mod error;
mod range;
mod watch;

pub use auth::{ProviderToken, TokenProvider};
pub use access_key::{AccessKeyTokenProvider, MountGrant};
pub use cache::{DEFAULT_CAP_BYTES, ShardCache, default_cache_dir};
pub use client::{Client, ClientBuilder, RetryPolicy, UploadLimiter, UploadReport};
pub use error::{Error, Result};
pub use range::{ShardSlice, map_range};
pub use watch::{CLOSE_DRIVE_DELETED, CLOSE_TOKEN_EXPIRED, WatchEvent, WatchStream};

pub use uls_proto as proto;
