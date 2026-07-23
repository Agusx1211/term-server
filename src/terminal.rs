use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use parking_lot::{Mutex, RwLock};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::ai::{PiRequest, PiService, PiTaskKind};

// Neighboring buckets jump across the hue wheel and keep similar luminance across themes.
const COLORS: [&str; 64] = [
    "#e05b5b", "#179874", "#ea42a1", "#1e9b31", "#d14ae4", "#489811", "#9572e4", "#888c15",
    "#5c81ed", "#c67126", "#1a92ae", "#eb4e5d", "#1d996a", "#e447ae", "#119c1a", "#c259df",
    "#569616", "#8d72ef", "#90891c", "#5284e5", "#dc6218", "#1f94a0", "#e5536e", "#119a5a",
    "#dd4cb9", "#1b9c17", "#be58ec", "#63941c", "#8576eb", "#9b8611", "#4688dc", "#df5e2c",
    "#119696", "#df577d", "#179a51", "#e834cc", "#2d9b1d", "#b162e8", "#6a9310", "#7d7ae6",
    "#a58219", "#2089e6", "#db6144", "#16978b", "#eb4885", "#1d9a48", "#e23ad7", "#2f9b11",
    "#a66ae3", "#769116", "#737bef", "#ae7e21", "#1f8dd0", "#ea5243", "#1d9780", "#e44d94",
    "#119c34", "#d746dc", "#409917", "#a06aee", "#808e1b", "#6b7ee9", "#c07515", "#2490bb",
];
const MEANINGFUL_OUTPUT_BYTES: u64 = 2 * 1024;
const MEANINGFUL_CPU_TICKS: u64 = 3;
const ACTIVE_SAMPLES_TO_WORKING: u8 = 3;
const QUIET_SAMPLES_TO_IDLE: u8 = 5;
const SUBMISSION_WORKING_MILLIS: u64 = 12_000;
const PI_QUIET_SAMPLES_TO_IDLE: u8 = 2;
const PI_SUBMISSION_WORKING_MILLIS: u64 = 3_000;
const REPORTED_WORKING_FRESH_MILLIS: u64 = 5_000;
const MAX_CAPTURED_PROMPT_CHARS: usize = 16_000;
const DEFAULT_VIEWPORT_SIZE: ViewportSize = ViewportSize {
    cols: 100,
    rows: 30,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Working,
    Idle,
    Closed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub kind: String,
    pub status: AgentStatus,
    pub status_changed_at: u64,
    pub started_at: u64,
    pub revision: u64,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: Uuid,
    pub name: String,
    pub workspace: String,
    pub path: String,
    pub cwd: PathBuf,
    pub shell: String,
    pub program: String,
    pub color: String,
    pub agent: Option<AgentInfo>,
    pub created_at: u64,
    pub pid: Option<u32>,
    pub status: TerminalStatus,
    pub exit_code: Option<u32>,
    pub clients: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminal {
    pub path: Option<String>,
    pub cwd: Option<PathBuf>,
    pub shell: Option<String>,
    pub clone_from: Option<Uuid>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenameTerminal {
    pub path: String,
}

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("terminal path must contain 1 to 256 characters")]
    InvalidPath,
    #[error("a terminal already exists at {0}")]
    DuplicatePath(String),
    #[error("working directory does not exist or is not a directory: {0}")]
    InvalidWorkingDirectory(String),
    #[error("the terminal to clone no longer exists")]
    CloneSourceNotFound,
    #[error("unable to start {shell}: {message}")]
    Spawn { shell: String, message: String },
    #[error("terminal I/O failed: {0}")]
    Io(String),
}

#[derive(Debug, Clone)]
pub enum TerminalEvent {
    Output(Bytes),
    Exit(u32),
    Size(TerminalSizeState),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSizeState {
    pub cols: u16,
    pub rows: u16,
    pub focused_client: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ViewportSize {
    cols: u16,
    rows: u16,
}

impl ViewportSize {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.clamp(2, 500),
            rows: rows.clamp(1, 300),
        }
    }
}

#[derive(Debug)]
struct ClientViewports {
    sizes: HashMap<Uuid, Option<ViewportSize>>,
    focused_client: Option<Uuid>,
    published: TerminalSizeState,
}

impl Default for ClientViewports {
    fn default() -> Self {
        Self {
            sizes: HashMap::new(),
            focused_client: None,
            published: TerminalSizeState {
                cols: DEFAULT_VIEWPORT_SIZE.cols,
                rows: DEFAULT_VIEWPORT_SIZE.rows,
                focused_client: None,
            },
        }
    }
}

impl ClientViewports {
    fn attach(&mut self, client_id: Uuid, size: Option<ViewportSize>) {
        self.sizes.insert(client_id, size);
    }

    fn detach(&mut self, client_id: Uuid) {
        self.sizes.remove(&client_id);
        if self.focused_client == Some(client_id) {
            self.focused_client = None;
        }
    }

    fn resize(&mut self, client_id: Uuid, size: ViewportSize) {
        if let Some(current) = self.sizes.get_mut(&client_id) {
            *current = Some(size);
        }
    }

    fn focus(&mut self, client_id: Uuid, focused: bool) {
        if focused && self.sizes.get(&client_id).is_some_and(Option::is_some) {
            self.focused_client = Some(client_id);
        } else if !focused && self.focused_client == Some(client_id) {
            self.focused_client = None;
        }
    }

    fn state(&self) -> TerminalSizeState {
        let size = self
            .focused_client
            .and_then(|client_id| self.sizes.get(&client_id).copied().flatten())
            .or_else(|| {
                self.sizes
                    .values()
                    .filter_map(|size| *size)
                    .reduce(|smallest, size| ViewportSize {
                        cols: smallest.cols.min(size.cols),
                        rows: smallest.rows.min(size.rows),
                    })
            })
            .unwrap_or(ViewportSize {
                cols: self.published.cols,
                rows: self.published.rows,
            });
        TerminalSizeState {
            cols: size.cols,
            rows: size.rows,
            focused_client: self.focused_client,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRecord {
    pub id: String,
    pub pid: u32,
    pub parent_id: Option<String>,
    pub command: String,
    pub arguments: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub foreground: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInspectorSnapshot {
    pub supported: bool,
    pub processes: Vec<ProcessRecord>,
}

#[derive(Debug)]
struct ReplayBuffer {
    chunks: VecDeque<Bytes>,
    bytes: usize,
    maximum_bytes: usize,
}

impl ReplayBuffer {
    fn new(maximum_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            maximum_bytes,
        }
    }

    fn push(&mut self, chunk: Bytes) {
        if chunk.is_empty() {
            return;
        }
        self.bytes += chunk.len();
        self.chunks.push_back(chunk);
        while self.bytes > self.maximum_bytes && self.chunks.len() > 1 {
            if let Some(removed) = self.chunks.pop_front() {
                self.bytes -= removed.len();
            }
        }
    }

    fn snapshot(&self) -> Vec<Bytes> {
        self.chunks.iter().cloned().collect()
    }

    fn text_tail(&self, maximum_bytes: usize) -> String {
        let mut remaining = maximum_bytes;
        let mut chunks = Vec::new();
        for chunk in self.chunks.iter().rev() {
            if remaining == 0 {
                break;
            }
            let start = chunk.len().saturating_sub(remaining);
            chunks.push(chunk.slice(start..));
            remaining = remaining.saturating_sub(chunk.len() - start);
        }
        chunks.reverse();
        let mut bytes = Vec::new();
        for chunk in chunks {
            bytes.extend_from_slice(&chunk);
        }
        sanitize_terminal_text(&String::from_utf8_lossy(&bytes))
    }
}

#[derive(Debug, Default)]
struct PromptCapture {
    characters: Vec<char>,
    cursor: usize,
    escape: String,
    bracketed_paste: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct PromptInput {
    submitted: bool,
    prompt: Option<String>,
}

fn title_prompt_for_submission(
    agent_status: &AgentStatus,
    prompt: Option<String>,
) -> Option<String> {
    if *agent_status == AgentStatus::Idle {
        prompt
    } else {
        None
    }
}

impl PromptCapture {
    fn observe(&mut self, bytes: &[u8]) -> PromptInput {
        let mut input = PromptInput::default();
        for character in String::from_utf8_lossy(bytes).chars() {
            self.observe_character(character, &mut input);
        }
        input
    }

    fn observe_character(&mut self, character: char, input: &mut PromptInput) {
        if !self.escape.is_empty() {
            if self.escape == "\u{1b}" && !matches!(character, '[' | 'O') {
                self.escape.clear();
                if matches!(character, '\r' | '\n') {
                    self.insert('\n');
                    return;
                }
                self.observe_character(character, input);
                return;
            }
            self.escape.push(character);
            if escape_sequence_complete(&self.escape) {
                let sequence = std::mem::take(&mut self.escape);
                self.apply_escape(&sequence);
            } else if self.escape.chars().count() > 32 {
                self.escape.clear();
            }
            return;
        }

        match character {
            '\u{1b}' => self.escape.push(character),
            '\r' | '\n' if self.bracketed_paste => self.insert('\n'),
            '\r' | '\n' => {
                input.submitted = true;
                let prompt = self.characters.iter().collect::<String>();
                let prompt = prompt.trim();
                if !prompt.is_empty() {
                    input.prompt = Some(prompt.to_owned());
                }
                self.characters.clear();
                self.cursor = 0;
            }
            '\u{1}' => self.cursor = 0,
            '\u{5}' => self.cursor = self.characters.len(),
            '\u{3}' | '\u{15}' => {
                self.characters.clear();
                self.cursor = 0;
            }
            '\u{11}' => self.characters.truncate(self.cursor),
            '\u{17}' => self.delete_previous_word(),
            '\u{8}' | '\u{7f}' => self.delete_before_cursor(),
            '\u{4}' => self.delete_at_cursor(),
            '\t' => {}
            value if !value.is_control() => self.insert(value),
            _ => {}
        }
    }

    fn apply_escape(&mut self, sequence: &str) {
        match sequence {
            "\u{1b}[200~" => self.bracketed_paste = true,
            "\u{1b}[201~" => self.bracketed_paste = false,
            "\u{1b}[H" | "\u{1b}[1~" | "\u{1b}[7~" | "\u{1b}OH" => self.cursor = 0,
            "\u{1b}[F" | "\u{1b}[4~" | "\u{1b}[8~" | "\u{1b}OF" => {
                self.cursor = self.characters.len();
            }
            "\u{1b}[3~" => self.delete_at_cursor(),
            "\u{1b}[13;2u" | "\u{1b}[27;2;13~" => self.insert('\n'),
            value if value.ends_with('D') => {
                self.cursor = self.cursor.saturating_sub(csi_count(value));
            }
            value if value.ends_with('C') => {
                self.cursor = (self.cursor + csi_count(value)).min(self.characters.len());
            }
            _ => {}
        }
    }

    fn insert(&mut self, character: char) {
        if self.characters.len() >= MAX_CAPTURED_PROMPT_CHARS {
            return;
        }
        self.characters.insert(self.cursor, character);
        self.cursor += 1;
    }

    fn delete_before_cursor(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
            self.characters.remove(self.cursor);
        }
    }

    fn delete_at_cursor(&mut self) {
        if self.cursor < self.characters.len() {
            self.characters.remove(self.cursor);
        }
    }

    fn delete_previous_word(&mut self) {
        while self.cursor > 0 && self.characters[self.cursor - 1].is_whitespace() {
            self.delete_before_cursor();
        }
        while self.cursor > 0 && !self.characters[self.cursor - 1].is_whitespace() {
            self.delete_before_cursor();
        }
    }
}

fn escape_sequence_complete(sequence: &str) -> bool {
    if sequence.starts_with("\u{1b}[") {
        return sequence.chars().nth(2).is_some_and(|_| {
            sequence
                .chars()
                .last()
                .is_some_and(|last| ('@'..='~').contains(&last))
        });
    }
    sequence.starts_with("\u{1b}O") && sequence.chars().count() >= 3
}

fn csi_count(sequence: &str) -> usize {
    sequence
        .trim_start_matches("\u{1b}[")
        .trim_end_matches(|character: char| character.is_ascii_alphabetic())
        .split(';')
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1)
}

#[derive(Debug)]
struct SessionActivity {
    automatic_name: bool,
    generated_title: Option<String>,
    agent_pid: Option<u32>,
    last_cpu_ticks: u64,
    last_sample_output_bytes: u64,
    active_samples: u8,
    quiet_samples: u8,
    input_submitted_at: u64,
    prompt_capture: PromptCapture,
    pending_title_prompt: Option<(u64, String)>,
    title_revision: u64,
    title_in_flight_revision: Option<u64>,
    summary_in_flight_revision: Option<u64>,
}

impl Default for SessionActivity {
    fn default() -> Self {
        Self {
            automatic_name: true,
            generated_title: None,
            agent_pid: None,
            last_cpu_ticks: 0,
            last_sample_output_bytes: 0,
            active_samples: 0,
            quiet_samples: 0,
            input_submitted_at: 0,
            prompt_capture: PromptCapture::default(),
            pending_title_prompt: None,
            title_revision: 0,
            title_in_flight_revision: None,
            summary_in_flight_revision: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReportedAgentState {
    Working,
    Idle,
}

#[derive(Debug, Default)]
struct TerminalSignals {
    pending: Vec<u8>,
    agent_state: Option<(ReportedAgentState, u64)>,
    active_title_seen: bool,
}

impl TerminalSignals {
    fn observe(&mut self, bytes: &[u8], now: u64) {
        self.pending.extend_from_slice(bytes);
        let mut consumed = 0;
        while let Some(relative_start) = self.pending[consumed..]
            .windows(2)
            .position(|window| window == b"\x1b]")
        {
            let start = consumed + relative_start;
            let payload_start = start + 2;
            let Some((payload_end, sequence_end)) = osc_end(&self.pending, payload_start) else {
                if start > 0 {
                    self.pending.drain(..start);
                }
                return;
            };
            let payload = self.pending[payload_start..payload_end].to_vec();
            self.observe_osc(&payload, now);
            consumed = sequence_end;
        }
        if consumed > 0 {
            self.pending.drain(..consumed);
        }
        if self.pending.len() > 1024 {
            let keep_from = self.pending.len() - 1024;
            self.pending.drain(..keep_from);
        }
    }

    fn observe_osc(&mut self, payload: &[u8], now: u64) {
        let text = String::from_utf8_lossy(payload);
        let normalized = text.trim().to_ascii_lowercase();
        let state = if normalized == "9;4;3" || normalized.starts_with("9;4;3;") {
            Some(ReportedAgentState::Working)
        } else if normalized == "9;4;0" || normalized.starts_with("9;4;0;") {
            Some(ReportedAgentState::Idle)
        } else if let Some(title) = normalized
            .strip_prefix("0;")
            .or_else(|| normalized.strip_prefix("2;"))
        {
            let first = title.trim_start().chars().next();
            if first.is_some_and(is_braille_spinner) {
                self.active_title_seen = true;
                Some(ReportedAgentState::Working)
            } else if first == Some('✳')
                || title.contains("action required")
                || title_contains_word(title, "ready")
            {
                self.active_title_seen = false;
                Some(ReportedAgentState::Idle)
            } else if std::mem::take(&mut self.active_title_seen) {
                Some(ReportedAgentState::Idle)
            } else if ["working", "thinking", "waiting"]
                .iter()
                .any(|word| title_contains_word(title, word))
            {
                Some(ReportedAgentState::Working)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(state) = state {
            self.agent_state = Some((state, now));
        }
    }
}

fn is_braille_spinner(character: char) -> bool {
    ('\u{2800}'..='\u{28ff}').contains(&character)
}

fn osc_end(bytes: &[u8], start: usize) -> Option<(usize, usize)> {
    for index in start..bytes.len() {
        if bytes[index] == b'\x07' {
            return Some((index, index + 1));
        }
        if bytes[index] == b'\x1b' && bytes.get(index + 1) == Some(&b'\\') {
            return Some((index, index + 2));
        }
    }
    None
}

fn title_contains_word(title: &str, expected: &str) -> bool {
    title
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|word| word == expected)
}

fn select_agent_status(
    agent_kind: &str,
    current: AgentStatus,
    reported: Option<(ReportedAgentState, u64)>,
    now: u64,
    input_submitted_at: u64,
    active_samples: u8,
    quiet_samples: u8,
) -> AgentStatus {
    let (submission_working_millis, quiet_samples_to_idle) = if agent_kind == "pi" {
        (PI_SUBMISSION_WORKING_MILLIS, PI_QUIET_SAMPLES_TO_IDLE)
    } else {
        (SUBMISSION_WORKING_MILLIS, QUIET_SAMPLES_TO_IDLE)
    };
    match reported {
        Some((ReportedAgentState::Idle, reported_at)) if reported_at >= input_submitted_at => {
            return AgentStatus::Idle;
        }
        Some((ReportedAgentState::Working, reported_at))
            if now.saturating_sub(reported_at) <= REPORTED_WORKING_FRESH_MILLIS =>
        {
            return AgentStatus::Working;
        }
        _ => {}
    }

    if input_submitted_at > 0 && now.saturating_sub(input_submitted_at) <= submission_working_millis
        || active_samples >= ACTIVE_SAMPLES_TO_WORKING
        || current == AgentStatus::Working && quiet_samples < quiet_samples_to_idle
    {
        AgentStatus::Working
    } else {
        AgentStatus::Idle
    }
}

fn agent_sample_active(agent_kind: &str, cpu_delta: u64, output_delta: u64) -> bool {
    if agent_kind == "pi" {
        output_delta > 0
    } else {
        cpu_delta >= MEANINGFUL_CPU_TICKS || output_delta >= MEANINGFUL_OUTPUT_BYTES
    }
}

#[derive(Debug)]
struct AgentObservation {
    kind: String,
    pid: u32,
    cpu_ticks: u64,
}

#[derive(Debug)]
struct ProcessObservation {
    program: String,
    shell_foreground: bool,
    agent: Option<AgentObservation>,
}

#[derive(Debug, Default)]
struct RefreshOutcome {
    title: Option<(u64, PiRequest)>,
    summary: Option<(u64, PiRequest)>,
}

pub struct TerminalSession {
    info: RwLock<TerminalInfo>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    replay: Mutex<ReplayBuffer>,
    events: broadcast::Sender<TerminalEvent>,
    viewports: Mutex<ClientViewports>,
    output_bytes: AtomicU64,
    activity: Mutex<SessionActivity>,
    signals: Mutex<TerminalSignals>,
    process_tracker: Mutex<ProcessTracker>,
    home_directory: PathBuf,
}

impl TerminalSession {
    pub fn info(&self) -> TerminalInfo {
        self.refresh_working_directory();
        let mut info = self.info.read().clone();
        info.clients = self.viewports.lock().sizes.len();
        info
    }

    pub fn subscribe(&self) -> (broadcast::Receiver<TerminalEvent>, Vec<Bytes>) {
        // The output thread publishes while holding this same lock. Subscribing
        // before copying the replay buffer prevents gaps or duplicated chunks.
        let replay = self.replay.lock();
        let receiver = self.events.subscribe();
        let snapshot = replay.snapshot();
        (receiver, snapshot)
    }

    pub fn process_inspector(&self) -> ProcessInspectorSnapshot {
        self.process_tracker.lock().snapshot()
    }

    pub fn attach(
        &self,
        client_id: Uuid,
        size: Option<(u16, u16)>,
    ) -> Result<TerminalSizeState, TerminalError> {
        self.update_viewports(|viewports| {
            viewports.attach(
                client_id,
                size.map(|(cols, rows)| ViewportSize::new(cols, rows)),
            );
        })
    }

    pub fn detach(&self, client_id: Uuid) {
        if let Err(error) = self.update_viewports(|viewports| viewports.detach(client_id)) {
            tracing::debug!(%error, "terminal resize after client detach failed");
        }
    }

    pub fn resize_client(
        &self,
        client_id: Uuid,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSizeState, TerminalError> {
        self.update_viewports(|viewports| {
            viewports.resize(client_id, ViewportSize::new(cols, rows));
        })
    }

    pub fn focus_client(
        &self,
        client_id: Uuid,
        focused: bool,
    ) -> Result<TerminalSizeState, TerminalError> {
        self.update_viewports(|viewports| viewports.focus(client_id, focused))
    }

    pub fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        if self.info.read().status != TerminalStatus::Running {
            return Ok(());
        }
        let now = current_millis();
        let agent_active = self
            .info
            .read()
            .agent
            .as_ref()
            .is_some_and(|agent| agent.status != AgentStatus::Closed);
        if agent_active {
            let mut activity = self.activity.lock();
            let input = activity.prompt_capture.observe(data);
            if input.submitted {
                let mut info = self.info.write();
                if let Some(agent) = info.agent.as_mut()
                    && agent.status != AgentStatus::Closed
                {
                    // A submitted line while the agent is already working is usually an
                    // approval or answer, not a new dashboard task. Only retitle when an
                    // idle agent starts a fresh work cycle.
                    if let Some(prompt) = title_prompt_for_submission(&agent.status, input.prompt)
                        && activity.automatic_name
                    {
                        activity.title_revision = activity.title_revision.saturating_add(1);
                        let revision = activity.title_revision;
                        activity.pending_title_prompt = Some((revision, prompt));
                    }
                    activity.input_submitted_at = now;
                    activity.active_samples = 0;
                    activity.quiet_samples = 0;
                    if agent.status != AgentStatus::Working {
                        agent.status = AgentStatus::Working;
                        agent.status_changed_at = now;
                        agent.revision = agent.revision.saturating_add(1);
                        agent.summary = None;
                    }
                }
            }
        }
        let mut writer = self.writer.lock();
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|error| TerminalError::Io(error.to_string()))
    }

    fn update_viewports(
        &self,
        update: impl FnOnce(&mut ClientViewports),
    ) -> Result<TerminalSizeState, TerminalError> {
        let mut viewports = self.viewports.lock();
        update(&mut viewports);
        let state = viewports.state();
        let size_changed =
            (state.cols, state.rows) != (viewports.published.cols, viewports.published.rows);
        // Keep resize redraws behind the size control frame so every browser
        // applies the shared grid before it processes output for that grid.
        let replay = size_changed.then(|| self.replay.lock());
        if size_changed && self.info.read().status == TerminalStatus::Running {
            self.master
                .lock()
                .resize(PtySize {
                    cols: state.cols,
                    rows: state.rows,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| TerminalError::Io(error.to_string()))?;
        }
        let publish = state != viewports.published;
        viewports.published = state;
        if publish {
            let _ = self.events.send(TerminalEvent::Size(state));
        }
        drop(replay);
        Ok(state)
    }

    pub fn kill(&self) {
        if self.info.read().status == TerminalStatus::Running {
            let _ = self.killer.lock().kill();
        }
    }

    fn publish(&self, bytes: Bytes) {
        let now = current_millis();
        self.signals.lock().observe(&bytes, now);
        self.output_bytes
            .fetch_add(bytes.len() as u64, Ordering::Relaxed);
        let mut replay = self.replay.lock();
        replay.push(bytes.clone());
        let _ = self.events.send(TerminalEvent::Output(bytes));
    }

    fn exited(&self, exit_code: u32) {
        {
            let mut info = self.info.write();
            info.status = TerminalStatus::Exited;
            info.exit_code = Some(exit_code);
            info.pid = None;
        }
        let _ = self.events.send(TerminalEvent::Exit(exit_code));
    }

    fn refresh_working_directory(&self) {
        let pid = {
            let info = self.info.read();
            if info.status != TerminalStatus::Running {
                return;
            }
            info.pid
        };
        let Some(pid) = pid else { return };
        let Ok(cwd) = std::fs::read_link(format!("/proc/{pid}/cwd")) else {
            return;
        };

        let mut info = self.info.write();
        if info.cwd == cwd {
            return;
        }
        info.cwd = cwd;
        info.workspace = workspace_for(&info.cwd, &self.home_directory);
        info.path = terminal_path(&info.workspace, &info.name);
        info.color = color_for(&info.workspace);
    }

    fn refresh_process_metadata(
        &self,
        processes: &ProcessSnapshot,
        pi_titles_enabled: bool,
        pi_summaries_enabled: bool,
        now: u64,
    ) -> RefreshOutcome {
        self.refresh_working_directory();
        let shell_pid = self.info.read().pid;
        let Some(shell_pid) = shell_pid else {
            return RefreshOutcome::default();
        };
        self.process_tracker
            .lock()
            .update(shell_pid, &processes.descendants(shell_pid));
        let shell_name = executable_name(&self.info.read().shell);
        let observation = processes.observe(shell_pid, &shell_name);
        let output_bytes = self.output_bytes.load(Ordering::Relaxed);
        let reported_state = self.signals.lock().agent_state;
        let mut activity = self.activity.lock();
        let mut info = self.info.write();
        let previous_program = info.program.clone();
        info.program = observation.program.clone();

        let mut outcome = RefreshOutcome::default();
        if let Some(agent) = observation.agent {
            let is_new_agent = activity.agent_pid != Some(agent.pid)
                || info
                    .agent
                    .as_ref()
                    .is_none_or(|current| current.kind != agent.kind);
            if is_new_agent {
                activity.agent_pid = Some(agent.pid);
                activity.last_cpu_ticks = agent.cpu_ticks;
                activity.last_sample_output_bytes = output_bytes;
                activity.active_samples = 0;
                activity.quiet_samples = 0;
                activity.input_submitted_at = 0;
                activity.prompt_capture = PromptCapture::default();
                activity.pending_title_prompt = None;
                activity.title_revision = 0;
                activity.title_in_flight_revision = None;
                activity.generated_title = None;
                activity.summary_in_flight_revision = None;
                let revision = info
                    .agent
                    .as_ref()
                    .map_or(1, |current| current.revision.saturating_add(1));
                info.agent = Some(AgentInfo {
                    kind: agent.kind.clone(),
                    status: select_agent_status(
                        &agent.kind,
                        AgentStatus::Idle,
                        reported_state,
                        now,
                        0,
                        0,
                        0,
                    ),
                    status_changed_at: now,
                    started_at: now,
                    revision,
                    summary: None,
                });
            } else {
                let cpu_delta = agent.cpu_ticks.saturating_sub(activity.last_cpu_ticks);
                let output_delta = output_bytes.saturating_sub(activity.last_sample_output_bytes);
                activity.last_cpu_ticks = agent.cpu_ticks;
                activity.last_sample_output_bytes = output_bytes;
                if agent_sample_active(&agent.kind, cpu_delta, output_delta) {
                    activity.active_samples = activity.active_samples.saturating_add(1);
                    activity.quiet_samples = 0;
                } else {
                    activity.active_samples = 0;
                    activity.quiet_samples = activity.quiet_samples.saturating_add(1);
                }
                let current_status = info
                    .agent
                    .as_ref()
                    .map(|current| current.status.clone())
                    .unwrap_or(AgentStatus::Idle);
                let next_status = select_agent_status(
                    &agent.kind,
                    current_status,
                    reported_state,
                    now,
                    activity.input_submitted_at,
                    activity.active_samples,
                    activity.quiet_samples,
                );
                if let Some(current) = info.agent.as_mut()
                    && current.status != next_status
                {
                    let was_working = current.status == AgentStatus::Working;
                    current.status = next_status.clone();
                    current.status_changed_at = now;
                    current.revision = current.revision.saturating_add(1);
                    current.summary = None;
                    if was_working && next_status == AgentStatus::Idle && pi_summaries_enabled {
                        let revision = current.revision;
                        if activity.summary_in_flight_revision != Some(revision) {
                            activity.summary_in_flight_revision = Some(revision);
                            outcome.summary = Some((
                                revision,
                                self.pi_request(PiTaskKind::Summary, &info, &agent.kind, None),
                            ));
                        }
                    }
                }
            }

            if activity.automatic_name && activity.generated_title.is_none() {
                info.name = agent.kind.clone();
            }
            if !pi_titles_enabled || !activity.automatic_name {
                activity.pending_title_prompt = None;
            } else if activity.title_in_flight_revision.is_none()
                && let Some((revision, prompt)) = activity.pending_title_prompt.take()
            {
                activity.title_in_flight_revision = Some(revision);
                outcome.title = Some((
                    revision,
                    self.pi_request(PiTaskKind::Title, &info, &agent.kind, Some(prompt)),
                ));
            }
        } else {
            if let Some(current) = info.agent.as_mut()
                && current.status != AgentStatus::Closed
            {
                current.status = AgentStatus::Closed;
                current.status_changed_at = now;
                current.revision = current.revision.saturating_add(1);
                current.summary = None;
                let revision = current.revision;
                let kind = current.kind.clone();
                if pi_summaries_enabled && activity.summary_in_flight_revision != Some(revision) {
                    activity.summary_in_flight_revision = Some(revision);
                    outcome.summary = Some((
                        revision,
                        self.pi_request(PiTaskKind::Summary, &info, &kind, None),
                    ));
                }
            }
            activity.agent_pid = None;
            activity.active_samples = 0;
            activity.quiet_samples = 0;
            activity.input_submitted_at = 0;
            activity.prompt_capture = PromptCapture::default();
            activity.pending_title_prompt = None;
            activity.title_in_flight_revision = None;
            *self.signals.lock() = TerminalSignals::default();
            if !observation.shell_foreground {
                activity.generated_title = None;
                info.agent = None;
            }
            if activity.automatic_name && activity.generated_title.is_none() {
                info.name = if observation.shell_foreground {
                    info.agent
                        .as_ref()
                        .filter(|agent| agent.status == AgentStatus::Closed)
                        .map(|agent| agent.kind.clone())
                        .unwrap_or(observation.program)
                } else {
                    observation.program
                };
            }
        }

        if info.program != previous_program
            || info.path != terminal_path(&info.workspace, &info.name)
        {
            info.path = terminal_path(&info.workspace, &info.name);
        }
        outcome
    }

    fn pi_request(
        &self,
        kind: PiTaskKind,
        info: &TerminalInfo,
        agent: &str,
        user_prompt: Option<String>,
    ) -> PiRequest {
        PiRequest {
            kind,
            workspace: info.workspace.clone(),
            program: info.program.clone(),
            agent: agent.to_owned(),
            user_prompt,
            recent_output: if kind == PiTaskKind::Summary {
                self.replay.lock().text_tail(12 * 1024)
            } else {
                String::new()
            },
        }
    }

    fn finish_title(&self, revision: u64, result: Result<String, String>) {
        let mut activity = self.activity.lock();
        if activity.title_in_flight_revision != Some(revision) {
            return;
        }
        activity.title_in_flight_revision = None;
        if activity.title_revision != revision || activity.agent_pid.is_none() {
            return;
        }
        match result {
            Ok(title) => {
                activity.generated_title = Some(title.clone());
                if activity.automatic_name {
                    let mut info = self.info.write();
                    info.name = title;
                    info.path = terminal_path(&info.workspace, &info.name);
                }
            }
            Err(error) => tracing::debug!(%error, "Pi terminal title generation failed"),
        }
    }

    fn finish_summary(&self, revision: u64, result: Result<String, String>) {
        let mut activity = self.activity.lock();
        if activity.summary_in_flight_revision == Some(revision) {
            activity.summary_in_flight_revision = None;
        }
        match result {
            Ok(summary) => {
                let mut info = self.info.write();
                if let Some(agent) = info.agent.as_mut()
                    && agent.revision == revision
                {
                    agent.summary = Some(summary);
                }
            }
            Err(error) => tracing::debug!(%error, "Pi terminal summary generation failed"),
        }
    }
}

pub struct TerminalManager {
    sessions: Arc<RwLock<HashMap<Uuid, Arc<TerminalSession>>>>,
    default_shell: Option<String>,
    replay_bytes: usize,
    home_directory: PathBuf,
}

impl TerminalManager {
    pub fn new(default_shell: Option<String>, replay_bytes: usize) -> Self {
        let home_directory = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            default_shell,
            replay_bytes,
            home_directory,
        }
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        let mut terminals: Vec<_> = self
            .sessions
            .read()
            .values()
            .map(|session| session.info())
            .collect();
        terminals.sort_by(|left, right| left.path.cmp(&right.path));
        terminals
    }

    pub fn get(&self, id: Uuid) -> Option<Arc<TerminalSession>> {
        self.sessions.read().get(&id).cloned()
    }

    pub fn start_monitor(self: &Arc<Self>, pi: Arc<PiService>) {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(1_500));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                manager.refresh_processes(pi.clone());
            }
        });
    }

    fn refresh_processes(&self, pi: Arc<PiService>) {
        let sessions = self.sessions.read().values().cloned().collect::<Vec<_>>();
        let shell_pids = sessions
            .iter()
            .filter_map(|session| session.info.read().pid)
            .collect::<Vec<_>>();
        let processes = ProcessSnapshot::read(&shell_pids);
        let now = current_millis();
        let pi_titles_enabled = pi.titles_enabled();
        let pi_summaries_enabled = pi.summaries_enabled();
        for session in sessions {
            let outcome = session.refresh_process_metadata(
                &processes,
                pi_titles_enabled,
                pi_summaries_enabled,
                now,
            );
            if let Some((revision, request)) = outcome.title {
                let pi = pi.clone();
                let session = session.clone();
                tokio::spawn(async move {
                    session.finish_title(revision, pi.generate(request).await);
                });
            }
            if let Some((revision, request)) = outcome.summary {
                let pi = pi.clone();
                let session = session.clone();
                tokio::spawn(async move {
                    session.finish_summary(revision, pi.generate(request).await);
                });
            }
        }
    }

    pub fn create(&self, request: CreateTerminal) -> Result<TerminalInfo, TerminalError> {
        let requested_name = request
            .path
            .as_deref()
            .map(normalize_terminal_path)
            .transpose()?
            .and_then(|path| path.rsplit('/').next().map(str::to_owned));
        let cwd = match (request.cwd, request.clone_from) {
            (Some(cwd), _) => cwd,
            (None, Some(id)) => self
                .get(id)
                .map(|session| session.info().cwd)
                .ok_or(TerminalError::CloneSourceNotFound)?,
            (None, None) => self.home_directory.clone(),
        };
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(TerminalError::InvalidWorkingDirectory(
                cwd.display().to_string(),
            ));
        }
        let shell = request
            .shell
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| self.default_shell.clone().unwrap_or_else(default_shell));

        let mut sessions = self.sessions.write();
        let (name, automatic_name) = if let Some(name) = requested_name {
            if sessions
                .values()
                .any(|session| session.info.read().name == name)
            {
                return Err(TerminalError::DuplicatePath(name));
            }
            (name, false)
        } else {
            (executable_name(&shell), true)
        };
        let workspace = workspace_for(&cwd, &self.home_directory);
        let path = terminal_path(&workspace, &name);

        let id = Uuid::new_v4();
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: DEFAULT_VIEWPORT_SIZE.rows,
                cols: DEFAULT_VIEWPORT_SIZE.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Spawn {
                shell: shell.clone(),
                message: error.to_string(),
            })?;
        let mut command = CommandBuilder::new(&shell);
        command.cwd(&cwd);
        configure_terminal_environment(&mut command);
        command.env("TERM_SERVER_SESSION", id.to_string());
        let mut child =
            pair.slave
                .spawn_command(command)
                .map_err(|error| TerminalError::Spawn {
                    shell: shell.clone(),
                    message: error.to_string(),
                })?;
        drop(pair.slave);

        let pid = child.process_id();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Io(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| TerminalError::Io(error.to_string()))?;
        let killer = child.clone_killer();
        let (events, _) = broadcast::channel(256);
        let session = Arc::new(TerminalSession {
            info: RwLock::new(TerminalInfo {
                id,
                name,
                color: color_for(&workspace),
                workspace,
                path,
                cwd,
                program: executable_name(&shell),
                shell,
                agent: None,
                created_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                pid,
                status: TerminalStatus::Running,
                exit_code: None,
                clients: 0,
            }),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            replay: Mutex::new(ReplayBuffer::new(self.replay_bytes)),
            events,
            viewports: Mutex::new(ClientViewports::default()),
            output_bytes: AtomicU64::new(0),
            activity: Mutex::new(SessionActivity {
                automatic_name,
                ..SessionActivity::default()
            }),
            signals: Mutex::new(TerminalSignals::default()),
            process_tracker: Mutex::new(ProcessTracker::default()),
            home_directory: self.home_directory.clone(),
        });
        sessions.insert(id, session.clone());
        drop(sessions);

        let output_session = session.clone();
        let sessions_on_exit = self.sessions.clone();
        thread::Builder::new()
            .name(format!("terminal-output-{id}"))
            .spawn(move || {
                read_output(reader, output_session.clone());
                let exit_code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
                output_session.exited(exit_code);
                sessions_on_exit.write().remove(&id);
            })
            .map_err(|error| TerminalError::Io(error.to_string()))?;

        Ok(session.info())
    }

    pub fn rename(&self, id: Uuid, input: &str) -> Result<Option<TerminalInfo>, TerminalError> {
        let normalized = normalize_terminal_path(input)?;
        let name = normalized
            .rsplit('/')
            .next()
            .unwrap_or(&normalized)
            .to_owned();
        let sessions = self.sessions.read();
        if sessions
            .iter()
            .any(|(candidate_id, session)| *candidate_id != id && session.info.read().name == name)
        {
            return Err(TerminalError::DuplicatePath(name));
        }
        let Some(session) = sessions.get(&id) else {
            return Ok(None);
        };
        {
            let mut activity = session.activity.lock();
            activity.automatic_name = false;
            activity.generated_title = None;
            let mut info = session.info.write();
            info.name = name;
            info.path = terminal_path(&info.workspace, &info.name);
        }
        Ok(Some(session.info()))
    }

    pub fn remove(&self, id: Uuid) -> bool {
        let Some(session) = self.sessions.write().remove(&id) else {
            return false;
        };
        session.kill();
        true
    }

    pub fn shutdown(&self) {
        let sessions = std::mem::take(&mut *self.sessions.write());
        for session in sessions.values() {
            session.kill();
        }
    }
}

fn read_output(mut reader: Box<dyn Read + Send>, session: Arc<TerminalSession>) {
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => session.publish(Bytes::copy_from_slice(&buffer[..count])),
        }
    }
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
struct ProcessIdentity {
    pid: u32,
    start_ticks: u64,
}

impl ProcessIdentity {
    fn label(self) -> String {
        format!("{}:{}", self.pid, self.start_ticks)
    }
}

#[derive(Debug, Default)]
struct ProcessTracker {
    records: Vec<ProcessRecord>,
}

impl ProcessTracker {
    fn update(&mut self, shell_pid: u32, processes: &[&ProcessInfo]) {
        let identities = processes
            .iter()
            .map(|process| {
                (
                    process.pid,
                    ProcessIdentity {
                        pid: process.pid,
                        start_ticks: process.start_ticks,
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        let foreground_group = processes
            .iter()
            .find(|process| process.pid == shell_pid)
            .map(|process| process.foreground_group)
            .filter(|group| *group > 0);

        self.records = processes
            .iter()
            .map(|process| {
                let identity = identities[&process.pid];
                ProcessRecord {
                    id: identity.label(),
                    pid: process.pid,
                    parent_id: identities
                        .get(&process.parent)
                        .copied()
                        .map(ProcessIdentity::label),
                    command: process.command.clone(),
                    arguments: process.arguments.clone(),
                    cwd: process.cwd.clone(),
                    foreground: foreground_group == Some(process.group),
                }
            })
            .collect();
    }

    fn snapshot(&self) -> ProcessInspectorSnapshot {
        let mut processes = self.records.clone();
        processes.sort_by(|left, right| {
            right
                .foreground
                .cmp(&left.foreground)
                .then_with(|| left.pid.cmp(&right.pid))
        });
        ProcessInspectorSnapshot {
            supported: cfg!(target_os = "linux"),
            processes,
        }
    }
}

fn truncate_text_bytes(mut value: String, maximum: usize) -> (String, bool) {
    if value.len() <= maximum {
        return (value, false);
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    (value, true)
}

#[derive(Debug, Clone)]
struct ProcessInfo {
    pid: u32,
    parent: u32,
    group: i32,
    foreground_group: i32,
    command: String,
    arguments: Vec<String>,
    cwd: Option<PathBuf>,
    start_ticks: u64,
    cpu_ticks: u64,
}

#[derive(Debug, Default)]
struct ProcessSnapshot {
    processes: HashMap<u32, ProcessInfo>,
    children: HashMap<u32, Vec<u32>>,
}

impl ProcessSnapshot {
    fn read(shell_pids: &[u32]) -> Self {
        #[cfg(target_os = "linux")]
        {
            let mut processes = HashMap::new();
            let mut process_children = HashMap::new();
            let mut visited = HashSet::new();
            let mut pending = shell_pids.to_vec();
            while let Some(pid) = pending.pop() {
                if !visited.insert(pid) {
                    continue;
                }
                let directory = PathBuf::from(format!("/proc/{pid}"));
                let Ok(stat) = std::fs::read_to_string(directory.join("stat")) else {
                    continue;
                };
                let Some(process) = parse_process_stat(pid, &stat, &directory) else {
                    continue;
                };
                processes.insert(pid, process);
                let children =
                    std::fs::read_to_string(directory.join(format!("task/{pid}/children")))
                        .unwrap_or_default();
                let children = children
                    .split_whitespace()
                    .filter_map(|child| child.parse::<u32>().ok())
                    .collect::<Vec<_>>();
                pending.extend(children.iter().copied());
                process_children.insert(pid, children);
            }
            Self {
                processes,
                children: process_children,
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = shell_pids;
            Self::default()
        }
    }

    fn observe(&self, shell_pid: u32, shell_name: &str) -> ProcessObservation {
        let Some(shell) = self.processes.get(&shell_pid) else {
            return ProcessObservation {
                program: shell_name.to_owned(),
                shell_foreground: true,
                agent: None,
            };
        };
        let foreground_group = shell.foreground_group;
        if foreground_group <= 0 || foreground_group == shell.group {
            return ProcessObservation {
                program: shell_name.to_owned(),
                shell_foreground: true,
                agent: None,
            };
        }
        let candidates = self
            .processes
            .values()
            .filter(|process| process.group == foreground_group)
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return ProcessObservation {
                program: shell_name.to_owned(),
                shell_foreground: true,
                agent: None,
            };
        }

        let candidate_pids = candidates
            .iter()
            .map(|process| process.pid)
            .collect::<HashSet<_>>();
        let root = candidates
            .iter()
            .filter(|process| !candidate_pids.contains(&process.parent))
            .min_by_key(|process| process.pid)
            .copied()
            .unwrap_or(candidates[0]);
        let agent = candidates.iter().find_map(|process| {
            agent_kind(process).map(|kind| AgentObservation {
                kind,
                pid: root.pid,
                cpu_ticks: candidates.iter().map(|process| process.cpu_ticks).sum(),
            })
        });
        ProcessObservation {
            program: agent
                .as_ref()
                .map(|agent| agent.kind.clone())
                .unwrap_or_else(|| process_program(root)),
            shell_foreground: false,
            agent,
        }
    }

    fn descendants(&self, shell_pid: u32) -> Vec<&ProcessInfo> {
        let mut descendants = Vec::new();
        let mut visited = HashSet::new();
        let mut pending = vec![shell_pid];
        while let Some(pid) = pending.pop() {
            if !visited.insert(pid) {
                continue;
            }
            let Some(process) = self.processes.get(&pid) else {
                continue;
            };
            descendants.push(process);
            if let Some(children) = self.children.get(&pid) {
                pending.extend(children.iter().copied());
            }
        }
        descendants
    }
}

#[cfg(target_os = "linux")]
fn parse_process_stat(pid: u32, stat: &str, directory: &Path) -> Option<ProcessInfo> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let command = stat[open + 1..close].to_owned();
    let fields = stat[close + 1..].split_whitespace().collect::<Vec<_>>();
    let parent = fields.get(1)?.parse().ok()?;
    let group = fields.get(2)?.parse().ok()?;
    let foreground_group = fields.get(5)?.parse().ok()?;
    let user_ticks = fields.get(11)?.parse::<u64>().ok()?;
    let system_ticks = fields.get(12)?.parse::<u64>().ok()?;
    let start_ticks = fields.get(19)?.parse::<u64>().ok()?;
    let arguments = std::fs::read(directory.join("cmdline"))
        .ok()
        .map(|bytes| {
            let arguments = bytes
                .split(|byte| *byte == 0)
                .filter(|value| !value.is_empty())
                .take(64)
                .map(|value| String::from_utf8_lossy(value).into_owned())
                .map(|value| truncate_text_bytes(value, 1024).0)
                .collect::<Vec<_>>();
            redact_process_arguments(arguments)
        })
        .unwrap_or_default();
    let cwd = std::fs::read_link(directory.join("cwd")).ok();
    Some(ProcessInfo {
        pid,
        parent,
        group,
        foreground_group,
        command,
        arguments,
        cwd,
        start_ticks,
        cpu_ticks: user_ticks.saturating_add(system_ticks),
    })
}

fn redact_process_arguments(arguments: Vec<String>) -> Vec<String> {
    let mut redact_next = false;
    arguments
        .into_iter()
        .map(|argument| {
            if redact_next {
                redact_next = false;
                return "[redacted]".to_owned();
            }
            let lower = argument.to_ascii_lowercase();
            if lower.contains("authorization:") {
                return "[redacted authorization]".to_owned();
            }
            if let Some((key, _)) = argument.split_once('=')
                && sensitive_argument_name(key)
            {
                return format!("{key}=[redacted]");
            }
            if sensitive_argument_name(&argument) {
                redact_next = true;
            }
            argument
        })
        .collect()
}

fn sensitive_argument_name(value: &str) -> bool {
    let normalized = value
        .trim_start_matches('-')
        .to_ascii_lowercase()
        .replace('_', "-");
    [
        "password",
        "passwd",
        "token",
        "secret",
        "api-key",
        "apikey",
        "access-key",
        "private-key",
        "client-secret",
        "auth-token",
    ]
    .iter()
    .any(|sensitive| normalized == *sensitive || normalized.ends_with(&format!("-{sensitive}")))
}

fn agent_kind(process: &ProcessInfo) -> Option<String> {
    let command_line = std::iter::once(process.command.as_str())
        .chain(process.arguments.iter().map(String::as_str))
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join(" ");
    let tokens = std::iter::once(process.command.as_str())
        .chain(process.arguments.iter().map(String::as_str))
        .map(|value| {
            Path::new(value)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(value)
                .trim_end_matches(".js")
                .to_ascii_lowercase()
        })
        .collect::<Vec<_>>();
    if command_line.contains("@openai/codex")
        || tokens
            .iter()
            .any(|token| token == "codex" || token.starts_with("codex-"))
    {
        return Some("codex".to_owned());
    }
    if command_line.contains("claude-code")
        || tokens.iter().any(|token| {
            token == "claude" || token.starts_with("claude-") || token.contains("claude-code")
        })
    {
        return Some("claude".to_owned());
    }
    if command_line.contains("pi-coding-agent")
        || tokens
            .iter()
            .any(|token| token == "pi" || token.contains("pi-coding-agent"))
    {
        return Some("pi".to_owned());
    }
    None
}

fn process_program(process: &ProcessInfo) -> String {
    let first = process.arguments.first().map(String::as_str);
    let first_name = first
        .map(executable_name)
        .unwrap_or_else(|| process.command.clone());
    if matches!(
        first_name.as_str(),
        "node" | "nodejs" | "python" | "python3" | "bun"
    ) && let Some(script) = process.arguments.get(1)
    {
        let script_name = executable_name(script)
            .trim_end_matches(".js")
            .trim_end_matches(".py")
            .to_owned();
        if !script_name.is_empty() {
            return script_name;
        }
    }
    if first_name.is_empty() {
        "process".to_owned()
    } else {
        first_name
    }
}

fn executable_name(command: &str) -> String {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(command)
        .trim_start_matches('-')
        .to_owned()
}

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn sanitize_terminal_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut characters = input.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' {
            match characters.peek().copied() {
                Some('[') => {
                    characters.next();
                    for next in characters.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    characters.next();
                    let mut escaped = false;
                    for next in characters.by_ref() {
                        if next == '\u{7}' || escaped && next == '\\' {
                            break;
                        }
                        escaped = next == '\u{1b}';
                    }
                }
                Some(_) => {
                    characters.next();
                }
                None => {}
            }
            continue;
        }
        if character == '\r' {
            output.push('\n');
        } else if character == '\n' || character == '\t' || !character.is_control() {
            output.push(character);
        }
    }
    output
}

pub fn normalize_terminal_path(input: &str) -> Result<String, TerminalError> {
    let normalized = input
        .trim()
        .replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty()
        || normalized.len() > 256
        || normalized.split('/').any(|segment| {
            segment == "." || segment == ".." || segment.chars().any(char::is_control)
        })
    {
        return Err(TerminalError::InvalidPath);
    }
    Ok(normalized)
}

fn color_for(path: &str) -> String {
    let hash = path.bytes().fold(2_166_136_261_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(16_777_619)
    });
    COLORS[hash as usize % COLORS.len()].to_owned()
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_owned())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_owned())
    }
}

fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("CLICOLOR", "1");
    command.env_remove("NO_COLOR");
    command.env("TERM_PROGRAM", "term-server");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
}

fn workspace_for(cwd: &Path, home: &Path) -> String {
    if cwd == home {
        return "~".to_owned();
    }
    if let Ok(relative) = cwd.strip_prefix(home) {
        return format!("~/{}", relative.to_string_lossy().replace('\\', "/"));
    }
    cwd.to_string_lossy().replace('\\', "/")
}

fn terminal_path(workspace: &str, name: &str) -> String {
    if workspace == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", workspace.trim_end_matches('/'))
    }
}

pub fn validate_working_directory(path: &Path) -> bool {
    path.is_absolute() && path.is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_tree_paths() {
        assert_eq!(
            normalize_terminal_path(" /infra//prod\\api/ ").unwrap(),
            "infra/prod/api"
        );
        assert!(normalize_terminal_path("../secret").is_err());
        assert!(normalize_terminal_path("//").is_err());
    }

    #[test]
    fn replay_buffer_evicts_whole_old_chunks() {
        let mut replay = ReplayBuffer::new(5);
        replay.push(Bytes::from_static(b"abc"));
        replay.push(Bytes::from_static(b"def"));
        assert_eq!(replay.snapshot(), vec![Bytes::from_static(b"def")]);
    }

    #[test]
    fn terminal_size_uses_the_smallest_viewport_until_one_client_is_focused() {
        let desktop = Uuid::from_u128(1);
        let mobile = Uuid::from_u128(2);
        let mut viewports = ClientViewports::default();

        viewports.attach(desktop, Some(ViewportSize::new(180, 50)));
        viewports.attach(mobile, Some(ViewportSize::new(60, 22)));
        assert_eq!(
            viewports.state(),
            TerminalSizeState {
                cols: 60,
                rows: 22,
                focused_client: None,
            }
        );

        viewports.focus(desktop, true);
        assert_eq!(
            viewports.state(),
            TerminalSizeState {
                cols: 180,
                rows: 50,
                focused_client: Some(desktop),
            }
        );

        viewports.resize(mobile, ViewportSize::new(40, 16));
        assert_eq!((viewports.state().cols, viewports.state().rows), (180, 50));

        viewports.detach(desktop);
        assert_eq!(
            viewports.state(),
            TerminalSizeState {
                cols: 40,
                rows: 16,
                focused_client: None,
            }
        );

        viewports.published = viewports.state();
        viewports.detach(mobile);
        assert_eq!(
            viewports.state(),
            TerminalSizeState {
                cols: 40,
                rows: 16,
                focused_client: None,
            }
        );
    }

    #[test]
    fn terminal_size_clamps_untrusted_client_dimensions() {
        let client = Uuid::from_u128(1);
        let mut viewports = ClientViewports::default();
        viewports.attach(client, Some(ViewportSize::new(0, u16::MAX)));

        assert_eq!((viewports.state().cols, viewports.state().rows), (2, 300));
    }

    #[test]
    fn process_tracker_only_exposes_the_latest_live_snapshot() {
        let process =
            |pid, parent, group, foreground_group, command: &str, start_ticks| ProcessInfo {
                pid,
                parent,
                group,
                foreground_group,
                command: command.to_owned(),
                arguments: vec![command.to_owned()],
                cwd: Some(PathBuf::from("/tmp")),
                start_ticks,
                cpu_ticks: 1,
            };
        let shell = process(10, 1, 10, 20, "bash", 100);
        let child = process(20, 10, 20, 20, "codex", 200);
        let mut tracker = ProcessTracker::default();
        tracker.update(10, &[&shell, &child]);

        let idle_shell = process(10, 1, 10, 10, "bash", 100);
        tracker.update(10, &[&idle_shell]);
        let reused = process(20, 10, 20, 20, "btop", 300);
        tracker.update(10, &[&shell, &reused]);

        let snapshot = tracker.snapshot();
        let reused_records = snapshot
            .processes
            .iter()
            .filter(|record| record.pid == 20)
            .collect::<Vec<_>>();
        assert_eq!(reused_records.len(), 1);
        assert_eq!(reused_records[0].command, "btop");
        assert!(reused_records[0].foreground);
    }

    #[test]
    fn process_arguments_redact_common_secret_forms() {
        assert_eq!(
            redact_process_arguments(vec![
                "command".into(),
                "--token".into(),
                "secret-value".into(),
                "AWS_SECRET_ACCESS_KEY=abc".into(),
                "Authorization: Bearer abc".into(),
                "--port=8080".into(),
            ]),
            vec![
                "command",
                "--token",
                "[redacted]",
                "AWS_SECRET_ACCESS_KEY=[redacted]",
                "[redacted authorization]",
                "--port=8080",
            ]
        );
    }

    #[test]
    fn advertises_color_support_without_inheriting_no_color() {
        use std::ffi::OsStr;

        let mut command = CommandBuilder::new("/bin/sh");
        command.env("NO_COLOR", "1");
        configure_terminal_environment(&mut command);

        assert_eq!(command.get_env("TERM"), Some(OsStr::new("xterm-256color")));
        assert_eq!(command.get_env("COLORTERM"), Some(OsStr::new("truecolor")));
        assert_eq!(command.get_env("CLICOLOR"), Some(OsStr::new("1")));
        assert_eq!(command.get_env("NO_COLOR"), None);
    }

    #[test]
    fn starts_writes_resizes_and_removes_a_terminal() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TerminalManager {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            default_shell: Some("/bin/sh".into()),
            replay_bytes: 1024 * 1024,
            home_directory: directory.path().to_path_buf(),
        };
        let info = manager
            .create(CreateTerminal {
                path: None,
                cwd: None,
                shell: None,
                clone_from: None,
            })
            .unwrap();
        assert_eq!(info.name, "sh");
        assert_eq!(info.program, "sh");
        assert_eq!(info.workspace, "~");
        let session = manager.get(info.id).unwrap();
        let client_id = Uuid::new_v4();
        session.attach(client_id, Some((80, 24))).unwrap();
        session.write(b"printf 'hello-from-pty\\n'\n").unwrap();
        session.write(b"cd /tmp\n").unwrap();
        let moved = (0..100).find_map(|_| {
            let next = session.info();
            if next.cwd == Path::new("/tmp") {
                Some(next)
            } else {
                thread::sleep(std::time::Duration::from_millis(10));
                None
            }
        });
        let moved = moved.unwrap();
        assert_eq!(moved.workspace, "/tmp");

        let clone = manager
            .create(CreateTerminal {
                path: None,
                cwd: None,
                shell: None,
                clone_from: Some(info.id),
            })
            .unwrap();
        assert_eq!(clone.cwd, Path::new("/tmp"));
        assert_eq!(clone.name, "sh");
        assert_eq!(clone.color, moved.color);

        session.write(b"exit\n").unwrap();
        let removed_on_exit = (0..100).any(|_| {
            if manager.get(info.id).is_none() {
                true
            } else {
                thread::sleep(std::time::Duration::from_millis(10));
                false
            }
        });
        assert!(removed_on_exit);
        assert!(!manager.remove(info.id));
        assert!(manager.remove(clone.id));
        assert!(manager.list().is_empty());
    }

    #[test]
    fn detects_supported_agent_commands() {
        let process = |command: &str, arguments: &[&str]| ProcessInfo {
            pid: 10,
            parent: 1,
            group: 10,
            foreground_group: 10,
            command: command.to_owned(),
            arguments: arguments.iter().map(|value| (*value).to_owned()).collect(),
            cwd: Some(PathBuf::from("/tmp")),
            start_ticks: 100,
            cpu_ticks: 0,
        };
        assert_eq!(
            agent_kind(&process("codex", &["codex"])).as_deref(),
            Some("codex")
        );
        assert_eq!(
            agent_kind(&process("node", &["node", "/opt/claude-code/cli.js"])).as_deref(),
            Some("claude")
        );
        assert_eq!(
            agent_kind(&process("node", &["node", "/opt/pi-coding-agent/dist.js"])).as_deref(),
            Some("pi")
        );
    }

    #[test]
    fn workspace_colors_and_terminal_text_are_stable() {
        assert_eq!(COLORS.len(), 64);
        assert_eq!(
            COLORS.iter().copied().collect::<HashSet<_>>().len(),
            COLORS.len()
        );
        assert_eq!(color_for("~/code"), color_for("~/code"));
        assert_eq!(
            sanitize_terminal_text("\u{1b}[31mred\u{1b}[0m\rnext"),
            "red\nnext"
        );
    }

    #[test]
    fn parses_agent_progress_sequences_across_output_chunks() {
        let mut signals = TerminalSignals::default();
        signals.observe(b"ordinary output\x1b]9;4;", 100);
        assert_eq!(signals.agent_state, None);
        signals.observe(b"3\x07more output", 101);
        assert_eq!(
            signals.agent_state,
            Some((ReportedAgentState::Working, 101))
        );
        signals.observe(b"\x1b]9;4;0;\x1b\\", 102);
        assert_eq!(signals.agent_state, Some((ReportedAgentState::Idle, 102)));
    }

    #[test]
    fn parses_real_codex_and_claude_title_lifecycle() {
        let mut signals = TerminalSignals::default();
        signals.observe("\x1b]0;⠴ term-server\x07".as_bytes(), 200);
        assert_eq!(
            signals.agent_state,
            Some((ReportedAgentState::Working, 200))
        );
        signals.observe(b"\x1b]0;term-server\x07", 201);
        assert_eq!(signals.agent_state, Some((ReportedAgentState::Idle, 201)));

        signals.observe("\x1b]0;⠂ Agent probe\x07".as_bytes(), 202);
        signals.observe("\x1b]0;✳ Agent probe\x07".as_bytes(), 203);
        assert_eq!(signals.agent_state, Some((ReportedAgentState::Idle, 203)));
    }

    #[test]
    fn debounces_fallback_activity_and_invalidates_stale_idle_signals() {
        assert_eq!(
            select_agent_status("codex", AgentStatus::Idle, None, 1_000, 0, 1, 0),
            AgentStatus::Idle
        );
        assert_eq!(
            select_agent_status("codex", AgentStatus::Idle, None, 1_000, 0, 2, 0),
            AgentStatus::Idle
        );
        assert_eq!(
            select_agent_status("codex", AgentStatus::Idle, None, 1_000, 0, 3, 0),
            AgentStatus::Working
        );
        assert_eq!(
            select_agent_status("codex", AgentStatus::Working, None, 1_000, 0, 0, 4),
            AgentStatus::Working
        );
        assert_eq!(
            select_agent_status("codex", AgentStatus::Working, None, 1_000, 0, 0, 5),
            AgentStatus::Idle
        );
        assert_eq!(
            select_agent_status(
                "codex",
                AgentStatus::Idle,
                Some((ReportedAgentState::Idle, 900)),
                1_050,
                1_000,
                0,
                0,
            ),
            AgentStatus::Working
        );
        assert_eq!(
            select_agent_status(
                "codex",
                AgentStatus::Working,
                Some((ReportedAgentState::Idle, 1_010)),
                1_050,
                1_000,
                2,
                0,
            ),
            AgentStatus::Idle
        );
    }

    #[test]
    fn settles_pi_after_two_quiet_samples() {
        assert_eq!(
            select_agent_status("pi", AgentStatus::Working, None, 5_000, 1_000, 0, 1),
            AgentStatus::Working
        );
        assert_eq!(
            select_agent_status("pi", AgentStatus::Working, None, 5_000, 1_000, 0, 2),
            AgentStatus::Idle
        );
    }

    #[test]
    fn uses_pi_redraws_instead_of_background_cpu_as_activity() {
        assert!(agent_sample_active("pi", 0, 1));
        assert!(!agent_sample_active("pi", MEANINGFUL_CPU_TICKS, 0));
        assert!(agent_sample_active("codex", MEANINGFUL_CPU_TICKS, 0));
        assert!(agent_sample_active("claude", 0, MEANINGFUL_OUTPUT_BYTES));
    }

    #[test]
    fn only_titles_submissions_that_start_a_new_work_cycle() {
        assert_eq!(
            title_prompt_for_submission(&AgentStatus::Idle, Some("new task".to_owned())),
            Some("new task".to_owned())
        );
        assert_eq!(
            title_prompt_for_submission(&AgentStatus::Working, Some("approve".to_owned())),
            None
        );
        assert_eq!(title_prompt_for_submission(&AgentStatus::Idle, None), None);
    }

    #[test]
    fn captures_edited_agent_prompts_on_submission() {
        let mut capture = PromptCapture::default();
        assert_eq!(capture.observe(b"Fix tesk"), PromptInput::default());
        assert_eq!(
            capture.observe(b"\x7ft\r"),
            PromptInput {
                submitted: true,
                prompt: Some("Fix test".to_owned()),
            }
        );

        capture.observe(b"agent task");
        capture.observe(b"\x1b[HFix \x1b[F");
        assert_eq!(
            capture.observe(b" now\r").prompt.as_deref(),
            Some("Fix agent task now")
        );

        capture.observe(b"remove wrong");
        capture.observe(b"\x17tests");
        assert_eq!(
            capture.observe(b"\r").prompt.as_deref(),
            Some("remove tests")
        );
    }

    #[test]
    fn preserves_multiline_paste_and_modified_enter_in_agent_prompts() {
        let mut capture = PromptCapture::default();
        assert_eq!(
            capture.observe(b"\x1b[200~first line\nsecond line\x1b[201~"),
            PromptInput::default()
        );
        assert_eq!(
            capture.observe(b"\r").prompt.as_deref(),
            Some("first line\nsecond line")
        );

        capture.observe(b"one");
        capture.observe(b"\x1b[13;2u");
        capture.observe(b"two");
        assert_eq!(capture.observe(b"\r").prompt.as_deref(), Some("one\ntwo"));
    }
}
