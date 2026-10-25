//! Codec round-trips against every JSON example in mac/DAEMON-PROTOCOL.md and the Swift
//! ProtocolTests. Server->client lines must re-encode to exactly the same JSON value.

use serde_json::{Value, json};
use ulsd::protocol::*;

fn rt<T: serde::Serialize + serde::de::DeserializeOwned>(line: &str) -> T {
    let want: Value = serde_json::from_str(line).unwrap();
    let t: T = serde_json::from_str(line).unwrap();
    assert_eq!(serde_json::to_value(&t).unwrap(), want, "re-encoded: {line}");
    t
}

#[test]
fn spec_example_session() {
    // -> {"id":1,"method":"status"}
    let r = parse_request(r#"{"id":1,"method":"status"}"#).unwrap();
    assert_eq!((r.id, r.method.as_str()), (1, "status"));
    // <- status
    let resp: Response = rt(r#"{"id":1,"result":{"version":"0.1.0","state":"idle","pendingOps":0}}"#);
    let st: Status = serde_json::from_value(resp.result.unwrap()).unwrap();
    assert_eq!(st, Status { version: "0.1.0".into(), state: State::Idle, message: None, pending_ops: Some(0) });
    // -> drive.mount
    let r = parse_request(r#"{"id":2,"method":"drive.mount","params":{"driveId":"demo"}}"#).unwrap();
    assert_eq!(parse_params::<DriveParams>(&r).unwrap().drive_id, "demo");
    // <- transfer event
    let ev: Event = rt(r#"{"event":"transfer","data":{"id":"t1","driveId":"demo","path":"/a.bin","direction":"download","bytesDone":0,"bytesTotal":4096,"status":"active"}}"#);
    assert!(matches!(ev, Event::Transfer(ref t) if t.direction == Direction::Download && !t.is_finished()));
    // <- {}
    let resp: Response = rt(r#"{"id":2,"result":{}}"#);
    assert_eq!(resp, Response::empty(2));
    // <- state event
    let ev: Event = rt(r#"{"event":"state","data":{"state":"syncing"}}"#);
    assert_eq!(ev, Event::State(StateEvent { state: State::Syncing, message: None }));
}

#[test]
fn swift_protocol_tests() {
    // encodeStatusRequest / encodeMountRequest (the exact lines the Swift codec emits)
    let r = parse_request(r#"{"id":1,"method":"status"}"#).unwrap();
    assert_eq!(r.params, json!({}));
    let r = parse_request(r#"{"id":7,"method":"drive.mount","params":{"driveId":"d1"}}"#).unwrap();
    assert_eq!(parse_params::<DriveParams>(&r).unwrap().drive_id, "d1");

    // decodeStatusResponse
    rt::<Response>(r#"{"id":1,"result":{"version":"0.1.0","state":"syncing","pendingOps":3}}"#);
    // decodeErrorResponse
    let e: Response = rt(r#"{"id":2,"error":{"code":"no_such_drive","message":"nope"}}"#);
    assert_eq!(e.error, Some(ErrorBody::new("no_such_drive", "nope")));
    assert!(e.result.is_none());
    // decodeDrivesList
    let line = r#"{"id":3,"result":{"drives":[{"driveId":"a","name":"A","mountState":"mounted","mountPath":"/Volumes/A"}]}}"#;
    let resp: Response = rt(line);
    #[derive(serde::Deserialize)]
    struct R {
        drives: Vec<DriveInfo>,
    }
    let d = serde_json::from_value::<R>(resp.result.unwrap()).unwrap().drives;
    assert_eq!(d, vec![DriveInfo { drive_id: "a".into(), name: "A".into(), mount_state: MountState::Mounted, mount_path: Some("/Volumes/A".into()) }]);
    // decodeTransferEvent
    let ev: Event = rt(r#"{"event":"transfer","data":{"id":"t1","driveId":"a","path":"/x.bin","direction":"upload","bytesDone":10,"bytesTotal":100,"status":"active"}}"#);
    assert!(matches!(ev, Event::Transfer(t) if t.bytes_done == 10 && t.bytes_total == 100 && t.direction == Direction::Upload));
    // decodeChangeEvent
    let ev: Event = rt(r#"{"event":"change","data":{"driveId":"a","seq":42,"paths":["/a","/b"]}}"#);
    assert_eq!(ev, Event::Change(ChangeEvent { drive_id: "a".into(), seq: 42, paths: vec!["/a".into(), "/b".into()] }));
    // decodeStateEventAndUnknown
    let ev: Event = rt(r#"{"event":"state","data":{"state":"offline","message":"no network"}}"#);
    assert_eq!(ev, Event::State(StateEvent { state: State::Offline, message: Some("no network".into()) }));
    // malformedRejected
    assert!(parse_request("not json").is_err());
    assert!(parse_request(r#"{"foo":1}"#).is_err());
}

#[test]
fn all_enum_spellings_match_swift_raw_values() {
    for (s, v) in [("signed_out", State::SignedOut), ("idle", State::Idle), ("syncing", State::Syncing), ("offline", State::Offline), ("error", State::Error)] {
        assert_eq!(serde_json::to_value(v).unwrap(), json!(s));
    }
    for (s, v) in [("unmounted", MountState::Unmounted), ("mounting", MountState::Mounting), ("mounted", MountState::Mounted), ("unmounting", MountState::Unmounting), ("error", MountState::Error)] {
        assert_eq!(serde_json::to_value(v).unwrap(), json!(s));
    }
    for (s, v) in [("queued", TransferStatus::Queued), ("active", TransferStatus::Active), ("done", TransferStatus::Done), ("failed", TransferStatus::Failed)] {
        assert_eq!(serde_json::to_value(v).unwrap(), json!(s));
    }
}

#[test]
fn auth_and_config_shapes() {
    // auth.set params (AuthSetParams.swift)
    let r = parse_request(r#"{"id":5,"method":"auth.set","params":{"apiEndpoint":"http://x","accessToken":"a","refreshToken":"r"}}"#).unwrap();
    let p: AuthSetParams = parse_params(&r).unwrap();
    assert_eq!(p.api_endpoint, "http://x");
    // auth.set result / auth.status results
    rt::<Response>(r#"{"id":5,"result":{"user":{"id":"u_1","email":"a@b.c"}}}"#);
    let s: AuthStatus = rt(r#"{"signedIn":true,"user":{"id":"u_1","email":"a@b.c"},"apiEndpoint":"http://x"}"#);
    assert!(s.signed_in);
    let s: AuthStatus = rt(r#"{"signedIn":false}"#);
    assert!(s.user.is_none() && s.api_endpoint.is_none());
    // config.set (DaemonConfig): every field optional
    let r = parse_request(r#"{"id":1,"method":"config.set","params":{"cacheCapBytes":1000}}"#).unwrap();
    let c: ConfigParams = parse_params(&r).unwrap();
    assert_eq!(c.cache_cap_bytes, Some(1000));
    assert!(c.endpoint.is_none() && c.token.is_none());
    // transfers result
    rt::<Response>(r#"{"id":9,"result":{"transfers":[]}}"#);
    // unknown fields are ignored
    let r = parse_request(r#"{"id":1,"method":"drive.mount","params":{"driveId":"d","extra":1}}"#).unwrap();
    assert!(parse_params::<DriveParams>(&r).is_ok());
}

#[test]
fn every_error_code_in_the_spec_is_defined() {
    for c in ["no_such_drive", "already_mounted", "not_mounted", "unauthorized", "offline", "bad_request", "internal"] {
        assert!([code::NO_SUCH_DRIVE, code::ALREADY_MOUNTED, code::NOT_MOUNTED, code::UNAUTHORIZED, code::OFFLINE, code::BAD_REQUEST, code::INTERNAL].contains(&c));
    }
}

#[test]
fn lines_have_no_raw_newlines() {
    let r = Response::err(1, ErrorBody::bad_request("multi\nline"));
    assert!(!r.to_line().contains('\n'));
    let e = Event::State(StateEvent { state: State::Error, message: Some("a\nb".into()) });
    assert!(!e.to_line().contains('\n'));
}
