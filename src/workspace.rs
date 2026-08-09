use std::{sync::Arc, time::Duration};

use axum::{
    extract::ws::{Message, WebSocket},
    http::StatusCode,
};
use base64::Engine as _;
use bytes::Bytes;
use futures_util::{Sink, SinkExt, StreamExt, stream::SplitSink};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    ai::{PiClientConfig, PiService, UpdatePiSettings},
    debug_recording::DebugRecordingManager,
    terminal::{
        CreateTerminal, ProcessInspectorSnapshot, ProcessSignalError, RenameTerminal,
        TerminalError, TerminalEvent, TerminalInfo, TerminalManager, TerminalSession,
        TerminalSizeState, TerminalViewport, terminate_descendant_process,
    },
    terminal_state::{SequencedOutput, SyncMode, TerminalResume, TerminalSync},
};

/// Bumped to 3 for flow control. A browser on the old protocol never
/// acknowledges output, so it has to be turned away and reloaded rather than
/// attached: it would otherwise leave the pty paused against acknowledgements
/// that are never coming.
pub(crate) const TERMINAL_STREAM_PROTOCOL: u8 = 3;

const TERMINAL_FRAME_HEADER_BYTES: usize = 9;
const TERMINAL_FRAME_PAYLOAD_BYTES: usize = 60 * 1024;
const TERMINAL_FRAME_SNAPSHOT: u8 = 0;
const TERMINAL_FRAME_OUTPUT: u8 = 1;
const TERMINAL_SEND_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_INPUT_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_INPUT_RETRY_INTERVAL: Duration = Duration::from_millis(5);
const TERMINAL_CHECKPOINT_CHUNK_BYTES: usize = 32 * 1024;
const TERMINAL_CHECKPOINT_CHUNK_BASE64_BYTES: usize =
    TERMINAL_CHECKPOINT_CHUNK_BYTES.div_ceil(3) * 4;
const TERMINAL_CLIENT_LEASE: Duration = Duration::from_secs(90);
const TERMINAL_LEASE_CHECK_INTERVAL: Duration = Duration::from_secs(15);
/// A pty master returns at most one 4 KiB chunk per read, so a full-screen TUI
/// redraw reaches this loop as hundreds of tiny events. Merging whatever is
/// already queued into one frame keeps a burst to a few dozen websocket
/// messages, which the browser can hand to its parser in far fewer turns.
const TERMINAL_OUTPUT_COALESCE_BYTES: usize = 60 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrokerGenerationInfo {
    pub version: String,
    pub commit: String,
    pub sessions: usize,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrokerInfo {
    pub version: String,
    pub commit: String,
    pub sessions: usize,
    pub restart_required: bool,
    pub generations: Vec<SessionBrokerGenerationInfo>,
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("terminal workspace is unavailable: {0}")]
    Unavailable(String),
    #[error("session broker protocol {actual} is incompatible with expected protocol {expected}")]
    Protocol { expected: u32, actual: u32 },
    #[error("{message}")]
    Remote { status: StatusCode, message: String },
}

impl WorkspaceError {
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            Self::Remote { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl From<std::io::Error> for WorkspaceError {
    fn from(error: std::io::Error) -> Self {
        Self::Unavailable(error.to_string())
    }
}

#[derive(Clone)]
pub enum WorkspaceBackend {
    Local {
        terminals: Arc<TerminalManager>,
        pi: Arc<PiService>,
    },
    #[cfg(unix)]
    Broker(Arc<crate::broker::BrokerPool>),
}

pub enum SessionConnection {
    Local(Arc<TerminalSession>),
    #[cfg(unix)]
    Broker(Box<crate::broker::BrokerWebSocket>),
}

impl WorkspaceBackend {
    pub fn local(terminals: Arc<TerminalManager>, pi: Arc<PiService>) -> Self {
        Self::Local { terminals, pi }
    }

    #[cfg(unix)]
    pub fn broker(pool: Arc<crate::broker::BrokerPool>) -> Self {
        Self::Broker(pool)
    }

    pub async fn list(&self) -> Result<Vec<TerminalInfo>, WorkspaceError> {
        match self {
            Self::Local { terminals, .. } => Ok(terminals.list()),
            #[cfg(unix)]
            Self::Broker(client) => client.list().await,
        }
    }

    pub async fn create(&self, request: CreateTerminal) -> Result<TerminalInfo, WorkspaceError> {
        match self {
            Self::Local { terminals, .. } => {
                let terminals = terminals.clone();
                tokio::task::spawn_blocking(move || terminals.create(request))
                    .await
                    .map_err(|error| WorkspaceError::Unavailable(error.to_string()))?
                    .map_err(|error| WorkspaceError::Remote {
                        status: StatusCode::BAD_REQUEST,
                        message: error.to_string(),
                    })
            }
            #[cfg(unix)]
            Self::Broker(client) => client.create(request).await,
        }
    }

    pub async fn rename(
        &self,
        id: Uuid,
        request: RenameTerminal,
    ) -> Result<TerminalInfo, WorkspaceError> {
        match self {
            Self::Local { terminals, .. } => terminals
                .rename(id, &request.path)
                .map_err(|error| WorkspaceError::Remote {
                    status: StatusCode::BAD_REQUEST,
                    message: error.to_string(),
                })?
                .ok_or_else(|| WorkspaceError::Remote {
                    status: StatusCode::NOT_FOUND,
                    message: "terminal not found".to_owned(),
                }),
            #[cfg(unix)]
            Self::Broker(client) => client.rename(id, request).await,
        }
    }

    pub async fn remove(&self, id: Uuid) -> Result<(), WorkspaceError> {
        match self {
            Self::Local { terminals, .. } if terminals.remove(id) => Ok(()),
            Self::Local { .. } => Err(WorkspaceError::Remote {
                status: StatusCode::NOT_FOUND,
                message: "terminal not found".to_owned(),
            }),
            #[cfg(unix)]
            Self::Broker(client) => client.remove(id).await,
        }
    }

    pub async fn process_inspector(
        &self,
        id: Uuid,
    ) -> Result<ProcessInspectorSnapshot, WorkspaceError> {
        match self {
            Self::Local { terminals, .. } => terminals
                .get(id)
                .map(|terminal| terminal.process_inspector())
                .ok_or_else(|| WorkspaceError::Remote {
                    status: StatusCode::NOT_FOUND,
                    message: "terminal not found".to_owned(),
                }),
            #[cfg(unix)]
            Self::Broker(client) => client.process_inspector(id).await,
        }
    }

    pub async fn agent_explain(
        &self,
        id: Uuid,
    ) -> Result<crate::terminal::AgentDetectionExplain, WorkspaceError> {
        match self {
            Self::Local { terminals, .. } => terminals
                .get(id)
                .map(|terminal| terminal.agent_explain())
                .ok_or_else(|| WorkspaceError::Remote {
                    status: StatusCode::NOT_FOUND,
                    message: "terminal not found".to_owned(),
                }),
            #[cfg(unix)]
            Self::Broker(client) => client.agent_explain(id).await,
        }
    }

    pub async fn terminate_process(
        &self,
        id: Uuid,
        process_id: &str,
    ) -> Result<(), WorkspaceError> {
        match self {
            Self::Local { terminals, .. } => terminals
                .get(id)
                .ok_or_else(|| WorkspaceError::Remote {
                    status: StatusCode::NOT_FOUND,
                    message: "terminal not found".to_owned(),
                })?
                .terminate_process(process_id)
                .map_err(process_signal_error),
            #[cfg(unix)]
            Self::Broker(client) => {
                let snapshot = client.process_inspector(id).await?;
                if !snapshot
                    .processes
                    .iter()
                    .any(|process| process.id == process_id)
                {
                    return Err(process_signal_error(ProcessSignalError::NotFound));
                }
                let shell_pid = client
                    .list()
                    .await?
                    .into_iter()
                    .find(|terminal| terminal.id == id)
                    .and_then(|terminal| terminal.pid)
                    .ok_or_else(|| process_signal_error(ProcessSignalError::NotFound))?;
                terminate_descendant_process(shell_pid, process_id).map_err(process_signal_error)
            }
        }
    }

    pub async fn pi_config(&self) -> Result<PiClientConfig, WorkspaceError> {
        match self {
            Self::Local { pi, .. } => Ok(pi.client_config()),
            #[cfg(unix)]
            Self::Broker(client) => client.pi_config().await,
        }
    }

    pub async fn broker_info(&self) -> Result<Option<SessionBrokerInfo>, WorkspaceError> {
        match self {
            Self::Local { .. } => Ok(None),
            #[cfg(unix)]
            Self::Broker(client) => client.info().await.map(Some),
        }
    }

    pub async fn update_pi(
        &self,
        settings: UpdatePiSettings,
    ) -> Result<PiClientConfig, WorkspaceError> {
        match self {
            Self::Local { pi, .. } => {
                pi.update(settings)
                    .map_err(|message| WorkspaceError::Remote {
                        status: StatusCode::BAD_REQUEST,
                        message,
                    })
            }
            #[cfg(unix)]
            Self::Broker(client) => client.update_pi(settings).await,
        }
    }

    pub async fn connect_terminal(
        &self,
        id: Uuid,
        initial_size: Option<TerminalViewport>,
        resume: Option<TerminalResume>,
        observer: bool,
    ) -> Result<SessionConnection, WorkspaceError> {
        match self {
            Self::Local { terminals, .. } => terminals
                .get(id)
                .map(SessionConnection::Local)
                .ok_or_else(|| WorkspaceError::Remote {
                    status: StatusCode::NOT_FOUND,
                    message: "terminal not found".to_owned(),
                }),
            #[cfg(unix)]
            Self::Broker(client) => client
                .terminal_socket(id, initial_size, resume, observer)
                .await
                .map(Box::new)
                .map(SessionConnection::Broker),
        }
    }

    pub async fn shutdown(&self) {
        match self {
            Self::Local { terminals, .. } => terminals.shutdown(),
            #[cfg(unix)]
            Self::Broker(client) => {
                if let Err(error) = client.shutdown().await {
                    tracing::warn!(%error, "unable to stop terminal session broker");
                }
            }
        }
    }
}

fn process_signal_error(error: ProcessSignalError) -> WorkspaceError {
    let status = match error {
        ProcessSignalError::Unsupported => StatusCode::BAD_REQUEST,
        ProcessSignalError::NotFound => StatusCode::NOT_FOUND,
        ProcessSignalError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    WorkspaceError::Remote {
        status,
        message: error.to_string(),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct TerminalSocketQuery {
    cols: Option<u16>,
    rows: Option<u16>,
    #[serde(rename = "pixelWidth")]
    pixel_width: Option<u16>,
    #[serde(rename = "pixelHeight")]
    pixel_height: Option<u16>,
    sequence: Option<u64>,
    epoch: Option<u64>,
    stream: Option<u8>,
    #[serde(default)]
    observer: bool,
}

impl TerminalSocketQuery {
    pub(crate) fn viewport(&self) -> Option<TerminalViewport> {
        self.cols.zip(self.rows).map(|(cols, rows)| {
            TerminalViewport::new(
                cols,
                rows,
                self.pixel_width.unwrap_or(0),
                self.pixel_height.unwrap_or(0),
            )
        })
    }

    pub(crate) fn resume(&self) -> Option<TerminalResume> {
        self.sequence
            .zip(self.epoch)
            .map(|(sequence, epoch)| TerminalResume { sequence, epoch })
    }

    pub(crate) fn stream_protocol(&self) -> Option<u8> {
        self.stream
    }

    pub(crate) fn observer(&self) -> bool {
        self.observer
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum TerminalClientMessage {
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
        #[serde(rename = "pixelWidth", default)]
        pixel_width: u16,
        #[serde(rename = "pixelHeight", default)]
        pixel_height: u16,
    },
    Focus {
        focused: bool,
    },
    /// The pane is cached: still mounted and still streaming, but off screen.
    /// It keeps the connection so that coming back costs nothing, and gives up
    /// its say in the negotiated size until it reports a viewport again.
    Release,
    /// Bytes this browser's parser has consumed since the last acknowledgement.
    Ack {
        bytes: u64,
    },
    /// One bounded chunk of an official xterm.js serialization. Chunks are
    /// ordered and assembled per socket because browser WebSocket messages are
    /// deliberately capped at 64 KiB.
    Checkpoint {
        sequence: u64,
        epoch: u64,
        offset: usize,
        data: String,
        #[serde(rename = "final")]
        final_chunk: bool,
    },
    Ping,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum TerminalServerMessage<'a> {
    Ready {
        terminal: Box<TerminalInfo>,
        /// Advertises that this server understands `ack`. A browser must not
        /// acknowledge output until it has seen this: terminals stay on the
        /// broker generation that created them, so a current browser routinely
        /// talks to an older broker, and that broker answers any message it does
        /// not recognize with an error the pane surfaces to the user.
        #[serde(rename = "flowControl")]
        flow_control: bool,
        /// Advertises that this server understands `release`, and therefore
        /// that a pane may hold its connection open once it is cached. Carries
        /// the same caveat as `flowControl`: an older broker would answer the
        /// message with an error the pane surfaces to the user, so a browser
        /// must keep closing cached sockets until it has seen this.
        #[serde(rename = "viewportRelease")]
        viewport_release: bool,
        /// Maximum decoded size of an xterm checkpoint. Its presence is also
        /// the feature negotiation that lets new browsers stay silent when a
        /// terminal belongs to an older broker generation.
        #[serde(rename = "checkpointBytes")]
        checkpoint_bytes: usize,
    },
    Exit {
        #[serde(rename = "exitCode")]
        exit_code: u32,
    },
    Size {
        cols: u16,
        rows: u16,
        focused: bool,
        controller: bool,
        responder: bool,
        epoch: u64,
    },
    Sync {
        mode: &'a str,
        sequence: u64,
    },
    Synced {
        sequence: u64,
    },
    Pong,
    Error {
        message: &'a str,
    },
}

struct Attachment {
    terminal: Arc<TerminalSession>,
    client_id: Uuid,
}

#[derive(Debug)]
struct PendingCheckpoint {
    sequence: u64,
    epoch: u64,
    bytes: Vec<u8>,
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.terminal.flow_detach();
        self.terminal.detach(self.client_id);
    }
}

fn size_message(state: TerminalSizeState, client_id: Uuid) -> TerminalServerMessage<'static> {
    TerminalServerMessage::Size {
        cols: state.cols,
        rows: state.rows,
        focused: state.focused_client.is_some(),
        controller: state.focused_client == Some(client_id),
        responder: state.responder_client == Some(client_id),
        epoch: state.epoch,
    }
}

pub(crate) async fn serve_terminal_socket(
    mut socket: WebSocket,
    terminal: Arc<TerminalSession>,
    initial_size: Option<TerminalViewport>,
    requested: Option<TerminalResume>,
    observer: bool,
    recorder: Option<&DebugRecordingManager>,
) {
    let client_id = Uuid::new_v4();
    let terminal_id = terminal.info().id;
    if let Some(recorder) = recorder {
        recorder.connect(&terminal_id);
        recorder.note(
            &terminal_id,
            if observer {
                "observer attached"
            } else {
                "client attached"
            },
        );
    }
    let _attachment = if observer {
        None
    } else {
        if let Err(error) = terminal.attach(client_id, initial_size) {
            terminal.detach(client_id);
            tracing::debug!(%error, "initial terminal resize failed");
            return;
        }
        // Only real clients gate the pty. A preview pane observes whatever the
        // terminal produces and is never allowed to slow it down.
        terminal.flow_attach();
        Some(Attachment {
            terminal: terminal.clone(),
            client_id,
        })
    };
    let ready = serde_json::to_string(&TerminalServerMessage::Ready {
        terminal: Box::new(terminal.info()),
        flow_control: true,
        viewport_release: true,
        checkpoint_bytes: terminal.checkpoint_maximum_bytes(),
    })
    .expect("serializable terminal");
    if send_socket_message(&mut socket, Message::Text(ready.into()))
        .await
        .is_err()
    {
        return;
    }
    let (mut sender, mut receiver) = socket.split();
    let Ok(Some((mut events, mut sent_sequence))) =
        synchronize_terminal(&mut sender, &terminal, client_id, requested, recorder).await
    else {
        return;
    };
    let mut last_client_message = tokio::time::Instant::now();
    let mut lease_check = tokio::time::interval(TERMINAL_LEASE_CHECK_INTERVAL);
    lease_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Holds the one event that ended a coalescing run, so merging output never
    // reorders the size, exit, or lag notices that follow it.
    let mut deferred: Option<Result<TerminalEvent, tokio::sync::broadcast::error::RecvError>> =
        None;
    let mut checkpoint: Option<PendingCheckpoint> = None;
    let client = TerminalClientContext {
        terminal: &terminal,
        client_id,
        terminal_id,
        observer,
        recorder,
    };
    loop {
        let event = match deferred.take() {
            Some(event) => event,
            None => tokio::select! {
                _ = lease_check.tick() => {
                    if last_client_message.elapsed() > TERMINAL_CLIENT_LEASE {
                        tracing::debug!(%client_id, "terminal client lease expired");
                        break;
                    }
                    continue;
                }
                event = events.recv() => event,
                incoming = receiver.next() => {
                    let Some(Ok(message)) = incoming else { break; };
                    last_client_message = tokio::time::Instant::now();
                    if handle_client_message(
                        message,
                        &mut sender,
                        client,
                        &mut checkpoint,
                    ).await.is_err() { break; }
                    continue;
                }
            },
        };
        match event {
            Ok(TerminalEvent::Output(output)) => {
                if output.end_sequence() <= sent_sequence {
                    continue;
                }
                if output.sequence > sent_sequence {
                    tracing::debug!(
                        expected_sequence = sent_sequence,
                        output_sequence = output.sequence,
                        "terminal stream gap detected; sending current snapshot"
                    );
                    match synchronize_terminal(&mut sender, &terminal, client_id, None, recorder)
                        .await
                    {
                        Ok(Some((next_events, sequence))) => {
                            events = next_events;
                            sent_sequence = sequence;
                        }
                        Ok(None) | Err(()) => break,
                    }
                    continue;
                }
                let Some(output) = output.slice_from(sent_sequence) else {
                    continue;
                };
                let output = coalesce_terminal_output(output, &mut events, &mut deferred);
                if send_terminal_output(&mut sender, &output, terminal_id, recorder)
                    .await
                    .is_err()
                {
                    break;
                }
                sent_sequence = output.end_sequence();
            }
            Ok(TerminalEvent::Exit(exit_code)) => {
                if let Some(recorder) = recorder {
                    recorder.control(
                        &terminal_id,
                        serde_json::json!({ "type": "exit", "exit_code": exit_code }),
                    );
                }
                let message = serde_json::to_string(&TerminalServerMessage::Exit { exit_code })
                    .expect("serializable exit");
                let _ = send_socket_message(&mut sender, Message::Text(message.into())).await;
                break;
            }
            Ok(TerminalEvent::Size(size)) => {
                if let Some(recorder) = recorder {
                    recorder.control(&terminal_id, serde_json::json!({ "type": "size", "cols": size.cols, "rows": size.rows, "focused": size.focused_client.is_some(), "controller": size.focused_client == Some(client_id), "responder": size.responder_client == Some(client_id), "epoch": size.epoch }));
                }
                let message = serde_json::to_string(&size_message(size, client_id))
                    .expect("serializable terminal size");
                if send_socket_message(&mut sender, Message::Text(message.into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                tracing::debug!(
                    skipped,
                    sent_sequence,
                    "terminal stream lagged; sending current snapshot"
                );
                match synchronize_terminal(&mut sender, &terminal, client_id, None, recorder).await
                {
                    Ok(Some((next_events, sequence))) => {
                        events = next_events;
                        sent_sequence = sequence;
                    }
                    Ok(None) | Err(()) => break,
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
    if let Some(recorder) = recorder {
        recorder.disconnect(&terminal_id, "socket closed");
    }
}

/// Merges the output events already queued behind `output` into a single frame.
/// Stops at the coalescing budget, at a gap, or at the first non-output event,
/// which is handed back through `deferred` so the caller processes it next.
fn coalesce_terminal_output(
    output: SequencedOutput,
    events: &mut tokio::sync::broadcast::Receiver<TerminalEvent>,
    deferred: &mut Option<Result<TerminalEvent, tokio::sync::broadcast::error::RecvError>>,
) -> SequencedOutput {
    use tokio::sync::broadcast::error::{RecvError, TryRecvError};

    let mut merged: Option<Vec<u8>> = None;
    let mut end = output.end_sequence();
    while end - output.sequence < TERMINAL_OUTPUT_COALESCE_BYTES as u64 {
        match events.try_recv() {
            Ok(TerminalEvent::Output(next)) => {
                if next.end_sequence() <= end {
                    continue;
                }
                if next.sequence > end {
                    // A gap, which only the caller's snapshot recovery can close.
                    deferred.replace(Ok(TerminalEvent::Output(next)));
                    break;
                }
                let Some(next) = next.slice_from(end) else {
                    continue;
                };
                end = next.end_sequence();
                merged
                    .get_or_insert_with(|| output.bytes.to_vec())
                    .extend_from_slice(&next.bytes);
            }
            Ok(other) => {
                deferred.replace(Ok(other));
                break;
            }
            Err(TryRecvError::Lagged(skipped)) => {
                deferred.replace(Err(RecvError::Lagged(skipped)));
                break;
            }
            Err(TryRecvError::Closed) => {
                deferred.replace(Err(RecvError::Closed));
                break;
            }
            Err(TryRecvError::Empty) => break,
        }
    }
    match merged {
        Some(bytes) => SequencedOutput {
            sequence: output.sequence,
            bytes: bytes.into(),
        },
        None => output,
    }
}

#[derive(Clone, Copy)]
struct TerminalClientContext<'a> {
    terminal: &'a TerminalSession,
    client_id: Uuid,
    terminal_id: Uuid,
    observer: bool,
    recorder: Option<&'a DebugRecordingManager>,
}

async fn handle_client_message(
    message: Message,
    sender: &mut SplitSink<WebSocket, Message>,
    client: TerminalClientContext<'_>,
    checkpoint: &mut Option<PendingCheckpoint>,
) -> Result<(), ()> {
    let TerminalClientContext {
        terminal,
        client_id,
        terminal_id,
        observer,
        recorder,
    } = client;
    macro_rules! send_or_stop {
        ($message:expr) => {
            if send_socket_message(sender, $message).await.is_err() {
                return Err(());
            }
        };
    }
    match message {
        Message::Text(text) => match serde_json::from_str::<TerminalClientMessage>(&text) {
            Ok(TerminalClientMessage::Ping) => {
                let pong =
                    serde_json::to_string(&TerminalServerMessage::Pong).expect("serializable pong");
                send_or_stop!(Message::Text(pong.into()));
            }
            // Acknowledgements are read-only, so observers are not rejected for
            // sending them. An observer never registered, and acknowledging an
            // unregistered client is a no-op.
            Ok(TerminalClientMessage::Ack { bytes }) => {
                terminal.flow_acknowledged(bytes);
            }
            Ok(_) if observer => {
                let error = serde_json::to_string(&TerminalServerMessage::Error {
                    message: "observer connections are read-only",
                })
                .expect("serializable error");
                send_or_stop!(Message::Text(error.into()));
            }
            Ok(TerminalClientMessage::Input { data }) if data.len() <= 64 * 1024 => {
                if let Some(recorder) = recorder {
                    recorder.input(&terminal_id, data.as_bytes());
                }
                forward_terminal_input(sender, terminal, data.as_bytes(), terminal_id, recorder)
                    .await?;
            }
            Ok(TerminalClientMessage::Resize {
                cols,
                rows,
                pixel_width,
                pixel_height,
            }) => {
                if let Some(recorder) = recorder {
                    recorder.resize(&terminal_id, cols, rows, pixel_width, pixel_height);
                }
                terminal
                    .resize_client(client_id, cols, rows, pixel_width, pixel_height)
                    .map_err(|_| ())?;
            }
            Ok(TerminalClientMessage::Focus { focused }) => {
                terminal.focus_client(client_id, focused).map_err(|_| ())?;
            }
            Ok(TerminalClientMessage::Release) => {
                if let Some(recorder) = recorder {
                    recorder.note(&terminal_id, "client viewport released");
                }
                terminal.release_client(client_id).map_err(|_| ())?;
            }
            Ok(TerminalClientMessage::Checkpoint {
                sequence,
                epoch,
                offset,
                data,
                final_chunk,
            }) => match append_checkpoint(
                checkpoint,
                terminal,
                sequence,
                epoch,
                offset,
                &data,
                final_chunk,
            ) {
                Ok(true) => {
                    if let Some(recorder) = recorder {
                        recorder.note(&terminal_id, "xterm checkpoint stored");
                    }
                }
                Ok(false) => {}
                Err(message) => {
                    let error = serde_json::to_string(&TerminalServerMessage::Error { message })
                        .expect("serializable error");
                    send_or_stop!(Message::Text(error.into()));
                }
            },
            _ => {
                let error = serde_json::to_string(&TerminalServerMessage::Error {
                    message: "invalid terminal message",
                })
                .expect("serializable error");
                send_or_stop!(Message::Text(error.into()));
            }
        },
        Message::Binary(_) if observer => {
            let error = serde_json::to_string(&TerminalServerMessage::Error {
                message: "observer connections are read-only",
            })
            .expect("serializable error");
            send_or_stop!(Message::Text(error.into()));
        }
        Message::Binary(data) if !data.is_empty() => {
            if let Some(recorder) = recorder {
                recorder.input(&terminal_id, &data);
            }
            forward_terminal_input(sender, terminal, &data, terminal_id, recorder).await?;
        }
        Message::Close(_) => return Err(()),
        Message::Ping(payload) => {
            send_or_stop!(Message::Pong(payload));
        }
        _ => {}
    }
    Ok(())
}

/// Appends one base64 checkpoint chunk. WebSocket ordering makes an offset
/// sufficient to reject missing, duplicated, or interleaved chunks, and the
/// terminal's replay budget bounds the assembly before it is retained.
fn append_checkpoint(
    pending: &mut Option<PendingCheckpoint>,
    terminal: &TerminalSession,
    sequence: u64,
    epoch: u64,
    offset: usize,
    data: &str,
    final_chunk: bool,
) -> Result<bool, &'static str> {
    if offset == 0 {
        *pending = Some(PendingCheckpoint {
            sequence,
            epoch,
            bytes: Vec::new(),
        });
    }
    let maximum = terminal.checkpoint_maximum_bytes();
    let Some(current) = pending.as_mut() else {
        return Err("terminal checkpoint is missing its first chunk");
    };
    if current.sequence != sequence || current.epoch != epoch || current.bytes.len() != offset {
        *pending = None;
        return Err("terminal checkpoint chunks are out of order");
    }
    if data.len() > TERMINAL_CHECKPOINT_CHUNK_BASE64_BYTES {
        *pending = None;
        return Err("terminal checkpoint chunk exceeds the message limit");
    }
    let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(data) else {
        *pending = None;
        return Err("terminal checkpoint contains invalid data");
    };
    if decoded.len() > TERMINAL_CHECKPOINT_CHUNK_BYTES {
        *pending = None;
        return Err("terminal checkpoint chunk exceeds the message limit");
    }
    if current.bytes.len().saturating_add(decoded.len()) > maximum {
        *pending = None;
        return Err("terminal checkpoint exceeds the replay limit");
    }
    current.bytes.extend_from_slice(&decoded);
    if !final_chunk {
        return Ok(false);
    }
    let completed = pending.take().expect("checkpoint assembly exists");
    Ok(terminal.store_browser_checkpoint(
        completed.sequence,
        completed.epoch,
        Bytes::from(completed.bytes),
    ))
}

async fn write_terminal_input(
    terminal: &TerminalSession,
    data: &[u8],
) -> Result<(), TerminalError> {
    let deadline = tokio::time::Instant::now() + TERMINAL_INPUT_WAIT_TIMEOUT;
    loop {
        match terminal.write(data) {
            Err(TerminalError::InputQueueFull) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(TERMINAL_INPUT_RETRY_INTERVAL).await;
            }
            result => return result,
        }
    }
}

async fn forward_terminal_input(
    sender: &mut SplitSink<WebSocket, Message>,
    terminal: &TerminalSession,
    data: &[u8],
    terminal_id: Uuid,
    recorder: Option<&DebugRecordingManager>,
) -> Result<(), ()> {
    let Err(error) = write_terminal_input(terminal, data).await else {
        return Ok(());
    };
    tracing::debug!(%error, "terminal input failed");
    let recoverable = matches!(
        error,
        TerminalError::InputQueueFull | TerminalError::InputTooLarge
    );
    let message = error.to_string();
    send_terminal_control(
        sender,
        TerminalServerMessage::Error { message: &message },
        terminal_id,
        recorder,
    )
    .await?;
    if recoverable { Ok(()) } else { Err(()) }
}

async fn synchronize_terminal(
    sender: &mut SplitSink<WebSocket, Message>,
    terminal: &TerminalSession,
    client_id: Uuid,
    requested: Option<TerminalResume>,
    recorder: Option<&DebugRecordingManager>,
) -> Result<Option<(tokio::sync::broadcast::Receiver<TerminalEvent>, u64)>, ()> {
    let terminal_id = terminal.info().id;
    let (events, sync, size, exit_code) = terminal.subscribe(requested);
    send_terminal_control(sender, size_message(size, client_id), terminal_id, recorder).await?;
    let sequence = send_terminal_sync(sender, sync, terminal_id, recorder).await?;
    if let Some(exit_code) = exit_code {
        send_terminal_control(
            sender,
            TerminalServerMessage::Exit { exit_code },
            terminal_id,
            recorder,
        )
        .await?;
        return Ok(None);
    }
    Ok(Some((events, sequence)))
}

async fn send_terminal_sync(
    sender: &mut SplitSink<WebSocket, Message>,
    sync: TerminalSync,
    terminal_id: Uuid,
    recorder: Option<&DebugRecordingManager>,
) -> Result<u64, ()> {
    let mode = match sync.mode {
        SyncMode::Snapshot => "snapshot",
        SyncMode::Resume => "resume",
    };
    send_terminal_control(
        sender,
        TerminalServerMessage::Sync {
            mode,
            sequence: sync.sequence,
        },
        terminal_id,
        recorder,
    )
    .await?;
    if let Some(snapshot) = sync.snapshot {
        send_terminal_bytes(
            sender,
            TERMINAL_FRAME_SNAPSHOT,
            sync.sequence,
            &snapshot,
            terminal_id,
            recorder,
        )
        .await?;
    }
    for output in sync.output {
        send_terminal_output(sender, &output, terminal_id, recorder).await?;
    }
    send_terminal_control(
        sender,
        TerminalServerMessage::Synced {
            sequence: sync.sequence,
        },
        terminal_id,
        recorder,
    )
    .await?;
    Ok(sync.sequence)
}

async fn send_terminal_output(
    sender: &mut SplitSink<WebSocket, Message>,
    output: &SequencedOutput,
    terminal_id: Uuid,
    recorder: Option<&DebugRecordingManager>,
) -> Result<(), ()> {
    send_terminal_bytes(
        sender,
        TERMINAL_FRAME_OUTPUT,
        output.sequence,
        &output.bytes,
        terminal_id,
        recorder,
    )
    .await
}

async fn send_terminal_bytes(
    sender: &mut SplitSink<WebSocket, Message>,
    kind: u8,
    mut sequence: u64,
    bytes: &[u8],
    terminal_id: Uuid,
    recorder: Option<&DebugRecordingManager>,
) -> Result<(), ()> {
    if let Some(recorder) = recorder {
        match kind {
            TERMINAL_FRAME_SNAPSHOT => recorder.snapshot(&terminal_id, sequence, bytes),
            TERMINAL_FRAME_OUTPUT => recorder.output(&terminal_id, sequence, bytes),
            _ => {}
        }
    }
    for chunk in bytes.chunks(TERMINAL_FRAME_PAYLOAD_BYTES) {
        let mut frame = Vec::with_capacity(TERMINAL_FRAME_HEADER_BYTES + chunk.len());
        frame.push(kind);
        frame.extend_from_slice(&sequence.to_be_bytes());
        frame.extend_from_slice(chunk);
        send_socket_message(sender, Message::Binary(frame.into())).await?;
        if kind == TERMINAL_FRAME_OUTPUT {
            sequence += chunk.len() as u64;
        }
    }
    Ok(())
}

async fn send_terminal_control(
    sender: &mut SplitSink<WebSocket, Message>,
    message: TerminalServerMessage<'_>,
    terminal_id: Uuid,
    recorder: Option<&DebugRecordingManager>,
) -> Result<(), ()> {
    if let Some(recorder) = recorder
        && let Ok(value) = serde_json::to_value(&message)
    {
        recorder.control(&terminal_id, value);
    }
    let message = serde_json::to_string(&message).expect("serializable terminal control message");
    send_socket_message(sender, Message::Text(message.into())).await
}

async fn send_socket_message<S>(sender: &mut S, message: Message) -> Result<(), ()>
where
    S: Sink<Message> + Unpin,
{
    tokio::time::timeout(TERMINAL_SEND_TIMEOUT, sender.send(message))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    fn output(sequence: u64, bytes: &'static [u8]) -> TerminalEvent {
        TerminalEvent::Output(SequencedOutput {
            sequence,
            bytes: Bytes::from_static(bytes),
        })
    }

    fn size_event() -> TerminalEvent {
        TerminalEvent::Size(TerminalSizeState {
            cols: 80,
            rows: 24,
            pixel_width: 800,
            pixel_height: 480,
            focused_client: None,
            responder_client: None,
            epoch: 1,
        })
    }

    fn drain(first: SequencedOutput, events: Vec<TerminalEvent>) -> (SequencedOutput, usize) {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(64);
        for event in events {
            sender.send(event).expect("queued event");
        }
        let mut deferred = None;
        let merged = coalesce_terminal_output(first, &mut receiver, &mut deferred);
        let remaining = usize::from(deferred.is_some()) + receiver.len();
        (merged, remaining)
    }

    #[test]
    fn contiguous_output_is_merged_into_one_frame() {
        let (merged, remaining) = drain(
            SequencedOutput {
                sequence: 10,
                bytes: Bytes::from_static(b"abc"),
            },
            vec![output(13, b"de"), output(15, b"f")],
        );
        assert_eq!(merged.sequence, 10);
        assert_eq!(merged.bytes.as_ref(), b"abcdef");
        assert_eq!(remaining, 0);
    }

    #[test]
    fn overlapping_and_stale_output_is_reconciled_while_merging() {
        let (merged, _) = drain(
            SequencedOutput {
                sequence: 10,
                bytes: Bytes::from_static(b"abc"),
            },
            // Already covered, then overlapping the merged tail by one byte.
            vec![output(10, b"ab"), output(12, b"cde")],
        );
        assert_eq!(merged.sequence, 10);
        assert_eq!(merged.bytes.as_ref(), b"abcde");
    }

    #[test]
    fn merging_stops_at_a_gap_and_leaves_it_for_snapshot_recovery() {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(64);
        sender.send(output(13, b"de")).expect("queued output");
        sender.send(output(99, b"gap")).expect("queued gap");
        sender.send(output(102, b"more")).expect("queued output");
        let mut deferred = None;
        let merged = coalesce_terminal_output(
            SequencedOutput {
                sequence: 10,
                bytes: Bytes::from_static(b"abc"),
            },
            &mut receiver,
            &mut deferred,
        );
        assert_eq!(merged.bytes.as_ref(), b"abcde");
        let Some(Ok(TerminalEvent::Output(gap))) = deferred else {
            panic!("the gap is handed back to the caller");
        };
        assert_eq!(gap.sequence, 99);
        assert_eq!(receiver.len(), 1, "output after the gap stays queued");
    }

    #[test]
    fn merging_stops_at_a_control_event_without_reordering_it() {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(64);
        sender.send(output(13, b"de")).expect("queued output");
        sender.send(size_event()).expect("queued size");
        sender.send(output(15, b"f")).expect("queued output");
        let mut deferred = None;
        let merged = coalesce_terminal_output(
            SequencedOutput {
                sequence: 10,
                bytes: Bytes::from_static(b"abc"),
            },
            &mut receiver,
            &mut deferred,
        );
        assert_eq!(merged.bytes.as_ref(), b"abcde");
        assert!(
            matches!(deferred, Some(Ok(TerminalEvent::Size(_)))),
            "the size event is applied before the output that follows it",
        );
        assert_eq!(receiver.len(), 1);
    }

    #[test]
    fn merging_stops_at_the_frame_budget() {
        let chunk: &'static [u8] = &[b'x'; 4095];
        let events = (1..40)
            .map(|index| {
                TerminalEvent::Output(SequencedOutput {
                    sequence: index * 4095,
                    bytes: Bytes::from_static(chunk),
                })
            })
            .collect();
        let (merged, _) = drain(
            SequencedOutput {
                sequence: 0,
                bytes: Bytes::from_static(chunk),
            },
            events,
        );
        assert!(merged.bytes.len() >= TERMINAL_OUTPUT_COALESCE_BYTES);
        assert!(merged.bytes.len() < TERMINAL_OUTPUT_COALESCE_BYTES + 4095);
    }
}
