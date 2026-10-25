//! Wire types for the app <-> daemon protocol (`mac/DAEMON-PROTOCOL.md`), matching
//! `mac/Sources/UnlispaceKit/DaemonProtocol.swift` and `AuthProtocol.swift`.
//!
//! Types that can carry secrets implement `Debug` by hand and never print them.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    SignedOut,
    Idle,
    Syncing,
    Offline,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MountState {
    Unmounted,
    Mounting,
    Mounted,
    Unmounting,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub version: String,
    pub state: State,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_ops: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub drive_id: String,
    pub name: String,
    pub mount_state: MountState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Queued,
    Active,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub drive_id: String,
    pub path: String,
    pub direction: Direction,
    pub bytes_done: i64,
    pub bytes_total: i64,
    pub status: TransferStatus,
}

impl Transfer {
    pub fn is_finished(&self) -> bool {
        matches!(self.status, TransferStatus::Done | TransferStatus::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub drive_id: String,
    pub seq: i64,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinEvent { pub drive_id: String, pub path: String, pub cached_bytes: u64, pub bytes: u64 }

/// A concurrent remote edit won; the local edit was preserved at `copy`. Both paths have a
/// leading slash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEvent {
    pub drive_id: String,
    pub path: String,
    pub copy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StateEvent {
    pub state: State,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", content = "data", rename_all = "lowercase")]
pub enum Event {
    Pin(PinEvent),
    Transfer(Transfer),
    Change(ChangeEvent),
    Conflict(ConflictEvent),
    State(StateEvent),
}

impl Event {
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{\"event\":\"state\",\"data\":{\"state\":\"error\"}}".into())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<User>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_endpoint: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSetParams {
    pub api_endpoint: String,
    pub access_token: String,
    pub refresh_token: String,
}

impl fmt::Debug for AuthSetParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthSetParams").field("api_endpoint", &self.api_endpoint).finish_non_exhaustive()
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigParams {
    pub endpoint: Option<String>,
    pub token: Option<String>,
    pub cache_cap_bytes: Option<i64>,
    pub journal_cap_bytes: Option<u64>,
}

impl fmt::Debug for ConfigParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConfigParams")
            .field("endpoint", &self.endpoint)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("cache_cap_bytes", &self.cache_cap_bytes)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveParams {
    pub drive_id: String,
}

/// Error codes from the spec.
pub mod code {
    pub const NO_SUCH_DRIVE: &str = "no_such_drive";
    pub const ALREADY_MOUNTED: &str = "already_mounted";
    pub const NOT_MOUNTED: &str = "not_mounted";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const OFFLINE: &str = "offline";
    pub const BAD_REQUEST: &str = "bad_request";
    pub const INTERNAL: &str = "internal";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

impl ErrorBody {
    pub fn new(code: &str, message: impl Into<String>) -> ErrorBody {
        ErrorBody { code: code.to_string(), message: message.into() }
    }
    pub fn bad_request(message: impl Into<String>) -> ErrorBody {
        ErrorBody::new(code::BAD_REQUEST, message)
    }
    pub fn internal(message: impl Into<String>) -> ErrorBody {
        ErrorBody::new(code::INTERNAL, message)
    }
}

/// A parsed request. `params` is always an object (absent / null become `{}`).
#[derive(Clone, PartialEq)]
pub struct Request {
    pub id: i64,
    pub method: String,
    pub params: Value,
}

// Params may carry tokens (`auth.set`, `config.set`), so they are never printed.
impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Request").field("id", &self.id).field("method", &self.method).finish_non_exhaustive()
    }
}

/// `{"id":N,"result":{..}}` or `{"id":N,"error":{..}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Response {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

/// The id used for errors that cannot be tied to a request (unparseable line). See the report:
/// the protocol does not define this case.
pub const UNATTRIBUTABLE_ID: i64 = 0;

impl Response {
    pub fn ok(id: i64, result: impl Serialize) -> Response {
        let v = serde_json::to_value(result).unwrap_or_else(|_| json!({}));
        Response { id, result: Some(v), error: None }
    }
    pub fn empty(id: i64) -> Response {
        Response { id, result: Some(Value::Object(Map::new())), error: None }
    }
    pub fn err(id: i64, e: ErrorBody) -> Response {
        Response { id, result: None, error: Some(e) }
    }
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| String::from("{\"id\":0,\"error\":{\"code\":\"internal\",\"message\":\"encode\"}}"))
    }
}

/// Parse one request line. On failure returns the response to send (with the request id when it
/// could be read). Error text never echoes any part of the input.
pub fn parse_request(line: &str) -> Result<Request, Response> {
    let v: Value = serde_json::from_str(line)
        .map_err(|_| Response::err(UNATTRIBUTABLE_ID, ErrorBody::bad_request("request is not valid JSON")))?;
    let Value::Object(mut obj) = v else {
        return Err(Response::err(UNATTRIBUTABLE_ID, ErrorBody::bad_request("request must be a JSON object")));
    };
    let Some(id) = obj.get("id").and_then(Value::as_i64) else {
        return Err(Response::err(UNATTRIBUTABLE_ID, ErrorBody::bad_request("request needs an integer id")));
    };
    let Some(method) = obj.get("method").and_then(Value::as_str).map(str::to_string) else {
        return Err(Response::err(id, ErrorBody::bad_request("request needs a string method")));
    };
    let params = match obj.remove("params") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(p @ Value::Object(_)) => p,
        Some(_) => return Err(Response::err(id, ErrorBody::bad_request("params must be an object"))),
    };
    Ok(Request { id, method, params })
}

/// Deserialize params, with an error message that cannot echo values.
pub fn parse_params<T: serde::de::DeserializeOwned>(req: &Request) -> Result<T, ErrorBody> {
    serde_json::from_value::<T>(req.params.clone()).map_err(|e| {
        let msg = e.to_string();
        if msg.starts_with("missing field") {
            ErrorBody::bad_request(format!("invalid params: {msg}"))
        } else {
            ErrorBody::bad_request("invalid params")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_parsing() {
        let r = parse_request(r#"{"id":7,"method":"drive.mount","params":{"driveId":"d1"}}"#).unwrap();
        assert_eq!((r.id, r.method.as_str()), (7, "drive.mount"));
        assert_eq!(parse_params::<DriveParams>(&r).unwrap().drive_id, "d1");
        let r = parse_request(r#"{"id":1,"method":"status"}"#).unwrap();
        assert_eq!(r.params, json!({}));
        assert_eq!(parse_request(r#"{"id":1,"method":"x","params":null}"#).unwrap().params, json!({}));
    }

    #[test]
    fn request_errors_keep_id_when_known_and_never_echo_input() {
        let e = parse_request("not json SECRET").unwrap_err();
        assert_eq!((e.id, e.error.as_ref().unwrap().code.as_str()), (0, "bad_request"));
        assert!(!e.to_line().contains("SECRET"));
        assert_eq!(parse_request(r#"{"id":4}"#).unwrap_err().id, 4);
        assert_eq!(parse_request(r#"{"id":4,"method":"a","params":[1]}"#).unwrap_err().id, 4);
        assert_eq!(parse_request(r#"{"id":"x","method":"a"}"#).unwrap_err().id, 0);
        assert_eq!(parse_request("[1]").unwrap_err().id, 0);
        let r = parse_request(r#"{"id":1,"method":"drive.mount","params":{"driveId":5}}"#).unwrap();
        assert!(!parse_params::<DriveParams>(&r).unwrap_err().message.contains('5'));
        let r = parse_request(r#"{"id":1,"method":"drive.mount"}"#).unwrap();
        assert!(parse_params::<DriveParams>(&r).unwrap_err().message.contains("driveId"));
    }

    #[test]
    fn debug_never_prints_secrets() {
        let p: AuthSetParams = serde_json::from_value(json!({"apiEndpoint":"http://x","accessToken":"AAA-secret","refreshToken":"RRR-secret"})).unwrap();
        assert!(!format!("{p:?}").contains("secret"));
        let c: ConfigParams = serde_json::from_value(json!({"token":"TTT-secret"})).unwrap();
        assert!(!format!("{c:?}").contains("secret"));
    }
}
