use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::Read as _,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE as BASE64_URL_SAFE},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{broadcast, mpsc, watch},
};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};
const ACCESS_EVENT_CAPACITY: usize = 256;
const ACCESS_ACTIVITY_LIMIT: usize = 100;
const MAX_DESCRIPTION_BYTES: usize = 2 * 1024;
const MAX_COMMAND_ARGUMENTS: usize = 256;
const MAX_PENDING_REQUESTS_PER_TERMINAL: usize = 32;
const MAX_SECRET_GRANTS_PER_TERMINAL: usize = 64;
const MAX_SECRET_EXECUTIONS_PER_TERMINAL: usize = 8;
const MAX_COMMAND_BYTES: usize = 64 * 1024;
const OUTPUT_CHUNK_BYTES: usize = 8 * 1024;
const REDACTED: &[u8] = b"[REDACTED]";
const MIN_DERIVED_SECRET_BYTES: usize = 4;
const MAX_DERIVED_SECRET_BYTES: usize = 1024;
const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SAFE_COMMAND_ENVIRONMENT: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "COLORTERM",
    "SSH_AUTH_SOCK",
    "XDG_RUNTIME_DIR",
];

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AccessRequestKind {
    Secret,
    Sudo,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AccessRequestState {
    Pending,
    Authenticating,
    Running,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AccessActivityStatus {
    Approved,
    Rejected,
    Revoked,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessRequestView {
    pub id: Uuid,
    pub request_hash: String,
    pub kind: AccessRequestKind,
    pub state: AccessRequestState,
    pub description: String,
    pub agent: String,
    pub created_at: u64,
    pub waiters: usize,
    pub secret_name: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretGrantView {
    pub id: Uuid,
    pub name: String,
    pub source: String,
    pub created_at: u64,
    pub uses: u64,
    pub last_used_at: Option<u64>,
    pub last_command: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessActivityView {
    pub id: Uuid,
    pub kind: AccessRequestKind,
    pub status: AccessActivityStatus,
    pub title: String,
    pub detail: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessSnapshot {
    pub terminal_id: Uuid,
    pub revision: u64,
    pub requests: Vec<AccessRequestView>,
    pub grants: Vec<SecretGrantView>,
    pub activity: Vec<AccessActivityView>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRequestContext {
    pub pid: u32,
    pub start_ticks: u64,
    pub agent: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSecretRequest {
    #[serde(flatten)]
    pub context: AgentRequestContext,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSudoRequest {
    #[serde(flatten)]
    pub context: AgentRequestContext,
    pub description: String,
    pub cwd: PathBuf,
    pub command: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SecretDelivery {
    Env { name: String },
    Stdin,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSecretExecute {
    #[serde(flatten)]
    pub context: AgentRequestContext,
    pub name: String,
    pub cwd: PathBuf,
    pub command: Vec<String>,
    pub delivery: SecretDelivery,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSecretName {
    #[serde(flatten)]
    pub context: AgentRequestContext,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessDecision {
    pub request_hash: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretApproval {
    pub request_hash: String,
    pub value: String,
}

impl Drop for SecretApproval {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SudoApproval {
    pub request_hash: String,
    pub password: String,
}

impl Drop for SudoApproval {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddSecretGrant {
    pub name: String,
    pub value: String,
    pub description: Option<String>,
}

impl Drop for AddSecretGrant {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AgentAccessEvent {
    Waiting { request_id: Uuid },
    Running { request_id: Option<Uuid> },
    Output { data: String },
    Granted { name: String },
    Rejected { comment: Option<String> },
    Completed { return_code: i32 },
    Failed { message: String },
}

impl AgentAccessEvent {
    pub fn output(bytes: &[u8]) -> Self {
        Self::Output {
            data: BASE64.encode(bytes),
        }
    }

    pub fn terminal(&self) -> bool {
        matches!(
            self,
            Self::Granted { .. }
                | Self::Rejected { .. }
                | Self::Completed { .. }
                | Self::Failed { .. }
        )
    }
}

#[derive(Debug, Error)]
pub enum AccessError {
    #[error("{0}")]
    Invalid(String),
    #[error("access request not found")]
    NotFound,
    #[error("{0}")]
    Conflict(String),
    #[error("the access request changed; review it again")]
    Stale,
    #[error("{0}")]
    Unavailable(String),
}

#[derive(Clone)]
pub struct AccessManager {
    inner: Arc<AccessInner>,
}

struct AccessInner {
    state: Mutex<AccessState>,
    sudo_program: PathBuf,
}

#[derive(Default)]
struct AccessState {
    revision: u64,
    requests: HashMap<Uuid, PendingAccessRequest>,
    grants: HashMap<Uuid, SecretGrant>,
    secret_executions: HashMap<Uuid, SecretExecution>,
    activity: VecDeque<AccessActivityRecord>,
}

struct AccessActivityRecord {
    terminal_id: Uuid,
    view: AccessActivityView,
}

struct PendingAccessRequest {
    id: Uuid,
    terminal_id: Uuid,
    request_hash: String,
    kind: PendingRequestKind,
    state: AccessRequestState,
    description: String,
    agent: String,
    created_at: u64,
    waiters: usize,
    sender: broadcast::Sender<AgentAccessEvent>,
}

enum PendingRequestKind {
    Secret {
        name: String,
    },
    Sudo {
        command: Vec<String>,
        command_display: String,
        cwd: PathBuf,
        executable_hash: String,
        executable_identity: FileIdentity,
        cwd_identity: FileIdentity,
        fingerprint: String,
    },
}

struct SecretGrant {
    id: Uuid,
    terminal_id: Uuid,
    name: String,
    source: String,
    created_at: u64,
    uses: u64,
    last_used_at: Option<u64>,
    last_command: Option<String>,
    value: Zeroizing<String>,
}

struct SecretExecution {
    terminal_id: Uuid,
    cancel: watch::Sender<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

pub struct AccessSubscription {
    initial: VecDeque<AgentAccessEvent>,
    receiver: Option<broadcast::Receiver<AgentAccessEvent>>,
    manager: Option<AccessManager>,
    request_id: Option<Uuid>,
    cancel: Option<watch::Sender<bool>>,
    terminal: bool,
}

impl AccessSubscription {
    fn immediate(event: AgentAccessEvent) -> Self {
        Self {
            initial: VecDeque::from([event]),
            receiver: None,
            manager: None,
            request_id: None,
            cancel: None,
            terminal: false,
        }
    }

    fn request(
        manager: AccessManager,
        request_id: Uuid,
        receiver: broadcast::Receiver<AgentAccessEvent>,
    ) -> Self {
        Self {
            initial: VecDeque::from([AgentAccessEvent::Waiting { request_id }]),
            receiver: Some(receiver),
            manager: Some(manager),
            request_id: Some(request_id),
            cancel: None,
            terminal: false,
        }
    }

    fn execution(
        receiver: broadcast::Receiver<AgentAccessEvent>,
        cancel: watch::Sender<bool>,
    ) -> Self {
        Self {
            initial: VecDeque::from([AgentAccessEvent::Running { request_id: None }]),
            receiver: Some(receiver),
            manager: None,
            request_id: None,
            cancel: Some(cancel),
            terminal: false,
        }
    }

    pub async fn next(&mut self) -> Option<AgentAccessEvent> {
        if self.terminal {
            return None;
        }
        let event = if let Some(event) = self.initial.pop_front() {
            event
        } else {
            let receiver = self.receiver.as_mut()?;
            match receiver.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => AgentAccessEvent::Failed {
                    message: "command output exceeded the consumer buffer".to_owned(),
                },
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        };
        self.terminal = event.terminal();
        Some(event)
    }
}

impl Drop for AccessSubscription {
    fn drop(&mut self) {
        if let (Some(manager), Some(request_id)) = (&self.manager, self.request_id) {
            manager.detach_waiter(request_id);
        }
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(true);
        }
    }
}

impl Default for AccessManager {
    fn default() -> Self {
        Self::new(PathBuf::from("/usr/bin/sudo"))
    }
}

impl AccessManager {
    pub fn new(sudo_program: PathBuf) -> Self {
        Self {
            inner: Arc::new(AccessInner {
                state: Mutex::new(AccessState::default()),
                sudo_program,
            }),
        }
    }

    pub fn snapshot(&self, terminal_id: Uuid) -> AccessSnapshot {
        let state = self.inner.state.lock();
        let mut requests = state
            .requests
            .values()
            .filter(|request| request.terminal_id == terminal_id)
            .map(PendingAccessRequest::view)
            .collect::<Vec<_>>();
        requests.sort_by_key(|request| request.created_at);
        let mut grants = state
            .grants
            .values()
            .filter(|grant| grant.terminal_id == terminal_id)
            .map(SecretGrant::view)
            .collect::<Vec<_>>();
        grants.sort_by(|left, right| left.name.cmp(&right.name));
        let activity = state
            .activity
            .iter()
            .filter(|entry| entry.terminal_id == terminal_id)
            .map(|entry| entry.view.clone())
            .collect();
        AccessSnapshot {
            terminal_id,
            revision: state.revision,
            requests,
            grants,
            activity,
        }
    }

    pub fn request_secret(
        &self,
        terminal_id: Uuid,
        request: AgentSecretRequest,
    ) -> Result<AccessSubscription, AccessError> {
        let name = validate_secret_name(&request.name)?;
        let description = validate_description(&request.description)?;
        let agent = validate_agent(&request.context.agent)?;
        let mut state = self.inner.state.lock();
        if state
            .grants
            .values()
            .any(|grant| grant.terminal_id == terminal_id && grant.name == name)
        {
            return Ok(AccessSubscription::immediate(AgentAccessEvent::Granted {
                name,
            }));
        }
        if let Some(existing) = state.requests.values_mut().find(|candidate| {
            candidate.terminal_id == terminal_id
                && candidate.state == AccessRequestState::Pending
                && matches!(&candidate.kind, PendingRequestKind::Secret { name: candidate_name } if candidate_name == &name)
        }) {
            if existing.description != description || existing.agent != agent {
                return Err(AccessError::Conflict(format!(
                    "{name} already has a pending request with a different purpose or agent"
                )));
            }
            existing.waiters += 1;
            return Ok(AccessSubscription::request(
                self.clone(),
                existing.id,
                existing.sender.subscribe(),
            ));
        }
        if state
            .requests
            .values()
            .filter(|request| {
                request.terminal_id == terminal_id && request.state == AccessRequestState::Pending
            })
            .count()
            >= MAX_PENDING_REQUESTS_PER_TERMINAL
        {
            return Err(AccessError::Conflict(
                "this terminal already has too many pending access requests".to_owned(),
            ));
        }
        let id = Uuid::new_v4();
        let created_at = current_millis();
        let request_hash = hash_parts(&[
            "secret",
            &terminal_id.to_string(),
            &id.to_string(),
            &name,
            &description,
        ]);
        let (sender, receiver) = broadcast::channel(ACCESS_EVENT_CAPACITY);
        state.requests.insert(
            id,
            PendingAccessRequest {
                id,
                terminal_id,
                request_hash,
                kind: PendingRequestKind::Secret { name },
                state: AccessRequestState::Pending,
                description,
                agent,
                created_at,
                waiters: 1,
                sender,
            },
        );
        state.revision = state.revision.wrapping_add(1);
        Ok(AccessSubscription::request(self.clone(), id, receiver))
    }

    pub fn request_sudo(
        &self,
        terminal_id: Uuid,
        request: AgentSudoRequest,
    ) -> Result<AccessSubscription, AccessError> {
        let description = validate_description(&request.description)?;
        let agent = validate_agent(&request.context.agent)?;
        let (command, executable_hash, executable_identity) =
            validate_sudo_command(request.command)?;
        let (cwd, cwd_identity) = validate_sudo_cwd(request.cwd)?;
        let command_display = command_display(&command);
        let executable_identity_label = format!(
            "{}:{}",
            executable_identity.device, executable_identity.inode
        );
        let cwd_identity_label = format!("{}:{}", cwd_identity.device, cwd_identity.inode);
        let fingerprint = hash_parts(&[
            "sudo",
            &terminal_id.to_string(),
            &cwd.display().to_string(),
            &command_display,
            &executable_hash,
            &executable_identity_label,
            &cwd_identity_label,
        ]);
        let mut state = self.inner.state.lock();
        if let Some(existing) = state.requests.values_mut().find(|candidate| {
            candidate.terminal_id == terminal_id
                && candidate.state == AccessRequestState::Pending
                && matches!(&candidate.kind, PendingRequestKind::Sudo { fingerprint: candidate_fingerprint, .. } if candidate_fingerprint == &fingerprint)
        }) {
            if existing.description != description || existing.agent != agent {
                return Err(AccessError::Conflict(
                    "the same root command already has a pending request with a different purpose or agent"
                        .to_owned(),
                ));
            }
            existing.waiters += 1;
            return Ok(AccessSubscription::request(
                self.clone(),
                existing.id,
                existing.sender.subscribe(),
            ));
        }
        if state
            .requests
            .values()
            .filter(|request| {
                request.terminal_id == terminal_id && request.state == AccessRequestState::Pending
            })
            .count()
            >= MAX_PENDING_REQUESTS_PER_TERMINAL
        {
            return Err(AccessError::Conflict(
                "this terminal already has too many pending access requests".to_owned(),
            ));
        }
        let id = Uuid::new_v4();
        let created_at = current_millis();
        let request_hash = hash_parts(&[
            "sudo-request",
            &terminal_id.to_string(),
            &id.to_string(),
            &fingerprint,
            &description,
        ]);
        let (sender, receiver) = broadcast::channel(ACCESS_EVENT_CAPACITY);
        state.requests.insert(
            id,
            PendingAccessRequest {
                id,
                terminal_id,
                request_hash,
                kind: PendingRequestKind::Sudo {
                    command,
                    command_display,
                    cwd,
                    executable_hash,
                    executable_identity,
                    cwd_identity,
                    fingerprint,
                },
                state: AccessRequestState::Pending,
                description,
                agent,
                created_at,
                waiters: 1,
                sender,
            },
        );
        state.revision = state.revision.wrapping_add(1);
        Ok(AccessSubscription::request(self.clone(), id, receiver))
    }

    pub fn list_grants(&self, terminal_id: Uuid) -> Vec<SecretGrantView> {
        self.snapshot(terminal_id).grants
    }

    pub fn add_secret(
        &self,
        terminal_id: Uuid,
        mut input: AddSecretGrant,
    ) -> Result<SecretGrantView, AccessError> {
        let name = validate_secret_name(&input.name)?;
        let value = validate_secret_value(std::mem::take(&mut input.value))?;
        let description = input
            .description
            .as_deref()
            .map(validate_optional_description)
            .transpose()?
            .flatten();
        let mut state = self.inner.state.lock();
        if state
            .grants
            .values()
            .any(|grant| grant.terminal_id == terminal_id && grant.name == name)
        {
            return Err(AccessError::Conflict(format!(
                "{name} is already granted to this terminal"
            )));
        }
        if state
            .grants
            .values()
            .filter(|grant| grant.terminal_id == terminal_id)
            .count()
            >= MAX_SECRET_GRANTS_PER_TERMINAL
        {
            return Err(AccessError::Conflict(
                "this terminal already has too many secret grants".to_owned(),
            ));
        }
        let grant = SecretGrant::new(terminal_id, name.clone(), "Added by you", value);
        let view = grant.view();
        state.grants.insert(grant.id, grant);
        let pending = state
            .requests
            .extract_if(|_, request| {
                request.terminal_id == terminal_id
                    && request.state == AccessRequestState::Pending
                    && matches!(&request.kind, PendingRequestKind::Secret { name: request_name } if request_name == &name)
            })
            .map(|(_, request)| request)
            .collect::<Vec<_>>();
        for request in pending {
            let _ = request
                .sender
                .send(AgentAccessEvent::Granted { name: name.clone() });
        }
        push_activity(
            &mut state,
            terminal_id,
            AccessRequestKind::Secret,
            AccessActivityStatus::Approved,
            "Secret added and granted",
            description.as_deref().unwrap_or(&name),
        );
        Ok(view)
    }

    pub fn approve_secret(
        &self,
        terminal_id: Uuid,
        request_id: Uuid,
        mut input: SecretApproval,
    ) -> Result<SecretGrantView, AccessError> {
        let value = validate_secret_value(std::mem::take(&mut input.value))?;
        let mut state = self.inner.state.lock();
        let request = state
            .requests
            .get(&request_id)
            .ok_or(AccessError::NotFound)?;
        if request.terminal_id != terminal_id {
            return Err(AccessError::NotFound);
        }
        if request.request_hash != input.request_hash {
            return Err(AccessError::Stale);
        }
        if request.state != AccessRequestState::Pending {
            return Err(AccessError::Conflict(
                "access request is no longer pending".to_owned(),
            ));
        }
        let PendingRequestKind::Secret { name } = &request.kind else {
            return Err(AccessError::Invalid(
                "this request does not accept a secret".to_owned(),
            ));
        };
        let name = name.clone();
        if state
            .grants
            .values()
            .any(|grant| grant.terminal_id == terminal_id && grant.name == name)
        {
            return Err(AccessError::Conflict(format!(
                "{name} is already granted to this terminal"
            )));
        }
        if state
            .grants
            .values()
            .filter(|grant| grant.terminal_id == terminal_id)
            .count()
            >= MAX_SECRET_GRANTS_PER_TERMINAL
        {
            return Err(AccessError::Conflict(
                "this terminal already has too many secret grants".to_owned(),
            ));
        }
        let request = state.requests.remove(&request_id).expect("request exists");
        let grant = SecretGrant::new(terminal_id, name.clone(), "Approved request", value);
        let view = grant.view();
        state.grants.insert(grant.id, grant);
        let _ = request
            .sender
            .send(AgentAccessEvent::Granted { name: name.clone() });
        push_activity(
            &mut state,
            terminal_id,
            AccessRequestKind::Secret,
            AccessActivityStatus::Approved,
            "Secret request approved",
            &name,
        );
        Ok(view)
    }

    pub fn reject(
        &self,
        terminal_id: Uuid,
        request_id: Uuid,
        decision: AccessDecision,
    ) -> Result<(), AccessError> {
        let comment = decision
            .comment
            .as_deref()
            .map(validate_optional_description)
            .transpose()?
            .flatten();
        let mut state = self.inner.state.lock();
        let request = state
            .requests
            .get(&request_id)
            .ok_or(AccessError::NotFound)?;
        if request.terminal_id != terminal_id {
            return Err(AccessError::NotFound);
        }
        if request.request_hash != decision.request_hash {
            return Err(AccessError::Stale);
        }
        if request.state != AccessRequestState::Pending {
            return Err(AccessError::Conflict(
                "access request is no longer pending".to_owned(),
            ));
        }
        let request = state.requests.remove(&request_id).expect("request exists");
        let detail = comment
            .clone()
            .unwrap_or_else(|| request.kind.summary().to_owned());
        let _ = request.sender.send(AgentAccessEvent::Rejected {
            comment: comment.clone(),
        });
        push_activity(
            &mut state,
            terminal_id,
            request.kind.kind(),
            AccessActivityStatus::Rejected,
            match request.kind.kind() {
                AccessRequestKind::Secret => "Secret request rejected",
                AccessRequestKind::Sudo => "Root command rejected",
            },
            &detail,
        );
        Ok(())
    }

    pub fn revoke_grant(&self, terminal_id: Uuid, grant_id: Uuid) -> Result<(), AccessError> {
        let mut state = self.inner.state.lock();
        let grant = state.grants.get(&grant_id).ok_or(AccessError::NotFound)?;
        if grant.terminal_id != terminal_id {
            return Err(AccessError::NotFound);
        }
        let grant = state.grants.remove(&grant_id).expect("grant exists");
        push_activity(
            &mut state,
            terminal_id,
            AccessRequestKind::Secret,
            AccessActivityStatus::Revoked,
            "Secret grant revoked",
            &grant.name,
        );
        Ok(())
    }

    pub fn drop_grant_by_name(&self, terminal_id: Uuid, name: &str) -> Result<(), AccessError> {
        let name = validate_secret_name(name)?;
        let grant_id = {
            let state = self.inner.state.lock();
            state
                .grants
                .values()
                .find(|grant| grant.terminal_id == terminal_id && grant.name == name)
                .map(|grant| grant.id)
                .ok_or(AccessError::NotFound)?
        };
        self.revoke_grant(terminal_id, grant_id)
    }

    pub async fn approve_sudo(
        &self,
        terminal_id: Uuid,
        request_id: Uuid,
        mut input: SudoApproval,
    ) -> Result<(), AccessError> {
        let password = validate_sudo_password_value(std::mem::take(&mut input.password))?;
        let mut execution = {
            let mut state = self.inner.state.lock();
            let request = state
                .requests
                .get_mut(&request_id)
                .ok_or(AccessError::NotFound)?;
            if request.terminal_id != terminal_id {
                return Err(AccessError::NotFound);
            }
            if request.request_hash != input.request_hash {
                return Err(AccessError::Stale);
            }
            if request.state != AccessRequestState::Pending {
                return Err(AccessError::Conflict(
                    "access request is no longer pending".to_owned(),
                ));
            }
            let PendingRequestKind::Sudo {
                command,
                command_display,
                cwd,
                executable_hash,
                executable_identity,
                cwd_identity,
                ..
            } = &request.kind
            else {
                return Err(AccessError::Invalid(
                    "this request does not accept sudo authentication".to_owned(),
                ));
            };
            request.state = AccessRequestState::Authenticating;
            let execution = SudoExecution {
                request_id,
                terminal_id,
                command: command.clone(),
                command_display: command_display.clone(),
                cwd: cwd.clone(),
                executable_hash: executable_hash.clone(),
                executable_identity: *executable_identity,
                cwd_identity: *cwd_identity,
                sender: request.sender.clone(),
                password,
            };
            state.revision = state.revision.wrapping_add(1);
            execution
        };
        if let Err(message) = validate_sudo_password(
            &self.inner.sudo_program,
            &execution.cwd,
            execution.password.as_str(),
        )
        .await
        {
            let mut state = self.inner.state.lock();
            if let Some(request) = state.requests.get_mut(&request_id) {
                request.state = AccessRequestState::Pending;
                state.revision = state.revision.wrapping_add(1);
            }
            return Err(AccessError::Invalid(message));
        }
        if !sudo_objects_match(&execution) {
            invalidate_sudo(&self.inner.sudo_program).await;
            execution.password.zeroize();
            self.fail_request(
                execution.request_id,
                "sudo executable or working directory changed after review",
            );
            return Err(AccessError::Stale);
        }
        invalidate_sudo(&self.inner.sudo_program).await;
        {
            let mut state = self.inner.state.lock();
            let request = state
                .requests
                .get_mut(&request_id)
                .ok_or(AccessError::NotFound)?;
            request.state = AccessRequestState::Running;
            state.revision = state.revision.wrapping_add(1);
        }
        let _ = execution.sender.send(AgentAccessEvent::Running {
            request_id: Some(execution.request_id),
        });
        let manager = self.clone();
        tokio::spawn(async move {
            manager.run_sudo(execution).await;
        });
        Ok(())
    }

    pub fn execute_secret(
        &self,
        terminal_id: Uuid,
        input: AgentSecretExecute,
    ) -> Result<AccessSubscription, AccessError> {
        let name = validate_secret_name(&input.name)?;
        let command = validate_command(input.command)?;
        let cwd = validate_cwd(input.cwd)?;
        if let SecretDelivery::Env { name } = &input.delivery {
            validate_environment_name(name)?;
        }
        let display = command_display(&command);
        let (sender, receiver) = broadcast::channel(ACCESS_EVENT_CAPACITY);
        let (cancel, cancellation) = watch::channel(false);
        let execution_id = Uuid::new_v4();
        let secret = {
            let mut state = self.inner.state.lock();
            if state
                .secret_executions
                .values()
                .filter(|execution| execution.terminal_id == terminal_id)
                .count()
                >= MAX_SECRET_EXECUTIONS_PER_TERMINAL
            {
                return Err(AccessError::Conflict(
                    "this terminal already has too many secret commands running".to_owned(),
                ));
            }
            let grant = state
                .grants
                .values_mut()
                .find(|grant| grant.terminal_id == terminal_id && grant.name == name)
                .ok_or(AccessError::NotFound)?;
            grant.uses = grant.uses.saturating_add(1);
            grant.last_used_at = Some(current_millis());
            grant.last_command = Some(display);
            let value = Zeroizing::new(grant.value.to_string());
            state.secret_executions.insert(
                execution_id,
                SecretExecution {
                    terminal_id,
                    cancel: cancel.clone(),
                },
            );
            state.revision = state.revision.wrapping_add(1);
            value
        };
        let manager = self.clone();
        tokio::spawn(async move {
            run_secret_command(
                command,
                cwd,
                input.delivery,
                name,
                secret,
                sender,
                cancellation,
            )
            .await;
            manager.finish_secret_execution(execution_id);
        });
        Ok(AccessSubscription::execution(receiver, cancel))
    }

    pub fn clear_terminal(&self, terminal_id: Uuid) {
        let mut state = self.inner.state.lock();
        let requests = state
            .requests
            .extract_if(|_, request| request.terminal_id == terminal_id)
            .map(|(_, request)| request)
            .collect::<Vec<_>>();
        let executions = state
            .secret_executions
            .extract_if(|_, execution| execution.terminal_id == terminal_id)
            .map(|(_, execution)| execution.cancel)
            .collect::<Vec<_>>();
        for request in requests {
            let _ = request.sender.send(AgentAccessEvent::Failed {
                message: "terminal closed".to_owned(),
            });
        }
        for cancel in executions {
            let _ = cancel.send(true);
        }
        state
            .grants
            .retain(|_, grant| grant.terminal_id != terminal_id);
        state
            .activity
            .retain(|activity| activity.terminal_id != terminal_id);
        state.revision = state.revision.wrapping_add(1);
    }
    pub fn clear_inactive_terminals(&self, active: &HashSet<Uuid>) {
        let mut state = self.inner.state.lock();
        let requests = state
            .requests
            .extract_if(|_, request| !active.contains(&request.terminal_id))
            .map(|(_, request)| request)
            .collect::<Vec<_>>();
        let executions = state
            .secret_executions
            .extract_if(|_, execution| !active.contains(&execution.terminal_id))
            .map(|(_, execution)| execution.cancel)
            .collect::<Vec<_>>();
        let changed = !requests.is_empty()
            || !executions.is_empty()
            || state
                .grants
                .values()
                .any(|grant| !active.contains(&grant.terminal_id));
        for request in requests {
            let _ = request.sender.send(AgentAccessEvent::Failed {
                message: "terminal exited".to_owned(),
            });
        }
        for cancel in executions {
            let _ = cancel.send(true);
        }
        state
            .grants
            .retain(|_, grant| active.contains(&grant.terminal_id));
        if changed {
            state.revision = state.revision.wrapping_add(1);
        }
    }

    fn finish_secret_execution(&self, execution_id: Uuid) {
        self.inner
            .state
            .lock()
            .secret_executions
            .remove(&execution_id);
    }

    fn detach_waiter(&self, request_id: Uuid) {
        let mut state = self.inner.state.lock();
        let remove = if let Some(request) = state.requests.get_mut(&request_id) {
            request.waiters = request.waiters.saturating_sub(1);
            request.waiters == 0 && request.state == AccessRequestState::Pending
        } else {
            false
        };
        if remove {
            let request = state.requests.remove(&request_id).expect("request exists");
            push_activity(
                &mut state,
                request.terminal_id,
                request.kind.kind(),
                AccessActivityStatus::Canceled,
                match request.kind.kind() {
                    AccessRequestKind::Secret => "Secret request canceled",
                    AccessRequestKind::Sudo => "Root command canceled",
                },
                request.kind.summary(),
            );
        } else {
            state.revision = state.revision.wrapping_add(1);
        }
    }

    async fn run_sudo(&self, mut execution: SudoExecution) {
        if !sudo_objects_match(&execution) {
            execution.password.zeroize();
            self.fail_request(
                execution.request_id,
                "sudo executable or working directory changed after approval",
            );
            return;
        }
        let mut command = Command::new(&self.inner.sudo_program);
        sanitize_command_environment(&mut command);
        command
            .arg("-S")
            .arg("-k")
            .arg("-p")
            .arg("")
            .arg("--")
            .args(&execution.command)
            .current_dir(&execution.cwd)
            .env_remove("SUDO_ASKPASS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let result = match command.spawn() {
            Ok(mut child) => {
                let delivered = if let Some(mut stdin) = child.stdin.take() {
                    stdin.write_all(execution.password.as_bytes()).await.is_ok()
                        && stdin.write_all(b"\n").await.is_ok()
                        && stdin.shutdown().await.is_ok()
                } else {
                    false
                };
                execution.password.zeroize();
                if delivered {
                    stream_child(child, execution.sender.clone(), None, None).await
                } else {
                    let _ = child.kill().await;
                    Err("unable to deliver sudo authentication".to_owned())
                }
            }
            Err(error) => {
                execution.password.zeroize();
                Err(format!("unable to start sudo command: {error}"))
            }
        };
        invalidate_sudo(&self.inner.sudo_program).await;
        match result {
            Ok(return_code) => {
                let mut state = self.inner.state.lock();
                state.requests.remove(&execution.request_id);
                push_activity(
                    &mut state,
                    execution.terminal_id,
                    AccessRequestKind::Sudo,
                    if return_code == 0 {
                        AccessActivityStatus::Approved
                    } else {
                        AccessActivityStatus::Failed
                    },
                    if return_code == 0 {
                        "Root command completed"
                    } else {
                        "Root command failed"
                    },
                    &execution.command_display,
                );
                let _ = execution
                    .sender
                    .send(AgentAccessEvent::Completed { return_code });
            }
            Err(message) => self.fail_request(execution.request_id, &message),
        }
    }

    fn fail_request(&self, request_id: Uuid, message: &str) {
        let mut state = self.inner.state.lock();
        let Some(request) = state.requests.remove(&request_id) else {
            return;
        };
        let _ = request.sender.send(AgentAccessEvent::Failed {
            message: message.to_owned(),
        });
        push_activity(
            &mut state,
            request.terminal_id,
            request.kind.kind(),
            AccessActivityStatus::Failed,
            match request.kind.kind() {
                AccessRequestKind::Secret => "Secret request failed",
                AccessRequestKind::Sudo => "Root command failed",
            },
            message,
        );
    }
}

struct SudoExecution {
    request_id: Uuid,
    terminal_id: Uuid,
    command: Vec<String>,
    command_display: String,
    cwd: PathBuf,
    sender: broadcast::Sender<AgentAccessEvent>,
    password: Zeroizing<String>,
    executable_hash: String,
    executable_identity: FileIdentity,
    cwd_identity: FileIdentity,
}

impl PendingAccessRequest {
    fn view(&self) -> AccessRequestView {
        let (secret_name, command, cwd, fingerprint) = match &self.kind {
            PendingRequestKind::Secret { name } => (Some(name.clone()), None, None, None),
            PendingRequestKind::Sudo {
                command_display,
                cwd,
                fingerprint,
                ..
            } => (
                None,
                Some(command_display.clone()),
                Some(cwd.display().to_string()),
                Some(fingerprint.clone()),
            ),
        };
        AccessRequestView {
            id: self.id,
            request_hash: self.request_hash.clone(),
            kind: self.kind.kind(),
            state: self.state,
            description: self.description.clone(),
            agent: self.agent.clone(),
            created_at: self.created_at,
            waiters: self.waiters,
            secret_name,
            command,
            cwd,
            fingerprint,
        }
    }
}

impl PendingRequestKind {
    fn kind(&self) -> AccessRequestKind {
        match self {
            Self::Secret { .. } => AccessRequestKind::Secret,
            Self::Sudo { .. } => AccessRequestKind::Sudo,
        }
    }

    fn summary(&self) -> &str {
        match self {
            Self::Secret { name } => name,
            Self::Sudo {
                command_display, ..
            } => command_display,
        }
    }
}

impl SecretGrant {
    fn new(
        terminal_id: Uuid,
        name: String,
        source: impl Into<String>,
        value: Zeroizing<String>,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            terminal_id,
            name,
            source: source.into(),
            created_at: current_millis(),
            uses: 0,
            last_used_at: None,
            last_command: None,
            value,
        }
    }

    fn view(&self) -> SecretGrantView {
        SecretGrantView {
            id: self.id,
            name: self.name.clone(),
            source: self.source.clone(),
            created_at: self.created_at,
            uses: self.uses,
            last_used_at: self.last_used_at,
            last_command: self.last_command.clone(),
        }
    }
}

fn push_activity(
    state: &mut AccessState,
    terminal_id: Uuid,
    kind: AccessRequestKind,
    status: AccessActivityStatus,
    title: &str,
    detail: &str,
) {
    state.activity.push_front(AccessActivityRecord {
        terminal_id,
        view: AccessActivityView {
            id: Uuid::new_v4(),
            kind,
            status,
            title: title.to_owned(),
            detail: detail.to_owned(),
            created_at: current_millis(),
        },
    });
    while state.activity.len() > ACCESS_ACTIVITY_LIMIT {
        state.activity.pop_back();
    }
    state.revision = state.revision.wrapping_add(1);
}

async fn validate_sudo_password(
    sudo_program: &Path,
    cwd: &Path,
    password: &str,
) -> Result<(), String> {
    let mut command = Command::new(sudo_program);
    sanitize_command_environment(&mut command);
    let mut child = command
        .arg("-S")
        .arg("-k")
        .arg("-p")
        .arg("")
        .arg("-v")
        .current_dir(cwd)
        .env_remove("SUDO_ASKPASS")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("unable to start sudo authentication: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(password.as_bytes())
            .await
            .map_err(|error| format!("unable to send sudo authentication: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("unable to finish sudo authentication: {error}"))?;
        stdin.shutdown().await.ok();
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("sudo authentication failed: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("sudo authentication failed; check the password and try again".to_owned())
    }
}

async fn invalidate_sudo(sudo_program: &Path) {
    let mut command = Command::new(sudo_program);
    sanitize_command_environment(&mut command);
    let _ = command
        .arg("-K")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

async fn run_secret_command(
    command: Vec<String>,
    cwd: PathBuf,
    delivery: SecretDelivery,
    secret_name: String,
    secret: Zeroizing<String>,
    sender: broadcast::Sender<AgentAccessEvent>,
    cancellation: watch::Receiver<bool>,
) {
    let mut process = Command::new(&command[0]);
    sanitize_command_environment(&mut process);
    #[cfg(unix)]
    process.process_group(0);
    process
        .args(&command[1..])
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    match &delivery {
        SecretDelivery::Env { name } => {
            process.env(name, secret.as_str()).stdin(Stdio::null());
        }
        SecretDelivery::Stdin => {
            process.stdin(Stdio::piped());
        }
    }
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = sender.send(AgentAccessEvent::Failed {
                message: format!("unable to start command: {error}"),
            });
            return;
        }
    };
    if matches!(delivery, SecretDelivery::Stdin)
        && let Some(mut stdin) = child.stdin.take()
    {
        if stdin.write_all(secret.as_bytes()).await.is_err() {
            let _ = child.kill().await;
            let _ = sender.send(AgentAccessEvent::Failed {
                message: "unable to deliver the secret on standard input".to_owned(),
            });
            return;
        }
        stdin.shutdown().await.ok();
    }
    let result = stream_child(
        child,
        sender.clone(),
        Some((secret_name.as_str(), secret.as_bytes())),
        Some(cancellation),
    )
    .await;
    match result {
        Ok(return_code) => {
            let _ = sender.send(AgentAccessEvent::Completed { return_code });
        }
        Err(message) => {
            let _ = sender.send(AgentAccessEvent::Failed { message });
        }
    }
}

async fn stream_child(
    mut child: tokio::process::Child,
    sender: broadcast::Sender<AgentAccessEvent>,
    secret: Option<(&str, &[u8])>,
    mut cancellation: Option<watch::Receiver<bool>>,
) -> Result<i32, String> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (output_sender, mut output_receiver) = mpsc::channel::<Zeroizing<Vec<u8>>>(32);
    if let Some(stdout) = stdout {
        tokio::spawn(read_stream(stdout, output_sender.clone()));
    }
    if let Some(stderr) = stderr {
        tokio::spawn(read_stream(stderr, output_sender.clone()));
    }
    drop(output_sender);
    let mut redactor = OutputRedactor::new(secret);
    loop {
        let next = if let Some(cancel) = cancellation.as_mut() {
            tokio::select! {
                output = output_receiver.recv() => output,
                _ = cancel.changed() => {
                    kill_child_process_group(&mut child).await;
                    return Err("secret command canceled because its requester disconnected".to_owned());
                }
            }
        } else {
            output_receiver.recv().await
        };
        let Some(bytes) = next else {
            break;
        };
        let output = redactor.push(&bytes, false);
        if !output.is_empty() {
            let _ = sender.send(AgentAccessEvent::output(&output));
        }
    }
    let output = redactor.push(&[], true);
    if !output.is_empty() {
        let _ = sender.send(AgentAccessEvent::output(&output));
    }
    let status = child
        .wait()
        .await
        .map_err(|error| format!("unable to wait for command: {error}"))?;
    Ok(status.code().unwrap_or(125))
}

async fn read_stream(mut stream: impl AsyncRead + Unpin, sender: mpsc::Sender<Zeroizing<Vec<u8>>>) {
    let mut buffer = Zeroizing::new(vec![0_u8; OUTPUT_CHUNK_BYTES]);
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) => return,
            Ok(count) => {
                let bytes = Zeroizing::new(buffer[..count].to_vec());
                buffer[..count].zeroize();
                if sender.send(bytes).await.is_err() {
                    return;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
    }
}

struct OutputRedactor {
    patterns: Vec<Zeroizing<Vec<u8>>>,
    replacement: Vec<u8>,
    pending: Zeroizing<Vec<u8>>,
    max_pattern_len: usize,
}

impl OutputRedactor {
    fn new(secret: Option<(&str, &[u8])>) -> Self {
        let Some((name, secret)) = secret.filter(|(_, value)| !value.is_empty()) else {
            return Self {
                patterns: Vec::new(),
                replacement: REDACTED.to_vec(),
                pending: Zeroizing::new(Vec::new()),
                max_pattern_len: 1,
            };
        };
        let mut patterns = secret_redaction_variants(secret);
        patterns.sort_by_key(|pattern| std::cmp::Reverse(pattern.len()));
        let max_pattern_len = patterns
            .iter()
            .map(|pattern| pattern.len())
            .max()
            .unwrap_or(1);
        let replacement = redaction_marker(name, &patterns);
        Self {
            patterns,
            replacement,
            pending: Zeroizing::new(Vec::new()),
            max_pattern_len,
        }
    }

    fn push(&mut self, bytes: &[u8], final_chunk: bool) -> Vec<u8> {
        if self.patterns.is_empty() {
            return bytes.to_vec();
        }
        self.pending.extend_from_slice(bytes);
        let limit = if final_chunk {
            self.pending.len()
        } else {
            self.pending
                .len()
                .saturating_sub(self.max_pattern_len.saturating_sub(1))
        };
        let mut output = Vec::with_capacity(limit);
        let mut offset = 0;
        while offset < limit {
            let matched = self
                .patterns
                .iter()
                .find(|pattern| self.pending[offset..].starts_with(pattern.as_slice()))
                .map(|pattern| pattern.len());
            if let Some(length) = matched {
                output.extend_from_slice(&self.replacement);
                offset += length;
            } else {
                output.push(self.pending[offset]);
                offset += 1;
            }
        }
        self.pending[..offset].zeroize();
        self.pending.drain(..offset);
        output
    }
}

fn secret_redaction_variants(secret: &[u8]) -> Vec<Zeroizing<Vec<u8>>> {
    let mut variants = Vec::new();
    push_secret_variant(&mut variants, secret.to_vec());
    if !(MIN_DERIVED_SECRET_BYTES..=MAX_DERIVED_SECRET_BYTES).contains(&secret.len()) {
        return variants;
    }

    let base64 = BASE64.encode(secret).into_bytes();
    push_secret_variant(&mut variants, base64_without_padding(base64.clone()));
    push_secret_variant(&mut variants, base64);
    let base64_url = BASE64_URL_SAFE.encode(secret).into_bytes();
    push_secret_variant(&mut variants, base64_without_padding(base64_url.clone()));
    push_secret_variant(&mut variants, base64_url);

    let base32 = encode_base32(secret);
    push_secret_variant(&mut variants, base64_without_padding(base32.clone()));
    let mut base32_lower = base32.clone();
    base32_lower.make_ascii_lowercase();
    push_secret_variant(&mut variants, base64_without_padding(base32_lower.clone()));
    push_secret_variant(&mut variants, base32);
    push_secret_variant(&mut variants, base32_lower);

    push_secret_variant(&mut variants, encode_hex(secret, false));
    push_secret_variant(&mut variants, encode_hex(secret, true));
    push_secret_variant(&mut variants, encode_percent(secret, false));
    push_secret_variant(&mut variants, encode_percent(secret, true));
    push_secret_variant(&mut variants, encode_hex_escape(secret, false));
    push_secret_variant(&mut variants, encode_hex_escape(secret, true));
    push_secret_variant(&mut variants, encode_unicode_escape(secret, false));
    push_secret_variant(&mut variants, encode_unicode_escape(secret, true));
    push_secret_variant(&mut variants, encode_octal(secret, true, false));
    push_secret_variant(&mut variants, encode_octal(secret, false, false));
    push_secret_variant(&mut variants, encode_octal(secret, false, true));
    push_secret_variant(&mut variants, encode_binary(secret, false));
    push_secret_variant(&mut variants, encode_binary(secret, true));

    let mut sha256 = Sha256::digest(secret);
    push_secret_variant(&mut variants, encode_hex(&sha256, false));
    push_secret_variant(&mut variants, encode_hex(&sha256, true));
    sha256.as_mut_slice().zeroize();
    let mut sha512 = Sha512::digest(secret);
    push_secret_variant(&mut variants, encode_hex(&sha512, false));
    push_secret_variant(&mut variants, encode_hex(&sha512, true));
    sha512.as_mut_slice().zeroize();
    variants
}

fn push_secret_variant(variants: &mut Vec<Zeroizing<Vec<u8>>>, mut value: Vec<u8>) {
    if value.is_empty()
        || variants
            .iter()
            .any(|existing| existing.as_slice() == value.as_slice())
    {
        value.zeroize();
        return;
    }
    variants.push(Zeroizing::new(value));
}

fn base64_without_padding(mut value: Vec<u8>) -> Vec<u8> {
    while value.last() == Some(&b'=') {
        value.pop();
    }
    value
}

fn encode_base32(value: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(value.len().div_ceil(5) * 8);
    let mut accumulator = 0_u16;
    let mut bits = 0_u8;
    for byte in value {
        accumulator = (accumulator << 8) | u16::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            output.push(BASE32_ALPHABET[usize::from((accumulator >> bits) & 0x1f)]);
        }
        if bits == 0 {
            accumulator = 0;
        } else {
            accumulator &= (1_u16 << bits) - 1;
        }
    }
    if bits > 0 {
        output.push(BASE32_ALPHABET[usize::from((accumulator << (5 - bits)) & 0x1f)]);
    }
    while output.len() % 8 != 0 {
        output.push(b'=');
    }
    output
}

fn encode_hex(value: &[u8], upper: bool) -> Vec<u8> {
    let alphabet = if upper {
        b"0123456789ABCDEF"
    } else {
        b"0123456789abcdef"
    };
    let mut output = Vec::with_capacity(value.len() * 2);
    for byte in value {
        output.push(alphabet[usize::from(byte >> 4)]);
        output.push(alphabet[usize::from(byte & 0x0f)]);
    }
    output
}

fn encode_percent(value: &[u8], lower: bool) -> Vec<u8> {
    let mut output = Vec::with_capacity(value.len() * 3);
    let hex = Zeroizing::new(encode_hex(value, !lower));
    for pair in hex.as_chunks::<2>().0 {
        output.push(b'%');
        output.extend_from_slice(pair);
    }
    output
}

fn encode_hex_escape(value: &[u8], upper: bool) -> Vec<u8> {
    let mut output = Vec::with_capacity(value.len() * 4);
    let hex = Zeroizing::new(encode_hex(value, upper));
    for pair in hex.as_chunks::<2>().0 {
        output.extend_from_slice(b"\\x");
        output.extend_from_slice(pair);
    }
    output
}

fn encode_unicode_escape(value: &[u8], upper: bool) -> Vec<u8> {
    let mut output = Vec::with_capacity(value.len() * 6);
    let hex = Zeroizing::new(encode_hex(value, upper));
    for pair in hex.as_chunks::<2>().0 {
        output.extend_from_slice(b"\\u00");
        output.extend_from_slice(pair);
    }
    output
}

fn encode_octal(value: &[u8], escaped: bool, spaced: bool) -> Vec<u8> {
    let unit = usize::from(escaped) + 3 + usize::from(spaced);
    let mut output = Vec::with_capacity(value.len() * unit);
    for (index, byte) in value.iter().enumerate() {
        if spaced && index > 0 {
            output.push(b' ');
        }
        if escaped {
            output.push(b'\\');
        }
        output.push(b'0' + ((byte >> 6) & 0x03));
        output.push(b'0' + ((byte >> 3) & 0x07));
        output.push(b'0' + (byte & 0x07));
    }
    output
}

fn encode_binary(value: &[u8], spaced: bool) -> Vec<u8> {
    let mut output = Vec::with_capacity(value.len() * (8 + usize::from(spaced)));
    for (index, byte) in value.iter().enumerate() {
        if spaced && index > 0 {
            output.push(b' ');
        }
        for shift in (0..8).rev() {
            output.push(b'0' + ((byte >> shift) & 1));
        }
    }
    output
}

fn redaction_marker(name: &str, patterns: &[Zeroizing<Vec<u8>>]) -> Vec<u8> {
    let candidates = [
        format!("[REDACTED: {name}]").into_bytes(),
        b"[REDACTED: SECRET]".to_vec(),
        b"[REDACTED]".to_vec(),
        b"<filtered>".to_vec(),
    ];
    for mut candidate in candidates {
        if !patterns
            .iter()
            .any(|pattern| contains_slice(&candidate, pattern))
        {
            return candidate;
        }
        candidate.zeroize();
    }
    for byte in b'!'..=b'~' {
        let candidate = vec![byte];
        if !patterns
            .iter()
            .any(|pattern| contains_slice(&candidate, pattern))
        {
            return candidate;
        }
    }
    Vec::new()
}
fn contains_slice(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && needle.len() <= haystack.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

#[cfg(target_os = "linux")]
async fn kill_child_process_group(child: &mut tokio::process::Child) {
    if let Some(pid) = child
        .id()
        .and_then(|pid| rustix::process::Pid::from_raw(pid as i32))
    {
        let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
    }
    let _ = child.wait().await;
}

#[cfg(not(target_os = "linux"))]
async fn kill_child_process_group(child: &mut tokio::process::Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn validate_secret_name(value: &str) -> Result<String, AccessError> {
    let value = value.trim().to_ascii_uppercase();
    validate_environment_name(&value)?;
    Ok(value)
}

fn validate_environment_name(value: &str) -> Result<(), AccessError> {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err(AccessError::Invalid("secret name is required".to_owned()));
    };
    if value.len() > 128
        || !(first == b'_' || first.is_ascii_alphabetic())
        || !bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
    {
        return Err(AccessError::Invalid(
            "secret name must be a valid environment variable name".to_owned(),
        ));
    }
    Ok(())
}

fn validate_description(value: &str) -> Result<String, AccessError> {
    validate_optional_description(value)?.ok_or_else(|| {
        AccessError::Invalid("a description of why access is needed is required".to_owned())
    })
}

fn validate_optional_description(value: &str) -> Result<Option<String>, AccessError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_DESCRIPTION_BYTES
        || value
            .chars()
            .any(|character| character.is_control() && character != '\n')
    {
        return Err(AccessError::Invalid(
            "description is too long or contains control characters".to_owned(),
        ));
    }
    Ok(Some(value.to_owned()))
}

fn validate_agent(value: &str) -> Result<String, AccessError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(AccessError::Invalid("invalid agent name".to_owned()));
    }
    Ok(value.to_owned())
}

fn validate_secret_value(value: String) -> Result<Zeroizing<String>, AccessError> {
    if value.is_empty() {
        return Err(AccessError::Invalid("secret value is required".to_owned()));
    }
    if value.len() > 64 * 1024 {
        return Err(AccessError::Invalid("secret value is too large".to_owned()));
    }
    Ok(Zeroizing::new(value))
}

fn validate_sudo_password_value(value: String) -> Result<Zeroizing<String>, AccessError> {
    if value
        .bytes()
        .any(|byte| matches!(byte, b'\0' | b'\n' | b'\r'))
    {
        return Err(AccessError::Invalid(
            "sudo password cannot contain line breaks or NUL bytes".to_owned(),
        ));
    }
    validate_secret_value(value)
}

fn sanitize_command_environment(command: &mut Command) {
    command.env_clear();
    for name in SAFE_COMMAND_ENVIRONMENT {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn validate_command(mut command: Vec<String>) -> Result<Vec<String>, AccessError> {
    if command.is_empty() || command.len() > MAX_COMMAND_ARGUMENTS {
        return Err(AccessError::Invalid(
            "invalid command argument count".to_owned(),
        ));
    }
    let bytes = command.iter().map(String::len).sum::<usize>();
    if bytes > MAX_COMMAND_BYTES || command.iter().any(|argument| argument.is_empty()) {
        return Err(AccessError::Invalid(
            "command is empty or too large".to_owned(),
        ));
    }
    let executable = Path::new(&command[0]);
    if !executable.is_absolute() {
        return Err(AccessError::Invalid(
            "command executable must be an absolute path".to_owned(),
        ));
    }
    let executable = executable.canonicalize().map_err(|error| {
        AccessError::Invalid(format!("command executable is unavailable: {error}"))
    })?;
    if !executable.is_file() {
        return Err(AccessError::Invalid(
            "command executable must be a regular file".to_owned(),
        ));
    }
    command[0] = executable
        .into_os_string()
        .into_string()
        .map_err(|_| AccessError::Invalid("command path is not valid UTF-8".to_owned()))?;
    Ok(command)
}

fn validate_cwd(cwd: PathBuf) -> Result<PathBuf, AccessError> {
    cwd.canonicalize()
        .map_err(|error| AccessError::Invalid(format!("command directory is unavailable: {error}")))
}

fn validate_sudo_command(
    command: Vec<String>,
) -> Result<(Vec<String>, String, FileIdentity), AccessError> {
    let command = validate_command(command)?;
    let executable = PathBuf::from(&command[0]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;

        let metadata = executable.metadata().map_err(|error| {
            AccessError::Invalid(format!("command executable is unavailable: {error}"))
        })?;
        if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(AccessError::Invalid(
                "sudo executable must be root-owned and not group- or world-writable".to_owned(),
            ));
        }
    }
    #[cfg(not(unix))]
    return Err(AccessError::Unavailable(
        "trusted sudo executable checks require Unix".to_owned(),
    ));
    let executable_hash = executable_digest(&executable)?;
    let executable_identity = file_identity(&executable)?;
    Ok((command, executable_hash, executable_identity))
}

fn validate_sudo_cwd(cwd: PathBuf) -> Result<(PathBuf, FileIdentity), AccessError> {
    let cwd = validate_cwd(cwd)?;
    let identity = file_identity(&cwd)?;
    Ok((cwd, identity))
}

fn executable_digest(path: &Path) -> Result<String, AccessError> {
    let mut file = std::fs::File::open(path).map_err(|error| {
        AccessError::Invalid(format!("command executable is unavailable: {error}"))
    })?;
    executable_digest_file(&mut file).map_err(|error| {
        AccessError::Invalid(format!("unable to hash command executable: {error}"))
    })
}

fn file_identity(path: &Path) -> Result<FileIdentity, AccessError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;

        let metadata = path.metadata().map_err(|error| {
            AccessError::Invalid(format!("command filesystem object is unavailable: {error}"))
        })?;
        Ok(FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(AccessError::Unavailable(
            "sudo object identity checks require Unix".to_owned(),
        ))
    }
}

fn sudo_objects_match(execution: &SudoExecution) -> bool {
    let executable = Path::new(&execution.command[0]);
    executable_digest(executable).is_ok_and(|digest| digest == execution.executable_hash)
        && file_identity(executable).is_ok_and(|identity| identity == execution.executable_identity)
        && file_identity(&execution.cwd).is_ok_and(|identity| identity == execution.cwd_identity)
}

fn executable_digest_file(file: &mut std::fs::File) -> std::io::Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 32 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn command_display(command: &[String]) -> String {
    command
        .iter()
        .map(|argument| shell_quote(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'_' | b'-' | b'.' | b'/' | b':' | b'@' | b'+' | b'=' | b','
                )
        })
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn hash_parts(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

pub fn current_process_start_ticks() -> Result<u64, AccessError> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string("/proc/self/stat").map_err(|error| {
            AccessError::Unavailable(format!("unable to identify requester: {error}"))
        })?;
        let close = stat
            .rfind(')')
            .ok_or_else(|| AccessError::Unavailable("invalid process identity".to_owned()))?;
        stat[close + 1..]
            .split_whitespace()
            .nth(19)
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| AccessError::Unavailable("invalid process identity".to_owned()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(AccessError::Unavailable(
            "integrated access requests currently require Linux".to_owned(),
        ))
    }
}

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn context() -> AgentRequestContext {
        AgentRequestContext {
            pid: std::process::id(),
            start_ticks: current_process_start_ticks().unwrap_or_default(),
            agent: "omp".to_owned(),
        }
    }

    #[tokio::test]
    async fn proactive_secret_grant_resolves_matching_pending_request() {
        let manager = AccessManager::default();
        let terminal = Uuid::new_v4();
        let mut subscription = manager
            .request_secret(
                terminal,
                AgentSecretRequest {
                    context: context(),
                    name: "TOKEN".to_owned(),
                    description: "Use the service".to_owned(),
                },
            )
            .unwrap();
        assert!(matches!(
            subscription.next().await,
            Some(AgentAccessEvent::Waiting { .. })
        ));
        manager
            .add_secret(
                terminal,
                AddSecretGrant {
                    name: "TOKEN".to_owned(),
                    value: "proactive-value".to_owned(),
                    description: Some("Added before approval".to_owned()),
                },
            )
            .unwrap();
        assert!(matches!(
            subscription.next().await,
            Some(AgentAccessEvent::Granted { .. })
        ));
        let snapshot = manager.snapshot(terminal);
        assert!(snapshot.requests.is_empty());
        assert_eq!(snapshot.grants.len(), 1);
    }

    #[tokio::test]
    async fn secret_request_deduplicates_and_approval_never_exposes_value() {
        let manager = AccessManager::default();
        let terminal = Uuid::new_v4();
        let request = AgentSecretRequest {
            context: context(),
            name: "demo_token".to_owned(),
            description: "Publish a preview".to_owned(),
        };
        let mut first = manager.request_secret(terminal, request.clone()).unwrap();
        let _second = manager.request_secret(terminal, request).unwrap();
        assert!(matches!(
            manager.request_secret(
                terminal,
                AgentSecretRequest {
                    context: context(),
                    name: "DEMO_TOKEN".to_owned(),
                    description: "Use it for a different purpose".to_owned(),
                },
            ),
            Err(AccessError::Conflict(_))
        ));
        let snapshot = manager.snapshot(terminal);
        assert_eq!(snapshot.requests.len(), 1);
        assert_eq!(snapshot.requests[0].waiters, 2);
        let id = snapshot.requests[0].id;
        manager
            .approve_secret(
                terminal,
                id,
                SecretApproval {
                    request_hash: snapshot.requests[0].request_hash.clone(),
                    value: "never-serialize-this".to_owned(),
                },
            )
            .unwrap();
        assert!(matches!(
            first.next().await,
            Some(AgentAccessEvent::Waiting { .. })
        ));
        assert!(matches!(
            first.next().await,
            Some(AgentAccessEvent::Granted { .. })
        ));
        let encoded = serde_json::to_string(&manager.snapshot(terminal)).unwrap();
        assert!(!encoded.contains("never-serialize-this"));
    }

    #[test]
    fn sudo_password_rejects_line_injection() {
        assert!(matches!(
            validate_sudo_password_value("password\nextra-input".to_owned()),
            Err(AccessError::Invalid(_))
        ));
    }

    #[test]
    fn pending_requests_are_bounded_per_terminal() {
        let manager = AccessManager::default();
        let terminal = Uuid::new_v4();
        let mut subscriptions = Vec::new();
        for index in 0..MAX_PENDING_REQUESTS_PER_TERMINAL {
            subscriptions.push(
                manager
                    .request_secret(
                        terminal,
                        AgentSecretRequest {
                            context: context(),
                            name: format!("TOKEN_{index}"),
                            description: "Bounded request".to_owned(),
                        },
                    )
                    .unwrap(),
            );
        }
        assert!(matches!(
            manager.request_secret(
                terminal,
                AgentSecretRequest {
                    context: context(),
                    name: "ONE_TOO_MANY".to_owned(),
                    description: "Bounded request".to_owned(),
                },
            ),
            Err(AccessError::Conflict(_))
        ));
    }

    #[test]
    fn stale_request_hash_cannot_reject_changed_request() {
        let manager = AccessManager::default();
        let terminal = Uuid::new_v4();
        let _subscription = manager
            .request_secret(
                terminal,
                AgentSecretRequest {
                    context: context(),
                    name: "TOKEN".to_owned(),
                    description: "Use service".to_owned(),
                },
            )
            .unwrap();
        let request = &manager.snapshot(terminal).requests[0];
        assert!(matches!(
            manager.reject(
                terminal,
                request.id,
                AccessDecision {
                    request_hash: "stale".to_owned(),
                    comment: None,
                },
            ),
            Err(AccessError::Stale)
        ));
    }

    #[test]
    fn redactor_catches_secrets_split_across_output_chunks() {
        let mut redactor = OutputRedactor::new(Some(("API_KEY", b"secret-value")));
        let mut output = redactor.push(b"before secret-", false);
        output.extend(redactor.push(b"value after", true));
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "before [REDACTED: API_KEY] after"
        );
    }

    #[test]
    fn redactor_catches_common_encoded_and_hashed_variations() {
        let secret = b"s3cr3t!";
        let sha256 = "d765af45f799c9d060386c88b6459d03fa2ca4dd32e864f95ceea43b52955a9b";
        let sha512 = "670fd70cf9c5eb009281fbca10051b0708c3faa14350a9df6c6cc4a07fec07546db3dcf5b20310a482212b6f7047786d7a8a9c2655d8507d29d400428ed3ab48";
        let variants = vec![
            "s3cr3t!".to_owned(),
            "czNjcjN0IQ==".to_owned(),
            "czNjcjN0IQ".to_owned(),
            "OMZWG4RTOQQQ====".to_owned(),
            "OMZWG4RTOQQQ".to_owned(),
            "omzwg4rtoqqq".to_owned(),
            "73336372337421".to_owned(),
            "73336372337421".to_uppercase(),
            "%73%33%63%72%33%74%21".to_owned(),
            "\\x73\\x33\\x63\\x72\\x33\\x74\\x21".to_owned(),
            "\\u0073\\u0033\\u0063\\u0072\\u0033\\u0074\\u0021".to_owned(),
            "\\163\\063\\143\\162\\063\\164\\041".to_owned(),
            "163063143162063164041".to_owned(),
            "163 063 143 162 063 164 041".to_owned(),
            "01110011001100110110001101110010001100110111010000100001".to_owned(),
            "01110011 00110011 01100011 01110010 00110011 01110100 00100001".to_owned(),
            sha256.to_owned(),
            sha256.to_uppercase(),
            sha512.to_owned(),
            sha512.to_uppercase(),
        ];
        for variant in variants {
            let split = variant.len() / 2;
            let mut redactor = OutputRedactor::new(Some(("SERVICE_TOKEN", secret)));
            let mut output = redactor.push(b"prefix ", false);
            output.extend(redactor.push(&variant.as_bytes()[..split], false));
            output.extend(redactor.push(&variant.as_bytes()[split..], false));
            output.extend(redactor.push(b" suffix", true));
            assert_eq!(
                String::from_utf8(output).unwrap(),
                "prefix [REDACTED: SERVICE_TOKEN] suffix",
                "variant was not redacted: {variant}"
            );
        }
    }

    #[test]
    fn redaction_marker_never_reprints_the_secret_value() {
        let mut redactor = OutputRedactor::new(Some(("API_KEY", b"API_KEY")));
        let output = redactor.push(b"API_KEY", true);
        assert!(!contains_slice(&output, b"API_KEY"));
        assert_eq!(String::from_utf8(output).unwrap(), "[REDACTED: SECRET]");
    }

    #[test]
    fn short_secrets_do_not_enable_derived_redaction() {
        let mut redactor = OutputRedactor::new(Some(("TOKEN", b"abc")));
        let output = redactor.push(b"YWJj abc", true);
        assert_eq!(String::from_utf8(output).unwrap(), "YWJj [REDACTED: TOKEN]");
    }

    #[test]
    fn redactor_catches_url_safe_and_uppercase_variations() {
        for variant in ["MDA+Pg==", "MDA+Pg", "MDA-Pg==", "MDA-Pg"] {
            let mut redactor = OutputRedactor::new(Some(("TOKEN", b"00>>")));
            assert_eq!(
                String::from_utf8(redactor.push(variant.as_bytes(), true)).unwrap(),
                "[REDACTED: TOKEN]"
            );
        }
        for variant in [
            "746F6B656E7A",
            "%74%6F%6B%65%6E%7A",
            "\\x74\\x6F\\x6B\\x65\\x6E\\x7A",
            "\\u0074\\u006F\\u006B\\u0065\\u006E\\u007A",
        ] {
            let mut redactor = OutputRedactor::new(Some(("TOKEN", b"tokenz")));
            assert_eq!(
                String::from_utf8(redactor.push(variant.as_bytes(), true)).unwrap(),
                "[REDACTED: TOKEN]"
            );
        }
    }

    #[test]
    fn command_display_quotes_without_invoking_a_shell() {
        assert_eq!(
            command_display(&[
                "printf".to_owned(),
                "%s\\n".to_owned(),
                "hello world".to_owned()
            ]),
            "printf '%s\\n' 'hello world'"
        );
    }

    #[tokio::test]
    async fn secret_execution_redacts_value_and_inherits_only_safe_environment() {
        let manager = AccessManager::default();
        let terminal = Uuid::new_v4();
        manager
            .add_secret(
                terminal,
                AddSecretGrant {
                    name: "TOKEN".to_owned(),
                    value: "super-secret".to_owned(),
                    description: None,
                },
            )
            .unwrap();
        let mut subscription = manager
            .execute_secret(
                terminal,
                AgentSecretExecute {
                    context: context(),
                    name: "TOKEN".to_owned(),
                    cwd: std::env::current_dir().unwrap(),
                    command: vec![
                        "/bin/sh".to_owned(),
                        "-c".to_owned(),
                        "printf '%s' \"$TOKEN\"".to_owned(),
                    ],
                    delivery: SecretDelivery::Env {
                        name: "TOKEN".to_owned(),
                    },
                },
            )
            .unwrap();
        let mut output = Vec::new();
        let mut return_code = None;
        while let Some(event) = subscription.next().await {
            match event {
                AgentAccessEvent::Output { data } => output.extend(BASE64.decode(data).unwrap()),
                AgentAccessEvent::Completed { return_code: code } => {
                    return_code = Some(code);
                    break;
                }
                AgentAccessEvent::Failed { message } => panic!("{message}"),
                _ => {}
            }
        }
        assert_eq!(return_code, Some(0));
        assert_eq!(String::from_utf8(output).unwrap(), "[REDACTED: TOKEN]");
        assert_eq!(manager.snapshot(terminal).grants[0].uses, 1);

        let mut command = Command::new("/usr/bin/env");
        command.env("TERM_SERVER_BROKER_CONTROL_TOKEN", "must-not-leak");
        sanitize_command_environment(&mut command);
        let environment = command.output().await.unwrap().stdout;
        assert!(
            !String::from_utf8_lossy(&environment).contains("TERM_SERVER_BROKER_CONTROL_TOKEN")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_secret_execution_cancels_credential_bearing_command() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("should-not-exist");
        let manager = AccessManager::default();
        let terminal = Uuid::new_v4();
        manager
            .add_secret(
                terminal,
                AddSecretGrant {
                    name: "TOKEN".to_owned(),
                    value: "secret".to_owned(),
                    description: None,
                },
            )
            .unwrap();
        let mut subscription = manager
            .execute_secret(
                terminal,
                AgentSecretExecute {
                    context: context(),
                    name: "TOKEN".to_owned(),
                    cwd: directory.path().to_owned(),
                    command: vec![
                        "/bin/sh".to_owned(),
                        "-c".to_owned(),
                        format!("sleep 2; touch {}", marker.display()),
                    ],
                    delivery: SecretDelivery::Env {
                        name: "TOKEN".to_owned(),
                    },
                },
            )
            .unwrap();
        assert!(matches!(
            subscription.next().await,
            Some(AgentAccessEvent::Running { .. })
        ));
        drop(subscription);
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sudo_password_is_checked_before_exact_command_runs() {
        let directory = tempfile::tempdir().unwrap();
        let sudo = directory.path().join("sudo");
        std::fs::write(
            &sudo,
            r#"#!/bin/sh
case "$1" in
  -S)
    IFS= read -r password
    [ "$password" = "correct-password" ] || exit 1
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -v) exit 0 ;;
        --) shift; exec "$@" ;;
        *) shift ;;
      esac
    done
    ;;
  -K)
    exit 0
    ;;
esac
exit 2
"#,
        )
        .unwrap();
        std::fs::set_permissions(&sudo, std::fs::Permissions::from_mode(0o700)).unwrap();
        let manager = AccessManager::new(sudo);
        let terminal = Uuid::new_v4();
        let mut subscription = manager
            .request_sudo(
                terminal,
                AgentSudoRequest {
                    context: context(),
                    description: "Print the reviewed marker".to_owned(),
                    cwd: std::env::current_dir().unwrap(),
                    command: vec![
                        "/bin/sh".to_owned(),
                        "-c".to_owned(),
                        "printf root-ok".to_owned(),
                    ],
                },
            )
            .unwrap();
        let request = manager.snapshot(terminal).requests[0].clone();
        assert!(matches!(
            manager
                .approve_sudo(
                    terminal,
                    request.id,
                    SudoApproval {
                        request_hash: request.request_hash.clone(),
                        password: "wrong-password".to_owned(),
                    },
                )
                .await,
            Err(AccessError::Invalid(_))
        ));
        assert_eq!(
            manager.snapshot(terminal).requests[0].state,
            AccessRequestState::Pending
        );
        manager
            .approve_sudo(
                terminal,
                request.id,
                SudoApproval {
                    request_hash: request.request_hash,
                    password: "correct-password".to_owned(),
                },
            )
            .await
            .unwrap();
        let mut output = Vec::new();
        let mut return_code = None;
        while let Some(event) = subscription.next().await {
            match event {
                AgentAccessEvent::Output { data } => output.extend(BASE64.decode(data).unwrap()),
                AgentAccessEvent::Completed { return_code: code } => {
                    return_code = Some(code);
                    break;
                }
                AgentAccessEvent::Failed { message } => panic!("{message}"),
                _ => {}
            }
        }
        assert_eq!(return_code, Some(0));
        assert_eq!(String::from_utf8(output).unwrap(), "root-ok");
        let snapshot = manager.snapshot(terminal);
        assert!(snapshot.requests.is_empty());
        assert_eq!(snapshot.activity[0].status, AccessActivityStatus::Approved);
    }
}
