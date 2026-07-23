use std::sync::Arc;

use axum::{
    extract::ws::{CloseFrame, Message, WebSocket},
    http::StatusCode,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    ai::{PiClientConfig, PiService, UpdatePiSettings},
    terminal::{
        CreateTerminal, ProcessInspectorSnapshot, RenameTerminal, TerminalEvent, TerminalInfo,
        TerminalManager, TerminalSession,
    },
};

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

    pub async fn pi_config(&self) -> Result<PiClientConfig, WorkspaceError> {
        match self {
            Self::Local { pi, .. } => Ok(pi.client_config()),
            #[cfg(unix)]
            Self::Broker(client) => client.pi_config().await,
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

    pub async fn connect_terminal(&self, id: Uuid) -> Result<SessionConnection, WorkspaceError> {
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
                .terminal_socket(id)
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

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
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
    Pong,
    Error {
        message: &'a str,
    },
}

struct Attachment(Arc<TerminalSession>);

impl Drop for Attachment {
    fn drop(&mut self) {
        self.0.detach();
    }
}

pub(crate) async fn serve_terminal_socket(mut socket: WebSocket, terminal: Arc<TerminalSession>) {
    terminal.attach();
    let _attachment = Attachment(terminal.clone());
    let (mut events, replay) = terminal.subscribe();
    let ready = serde_json::to_string(&TerminalServerMessage::Ready {
        terminal: Box::new(terminal.info()),
    })
    .expect("serializable terminal");
    if socket.send(Message::Text(ready.into())).await.is_err() {
        return;
    }
    for chunk in replay {
        if socket.send(Message::Binary(chunk)).await.is_err() {
            return;
        }
    }

    let (mut sender, mut receiver) = socket.split();
    loop {
        tokio::select! {
            event = events.recv() => {
                match event {
                    Ok(TerminalEvent::Output(chunk)) => {
                        if sender.send(Message::Binary(chunk)).await.is_err() { break; }
                    }
                    Ok(TerminalEvent::Exit(exit_code)) => {
                        let message = serde_json::to_string(&TerminalServerMessage::Exit { exit_code })
                            .expect("serializable exit");
                        let _ = sender.send(Message::Text(message.into())).await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = sender.send(Message::Close(Some(CloseFrame {
                            code: 1013,
                            reason: "terminal client fell behind".into(),
                        }))).await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Text(text) => match serde_json::from_str::<TerminalClientMessage>(&text) {
                        Ok(TerminalClientMessage::Input { data }) if data.len() <= 64 * 1024 => {
                            if terminal.write(data.as_bytes()).is_err() { break; }
                        }
                        Ok(TerminalClientMessage::Resize { cols, rows }) => {
                            if terminal.resize(cols, rows).is_err() { break; }
                        }
                        Ok(TerminalClientMessage::Ping) => {
                            let pong = serde_json::to_string(&TerminalServerMessage::Pong)
                                .expect("serializable pong");
                            if sender.send(Message::Text(pong.into())).await.is_err() { break; }
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
