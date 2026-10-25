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
use crate::mount::{MountAdapter, MountHandle, MountRequest};
use crate::protocol::*;
use crate::state::{MountRecord, PersistedAuth, StateStore};
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
    path: PathBuf,
    state: MountState,
    handle: Option<Arc<dyn MountHandle>>,
    tasks: Vec<JoinHandle<()>>,
    vfs: Option<Vfs>,
}

pub struct Engine {
    cfg: EngineConfig,
    hub: Arc<AuthHub>,
    store: Arc<StateStore>,
    adapter: Arc<dyn MountAdapter>,
    events: broadcast::Sender<String>,
    mounts: Mutex<HashMap<String, Entry>>,
    status: Mutex<(State, Option<String>)>,
    known_drives: Mutex<Vec<DriveSummary>>,
    cache: OnceLock<Option<Arc<ShardCache>>>,
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
        Arc::new(Engine {
            cfg,
            hub,
            store,
            adapter,
            events,
            mounts: Mutex::new(HashMap::new()),
            status: Mutex::new((State::SignedOut, None)),
            known_drives: Mutex::new(Vec::new()),
            cache: OnceLock::new(),
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
        if self.hub.has_session() {
            let me = self.clone();
            tokio::spawn(async move { me.restore_mounts().await });
        }
    }

    async fn restore_mounts(self: &Arc<Self>) {
        for rec in self.store.get().mounts {
            if self.mounts().contains_key(&rec.drive_id) {
                continue;
            }
            if let Err(e) = self.mount_named(&rec.drive_id, &rec.name).await {
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
        self.store.update(|p| {
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
            "status" => {
                let (state, message) = self.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
                to_val(Status { version: self.cfg.version.clone(), state, message, pending_ops: Some(self.pending_ops().await) })
            }
            "drives.list" => to_val(json!({ "drives": self.drives_list().await? })),
            "drive.mount" => {
                let p: DriveParams = parse_params(req)?;
                self.mount(&p.drive_id).await?;
                Ok(json!({}))
            }
            "drive.unmount" => {
                let p: DriveParams = parse_params(req)?;
                self.unmount_inner(&p.drive_id, true).await?;
                Ok(json!({}))
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
            self.store.update(|s| {
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

    async fn mount(self: &Arc<Self>, id: &str) -> Result<(), ErrorBody> {
        if !valid_drive_id(id) {
            return Err(ErrorBody::new(code::NO_SUCH_DRIVE, "no such drive"));
        }
        if self.mounts().contains_key(id) {
            return Err(ErrorBody::new(code::ALREADY_MOUNTED, "drive is already mounted"));
        }
        let name = self.drive_name(id).await?;
        self.mount_named(id, &name).await
    }

    async fn mount_named(self: &Arc<Self>, id: &str, name: &str) -> Result<(), ErrorBody> {
        if !valid_drive_id(id) {
            return Err(ErrorBody::new(code::NO_SUCH_DRIVE, "no such drive"));
        }
        let path = {
            let mut m = self.mounts();
            if m.contains_key(id) {
                return Err(ErrorBody::new(code::ALREADY_MOUNTED, "drive is already mounted"));
            }
            let mut dir = safe_dir_name(name);
            if m.values().any(|e| e.path == self.cfg.mount_root.join(&dir)) {
                dir = format!("{dir} ({id})");
            }
            let path = self.cfg.mount_root.join(dir);
            m.insert(id.to_string(), Entry { name: name.to_string(), path: path.clone(), state: MountState::Mounting, handle: None, tasks: Vec::new(), vfs: None });
            path
        };
        match self.do_mount(id, name, &path).await {
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

    async fn do_mount(self: &Arc<Self>, id: &str, name: &str, path: &PathBuf) -> Result<(), ErrorBody> {
        let client = self.build_client(id)?;
        let state_dir = self.cfg.state_path.parent().ok_or_else(|| ErrorBody::internal("state path has no parent"))?.join("drives").join(id);
        let vfs = Vfs::open(client.clone(), id, &state_dir, VfsOptions::default()).await
            .map_err(|_| ErrorBody::internal("cannot open drive journal"))?;
        // Cached clean metadata may predate the persisted cursor after a restart.
        vfs.apply_remote(WatchEvent::Resync { head_seq: 0, last_ev: 0 }).await;
        let vfs_events = vfs.subscribe();
        std::fs::create_dir_all(path).map_err(|e| ErrorBody::internal(format!("cannot create {}: {}", path.display(), e.kind())))?;
        let handle = self
            .adapter
            .mount(MountRequest { drive_id: id.to_string(), drive_name: name.to_string(), mountpoint: path.clone(), client: client.clone(), vfs: vfs.clone() })
            .await
            .map_err(|e| e.0)?;

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
        let rec = MountRecord { drive_id: id.to_string(), name: name.to_string(), mount_path: Some(path.display().to_string()) };
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

    fn build_client(&self, id: &str) -> Result<Client, ErrorBody> {
        let mut b = Client::builder(self.cfg.default_endpoint.clone(), "")
            .token_provider(self.hub.token_provider(id, self.adapter.access()))
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
        self.mounts().iter().filter_map(|(id, entry)| entry.vfs.clone().map(|vfs| (id.clone(), vfs))).collect()
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
