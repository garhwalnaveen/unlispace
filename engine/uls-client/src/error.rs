use std::io;

use uls_proto::ApiError;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 401: missing or wrong bearer token.
    #[error("unauthorized (check ULS_DEV_TOKEN)")]
    Unauthorized,
    /// 404 with the server's error code (`no_such_path`, `no_such_drive`, `no_such_shard`, ...).
    #[error("not found: {code}")]
    NotFound { code: String },
    /// 412: an `ifVersion` / `ifAbsent` precondition failed.
    #[error("precondition failed for {path:?}: current version is {current_version_id:?}")]
    PreconditionFailed {
        path: String,
        current_version_id: Option<String>,
    },
    /// 409 `missing_shards`: the commit referenced shards the server does not have.
    #[error("commit references {} missing shard(s)", hashes.len())]
    MissingShards { hashes: Vec<String> },
    /// 409 `drive_exists`.
    #[error("drive already exists")]
    DriveExists,
    /// Any other non-success response.
    #[error("server returned {status}: {}", .body.error)]
    Api { status: u16, body: ApiError },
    #[error("shard hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("unexpected response: {0}")]
    InvalidResponse(String),
    #[error("transport error: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("websocket error: {0}")]
    Ws(String),
    /// The token provider could not supply a token.
    #[error("token provider failed: {0}")]
    Auth(String),
}

impl Error {
    /// Worth retrying with backoff: network failures, 429 and 5xx.
    pub fn is_retryable(&self) -> bool {
        match self {
            Error::Transport(e) => e.is_connect() || e.is_timeout() || e.is_request() || e.is_body(),
            Error::Api { status, .. } => *status == 429 || *status >= 500,
            _ => false,
        }
    }

    /// Turn a non-success HTTP response into a typed error.
    pub(crate) fn from_response(status: u16, body: &[u8]) -> Error {
        let api: ApiError = serde_json::from_slice(body).unwrap_or_else(|_| ApiError {
            error: format!("http_{status}"),
            message: Some(String::from_utf8_lossy(&body[..body.len().min(200)]).into_owned()),
            ..Default::default()
        });
        match (status, api.error.as_str()) {
            (401, _) => Error::Unauthorized,
            (412, _) => Error::PreconditionFailed {
                path: api.path.unwrap_or_default(),
                current_version_id: api.current_version_id,
            },
            (409, "missing_shards") => Error::MissingShards {
                hashes: api.hashes.unwrap_or_default(),
            },
            (409, "drive_exists") => Error::DriveExists,
            (404, code) => Error::NotFound { code: code.to_string() },
            _ => Error::Api { status, body: api },
        }
    }
}
