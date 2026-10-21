//! Per-terminal control access.
//!
//! Every terminal carries two independent settings that only the user can
//! change from its Access panel: how much a controlling terminal may do to it
//! (`exposure`: off, read, or read and write), and whether processes inside it
//! may control other terminals at all (`controller`). Both default to off.
//!
//! A controlling process proves which terminal it runs in the same way access
//! requests do: the control socket reads the peer's kernel-reported pid, and
//! that process must be a live descendant of the claimed terminal's shell.
//! There is no token to leak and no special terminal kind.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    fmt::Write as _,
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use thiserror::Error;
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::{Mutex, oneshot},
};
use uuid::Uuid;

use crate::{
    access::current_process_start_ticks,
    history::{
        AgentTranscriptKind, AgentTranscriptPage, DEFAULT_SCROLLBACK_BYTES,
        DEFAULT_TRANSCRIPT_RECORDS, TerminalScrollbackPage,
    },
    terminal::{
        CreateTerminal, RenameTerminal, TerminalInfo, TerminalStatus, is_terminal_descendant,
    },
    workspace::{WorkspaceBackend, WorkspaceError},
};

pub const CONTROL_SOCKET_NAME: &str = "terminal-control.sock";
pub const CONTROL_SOCKET_ENV: &str = "TERM_SERVER_CONTROL_SOCKET";
const SETTINGS_FILE_NAME: &str = "terminal-control.json";
const SETTINGS_SCHEMA_VERSION: u8 = 1;
/// Left behind by the singleton Supervisor this module replaced.
const LEGACY_CREDENTIALS_FILE_NAME: &str = "supervisor-credentials.json";
const MAX_CONTROL_REQUEST_BYTES: u64 = 128 * 1024;
const MAX_CONTROL_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const CONTROL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TAIL_BYTES: usize = 64 * 1024;
const MAX_ACTIVITY_PER_TERMINAL: usize = 50;
const MAX_ACTIVITY_PREVIEW_CHARS: usize = 80;
const MAX_AGENT_LABEL_BYTES: usize = 64;
/// A listing can briefly omit the terminals of a draining broker that stopped
/// answering, so a missing terminal keeps its settings for this long.
const PRUNE_GRACE: Duration = Duration::from_secs(10 * 60);
const BROWSER_VIEW_LEASE: Duration = Duration::from_secs(5);
const BROWSER_COMMAND_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_BROWSER_VIEWS: usize = 32;
const MAX_BROWSER_RESOURCES: usize = 256;
const MAX_BROWSER_TITLE_BYTES: usize = 512;
const MAX_BROWSER_LABEL_BYTES: usize = 512;
const MAX_BROWSER_PATH_BYTES: usize = 8 * 1024;
/// Accept errors such as descriptor exhaustion are transient, so the control
/// socket waits and retries instead of giving up on the listener.
const ACCEPT_BACKOFF_MIN: Duration = Duration::from_millis(50);
const ACCEPT_BACKOFF_MAX: Duration = Duration::from_secs(1);

#[derive(Debug, Error)]
pub enum ControlError {
    #[error("terminal control is not authorized for this process")]
    Unauthorized,
    #[error(
        "terminal control is off for this terminal; the user can turn on \"Control other terminals\" in its Access panel"
    )]
    ControlDisabled,
    #[error("terminal not found or not shared with controlling terminals")]
    NotShared,
    #[error(
        "this terminal is shared read-only; the user can allow read & write in its Access panel"
    )]
    ReadOnly,
    /// A refusal relayed from the server to the CLI.
    #[error("{0}")]
    Denied(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Workspace(#[from] WorkspaceError),
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

impl ControlError {
    /// Whether the user's settings, rather than a fault, refused the request.
    fn denied(&self) -> bool {
        matches!(
            self,
            Self::Unauthorized
                | Self::ControlDisabled
                | Self::NotShared
                | Self::ReadOnly
                | Self::Denied(_)
        )
    }
}

/// What controlling terminals may do to a terminal.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum TerminalExposure {
    #[default]
    Off,
    Read,
    Write,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalControlSettings {
    #[serde(default)]
    pub exposure: TerminalExposure,
    #[serde(default)]
    pub controller: bool,
    /// The controlling terminal that created this one, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<Uuid>,
}

impl TerminalControlSettings {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateTerminalControl {
    #[serde(default)]
    pub exposure: Option<TerminalExposure>,
    #[serde(default)]
    pub controller: Option<bool>,
}

/// One action a controlling terminal took on a terminal.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalControlActivity {
    pub at: u64,
    pub controller_id: Uuid,
    pub controller_name: String,
    pub agent: String,
    pub action: String,
}

/// Settings plus the most recent read, attached to every terminal listing.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalControlSummary {
    #[serde(flatten)]
    pub settings: TerminalControlSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_read_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_read_by: Option<String>,
}

/// The summary plus the recent write activity, for the Access panel.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalControlDetail {
    #[serde(flatten)]
    pub summary: TerminalControlSummary,
    pub activity: Vec<TerminalControlActivity>,
}

#[derive(Debug, Default)]
struct Observations {
    last_read_at: Option<u64>,
    last_read_by: Option<String>,
    activity: VecDeque<TerminalControlActivity>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    schema_version: u8,
    #[serde(default)]
    terminals: HashMap<Uuid, TerminalControlSettings>,
}

/// A terminal as a controlling terminal sees it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlledTerminal {
    #[serde(flatten)]
    pub terminal: TerminalInfo,
    pub access: TerminalExposure,
    /// The calling terminal itself, listed so an agent knows its own id.
    #[serde(rename = "self")]
    pub is_self: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTerminalPane {
    pub terminal_id: Uuid,
    pub label: String,
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserResourceTab {
    pub path: String,
    pub name: String,
    pub dirty: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabSnapshot {
    pub title: String,
    pub focused: bool,
    pub visible: bool,
    pub terminal_panes: Vec<BrowserTerminalPane>,
    pub resources: Vec<BrowserResourceTab>,
    pub settings_open: bool,
    pub settings_active: bool,
}

impl BrowserTabSnapshot {
    fn validate(&self) -> Result<(), ControlError> {
        if self.title.len() > MAX_BROWSER_TITLE_BYTES {
            return Err(ControlError::Invalid("browser title is too long".into()));
        }
        if self.terminal_panes.len() > 8 {
            return Err(ControlError::Invalid(
                "browser view has more than eight terminal panes".into(),
            ));
        }
        if self.resources.len() > MAX_BROWSER_RESOURCES {
            return Err(ControlError::Invalid(
                "browser view has too many resource tabs".into(),
            ));
        }
        let mut terminal_ids = HashSet::with_capacity(self.terminal_panes.len());
        for pane in &self.terminal_panes {
            if pane.label.len() > MAX_BROWSER_LABEL_BYTES {
                return Err(ControlError::Invalid(
                    "terminal pane label is too long".into(),
                ));
            }
            if !terminal_ids.insert(pane.terminal_id) {
                return Err(ControlError::Invalid(
                    "browser view contains a duplicate terminal pane".into(),
                ));
            }
        }
        let mut resource_paths = HashSet::with_capacity(self.resources.len());
        for resource in &self.resources {
            if resource.name.len() > MAX_BROWSER_LABEL_BYTES
                || resource.path.len() > MAX_BROWSER_PATH_BYTES
            {
                return Err(ControlError::Invalid(
                    "browser resource metadata is too long".into(),
                ));
            }
            if !resource_paths.insert(resource.path.as_str()) {
                return Err(ControlError::Invalid(
                    "browser view contains a duplicate resource tab".into(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BrowserTabCommand {
    CloseTerminalPane {
        id: Uuid,
        #[serde(rename = "terminalId")]
        terminal_id: Uuid,
    },
    CloseResource {
        id: Uuid,
        path: String,
    },
    CloseSettings {
        id: Uuid,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabHeartbeat {
    pub commands: Vec<BrowserTabCommand>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct BrowserTabCommandAck {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabInfo {
    pub id: String,
    pub view_id: Uuid,
    pub view_title: String,
    pub kind: BrowserTabKind,
    pub label: String,
    pub active: bool,
    pub focused: bool,
    pub visible: bool,
    pub dirty: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BrowserTabKind {
    Terminal,
    Resource,
    Settings,
}

#[derive(Debug, Clone)]
enum BrowserTabTarget {
    Terminal { terminal_id: Uuid },
    Resource { path: String },
    Settings,
}

struct PendingBrowserCommand {
    command: BrowserTabCommand,
    completion: oneshot::Sender<BrowserTabCommandAck>,
}

struct BrowserViewRecord {
    snapshot: BrowserTabSnapshot,
    updated_at: Instant,
    pending: HashMap<Uuid, PendingBrowserCommand>,
}

#[derive(Default)]
struct BrowserTabRegistry {
    views: Mutex<HashMap<Uuid, BrowserViewRecord>>,
}

impl BrowserTabRegistry {
    async fn heartbeat(
        &self,
        view_id: Uuid,
        snapshot: BrowserTabSnapshot,
    ) -> Result<BrowserTabHeartbeat, ControlError> {
        snapshot.validate()?;
        let mut views = self.views.lock().await;
        Self::prune(&mut views);
        if !views.contains_key(&view_id) && views.len() >= MAX_BROWSER_VIEWS {
            return Err(ControlError::Invalid(
                "too many browser views are connected".into(),
            ));
        }
        let now = Instant::now();
        let view = match views.entry(view_id) {
            std::collections::hash_map::Entry::Occupied(entry) => {
                let view = entry.into_mut();
                view.snapshot = snapshot;
                view.updated_at = now;
                view
            }
            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(BrowserViewRecord {
                snapshot,
                updated_at: now,
                pending: HashMap::new(),
            }),
        };
        Ok(BrowserTabHeartbeat {
            commands: view
                .pending
                .values()
                .map(|pending| pending.command.clone())
                .collect(),
        })
    }

    async fn acknowledge(
        &self,
        view_id: Uuid,
        command_id: Uuid,
        ack: BrowserTabCommandAck,
    ) -> Result<(), ControlError> {
        let completion = {
            let mut views = self.views.lock().await;
            let view = views.get_mut(&view_id).ok_or_else(|| {
                ControlError::Invalid("browser view is no longer connected".into())
            })?;
            view.pending
                .remove(&command_id)
                .map(|pending| pending.completion)
                .ok_or_else(|| {
                    ControlError::Invalid("browser command is no longer pending".into())
                })?
        };
        let _ = completion.send(ack);
        Ok(())
    }

    async fn list(&self) -> Vec<BrowserTabInfo> {
        let mut views = self.views.lock().await;
        Self::prune(&mut views);
        views
            .iter()
            .flat_map(|(view_id, view)| tab_infos(*view_id, &view.snapshot))
            .collect()
    }

    async fn close(&self, tab_id: &str) -> Result<BrowserTabCommandAck, ControlError> {
        let (view_id, command_id, receiver) = {
            let mut views = self.views.lock().await;
            Self::prune(&mut views);
            let (view_id, target) = views
                .iter()
                .find_map(|(view_id, view)| {
                    tab_targets(*view_id, &view.snapshot)
                        .into_iter()
                        .find(|(id, _)| id == tab_id)
                        .map(|(_, target)| (*view_id, target))
                })
                .ok_or_else(|| ControlError::Invalid("tab is no longer open".into()))?;
            if let BrowserTabTarget::Resource { path } = &target {
                let dirty = views
                    .get(&view_id)
                    .and_then(|view| {
                        view.snapshot
                            .resources
                            .iter()
                            .find(|resource| resource.path == *path)
                    })
                    .is_some_and(|resource| resource.dirty);
                if dirty {
                    return Err(ControlError::Invalid(
                        "dirty resource tabs cannot be closed from another terminal".into(),
                    ));
                }
            }
            let command_id = Uuid::new_v4();
            let command = match target {
                BrowserTabTarget::Terminal { terminal_id } => {
                    BrowserTabCommand::CloseTerminalPane {
                        id: command_id,
                        terminal_id,
                    }
                }
                BrowserTabTarget::Resource { path } => BrowserTabCommand::CloseResource {
                    id: command_id,
                    path,
                },
                BrowserTabTarget::Settings => BrowserTabCommand::CloseSettings { id: command_id },
            };
            let (completion, receiver) = oneshot::channel();
            views
                .get_mut(&view_id)
                .expect("selected browser view exists")
                .pending
                .insert(
                    command_id,
                    PendingBrowserCommand {
                        command,
                        completion,
                    },
                );
            (view_id, command_id, receiver)
        };

        match tokio::time::timeout(BROWSER_COMMAND_TIMEOUT, receiver).await {
            Ok(Ok(ack)) => Ok(ack),
            Ok(Err(_)) => Err(ControlError::Unavailable(
                "browser tab command was cancelled".into(),
            )),
            Err(_) => {
                if let Some(view) = self.views.lock().await.get_mut(&view_id) {
                    view.pending.remove(&command_id);
                }
                Err(ControlError::Unavailable(
                    "browser tab did not acknowledge the close command".into(),
                ))
            }
        }
    }

    fn prune(views: &mut HashMap<Uuid, BrowserViewRecord>) {
        let now = Instant::now();
        views.retain(|_, view| now.duration_since(view.updated_at) <= BROWSER_VIEW_LEASE);
    }
}

fn stable_tab_id(view_id: Uuid, kind: &str, target: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(view_id.as_bytes());
    hash.update([0]);
    hash.update(kind.as_bytes());
    hash.update([0]);
    hash.update(target.as_bytes());
    URL_SAFE_NO_PAD.encode(&hash.finalize()[..12])
}

fn tab_targets(view_id: Uuid, snapshot: &BrowserTabSnapshot) -> Vec<(String, BrowserTabTarget)> {
    let mut targets = Vec::with_capacity(
        snapshot.terminal_panes.len()
            + snapshot.resources.len()
            + usize::from(snapshot.settings_open),
    );
    targets.extend(snapshot.terminal_panes.iter().map(|pane| {
        (
            stable_tab_id(view_id, "terminal", &pane.terminal_id.to_string()),
            BrowserTabTarget::Terminal {
                terminal_id: pane.terminal_id,
            },
        )
    }));
    targets.extend(snapshot.resources.iter().map(|resource| {
        (
            stable_tab_id(view_id, "resource", &resource.path),
            BrowserTabTarget::Resource {
                path: resource.path.clone(),
            },
        )
    }));
    if snapshot.settings_open {
        targets.push((
            stable_tab_id(view_id, "settings", "settings"),
            BrowserTabTarget::Settings,
        ));
    }
    targets
}

fn tab_infos(view_id: Uuid, snapshot: &BrowserTabSnapshot) -> Vec<BrowserTabInfo> {
    let mut tabs = Vec::with_capacity(
        snapshot.terminal_panes.len()
            + snapshot.resources.len()
            + usize::from(snapshot.settings_open),
    );
    tabs.extend(snapshot.terminal_panes.iter().map(|pane| BrowserTabInfo {
        id: stable_tab_id(view_id, "terminal", &pane.terminal_id.to_string()),
        view_id,
        view_title: snapshot.title.clone(),
        kind: BrowserTabKind::Terminal,
        label: pane.label.clone(),
        active: pane.active,
        focused: snapshot.focused,
        visible: snapshot.visible,
        dirty: false,
        terminal_id: Some(pane.terminal_id),
        path: None,
    }));
    tabs.extend(snapshot.resources.iter().map(|resource| BrowserTabInfo {
        id: stable_tab_id(view_id, "resource", &resource.path),
        view_id,
        view_title: snapshot.title.clone(),
        kind: BrowserTabKind::Resource,
        label: resource.name.clone(),
        active: resource.active,
        focused: snapshot.focused,
        visible: snapshot.visible,
        dirty: resource.dirty,
        terminal_id: None,
        path: Some(resource.path.clone()),
    }));
    if snapshot.settings_open {
        tabs.push(BrowserTabInfo {
            id: stable_tab_id(view_id, "settings", "settings"),
            view_id,
            view_title: snapshot.title.clone(),
            kind: BrowserTabKind::Settings,
            label: "Settings".into(),
            active: snapshot.settings_active,
            focused: snapshot.focused,
            visible: snapshot.visible,
            dirty: false,
            terminal_id: None,
            path: None,
        });
    }
    tabs
}

/// Doubles the accept backoff, up to its ceiling.
fn next_accept_backoff(current: Duration) -> Duration {
    (current * 2).min(ACCEPT_BACKOFF_MAX)
}

/// The bound control socket. Binding it is what makes a server the single
/// instance for a data directory, so it is claimed before anything else in
/// that directory is opened: a second server that is going to be rejected must
/// not first reconfigure the running one's session broker.
#[derive(Debug)]
pub struct ControlSocket {
    listener: UnixListener,
}

impl ControlSocket {
    pub async fn claim(data_directory: &Path) -> Result<Self, ControlError> {
        fs::create_dir_all(data_directory).await?;
        let data_directory = fs::canonicalize(data_directory).await?;
        Self::bind(data_directory.join(CONTROL_SOCKET_NAME)).await
    }

    async fn bind(socket_path: PathBuf) -> Result<Self, ControlError> {
        if let Some(parent) = socket_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let listener = match UnixListener::bind(&socket_path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                if UnixStream::connect(&socket_path).await.is_ok() {
                    return Err(ControlError::Unavailable(
                        "a terminal control service is already running".into(),
                    ));
                }
                fs::remove_file(&socket_path).await?;
                UnixListener::bind(&socket_path)?
            }
            Err(error) => return Err(error.into()),
        };
        set_private_permissions(&socket_path)?;
        Ok(Self { listener })
    }
}

/// Checks that `pid` started at `start_ticks` descends from `shell_pid`.
type IdentityCheck = fn(u32, u32, u64) -> bool;

pub struct TerminalControlService {
    workspace: WorkspaceBackend,
    socket_path: PathBuf,
    settings_path: PathBuf,
    settings: parking_lot::RwLock<HashMap<Uuid, TerminalControlSettings>>,
    observations: parking_lot::Mutex<HashMap<Uuid, Observations>>,
    missing_since: parking_lot::Mutex<HashMap<Uuid, Instant>>,
    prune_grace: Duration,
    browser_tabs: BrowserTabRegistry,
    identity_check: IdentityCheck,
}

impl TerminalControlService {
    pub async fn new(
        workspace: WorkspaceBackend,
        data_directory: &Path,
    ) -> Result<Arc<Self>, ControlError> {
        fs::create_dir_all(data_directory).await?;
        let data_directory = fs::canonicalize(data_directory).await?;
        match fs::remove_file(data_directory.join(LEGACY_CREDENTIALS_FILE_NAME)).await {
            Ok(()) => tracing::info!("removed the retired Supervisor credentials"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(%error, "unable to remove the retired Supervisor credentials");
            }
        }
        let settings_path = data_directory.join(SETTINGS_FILE_NAME);
        let settings = load_settings(&settings_path);
        Ok(Arc::new(Self {
            workspace,
            socket_path: data_directory.join(CONTROL_SOCKET_NAME),
            settings_path,
            settings: parking_lot::RwLock::new(settings),
            observations: parking_lot::Mutex::new(HashMap::new()),
            missing_since: parking_lot::Mutex::new(HashMap::new()),
            prune_grace: PRUNE_GRACE,
            browser_tabs: BrowserTabRegistry::default(),
            identity_check: is_terminal_descendant,
        }))
    }

    pub async fn start(self: &Arc<Self>) -> Result<(), ControlError> {
        let socket = ControlSocket::bind(self.socket_path.clone()).await?;
        self.serve(socket);
        Ok(())
    }

    /// Serves the control socket claimed earlier by [`ControlSocket::claim`].
    pub fn serve(self: &Arc<Self>, socket: ControlSocket) {
        let service = self.clone();
        let listener = socket.listener;
        tokio::spawn(async move {
            let mut backoff = ACCEPT_BACKOFF_MIN;
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        backoff = ACCEPT_BACKOFF_MIN;
                        let service = service.clone();
                        tokio::spawn(async move {
                            if let Err(error) = service.handle_connection(stream).await {
                                tracing::debug!(%error, "terminal control connection ended");
                            }
                        });
                    }
                    Err(error) => {
                        // Descriptor exhaustion and aborted connections are
                        // transient. Dropping the listener here would refuse
                        // every later CLI call until the server is restarted,
                        // so back off and keep accepting.
                        tracing::warn!(
                            %error,
                            backoff_ms = backoff.as_millis() as u64,
                            "terminal control socket failed to accept a connection"
                        );
                        tokio::time::sleep(backoff).await;
                        backoff = next_accept_backoff(backoff);
                    }
                }
            }
        });
    }

    pub fn settings(&self, terminal_id: Uuid) -> TerminalControlSettings {
        self.settings
            .read()
            .get(&terminal_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn summary(&self, terminal_id: Uuid) -> TerminalControlSummary {
        let settings = self.settings(terminal_id);
        let observations = self.observations.lock();
        let observed = observations.get(&terminal_id);
        TerminalControlSummary {
            settings,
            last_read_at: observed.and_then(|observed| observed.last_read_at),
            last_read_by: observed.and_then(|observed| observed.last_read_by.clone()),
        }
    }

    pub fn detail(&self, terminal_id: Uuid) -> TerminalControlDetail {
        let summary = self.summary(terminal_id);
        let activity = self
            .observations
            .lock()
            .get(&terminal_id)
            .map(|observed| observed.activity.iter().rev().cloned().collect())
            .unwrap_or_default();
        TerminalControlDetail { summary, activity }
    }

    /// Applies a change the user made in the Access panel.
    pub fn update(
        &self,
        terminal_id: Uuid,
        update: UpdateTerminalControl,
    ) -> Result<TerminalControlSummary, ControlError> {
        self.modify(terminal_id, |settings| {
            if let Some(exposure) = update.exposure {
                settings.exposure = exposure;
            }
            if let Some(controller) = update.controller {
                settings.controller = controller;
            }
        })?;
        Ok(self.summary(terminal_id))
    }

    /// Drops everything recorded for a terminal that no longer exists.
    pub fn forget(&self, terminal_id: Uuid) -> Result<(), ControlError> {
        self.observations.lock().remove(&terminal_id);
        let mut settings = self.settings.write();
        if !settings.contains_key(&terminal_id) {
            return Ok(());
        }
        let mut updated = settings.clone();
        updated.remove(&terminal_id);
        persist_settings(&self.settings_path, &updated)?;
        *settings = updated;
        Ok(())
    }

    /// Forgets terminals that have been missing from listings for longer
    /// than the grace period.
    pub fn retain(&self, terminals: &[TerminalInfo]) {
        let live = terminals
            .iter()
            .map(|terminal| terminal.id)
            .collect::<HashSet<_>>();
        let now = Instant::now();
        // Each lock is taken on its own so no two are ever held together here.
        let mut known = self.settings.read().keys().copied().collect::<Vec<_>>();
        known.extend(self.observations.lock().keys().copied());
        known.retain(|id| !live.contains(id));
        let expired = {
            let mut missing = self.missing_since.lock();
            missing.retain(|id, _| !live.contains(id));
            known
                .into_iter()
                .filter(|id| {
                    now.duration_since(*missing.entry(*id).or_insert(now)) >= self.prune_grace
                })
                .collect::<HashSet<_>>()
        };
        if expired.is_empty() {
            return;
        }
        self.observations
            .lock()
            .retain(|id, _| !expired.contains(id));
        let pruned = {
            let mut settings = self.settings.write();
            if settings.keys().all(|id| !expired.contains(id)) {
                true
            } else {
                let mut updated = settings.clone();
                updated.retain(|id, _| !expired.contains(id));
                match persist_settings(&self.settings_path, &updated) {
                    Ok(()) => {
                        *settings = updated;
                        true
                    }
                    Err(error) => {
                        tracing::warn!(%error, "unable to prune terminal control settings");
                        false
                    }
                }
            }
        };
        if pruned {
            self.missing_since
                .lock()
                .retain(|id, _| !expired.contains(id));
        }
    }

    fn modify(
        &self,
        terminal_id: Uuid,
        change: impl FnOnce(&mut TerminalControlSettings),
    ) -> Result<(), ControlError> {
        let mut settings = self.settings.write();
        let mut next = settings.get(&terminal_id).cloned().unwrap_or_default();
        change(&mut next);
        if settings.get(&terminal_id).cloned().unwrap_or_default() == next {
            return Ok(());
        }
        let mut updated = settings.clone();
        if next.is_default() {
            updated.remove(&terminal_id);
        } else {
            updated.insert(terminal_id, next);
        }
        persist_settings(&self.settings_path, &updated)?;
        *settings = updated;
        Ok(())
    }

    pub async fn browser_heartbeat(
        &self,
        view_id: Uuid,
        snapshot: BrowserTabSnapshot,
    ) -> Result<BrowserTabHeartbeat, ControlError> {
        self.browser_tabs.heartbeat(view_id, snapshot).await
    }

    pub async fn acknowledge_browser_command(
        &self,
        view_id: Uuid,
        command_id: Uuid,
        ack: BrowserTabCommandAck,
    ) -> Result<(), ControlError> {
        self.browser_tabs
            .acknowledge(view_id, command_id, ack)
            .await
    }

    /// Resolves the calling terminal from the peer's kernel-reported pid and
    /// returns it with the full terminal listing.
    async fn authorize(
        &self,
        peer_pid: Option<u32>,
        request: &ControlRequest,
    ) -> Result<(TerminalInfo, Vec<TerminalInfo>), ControlError> {
        let terminals = self.workspace.list().await?;
        let caller = terminals
            .iter()
            .find(|terminal| {
                terminal.id == request.terminal_id && terminal.status == TerminalStatus::Running
            })
            .cloned()
            .ok_or(ControlError::Unauthorized)?;
        let shell_pid = caller.pid.ok_or(ControlError::Unauthorized)?;
        if peer_pid != Some(request.pid)
            || request.pid == shell_pid
            || !(self.identity_check)(shell_pid, request.pid, request.start_ticks)
        {
            return Err(ControlError::Unauthorized);
        }
        if !self.settings(caller.id).controller {
            return Err(ControlError::ControlDisabled);
        }
        Ok((caller, terminals))
    }

    async fn handle_connection(&self, mut stream: UnixStream) -> Result<(), ControlError> {
        let peer_pid = stream
            .peer_cred()
            .ok()
            .and_then(|credentials| credentials.pid())
            .and_then(|pid| u32::try_from(pid).ok());
        let mut bytes = Vec::new();
        tokio::time::timeout(
            CONTROL_REQUEST_TIMEOUT,
            (&mut stream)
                .take(MAX_CONTROL_REQUEST_BYTES)
                .read_to_end(&mut bytes),
        )
        .await
        .map_err(|_| ControlError::Unavailable("terminal control request timed out".into()))??;
        let request: ControlRequest = serde_json::from_slice(&bytes)?;
        let outcome = match self.authorize(peer_pid, &request).await {
            Ok((caller, terminals)) => {
                let agent = agent_label(&request.agent);
                self.execute(request.command, &caller, &agent, &terminals)
                    .await
            }
            Err(error) => Err(error),
        };
        let response = match outcome {
            Ok(result) => ControlResponse {
                ok: true,
                denied: false,
                result: Some(result),
                error: None,
            },
            Err(error) => ControlResponse {
                ok: false,
                denied: error.denied(),
                result: None,
                error: Some(error.to_string()),
            },
        };
        let mut encoded = serde_json::to_vec(&response)?;
        if encoded.len() > MAX_CONTROL_RESPONSE_BYTES as usize {
            encoded = serde_json::to_vec(&ControlResponse {
                ok: false,
                denied: false,
                result: None,
                error: Some("terminal control response exceeds the 2 MiB limit".into()),
            })?;
        }
        tokio::time::timeout(CONTROL_RESPONSE_TIMEOUT, async {
            stream.write_all(&encoded).await?;
            stream.shutdown().await
        })
        .await
        .map_err(|_| {
            ControlError::Unavailable("terminal control response write timed out".into())
        })??;
        Ok(())
    }

    /// Finds a target the caller may act on at `needed` level. Hidden
    /// terminals are indistinguishable from missing ones.
    fn target<'a>(
        &self,
        terminals: &'a [TerminalInfo],
        terminal_id: Uuid,
        needed: TerminalExposure,
    ) -> Result<&'a TerminalInfo, ControlError> {
        let terminal = terminals
            .iter()
            .find(|terminal| terminal.id == terminal_id)
            .ok_or(ControlError::NotShared)?;
        match self.settings(terminal_id).exposure {
            TerminalExposure::Off => Err(ControlError::NotShared),
            exposure if exposure < needed => Err(ControlError::ReadOnly),
            _ => Ok(terminal),
        }
    }

    fn record_read(&self, target: Uuid, caller: &TerminalInfo, agent: &str) {
        let mut observations = self.observations.lock();
        let observed = observations.entry(target).or_default();
        observed.last_read_at = Some(current_millis());
        observed.last_read_by = Some(format!("{agent} in {}", caller.name));
    }

    fn record_action(&self, target: Uuid, caller: &TerminalInfo, agent: &str, action: String) {
        let mut observations = self.observations.lock();
        let observed = observations.entry(target).or_default();
        if observed.activity.len() >= MAX_ACTIVITY_PER_TERMINAL {
            observed.activity.pop_front();
        }
        observed.activity.push_back(TerminalControlActivity {
            at: current_millis(),
            controller_id: caller.id,
            controller_name: caller.name.clone(),
            agent: agent.to_owned(),
            action,
        });
    }

    async fn execute(
        &self,
        command: ControlCommand,
        caller: &TerminalInfo,
        agent: &str,
        terminals: &[TerminalInfo],
    ) -> Result<Value, ControlError> {
        use TerminalExposure::{Read, Write};
        match command {
            ControlCommand::Terminals => {
                self.retain(terminals);
                let visible = terminals
                    .iter()
                    .filter_map(|terminal| {
                        let access = self.settings(terminal.id).exposure;
                        let is_self = terminal.id == caller.id;
                        (is_self || access != TerminalExposure::Off).then(|| ControlledTerminal {
                            terminal: terminal.clone(),
                            access,
                            is_self,
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(serde_json::to_value(visible)?)
            }
            ControlCommand::Screen {
                terminal_id,
                tail_bytes,
            } => {
                self.target(terminals, terminal_id, Read)?;
                let screen = self
                    .workspace
                    .screen(terminal_id, tail_bytes.min(MAX_TAIL_BYTES))
                    .await?;
                self.record_read(terminal_id, caller, agent);
                Ok(serde_json::to_value(screen)?)
            }
            ControlCommand::Scrollback {
                terminal_id,
                from_sequence,
                limit_bytes,
            } => {
                self.target(terminals, terminal_id, Read)?;
                let page = self
                    .workspace
                    .scrollback(terminal_id, from_sequence, limit_bytes)
                    .await?;
                self.record_read(terminal_id, caller, agent);
                Ok(serde_json::to_value(page)?)
            }
            ControlCommand::Transcript {
                terminal_id,
                from_sequence,
                limit,
                kinds,
            } => {
                self.target(terminals, terminal_id, Read)?;
                let page = self
                    .workspace
                    .transcript(terminal_id, from_sequence, limit, &kinds)
                    .await?;
                self.record_read(terminal_id, caller, agent);
                Ok(serde_json::to_value(page)?)
            }
            ControlCommand::Processes { terminal_id } => {
                self.target(terminals, terminal_id, Read)?;
                let processes = self.workspace.process_inspector(terminal_id).await?;
                self.record_read(terminal_id, caller, agent);
                Ok(serde_json::to_value(processes)?)
            }
            ControlCommand::Send { terminal_id, data } => {
                self.target(terminals, terminal_id, Write)?;
                let preview = input_preview(&data);
                self.workspace.write(terminal_id, data).await?;
                self.record_action(terminal_id, caller, agent, format!("typed {preview}"));
                Ok(serde_json::json!({ "sent": true }))
            }
            ControlCommand::Rename { terminal_id, name } => {
                let previous = self.target(terminals, terminal_id, Write)?.name.clone();
                let renamed = self
                    .workspace
                    .rename(terminal_id, RenameTerminal { path: name })
                    .await?;
                self.record_action(
                    terminal_id,
                    caller,
                    agent,
                    format!("renamed it from {previous} to {}", renamed.name),
                );
                Ok(serde_json::to_value(renamed)?)
            }
            ControlCommand::Create { name, cwd, shell } => {
                let created = self
                    .workspace
                    .create(CreateTerminal {
                        path: name,
                        cwd,
                        shell,
                        clone_from: None,
                    })
                    .await?;
                if let Err(error) = self.modify(created.id, |settings| {
                    settings.exposure = TerminalExposure::Write;
                    settings.created_by = Some(caller.id);
                }) {
                    let _ = self.workspace.remove(created.id).await;
                    return Err(error);
                }
                self.record_action(created.id, caller, agent, "opened this terminal".into());
                Ok(serde_json::to_value(ControlledTerminal {
                    terminal: created,
                    access: TerminalExposure::Write,
                    is_self: false,
                })?)
            }
            ControlCommand::Kill { terminal_id } => {
                self.target(terminals, terminal_id, Write)?;
                self.workspace.remove(terminal_id).await?;
                self.forget(terminal_id)?;
                Ok(serde_json::json!({ "killed": true }))
            }
            ControlCommand::Terminate {
                terminal_id,
                process_id,
            } => {
                self.target(terminals, terminal_id, Write)?;
                self.workspace
                    .terminate_process(terminal_id, &process_id)
                    .await?;
                self.record_action(
                    terminal_id,
                    caller,
                    agent,
                    format!("terminated process {process_id}"),
                );
                Ok(serde_json::json!({ "terminated": true }))
            }
            ControlCommand::Tabs => {
                let tabs = self
                    .browser_tabs
                    .list()
                    .await
                    .into_iter()
                    .filter(|tab| {
                        tab.terminal_id.is_none_or(|terminal_id| {
                            self.target(terminals, terminal_id, Read).is_ok()
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(serde_json::to_value(tabs)?)
            }
            ControlCommand::CloseTab { tab_id } => {
                let tab = self
                    .browser_tabs
                    .list()
                    .await
                    .into_iter()
                    .find(|tab| tab.id == tab_id)
                    .ok_or_else(|| ControlError::Invalid("tab is no longer open".into()))?;
                if let Some(terminal_id) = tab.terminal_id {
                    self.target(terminals, terminal_id, Write)?;
                }
                let ack = self.browser_tabs.close(&tab_id).await?;
                if !ack.ok {
                    return Err(ControlError::Invalid(
                        ack.error
                            .unwrap_or_else(|| "browser rejected the close command".into()),
                    ));
                }
                if let Some(terminal_id) = tab.terminal_id {
                    self.record_action(terminal_id, caller, agent, "closed its pane".into());
                }
                Ok(serde_json::json!({ "closed": true }))
            }
        }
    }
}

/// A short, control-free rendering of input for the activity log.
fn input_preview(data: &str) -> String {
    let mut preview = String::new();
    for (index, character) in data.chars().enumerate() {
        if index >= MAX_ACTIVITY_PREVIEW_CHARS {
            preview.push('…');
            break;
        }
        match character {
            '\r' | '\n' => preview.push('⏎'),
            '\t' => preview.push('⇥'),
            '\x1b' => preview.push_str("Esc"),
            '\x03' => preview.push_str("Ctrl-C"),
            '\x04' => preview.push_str("Ctrl-D"),
            '\x1a' => preview.push_str("Ctrl-Z"),
            character if character.is_control() => preview.push('·'),
            character => preview.push(character),
        }
    }
    format!("\"{preview}\"")
}

fn agent_label(agent: &str) -> String {
    let agent = agent.trim();
    if agent.is_empty() {
        return "agent".to_owned();
    }
    let mut label = agent
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    while label.len() > MAX_AGENT_LABEL_BYTES {
        label.pop();
    }
    label
}

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn load_settings(path: &Path) -> HashMap<Uuid, TerminalControlSettings> {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<StoredSettings>(&bytes) {
            Ok(stored) if stored.schema_version == SETTINGS_SCHEMA_VERSION => stored.terminals,
            Ok(stored) => {
                tracing::warn!(
                    path = %path.display(),
                    schema_version = stored.schema_version,
                    "ignoring terminal control settings with an unsupported schema"
                );
                HashMap::new()
            }
            Err(error) => {
                tracing::warn!(
                    %error,
                    path = %path.display(),
                    "ignoring invalid terminal control settings"
                );
                HashMap::new()
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => HashMap::new(),
        Err(error) => {
            tracing::warn!(
                %error,
                path = %path.display(),
                "unable to load terminal control settings"
            );
            HashMap::new()
        }
    }
}

fn persist_settings(
    path: &Path,
    settings: &HashMap<Uuid, TerminalControlSettings>,
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("terminal control settings path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let stored = StoredSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        terminals: settings.clone(),
    };
    let mut temporary = NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut temporary, &stored).map_err(io::Error::other)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    std::fs::File::open(parent)?.sync_all()
}

fn set_private_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlRequest {
    terminal_id: Uuid,
    pid: u32,
    start_ticks: u64,
    #[serde(default)]
    agent: String,
    command: ControlCommand,
}

#[derive(Debug, Deserialize, Serialize)]
struct ControlResponse {
    ok: bool,
    #[serde(default)]
    denied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "command", rename_all = "camelCase")]
enum ControlCommand {
    Terminals,
    Screen {
        terminal_id: Uuid,
        tail_bytes: usize,
    },
    Send {
        terminal_id: Uuid,
        data: String,
    },
    Scrollback {
        terminal_id: Uuid,
        from_sequence: Option<u64>,
        limit_bytes: usize,
    },
    Transcript {
        terminal_id: Uuid,
        from_sequence: Option<u64>,
        limit: usize,
        kinds: Vec<AgentTranscriptKind>,
    },
    Rename {
        terminal_id: Uuid,
        name: String,
    },
    Create {
        name: Option<String>,
        cwd: Option<PathBuf>,
        shell: Option<String>,
    },
    Kill {
        terminal_id: Uuid,
    },
    Processes {
        terminal_id: Uuid,
    },
    Terminate {
        terminal_id: Uuid,
        process_id: String,
    },
    Tabs,
    CloseTab {
        tab_id: String,
    },
}

/// `term-server access terminals`: read and drive the terminals the user
/// shared, from a terminal the user allowed to control them.
#[derive(Debug, Clone, Args)]
pub struct TerminalsCli {
    /// Agent acting, for attribution in the target terminal's Access panel.
    #[arg(long, global = true, default_value = "agent")]
    agent: String,
    #[command(subcommand)]
    command: TerminalsCliCommand,
}

#[derive(Debug, Clone, Subcommand)]
enum TerminalsCliCommand {
    /// List this terminal and every terminal shared with controlling terminals.
    List,
    /// Read one terminal's current rendered screen.
    Screen {
        terminal_id: Uuid,
        #[arg(long, default_value_t = 0)]
        tail_bytes: usize,
    },
    /// Read retained raw terminal output as clean text.
    Scrollback {
        terminal_id: Uuid,
        #[arg(long)]
        from_sequence: Option<u64>,
        #[arg(long, default_value_t = DEFAULT_SCROLLBACK_BYTES)]
        limit_bytes: usize,
        #[arg(long)]
        jsonl: bool,
    },
    /// Read the retained semantic thread for a detected agent.
    Transcript {
        terminal_id: Uuid,
        #[arg(long)]
        from_sequence: Option<u64>,
        #[arg(long, default_value_t = DEFAULT_TRANSCRIPT_RECORDS)]
        limit: usize,
        #[arg(long = "kind", value_parser = parse_transcript_kind)]
        kinds: Vec<AgentTranscriptKind>,
        #[arg(long)]
        jsonl: bool,
    },
    /// Inspect one terminal's descendant process tree.
    Processes { terminal_id: Uuid },
    /// Send text, single-character keys, or named keys to one terminal.
    Send {
        terminal_id: Uuid,
        #[arg(long)]
        text: Option<String>,
        #[arg(long = "key")]
        keys: Vec<String>,
        #[arg(long)]
        enter: bool,
    },
    /// Rename a terminal session.
    Rename { terminal_id: Uuid, name: String },
    /// Open a new terminal; it is shared read & write with controlling terminals.
    Create {
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        shell: Option<String>,
    },
    /// Permanently kill a terminal session.
    Kill { terminal_id: Uuid },
    /// Terminate one tracked descendant process.
    Terminate {
        terminal_id: Uuid,
        process_id: String,
    },
    /// List open terminal panes, resources, and Settings tabs.
    Tabs,
    /// Close one open tab without killing its terminal session.
    CloseTab {
        #[arg(allow_hyphen_values = true)]
        tab_id: String,
    },
}

#[derive(Debug, Clone, Copy)]
enum ControlOutput {
    Json,
    ScrollbackText,
    ScrollbackJsonl,
    TranscriptText,
    TranscriptJsonl,
}

impl TerminalsCliCommand {
    fn output(&self) -> ControlOutput {
        match self {
            Self::Scrollback { jsonl: true, .. } => ControlOutput::ScrollbackJsonl,
            Self::Scrollback { .. } => ControlOutput::ScrollbackText,
            Self::Transcript { jsonl: true, .. } => ControlOutput::TranscriptJsonl,
            Self::Transcript { .. } => ControlOutput::TranscriptText,
            _ => ControlOutput::Json,
        }
    }

    fn into_request(self) -> Result<ControlCommand, ControlError> {
        Ok(match self {
            Self::List => ControlCommand::Terminals,
            Self::Screen {
                terminal_id,
                tail_bytes,
            } => ControlCommand::Screen {
                terminal_id,
                tail_bytes,
            },
            Self::Scrollback {
                terminal_id,
                from_sequence,
                limit_bytes,
                jsonl: _,
            } => ControlCommand::Scrollback {
                terminal_id,
                from_sequence,
                limit_bytes,
            },
            Self::Transcript {
                terminal_id,
                from_sequence,
                limit,
                kinds,
                jsonl: _,
            } => ControlCommand::Transcript {
                terminal_id,
                from_sequence,
                limit,
                kinds,
            },
            Self::Processes { terminal_id } => ControlCommand::Processes { terminal_id },
            Self::Send {
                terminal_id,
                text,
                keys,
                enter,
            } => {
                let mut data = text.unwrap_or_default();
                for key in keys {
                    data.push_str(key_sequence(&key).ok_or_else(|| {
                        ControlError::Invalid(format!("unsupported terminal key: {key}"))
                    })?);
                }
                if enter {
                    data.push('\r');
                }
                if data.is_empty() {
                    return Err(ControlError::Invalid(
                        "send requires --text, --key, or --enter".into(),
                    ));
                }
                ControlCommand::Send { terminal_id, data }
            }
            Self::Rename { terminal_id, name } => ControlCommand::Rename { terminal_id, name },
            Self::Create { name, cwd, shell } => ControlCommand::Create { name, cwd, shell },
            Self::Kill { terminal_id } => ControlCommand::Kill { terminal_id },
            Self::Terminate {
                terminal_id,
                process_id,
            } => ControlCommand::Terminate {
                terminal_id,
                process_id,
            },
            Self::Tabs => ControlCommand::Tabs,
            Self::CloseTab { tab_id } => ControlCommand::CloseTab { tab_id },
        })
    }
}

/// Runs one `access terminals` command. Exit codes follow the other access
/// commands: 0 on success, 126 when the user's settings refuse it, 125 on
/// any other failure.
pub async fn run_cli(cli: TerminalsCli, terminal_id: Uuid, broker_socket: &Path) -> i32 {
    let output = cli.command.output();
    let outcome = async {
        let command = cli.command.into_request()?;
        let socket = env::var_os(CONTROL_SOCKET_ENV)
            .map(PathBuf::from)
            .or_else(|| {
                crate::broker::data_directory_for_socket(broker_socket)
                    .map(|directory| directory.join(CONTROL_SOCKET_NAME))
            })
            .ok_or_else(|| {
                ControlError::Unavailable("unable to locate the term-server control socket".into())
            })?;
        let request = ControlRequest {
            terminal_id,
            pid: std::process::id(),
            start_ticks: current_process_start_ticks()
                .map_err(|error| ControlError::Unavailable(error.to_string()))?,
            agent: cli.agent,
            command,
        };
        let result = send_control_request(&socket, &request).await?;
        print_result(output, result)
    }
    .await;
    match outcome {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("term-server access terminals: {error}");
            if error.denied() { 126 } else { 125 }
        }
    }
}

async fn send_control_request(
    socket: &Path,
    request: &ControlRequest,
) -> Result<Value, ControlError> {
    let mut stream = tokio::time::timeout(CONTROL_RESPONSE_TIMEOUT, UnixStream::connect(socket))
        .await
        .map_err(|_| ControlError::Unavailable("terminal control connection timed out".into()))?
        .map_err(|error| {
            ControlError::Unavailable(format!(
                "term-server is not reachable at {}: {error}",
                socket.display()
            ))
        })?;
    stream.write_all(&serde_json::to_vec(request)?).await?;
    stream.shutdown().await?;
    let mut bytes = Vec::new();
    tokio::time::timeout(
        CONTROL_RESPONSE_TIMEOUT,
        stream
            .take(MAX_CONTROL_RESPONSE_BYTES)
            .read_to_end(&mut bytes),
    )
    .await
    .map_err(|_| ControlError::Unavailable("terminal control response timed out".into()))??;
    let response: ControlResponse = serde_json::from_slice(&bytes)?;
    if response.ok {
        return Ok(response.result.unwrap_or(Value::Null));
    }
    let message = response
        .error
        .unwrap_or_else(|| "terminal control command failed".into());
    if response.denied {
        // The server already chose the user-facing wording; keep the exit code.
        return Err(ControlError::Denied(message));
    }
    Err(ControlError::Unavailable(message))
}

fn parse_transcript_kind(value: &str) -> Result<AgentTranscriptKind, String> {
    AgentTranscriptKind::parse(value).ok_or_else(|| {
        format!(
            "unknown transcript record kind {value:?}; expected message, tool_start, tool_result, status, compaction, summary, or marker"
        )
    })
}

fn print_result(output: ControlOutput, result: Value) -> Result<(), ControlError> {
    match output {
        ControlOutput::Json => println!("{}", serde_json::to_string_pretty(&result)?),
        ControlOutput::ScrollbackText => {
            let page = serde_json::from_value::<TerminalScrollbackPage>(result)?;
            print!("{}", scrollback_text(&page));
        }
        ControlOutput::ScrollbackJsonl => {
            let page = serde_json::from_value::<TerminalScrollbackPage>(result)?;
            println!("{}", scrollback_jsonl(&page)?);
        }
        ControlOutput::TranscriptText => {
            let page = serde_json::from_value::<AgentTranscriptPage>(result)?;
            print!("{}", transcript_text(&page));
        }
        ControlOutput::TranscriptJsonl => {
            let page = serde_json::from_value::<AgentTranscriptPage>(result)?;
            print!("{}", transcript_jsonl(&page)?);
        }
    }
    Ok(())
}

fn scrollback_text(page: &TerminalScrollbackPage) -> String {
    let mut output = format!(
        "# scrollback terminal={} earliest={} start={} end={} latest={} hasMore={} truncated={}\n",
        page.terminal_id,
        page.earliest_sequence,
        page.start_sequence,
        page.end_sequence,
        page.latest_sequence,
        page.has_more,
        page.truncated,
    );
    output.push_str(&page.text);
    if !output.ends_with('\n') {
        output.push('\n');
    }
    output
}

fn scrollback_jsonl(page: &TerminalScrollbackPage) -> Result<String, serde_json::Error> {
    let mut value = serde_json::to_value(page)?;
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "recordType".to_owned(),
            Value::String("scrollback".to_owned()),
        );
    }
    serde_json::to_string(&value)
}

fn transcript_text(page: &AgentTranscriptPage) -> String {
    let mut output = format!(
        "# transcript terminal={} earliest={} start={} next={} latest={} hasMore={} truncated={}\n",
        page.terminal_id,
        page.earliest_sequence,
        page.start_sequence,
        page.next_sequence,
        page.latest_sequence,
        page.has_more,
        page.truncated,
    );
    for record in &page.records {
        let label = record.role.as_deref().unwrap_or(record.kind.as_str());
        let name = record
            .name
            .as_deref()
            .map(|name| format!(" {name}"))
            .unwrap_or_default();
        let truncated = if record.truncated { " truncated" } else { "" };
        let _ = writeln!(
            output,
            "\n[{} @ {}] {}{}{}",
            record.sequence, record.timestamp, label, name, truncated
        );
        if let Some(text) = record.text.as_deref() {
            output.push_str(text);
            if !output.ends_with('\n') {
                output.push('\n');
            }
        }
    }
    output
}

fn transcript_jsonl(page: &AgentTranscriptPage) -> Result<String, serde_json::Error> {
    let mut output = String::new();
    let metadata = serde_json::json!({
        "recordType": "page",
        "terminalId": page.terminal_id,
        "earliestSequence": page.earliest_sequence,
        "startSequence": page.start_sequence,
        "nextSequence": page.next_sequence,
        "latestSequence": page.latest_sequence,
        "truncated": page.truncated,
        "hasMore": page.has_more,
    });
    let _ = writeln!(output, "{}", serde_json::to_string(&metadata)?);
    for record in &page.records {
        let mut value = serde_json::to_value(record)?;
        if let Some(object) = value.as_object_mut() {
            object.insert("recordType".to_owned(), Value::String("entry".to_owned()));
        }
        let _ = writeln!(output, "{}", serde_json::to_string(&value)?);
    }
    Ok(output)
}

const NAMED_KEY_SEQUENCES: [(&str, &str); 11] = [
    ("enter", "\r"),
    ("tab", "\t"),
    ("escape", "\x1b"),
    ("esc", "\x1b"),
    ("ctrl-c", "\x03"),
    ("ctrl-d", "\x04"),
    ("ctrl-z", "\x1a"),
    ("up", "\x1b[A"),
    ("down", "\x1b[B"),
    ("right", "\x1b[C"),
    ("left", "\x1b[D"),
];

fn key_sequence(key: &str) -> Option<&str> {
    for &(name, sequence) in &NAMED_KEY_SEQUENCES {
        if key.eq_ignore_ascii_case(name) {
            return Some(sequence);
        }
    }

    let mut characters = key.chars();
    characters.next()?;
    characters.next().is_none().then_some(key)
}

#[cfg(test)]
mod tests {
    use std::{os::unix::fs::PermissionsExt as _, sync::Arc};

    use clap::Parser;
    use tempfile::TempDir;

    use super::*;
    use crate::{fili::FiliService, terminal::TerminalManager};

    #[derive(Parser)]
    struct TestCli {
        #[command(flatten)]
        terminals: TerminalsCli,
    }

    fn parse_cli(arguments: &[&str]) -> Result<TerminalsCli, clap::Error> {
        TestCli::try_parse_from(std::iter::once("terminals").chain(arguments.iter().copied()))
            .map(|cli| cli.terminals)
    }

    fn trust_any_process(_shell_pid: u32, _pid: u32, _start_ticks: u64) -> bool {
        true
    }

    /// A service whose identity check accepts the test process, so requests
    /// over the real socket exercise everything but the /proc ancestry walk.
    async fn test_service() -> (
        TempDir,
        Arc<TerminalControlService>,
        WorkspaceBackend,
        Arc<TerminalManager>,
    ) {
        let (directory, mut service, workspace, terminals) = strict_service().await;
        Arc::get_mut(&mut service).unwrap().identity_check = trust_any_process;
        service.start().await.unwrap();
        (directory, service, workspace, terminals)
    }

    async fn strict_service() -> (
        TempDir,
        Arc<TerminalControlService>,
        WorkspaceBackend,
        Arc<TerminalManager>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let terminals = Arc::new(TerminalManager::new(
            Some("/bin/sh".to_owned()),
            1024 * 1024,
        ));
        let workspace = WorkspaceBackend::local(
            terminals.clone(),
            Arc::new(FiliService::new(directory.path())),
        );
        let service = TerminalControlService::new(workspace.clone(), directory.path())
            .await
            .unwrap();
        (directory, service, workspace, terminals)
    }

    async fn shell(workspace: &WorkspaceBackend, name: &str) -> TerminalInfo {
        workspace
            .create(CreateTerminal {
                path: Some(name.into()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".into()),
                clone_from: None,
            })
            .await
            .unwrap()
    }

    fn share(service: &TerminalControlService, terminal_id: Uuid, exposure: TerminalExposure) {
        service
            .update(
                terminal_id,
                UpdateTerminalControl {
                    exposure: Some(exposure),
                    controller: None,
                },
            )
            .unwrap();
    }

    fn allow_control(service: &TerminalControlService, terminal_id: Uuid) {
        service
            .update(
                terminal_id,
                UpdateTerminalControl {
                    exposure: None,
                    controller: Some(true),
                },
            )
            .unwrap();
    }

    async fn control(
        service: &TerminalControlService,
        caller: Uuid,
        command: ControlCommand,
    ) -> ControlResponse {
        control_as(service, caller, std::process::id(), command).await
    }

    async fn control_as(
        service: &TerminalControlService,
        caller: Uuid,
        pid: u32,
        command: ControlCommand,
    ) -> ControlResponse {
        let mut stream = UnixStream::connect(&service.socket_path).await.unwrap();
        stream
            .write_all(
                &serde_json::to_vec(&ControlRequest {
                    terminal_id: caller,
                    pid,
                    start_ticks: 0,
                    agent: "test-agent".into(),
                    command,
                })
                .unwrap(),
            )
            .await
            .unwrap();
        stream.shutdown().await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn wait_for_screen(workspace: &WorkspaceBackend, terminal_id: Uuid, marker: &str) {
        for _ in 0..50 {
            if workspace
                .screen(terminal_id, 0)
                .await
                .unwrap()
                .screen
                .contains(marker)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("terminal screen never contained {marker}");
    }

    #[tokio::test]
    async fn every_terminal_starts_hidden_and_unable_to_control() {
        let (_directory, service, workspace, _terminals) = test_service().await;
        let caller = shell(&workspace, "caller").await;
        let target = shell(&workspace, "target").await;
        assert_eq!(
            service.settings(target.id),
            TerminalControlSettings::default()
        );

        let refused = control(&service, caller.id, ControlCommand::Terminals).await;
        assert!(!refused.ok);
        assert!(refused.denied);
        assert_eq!(
            refused.error.as_deref(),
            Some(ControlError::ControlDisabled.to_string().as_str())
        );

        allow_control(&service, caller.id);
        let listed = control(&service, caller.id, ControlCommand::Terminals).await;
        let listed =
            serde_json::from_value::<Vec<ControlledTerminal>>(listed.result.unwrap()).unwrap();
        assert_eq!(listed.len(), 1, "only the caller itself is visible");
        assert!(listed[0].is_self);
        assert_eq!(listed[0].terminal.id, caller.id);

        let hidden = control(
            &service,
            caller.id,
            ControlCommand::Screen {
                terminal_id: target.id,
                tail_bytes: 0,
            },
        )
        .await;
        assert!(hidden.denied);
        assert_eq!(
            hidden.error.as_deref(),
            Some(ControlError::NotShared.to_string().as_str())
        );
        let missing = control(
            &service,
            caller.id,
            ControlCommand::Screen {
                terminal_id: Uuid::new_v4(),
                tail_bytes: 0,
            },
        )
        .await;
        assert_eq!(missing.error, hidden.error, "hidden and missing look alike");
        workspace.shutdown().await;
    }

    #[tokio::test]
    async fn read_exposure_allows_reading_but_not_input() {
        let (_directory, service, workspace, _terminals) = test_service().await;
        let caller = shell(&workspace, "reader").await;
        let target = shell(&workspace, "read-target").await;
        allow_control(&service, caller.id);
        share(&service, target.id, TerminalExposure::Read);
        workspace
            .write(target.id, "printf 'READ-MARKER\\n'\r".into())
            .await
            .unwrap();
        wait_for_screen(&workspace, target.id, "READ-MARKER").await;

        let listed = control(&service, caller.id, ControlCommand::Terminals).await;
        let listed =
            serde_json::from_value::<Vec<ControlledTerminal>>(listed.result.unwrap()).unwrap();
        let shared = listed
            .iter()
            .find(|terminal| terminal.terminal.id == target.id)
            .unwrap();
        assert_eq!(shared.access, TerminalExposure::Read);
        assert!(!shared.is_self);

        let screen = control(
            &service,
            caller.id,
            ControlCommand::Screen {
                terminal_id: target.id,
                tail_bytes: 0,
            },
        )
        .await;
        assert!(screen.ok);
        assert!(
            screen.result.unwrap()["screen"]
                .as_str()
                .unwrap()
                .contains("READ-MARKER")
        );
        let summary = service.summary(target.id);
        assert!(summary.last_read_at.is_some());
        assert_eq!(
            summary.last_read_by.as_deref(),
            Some("test-agent in reader")
        );

        let refused = control(
            &service,
            caller.id,
            ControlCommand::Send {
                terminal_id: target.id,
                data: "echo SHOULD-NOT-ARRIVE\r".into(),
            },
        )
        .await;
        assert!(refused.denied);
        assert_eq!(
            refused.error.as_deref(),
            Some(ControlError::ReadOnly.to_string().as_str())
        );
        assert!(service.detail(target.id).activity.is_empty());
        workspace.shutdown().await;
    }

    #[tokio::test]
    async fn write_exposure_delivers_input_and_records_it() {
        let (_directory, service, workspace, _terminals) = test_service().await;
        let caller = shell(&workspace, "writer").await;
        let target = shell(&workspace, "write-target").await;
        allow_control(&service, caller.id);
        share(&service, target.id, TerminalExposure::Write);

        let delivered = control(
            &service,
            caller.id,
            ControlCommand::Send {
                terminal_id: target.id,
                data: "printf 'CONTROL-DELIVERY\\n'\r".into(),
            },
        )
        .await;
        assert!(delivered.ok, "{:?}", delivered.error);
        wait_for_screen(&workspace, target.id, "CONTROL-DELIVERY").await;
        let activity = service.detail(target.id).activity;
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].controller_id, caller.id);
        assert_eq!(activity[0].controller_name, "writer");
        assert_eq!(activity[0].agent, "test-agent");
        assert_eq!(
            activity[0].action,
            "typed \"printf 'CONTROL-DELIVERY\\n'⏎\""
        );

        workspace.write(target.id, "exit\r".into()).await.unwrap();
        for _ in 0..50 {
            if workspace.list().await.unwrap().iter().any(|terminal| {
                terminal.id == target.id && terminal.status == TerminalStatus::Exited
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let rejected = control(
            &service,
            caller.id,
            ControlCommand::Send {
                terminal_id: target.id,
                data: "echo SHOULD-NOT-BE-SENT\r".into(),
            },
        )
        .await;
        assert!(!rejected.ok);
        assert!(!rejected.denied);
        assert_eq!(rejected.error.as_deref(), Some("terminal is not running"));
        workspace.shutdown().await;
    }

    #[tokio::test]
    async fn created_terminals_are_writable_and_attributed_but_cannot_control() {
        let (_directory, service, workspace, _terminals) = test_service().await;
        let caller = shell(&workspace, "spawner").await;
        allow_control(&service, caller.id);
        let created = control(
            &service,
            caller.id,
            ControlCommand::Create {
                name: Some("spawned".into()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".into()),
            },
        )
        .await;
        assert!(created.ok, "{:?}", created.error);
        let created =
            serde_json::from_value::<ControlledTerminal>(created.result.unwrap()).unwrap();
        assert_eq!(created.access, TerminalExposure::Write);
        let settings = service.settings(created.terminal.id);
        assert_eq!(settings.exposure, TerminalExposure::Write);
        assert_eq!(settings.created_by, Some(caller.id));
        assert!(!settings.controller);
        assert_eq!(
            service.detail(created.terminal.id).activity[0].action,
            "opened this terminal"
        );

        let nested = control(&service, created.terminal.id, ControlCommand::Terminals).await;
        assert!(nested.denied, "a spawned terminal must not inherit control");

        let killed = control(
            &service,
            caller.id,
            ControlCommand::Kill {
                terminal_id: created.terminal.id,
            },
        )
        .await;
        assert!(killed.ok);
        assert_eq!(
            service.settings(created.terminal.id),
            TerminalControlSettings::default()
        );
        workspace.shutdown().await;
    }

    #[tokio::test]
    async fn requests_must_come_from_the_claimed_terminal() {
        let (_directory, service, workspace, _terminals) = test_service().await;
        let caller = shell(&workspace, "claimed").await;
        allow_control(&service, caller.id);

        let spoofed = control_as(
            &service,
            caller.id,
            std::process::id() + 1,
            ControlCommand::Terminals,
        )
        .await;
        assert!(spoofed.denied, "the peer pid must match the request");
        let unknown = control(&service, Uuid::new_v4(), ControlCommand::Terminals).await;
        assert_eq!(
            unknown.error.as_deref(),
            Some(ControlError::Unauthorized.to_string().as_str())
        );
        workspace.shutdown().await;
    }

    #[tokio::test]
    async fn a_process_outside_the_terminal_is_rejected() {
        let (_directory, service, workspace, _terminals) = strict_service().await;
        service.start().await.unwrap();
        let caller = shell(&workspace, "strict").await;
        allow_control(&service, caller.id);
        let outsider = control(&service, caller.id, ControlCommand::Terminals).await;
        assert!(outsider.denied);
        assert_eq!(
            outsider.error.as_deref(),
            Some(ControlError::Unauthorized.to_string().as_str())
        );
        workspace.shutdown().await;
    }

    #[tokio::test]
    async fn settings_persist_privately_and_are_pruned_with_their_terminal() {
        let directory = tempfile::tempdir().unwrap();
        let terminals = Arc::new(TerminalManager::new(
            Some("/bin/sh".to_owned()),
            1024 * 1024,
        ));
        let workspace =
            WorkspaceBackend::local(terminals, Arc::new(FiliService::new(directory.path())));
        let kept = shell(&workspace, "kept").await;
        let gone = Uuid::new_v4();
        let service = TerminalControlService::new(workspace.clone(), directory.path())
            .await
            .unwrap();
        share(&service, kept.id, TerminalExposure::Read);
        allow_control(&service, kept.id);
        share(&service, gone, TerminalExposure::Write);
        let mode = std::fs::metadata(directory.path().join(SETTINGS_FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0);

        let mut reloaded = TerminalControlService::new(workspace.clone(), directory.path())
            .await
            .unwrap();
        assert_eq!(
            reloaded.settings(kept.id),
            TerminalControlSettings {
                exposure: TerminalExposure::Read,
                controller: true,
                created_by: None,
            }
        );
        assert_eq!(reloaded.settings(gone).exposure, TerminalExposure::Write);
        let listed = workspace.list().await.unwrap();
        reloaded.retain(&listed);
        assert_eq!(
            reloaded.settings(gone).exposure,
            TerminalExposure::Write,
            "a terminal missing from one listing keeps its settings"
        );
        Arc::get_mut(&mut reloaded).unwrap().prune_grace = Duration::ZERO;
        reloaded.retain(&listed);
        assert_eq!(reloaded.settings(gone), TerminalControlSettings::default());
        assert_eq!(reloaded.settings(kept.id).exposure, TerminalExposure::Read);
        reloaded.forget(kept.id).unwrap();
        let after = TerminalControlService::new(workspace.clone(), directory.path())
            .await
            .unwrap();
        assert_eq!(after.settings(kept.id), TerminalControlSettings::default());
        workspace.shutdown().await;
    }

    #[tokio::test]
    async fn the_retired_supervisor_credentials_are_removed() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join(LEGACY_CREDENTIALS_FILE_NAME),
            b"{\"version\":1}",
        )
        .unwrap();
        let terminals = Arc::new(TerminalManager::new(
            Some("/bin/sh".to_owned()),
            1024 * 1024,
        ));
        let workspace =
            WorkspaceBackend::local(terminals, Arc::new(FiliService::new(directory.path())));
        TerminalControlService::new(workspace, directory.path())
            .await
            .unwrap();
        assert!(!directory.path().join(LEGACY_CREDENTIALS_FILE_NAME).exists());
    }

    #[tokio::test]
    async fn history_commands_page_running_and_closed_sessions() {
        let (directory, service, workspace, terminals) = test_service().await;
        let caller = shell(&workspace, "history-reader").await;
        allow_control(&service, caller.id);
        let target = workspace
            .create(CreateTerminal {
                path: Some("history-target".into()),
                cwd: Some(directory.path().to_path_buf()),
                shell: Some("/bin/sh".into()),
                clone_from: None,
            })
            .await
            .unwrap();
        share(&service, target.id, TerminalExposure::Read);
        assert!(terminals.apply_agent_event(
            target.id,
            crate::agent_events::AgentEvent {
                provider: "omp".to_owned(),
                kind: crate::agent_events::AgentEventKind::Thinking,
                sequence: None,
                title: None,
                transcript_only: true,
                transcript_reset: true,
                transcript: vec![
                    crate::history::AgentTranscriptInput {
                        kind: AgentTranscriptKind::Message,
                        source_id: Some("message-1".to_owned()),
                        timestamp: Some(1),
                        role: Some("user".to_owned()),
                        name: None,
                        text: Some("first".to_owned()),
                        data: None,
                        truncated: false,
                    },
                    crate::history::AgentTranscriptInput {
                        kind: AgentTranscriptKind::Message,
                        source_id: Some("message-2".to_owned()),
                        timestamp: Some(2),
                        role: Some("assistant".to_owned()),
                        name: None,
                        text: Some("second".to_owned()),
                        data: None,
                        truncated: false,
                    },
                ],
            },
        ));
        workspace
            .write(
                target.id,
                "printf '\\033[32mRAW-HISTORY\\033[0m\\n'\r".into(),
            )
            .await
            .unwrap();

        let current = control(
            &service,
            caller.id,
            ControlCommand::Transcript {
                terminal_id: target.id,
                from_sequence: None,
                limit: 1,
                kinds: vec![AgentTranscriptKind::Message],
            },
        )
        .await;
        assert!(current.ok, "{:?}", current.error);
        let first_page =
            serde_json::from_value::<AgentTranscriptPage>(current.result.unwrap()).unwrap();
        assert_eq!(first_page.records.len(), 1);
        assert!(first_page.has_more);
        let next = control(
            &service,
            caller.id,
            ControlCommand::Transcript {
                terminal_id: target.id,
                from_sequence: Some(first_page.next_sequence),
                limit: 1,
                kinds: vec![AgentTranscriptKind::Message],
            },
        )
        .await;
        let next_page =
            serde_json::from_value::<AgentTranscriptPage>(next.result.unwrap()).unwrap();
        assert_eq!(next_page.records[0].text.as_deref(), Some("second"));
        assert!(!next_page.has_more);

        let mut raw_history = None;
        for _ in 0..50 {
            let response = control(
                &service,
                caller.id,
                ControlCommand::Scrollback {
                    terminal_id: target.id,
                    from_sequence: None,
                    limit_bytes: DEFAULT_SCROLLBACK_BYTES,
                },
            )
            .await;
            let page =
                serde_json::from_value::<TerminalScrollbackPage>(response.result.unwrap()).unwrap();
            if page.text.contains("RAW-HISTORY") {
                raw_history = Some(page);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let raw_history = raw_history.expect("running terminal scrollback omitted retained output");
        assert!(!raw_history.text.contains("\u{1b}[32m"));

        workspace.write(target.id, "exit\r".into()).await.unwrap();
        let mut exited = false;
        for _ in 0..50 {
            if terminals.get(target.id).unwrap().info().status == TerminalStatus::Exited {
                exited = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(exited);
        let closed = control(
            &service,
            caller.id,
            ControlCommand::Transcript {
                terminal_id: target.id,
                from_sequence: Some(0),
                limit: 10,
                kinds: Vec::new(),
            },
        )
        .await;
        assert!(closed.ok);
        let closed_page =
            serde_json::from_value::<AgentTranscriptPage>(closed.result.unwrap()).unwrap();
        assert_eq!(closed_page.records.len(), 2);
        workspace.shutdown().await;
    }

    #[tokio::test]
    async fn send_cli_plain_key_reaches_raw_mode_terminal() {
        let (_directory, service, workspace, _terminals) = test_service().await;
        let caller = shell(&workspace, "raw-key-caller").await;
        let terminal = shell(&workspace, "raw-key-target").await;
        allow_control(&service, caller.id);
        share(&service, terminal.id, TerminalExposure::Write);
        workspace
            .write(
                terminal.id,
                "printf 'RAW-KEY-READY\\n'; stty raw -echo; key=$(dd bs=1 count=1 2>/dev/null); stty sane; printf '\\r\\nRAW-KEY:%s\\n' \"$key\"\r".into(),
            )
            .await
            .unwrap();
        wait_for_screen(&workspace, terminal.id, "RAW-KEY-READY").await;

        let cli = parse_cli(&["send", &terminal.id.to_string(), "--key", "q"]).unwrap();
        let response = control(&service, caller.id, cli.command.into_request().unwrap()).await;
        assert!(response.ok, "{:?}", response.error);
        wait_for_screen(&workspace, terminal.id, "RAW-KEY:q").await;
        workspace.shutdown().await;
    }

    #[test]
    fn agent_attribution_is_global_and_defaults_to_agent() {
        let id = Uuid::from_u128(30).to_string();
        assert_eq!(parse_cli(&["screen", &id]).unwrap().agent, "agent");
        assert_eq!(
            parse_cli(&["screen", &id, "--agent", "claude"])
                .unwrap()
                .agent,
            "claude"
        );
        assert_eq!(
            parse_cli(&["--agent", "codex", "list"]).unwrap().agent,
            "codex"
        );
        assert_eq!(agent_label("  "), "agent");
        assert_eq!(agent_label("pa\u{1b}[31m"), "pa[31m");
    }

    #[test]
    fn input_previews_are_bounded_and_control_free() {
        assert_eq!(input_preview("claude\r"), "\"claude⏎\"");
        assert_eq!(input_preview("\x03\x1b[A\t"), "\"Ctrl-CEsc[A⇥\"");
        let long = "x".repeat(200);
        let preview = input_preview(&long);
        assert_eq!(preview.chars().count(), MAX_ACTIVITY_PREVIEW_CHARS + 3);
        assert!(preview.ends_with("…\""));
    }

    #[test]
    fn exposure_levels_are_ordered() {
        assert!(TerminalExposure::Off < TerminalExposure::Read);
        assert!(TerminalExposure::Read < TerminalExposure::Write);
        assert_eq!(
            serde_json::to_value(TerminalExposure::Write).unwrap(),
            serde_json::json!("write")
        );
    }

    #[test]
    fn send_cli_builds_text_keys_and_submission_atomically() {
        let terminal_id = Uuid::from_u128(20);
        let request = TerminalsCliCommand::Send {
            terminal_id,
            text: Some("continue".into()),
            keys: vec!["tab".into(), "escape".into()],
            enter: true,
        }
        .into_request()
        .unwrap();
        match request {
            ControlCommand::Send {
                terminal_id: actual,
                data,
            } => {
                assert_eq!(actual, terminal_id);
                assert_eq!(data, "continue\t\x1b\r");
            }
            _ => panic!("expected send request"),
        }
    }

    #[test]
    fn send_cli_rejects_empty_input_and_unknown_keys() {
        let terminal_id = Uuid::from_u128(21);
        assert!(
            TerminalsCliCommand::Send {
                terminal_id,
                text: None,
                keys: Vec::new(),
                enter: false,
            }
            .into_request()
            .is_err()
        );
        assert!(
            TerminalsCliCommand::Send {
                terminal_id,
                text: None,
                keys: vec!["power".into()],
                enter: false,
            }
            .into_request()
            .is_err()
        );
    }

    #[test]
    fn history_cli_maps_pagination_filters_and_output_modes() {
        let terminal_id = Uuid::from_u128(23);
        let scrollback = TerminalsCliCommand::Scrollback {
            terminal_id,
            from_sequence: Some(40),
            limit_bytes: 2048,
            jsonl: true,
        };
        assert!(matches!(
            scrollback.output(),
            ControlOutput::ScrollbackJsonl
        ));
        assert!(matches!(
            scrollback.into_request().unwrap(),
            ControlCommand::Scrollback {
                terminal_id: actual,
                from_sequence: Some(40),
                limit_bytes: 2048,
            } if actual == terminal_id
        ));

        let transcript = TerminalsCliCommand::Transcript {
            terminal_id,
            from_sequence: Some(7),
            limit: 12,
            kinds: vec![
                AgentTranscriptKind::Message,
                AgentTranscriptKind::ToolResult,
            ],
            jsonl: false,
        };
        assert!(matches!(transcript.output(), ControlOutput::TranscriptText));
        assert!(matches!(
            transcript.into_request().unwrap(),
            ControlCommand::Transcript {
                terminal_id: actual,
                from_sequence: Some(7),
                limit: 12,
                kinds,
            } if actual == terminal_id
                && kinds == vec![
                    AgentTranscriptKind::Message,
                    AgentTranscriptKind::ToolResult,
                ]
        ));
        assert_eq!(
            parse_transcript_kind("tool_result").unwrap(),
            AgentTranscriptKind::ToolResult
        );
        assert!(parse_transcript_kind("unknown").is_err());
    }

    #[test]
    fn history_formatters_emit_clean_text_and_jsonl_cursors() {
        let terminal_id = Uuid::from_u128(24);
        let scrollback = TerminalScrollbackPage {
            terminal_id,
            earliest_sequence: 2,
            start_sequence: 2,
            end_sequence: 8,
            latest_sequence: 10,
            truncated: true,
            has_more: true,
            text: "clean output\n".to_owned(),
        };
        let scrollback_text = scrollback_text(&scrollback);
        assert!(scrollback_text.contains("end=8"));
        assert!(scrollback_text.ends_with("clean output\n"));
        let scrollback_json =
            serde_json::from_str::<Value>(&scrollback_jsonl(&scrollback).unwrap()).unwrap();
        assert_eq!(scrollback_json["recordType"], "scrollback");
        assert_eq!(scrollback_json["endSequence"], 8);

        let transcript = AgentTranscriptPage {
            terminal_id,
            earliest_sequence: 3,
            start_sequence: 3,
            next_sequence: 4,
            latest_sequence: 5,
            truncated: false,
            has_more: true,
            records: vec![crate::history::AgentTranscriptRecord {
                sequence: 3,
                timestamp: 42,
                provider: "omp".to_owned(),
                kind: AgentTranscriptKind::Message,
                source_id: Some("message-1".to_owned()),
                role: Some("user".to_owned()),
                name: None,
                text: Some("relay this".to_owned()),
                data: None,
                truncated: false,
            }],
        };
        let text = transcript_text(&transcript);
        assert!(text.contains("next=4"));
        assert!(text.contains("[3 @ 42] user"));
        assert!(text.contains("relay this"));
        let jsonl = transcript_jsonl(&transcript).unwrap();
        let lines = jsonl.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        let page = serde_json::from_str::<Value>(lines[0]).unwrap();
        let record = serde_json::from_str::<Value>(lines[1]).unwrap();
        assert_eq!(page["recordType"], "page");
        assert_eq!(page["nextSequence"], 4);
        assert_eq!(record["recordType"], "entry");
        assert_eq!(record["sequence"], 3);
    }

    #[tokio::test]
    async fn claiming_the_control_socket_rejects_a_second_server_and_recovers_stale_sockets() {
        let directory = tempfile::tempdir().unwrap();
        let claimed = ControlSocket::claim(directory.path()).await.unwrap();
        let rejected = ControlSocket::claim(directory.path()).await.unwrap_err();
        assert!(
            matches!(&rejected, ControlError::Unavailable(message) if message.contains("already running")),
            "unexpected error: {rejected}"
        );

        // A server that died leaves its socket file behind; the next one still
        // has to be able to claim it.
        drop(claimed);
        ControlSocket::claim(directory.path()).await.unwrap();
    }

    #[test]
    fn accept_backoff_doubles_up_to_its_ceiling() {
        assert_eq!(
            next_accept_backoff(ACCEPT_BACKOFF_MIN),
            ACCEPT_BACKOFF_MIN * 2
        );
        assert_eq!(
            next_accept_backoff(ACCEPT_BACKOFF_MAX / 2 + Duration::from_millis(1)),
            ACCEPT_BACKOFF_MAX
        );
        assert_eq!(next_accept_backoff(ACCEPT_BACKOFF_MAX), ACCEPT_BACKOFF_MAX);
    }

    fn browser_snapshot() -> BrowserTabSnapshot {
        BrowserTabSnapshot {
            title: "Primary".into(),
            focused: true,
            visible: true,
            terminal_panes: vec![BrowserTerminalPane {
                terminal_id: Uuid::from_u128(11),
                label: "agent".into(),
                active: true,
            }],
            resources: vec![BrowserResourceTab {
                path: "/tmp/notes.txt".into(),
                name: "notes.txt".into(),
                dirty: false,
                active: false,
            }],
            settings_open: true,
            settings_active: false,
        }
    }

    #[test]
    fn tab_ids_are_stable_and_view_scoped() {
        let first_view = Uuid::from_u128(1);
        let second_view = Uuid::from_u128(2);
        assert_eq!(
            stable_tab_id(first_view, "terminal", "target"),
            stable_tab_id(first_view, "terminal", "target")
        );
        assert_ne!(
            stable_tab_id(first_view, "terminal", "target"),
            stable_tab_id(second_view, "terminal", "target")
        );
        assert_ne!(
            stable_tab_id(first_view, "terminal", "target"),
            stable_tab_id(first_view, "resource", "target")
        );
    }

    #[test]
    fn close_tab_cli_accepts_opaque_ids_starting_with_hyphens() {
        for id in ["-nha4I1dPMGadCm3", "--opaque-tab-id", "ordinary-tab-id"] {
            let cli = parse_cli(&["close-tab", id]).unwrap();
            let ControlCommand::CloseTab { tab_id } = cli.command.into_request().unwrap() else {
                panic!("expected a close-tab request");
            };
            assert_eq!(tab_id, id);
        }
        assert!(parse_cli(&["--unknown"]).is_err());
        assert_eq!(
            parse_cli(&["close-tab", "--help"]).unwrap_err().kind(),
            clap::error::ErrorKind::DisplayHelp,
        );
    }

    #[test]
    fn browser_commands_use_the_shared_camel_case_contract() {
        let terminal_id = Uuid::from_u128(6);
        let command_id = Uuid::from_u128(7);
        assert_eq!(
            serde_json::to_value(BrowserTabCommand::CloseTerminalPane {
                id: command_id,
                terminal_id,
            })
            .unwrap(),
            serde_json::json!({
                "type": "closeTerminalPane",
                "id": command_id,
                "terminalId": terminal_id,
            })
        );
    }

    #[tokio::test]
    async fn browser_registry_lists_every_closeable_surface() {
        let registry = BrowserTabRegistry::default();
        let view_id = Uuid::from_u128(7);
        registry
            .heartbeat(view_id, browser_snapshot())
            .await
            .unwrap();
        let tabs = registry.list().await;
        assert_eq!(tabs.len(), 3);
        assert_eq!(
            tabs.iter().map(|tab| &tab.kind).collect::<Vec<_>>(),
            vec![
                &BrowserTabKind::Terminal,
                &BrowserTabKind::Resource,
                &BrowserTabKind::Settings,
            ]
        );
        assert!(tabs.iter().all(|tab| tab.view_id == view_id));
        assert!(tabs.iter().all(|tab| tab.focused && tab.visible));
    }

    #[tokio::test]
    async fn browser_registry_rejects_oversized_duplicate_and_excess_views() {
        let registry = BrowserTabRegistry::default();
        let mut duplicate = browser_snapshot();
        duplicate
            .terminal_panes
            .push(duplicate.terminal_panes[0].clone());
        assert!(
            registry
                .heartbeat(Uuid::from_u128(100), duplicate)
                .await
                .is_err()
        );

        let mut oversized = browser_snapshot();
        oversized.resources = (0..=MAX_BROWSER_RESOURCES)
            .map(|index| BrowserResourceTab {
                path: format!("/tmp/{index}"),
                name: index.to_string(),
                dirty: false,
                active: false,
            })
            .collect();
        assert!(
            registry
                .heartbeat(Uuid::from_u128(101), oversized)
                .await
                .is_err()
        );

        for index in 0..MAX_BROWSER_VIEWS {
            registry
                .heartbeat(Uuid::from_u128(1_000 + index as u128), browser_snapshot())
                .await
                .unwrap();
        }
        assert!(
            registry
                .heartbeat(Uuid::from_u128(2_000), browser_snapshot())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn close_tab_waits_for_browser_acknowledgement() {
        let registry = Arc::new(BrowserTabRegistry::default());
        let view_id = Uuid::from_u128(8);
        registry
            .heartbeat(view_id, browser_snapshot())
            .await
            .unwrap();
        let tab_id = registry
            .list()
            .await
            .into_iter()
            .find(|tab| tab.kind == BrowserTabKind::Terminal)
            .unwrap()
            .id;

        let closing = {
            let registry = registry.clone();
            tokio::spawn(async move { registry.close(&tab_id).await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        let heartbeat = registry
            .heartbeat(view_id, browser_snapshot())
            .await
            .unwrap();
        assert_eq!(heartbeat.commands.len(), 1);
        let command_id = match heartbeat.commands[0] {
            BrowserTabCommand::CloseTerminalPane { id, terminal_id } => {
                assert_eq!(terminal_id, Uuid::from_u128(11));
                id
            }
            ref command => panic!("unexpected command: {command:?}"),
        };
        registry
            .acknowledge(
                view_id,
                command_id,
                BrowserTabCommandAck {
                    ok: true,
                    error: None,
                },
            )
            .await
            .unwrap();
        assert!(closing.await.unwrap().unwrap().ok);
        assert!(
            registry
                .heartbeat(view_id, browser_snapshot())
                .await
                .unwrap()
                .commands
                .is_empty()
        );
    }

    #[tokio::test]
    async fn dirty_resources_are_never_queued_for_remote_close() {
        let registry = BrowserTabRegistry::default();
        let view_id = Uuid::from_u128(9);
        let mut snapshot = browser_snapshot();
        snapshot.resources[0].dirty = true;
        registry.heartbeat(view_id, snapshot).await.unwrap();
        let tab_id = registry
            .list()
            .await
            .into_iter()
            .find(|tab| tab.kind == BrowserTabKind::Resource)
            .unwrap()
            .id;
        let error = registry.close(&tab_id).await.unwrap_err();
        assert!(error.to_string().contains("dirty resource"));
    }

    #[tokio::test]
    async fn rejected_browser_ack_is_returned_to_the_controller() {
        let registry = Arc::new(BrowserTabRegistry::default());
        let view_id = Uuid::from_u128(10);
        registry
            .heartbeat(view_id, browser_snapshot())
            .await
            .unwrap();
        let tab_id = registry
            .list()
            .await
            .into_iter()
            .find(|tab| tab.kind == BrowserTabKind::Settings)
            .unwrap()
            .id;
        let closing = {
            let registry = registry.clone();
            tokio::spawn(async move { registry.close(&tab_id).await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        let heartbeat = registry
            .heartbeat(view_id, browser_snapshot())
            .await
            .unwrap();
        let command_id = match heartbeat.commands[0] {
            BrowserTabCommand::CloseSettings { id } => id,
            ref command => panic!("unexpected command: {command:?}"),
        };
        registry
            .acknowledge(
                view_id,
                command_id,
                BrowserTabCommandAck {
                    ok: false,
                    error: Some("view changed".into()),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            closing.await.unwrap().unwrap(),
            BrowserTabCommandAck {
                ok: false,
                error: Some("view changed".into()),
            }
        );
    }

    #[tokio::test]
    async fn stale_browser_views_disappear_from_inventory() {
        let registry = BrowserTabRegistry::default();
        let view_id = Uuid::from_u128(12);
        registry
            .heartbeat(view_id, browser_snapshot())
            .await
            .unwrap();
        registry
            .views
            .lock()
            .await
            .get_mut(&view_id)
            .unwrap()
            .updated_at = Instant::now() - BROWSER_VIEW_LEASE - Duration::from_millis(1);
        assert!(registry.list().await.is_empty());
    }
}
