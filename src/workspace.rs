use std::sync::Arc;

use axum::{
    extract::ws::{Message, WebSocket},
    http::StatusCode,
};
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    ai::{PiClientConfig, PiService, UpdatePiSettings},
    terminal::{
        CreateTerminal, ProcessInspectorSnapshot, ProcessSignalError, RenameTerminal,
        TerminalEvent, TerminalInfo, TerminalManager, TerminalSession, TerminalSizeState,
        terminate_descendant_process,
    },
    terminal_state::{SequencedOutput, SyncMode, TerminalSync},
};

const TERMINAL_FRAME_HEADER_BYTES: usize = 9;
const TERMINAL_FRAME_PAYLOAD_BYTES: usize = 60 * 1024;
const TERMINAL_FRAME_SNAPSHOT: u8 = 0;
const TERMINAL_FRAME_OUTPUT: u8 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrokerInfo {
    pub version: String,
    pub commit: String,
    pub sessions: usize,
    pub restart_required: bool,
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
    Broker(Arc<crate::broker::BrokerClient>),
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
    pub fn broker(client: crate::broker::BrokerClient) -> Self {
        Self::Broker(Arc::new(client))
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
        initial_size: Option<(u16, u16)>,
        sequence: Option<u64>,
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
                .terminal_socket(id, initial_size, sequence, observer)
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
    sequence: Option<u64>,
    #[serde(default)]
    observer: bool,
}

impl TerminalSocketQuery {
    pub(crate) fn viewport(&self) -> Option<(u16, u16)> {
        self.cols.zip(self.rows)
    }

    pub(crate) fn sequence(&self) -> Option<u64> {
        self.sequence
    }

    pub(crate) fn observer(&self) -> bool {
        self.observer
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Focus { focused: bool },
    Ping,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum TerminalServerMessage<'a> {
    Ready {
        terminal: Box<TerminalInfo>,
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

impl Drop for Attachment {
    fn drop(&mut self) {
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
    }
}

pub(crate) async fn serve_terminal_socket(
    mut socket: WebSocket,
    terminal: Arc<TerminalSession>,
    initial_size: Option<(u16, u16)>,
    requested_sequence: Option<u64>,
    observer: bool,
) {
    let client_id = Uuid::new_v4();
    let _attachment = if observer {
        None
    } else {
        if let Err(error) = terminal.attach(client_id, initial_size) {
            terminal.detach(client_id);
            tracing::debug!(%error, "initial terminal resize failed");
            return;
        }
        Some(Attachment {
            terminal: terminal.clone(),
            client_id,
        })
    };
    let ready = serde_json::to_string(&TerminalServerMessage::Ready {
        terminal: Box::new(terminal.info()),
    })
    .expect("serializable terminal");
    if socket.send(Message::Text(ready.into())).await.is_err() {
        return;
    }
    let (mut sender, mut receiver) = socket.split();
    let Ok(Some((mut events, mut sent_sequence))) =
        synchronize_terminal(&mut sender, &terminal, client_id, requested_sequence).await
    else {
        return;
    };
    loop {
        tokio::select! {
            event = events.recv() => {
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
                            match synchronize_terminal(
                                &mut sender,
                                &terminal,
                                client_id,
                                None,
                            ).await {
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
                        if send_terminal_output(&mut sender, &output).await.is_err() { break; }
                        sent_sequence = output.end_sequence();
                    }
                    Ok(TerminalEvent::Exit(exit_code)) => {
                        let message = serde_json::to_string(&TerminalServerMessage::Exit { exit_code })
                            .expect("serializable exit");
                        let _ = sender.send(Message::Text(message.into())).await;
                        break;
                    }
                    Ok(TerminalEvent::Size(size)) => {
                        let message = serde_json::to_string(&size_message(size, client_id))
                            .expect("serializable terminal size");
                        if sender.send(Message::Text(message.into())).await.is_err() { break; }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::debug!(
                            skipped,
                            sent_sequence,
                            "terminal stream lagged; sending current snapshot"
                        );
                        match synchronize_terminal(
                            &mut sender,
                            &terminal,
                            client_id,
                            None,
                        ).await {
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
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Text(text) => match serde_json::from_str::<TerminalClientMessage>(&text) {
                        Ok(TerminalClientMessage::Ping) => {
                            let pong = serde_json::to_string(&TerminalServerMessage::Pong)
                                .expect("serializable pong");
                            if sender.send(Message::Text(pong.into())).await.is_err() { break; }
                        }
                        Ok(_) if observer => {
                            let error = serde_json::to_string(&TerminalServerMessage::Error {
                                message: "observer connections are read-only",
                            })
                            .expect("serializable error");
                            if sender.send(Message::Text(error.into())).await.is_err() { break; }
                        }
                        Ok(TerminalClientMessage::Input { data }) if data.len() <= 64 * 1024 => {
                            if let Err(error) = terminal.write(data.as_bytes()) {
                                tracing::debug!(%error, "terminal input failed");
                                break;
                            }
                        }
                        Ok(TerminalClientMessage::Resize { cols, rows }) => {
                            if terminal.resize_client(client_id, cols, rows).is_err() { break; }
                        }
                        Ok(TerminalClientMessage::Focus { focused }) => {
                            if terminal.focus_client(client_id, focused).is_err() { break; }
                        }
                        _ => {
                            let error = serde_json::to_string(&TerminalServerMessage::Error {
                                message: "invalid terminal message",
                            })
                            .expect("serializable error");
                            if sender.send(Message::Text(error.into())).await.is_err() { break; }
                        }
                    },
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        if sender.send(Message::Pong(payload)).await.is_err() { break; }
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn synchronize_terminal(
    sender: &mut SplitSink<WebSocket, Message>,
    terminal: &TerminalSession,
    client_id: Uuid,
    requested_sequence: Option<u64>,
) -> Result<Option<(tokio::sync::broadcast::Receiver<TerminalEvent>, u64)>, ()> {
    let (events, sync, size, exit_code) = terminal.subscribe(requested_sequence);
    send_terminal_control(sender, size_message(size, client_id)).await?;
    let sequence = send_terminal_sync(sender, sync).await?;
    if let Some(exit_code) = exit_code {
        send_terminal_control(sender, TerminalServerMessage::Exit { exit_code }).await?;
        return Ok(None);
    }
    Ok(Some((events, sequence)))
}

async fn send_terminal_sync(
    sender: &mut SplitSink<WebSocket, Message>,
    sync: TerminalSync,
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
    )
    .await?;
    if let Some(snapshot) = sync.snapshot {
        send_terminal_bytes(sender, TERMINAL_FRAME_SNAPSHOT, sync.sequence, &snapshot).await?;
    }
    for output in sync.output {
        send_terminal_output(sender, &output).await?;
    }
    send_terminal_control(
        sender,
        TerminalServerMessage::Synced {
            sequence: sync.sequence,
        },
    )
    .await?;
    Ok(sync.sequence)
}

async fn send_terminal_output(
    sender: &mut SplitSink<WebSocket, Message>,
    output: &SequencedOutput,
) -> Result<(), ()> {
    send_terminal_bytes(
        sender,
        TERMINAL_FRAME_OUTPUT,
        output.sequence,
        &output.bytes,
    )
    .await
}

async fn send_terminal_bytes(
    sender: &mut SplitSink<WebSocket, Message>,
    kind: u8,
    mut sequence: u64,
    bytes: &[u8],
) -> Result<(), ()> {
    for chunk in bytes.chunks(TERMINAL_FRAME_PAYLOAD_BYTES) {
        let mut frame = Vec::with_capacity(TERMINAL_FRAME_HEADER_BYTES + chunk.len());
        frame.push(kind);
        frame.extend_from_slice(&sequence.to_be_bytes());
        frame.extend_from_slice(chunk);
        sender
            .send(Message::Binary(frame.into()))
            .await
            .map_err(|_| ())?;
        if kind == TERMINAL_FRAME_OUTPUT {
            sequence += chunk.len() as u64;
        }
    }
    Ok(())
}

async fn send_terminal_control(
    sender: &mut SplitSink<WebSocket, Message>,
    message: TerminalServerMessage<'_>,
) -> Result<(), ()> {
    let message = serde_json::to_string(&message).expect("serializable terminal control message");
    sender
        .send(Message::Text(message.into()))
        .await
        .map_err(|_| ())
}
