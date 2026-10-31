//! The daemon's brain: owns auth, remembered mounts, per-drive watch tasks and the state
//! machine. The socket layer only parses lines and calls [`Engine::handle`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

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
    auth_change: tokio::sync::Mutex<()>,
    auth_revision: AtomicU64,
    restore_running: AtomicBool,
    can_retry_sign_in: AtomicBool,
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
    /// Short-lived `/orgs` answer for drive-name resolution. Every data CLI command resolves its
    /// drive first; refetching orgs each time cost one hosted round trip (1.9–3.2 s measured).
    orgs_cache: Mutex<Option<(std::time::Instant, String, Value)>>,
    /// One shared upload budget for every shard PUT this daemon makes.
    upload_limiter: Arc<uls_client::UploadLimiter>,
    /// Owning org's plan `(quotaBytes, usedBytes)` per drive id, from the last `/orgs` answer.
    capacity: Mutex<HashMap<String, (u64, u64)>>,
}

const ORGS_TTL: std::time::Duration = std::time::Duration::from_secs(30);

fn state_error(_: std::io::Error) -> ErrorBody { ErrorBody::internal("Could not save local state. Check free disk space and folder access, then retry.") }

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
        let upload_bps = store.get().upload_bandwidth_bps.unwrap_or(0);
        let budget = Arc::new(uls_vfs::JournalBudget::new(store.get().journal_cap_bytes.unwrap_or(10 * 1024 * 1024 * 1024)));
        Arc::new(Engine {
            budget,
            auth_change: tokio::sync::Mutex::new(()),
            auth_revision: AtomicU64::new(0),
            restore_running: AtomicBool::new(false),
            can_retry_sign_in: AtomicBool::new(false),
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
            orgs_cache: Mutex::new(None),
            upload_limiter: uls_client::UploadLimiter::new(upload_bps),
            capacity: Mutex::new(HashMap::new()),
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

    /// Startup must not wait for a blocking macOS Keychain authorization dialog.
    pub async fn start(self: &Arc<Self>) {
        if let Ok(token) = std::env::var("ULS_DEV_TOKEN") { self.hub.set_dev(None,Some(token)); self.note_ok(); }
        if self.store.get().auth.is_some() { let _ = self.begin_restore(); }
        else if self.hub.is_authenticated() { self.resume_background(); }
    }

    fn begin_restore(self: &Arc<Self>) -> Result<(), ErrorBody> {
        let remembered = self.store.get().auth.ok_or_else(|| ErrorBody::new(code::UNAUTHORIZED, "no saved sign-in; sign in again"))?;
        if self.hub.has_session() { return Err(ErrorBody::bad_request("already signed in")); }
        if self.restore_running.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err() {
            return Err(ErrorBody::bad_request("saved sign-in restoration is already in progress"));
        }
        self.can_retry_sign_in.store(false,Ordering::SeqCst);
        self.set_state(State::Error, Some("Restoring saved sign-in. Respond to the macOS Keychain prompt if one appears.".into()));
        let revision = self.auth_revision.load(Ordering::SeqCst);
        let hub = self.hub.clone();
        let task = tokio::task::spawn_blocking(move || hub.load_saved(&remembered.api_endpoint, &remembered.user));
        let me = self.clone();
        tokio::spawn(async move {
            let result = task.await;
            let _gate = me.auth_change.lock().await;
            me.restore_running.store(false,Ordering::SeqCst);
            if revision != me.auth_revision.load(Ordering::SeqCst) { return; }
            match result {
                Ok(Ok(Some(session))) => {
                    me.hub.install_saved(session.clone());
                    me.watch_session(session);
                    me.set_state(State::Idle,None);
                    me.resume_background();
                }
                Ok(Ok(None)) => me.set_state(State::SignedOut, Some("The saved sign-in is no longer available. Sign in again.".into())),
                _ => {
                    me.can_retry_sign_in.store(true,Ordering::SeqCst);
                    me.set_state(State::Error, Some("macOS could not read your saved sign-in. Retry saved sign-in and approve Keychain access if prompted, or sign in again.".into()));
                }
            }
        });
        Ok(())
    }

    fn resume_background(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            me.restore_mounts().await;
            for id in me.store.get().upload_drives { if let Err(e) = me.journal_for(&id).await { me.note_err(&e); } }
        });
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
                    let _gate = me.auth_change.lock().await;
                    if me.hub.session().is_some_and(|c| std::ptr::eq(Arc::as_ptr(&c), weak.as_ptr())) && me.store.get().auth.is_some() {
                        me.auth_revision.fetch_add(1,Ordering::SeqCst);
                        if let Err(error) = me.on_signed_out().await { me.set_state(State::Error,Some(error.message)); }
                    }
                }
            }
        });
    }

    async fn on_signed_out(self: &Arc<Self>) -> Result<(), ErrorBody> {
        self.unmount_all(true).await;
        self.stop_journals().await;
        let pins = self.store.get().pins;
        let saved = self.store.try_update(|p| {
            p.pins.clear();
            p.workspace = None;
            p.upload_drives.clear();
            p.auth = None;
            p.mounts.clear();
            p.cursors.clear();
        });
        if saved.is_ok() { self.release_pin_owners(&pins); }
        self.capacity.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.known_drives.lock().unwrap_or_else(|e| e.into_inner()).clear();
        *self.orgs_cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let st = if self.hub.has_dev() { State::Idle } else { State::SignedOut };
        self.can_retry_sign_in.store(false,Ordering::SeqCst);
        self.set_state(st, None);
        saved.map_err(state_error)
    }

    fn release_pin_owners(&self, pins: &[PinRecord]) {
        if let Some(cache) = self.cache() {
            for pin in pins {
                if let Err(error) = cache.set_pin(&format!("{}:{}", pin.drive_id, pin.path), Default::default()) {
                    tracing::warn!("could not release old account cache pin: {error}");
                }
            }
        }
    }

    /// SIGTERM path: unmount everything but keep the remembered mounts for the next start.
    pub async fn shutdown(&self) {
        self.auth_revision.fetch_add(1,Ordering::SeqCst);
        self.can_retry_sign_in.store(false,Ordering::SeqCst);
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
                to_val(Status { version: self.cfg.version.clone(), state, message, pending_ops: Some(self.pending_ops().await), upload_bandwidth_bps: Some(self.upload_limiter.bps()), can_retry_sign_in: self.can_retry_sign_in.load(Ordering::SeqCst).then_some(true) })
            }
            "drives.list" => to_val(json!({ "drives": self.drives_list().await? })),
            "files.search" => {
                let p: DriveParams = parse_params(req)?;
                let query = req.params["query"].as_str().unwrap_or("").trim();
                if query.chars().count()<3 || query.len()>256 { return Err(ErrorBody::bad_request("search needs 3–256 characters")); }
                let id = self.resolve_drive(&p.drive_id).await?;
                self.build_client_access(&id,NeedAccess::Read)?.search(&id,query,req.params["cursor"].as_str()).await
                    .map_err(client_err)
            }
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
                self.store.try_update(|s| s.workspace = Some(matches[0].id.clone())).map_err(state_error)?;
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
                    for item in vfs.pending_items().await {
                        // `bytes`/`driveId`/`path` are the original fields; the rest is additive.
                        pending.push(json!({"driveId":id,"path":slashed(&item.path),"bytes":item.bytes,
                            "phase":if item.uploading {"uploading"} else {"saved_locally"},
                            "bytesSent":item.bytes_sent,"bytesTotal":item.bytes}));
                    }
                }
                Ok(json!({"pending":pending,"journalBytes":self.budget.used(),"journalCapBytes":self.journal_cap()}))
            }
            "upload.queue" => self.queue_upload(req).await,
            "api.request" => self.api_request(req).await,
            "changes" => {
                let p: DriveParams = parse_params(req)?;
                let id = self.resolve_drive(&p.drive_id).await?;
                let cursor = req.params["after"].as_i64().unwrap_or(0);
                to_val(self.build_client(&id)?.changes(&id,cursor,1000).await.map_err(client_err)?)
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
            "auth.retryRestore" => {
                let _gate = self.auth_change.lock().await;
                if !self.can_retry_sign_in.load(Ordering::SeqCst) { return Err(ErrorBody::bad_request("saved sign-in retry is unavailable")); }
                self.begin_restore()?;
                Ok(json!({}))
            }
            "auth.signOut" => {
                self.auth_sign_out().await?;
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
        if p.upload_bandwidth_bps.is_some_and(|b| b > MAX_UPLOAD_BANDWIDTH_BPS) {
            return Err(ErrorBody::bad_request("uploadBandwidthBps is too large"));
        }
        if p.cache_cap_bytes.is_some_and(|c| c < 0) {
            return Err(ErrorBody::bad_request("cacheCapBytes must not be negative"));
        }
        if let Some(c) = p.cache_cap_bytes {
            self.store.try_update(|s| s.cache_cap_bytes = Some(c)).map_err(state_error)?;
            if let Some(cache) = self.cache() { cache.set_cap_bytes(c as u64); }
        }
        if let Some(c) = p.journal_cap_bytes {
            self.store.try_update(|s| s.journal_cap_bytes = Some(c)).map_err(state_error)?;
            self.budget.set_cap(c);
        }
        if let Some(bps) = p.upload_bandwidth_bps {
            if bps > MAX_UPLOAD_BANDWIDTH_BPS {
                return Err(ErrorBody::bad_request("uploadBandwidthBps is too large"));
            }
            self.store.try_update(|s| s.upload_bandwidth_bps = (bps > 0).then_some(bps)).map_err(state_error)?;
            self.upload_limiter.set_bps(bps);
        }
        if p.endpoint.is_some() || p.token.is_some() {
            self.hub.set_dev(p.endpoint, p.token);
            self.note_ok();
        }
        Ok(())
    }

    async fn auth_set(self: &Arc<Self>, p: AuthSetParams) -> Result<User, ErrorBody> {
        let _gate = self.auth_change.lock().await;
        let api = p.api_endpoint.trim_end_matches('/').to_string();
        let mut prepared = self.hub.prepare_set(p).await?;
        let user = prepared.user.clone();
        let previous = self.hub.session().and_then(|s|s.user()).map(|u|u.id)
            .or_else(||self.store.get().auth.map(|a|a.user.id));
        let changing = previous.is_some_and(|old|old != user.id);
        let pins = if changing { self.store.get().pins } else { Vec::new() };
        if changing {
            self.unmount_all(true).await;
            if !self.mounts().is_empty() { return Err(ErrorBody::internal("Could not disconnect the previous account's drives. Close files on those drives and retry sign-in.")); }
            self.stop_journals().await;
        }
        prepared.persist().await?;
        self.store.try_update(|s| {
            if changing { s.upload_drives.clear(); s.mounts.clear(); s.cursors.clear(); s.pins.clear(); s.workspace = None; }
            s.auth = Some(PersistedAuth {api_endpoint:api,user:user.clone()});
        }).map_err(state_error)?;
        if changing { self.release_pin_owners(&pins); self.capacity.lock().unwrap_or_else(|e| e.into_inner()).clear(); }
        self.auth_revision.fetch_add(1,Ordering::SeqCst);
        self.can_retry_sign_in.store(false,Ordering::SeqCst);
        let out = self.hub.install(prepared).await;
        self.watch_session(out.session);
        self.known_drives.lock().unwrap_or_else(|e| e.into_inner()).clear();
        *self.orgs_cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.set_state(State::Idle, None);
        self.resume_background();
        Ok(out.user)
    }

    async fn auth_sign_out(self: &Arc<Self>) -> Result<(), ErrorBody> {
        let _gate = self.auth_change.lock().await;
        self.auth_revision.fetch_add(1,Ordering::SeqCst);
        let cleanup = if let Some(s) = self.hub.session() {
            match s.sign_out().await {
                Err(uls_auth::AuthError::Store(_)) => Err(ErrorBody::internal("Signed out, but macOS did not allow removal of the saved credential. The saved item may remain in Keychain.")),
                Err(error) => { tracing::warn!("logout request failed: {error}"); Ok(()) }
                Ok(()) => Ok(()),
            }
        } else if let Some(saved) = self.store.get().auth {
            let secrets = self.cfg.secrets.clone();
            tokio::task::spawn_blocking(move || secrets.delete(&saved.user.id)).await
                .map_err(|_|ErrorBody::internal("Could not remove saved sign-in. Try again."))?
                .map_err(|_|ErrorBody::internal("macOS could not remove saved sign-in. Approve Keychain access if prompted, then try again."))
        } else { Ok(()) };
        self.hub.clear_dev();
        let saved = self.on_signed_out().await;
        let result = cleanup.and(saved);
        if let Err(error) = &result { self.set_state(State::SignedOut,Some(error.message.clone())); }
        result
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
        let workspace = self.store.get().workspace;
        // An exact drive ID or name in a fresh cached answer needs no network round trip.
        let user = self.hub.status().user.map(|u| u.id).unwrap_or_default();
        let cached = self.orgs_cache.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
            .filter(|(at, who, _)| at.elapsed() < ORGS_TTL && *who == user).map(|(_, _, v)| v.clone());
        if let Some(orgs) = cached && let Ok(id) = resolve_in_orgs(&orgs,query,workspace.as_deref()) { return Ok(id); }
        let request = Request { id:0,method:"api.request".into(),params:json!({"path":"/orgs"}) };
        let orgs = self.api_request(&request).await?;
        *self.orgs_cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((std::time::Instant::now(), user, orgs.clone()));
        resolve_in_orgs(&orgs,query,workspace.as_deref())
    }

    async fn api_request(&self, req: &Request) -> Result<Value, ErrorBody> {
        let method = req.params["method"].as_str().unwrap_or("GET");
        let path = req.params["path"].as_str().ok_or_else(|| ErrorBody::bad_request("path required"))?;
        if !allowed_api_request(method,path) {
            return Err(ErrorBody::bad_request("unsupported API path"));
        }
        // Any mutation (new drive, membership or fork) can change what `/orgs` returns.
        if method != "GET" { *self.orgs_cache.lock().unwrap_or_else(|e| e.into_inner()) = None; }
        let session = self.hub.session().ok_or_else(|| ErrorBody::new(code::UNAUTHORIZED, "not signed in"))?;
        let result = async {
            let token = session.access_token().await.map_err(crate::hub::map_auth_err)?;
            let client = Client::builder(session.api_endpoint(),token).build().map_err(|_|ErrorBody::internal("cannot build API client"))?;
            client.control_request(method,path,req.params.get("body")).await.map_err(client_err)
        }.await;
        // Transient failures (offline) never sign out: mounts and journals stay, state flips to
        // `offline`, and the next call that succeeds returns it to `idle`. Only an explicit
        // `AuthEvent::SignedOut` from the session unmounts.
        match &result {
            Ok(v) => {
                self.note_ok();
                if method == "GET" && path == "/orgs" { self.remember_capacity(v); }
            }
            Err(e) => self.note_err(e),
        }
        result
    }

    /// Record each drive's plan capacity from an `/orgs` answer and hand it to open journals.
    fn remember_capacity(&self, orgs: &Value) {
        let map = capacities_in_orgs(orgs);
        if map.is_empty() { return; }
        *self.capacity.lock().unwrap_or_else(|e| e.into_inner()) = map.clone();
        for (id, vfs) in self.mounted_vfs() {
            vfs.set_capacity(map.get(&id).copied());
        }
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
            self.store.try_update(|s| s.pins.retain(|r| r.drive_id != id || r.path != slashed(&path))).map_err(state_error)?;
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
                let manifest = client.manifest(&id, &path, stat.version_id.as_deref()).await.map_err(|_| ErrorBody::internal("cannot load manifest"))?;
                for shard in manifest.shards.into_iter().chain(manifest.xattrs.into_iter().flat_map(|x| x.into_values().flatten())) { shards.insert(shard.h, shard.n); }
            }
        }
        cache.set_pin(&owner, shards.keys().cloned().collect()).map_err(|_| ErrorBody::internal("cannot persist pin"))?;
        let record = PinRecord { drive_id: id.clone(), path: slashed(&path), shards: shards.clone() };
        self.store.try_update(|s| { s.pins.retain(|r| r.drive_id != id || r.path != record.path); s.pins.push(record); }).map_err(state_error)?;
        let bytes: u64 = shards.values().sum();
        let mut cached = 0u64;
        for (hash,n) in shards {
            client.fetch_shard_durable(&id, &hash).await.map_err(|_| ErrorBody::new(code::OFFLINE,"pin prefetch failed; retry to resume"))?;
            cached += n;
            self.emit(&Event::Pin(PinEvent {drive_id:id.clone(),path:slashed(&path),cached_bytes:cached,bytes}));
        }
        let mounted = self.mounts().get(&id).and_then(|entry| entry.vfs.clone());
        if let Some(vfs) = mounted {
            vfs.warm_metadata(&path).await.map_err(|_| ErrorBody::new(code::OFFLINE,"pin metadata prefetch failed; retry to resume"))?;
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
        self.store.try_update(|s| { if !s.upload_drives.contains(&id) { s.upload_drives.push(id.clone()); } }).map_err(state_error)?;
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
        let mut read_only = read_only || self.adapter.access() == NeedAccess::Read;
        if !read_only { read_only = self.hub.mount_access(id).await? == NeedAccess::Read; }
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
                if self.mounts().get(id).is_some_and(|entry|entry.state == MountState::Mounted) { return Err(e); }
                self.mounts().remove(id);
                // A failed preparation may leave a dead mount here; do not probe it again.
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
        let known = self.capacity.lock().unwrap_or_else(|e| e.into_inner()).get(id).copied();
        vfs.set_capacity(known);
        if known.is_none() && self.hub.has_session() {
            // Best effort, off the mount path: `api_request` records `/orgs` capacity for open journals.
            let me = self.clone();
            tokio::spawn(async move {
                let _ = me.api_request(&Request { id: 0, method: "api.request".into(), params: json!({"path":"/orgs"}) }).await;
            });
        }
        let vfs_events = vfs.subscribe();
        adapter.prepare_mountpoint(path).await.map_err(|error| error.0)?;
        let handle = adapter.mount(MountRequest { drive_id: id.to_string(), drive_name: name.to_string(), mountpoint: path.clone(), client: client.clone(), vfs: vfs.clone() })
            .await
            .map_err(|e| e.0)?;

        let rec = MountRecord { drive_id: id.to_string(), name: name.to_string(), mount_path: Some(path.display().to_string()), read_only };
        if let Err(error) = self.store.try_update(|p| {
            p.mounts.retain(|r|r.drive_id != rec.drive_id); p.mounts.push(rec);
        }) {
            // Preserve the real mount if the adapter cannot undo it; expose it for an explicit retry.
            if handle.unmount().await.is_err() {
                if let Some(entry) = self.mounts().get_mut(id) { entry.state = MountState::Mounted; entry.handle = Some(handle); entry.vfs = Some(vfs); }
            } else { let _ = vfs.shutdown().await; }
            return Err(state_error(error));
        }

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
            .upload_limiter(self.upload_limiter.clone())
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
                    Ok(VfsEvent::Transfer { bytes, files, .. }) => {
                        // One `done` per committed file ("Saved to cloud"), then the drive aggregate.
                        for (path, size) in files {
                            me.emit(&Event::Transfer(file_transfer(&id, &path, size)));
                        }
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
            self.store.try_update(|p| {
                p.mounts.retain(|r| r.drive_id != id);
                p.cursors.remove(id);
            }).map_err(state_error)?;
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

fn file_transfer(id: &str, path: &str, size: u64) -> Transfer {
    let size = i64::try_from(size).unwrap_or(i64::MAX);
    let path = slashed(path);
    Transfer { id: format!("{id}:upload:{path}"), drive_id: id.into(), path, direction: Direction::Upload,
        bytes_done: size, bytes_total: size, status: TransferStatus::Done }
}

/// Plan `(quotaBytes, usedBytes)` for every drive in an `/orgs` answer (orgs without both numbers are skipped).
pub fn capacities_in_orgs(orgs: &Value) -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    let list = orgs.get("orgs").and_then(Value::as_array).or_else(|| orgs.as_array());
    for org in list.into_iter().flatten() {
        let (Some(quota), Some(used)) = (org["quotaBytes"].as_u64(), org["usedBytes"].as_u64()) else { continue };
        for d in org["drives"].as_array().into_iter().flatten() {
            if let Some(id) = d["id"].as_str() { out.insert(id.to_string(), (quota, used)); }
        }
    }
    out
}

/// A data-plane or auth failure that means "cannot reach the servers" rather than "rejected".
fn client_err(e: uls_client::Error) -> ErrorBody {
    match &e {
        uls_client::Error::Transport(t) if t.is_connect() || t.is_timeout() || t.is_request() => ErrorBody::new(code::OFFLINE, "cannot reach the Unlispace servers"),
        uls_client::Error::Auth(m) if m.starts_with("offline") => ErrorBody::new(code::OFFLINE, "cannot reach the Unlispace servers"),
        _ => ErrorBody::bad_request(e.to_string()),
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

/// An explicit route/method allowlist prevents local callers forwarding a bearer to arbitrary paths.
pub fn allowed_api_request(method: &str, path: &str) -> bool {
    let parts: Vec<_> = path.split('/').skip(1).collect();
    if !path.starts_with('/') || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')) { return false; }
    match parts.as_slice() {
        ["orgs"] | ["client-config"] | ["me","access"] => method == "GET",
        ["keys"] => matches!(method,"GET"|"POST"),
        ["keys",_] => method == "DELETE",
        ["drives",_,"fork"] => method == "POST",
        ["orgs",_,"drives"] => method == "POST",
        ["orgs",_,"members"] | ["orgs",_,"billing"] => method == "GET",
        ["orgs",_,"invites"] => method == "POST",
        ["orgs",_,"members",_] => matches!(method,"PATCH"|"DELETE"),
        ["orgs",_,"invites",_] => method == "DELETE",
        ["orgs",_,"billing","portal"] => method == "POST",
        _ => false,
    }
}
