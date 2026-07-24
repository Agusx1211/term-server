use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
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
    sync::Notify,
};
use tokio_tungstenite::{WebSocketStream, client_async};
use uuid::Uuid;

use crate::{
    agent_events::AgentEvent,
    ai::{PiClientConfig, PiService, UpdatePiSettings},
    build,
    config::Cli,
    terminal::{
        CreateTerminal, ProcessInspectorSnapshot, RenameTerminal, TerminalInfo, TerminalManager,
    },
    workspace::{
        SessionBrokerInfo, TerminalSocketQuery, WorkspaceError as BrokerError,
        serve_terminal_socket,
    },
};

const PROTOCOL_VERSION: u32 = 2;
const SOCKET_NAME: &str = "session-broker.sock";

pub type BrokerWebSocket = WebSocketStream<UnixStream>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrokerSettings {
    default_shell: Option<String>,
    replay_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    protocol_version: u32,
    build: BrokerBuild,
    sessions: usize,
}

#[derive(Debug, Deserialize)]
struct BrokerBuild {
    version: String,
    commit: String,
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

    pub async fn connect_or_start(cli: &Cli, executable: &Path) -> Result<Self, BrokerError> {
        tokio::fs::create_dir_all(&cli.data_dir).await?;
        let client = Self::new(socket_path(&cli.data_dir));
        if client.health().await.is_err() {
            spawn_broker(cli, executable)?;
            let mut last_error = None;
            for _ in 0..50 {
                match client.health().await {
                    Ok(_) => {
                        last_error = None;
                        break;
                    }
                    Err(error) => last_error = Some(error),
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if let Some(error) = last_error {
                return Err(error);
            }
        }
        let health = client.health().await?;
        if health.protocol_version != PROTOCOL_VERSION {
            return Err(BrokerError::Protocol {
                expected: PROTOCOL_VERSION,
                actual: health.protocol_version,
            });
        }
        tracing::info!(
            broker_version = %health.build.version,
            broker_commit = %health.build.commit,
            sessions = health.sessions,
            socket = %client.socket_path.display(),
            "connected to terminal session broker"
        );
        client
            .configure(cli.shell.clone(), cli.replay_bytes())
            .await?;
        Ok(client)
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
        initial_size: Option<(u16, u16)>,
    ) -> Result<BrokerWebSocket, BrokerError> {
        let stream = UnixStream::connect(self.socket_path.as_ref()).await?;
        let query = initial_size
            .map(|(cols, rows)| format!("?cols={cols}&rows={rows}"))
            .unwrap_or_default();
        let (socket, _) = client_async(
            format!("ws://localhost/terminals/{id}/socket{query}"),
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

    pub async fn info(&self) -> Result<SessionBrokerInfo, BrokerError> {
        let health = self.health().await?;
        let restart_required =
            health.build.version != build::VERSION || health.build.commit != build::COMMIT;
        Ok(SessionBrokerInfo {
            version: health.build.version,
            commit: health.build.commit,
            sessions: health.sessions,
            restart_required,
        })
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

fn remote_error(status: StatusCode, bytes: &[u8]) -> BrokerError {
    let message = serde_json::from_slice::<ErrorResponse>(bytes)
        .map(|response| response.error)
        .unwrap_or_else(|_| format!("session broker request failed ({status})"));
    BrokerError::Remote { status, message }
}

fn spawn_broker(cli: &Cli, executable: &Path) -> Result<(), BrokerError> {
    let mut command = Command::new(executable);
    command
        .arg("--session-broker")
        .arg("--data-dir")
        .arg(&cli.data_dir)
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

fn socket_path(data_directory: &Path) -> PathBuf {
    data_directory.join(SOCKET_NAME)
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
    default_shell: Option<String>,
    replay_bytes: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    tokio::fs::create_dir_all(data_directory).await?;
    let path = socket_path(data_directory);
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
        .route(
            "/terminals/{id}/agent-event",
            post(broker_terminal_agent_event),
        )
        .route("/terminals/{id}/socket", any(broker_terminal_socket))
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
        .on_upgrade(move |socket| serve_terminal_socket(socket, terminal, query.viewport())))
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

    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

    use super::*;

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

    async fn wait_for_output(socket: &mut BrokerWebSocket, needle: &str) -> String {
        let mut output = String::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(message) = socket.next().await {
                match message.unwrap() {
                    TungsteniteMessage::Binary(bytes) => {
                        output.push_str(&String::from_utf8_lossy(&bytes));
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

    #[tokio::test]
    async fn sessions_survive_web_client_reconnections() {
        let directory = tempfile::tempdir().unwrap();
        let data_directory = directory.path().to_path_buf();
        let server = tokio::spawn(async move {
            run_session_broker(&data_directory, Some("/bin/sh".to_owned()), 1024 * 1024)
                .await
                .unwrap();
        });
        let client = BrokerClient::new(socket_path(directory.path()));
        for _ in 0..50 {
            if client.health().await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let broker = client.info().await.unwrap();
        assert_eq!(broker.version, build::VERSION);
        assert_eq!(broker.commit, build::COMMIT);
        assert_eq!(broker.sessions, 0);
        assert!(!broker.restart_required);

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
            .terminal_socket(terminal.id, Some((80, 24)))
            .await
            .unwrap();
        let size = wait_for_control(&mut first, "size").await;
        assert_eq!(
            (size["cols"].as_u64(), size["rows"].as_u64()),
            (Some(80), Some(24))
        );
        first
            .send(TungsteniteMessage::Text(
                r#"{"type":"focus","focused":true}"#.into(),
            ))
            .await
            .unwrap();
        let focused = wait_for_control(&mut first, "size").await;
        assert_eq!(focused["controller"], true);
        first
            .send(TungsteniteMessage::Text(
                r#"{"type":"input","data":"printf 'before-restart\\n'\n"}"#.into(),
            ))
            .await
            .unwrap();
        wait_for_output(&mut first, "before-restart").await;
        first.close(None).await.unwrap();

        let replacement_client = BrokerClient::new(socket_path(directory.path()));
        assert!(
            replacement_client
                .list()
                .await
                .unwrap()
                .iter()
                .any(|candidate| candidate.id == terminal.id)
        );
        let mut second = replacement_client
            .terminal_socket(terminal.id, Some((80, 24)))
            .await
            .unwrap();
        let replay = wait_for_output(&mut second, "before-restart").await;
        assert!(replay.contains("before-restart"));

        replacement_client.remove(terminal.id).await.unwrap();
        replacement_client.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("broker shutdown timeout")
            .unwrap();
    }
}
