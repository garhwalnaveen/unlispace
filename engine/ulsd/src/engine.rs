//! The daemon's brain: owns auth, remembered mounts, per-drive watch tasks and the state
//! machine. The socket layer only parses lines and calls [`Engine::handle`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use uls_auth::{AuthEvent, DriveSummary, SecretStore, Session};
use uls_client::{Client, ShardCache, WatchEvent};
use uls_vfs::{Vfs, VfsEvent, VfsOptions};

use crate::hub::AuthHub;
use crate::mount::{MountAdapter, MountHandle, MountRequest, NeedAccess};
use crate::protocol::*;
use crate::state::{MountRecord, PersistedAuth, StateStore, PinRecord};
use crate::watch::{self, WatchCtx};

pub struct EngineConfig {
    pub version: String,
    pub state_path: PathBuf,
    /// `~/Unlispace`; drives mount at `<root>/<Drive name>`.
    pub mount_root: PathBuf,
    /// Shard cache directory; `None` = the platform default.
    pub cache_dir: Option<PathBuf>,
    pub secrets: Arc<dyn SecretStore>,
    /// Data-plane endpoint used with a dev token when `config.set` gave no `endpoint`.
    pub default_endpoint: String,
}

struct Entry {
    name: String,
    read_only: bool,
    adapter_name: String,
    path: PathBuf,
    state: MountState,
    handle: Option<Arc<dyn MountHandle>>,
    tasks: Vec<JoinHandle<()>>,
    vfs: Option<Vfs>,
}

pub struct Engine {
    pub stop: tokio::sync::Notify,
    cfg: EngineConfig,
    hub: Arc<AuthHub>,
    store: Arc<StateStore>,
    adapter: Arc<dyn MountAdapter>,
    events: broadcast::Sender<String>,
    mounts: Mutex<HashMap<String, Entry>>,
    status: Mutex<(State, Option<String>)>,
    known_drives: Mutex<Vec<DriveSummary>>,
    cache: OnceLock<Option<Arc<ShardCache>>>,
    journals: Mutex<HashMap<String, Vfs>>,
    journal_tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    journal_lock: tokio::sync::Mutex<()>,
    budget: Arc<uls_vfs::JournalBudget>,
}

fn to_val<T: Serialize>(t: T) -> Result<Value, ErrorBody> {
    serde_json::to_value(t).map_err(|_| ErrorBody::internal("encode"))
}

/// A folder name safe to create under the mount root.
pub fn safe_dir_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c == '/' || c == ':' || c.is_control() { '-' } else { c }).collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim().to_string();
    if cleaned.is_empty() { "Drive".to_string() } else { cleaned }
}

fn valid_drive_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Engine {
    pub fn new(cfg: EngineConfig, adapter: Arc<dyn MountAdapter>) -> Arc<Engine> {
        let (events, _) = broadcast::channel(256);
        let hub = Arc::new(AuthHub::new(cfg.secrets.clone(), cfg.default_endpoint.clone()));
        let store = Arc::new(StateStore::load(cfg.state_path.clone()));
        let budget = Arc::new(uls_vfs::JournalBudget::new(store.get().journal_cap_bytes.unwrap_or(10 * 1024 * 1024 * 1024)));
        Arc::new(Engine {
            budget,
            stop: tokio::sync::Notify::new(),
            cfg,
            hub,
            store,
            adapter,
            events,
            mounts: Mutex::new(HashMap::new()),
            status: Mutex::new((State::SignedOut, None)),
            known_drives: Mutex::new(Vec::new()),
            cache: OnceLock::new(),
            journals: Mutex::new(HashMap::new()),
            journal_tasks: Mutex::new(HashMap::new()),
            journal_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.events.subscribe()
    }

    pub fn emit(&self, e: &Event) {
        let _ = self.events.send(e.to_line());
    }

    pub fn state_event_line(&self) -> String {
        let (state, message) = self.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
        Event::State(StateEvent { state, message }).to_line()
    }

    fn set_state(&self, state: State, message: Option<String>) {
        {
            let mut s = self.status.lock().unwrap_or_else(|e| e.into_inner());
            if *s == (state, message.clone()) {
                return;
            }
            *s = (state, message.clone());
        }
        self.emit(&Event::State(StateEvent { state, message }));
    }

    fn current_state(&self) -> State {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).0
    }

    fn note_ok(&self) {
        if self.hub.is_authenticated() && matches!(self.current_state(), State::SignedOut | State::Offline | State::Error) {
            self.set_state(State::Idle, None);
        }
    }

    fn note_err(&self, e: &ErrorBody) {
        if e.code == code::OFFLINE {
            self.set_state(State::Offline, Some("cannot reach the Unlispace servers".into()));
        }
    }

    fn mounts(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.mounts.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Resume the previous session and remembered mounts. Call once at startup.
    pub async fn start(self: &Arc<Self>) {
        if let Ok(token) = std::env::var("ULS_DEV_TOKEN") { self.hub.set_dev(None,Some(token)); self.note_ok(); }
        let persisted = self.store.get();
        if let Some(a) = persisted.auth {
            match self.hub.restore(&a.api_endpoint, &a.user) {
                Ok(Some(s)) => {
                    self.watch_session(s);
                    self.set_state(State::Idle, None);
                }
                Ok(None) => tracing::info!("no stored credentials for the remembered user"),
                Err(e) => tracing::warn!("could not restore session: {}", e.message),
            }
        }
        if self.hub.is_authenticated() {
            let me = self.clone();
            tokio::spawn(async move {
                me.restore_mounts().await;
                for id in me.store.get().upload_drives { if let Err(e) = me.journal_for(&id).await { me.note_err(&e); } }
            });
        }
    }

    async fn restore_mounts(self: &Arc<Self>) {
        for rec in self.store.get().mounts {
            if self.mounts().contains_key(&rec.drive_id) {
                continue;
            }
            if let Err(e) = self.mount_named(&rec.drive_id, &rec.name, rec.mount_path.map(PathBuf::from), rec.read_only).await {
                tracing::warn!(drive = %rec.drive_id, "could not restore mount: {}: {}", e.code, e.message);
                self.note_err(&e);
            }
        }
    }

    /// Reacts to the session being cleared by a failed refresh (`invalid_refresh`).
    fn watch_session(self: &Arc<Self>, s: Arc<Session>) {
        let mut rx = s.subscribe();
        let weak = Arc::downgrade(&s);
        drop(s);
        let me = self.clone();
        tokio::spawn(async move {
            while let Ok(AuthEvent::SignedOut) = rx.recv().await {
                // Ignore events from a session that has since been replaced.
                let is_current = me.hub.session().is_some_and(|c| std::ptr::eq(Arc::as_ptr(&c), weak.as_ptr()));
                if is_current {
                    me.on_signed_out().await;
                }
            }
        });
    }

    async fn on_signed_out(self: &Arc<Self>) {
        self.unmount_all(true).await;
        self.stop_journals().await;
        self.store.update(|p| {
            p.upload_drives.clear();
            p.auth = None;
            p.mounts.clear();
            p.cursors.clear();
        });
        self.known_drives.lock().unwrap_or_else(|e| e.into_inner()).clear();
        let st = if self.hub.has_dev() { State::Idle } else { State::SignedOut };
        self.set_state(st, None);
    }

    /// SIGTERM path: unmount everything but keep the remembered mounts for the next start.
    pub async fn shutdown(&self) {
        self.unmount_all(false).await;
        self.stop_journals().await;
    }

    async fn stop_journals(&self) {
        let tasks = std::mem::take(&mut *self.journal_tasks.lock().unwrap_or_else(|e|e.into_inner()));
        for (_,task) in tasks { task.abort(); let _ = task.await; }
        let journals = std::mem::take(&mut *self.journals.lock().unwrap_or_else(|e|e.into_inner()));
        for (_,vfs) in journals { let _ = vfs.shutdown().await; }
    }

    pub async fn unmount_all(&self, forget: bool) {
        let ids: Vec<String> = self.mounts().keys().cloned().collect();
        for id in ids {
            if let Err(e) = self.unmount_inner(&id, forget).await {
                tracing::warn!(drive = %id, "unmount failed: {}", e.message);
            }
        }
    }

    // ---- request dispatch ---------------------------------------------------------------

    pub async fn handle(self: &Arc<Self>, req: Request) -> Response {
        tracing::debug!(id = req.id, method = %req.method, "request");
        let id = req.id;
        match self.dispatch(&req).await {
            Ok(v) => Response { id, result: Some(v), error: None },
            Err(e) => Response::err(id, e),
        }
    }

    async fn dispatch(self: &Arc<Self>, req: &Request) -> Result<Value, ErrorBody> {
        match req.method.as_str() {
            "daemon.stop" => {
                let me = self.clone();
                tokio::spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(100)).await; me.stop.notify_one(); });
                Ok(json!({}))
            }
            "status" => {
                let (state, message) = self.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
                to_val(Status { version: self.cfg.version.clone(), state, message, pending_ops: Some(self.pending_ops().await) })
            }
            "drives.list" => to_val(json!({ "drives": self.drives_list().await? })),
            "drive.mount" => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Params { drive_id: String, mountpoint: Option<PathBuf>, #[serde(default)] read_only: bool }
                let p: Params = parse_params(req)?;
                let id = self.resolve_drive(&p.drive_id).await?;
                if !valid_drive_id(&id) { return Err(ErrorBody::new(code::NO_SUCH_DRIVE,"no such drive")); }
                let name = self.drive_name(&id).await?;
                self.mount_named(&id, &name, p.mountpoint, p.read_only).await?;
                Ok(json!({"mountpoint": self.mounts()[&id].path}))
            }
            "drive.unmount" => {
                let p: DriveParams = parse_params(req)?;
                let by_path = self.mounts().iter().find(|(id, e)| id.eq_ignore_ascii_case(&p.drive_id) || e.path.to_string_lossy() == p.drive_id).map(|(id,_)| id.clone());
                let id = match by_path { Some(id) => id, None => self.resolve_drive(&p.drive_id).await? };
                self.unmount_inner(&id, true).await?;
                Ok(json!({}))
            }
            "mounts.list" => {
                let mut mounts: Vec<_> = self.mounts().iter().filter(|(_,e)| e.state == MountState::Mounted)
                    .map(|(id,e)| json!({"driveId": id, "mountpoint": e.path, "readOnly": e.read_only, "adapter": e.adapter_name})).collect();
                mounts.sort_by_key(|v| v["driveId"].as_str().unwrap_or("").to_string());
                Ok(json!({"mounts": mounts}))
            }
            "drive.resolve" => {
                let p: DriveParams = parse_params(req)?;
                let id = self.resolve_drive(&p.drive_id).await?;
                Ok(json!({"driveId": id}))
            }
            "workspace.use" => {
                let workspace = req.params["workspace"].as_str().ok_or_else(|| ErrorBody::bad_request("workspace required"))?;
                let orgs = self.hub.orgs().await?;
                let matches: Vec<_> = orgs.iter().filter(|o| o.name.eq_ignore_ascii_case(workspace) || o.id.eq_ignore_ascii_case(workspace)).collect();
                if matches.len() != 1 { return Err(ErrorBody::bad_request("workspace must match exactly one workspace")); }
                self.store.update(|s| s.workspace = Some(matches[0].id.clone()));
                Ok(json!({"workspace": matches[0].id}))
            }
            "drive.pin" => self.pin(req).await,
            "pins.list" => {
                let filter = req.params.get("driveId").and_then(Value::as_str);
                let cache = self.cache();
                let pins: Vec<_> = self.store.get().pins.into_iter().filter(|p| filter.is_none_or(|id| p.drive_id == id))
                    .map(|p| { let bytes: u64 = p.shards.values().sum();
                        let cached: u64 = p.shards.iter().filter(|(h,_)| cache.as_ref().is_some_and(|c| c.contains(h))).map(|(_,n)| *n).sum();
                        json!({"driveId":p.drive_id,"path":p.path,"bytes":bytes,"cachedBytes":cached}) }).collect();
                Ok(json!({"pins": pins}))
            }
            "uploads" => {
                let mut pending = Vec::new();
                for (id,vfs) in self.mounted_vfs() {
                    for (path, n) in vfs.pending_paths().await { pending.push(json!({"driveId":id,"path":slashed(&path),"bytes":n})); }
                }
                Ok(json!({"pending":pending,"journalBytes":self.budget.used(),"journalCapBytes":self.journal_cap()}))
            }
            "upload.queue" => self.queue_upload(req).await,
            "api.request" => self.api_request(req).await,
            "changes" => {
                let p: DriveParams = parse_params(req)?;
                let id = self.resolve_drive(&p.drive_id).await?;
                let cursor = req.params["after"].as_i64().unwrap_or(0);
                to_val(self.build_client(&id)?.changes(&id,cursor,1000).await.map_err(|e|ErrorBody::bad_request(e.to_string()))?)
            }
            "cli.run" => {
                let mut cli: crate::cli::Cli = parse_params(req)?;
                let drive = cli.cmd.as_ref().and_then(crate::cli::data_drive).ok_or_else(||ErrorBody::bad_request("unsupported data command"))?;
                let id = self.resolve_drive(drive).await?;
                crate::cli::set_data_drive(cli.cmd.as_mut().unwrap(),id.clone());
                let access = if matches!(cli.cmd.as_ref(),Some(crate::cli::Cmd::Put {..} | crate::cli::Cmd::Mkdir {..} | crate::cli::Cmd::Rm {..} | crate::cli::Cmd::Mv {..} | crate::cli::Cmd::Restore {..})) {NeedAccess::Write} else {NeedAccess::Read};
                let output = crate::cli::execute(cli,self.build_client_access(&id,access)?).await.map_err(|e|ErrorBody::bad_request(e.to_string()))?;
                Ok(json!({"output":output}))
            }
            "transfers" => to_val(json!({ "transfers": self.transfers().await })),
            "config.set" => {
                let p: ConfigParams = parse_params(req)?;
                self.config_set(p)?;
                Ok(json!({}))
            }
            "auth.set" => {
                let p: AuthSetParams = parse_params(req)?;
                let user = self.auth_set(p).await?;
                to_val(json!({ "user": user }))
            }
            "auth.status" => to_val(self.hub.status()),
            "auth.signOut" => {
                self.auth_sign_out().await;
                Ok(json!({}))
            }
            other => Err(ErrorBody::bad_request(format!("unknown method {:?}", other.chars().take(64).collect::<String>()))),
        }
    }

    fn config_set(&self, p: ConfigParams) -> Result<(), ErrorBody> {
        if let Some(e) = &p.endpoint
            && !(e.starts_with("http://") || e.starts_with("https://"))
        {
            return Err(ErrorBody::bad_request("endpoint must be an http(s) URL"));
        }
        if p.cache_cap_bytes.is_some_and(|c| c < 0) {
            return Err(ErrorBody::bad_request("cacheCapBytes must not be negative"));
        }
        if let Some(c) = p.cache_cap_bytes {
            self.store.update(|s| s.cache_cap_bytes = Some(c));
            if let Some(cache) = self.cache() { cache.set_cap_bytes(c as u64); }
        }
        if let Some(c) = p.journal_cap_bytes {
            self.store.update(|s| s.journal_cap_bytes = Some(c));
            self.budget.set_cap(c);
        }
        if p.endpoint.is_some() || p.token.is_some() {
            self.hub.set_dev(p.endpoint, p.token);
            self.note_ok();
        }
        Ok(())
    }

    async fn auth_set(self: &Arc<Self>, p: AuthSetParams) -> Result<User, ErrorBody> {
        let api = p.api_endpoint.trim_end_matches('/').to_string();
        let out = self.hub.set(p).await?;
        if out.previous_user.as_ref().is_some_and(|u| *u != out.user.id) {
            self.unmount_all(true).await;
            self.stop_journals().await;
            self.store.update(|s| {
                s.upload_drives.clear();
                s.mounts.clear();
                s.cursors.clear();
            });
        }
        self.store.update(|s| s.auth = Some(PersistedAuth { api_endpoint: api, user: out.user.clone() }));
        self.watch_session(out.session);
        self.known_drives.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.set_state(State::Idle, None);
        let me = self.clone();
        tokio::spawn(async move { me.restore_mounts().await });
        Ok(out.user)
    }

    async fn auth_sign_out(self: &Arc<Self>) {
        if let Some(s) = self.hub.session()
            && let Err(e) = s.sign_out().await
        {
            // The local wipe has happened regardless.
            tracing::warn!("logout request failed: {e}");
        }
        self.hub.clear_dev();
        self.on_signed_out().await;
    }

    async fn drives_list(self: &Arc<Self>) -> Result<Vec<DriveInfo>, ErrorBody> {
        let mut out: Vec<DriveInfo> = Vec::new();
        if self.hub.has_session() {
            let orgs = match self.hub.orgs().await {
                Ok(o) => {
                    self.note_ok();
                    o
                }
                Err(e) => {
                    self.note_err(&e);
                    return Err(e);
                }
            };
            let mut all = Vec::new();
            for d in orgs.into_iter().flat_map(|o| o.drives) {
                if matches!(d.status.as_deref(), Some("deleted" | "provisioning_failed")) {
                    continue;
                }
                all.push(d);
            }
            let m = self.mounts();
            for d in &all {
                out.push(self.drive_info(&m, &d.id, &d.name));
            }
            drop(m);
            *self.known_drives.lock().unwrap_or_else(|e| e.into_inner()) = all;
        } else if self.hub.has_dev() {
            // No control plane: all we know about is what is mounted.
            let m = self.mounts();
            out = m.iter().map(|(id, e)| self.drive_info(&m, id, &e.name)).collect();
            out.sort_by(|a, b| a.drive_id.cmp(&b.drive_id));
        } else {
            return Err(ErrorBody::new(code::UNAUTHORIZED, "not signed in"));
        }
        Ok(out)
    }

    fn drive_info(&self, m: &HashMap<String, Entry>, id: &str, name: &str) -> DriveInfo {
        match m.get(id) {
            Some(e) => DriveInfo {
                drive_id: id.to_string(),
                name: name.to_string(),
                mount_state: e.state,
                mount_path: (e.state == MountState::Mounted).then(|| e.path.display().to_string()),
            },
            None => DriveInfo { drive_id: id.to_string(), name: name.to_string(), mount_state: MountState::Unmounted, mount_path: None },
        }
    }

    fn journal_cap(&self) -> u64 { self.store.get().journal_cap_bytes.unwrap_or(10 * 1024 * 1024 * 1024) }

    async fn resolve_drive(self: &Arc<Self>, query: &str) -> Result<String, ErrorBody> {
        if !self.hub.has_session() { return Ok(query.to_string()); }
        let request = Request { id:0,method:"api.request".into(),params:json!({"path":"/orgs"}) };
        let orgs = self.api_request(&request).await?;
        resolve_in_orgs(&orgs,query,self.store.get().workspace.as_deref())
    }

    async fn api_request(&self, req: &Request) -> Result<Value, ErrorBody> {
        let method = req.params["method"].as_str().unwrap_or("GET");
        let path = req.params["path"].as_str().ok_or_else(|| ErrorBody::bad_request("path required"))?;
        // Keep the session bearer restricted to the control-plane operations exposed by the CLI.
        if !(path == "/orgs" || path == "/keys" || path.starts_with("/keys/") || (path.starts_with("/drives/") && path.ends_with("/fork")))
            || path.contains("..") || path.contains(['?', '#', '%']) {
            return Err(ErrorBody::bad_request("unsupported API path"));
        }
        let session = self.hub.session().ok_or_else(|| ErrorBody::new(code::UNAUTHORIZED, "not signed in"))?;
        let token = session.access_token().await.map_err(crate::hub::map_auth_err)?;
        let client = Client::builder(session.api_endpoint(),token).build().map_err(|_|ErrorBody::internal("cannot build API client"))?;
        client.control_request(method,path,req.params.get("body")).await.map_err(|e|ErrorBody::bad_request(e.to_string()))
    }

    async fn pin(self: &Arc<Self>, req: &Request) -> Result<Value, ErrorBody> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params { drive_id: String, path: String, pinned: bool }
        let p: Params = parse_params(req)?;
        let id = self.resolve_drive(&p.drive_id).await?;
        let path = p.path.trim_start_matches('/').trim_end_matches('/').to_string();
        uls_proto::validate_path(&path).map_err(|_| ErrorBody::bad_request("invalid path"))?;
        let cache = self.cache().ok_or_else(|| ErrorBody::internal("cache unavailable"))?;
        let owner = format!("{id}:/{path}");
        if !p.pinned {
            cache.set_pin(&owner, Default::default()).map_err(|_| ErrorBody::internal("cannot persist pin"))?;
            self.store.update(|s| s.pins.retain(|r| r.drive_id != id || r.path != slashed(&path)));
            cache.evict();
            return Ok(json!({}));
        }
        let client = self.build_client_access(&id,NeedAccess::Read)?;
        let mut todo = vec![path.clone()];
        let mut shards = std::collections::BTreeMap::new();
        while let Some(path) = todo.pop() {
            let stat = client.stat(&id, &path).await.map_err(|_| ErrorBody::bad_request("cannot stat pinned path"))?;
            if stat.node_type == uls_proto::NodeType::Folder {
                for e in client.list(&id, &path).await.map_err(|_| ErrorBody::internal("cannot list pinned folder"))? {
                    todo.push(if path.is_empty() { e.name.trim_end_matches('/').into() } else { format!("{}/{}",path,e.name.trim_end_matches('/')) });
                }
            } else {
                for shard in client.manifest(&id, &path, stat.version_id.as_deref()).await.map_err(|_| ErrorBody::internal("cannot load manifest"))?.shards { shards.insert(shard.h, shard.n); }
            }
        }
        cache.set_pin(&owner, shards.keys().cloned().collect()).map_err(|_| ErrorBody::internal("cannot persist pin"))?;
        let record = PinRecord { drive_id: id.clone(), path: slashed(&path), shards: shards.clone() };
        self.store.update(|s| { s.pins.retain(|r| r.drive_id != id || r.path != record.path); s.pins.push(record); });
        let bytes: u64 = shards.values().sum();
        let mut cached = 0u64;
        for (hash,n) in shards {
            client.fetch_shard(&id, &hash).await.map_err(|_| ErrorBody::new(code::OFFLINE,"pin prefetch failed; retry to resume"))?;
            cached += n;
            self.emit(&Event::Pin(PinEvent {drive_id:id.clone(),path:slashed(&path),cached_bytes:cached,bytes}));
        }
        Ok(json!({}))
    }

    async fn journal_for(self: &Arc<Self>, id: &str) -> Result<Vfs, ErrorBody> {
        if !valid_drive_id(id) { return Err(ErrorBody::bad_request("invalid drive id")); }
        let _guard = self.journal_lock.lock().await;
        if let Some(vfs) = self.mounts().get(id).and_then(|e|e.vfs.clone()) { return Ok(vfs); }
        if let Some(vfs) = self.journals.lock().unwrap_or_else(|e|e.into_inner()).get(id).cloned() { return Ok(vfs); }
        let client = self.build_client_access(id,NeedAccess::Write)?;
        let dir = self.cfg.state_path.parent().ok_or_else(|| ErrorBody::internal("state path has no parent"))?.join("drives").join(id);
        let vfs = Vfs::open_with_budget(client,id,&dir,VfsOptions::default(),self.budget.clone()).await.map_err(|_| ErrorBody::internal("cannot open journal"))?;
        let events = self.spawn_vfs_events(id,vfs.clone(),vfs.subscribe());
        self.journal_tasks.lock().unwrap_or_else(|e|e.into_inner()).insert(id.to_string(),events);
        self.journals.lock().unwrap_or_else(|e|e.into_inner()).insert(id.to_string(),vfs.clone());
        Ok(vfs)
    }

    async fn queue_upload(self: &Arc<Self>, req: &Request) -> Result<Value, ErrorBody> {
        let p: DriveParams = parse_params(req)?;
        let id = self.resolve_drive(&p.drive_id).await?;
        if self.mounts().get(&id).is_some_and(|e| e.read_only) { return Err(ErrorBody::bad_request("drive is mounted read-only")); }
        let vfs = self.journal_for(&id).await?;
        self.store.update(|s| { if !s.upload_drives.contains(&id) { s.upload_drives.push(id.clone()); } });
        let files = req.params["files"].as_array().ok_or_else(|| ErrorBody::bad_request("files required"))?;
        for file in files {
            let local = file["local"].as_str().ok_or_else(|| ErrorBody::bad_request("local required"))?;
            let path = file["path"].as_str().ok_or_else(|| ErrorBody::bad_request("path required"))?;
            uls_proto::validate_path(path).map_err(|_|ErrorBody::bad_request("invalid upload path"))?;
            if file["directory"].as_bool().unwrap_or(false) {
                let mut directory = String::new();
                for component in path.split('/') {
                    if !directory.is_empty() { directory.push('/'); } directory.push_str(component);
                    match vfs.create(&directory,uls_vfs::Kind::Directory).await {
                        Ok(_) => {},
                        Err(uls_vfs::FsError::Exists) if vfs.lookup(&directory).await.is_ok_and(|a|a.kind == uls_vfs::Kind::Directory) => {},
                        Err(e) => return Err(ErrorBody::bad_request(e.to_string())),
                    }
                }
                continue;
            }
            let mut source = tokio::fs::File::open(local).await.map_err(|_| ErrorBody::bad_request("cannot read local file"))?;
            let metadata = source.metadata().await.map_err(|_|ErrorBody::bad_request("cannot stat local file"))?;
            if !metadata.is_file() { return Err(ErrorBody::bad_request("local source must be a regular file")); }
            if metadata.len() > self.journal_cap().saturating_sub(self.budget.used()) {
                self.set_state(State::Error,Some("journal_full".into()));
                return Err(ErrorBody::new("journal_full","journal full (ENOSPC)"));
            }
            let mut parent = String::new();
            for component in path.split('/').take(path.split('/').count().saturating_sub(1)) {
                if !parent.is_empty() { parent.push('/'); } parent.push_str(component);
                if let Err(e) = vfs.create(&parent, uls_vfs::Kind::Directory).await && e != uls_vfs::FsError::Exists { return Err(ErrorBody::internal(e.to_string())); }
            }
            // Stage beside the destination so ENOSPC/read failures never truncate its old head.
            static NEXT_UPLOAD: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let sequence = NEXT_UPLOAD.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
            let staging = format!("{}/.uls-upload-{}-{sequence}",path.rsplit_once('/').map_or("",|(p,_)|p),std::process::id()).trim_start_matches('/').to_string();
            vfs.create(&staging,uls_vfs::Kind::File).await.map_err(|e|ErrorBody::internal(e.to_string()))?;
            let result: Result<(),ErrorBody> = async {
                use tokio::io::AsyncReadExt;
                let mut buf = vec![0; 1024 * 1024];
                let mut offset = 0;
                loop { let n = source.read(&mut buf).await.map_err(|_| ErrorBody::internal("local read failed"))?; if n == 0 { break; }
                    vfs.write(&staging,offset,&buf[..n]).await.map_err(|e| ErrorBody::internal(e.to_string()))?; offset += n as u64; }
                vfs.flush(&staging).await.map_err(|e| ErrorBody::internal(e.to_string()))?;
                vfs.rename(&staging,path,true).await.map_err(|e|ErrorBody::internal(e.to_string()))?;
                Ok(())
            }.await;
            if result.is_err() { let _ = vfs.remove(&staging).await; }
            result?;
        }
        Ok(json!({}))
    }

    // ---- mounting -----------------------------------------------------------------------

    async fn drive_name(self: &Arc<Self>, id: &str) -> Result<String, ErrorBody> {
        let find = |me: &Engine| me.known_drives.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|d| d.id == id).map(|d| d.name.clone());
        if let Some(n) = find(self) {
            return Ok(n);
        }
        if self.hub.has_session() {
            self.drives_list().await?;
            return find(self).ok_or_else(|| ErrorBody::new(code::NO_SUCH_DRIVE, "no such drive"));
        }
        if self.hub.has_dev() {
            return Ok(id.to_string());
        }
        Err(ErrorBody::new(code::UNAUTHORIZED, "not signed in"))
    }

    async fn mount_named(self: &Arc<Self>, id: &str, name: &str, mountpoint: Option<PathBuf>, read_only: bool) -> Result<(), ErrorBody> {
        if !valid_drive_id(id) {
            return Err(ErrorBody::new(code::NO_SUCH_DRIVE, "no such drive"));
        }
        if mountpoint.as_ref().is_some_and(|p| !p.is_absolute()) { return Err(ErrorBody::bad_request("mountpoint must be absolute")); }
        let read_only = read_only || self.adapter.access() == NeedAccess::Read;
        let adapter = if read_only && self.adapter.access() == NeedAccess::Write { crate::daemon::adapter(true) } else { self.adapter.clone() };
        let adapter_name = if read_only || !cfg!(feature = "smb") { "nfs" } else { "smb" };
        let path = {
            let mut m = self.mounts();
            if m.contains_key(id) {
                return Err(ErrorBody::new(code::ALREADY_MOUNTED, "drive is already mounted"));
            }
            let mut dir = safe_dir_name(name);
            if m.values().any(|e| e.path == self.cfg.mount_root.join(&dir)) {
                dir = format!("{dir} ({id})");
            }
            let path = mountpoint.unwrap_or_else(|| self.cfg.mount_root.join(dir));
            if m.values().any(|e| e.path == path) { return Err(ErrorBody::bad_request("mountpoint already in use")); }
            m.insert(id.to_string(), Entry { name: name.to_string(), read_only, adapter_name: adapter_name.into(), path: path.clone(), state: MountState::Mounting, handle: None, tasks: Vec::new(), vfs: None });
            path
        };
        match self.do_mount(id, name, &path, adapter, read_only).await {
            Ok(()) => {
                self.note_ok();
                Ok(())
            }
            Err(e) => {
                self.mounts().remove(id);
                // Only removes an empty directory we created.
                let _ = std::fs::remove_dir(&path);
                self.note_err(&e);
                Err(e)
            }
        }
    }

    async fn do_mount(self: &Arc<Self>, id: &str, name: &str, path: &PathBuf, adapter: Arc<dyn MountAdapter>, read_only: bool) -> Result<(), ErrorBody> {
        let client = self.build_client_access(id,adapter.access())?;
        let state_dir = self.cfg.state_path.parent().ok_or_else(|| ErrorBody::internal("state path has no parent"))?.join("drives").join(id);
        let _journal_guard = self.journal_lock.lock().await;
        let existing = self.journals.lock().unwrap_or_else(|e|e.into_inner()).get(id).cloned();
        let vfs = match existing { Some(vfs) => vfs, None => Vfs::open_with_budget(client.clone(), id, &state_dir, VfsOptions::default(),self.budget.clone()).await
            .map_err(|_| ErrorBody::internal("cannot open drive journal"))? };
        // Cached clean metadata may predate the persisted cursor after a restart.
        vfs.apply_remote(WatchEvent::Resync { head_seq: 0, last_ev: 0 }).await;
        let vfs_events = vfs.subscribe();
        std::fs::create_dir_all(path).map_err(|e| ErrorBody::internal(format!("cannot create {}: {}", path.display(), e.kind())))?;
        let handle = adapter.mount(MountRequest { drive_id: id.to_string(), drive_name: name.to_string(), mountpoint: path.clone(), client: client.clone(), vfs: vfs.clone() })
            .await
            .map_err(|e| e.0)?;

        if let Some(task) = self.journal_tasks.lock().unwrap_or_else(|e|e.into_inner()).remove(id) { task.abort(); }
        let tasks = vec![self.spawn_watch(id, client, vfs.clone()), self.spawn_vfs_events(id, vfs.clone(), vfs_events)];
        {
            let mut m = self.mounts();
            match m.get_mut(id) {
                Some(e) => {
                    e.state = MountState::Mounted;
                    e.handle = Some(handle);
                    e.tasks = tasks;
                    e.vfs = Some(vfs);
                }
                None => {
                    for t in tasks {
                        t.abort();
                    }
                }
            }
        }
        let rec = MountRecord { drive_id: id.to_string(), name: name.to_string(), mount_path: Some(path.display().to_string()), read_only };
        self.store.update(|p| {
            p.mounts.retain(|r| r.drive_id != rec.drive_id);
            p.mounts.push(rec);
        });
        Ok(())
    }

    fn cache(&self) -> Option<Arc<ShardCache>> {
        self.cache
            .get_or_init(|| {
                let dir = self.cfg.cache_dir.clone().or_else(uls_client::default_cache_dir)?;
                let cap = self.store.get().cache_cap_bytes.map(|c| c as u64).unwrap_or(uls_client::DEFAULT_CAP_BYTES);
                match ShardCache::open(dir, cap) {
                    Ok(c) => Some(Arc::new(c)),
                    Err(e) => {
                        tracing::warn!("shard cache disabled: {e}");
                        None
                    }
                }
            })
            .clone()
    }

    fn build_client(&self, id: &str) -> Result<Client, ErrorBody> { self.build_client_access(id,NeedAccess::Read) }

    fn build_client_access(&self, id: &str, access: NeedAccess) -> Result<Client, ErrorBody> {
        let mut b = Client::builder(self.cfg.default_endpoint.clone(), "")
            .token_provider(self.hub.token_provider(id, access))
            .whole_shard_on_partial(true);
        if let Some(cache) = self.cache() {
            b = b.cache(cache);
        }
        b.build().map_err(|_| ErrorBody::internal("cannot build data-plane client"))
    }

    fn spawn_watch(self: &Arc<Self>, id: &str, client: Client, vfs: Vfs) -> JoinHandle<()> {
        let ctx = WatchCtx {
            drive_id: id.to_string(), client, vfs,
            events: self.events.clone(), state: self.store.clone(),
        };
        tokio::spawn(watch::run(ctx))
    }

    fn mounted_vfs(&self) -> Vec<(String, Vfs)> {
        let mut all = self.journals.lock().unwrap_or_else(|e|e.into_inner()).clone();
        for (id,entry) in self.mounts().iter() { if let Some(vfs) = &entry.vfs { all.insert(id.clone(),vfs.clone()); } }
        all.into_iter().collect()
    }

    async fn pending_ops(&self) -> i64 {
        let mut count = 0i64;
        for (_, vfs) in self.mounted_vfs() {
            let pending = vfs.pending().await;
            count = count.saturating_add(i64::try_from(pending.files.saturating_add(pending.metadata_ops)).unwrap_or(i64::MAX));
        }
        count
    }

    async fn transfers(&self) -> Vec<Transfer> {
        let mut transfers = Vec::new();
        for (id, vfs) in self.mounted_vfs() {
            let pending = vfs.pending().await;
            if pending.files + pending.metadata_ops > 0 {
                transfers.push(upload_transfer(&id, pending.bytes, TransferStatus::Queued));
            }
        }
        transfers.sort_by(|a, b| a.drive_id.cmp(&b.drive_id));
        transfers
    }

    fn spawn_vfs_events(self: &Arc<Self>, id: &str, vfs: Vfs, mut rx: broadcast::Receiver<VfsEvent>) -> JoinHandle<()> {
        let me = self.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(VfsEvent::JournalFull) => {
                        me.set_state(State::Error, Some("journal_full".into()));
                        continue;
                    }
                    Ok(VfsEvent::Transfer { bytes, .. }) => {
                        me.emit(&Event::Transfer(upload_transfer(&id, bytes, TransferStatus::Done)));
                    }
                    Ok(VfsEvent::Conflict { path, copy }) => {
                        me.emit(&Event::Conflict(ConflictEvent { drive_id: id.clone(), path: slashed(&path), copy: slashed(&copy) }));
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
                let pending = vfs.pending().await;
                if pending.files + pending.metadata_ops > 0 {
                    me.emit(&Event::Transfer(upload_transfer(&id, pending.bytes, TransferStatus::Queued)));
                }
                let state = if me.pending_ops().await > 0 { State::Syncing } else { State::Idle };
                me.set_state(if pending.state == uls_vfs::SyncState::Offline { State::Offline } else { state }, None);
            }
        })
    }

    async fn unmount_inner(&self, id: &str, forget: bool) -> Result<(), ErrorBody> {
        let handle = {
            let mut m = self.mounts();
            match m.get_mut(id) {
                Some(e) if e.state == MountState::Mounted => {
                    e.state = MountState::Unmounting;
                    e.handle.clone()
                }
                _ => return Err(ErrorBody::new(code::NOT_MOUNTED, "drive is not mounted")),
            }
        };
        if let Some(h) = handle
            && let Err(e) = h.unmount().await
        {
            if let Some(en) = self.mounts().get_mut(id) {
                en.state = MountState::Mounted;
            }
            return Err(e.0);
        }
        self.journals.lock().unwrap_or_else(|e|e.into_inner()).remove(id);
        let removed = self.mounts().remove(id);
        if let Some(e) = removed {
            for t in &e.tasks {
                t.abort();
            }
            if let Some(vfs) = e.vfs
                && vfs.shutdown().await.is_err()
            {
                tracing::warn!(drive = %id, "drive journal retained with unpublished writes");
            }
            let _ = std::fs::remove_dir(&e.path);
        }
        if forget {
            self.store.update(|p| {
                p.mounts.retain(|r| r.drive_id != id);
                p.cursors.remove(id);
            });
        }
        Ok(())
    }
}

/// The Vfs uses paths without a leading slash; the protocol always has one.
fn slashed(p: &str) -> String {
    format!("/{}", p.trim_start_matches('/'))
}

// The VFS exposes a per-drive pending summary and completed batches, not per-file progress.
fn upload_transfer(id: &str, bytes: u64, status: TransferStatus) -> Transfer {
    let bytes = i64::try_from(bytes).unwrap_or(i64::MAX);
    Transfer {
        id: format!("{id}:upload"), drive_id: id.into(), path: "/".into(),
        direction: Direction::Upload,
        bytes_done: if status == TransferStatus::Done { bytes } else { 0 },
        bytes_total: bytes, status,
    }
}

/// Resolve ids, aliases and workspace/name forms without discarding unknown API fields.
pub fn resolve_in_orgs(orgs: &Value, query: &str, default: Option<&str>) -> Result<String, ErrorBody> {
    let mut found = std::collections::BTreeMap::new();
    let mut choices = Vec::new();
    let orgs = orgs.get("orgs").and_then(Value::as_array).or_else(||orgs.as_array()).ok_or_else(||ErrorBody::internal("invalid org list"))?;
    for org in orgs {
        let org_id = org["id"].as_str().unwrap_or(""); let org_name = org["name"].as_str().unwrap_or("");
        for d in org["drives"].as_array().into_iter().flatten() {
            if matches!(d["status"].as_str(),Some("deleted"|"provisioning_failed")) { continue; }
            let id = d["id"].as_str().unwrap_or(""); let name = d["name"].as_str().unwrap_or("");
            let alias = d["alias"].as_str(); let qualified = format!("{org_name}/{name}");
            choices.push(qualified.clone());
            if id.eq_ignore_ascii_case(query) || qualified.eq_ignore_ascii_case(query) || format!("{org_id}/{name}").eq_ignore_ascii_case(query)
                || (default.is_none_or(|w|w.eq_ignore_ascii_case(org_id)) && (name.eq_ignore_ascii_case(query) || alias.is_some_and(|a|a.eq_ignore_ascii_case(query)))) {
                found.insert(id.to_string(),qualified);
            }
        }
    }
    match found.len() { 1 => Ok(found.into_keys().next().unwrap()), 0 => Err(ErrorBody::new(code::NO_SUCH_DRIVE,format!("no drive matches; choices: {}",choices.join(", ")))), _ => Err(ErrorBody::bad_request(format!("ambiguous drive; choices: {}",found.into_values().collect::<Vec<_>>().join(", ")))) }
}
