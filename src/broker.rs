use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Path as AxumPath, Query, State, ws::WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{any, get, patch, post},
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use tokio::{
    net::{UnixListener, UnixStream},
    sync::{Mutex, Notify, RwLock},
};
use tokio_tungstenite::{WebSocketStream, client_async};
use uuid::Uuid;

use crate::{
    agent_events::AgentEvent,
    ai::{PiClientConfig, PiService, UpdatePiSettings},
    build::{self, BuildIdentity},
    config::Cli,
    terminal::{
        AgentDetectionExplain, CreateTerminal, ProcessInspectorSnapshot, RenameTerminal,
        TerminalInfo, TerminalManager, TerminalViewport, normalize_terminal_path,
    },
    workspace::{
        SessionBrokerGenerationInfo, SessionBrokerInfo, TerminalSocketQuery,
        WorkspaceError as BrokerError, serve_terminal_socket,
    },
};

const PROTOCOL_VERSION: u32 = 4;
const SOCKET_NAME: &str = "session-broker.sock";
const BROKER_DIRECTORY: &str = "session-brokers";
const DRAIN_INTERVAL: Duration = Duration::from_secs(2);

pub type BrokerWebSocket = WebSocketStream<UnixStream>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrokerSettings {
    default_shell: Option<String>,
    replay_bytes: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    protocol_version: u32,
    build: BuildIdentity,
    sessions: usize,
}

#[derive(Debug, Deserialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Clone)]
pub struct BrokerClient {
    socket_path: Arc<PathBuf>,
}

impl BrokerClient {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path: Arc::new(socket_path),
        }
    }

    async fn start_and_wait(
        &self,
        cli: &Cli,
        executable: &Path,
    ) -> Result<HealthResponse, BrokerError> {
        spawn_broker(cli, executable, self.socket_path.as_ref())?;
        let mut last_error = None;
        for _ in 0..50 {
            match self.health().await {
                Ok(health) if health.protocol_version == PROTOCOL_VERSION => return Ok(health),
                Ok(health) => {
                    last_error = Some(BrokerError::Protocol {
                        expected: PROTOCOL_VERSION,
                        actual: health.protocol_version,
                    });
                }
                Err(error) => last_error = Some(error),
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err(last_error.unwrap_or_else(|| {
            BrokerError::Unavailable("session broker did not become ready".to_owned())
        }))
    }

    async fn health(&self) -> Result<HealthResponse, BrokerError> {
        self.get_json("/health").await
    }

    async fn configure(
        &self,
        default_shell: Option<String>,
        replay_bytes: usize,
    ) -> Result<(), BrokerError> {
        self.send_empty(
            Method::PUT,
            "/config",
            Some(&BrokerSettings {
                default_shell,
                replay_bytes,
            }),
        )
        .await
    }

    pub async fn list(&self) -> Result<Vec<TerminalInfo>, BrokerError> {
        self.get_json("/terminals").await
    }

    pub async fn create(&self, request: CreateTerminal) -> Result<TerminalInfo, BrokerError> {
        self.send_json(Method::POST, "/terminals", Some(&request))
            .await
    }

    pub async fn rename(
        &self,
        id: Uuid,
        request: RenameTerminal,
    ) -> Result<TerminalInfo, BrokerError> {
        self.send_json(Method::PATCH, &format!("/terminals/{id}"), Some(&request))
            .await
    }

    pub async fn remove(&self, id: Uuid) -> Result<(), BrokerError> {
        self.send_empty::<()>(Method::DELETE, &format!("/terminals/{id}"), None)
            .await
    }

    pub async fn process_inspector(
        &self,
        id: Uuid,
    ) -> Result<ProcessInspectorSnapshot, BrokerError> {
        self.get_json(&format!("/terminals/{id}/processes")).await
    }

    pub async fn agent_explain(&self, id: Uuid) -> Result<AgentDetectionExplain, BrokerError> {
        self.get_json(&format!("/terminals/{id}/agent-explain"))
            .await
    }

    pub async fn pi_config(&self) -> Result<PiClientConfig, BrokerError> {
        self.get_json("/pi").await
    }

    pub async fn update_pi(
        &self,
        settings: UpdatePiSettings,
    ) -> Result<PiClientConfig, BrokerError> {
        self.send_json(Method::PATCH, "/pi", Some(&settings)).await
    }

    pub async fn agent_event(&self, id: Uuid, event: &AgentEvent) -> Result<(), BrokerError> {
        self.send_empty(
            Method::POST,
            &format!("/terminals/{id}/agent-event"),
            Some(event),
        )
        .await
    }

    pub async fn terminal_socket(
        &self,
        id: Uuid,
        initial_size: Option<TerminalViewport>,
        sequence: Option<u64>,
        observer: bool,
    ) -> Result<BrokerWebSocket, BrokerError> {
        let stream = UnixStream::connect(self.socket_path.as_ref()).await?;
        let mut query = vec![];
        if let Some(viewport) = initial_size {
            query.push(format!("cols={}", viewport.cols));
            query.push(format!("rows={}", viewport.rows));
            query.push(format!("pixelWidth={}", viewport.pixel_width));
            query.push(format!("pixelHeight={}", viewport.pixel_height));
        }
        if let Some(sequence) = sequence {
            query.push(format!("sequence={sequence}"));
        }
        let query = if query.is_empty() {
            String::new()
        } else {
            format!("?{}", query.join("&"))
        };
        let endpoint = if observer { "observe" } else { "socket" };
        let (socket, _) = client_async(
            format!("ws://localhost/terminals/{id}/{endpoint}{query}"),
            stream,
        )
        .await
        .map_err(|error| BrokerError::Unavailable(error.to_string()))?;
        Ok(socket)
    }

    pub async fn shutdown(&self) -> Result<(), BrokerError> {
        self.send_empty::<()>(Method::POST, "/shutdown", None)
            .await?;
        for _ in 0..100 {
            if UnixStream::connect(self.socket_path.as_ref())
                .await
                .is_err()
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Err(BrokerError::Unavailable(
            "session broker did not stop".to_owned(),
        ))
    }

    async fn get_json<R: DeserializeOwned>(&self, path: &str) -> Result<R, BrokerError> {
        self.send_json::<(), R>(Method::GET, path, None).await
    }

    async fn send_json<B: Serialize + ?Sized, R: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<R, BrokerError> {
        let (status, bytes) = self.request(method, path, body).await?;
        if !status.is_success() {
            return Err(remote_error(status, &bytes));
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| BrokerError::Unavailable(format!("invalid broker response: {error}")))
    }

    async fn send_empty<B: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<(), BrokerError> {
        let (status, bytes) = self.request(method, path, body).await?;
        if status.is_success() {
            Ok(())
        } else {
            Err(remote_error(status, &bytes))
        }
    }

    async fn request<B: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<(StatusCode, Bytes), BrokerError> {
        let stream = UnixStream::connect(self.socket_path.as_ref()).await?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|error| BrokerError::Unavailable(error.to_string()))?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                tracing::debug!(%error, "session broker HTTP connection ended");
            }
        });

        let encoded = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| BrokerError::Unavailable(error.to_string()))?
            .unwrap_or_default();
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "localhost")
            .header("content-length", encoded.len());
        if !encoded.is_empty() {
            builder = builder.header("content-type", "application/json");
        }
        let request = builder
            .body(Full::new(Bytes::from(encoded)))
            .map_err(|error| BrokerError::Unavailable(error.to_string()))?;
        let response = sender
            .send_request(request)
            .await
            .map_err(|error| BrokerError::Unavailable(error.to_string()))?;
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|error| BrokerError::Unavailable(error.to_string()))?
            .to_bytes();
        Ok((status, bytes))
    }
}

#[derive(Debug, Clone)]
struct BrokerGeneration {
    client: BrokerClient,
    build: BuildIdentity,
    current: bool,
}

impl BrokerGeneration {
    fn terminal(&self, mut terminal: TerminalInfo) -> TerminalInfo {
        terminal.broker = Some(self.build.clone());
        terminal
    }
}

pub struct BrokerPool {
    current: BrokerGeneration,
    draining: RwLock<Vec<BrokerGeneration>>,
    owners: RwLock<HashMap<Uuid, BrokerGeneration>>,
    create_lock: Mutex<()>,
    shutting_down: AtomicBool,
}

impl BrokerPool {
    pub async fn connect_or_start(cli: &Cli, executable: &Path) -> Result<Arc<Self>, BrokerError> {
        tokio::fs::create_dir_all(&cli.data_dir).await?;
        tokio::fs::create_dir_all(cli.data_dir.join(BROKER_DIRECTORY)).await?;
        let current_path = current_socket_path(&cli.data_dir);
        let mut compatible = Vec::new();

        for path in broker_socket_paths(&cli.data_dir).await? {
            let client = BrokerClient::new(path);
            let Ok(health) = client.health().await else {
                continue;
            };
            if health.protocol_version != PROTOCOL_VERSION {
                tracing::warn!(
                    expected_protocol = PROTOCOL_VERSION,
                    actual_protocol = health.protocol_version,
                    sessions = health.sessions,
                    socket = %client.socket_path.display(),
                    "replacing incompatible session broker; existing terminals will close"
                );
                client.shutdown().await?;
                continue;
            }
            compatible.push(BrokerGeneration {
                client,
                build: health.build,
                current: false,
            });
        }

        let current_index = compatible
            .iter()
            .position(|generation| {
                generation.client.socket_path.as_ref() == &current_path
                    && generation.build.is_current()
            })
            .or_else(|| {
                compatible
                    .iter()
                    .position(|generation| generation.build.is_current())
            });
        let mut current = if let Some(index) = current_index {
            compatible.remove(index)
        } else {
            let client = BrokerClient::new(current_path);
            let health = client.start_and_wait(cli, executable).await?;
            BrokerGeneration {
                client,
                build: health.build,
                current: false,
            }
        };
        current.current = true;
        current
            .client
            .configure(cli.shell.clone(), cli.replay_bytes())
            .await?;

        tracing::info!(
            broker_version = %current.build.version,
            broker_commit = %current.build.commit,
            socket = %current.client.socket_path.display(),
            draining_brokers = compatible.len(),
            "connected to current terminal session broker"
        );
        for generation in &compatible {
            tracing::info!(
                broker_version = %generation.build.version,
                broker_commit = %generation.build.commit,
                socket = %generation.client.socket_path.display(),
                "keeping compatible terminal session broker in draining mode"
            );
        }

        let pool = Arc::new(Self {
            current,
            draining: RwLock::new(compatible),
            owners: RwLock::new(HashMap::new()),
            create_lock: Mutex::new(()),
            shutting_down: AtomicBool::new(false),
        });
        Self::start_reaper(&pool);
        pool.retire_empty_brokers().await;
        Ok(pool)
    }

    fn start_reaper(pool: &Arc<Self>) {
        let pool = Arc::downgrade(pool);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(DRAIN_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(pool) = pool.upgrade() else {
                    return;
                };
                if pool.shutting_down.load(Ordering::Relaxed) {
                    return;
                }
                pool.retire_empty_brokers().await;
            }
        });
    }

    async fn generations(&self) -> Vec<BrokerGeneration> {
        let draining = self.draining.read().await;
        let mut generations = Vec::with_capacity(draining.len() + 1);
        generations.push(self.current.clone());
        generations.extend(draining.iter().cloned());
        generations
    }

    async fn retire_empty_brokers(&self) {
        let candidates = self.draining.read().await.clone();
        for generation in candidates {
            let Ok(health) = generation.client.health().await else {
                continue;
            };
            if health.sessions != 0 {
                continue;
            }
            {
                let mut draining = self.draining.write().await;
                let Some(index) = draining.iter().position(|candidate| {
                    candidate.client.socket_path == generation.client.socket_path
                }) else {
                    continue;
                };
                draining.remove(index);
            }
            if let Err(error) = generation.client.shutdown().await {
                self.draining.write().await.push(generation.clone());
                tracing::warn!(
                    %error,
                    socket = %generation.client.socket_path.display(),
                    "unable to stop drained terminal session broker"
                );
            } else {
                self.owners
                    .write()
                    .await
                    .retain(|_, owner| owner.client.socket_path != generation.client.socket_path);
                tracing::info!(
                    broker_version = %generation.build.version,
                    broker_commit = %generation.build.commit,
                    "stopped drained terminal session broker"
                );
            }
        }
    }

    pub async fn list(&self) -> Result<Vec<TerminalInfo>, BrokerError> {
        let generations = self.generations().await;
        let mut terminals = Vec::new();
        let mut owners = HashMap::new();
        for generation in generations {
            let listed = match generation.client.list().await {
                Ok(listed) => listed,
                Err(error) if !generation.current => {
                    tracing::warn!(
                        %error,
                        broker_version = %generation.build.version,
                        "draining terminal session broker became unavailable"
                    );
                    continue;
                }
                Err(error) => return Err(error),
            };
            for terminal in listed {
                owners.insert(terminal.id, generation.clone());
                terminals.push(generation.terminal(terminal));
            }
        }
        terminals.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then_with(|| left.created_at.cmp(&right.created_at))
        });
        *self.owners.write().await = owners;
        Ok(terminals)
    }

    async fn owner(&self, id: Uuid) -> Result<BrokerGeneration, BrokerError> {
        if let Some(owner) = self.owners.read().await.get(&id).cloned() {
            return Ok(owner);
        }
        self.list().await?;
        self.owners
            .read()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(terminal_not_found)
    }

    pub async fn create(&self, mut request: CreateTerminal) -> Result<TerminalInfo, BrokerError> {
        let _guard = self.create_lock.lock().await;
        let terminals = self.list().await?;
        if let Some(path) = request.path.as_deref() {
            ensure_unique_terminal_name(path, None, &terminals)?;
        }
        if request.cwd.is_none()
            && let Some(source) = request.clone_from
        {
            let terminal = terminals
                .into_iter()
                .find(|terminal| terminal.id == source)
                .ok_or_else(|| BrokerError::Remote {
                    status: StatusCode::BAD_REQUEST,
                    message: "the terminal to clone no longer exists".to_owned(),
                })?;
            request.cwd = Some(terminal.cwd);
            request.clone_from = None;
        }
        let terminal = self.current.client.create(request).await?;
        self.owners
            .write()
            .await
            .insert(terminal.id, self.current.clone());
        Ok(self.current.terminal(terminal))
    }

    pub async fn rename(
        &self,
        id: Uuid,
        request: RenameTerminal,
    ) -> Result<TerminalInfo, BrokerError> {
        let _guard = self.create_lock.lock().await;
        ensure_unique_terminal_name(&request.path, Some(id), &self.list().await?)?;
        let generation = self.owner(id).await?;
        generation
            .client
            .rename(id, request)
            .await
            .map(|terminal| generation.terminal(terminal))
    }

    pub async fn remove(&self, id: Uuid) -> Result<(), BrokerError> {
        let generation = self.owner(id).await?;
        generation.client.remove(id).await?;
        self.owners.write().await.remove(&id);
        Ok(())
    }

    pub async fn process_inspector(
        &self,
        id: Uuid,
    ) -> Result<ProcessInspectorSnapshot, BrokerError> {
        self.owner(id).await?.client.process_inspector(id).await
    }

    pub async fn agent_explain(&self, id: Uuid) -> Result<AgentDetectionExplain, BrokerError> {
        self.owner(id).await?.client.agent_explain(id).await
    }

    pub async fn pi_config(&self) -> Result<PiClientConfig, BrokerError> {
        self.current.client.pi_config().await
    }

    pub async fn update_pi(
        &self,
        settings: UpdatePiSettings,
    ) -> Result<PiClientConfig, BrokerError> {
        let updated = self.current.client.update_pi(settings.clone()).await?;
        for generation in self.draining.read().await.iter() {
            if let Err(error) = generation.client.update_pi(settings.clone()).await {
                tracing::warn!(
                    %error,
                    broker_version = %generation.build.version,
                    "unable to update settings in draining broker"
                );
            }
        }
        Ok(updated)
    }

    pub async fn terminal_socket(
        &self,
        id: Uuid,
        initial_size: Option<TerminalViewport>,
        sequence: Option<u64>,
        observer: bool,
    ) -> Result<BrokerWebSocket, BrokerError> {
        self.owner(id)
            .await?
            .client
            .terminal_socket(id, initial_size, sequence, observer)
            .await
    }

    pub async fn info(&self) -> Result<SessionBrokerInfo, BrokerError> {
        let mut generations = Vec::new();
        let mut sessions = 0;
        let mut restart_required = false;
        for generation in self.generations().await {
            let health = match generation.client.health().await {
                Ok(health) => health,
                Err(error) if !generation.current => {
                    tracing::warn!(
                        %error,
                        broker_version = %generation.build.version,
                        "draining terminal session broker became unavailable"
                    );
                    continue;
                }
                Err(error) => return Err(error),
            };
            sessions += health.sessions;
            restart_required |= !generation.current && health.sessions > 0;
            generations.push(SessionBrokerGenerationInfo {
                version: health.build.version,
                commit: health.build.commit,
                sessions: health.sessions,
                current: generation.current,
            });
        }
        Ok(SessionBrokerInfo {
            version: self.current.build.version.clone(),
            commit: self.current.build.commit.clone(),
            sessions,
            restart_required,
            generations,
        })
    }

    pub async fn shutdown(&self) -> Result<(), BrokerError> {
        self.shutting_down.store(true, Ordering::Relaxed);
        let mut first_error = None;
        for generation in self.generations().await {
            if let Err(error) = generation.client.shutdown().await
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

fn terminal_not_found() -> BrokerError {
    BrokerError::Remote {
        status: StatusCode::NOT_FOUND,
        message: "terminal not found".to_owned(),
    }
}

fn bad_terminal_request(error: impl std::fmt::Display) -> BrokerError {
    BrokerError::Remote {
        status: StatusCode::BAD_REQUEST,
        message: error.to_string(),
    }
}

fn ensure_unique_terminal_name(
    input: &str,
    except: Option<Uuid>,
    terminals: &[TerminalInfo],
) -> Result<(), BrokerError> {
    let normalized = normalize_terminal_path(input).map_err(bad_terminal_request)?;
    let name = normalized.rsplit('/').next().unwrap_or(&normalized);
    if terminals
        .iter()
        .any(|terminal| Some(terminal.id) != except && terminal.name == name)
    {
        return Err(BrokerError::Remote {
            status: StatusCode::BAD_REQUEST,
            message: format!("a terminal already exists at {name}"),
        });
    }
    Ok(())
}

fn remote_error(status: StatusCode, bytes: &[u8]) -> BrokerError {
    let message = serde_json::from_slice::<ErrorResponse>(bytes)
        .map(|response| response.error)
        .unwrap_or_else(|_| format!("session broker request failed ({status})"));
    BrokerError::Remote { status, message }
}

fn spawn_broker(cli: &Cli, executable: &Path, socket: &Path) -> Result<(), BrokerError> {
    let mut command = Command::new(executable);
    command
        .arg("--session-broker")
        .arg("--data-dir")
        .arg(&cli.data_dir)
        .arg("--broker-socket")
        .arg(socket)
        .arg("--replay-mb")
        .arg(cli.replay_mb.to_string())
        .arg("--log")
        .arg(&cli.log)
        .stdin(Stdio::null())
        .env_remove("TERM_SERVER_SESSION");
    if let Some(shell) = &cli.shell {
        command.arg("--shell").arg(shell);
    }
    command
        .spawn()
        .map_err(|error| BrokerError::Unavailable(format!("unable to start broker: {error}")))?;
    Ok(())
}

pub fn legacy_socket_path(data_directory: &Path) -> PathBuf {
    data_directory.join(SOCKET_NAME)
}

fn current_socket_path(data_directory: &Path) -> PathBuf {
    let version = build::VERSION
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>();
    let commit = build::COMMIT
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(16)
        .collect::<String>();
    data_directory
        .join(BROKER_DIRECTORY)
        .join(format!("{version}-{commit}.sock"))
}

async fn broker_socket_paths(data_directory: &Path) -> Result<Vec<PathBuf>, BrokerError> {
    let mut paths = vec![legacy_socket_path(data_directory)];
    let mut entries = tokio::fs::read_dir(data_directory.join(BROKER_DIRECTORY)).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "sock")
        {
            paths.push(path);
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[derive(Clone)]
struct BrokerState {
    terminals: Arc<TerminalManager>,
    pi: Arc<PiService>,
    shutdown: Arc<Notify>,
}

#[derive(Debug, Error)]
enum BrokerApiError {
    #[error("terminal not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("internal broker error")]
    Internal,
}

impl IntoResponse for BrokerApiError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (
            status,
            Json(serde_json::json!({ "error": self.to_string() })),
        )
            .into_response()
    }
}

pub async fn run_session_broker(
    data_directory: &Path,
    socket_path: &Path,
    default_shell: Option<String>,
    replay_bytes: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    tokio::fs::create_dir_all(data_directory).await?;
    if let Some(parent) = socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let path = socket_path.to_owned();
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            if UnixStream::connect(&path).await.is_ok() {
                return Err("a terminal session broker is already running".into());
            }
            tokio::fs::remove_file(&path).await?;
            UnixListener::bind(&path)?
        }
        Err(error) => return Err(error.into()),
    };
    set_socket_permissions(&path)?;

    let terminals = Arc::new(
        TerminalManager::new(default_shell, replay_bytes).with_agent_event_socket(path.clone()),
    );
    let pi = Arc::new(PiService::new(data_directory));
    terminals.start_monitor(pi.clone());
    let shutdown = Arc::new(Notify::new());
    let state = BrokerState {
        terminals,
        pi,
        shutdown: shutdown.clone(),
    };
    let router = Router::new()
        .route("/health", get(broker_health))
        .route("/config", axum::routing::put(configure_broker))
        .route("/pi", get(broker_pi_config).patch(update_broker_pi))
        .route(
            "/terminals",
            get(list_broker_terminals).post(create_broker_terminal),
        )
        .route(
            "/terminals/{id}",
            patch(rename_broker_terminal).delete(remove_broker_terminal),
        )
        .route("/terminals/{id}/processes", get(broker_terminal_processes))
        .route("/terminals/{id}/agent-explain", get(broker_agent_explain))
        .route(
            "/terminals/{id}/agent-event",
            post(broker_terminal_agent_event),
        )
        .route("/terminals/{id}/socket", any(broker_terminal_socket))
        .route("/terminals/{id}/observe", any(broker_terminal_observer))
        .route("/shutdown", axum::routing::post(shutdown_broker))
        .with_state(state);

    tracing::info!(socket = %path.display(), "terminal session broker is ready");
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            shutdown.notified().await;
        })
        .await;
    let _ = tokio::fs::remove_file(&path).await;
    result.map_err(Into::into)
}

fn set_socket_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

async fn broker_health(State(state): State<BrokerState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "protocolVersion": PROTOCOL_VERSION,
        "build": build::info(),
        "sessions": state.terminals.list().len(),
    }))
}

async fn configure_broker(
    State(state): State<BrokerState>,
    Json(settings): Json<BrokerSettings>,
) -> StatusCode {
    state
        .terminals
        .configure(settings.default_shell, settings.replay_bytes);
    StatusCode::NO_CONTENT
}

async fn broker_pi_config(State(state): State<BrokerState>) -> Json<PiClientConfig> {
    Json(state.pi.client_config())
}

async fn update_broker_pi(
    State(state): State<BrokerState>,
    Json(settings): Json<UpdatePiSettings>,
) -> Result<Json<PiClientConfig>, BrokerApiError> {
    state
        .pi
        .update(settings)
        .map(Json)
        .map_err(BrokerApiError::BadRequest)
}

async fn list_broker_terminals(State(state): State<BrokerState>) -> Json<Vec<TerminalInfo>> {
    Json(state.terminals.list())
}

async fn create_broker_terminal(
    State(state): State<BrokerState>,
    Json(request): Json<CreateTerminal>,
) -> Result<(StatusCode, Json<TerminalInfo>), BrokerApiError> {
    let terminals = state.terminals.clone();
    let terminal = tokio::task::spawn_blocking(move || terminals.create(request))
        .await
        .map_err(|error| {
            tracing::error!(%error, "broker terminal creation task failed");
            BrokerApiError::Internal
        })?
        .map_err(|error| BrokerApiError::BadRequest(error.to_string()))?;
    Ok((StatusCode::CREATED, Json(terminal)))
}

async fn broker_terminal_agent_event(
    State(state): State<BrokerState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(event): Json<AgentEvent>,
) -> Result<StatusCode, BrokerApiError> {
    state
        .terminals
        .apply_agent_event(id, event, state.pi.clone())
        .then_some(StatusCode::NO_CONTENT)
        .ok_or(BrokerApiError::NotFound)
}

async fn rename_broker_terminal(
    State(state): State<BrokerState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(request): Json<RenameTerminal>,
) -> Result<Json<TerminalInfo>, BrokerApiError> {
    state
        .terminals
        .rename(id, &request.path)
        .map_err(|error| BrokerApiError::BadRequest(error.to_string()))?
        .map(Json)
        .ok_or(BrokerApiError::NotFound)
}

async fn remove_broker_terminal(
    State(state): State<BrokerState>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<StatusCode, BrokerApiError> {
    state
        .terminals
        .remove(id)
        .then_some(StatusCode::NO_CONTENT)
        .ok_or(BrokerApiError::NotFound)
}

async fn broker_terminal_processes(
    State(state): State<BrokerState>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<ProcessInspectorSnapshot>, BrokerApiError> {
    state
        .terminals
        .get(id)
        .map(|terminal| Json(terminal.process_inspector()))
        .ok_or(BrokerApiError::NotFound)
}

async fn broker_agent_explain(
    State(state): State<BrokerState>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<AgentDetectionExplain>, BrokerApiError> {
    state
        .terminals
        .get(id)
        .map(|terminal| Json(terminal.agent_explain()))
        .ok_or(BrokerApiError::NotFound)
}

async fn broker_terminal_socket(
    State(state): State<BrokerState>,
    AxumPath(id): AxumPath<Uuid>,
    Query(query): Query<TerminalSocketQuery>,
    websocket: WebSocketUpgrade,
) -> Result<Response, BrokerApiError> {
    let terminal = state.terminals.get(id).ok_or(BrokerApiError::NotFound)?;
    Ok(websocket
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .write_buffer_size(128 * 1024)
        .max_write_buffer_size(4 * 1024 * 1024)
        .on_upgrade(move |socket| {
            serve_terminal_socket(
                socket,
                terminal,
                query.viewport(),
                query.sequence(),
                false,
                None,
            )
        }))
}

async fn broker_terminal_observer(
    State(state): State<BrokerState>,
    AxumPath(id): AxumPath<Uuid>,
    Query(query): Query<TerminalSocketQuery>,
    websocket: WebSocketUpgrade,
) -> Result<Response, BrokerApiError> {
    let terminal = state.terminals.get(id).ok_or(BrokerApiError::NotFound)?;
    Ok(websocket
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .write_buffer_size(128 * 1024)
        .max_write_buffer_size(4 * 1024 * 1024)
        .on_upgrade(move |socket| {
            serve_terminal_socket(socket, terminal, None, query.sequence(), true, None)
        }))
}

async fn shutdown_broker(State(state): State<BrokerState>) -> StatusCode {
    state.terminals.shutdown();
    let shutdown = state.shutdown.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        shutdown.notify_one();
    });
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use clap::Parser;
    use futures_util::{SinkExt, StreamExt};
    use tempfile::TempDir;
    use tokio::task::JoinHandle;
    use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

    use super::*;

    async fn start_test_broker(replay_bytes: usize) -> (TempDir, JoinHandle<()>, BrokerClient) {
        let directory = tempfile::tempdir().unwrap();
        let data_directory = directory.path().to_path_buf();
        let socket = legacy_socket_path(&data_directory);
        let server_socket = socket.clone();
        let server = tokio::spawn(async move {
            run_session_broker(
                &data_directory,
                &server_socket,
                Some("/bin/sh".to_owned()),
                replay_bytes,
            )
            .await
            .unwrap();
        });
        let client = BrokerClient::new(socket);
        for _ in 0..50 {
            if client.health().await.is_ok() {
                return (directory, server, client);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("test broker did not start");
    }

    async fn start_test_broker_at(
        data_directory: &Path,
        socket: PathBuf,
        replay_bytes: usize,
    ) -> (JoinHandle<()>, BrokerClient) {
        let server_data = data_directory.to_path_buf();
        let server_socket = socket.clone();
        let server = tokio::spawn(async move {
            run_session_broker(
                &server_data,
                &server_socket,
                Some("/bin/sh".to_owned()),
                replay_bytes,
            )
            .await
            .unwrap();
        });
        let client = BrokerClient::new(socket);
        for _ in 0..50 {
            if client.health().await.is_ok() {
                return (server, client);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("test broker did not start");
    }

    async fn wait_for_control(
        socket: &mut BrokerWebSocket,
        message_type: &str,
    ) -> serde_json::Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(message) = socket.next().await {
                match message.unwrap() {
                    TungsteniteMessage::Text(text) => {
                        let value = serde_json::from_str::<serde_json::Value>(&text).unwrap();
                        if value["type"] == message_type {
                            return value;
                        }
                    }
                    TungsteniteMessage::Close(_) => panic!("terminal socket closed"),
                    _ => {}
                }
            }
            panic!("terminal socket ended before receiving {message_type}");
        })
        .await
        .expect("terminal control message timeout")
    }

    async fn wait_for_control_without_size(
        socket: &mut BrokerWebSocket,
        message_type: &str,
    ) -> serde_json::Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(message) = socket.next().await {
                match message.unwrap() {
                    TungsteniteMessage::Text(text) => {
                        let value = serde_json::from_str::<serde_json::Value>(&text).unwrap();
                        assert_ne!(
                            value["type"], "size",
                            "observer changed the terminal viewport"
                        );
                        if value["type"] == message_type {
                            return value;
                        }
                    }
                    TungsteniteMessage::Close(_) => panic!("terminal socket closed"),
                    _ => {}
                }
            }
            panic!("terminal socket ended before receiving {message_type}");
        })
        .await
        .expect("terminal control message timeout")
    }

    async fn wait_for_output(socket: &mut BrokerWebSocket, needle: &str) -> String {
        let mut output = String::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(message) = socket.next().await {
                match message.unwrap() {
                    TungsteniteMessage::Binary(bytes) => {
                        assert!(bytes.len() >= 9, "terminal frame includes its header");
                        output.push_str(&String::from_utf8_lossy(&bytes[9..]));
                        if output.contains(needle) {
                            return;
                        }
                    }
                    TungsteniteMessage::Close(_) => panic!("terminal socket closed"),
                    _ => {}
                }
            }
        })
        .await
        .expect("terminal output timeout");
        output
    }

    /// Reads a flood to its end, tolerating either outcome for a client that
    /// falls behind: the stream is delivered whole, or the server jumps it to a
    /// fresh snapshot. What must never happen is the socket being dropped.
    async fn wait_for_flooded_output(socket: &mut BrokerWebSocket, needle: &str) {
        // A flood spans megabytes across thousands of frames, so only the tail
        // is retained: rescanning everything per frame is quadratic and dwarfs
        // the behaviour under test.
        let mut output = String::new();
        tokio::time::timeout(Duration::from_secs(30), async {
            while let Some(message) = socket.next().await {
                match message.unwrap() {
                    TungsteniteMessage::Text(text) => {
                        let value = serde_json::from_str::<serde_json::Value>(&text).unwrap();
                        if value["type"] == "sync" {
                            assert_eq!(value["mode"], "snapshot");
                        }
                    }
                    TungsteniteMessage::Binary(bytes) => {
                        assert!(bytes.len() >= 9, "terminal frame includes its header");
                        output.push_str(&String::from_utf8_lossy(&bytes[9..]));
                        if output.contains(needle) {
                            return;
                        }
                        let keep = output.len().saturating_sub(needle.len() * 4 + 4096);
                        if keep > 0 && output.is_char_boundary(keep) {
                            output.drain(..keep);
                        }
                    }
                    TungsteniteMessage::Close(_) => {
                        panic!("flooded terminal socket was closed instead of recovering")
                    }
                    _ => {}
                }
            }
            panic!("terminal socket ended before the flood finished");
        })
        .await
        .expect("terminal flood recovery timeout");
    }

    #[tokio::test]
    async fn sessions_survive_web_client_reconnections() {
        let (directory, server, client) = start_test_broker(1024 * 1024).await;
        let broker = client.health().await.unwrap();
        assert_eq!(broker.build.version, build::VERSION);
        assert_eq!(broker.build.commit, build::COMMIT);
        assert_eq!(broker.sessions, 0);

        let terminal = client
            .create(CreateTerminal {
                path: Some("survivor".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".to_owned()),
                clone_from: None,
            })
            .await
            .unwrap();
        client
            .agent_event(
                terminal.id,
                &AgentEvent {
                    provider: "codex".to_owned(),
                    kind: crate::agent_events::AgentEventKind::Thinking,
                    title: None,
                },
            )
            .await
            .unwrap();
        let observed = client
            .list()
            .await
            .unwrap()
            .into_iter()
            .find(|candidate| candidate.id == terminal.id)
            .unwrap()
            .agent
            .unwrap();
        assert_eq!(observed.status, crate::terminal::AgentStatus::Working);
        assert_eq!(observed.activity.unwrap().label, "thinking");
        let mut first = client
            .terminal_socket(
                terminal.id,
                Some(TerminalViewport::new(80, 24, 800, 480)),
                None,
                false,
            )
            .await
            .unwrap();
        let size = wait_for_control(&mut first, "size").await;
        assert_eq!(
            (size["cols"].as_u64(), size["rows"].as_u64()),
            (Some(80), Some(24))
        );
        let initial_sync = wait_for_control(&mut first, "sync").await;
        assert_eq!(initial_sync["mode"], "snapshot");
        let initial_sequence = initial_sync["sequence"].as_u64().unwrap();
        let synced = wait_for_control(&mut first, "synced").await;
        assert_eq!(synced["sequence"], initial_sequence);
        first
            .send(TungsteniteMessage::Text(
                r#"{"type":"focus","focused":true}"#.into(),
            ))
            .await
            .unwrap();
        let focused = wait_for_control(&mut first, "size").await;
        assert_eq!(focused["controller"], true);
        first
            .send(TungsteniteMessage::Binary(
                b"printf 'before-restart\\n'\n".to_vec().into(),
            ))
            .await
            .unwrap();
        wait_for_output(&mut first, "before-restart").await;
        first.close(None).await.unwrap();

        let replacement_client = BrokerClient::new(legacy_socket_path(directory.path()));
        assert!(
            replacement_client
                .list()
                .await
                .unwrap()
                .iter()
                .any(|candidate| candidate.id == terminal.id)
        );
        let mut second = replacement_client
            .terminal_socket(
                terminal.id,
                Some(TerminalViewport::new(80, 24, 800, 480)),
                Some(initial_sequence),
                false,
            )
            .await
            .unwrap();
        let size = wait_for_control(&mut second, "size").await;
        assert_eq!(
            (size["cols"].as_u64(), size["rows"].as_u64()),
            (Some(80), Some(24))
        );
        let resumed = wait_for_control(&mut second, "sync").await;
        assert_eq!(resumed["mode"], "resume");
        let replay = wait_for_output(&mut second, "before-restart").await;
        assert!(replay.contains("before-restart"));
        let synced = wait_for_control(&mut second, "synced").await;
        assert!(synced["sequence"].as_u64().unwrap() > initial_sequence);
        second
            .send(TungsteniteMessage::Text(r#"{"type":"ping"}"#.into()))
            .await
            .unwrap();
        wait_for_control(&mut second, "pong").await;

        replacement_client.remove(terminal.id).await.unwrap();
        replacement_client.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("broker shutdown timeout")
            .unwrap();
    }

    #[tokio::test]
    async fn compatible_broker_generations_drain_without_moving_existing_terminals() {
        let directory = tempfile::tempdir().unwrap();
        let (legacy_server, legacy) = start_test_broker_at(
            directory.path(),
            legacy_socket_path(directory.path()),
            1024 * 1024,
        )
        .await;
        let old_terminal = legacy
            .create(CreateTerminal {
                path: Some("old-generation".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".to_owned()),
                clone_from: None,
            })
            .await
            .unwrap();
        let current_path = current_socket_path(directory.path());
        let (current_server, current) =
            start_test_broker_at(directory.path(), current_path, 1024 * 1024).await;
        let cli = Cli::try_parse_from([
            "term-server",
            "--data-dir",
            directory.path().to_str().unwrap(),
            "--shell",
            "/bin/sh",
        ])
        .unwrap();
        let pool = BrokerPool::connect_or_start(&cli, Path::new("/unused"))
            .await
            .unwrap();

        let info = pool.info().await.unwrap();
        assert_eq!(info.sessions, 1);
        assert!(info.restart_required);
        assert_eq!(info.generations.len(), 2);
        assert_eq!(
            info.generations
                .iter()
                .filter(|generation| generation.current)
                .count(),
            1
        );

        let listed = pool.list().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, old_terminal.id);
        assert_eq!(listed[0].broker.as_ref(), Some(&BuildIdentity::current()));

        let new_terminal = pool
            .create(CreateTerminal {
                path: Some("new-generation".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".to_owned()),
                clone_from: None,
            })
            .await
            .unwrap();
        assert!(
            current
                .list()
                .await
                .unwrap()
                .iter()
                .any(|terminal| terminal.id == new_terminal.id)
        );
        assert!(
            !legacy
                .list()
                .await
                .unwrap()
                .iter()
                .any(|terminal| terminal.id == new_terminal.id)
        );
        let duplicate = pool
            .create(CreateTerminal {
                path: Some("old-generation".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".to_owned()),
                clone_from: None,
            })
            .await
            .unwrap_err();
        assert_eq!(duplicate.status(), Some(StatusCode::BAD_REQUEST));
        let duplicate = pool
            .rename(
                new_terminal.id,
                RenameTerminal {
                    path: "old-generation".to_owned(),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(duplicate.status(), Some(StatusCode::BAD_REQUEST));

        let cloned = pool
            .create(CreateTerminal {
                path: Some("cloned-from-old".to_owned()),
                cwd: None,
                shell: Some("/bin/sh".to_owned()),
                clone_from: Some(old_terminal.id),
            })
            .await
            .unwrap();
        assert_eq!(cloned.cwd, PathBuf::from("/tmp"));
        assert!(
            current
                .list()
                .await
                .unwrap()
                .iter()
                .any(|terminal| terminal.id == cloned.id)
        );

        let renamed = pool
            .rename(
                old_terminal.id,
                RenameTerminal {
                    path: "renamed-old".to_owned(),
                },
            )
            .await
            .unwrap();
        assert_eq!(renamed.name, "renamed-old");
        pool.remove(old_terminal.id).await.unwrap();

        tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if legacy.health().await.is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("draining broker did not stop");
        let info = pool.info().await.unwrap();
        assert!(!info.restart_required);
        assert_eq!(info.generations.len(), 1);

        pool.remove(new_terminal.id).await.unwrap();
        pool.remove(cloned.id).await.unwrap();
        pool.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), legacy_server)
            .await
            .expect("legacy broker shutdown timeout")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), current_server)
            .await
            .expect("current broker shutdown timeout")
            .unwrap();
    }

    #[tokio::test]
    async fn observer_sockets_are_read_only_and_do_not_attach_viewports() {
        let (_directory, server, client) = start_test_broker(1024 * 1024).await;
        let terminal = client
            .create(CreateTerminal {
                path: Some("observer-test".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".to_owned()),
                clone_from: None,
            })
            .await
            .unwrap();
        let mut controller = client
            .terminal_socket(
                terminal.id,
                Some(TerminalViewport::new(120, 40, 1200, 800)),
                None,
                false,
            )
            .await
            .unwrap();
        wait_for_control(&mut controller, "size").await;
        wait_for_control(&mut controller, "sync").await;
        wait_for_control(&mut controller, "synced").await;

        let mut observer = client
            .terminal_socket(terminal.id, None, None, true)
            .await
            .unwrap();
        let size = wait_for_control(&mut observer, "size").await;
        assert_eq!(
            (size["cols"].as_u64(), size["rows"].as_u64()),
            (Some(120), Some(40))
        );
        assert_eq!(size["controller"], false);
        assert_eq!(size["responder"], false);
        wait_for_control(&mut observer, "sync").await;
        wait_for_control(&mut observer, "synced").await;
        let connected = client
            .list()
            .await
            .unwrap()
            .into_iter()
            .find(|candidate| candidate.id == terminal.id)
            .unwrap();
        assert_eq!(connected.clients, 1);

        for message in [
            r#"{"type":"resize","cols":20,"rows":5}"#,
            r#"{"type":"focus","focused":true}"#,
            r#"{"type":"input","data":"printf 'observer wrote input\\n'\n"}"#,
        ] {
            observer
                .send(TungsteniteMessage::Text(message.into()))
                .await
                .unwrap();
            let error = wait_for_control(&mut observer, "error").await;
            assert_eq!(error["message"], "observer connections are read-only");
        }
        observer
            .send(TungsteniteMessage::Binary(b"raw input".to_vec().into()))
            .await
            .unwrap();
        let error = wait_for_control(&mut observer, "error").await;
        assert_eq!(error["message"], "observer connections are read-only");

        controller
            .send(TungsteniteMessage::Text(r#"{"type":"ping"}"#.into()))
            .await
            .unwrap();
        wait_for_control_without_size(&mut controller, "pong").await;

        client.remove(terminal.id).await.unwrap();
        client.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("broker shutdown timeout")
            .unwrap();
    }

    #[tokio::test]
    async fn flooded_clients_are_paced_rather_than_resynchronized() {
        let (_directory, server, client) = start_test_broker(1024 * 1024).await;
        let terminal = client
            .create(CreateTerminal {
                path: Some("lag-test".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".to_owned()),
                clone_from: None,
            })
            .await
            .unwrap();
        let mut socket = client
            .terminal_socket(
                terminal.id,
                Some(TerminalViewport::new(80, 24, 800, 480)),
                None,
                false,
            )
            .await
            .unwrap();
        wait_for_control(&mut socket, "size").await;
        wait_for_control(&mut socket, "sync").await;
        wait_for_control(&mut socket, "synced").await;

        // A flood far larger than any buffer between the pty and the browser.
        // Acknowledging as a real browser does, flow control paces the producer,
        // so the client never falls behind and the stream is never rebuilt. This
        // used to be a test that falling behind recovered gracefully; the point
        // now is that a client keeping up does not fall behind at all.
        let command = "yes x | head -c 6000000; printf '\\nLAG-%s\\n' DONE\n";
        socket
            .send(TungsteniteMessage::Text(
                serde_json::json!({ "type": "input", "data": command })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let resyncs = drain_with_acknowledgements(&mut socket, "LAG-DONE").await;
        assert_eq!(resyncs, 0, "a client that keeps up is never resynchronized");

        socket
            .send(TungsteniteMessage::Text(r#"{"type":"ping"}"#.into()))
            .await
            .unwrap();
        wait_for_control(&mut socket, "pong").await;
        client.remove(terminal.id).await.unwrap();
        client.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("broker shutdown timeout")
            .unwrap();
    }

    #[tokio::test]
    async fn flooded_observers_recover_with_a_snapshot() {
        let (_directory, server, client) = start_test_broker(1024 * 1024).await;
        let terminal = client
            .create(CreateTerminal {
                path: Some("observer-lag".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".to_owned()),
                clone_from: None,
            })
            .await
            .unwrap();
        let mut controller = client
            .terminal_socket(
                terminal.id,
                Some(TerminalViewport::new(80, 24, 800, 480)),
                None,
                false,
            )
            .await
            .unwrap();
        wait_for_control(&mut controller, "size").await;
        wait_for_control(&mut controller, "sync").await;
        wait_for_control(&mut controller, "synced").await;
        let mut observer = client
            .terminal_socket(terminal.id, None, None, true)
            .await
            .unwrap();
        wait_for_control(&mut observer, "synced").await;

        // Observers are outside flow control, so they can still fall behind a
        // flood. That path has to keep working: the server rebuilds the stream
        // from a snapshot on the same socket instead of dropping it.
        let command = "yes x | head -c 6000000; printf '\\nOBSLAG-%s\\n' DONE\n";
        controller
            .send(TungsteniteMessage::Text(
                serde_json::json!({ "type": "input", "data": command })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let controller_drain = tokio::spawn(async move {
            drain_with_acknowledgements(&mut controller, "OBSLAG-DONE").await;
            controller
        });
        tokio::time::sleep(Duration::from_millis(250)).await;
        wait_for_flooded_output(&mut observer, "OBSLAG-DONE").await;
        let _controller = controller_drain.await.unwrap();

        client.remove(terminal.id).await.unwrap();
        client.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("broker shutdown timeout")
            .unwrap();
    }

    /// Reads terminal payload bytes until the stream stays silent for `quiet`,
    /// acknowledging nothing. Returns the total payload delivered.
    async fn read_payload_until_quiet(socket: &mut BrokerWebSocket, quiet: Duration) -> u64 {
        let mut delivered = 0_u64;
        loop {
            match tokio::time::timeout(quiet, socket.next()).await {
                Err(_) => return delivered,
                Ok(Some(Ok(TungsteniteMessage::Binary(bytes)))) => {
                    delivered += (bytes.len() - 9) as u64;
                }
                Ok(Some(Ok(TungsteniteMessage::Close(_))) | None) => {
                    panic!("terminal socket closed instead of pausing")
                }
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(error))) => panic!("terminal socket failed: {error}"),
            }
        }
    }

    /// Drains the stream to `needle`, acknowledging every frame as a browser
    /// would. Without the acknowledgements the pty stays paused and this hangs,
    /// which is what makes it a test of flow control rather than of throughput.
    /// Returns how many times the server had to resynchronize the stream.
    async fn drain_with_acknowledgements(socket: &mut BrokerWebSocket, needle: &str) -> usize {
        let mut output = String::new();
        let mut resyncs = 0;
        tokio::time::timeout(Duration::from_secs(30), async {
            while let Some(message) = socket.next().await {
                match message.unwrap() {
                    TungsteniteMessage::Text(text) => {
                        let value = serde_json::from_str::<serde_json::Value>(&text).unwrap();
                        if value["type"] == "sync" {
                            resyncs += 1;
                        }
                    }
                    TungsteniteMessage::Binary(bytes) => {
                        let payload = &bytes[9..];
                        output.push_str(&String::from_utf8_lossy(payload));
                        if output.contains(needle) {
                            return;
                        }
                        let keep = output.len().saturating_sub(needle.len() * 4 + 4096);
                        if keep > 0 && output.is_char_boundary(keep) {
                            output.drain(..keep);
                        }
                        socket
                            .send(TungsteniteMessage::Text(
                                serde_json::json!({ "type": "ack", "bytes": payload.len() })
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                    }
                    TungsteniteMessage::Close(_) => panic!("terminal socket closed while draining"),
                    _ => {}
                }
            }
            panic!("terminal socket ended before {needle}");
        })
        .await
        .expect("acknowledged drain timeout");
        resyncs
    }

    #[tokio::test]
    async fn unacknowledged_output_pauses_the_pty_until_the_browser_catches_up() {
        let (_directory, server, client) = start_test_broker(1024 * 1024).await;
        let terminal = client
            .create(CreateTerminal {
                path: Some("flow-test".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".to_owned()),
                clone_from: None,
            })
            .await
            .unwrap();
        let mut socket = client
            .terminal_socket(
                terminal.id,
                Some(TerminalViewport::new(80, 24, 800, 480)),
                None,
                false,
            )
            .await
            .unwrap();
        // A browser stays silent until the server advertises flow control, so a
        // server that supports it has to say so. Terminals keep the broker
        // generation that created them, and an older broker rejects any message
        // it does not recognize with an error the pane shows the user.
        let ready = wait_for_control(&mut socket, "ready").await;
        assert_eq!(ready["flowControl"], true);
        wait_for_control(&mut socket, "size").await;
        wait_for_control(&mut socket, "sync").await;
        wait_for_control(&mut socket, "synced").await;

        // Ask for far more output than the flow-control window and acknowledge
        // none of it. The pty read loop should stop draining the master, which
        // blocks the writing process instead of burying the browser.
        let total = 4_000_000;
        let command = format!("yes flow-control | head -c {total}; printf '\\nFLOW-%s\\n' DONE\n");
        socket
            .send(TungsteniteMessage::Text(
                serde_json::json!({ "type": "input", "data": command })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();

        // Must finish inside the stall timeout, or the server would rightly
        // decide this client is gone rather than slow and resume without it.
        let delivered = read_payload_until_quiet(&mut socket, Duration::from_millis(400)).await;
        assert!(
            delivered > 0,
            "the first window is delivered before pausing"
        );
        assert!(
            delivered < total / 2,
            "an unacknowledging client received {delivered} of {total} bytes; \
             the pty was never paused"
        );

        // Acknowledging what arrived releases the pty and the rest follows.
        socket
            .send(TungsteniteMessage::Text(
                serde_json::json!({ "type": "ack", "bytes": delivered })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        drain_with_acknowledgements(&mut socket, "FLOW-DONE").await;

        client.remove(terminal.id).await.unwrap();
        client.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("broker shutdown timeout")
            .unwrap();
    }

    #[tokio::test]
    async fn observer_sockets_never_pause_the_pty() {
        let (_directory, server, client) = start_test_broker(1024 * 1024).await;
        let terminal = client
            .create(CreateTerminal {
                path: Some("observer-flow".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".to_owned()),
                clone_from: None,
            })
            .await
            .unwrap();
        let mut controller = client
            .terminal_socket(
                terminal.id,
                Some(TerminalViewport::new(80, 24, 800, 480)),
                None,
                false,
            )
            .await
            .unwrap();
        wait_for_control(&mut controller, "size").await;
        wait_for_control(&mut controller, "sync").await;
        wait_for_control(&mut controller, "synced").await;
        // An observer that never reads a byte. A preview pane must not be able
        // to hold back the terminal it is previewing.
        let _observer = client
            .terminal_socket(terminal.id, None, None, true)
            .await
            .unwrap();

        let total = 400_000;
        let command = format!("yes observer-flow | head -c {total}; printf '\\nOBS-%s\\n' DONE\n");
        controller
            .send(TungsteniteMessage::Text(
                serde_json::json!({ "type": "input", "data": command })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();

        drain_with_acknowledgements(&mut controller, "OBS-DONE").await;

        client.remove(terminal.id).await.unwrap();
        client.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("broker shutdown timeout")
            .unwrap();
    }
}
