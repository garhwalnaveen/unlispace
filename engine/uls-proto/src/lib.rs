//! Serde types for every request and response in `docs/design/m0-contract.md`.
//!
//! Field names follow the contract exactly (camelCase in JSON, `h`/`n` for shard refs).

use serde::{Deserialize, Serialize};

pub const MAX_SHARD_BODY: u64 = 16 * 1024 * 1024;
pub const MAX_MISSING_HASHES: usize = 1000;
pub const MAX_COMMIT_OPS: usize = 1000;

// ---- 3.1 drives -----------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateDriveRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveCreated {
    pub drive_id: String,
    pub placement: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub drive_id: String,
    pub placement: Option<String>,
    pub created_at: i64,
    pub head_seq: u64,
    pub file_count: u64,
    pub bytes: u64,
}

// ---- 3.2 shards -----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissingRequest {
    pub hashes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissingResponse {
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PutShardResponse {
    pub hash: String,
    pub size: u64,
    pub stored: bool,
}

/// A shard reference in a manifest: hash and length.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShardRef {
    pub h: String,
    pub n: u64,
}

// ---- 3.3 commit -----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Op {
    #[serde(rename_all = "camelCase")]
    Put {
        path: String,
        /// Serialised as `null` when absent, as in the contract example.
        if_version: Option<String>,
        #[serde(default)]
        if_absent: bool,
        size: u64,
        content_type: String,
        mtime_ms: i64,
        shards: Vec<ShardRef>,
    },
    Mkdir {
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    Delete {
        path: String,
        #[serde(default)]
        if_version: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Rename {
        from: String,
        to: String,
        #[serde(default)]
        if_version: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitRequest {
    pub ops: Vec<Op>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub path: String,
    pub version_id: String,
    /// Absent for ops without a size (mkdir, delete).
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitResponse {
    pub seq: u64,
    pub results: Vec<CommitResult>,
}

// ---- 3.4 read metadata ----------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    File,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatResponse {
    pub path: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub mtime_ms: Option<i64>,
    #[serde(default)]
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub mtime_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListResponse {
    pub entries: Vec<ListEntry>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestResponse {
    pub path: String,
    pub version_id: String,
    pub size: u64,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub mtime_ms: Option<i64>,
    pub shards: Vec<ShardRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub version_id: String,
    pub op: String,
    #[serde(default)]
    pub size: Option<u64>,
    pub seq: u64,
    pub ts: i64,
    #[serde(default)]
    pub actor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionsResponse {
    pub versions: Vec<VersionEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRequest {
    pub path: String,
    pub version_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_version: Option<String>,
}

// ---- 3.5 changes ----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub seq: u64,
    pub path: String,
    pub op: String,
    #[serde(default)]
    pub version_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesResponse {
    pub changes: Vec<Change>,
    pub head_seq: u64,
    pub more: bool,
}

/// WebSocket frames on `/watch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WatchMessage {
    #[serde(rename_all = "camelCase")]
    Change {
        seq: u64,
        path: String,
        op: String,
        #[serde(default)]
        version_id: Option<String>,
    },
    Ping,
    Pong,
}

// ---- errors ---------------------------------------------------------------------------------

/// Error body: `{"error": "<code>", "message"?, ...}` plus code-specific fields.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// `precondition_failed`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// `precondition_failed`: `null` when the path does not exist.
    #[serde(default)]
    pub current_version_id: Option<String>,
    /// `missing_shards`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hashes: Option<Vec<String>>,
}

// ---- path helpers ---------------------------------------------------------------------------

/// Validate a path per contract 3.3. Folder paths end with `/`; the empty string is the root.
pub fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }
    if path.len() > 1024 {
        return Err("path longer than 1024 bytes".into());
    }
    if path.contains('\0') {
        return Err("path contains NUL".into());
    }
    if path.starts_with('/') {
        return Err("path has a leading slash".into());
    }
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(format!("invalid path segment {seg:?}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn roundtrip<T>(v: Value) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let parsed: T = serde_json::from_value(v.clone()).expect("deserialize");
        assert_eq!(serde_json::to_value(&parsed).expect("serialize"), v);
        parsed
    }

    #[test]
    fn commit_contract_example() {
        let v = json!({
          "ops": [
            {"op":"put","path":"cuts/a.mov","ifVersion":null,"ifAbsent":false,"size":67108864,
             "contentType":"video/quicktime","mtimeMs":1792911671000i64,
             "shards":[{"h":"aa","n":2097152}]},
            {"op":"mkdir","path":"cuts/"},
            {"op":"delete","path":"old.txt","ifVersion":"v_01"},
            {"op":"rename","from":"cuts/","to":"archive/cuts/","ifVersion":null}
          ]
        });
        let req: CommitRequest = roundtrip(v);
        assert_eq!(req.ops.len(), 4);
        assert!(matches!(&req.ops[1], Op::Mkdir { path } if path == "cuts/"));
    }

    #[test]
    fn commit_response_example() {
        let r: CommitResponse = serde_json::from_value(json!({
            "seq": 42,
            "results": [{"path":"cuts/a.mov","versionId":"v_X","size":67108864}]
        }))
        .unwrap();
        assert_eq!(r.seq, 42);
        assert_eq!(r.results[0].size, Some(67108864));
        // Results without a size (mkdir/delete) still parse.
        let r: CommitResponse =
            serde_json::from_value(json!({"seq":1,"results":[{"path":"a/","versionId":"v_Y"}]}))
                .unwrap();
        assert_eq!(r.results[0].size, None);
    }

    #[test]
    fn drive_examples() {
        let _: DriveCreated = roundtrip(json!({"driveId":"my-drive","placement":"wnam","createdAt":1}));
        let _: DriveInfo = roundtrip(json!({
            "driveId":"my-drive","placement":"wnam","createdAt":1,"headSeq":3,"fileCount":2,"bytes":10}));
        let body = serde_json::to_value(CreateDriveRequest::default()).unwrap();
        assert_eq!(body, json!({}));
        let body = serde_json::to_value(CreateDriveRequest { placement: Some("weur".into()) }).unwrap();
        assert_eq!(body, json!({"placement":"weur"}));
    }

    #[test]
    fn metadata_examples() {
        let s: StatResponse = roundtrip(json!({
            "path":"a.txt","type":"file","versionId":"v_1","size":3,"contentType":"text/plain",
            "mtimeMs":5,"seq":2}));
        assert_eq!(s.node_type, NodeType::File);
        let l: ListResponse = roundtrip(json!({
            "entries":[{"name":"a","type":"folder","versionId":null,"size":null,"mtimeMs":null}],
            "cursor":null}));
        assert_eq!(l.entries[0].node_type, NodeType::Folder);
        let _: ManifestResponse = roundtrip(json!({
            "path":"a","versionId":"v_1","size":4,"contentType":"x/y","mtimeMs":1,
            "shards":[{"h":"ab","n":4}]}));
        let _: VersionsResponse = roundtrip(json!({"versions":[
            {"versionId":"v_1","op":"put","size":4,"seq":1,"ts":9,"actor":"dev"}]}));
        let _: RestoreRequest = roundtrip(json!({"path":"a","versionId":"v_1","ifVersion":"v_2"}));
    }

    #[test]
    fn changes_and_watch_examples() {
        let c: ChangesResponse = roundtrip(json!({
            "changes":[{"seq":1,"path":"a","op":"put","versionId":"v_1"},
                       {"seq":2,"path":"b","op":"delete","versionId":null}],
            "headSeq":2,"more":false}));
        assert_eq!(c.changes[1].version_id, None);
        let m: WatchMessage = roundtrip(json!({
            "type":"change","seq":7,"path":"a","op":"put","versionId":"v_1"}));
        assert!(matches!(m, WatchMessage::Change { seq: 7, .. }));
        let _: WatchMessage = roundtrip(json!({"type":"ping"}));
        let _: WatchMessage = roundtrip(json!({"type":"pong"}));
    }

    #[test]
    fn error_examples() {
        let e: ApiError = serde_json::from_value(json!({
            "error":"precondition_failed","path":"a","currentVersionId":"v_9"})).unwrap();
        assert_eq!(e.current_version_id.as_deref(), Some("v_9"));
        let e: ApiError = serde_json::from_value(json!({
            "error":"precondition_failed","path":"a","currentVersionId":null})).unwrap();
        assert_eq!(e.current_version_id, None);
        let e: ApiError =
            serde_json::from_value(json!({"error":"missing_shards","hashes":["aa","bb"]})).unwrap();
        assert_eq!(e.hashes.unwrap().len(), 2);
    }

    #[test]
    fn path_validation() {
        assert!(validate_path("").is_ok());
        assert!(validate_path("a/b.txt").is_ok());
        assert!(validate_path("cuts/").is_ok());
        for bad in ["/a", "a//b", "a/./b", "../a", "a/..", "a\0b"] {
            assert!(validate_path(bad).is_err(), "{bad:?}");
        }
        assert!(validate_path(&"x".repeat(1025)).is_err());
    }
}
