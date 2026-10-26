//! Local contract tests for M3 socket and CLI parity (no native mounts or external services).
use std::path::PathBuf;
use std::sync::{Arc,Mutex};
use async_trait::async_trait;
use clap::Parser;
use serde_json::{json,Value};
use uls_client::Client;
use ulsd::engine::{Engine,EngineConfig,resolve_in_orgs};
use ulsd::mount::{MountAdapter,MountHandle,MountRequest,MountError,NeedAccess};
use ulsd::protocol::parse_request;

struct Adapter { paths: Arc<Mutex<Vec<PathBuf>>> }
struct Handle;
#[async_trait]
impl MountHandle for Handle { async fn unmount(&self)->Result<(),MountError> {Ok(())} }
#[async_trait]
impl MountAdapter for Adapter {
    fn access(&self)->NeedAccess {NeedAccess::Read}
    async fn mount(&self,req:MountRequest)->Result<Arc<dyn MountHandle>,MountError> { self.paths.lock().unwrap().push(req.mountpoint); Ok(Arc::new(Handle)) }
}
async fn call(e:&Arc<Engine>,method:&str,params:Value)->Value {
    let response=e.handle(parse_request(&json!({"id":1,"method":method,"params":params}).to_string()).unwrap()).await;
    assert!(response.error.is_none(),"{response:?}");response.result.unwrap()
}
fn config(dir:&std::path::Path,endpoint:String)->EngineConfig {
    EngineConfig {version:"test".into(),state_path:dir.join("state.json"),mount_root:dir.join("mnt"),cache_dir:Some(dir.join("cache")),secrets:Arc::new(uls_auth::MemoryStore::new()),default_endpoint:endpoint}
}
#[test]
fn cli_shapes_and_legacy_mount_flags() {
    for args in [vec!["uls","drives","--json"],vec!["uls","use","Acme"],vec!["uls","mount","Demo"],vec!["uls","mount","Demo","/tmp/demo","--read-only","--state-dir","/tmp/state"],vec!["uls","mounts","--json"],vec!["uls","unmount","/tmp/demo"],vec!["uls","status"],vec!["uls","uploads","--watch","--json"],vec!["uls","pin","d","/a"],vec!["uls","unpin","d","/a"],vec!["uls","history","d","a","--json"],vec!["uls","show","d","a","--at","2026-01-01T00:00:00Z"],vec!["uls","restore","d","a","v_1"],vec!["uls","restore","d","a/","--at","2026-01-01T00:00:00Z","--dry-run"],vec!["uls","fork","d","new"],vec!["uls","keys"],vec!["uls","keys","create","--name","test","--org","org","--access","write"],vec!["uls","keys","revoke","k1"],vec!["uls","daemon","start"],vec!["uls","daemon","stop"],vec!["uls","daemon","status","--json"],vec!["uls","upload","a","b","d:/folder"]] {
        assert!(ulsd::cli::Cli::try_parse_from(&args).is_ok(),"{args:?}");
    }
    assert!(ulsd::cli::Cli::try_parse_from(["uls","show","d","a","--at","T","--version","v"]).is_err());
}
#[test]
fn name_alias_id_workspace_and_ambiguity() {
    let orgs=json!({"orgs":[{"id":"o1","name":"Acme","drives":[{"id":"d1","name":"Footage","alias":"cuts"}]},{"id":"o2","name":"Other","drives":[{"id":"d2","name":"Footage"}]}]});
    assert_eq!(resolve_in_orgs(&orgs,"D1",None).unwrap(),"d1");
    assert_eq!(resolve_in_orgs(&orgs,"ACME/footage",None).unwrap(),"d1");
    assert_eq!(resolve_in_orgs(&orgs,"CUTS",None).unwrap(),"d1");
    assert_eq!(resolve_in_orgs(&orgs,"footage",Some("o2")).unwrap(),"d2");
    let e=resolve_in_orgs(&orgs,"footage",None).unwrap_err();
    assert!(e.message.contains("Acme/Footage")&&e.message.contains("Other/Footage"));
}
#[tokio::test]
async fn pins_mount_options_uploads_and_cap() {
    let server=uls_mock::MockServer::start("local").await;
    let c=Client::builder(server.url(),"local").build().unwrap();c.create_drive("drive",None).await.unwrap();
    let dir=tempfile::tempdir_in("/tmp").unwrap();let local=dir.path().join("local");std::fs::write(&local,b"offline").unwrap();
    c.upload_file("drive",&local,"folder/a",None).await.unwrap();
    let paths=Arc::new(Mutex::new(Vec::new()));
    let e=Engine::new(config(dir.path(),server.url()),Arc::new(Adapter{paths:paths.clone()}));
    call(&e,"config.set",json!({"token":"local","cacheCapBytes":0,"journalCapBytes":3})).await;
    let mut events=e.subscribe();
    call(&e,"drive.pin",json!({"driveId":"drive","path":"/folder","pinned":true})).await;
    let pins=call(&e,"pins.list",json!({"driveId":"drive"})).await;
    assert_eq!(pins["pins"][0]["bytes"],7);assert_eq!(pins["pins"][0]["cachedBytes"],7);
    let event:Value=serde_json::from_str(&events.recv().await.unwrap()).unwrap();assert_eq!(event["event"],"pin");
    let cache=uls_client::ShardCache::open(dir.path().join("cache"),0).unwrap();cache.evict();
    assert_eq!(call(&e,"pins.list",json!({})).await["pins"][0]["cachedBytes"],7);
    call(&e,"drive.pin",json!({"driveId":"drive","path":"/folder","pinned":false})).await;
    assert!(call(&e,"pins.list",json!({})).await["pins"].as_array().unwrap().is_empty());
    // Uploads work without a native mount and remain in the daemon's durable VFS journal.
    std::fs::write(&local,b"abc").unwrap();
    call(&e,"upload.queue",json!({"driveId":"drive","files":[{"local":local,"path":"queued"}]})).await;
    let uploads=call(&e,"uploads",json!({})).await;assert_eq!(uploads["journalCapBytes"],3);assert_eq!(uploads["journalBytes"],3);
    assert!(uploads["pending"].as_array().unwrap().iter().any(|p|p["path"]=="/queued"));
    e.shutdown().await;
    let e=Engine::new(config(dir.path(),server.url()),Arc::new(Adapter{paths:paths.clone()}));
    call(&e,"config.set",json!({"token":"local"})).await;
    let point=dir.path().join("custom");
    let result=call(&e,"drive.mount",json!({"driveId":"drive","mountpoint":point,"readOnly":true})).await;
    assert_eq!(result["mountpoint"],json!(point));
    let mounts=call(&e,"mounts.list",json!({})).await;assert_eq!(mounts["mounts"][0]["readOnly"],true);assert_eq!(mounts["mounts"][0]["adapter"],"nfs");
    e.shutdown().await;
    let state:Value=serde_json::from_slice(&std::fs::read(dir.path().join("state.json")).unwrap()).unwrap();
    assert_eq!(state["mounts"][0]["mountPath"],json!(point));assert_eq!(state["mounts"][0]["readOnly"],true);
    // auth.set/config.set restoration uses the remembered path rather than a generated root.
    assert_eq!(paths.lock().unwrap().last(),Some(&point));
}
#[tokio::test]
async fn historical_selection_and_subtree_restore_is_one_commit() {
    let server=uls_mock::MockServer::start("local").await;let c=Client::builder(server.url(),"local").build().unwrap();c.create_drive("drive",None).await.unwrap();
    let dir=tempfile::tempdir_in("/tmp").unwrap();let local=dir.path().join("seed");std::fs::write(&local,b"before").unwrap();
    c.upload_file("drive",&local,"folder/a",None).await.unwrap();c.upload_file("drive",&local,"folder/deleted",None).await.unwrap();
    let ts=c.versions("drive","folder/deleted").await.unwrap()[0].ts;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    std::fs::write(&local,b"after").unwrap();c.upload_file("drive",&local,"folder/a",None).await.unwrap();c.upload_file("drive",&local,"folder/new",None).await.unwrap();c.delete("drive","folder/deleted",None).await.unwrap();
    let v=ulsd::history::at(&c,"drive","folder/a",ts).await.unwrap().unwrap();assert_eq!(v.size,Some(6));
    let ops=ulsd::history::plan(&c,"drive","folder/",ts).await.unwrap();assert_eq!(ops.len(),3);
    let head=c.drive_info("drive").await.unwrap().head_seq;
    let result=c.commit("drive",ops).await.unwrap();assert_eq!(result.seq,head+1);
    assert_eq!(c.read_range("drive","folder/a",0,100).await.unwrap().as_ref(),b"before");
    assert_eq!(c.read_range("drive","folder/deleted",0,100).await.unwrap().as_ref(),b"before");
    assert!(c.stat("drive","folder/new").await.is_err());
}

async fn cli(server:&uls_mock::MockServer,dir:&std::path::Path,args:&[&str])->std::process::Output {
    tokio::process::Command::new(env!("CARGO_BIN_EXE_ulsd")).args(args)
        .env("ULS_ENDPOINT",server.url()).env("ULS_DEV_TOKEN","local").env("ULS_SOCKET",dir.join("absent.sock"))
        .output().await.unwrap()
}
#[tokio::test]
async fn cli_mock_history_show_restore_and_json_reads() {
    let server=uls_mock::MockServer::start("local").await;
    let c=Client::builder(server.url(),"local").build().unwrap();c.create_drive("drive",None).await.unwrap();
    let dir=tempfile::tempdir_in("/tmp").unwrap();let local=dir.path().join("source");std::fs::write(&local,b"old bytes").unwrap();
    let before=c.upload_file("drive",&local,"a",None).await.unwrap();
    let output=cli(&server,dir.path(),&["show","drive","a","--version",&before.version_id]).await;
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));assert_eq!(output.stdout,b"old bytes");
    for args in [vec!["history","drive","a","--json"],vec!["versions","drive","a","--json"],vec!["stat","drive","a","--json"],vec!["ls","drive","--json"],vec!["drive","info","drive","--json"],vec!["show","drive","a","--json"]] {
        let output=cli(&server,dir.path(),&args).await;
        assert!(output.status.success(),"{args:?}: {}",String::from_utf8_lossy(&output.stderr));
        let _:Value=serde_json::from_slice(&output.stdout).unwrap();
    }
    std::fs::write(&local,b"new bytes").unwrap();c.upload_file("drive",&local,"a",None).await.unwrap();
    let output=cli(&server,dir.path(),&["restore","drive","a",&before.version_id]).await;assert!(output.status.success());
    assert_eq!(c.read_range("drive","a",0,100).await.unwrap().as_ref(),b"old bytes");
    let output=cli(&server,dir.path(),&["show","drive","a","--at","1970-01-01T00:00:00Z"]).await;assert!(!output.status.success());
}

#[tokio::test]
async fn socket_cli_read_commands_fork_keys_and_workspace() {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use wiremock::{Mock,MockServer,ResponseTemplate};
    use wiremock::matchers::{method,path,body_json};
    let dir=tempfile::tempdir_in("/tmp").unwrap();let socket=dir.path().join("uls.sock");
    let api=MockServer::start().await;
    let data=uls_mock::MockServer::start("local").await;
    let client=Client::builder(data.url(),"local").build().unwrap();client.create_drive("drive",None).await.unwrap();
    let seed=dir.path().join("seed");std::fs::write(&seed,b"through daemon").unwrap();client.upload_file("drive",&seed,"file",None).await.unwrap();
    Mock::given(method("POST")).and(path("/drives/drive/token")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"token":"local","endpoint":data.url(),"driveId":"drive","expiresAt":9999999999999u64}))).mount(&api).await;
    let orgs=json!({"orgs":[{"id":"o1","name":"Acme","drives":[{"id":"drive","name":"Demo","alias":"alias","orgId":"o1","status":"active"}]}]});
    Mock::given(method("GET")).and(path("/orgs")).respond_with(ResponseTemplate::new(200).set_body_json(orgs)).mount(&api).await;
    Mock::given(method("POST")).and(path("/drives/drive/fork")).and(body_json(json!({"name":"Branch"}))).respond_with(ResponseTemplate::new(201).set_body_json(json!({"id":"child","name":"Branch"}))).expect(1).mount(&api).await;
    Mock::given(method("GET")).and(path("/keys")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"keys":[]}))).mount(&api).await;
    Mock::given(method("POST")).and(path("/keys")).and(body_json(json!({"label":"test","workspaceId":"o1","access":"write","drives":null}))).respond_with(ResponseTemplate::new(201).set_body_json(json!({"accessKeyId":"K1"}))).expect(1).mount(&api).await;
    Mock::given(method("DELETE")).and(path("/keys/K1")).respond_with(ResponseTemplate::new(204)).expect(1).mount(&api).await;
    let e=Engine::new(config(dir.path(),"http://127.0.0.1:1".into()),Arc::new(Adapter{paths:Default::default()}));
    let exp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()+900;
    let access=format!("e30.{}.sig",URL_SAFE_NO_PAD.encode(json!({"sub":"u1","email":"a@b.c","exp":exp}).to_string()));
    call(&e,"auth.set",json!({"apiEndpoint":api.uri(),"accessToken":access,"refreshToken":"local-refresh"})).await;
    let (listener,uid)=ulsd::server::bind(&socket).unwrap();let serving=tokio::spawn(ulsd::server::serve(listener,uid,e.clone()));
    for args in [vec!["drives","--json"],vec!["mounts","--json"],vec!["status","--json"],vec!["uploads","--json"],vec!["use","acme","--json"],vec!["fork","ALIAS","Branch","--json"],vec!["keys","list","--json"],vec!["keys","create","--name","test","--org","o1","--access","write","--json"],vec!["keys","revoke","K1","--json"],vec!["stat","ALIAS","file","--json"],vec!["ls","drive","--json"],vec!["history","drive","file","--json"],vec!["show","drive","file","--json"]] {
        let output=tokio::process::Command::new(env!("CARGO_BIN_EXE_ulsd")).args(&args).env("ULS_SOCKET",&socket).env_remove("ULS_DEV_TOKEN").output().await.unwrap();
        assert!(output.status.success(),"{args:?}: {}",String::from_utf8_lossy(&output.stderr));
        let _:Value=serde_json::from_slice(&output.stdout).unwrap();
    }
    let empty=dir.path().join("empty");std::fs::create_dir(&empty).unwrap();
    for args in [vec!["pin".to_string(),"ALIAS".into(),"file".into()],vec!["unpin".into(),"drive".into(),"file".into()],vec!["upload".into(),seed.to_string_lossy().into_owned(),empty.to_string_lossy().into_owned(),"drive:/import".into()]] {
        let output=tokio::process::Command::new(env!("CARGO_BIN_EXE_ulsd")).args(&args).env("ULS_SOCKET",&socket).env_remove("ULS_DEV_TOKEN").output().await.unwrap();
        assert!(output.status.success(),"{args:?}: {}",String::from_utf8_lossy(&output.stderr));
    }
    let point=dir.path().join("custom-cli");
    let output=tokio::process::Command::new(env!("CARGO_BIN_EXE_ulsd")).args(["mount","ALIAS"]).arg(&point).args(["--read-only","--json"]).env("ULS_SOCKET",&socket).env_remove("ULS_DEV_TOKEN").output().await.unwrap();
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let mounted:Value=serde_json::from_slice(&output.stdout).unwrap();assert_eq!(mounted["mountpoint"],json!(point));
    let output=tokio::process::Command::new(env!("CARGO_BIN_EXE_ulsd")).arg("unmount").arg(&point).env("ULS_SOCKET",&socket).env_remove("ULS_DEV_TOKEN").output().await.unwrap();
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    assert_eq!(client.read_range("drive","import/seed",0,100).await.unwrap().as_ref(),b"through daemon");
    assert_eq!(client.stat("drive","import/empty/").await.unwrap().node_type,uls_proto::NodeType::Folder);
    call(&e,"daemon.stop",json!({})).await;
    tokio::time::timeout(std::time::Duration::from_secs(1),e.stop.notified()).await.unwrap();
    serving.abort();e.shutdown().await;
}

#[tokio::test]
async fn daemon_cli_start_status_stop_are_isolated() {
    let dir=tempfile::tempdir_in("/tmp").unwrap();let socket=dir.path().join("daemon.sock");
    async fn command(dir:&std::path::Path,socket:&std::path::Path,action:&str)->std::process::Output {
        tokio::process::Command::new(env!("CARGO_BIN_EXE_ulsd")).arg("daemon").arg(action).arg("--state-dir").arg(dir).arg("--socket").arg(socket).args(["--secret-store","memory"]).output().await.unwrap()
    }
    let output=command(dir.path(),&socket,"start").await;
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let output=command(dir.path(),&socket,"status").await;
    assert!(output.status.success());
    let output=command(dir.path(),&socket,"stop").await;
    assert!(output.status.success());
    for _ in 0..100 {if !socket.exists() {break;}tokio::time::sleep(std::time::Duration::from_millis(20)).await;}
    assert!(!socket.exists());
}

#[tokio::test]
async fn historical_file_renames_retain_bytes_and_folder_deletes_hide_descendants() {
    let server=uls_mock::MockServer::start("local").await;let c=Client::builder(server.url(),"local").build().unwrap();c.create_drive("drive",None).await.unwrap();
    let dir=tempfile::tempdir_in("/tmp").unwrap();let local=dir.path().join("source");std::fs::write(&local,b"content").unwrap();
    c.upload_file("drive",&local,"folder/old",None).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    c.rename("drive","folder/old","folder/new",None).await.unwrap();
    let versions=c.versions("drive","folder/new").await.unwrap();let ts=versions[0].ts;
    assert_eq!(c.read_range("drive","folder/new",0,100).await.unwrap().as_ref(),b"content");
    assert_eq!(ulsd::history::at(&c,"drive","folder/old",ts).await.unwrap().unwrap().op,"delete");
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    c.delete("drive","folder/",None).await.unwrap();
    let deleted=c.versions("drive","folder/").await.unwrap().last().unwrap().ts;
    assert!(ulsd::history::at(&c,"drive","folder/new",deleted).await.unwrap().is_none());
    assert!(ulsd::history::plan(&c,"drive","folder/",deleted).await.unwrap().is_empty());
}

#[tokio::test]
async fn explicit_dev_token_never_resolves_through_an_existing_daemon_socket() {
    let server = uls_mock::MockServer::start("isolated-token").await;
    let client = Client::builder(server.url(), "isolated-token").build().unwrap();
    client.create_drive("fixture-drive", None).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    std::fs::write(&source, b"fixture").unwrap();
    client.upload_file("fixture-drive", &source, "file", None).await.unwrap();
    let socket = dir.path().join("unrelated.sock");
    // The socket exists but never responds. Consulting it would hang instead of using the fixture.
    let _listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_ulsd"));
    command.args(["stat", "fixture-drive", "file", "--json"])
        .env("ULS_ENDPOINT", server.url()).env("ULS_DEV_TOKEN", "isolated-token")
        .env("ULS_SOCKET", &socket).env_remove("ULS_ACCESS_TOKEN").kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output()).await.unwrap().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stat: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(stat["size"], 7);
}
