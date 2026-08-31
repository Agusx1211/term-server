use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use parking_lot::{Condvar, Mutex, RwLock};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{broadcast, oneshot};
use uuid::Uuid;

use crate::{
    agent_detection,
    agent_events::{AgentActivity, AgentEvent, AgentEventKind},
    ai::{PiRequest, PiService, PiTaskKind},
    artifacts,
    build::BuildIdentity,
    history::{
        AgentTranscriptKind, AgentTranscriptPage, AgentTranscriptStore, TerminalScrollbackPage,
    },
    terminal_state::{
        SequencedOutput, SyncMode, TERMINAL_OUTPUT_FRAME_BYTES, TerminalOutputState,
        TerminalResume, TerminalSync,
    },
};

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
const NATIVE_EVENT_FRESH_MILLIS: u64 = 15_000;
const LONG_RUNNING_COMMAND_MILLIS: u64 = 5_000;
const MAX_CAPTURED_PROMPT_CHARS: usize = 16_000;
const OSC_PAYLOAD_MAX_CHARS: usize = 256;
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const TERMINAL_INPUT_QUEUE_BYTES: usize = 1024 * 1024;
const TERMINAL_INPUT_QUEUE_MESSAGES: usize = 64;
const TERMINAL_RESPONSE_QUEUE_BYTES: usize = 64 * 1024;
const TERMINAL_RESPONSE_QUEUE_MESSAGES: usize = 256;
/// A pty master hands back at most one 4 KiB chunk per read, so a full-screen
/// redraw from a TUI with a long history arrives as several hundred events in a
/// single burst. The channel has to outlast one of those bursts while a
/// subscriber is busy writing to its socket: lagging costs a full canonical
/// snapshot, which is far more expensive than the buffering. Subscribers merge
/// queued output before sending, so this only has to cover what accumulates
/// behind one in-flight write rather than a whole slow client.
const TERMINAL_EVENT_CAPACITY: usize = 1024;
/// Keep exited terminals available for history/reconnect without retaining an
/// unbounded PTY, input queue, and replay buffer for every session ever run.
const MAX_RETAINED_EXITED_SESSIONS: usize = 32;
/// Unacknowledged output bytes before the pty read loop stops draining the
/// master. The master's buffer then fills and the process writing to it blocks,
/// which is the only backpressure that reaches a TUI. Matches VS Code's
/// `FlowControlConstants.HighWatermarkChars`.
const FLOW_CONTROL_HIGH_WATERMARK_BYTES: u64 = 100_000;
/// Unacknowledged bytes output has to fall back under before the pty resumes.
/// The gap from the high watermark is hysteresis: resuming at the same point
/// would re-pause on the next chunk and shred a burst into single reads.
/// Matches VS Code's `FlowControlConstants.LowWatermarkChars`.
const FLOW_CONTROL_LOW_WATERMARK_BYTES: u64 = 5_000;
/// Liveness backstop for a parked read loop. Every transition that can resume
/// the pty notifies the condvar, so this only ever re-checks a predicate that is
/// already false. It exists because a missed notification would wedge an agent
/// silently, which is far worse than one predicate check every few seconds.
const FLOW_CONTROL_WAIT_BACKSTOP: Duration = Duration::from_secs(5);
/// Longest a parked read loop waits without any acknowledgement progress before
/// the outstanding debt is written off and the pty resumes. A browser whose
/// parser has wedged (or that a background tab has throttled to a crawl) stops
/// acknowledging while its socket stays healthy; without a deadline that single
/// client freezes the terminal for every other client and blocks the agent on
/// its next write, indefinitely. A slow-but-alive browser is unaffected: any
/// acknowledgement arriving during the pause restarts the clock, and a browser
/// that genuinely cannot keep up falls behind and recovers through its own
/// snapshot resynchronization path.
const FLOW_CONTROL_PAUSE_DEADLINE: Duration = Duration::from_secs(10);
#[cfg(feature = "e2e")]
const E2E_FLOW_CONTROL_PAUSE_DEADLINE_ENV: &str = "TERM_SERVER_E2E_FLOW_CONTROL_PAUSE_DEADLINE_MS";

#[cfg(feature = "e2e")]
fn e2e_flow_control_pause_deadline() -> Option<Duration> {
    std::env::var(E2E_FLOW_CONTROL_PAUSE_DEADLINE_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|milliseconds| (1_000..=60_000).contains(milliseconds))
        .map(Duration::from_millis)
}
const DEFAULT_VIEWPORT_SIZE: TerminalViewport = TerminalViewport {
    cols: 100,
    rows: 30,
    pixel_width: 0,
    pixel_height: 0,
};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Working,
    /// The agent is waiting on a person: an approval, a question, a choice.
    /// Distinct from `Idle`, which means it is finished and ready for input.
    Blocked,
    Idle,
    Closed,
}

/// Why a terminal's agent is in the state it is in, for debugging detection.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetectionExplain {
    /// `None` when no agent is running in this terminal.
    pub agent_kind: Option<String>,
    pub status: Option<AgentStatus>,
    /// `None` when no manifest covers the running agent, which leaves the
    /// status to integration hooks and the activity heuristics.
    pub detection: Option<agent_detection::DetectionExplain>,
    pub osc_title: String,
    pub osc_progress: String,
    /// The exact screen text the rules were evaluated against.
    pub screen: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub kind: String,
    pub status: AgentStatus,
    pub status_changed_at: u64,
    pub started_at: u64,
    pub revision: u64,
    #[serde(default)]
    pub completed_at: Option<u64>,
    pub summary: Option<String>,
    #[serde(default)]
    pub activity: Option<AgentActivity>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ForegroundCommandStatus {
    Running,
    Live,
    Completed,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundCommandInfo {
    pub name: String,
    pub status: ForegroundCommandStatus,
    pub status_changed_at: u64,
    pub started_at: u64,
    pub completed_at: Option<u64>,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalKind {
    #[default]
    Regular,
    Supervisor,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    #[serde(default)]
    pub kind: TerminalKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supervisor_root: Option<PathBuf>,
    pub id: Uuid,
    pub name: String,
    pub workspace: String,
    pub path: String,
    pub cwd: PathBuf,
    pub shell: String,
    pub program: String,
    pub color: String,
    pub agent: Option<AgentInfo>,
    #[serde(default)]
    pub command: Option<ForegroundCommandInfo>,
    pub created_at: u64,
    pub pid: Option<u32>,
    pub status: TerminalStatus,
    pub exit_code: Option<u32>,
    pub clients: usize,
    #[serde(default)]
    pub broker: Option<BuildIdentity>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminal {
    pub path: Option<String>,
    pub cwd: Option<PathBuf>,
    pub shell: Option<String>,
    pub clone_from: Option<Uuid>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSupervisorTerminal {
    #[serde(flatten)]
    pub terminal: CreateTerminal,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScreenSnapshot {
    pub screen: String,
    pub tail: String,
    pub rows: u16,
    pub cols: u16,
    pub alternate_screen: bool,
    pub sequence: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    #[error("terminal input exceeds the 64 KiB message limit")]
    InputTooLarge,
    #[error("terminal input queue is full; wait for the terminal to catch up")]
    InputQueueFull,
    #[error("terminal is not running")]
    NotRunning,
    #[error("terminal I/O failed: {0}")]
    Io(String),
}

#[derive(Debug, Error)]
pub enum ProcessSignalError {
    #[error("process signaling is only available on Linux hosts")]
    Unsupported,
    #[error("process is no longer running in this terminal")]
    NotFound,
    #[error("unable to signal process: {0}")]
    Io(String),
}

#[derive(Debug, Clone)]
pub enum TerminalEvent {
    Output(SequencedOutput),
    Exit(u32),
    Size(TerminalSizeState),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSizeState {
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
    pub focused_client: Option<Uuid>,
    pub responder_client: Option<Uuid>,
    /// Changes whenever the PTY grid changes. Byte sequences alone cannot
    /// prove a reconnect did not miss a resize, because resizes consume no
    /// output bytes.
    pub epoch: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalViewport {
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

impl TerminalViewport {
    pub fn new(cols: u16, rows: u16, pixel_width: u16, pixel_height: u16) -> Self {
        Self {
            cols: cols.clamp(2, 500),
            rows: rows.clamp(1, 300),
            pixel_width,
            pixel_height,
        }
    }
}

#[derive(Debug)]
struct ClientViewports {
    sizes: HashMap<Uuid, Option<TerminalViewport>>,
    focused_client: Option<Uuid>,
    responder_client: Option<Uuid>,
    published: TerminalSizeState,
}

impl Default for ClientViewports {
    fn default() -> Self {
        Self {
            sizes: HashMap::new(),
            focused_client: None,
            responder_client: None,
            published: TerminalSizeState {
                cols: DEFAULT_VIEWPORT_SIZE.cols,
                rows: DEFAULT_VIEWPORT_SIZE.rows,
                pixel_width: DEFAULT_VIEWPORT_SIZE.pixel_width,
                pixel_height: DEFAULT_VIEWPORT_SIZE.pixel_height,
                focused_client: None,
                responder_client: None,
                epoch: 0,
            },
        }
    }
}

impl ClientViewports {
    fn attach(&mut self, client_id: Uuid, size: Option<TerminalViewport>) {
        self.sizes.insert(client_id, size);
        self.responder_client.get_or_insert(client_id);
    }

    fn detach(&mut self, client_id: Uuid) {
        self.sizes.remove(&client_id);
        if self.focused_client == Some(client_id) {
            self.focused_client = None;
        }
        if self.responder_client == Some(client_id) {
            self.responder_client = self
                .sizes
                .iter()
                .filter(|(_, size)| size.is_some())
                .map(|(id, _)| *id)
                .min()
                .or_else(|| self.sizes.keys().copied().min());
        }
    }

    fn resize(&mut self, client_id: Uuid, size: TerminalViewport) {
        if let Some(current) = self.sizes.get_mut(&client_id) {
            *current = Some(size);
        }
    }

    fn activate(&mut self, client_id: Uuid) {
        if self.sizes.contains_key(&client_id) {
            self.responder_client = Some(client_id);
        }
    }

    /// Drops a client's contribution to the negotiated size while leaving it
    /// attached. A cached pane holds its stream open so that returning to it
    /// never costs a resynchronization, but it is not being read and must not
    /// hold the size down for the panes that are. The pane re-registers by
    /// reporting its viewport again once it is back on screen.
    fn release(&mut self, client_id: Uuid) {
        if let Some(current) = self.sizes.get_mut(&client_id) {
            *current = None;
        }
        if self.focused_client == Some(client_id) {
            self.focused_client = None;
        }
        // Device queries are answered from the responder's own browser state, so
        // hand the role to a pane that is actually on screen. Falling back to the
        // released client matters: a terminal whose only browser has cached it
        // still needs someone to answer, exactly as it did before it was cached.
        if self.responder_client == Some(client_id) {
            self.responder_client = self
                .sizes
                .iter()
                .filter(|(id, size)| **id != client_id && size.is_some())
                .map(|(id, _)| *id)
                .min()
                .or(Some(client_id));
        }
    }

    fn focus(&mut self, client_id: Uuid, focused: bool) {
        if focused && self.sizes.get(&client_id).is_some_and(Option::is_some) {
            self.focused_client = Some(client_id);
            self.responder_client = Some(client_id);
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
                    .reduce(|smallest, size| TerminalViewport {
                        cols: smallest.cols.min(size.cols),
                        rows: smallest.rows.min(size.rows),
                        pixel_width: smallest.pixel_width.min(size.pixel_width),
                        pixel_height: smallest.pixel_height.min(size.pixel_height),
                    })
            })
            .unwrap_or(TerminalViewport {
                cols: self.published.cols,
                rows: self.published.rows,
                pixel_width: self.published.pixel_width,
                pixel_height: self.published.pixel_height,
            });
        TerminalSizeState {
            cols: size.cols,
            rows: size.rows,
            pixel_width: size.pixel_width,
            pixel_height: size.pixel_height,
            focused_client: self.focused_client,
            responder_client: self.responder_client,
            epoch: self.published.epoch,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRecord {
    pub id: String,
    pub pid: u32,
    pub parent_id: Option<String>,
    pub command: String,
    pub arguments: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub foreground: bool,
    #[serde(default)]
    pub cpu_percent: f32,
    #[serde(default)]
    pub memory_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInspectorSnapshot {
    pub supported: bool,
    pub processes: Vec<ProcessRecord>,
}

#[derive(Debug, Default)]
struct PromptCapture {
    characters: Vec<char>,
    cursor: usize,
    escape: PromptEscape,
    bracketed_paste: bool,
}

#[derive(Debug, Default)]
enum PromptEscape {
    #[default]
    None,
    Escape,
    Sequence(String),
    ControlString {
        bell_terminated: bool,
        escape_seen: bool,
    },
}

#[derive(Debug, Default, PartialEq, Eq)]
struct PromptInput {
    submitted: bool,
    prompt: Option<String>,
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
        match std::mem::take(&mut self.escape) {
            PromptEscape::Escape => match character {
                '[' | 'O' => {
                    let mut sequence = "\u{1b}".to_owned();
                    sequence.push(character);
                    self.escape = PromptEscape::Sequence(sequence);
                }
                ']' => {
                    self.escape = PromptEscape::ControlString {
                        bell_terminated: true,
                        escape_seen: false,
                    };
                }
                'P' | 'X' | '^' | '_' => {
                    self.escape = PromptEscape::ControlString {
                        bell_terminated: false,
                        escape_seen: false,
                    };
                }
                _ => {
                    if matches!(character, '\r' | '\n') {
                        self.insert('\n');
                        return;
                    }
                    self.observe_character(character, input);
                }
            },
            PromptEscape::Sequence(mut sequence) => {
                sequence.push(character);
                if escape_sequence_complete(&sequence) {
                    self.apply_escape(&sequence);
                } else if sequence.chars().count() <= 32 {
                    self.escape = PromptEscape::Sequence(sequence);
                }
            }
            PromptEscape::ControlString {
                bell_terminated,
                escape_seen,
            } => {
                if !(bell_terminated && character == '\u{7}' || escape_seen && character == '\\') {
                    self.escape = PromptEscape::ControlString {
                        bell_terminated,
                        escape_seen: character == '\u{1b}',
                    };
                }
            }
            PromptEscape::None => match character {
                '\u{1b}' => self.escape = PromptEscape::Escape,
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
            },
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
    initial_title_prompt: Option<String>,
    agent_pid: Option<u32>,
    agent_start_ticks: Option<u64>,
    last_cpu_ticks: u64,
    last_sample_output_bytes: u64,
    active_samples: u8,
    quiet_samples: u8,
    input_submitted_at: u64,
    prompt_capture: PromptCapture,
    pending_agent_submission: Option<PendingAgentSubmission>,
    pending_title_prompt: Option<(u64, String)>,
    title_revision: u64,
    title_in_flight_revision: Option<u64>,
    summary_in_flight_revision: Option<u64>,
    native_provider: Option<String>,
    native_status: Option<AgentStatus>,
    native_updated_at: u64,
    native_sequence_provider: Option<String>,
    last_native_sequence: Option<u64>,
    foreground_command: ForegroundCommandTracker,
}

impl Default for SessionActivity {
    fn default() -> Self {
        Self {
            automatic_name: true,
            generated_title: None,
            initial_title_prompt: None,
            agent_pid: None,
            agent_start_ticks: None,
            last_cpu_ticks: 0,
            last_sample_output_bytes: 0,
            active_samples: 0,
            quiet_samples: 0,
            input_submitted_at: 0,
            prompt_capture: PromptCapture::default(),
            pending_agent_submission: None,
            pending_title_prompt: None,
            title_revision: 0,
            title_in_flight_revision: None,
            summary_in_flight_revision: None,
            native_provider: None,
            native_status: None,
            native_updated_at: 0,
            native_sequence_provider: None,
            last_native_sequence: None,
            foreground_command: ForegroundCommandTracker::default(),
        }
    }
}

impl SessionActivity {
    fn expire_native_state(&mut self, now: u64) -> bool {
        // A blocked report is not refreshed while it holds: the agent sends one
        // approval request and then nothing until a person answers. Expiring it
        // on the freshness timer would quietly relabel a waiting agent as idle.
        if self.native_status == Some(AgentStatus::Blocked) {
            return false;
        }
        if self.native_status.is_none()
            || now.saturating_sub(self.native_updated_at) <= NATIVE_EVENT_FRESH_MILLIS
        {
            return false;
        }
        self.native_provider = None;
        self.native_status = None;
        self.native_updated_at = 0;
        true
    }

    fn clear_native_sequence(&mut self) {
        self.native_sequence_provider = None;
        self.last_native_sequence = None;
    }

    /// Accept a native report only if it cannot be older than a sequenced
    /// report from the same active source. Legacy unsequenced reports remain
    /// valid until that source has established sequence authority.
    fn accept_native_sequence(&mut self, provider: &str, sequence: Option<u64>) -> bool {
        match self.native_sequence_provider.as_deref() {
            Some(active_provider) if active_provider == provider => {
                match (self.last_native_sequence, sequence) {
                    (Some(last), Some(next)) if next <= last => false,
                    (Some(_), None) => false,
                    (_, Some(next)) => {
                        self.last_native_sequence = Some(next);
                        true
                    }
                    (None, None) => true,
                }
            }
            Some(_) => {
                self.clear_native_sequence();
                if let Some(next) = sequence {
                    self.native_sequence_provider = Some(provider.to_owned());
                    self.last_native_sequence = Some(next);
                }
                true
            }
            None => {
                if let Some(next) = sequence {
                    self.native_sequence_provider = Some(provider.to_owned());
                    self.last_native_sequence = Some(next);
                }
                true
            }
        }
    }

    fn queue_title_for_submission(
        &mut self,
        agent_status: &AgentStatus,
        submitted_prompt: Option<String>,
    ) {
        if *agent_status != AgentStatus::Idle
            || !self.automatic_name
            || self.generated_title.is_some()
            || self.pending_title_prompt.is_some()
            || self.title_in_flight_revision.is_some()
        {
            return;
        }
        if self.initial_title_prompt.is_none() {
            self.initial_title_prompt = submitted_prompt.and_then(|prompt| {
                let prompt = prompt.trim();
                (!prompt.is_empty() && !prompt.starts_with('/')).then(|| prompt.to_owned())
            });
        }
        let Some(prompt) = self.initial_title_prompt.clone() else {
            return;
        };
        self.title_revision = self.title_revision.saturating_add(1);
        self.pending_title_prompt = Some((self.title_revision, prompt));
    }

    fn begin_submission(
        &mut self,
        agent: &mut AgentInfo,
        submitted_at: u64,
        prompt: Option<String>,
    ) {
        let has_prompt = prompt.is_some();
        self.queue_title_for_submission(&agent.status, prompt);
        if !has_prompt && self.input_submitted_at == 0 {
            return;
        }
        self.input_submitted_at = submitted_at;
        self.active_samples = 0;
        self.quiet_samples = 0;
        self.native_provider = None;
        self.native_status = None;
        self.native_updated_at = 0;
        agent.activity = None;
        if agent.status != AgentStatus::Working {
            agent.status = AgentStatus::Working;
            agent.status_changed_at = submitted_at;
            agent.revision = agent.revision.saturating_add(1);
            agent.completed_at = None;
            agent.summary = None;
        }
    }
}

#[derive(Debug)]
struct PendingAgentSubmission {
    agent_pid: u32,
    agent_start_ticks: u64,
    agent_kind: String,
    submitted_at: u64,
    prompt: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReportedAgentState {
    Working,
    Blocked,
    Idle,
}

#[derive(Debug, Default)]
struct TerminalSignals {
    pending: Vec<u8>,
    agent_state: Option<(ReportedAgentState, u64)>,
    active_title_seen: bool,
    osc_title: Option<String>,
    osc_progress: Option<String>,
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
        self.retain_detection_payload(text.trim());
        let normalized = text.trim().to_ascii_lowercase();
        let state = if normalized == "9;4;3" || normalized.starts_with("9;4;3;") {
            Some(ReportedAgentState::Working)
        } else if normalized == "9;4;0" || normalized.starts_with("9;4;0;") {
            Some(ReportedAgentState::Idle)
        } else if let Some(title) = normalized
            .strip_prefix("0;")
            .or_else(|| normalized.strip_prefix("2;"))
        {
            // omp prefixes its titles with a "π" marker; the state glyph is
            // the token after it (busy spinner while running, ">" at the
            // prompt). Strip the marker so the glyph checks below see it.
            let trimmed = title.trim_start();
            let omp_title = trimmed.strip_prefix('π').map(str::trim_start);
            let glyphs = omp_title.unwrap_or(trimmed);
            let first = glyphs.chars().next();
            if first.is_some_and(is_busy_spinner) {
                self.active_title_seen = true;
                Some(ReportedAgentState::Working)
            } else if title.contains("action required") {
                // Codex writes this when it needs an approval or an answer.
                self.active_title_seen = false;
                Some(ReportedAgentState::Blocked)
            } else if first == Some('✳')
                || title_contains_word(title, "ready")
                || (omp_title.is_some() && first == Some('>'))
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

    /// Retains the latest OSC 0/2 title and OSC 9 progress payloads with their
    /// original case, which the detection manifests match against. An empty
    /// title payload is a clear, so it drops the retained value.
    fn retain_detection_payload(&mut self, payload: &str) {
        if let Some(title) = payload
            .strip_prefix("0;")
            .or_else(|| payload.strip_prefix("2;"))
        {
            let title = sanitize_osc_payload(title);
            self.osc_title = (!title.is_empty()).then_some(title);
        } else if let Some(progress) = payload.strip_prefix("9;") {
            let progress = sanitize_osc_payload(progress);
            self.osc_progress = (!progress.is_empty()).then_some(progress);
        }
    }

    fn osc_title(&self) -> &str {
        self.osc_title.as_deref().unwrap_or_default()
    }

    fn osc_progress(&self) -> &str {
        self.osc_progress.as_deref().unwrap_or_default()
    }

    /// Clears retained OSC evidence so a newly started agent does not inherit
    /// the previous process's title or progress.
    fn clear_detection_payloads(&mut self) {
        self.osc_title = None;
        self.osc_progress = None;
    }
}

/// OSC payloads are untrusted child output. Drop control characters and bound
/// the length before retaining them for detection.
fn sanitize_osc_payload(payload: &str) -> String {
    payload
        .chars()
        .filter(|character| !character.is_control())
        .take(OSC_PAYLOAD_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn is_braille_spinner(character: char) -> bool {
    ('\u{2800}'..='\u{28ff}').contains(&character)
}

/// Spinner glyphs agents animate in their titles while running. omp cycles
/// through braille frames plus "⸼"-style dotted frames.
fn is_busy_spinner(character: char) -> bool {
    is_braille_spinner(character) || matches!(character, '⸼' | '⸽' | '⸱' | '⸳')
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

/// Pi and OMP are fullscreen TUI agents that signal activity through redraws
/// rather than sustained CPU, so output deltas alone count as active work.
fn redraws_signal_activity(agent_kind: &str) -> bool {
    matches!(agent_kind, "pi" | "omp")
}

/// What screen detection concluded about the next status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DetectionOutcome {
    /// The screen is not showing the agent's state. Hold the current status.
    Keep,
    /// A rule matched with enough evidence to set the status.
    Status(AgentStatus),
    /// Detection has nothing useful to say; defer to hooks, then heuristics.
    Undecided,
}

/// Resolves a manifest match into a status decision.
///
/// `blocked` and `working` are applied from any matched rule: those states are
/// what the manifests exist to catch, and a wrong guess self-corrects on the
/// next sample because the rule stops matching. `idle` is applied only from a
/// rule that declared itself visible evidence — a live prompt box, an idle
/// window title — so a weak match cannot yank a genuinely working agent to
/// idle. The engine's own no-rule-matched idle fallback stays out of this
/// entirely, leaving term-server's CPU and output heuristics in charge.
pub(crate) fn screen_detection_outcome(
    detection: Option<&agent_detection::Detection>,
) -> DetectionOutcome {
    let Some(detection) = detection else {
        return DetectionOutcome::Undecided;
    };
    if detection.skip_state_update {
        return DetectionOutcome::Keep;
    }
    if detection.matched_rule.is_none() {
        return DetectionOutcome::Undecided;
    }
    match detection.state {
        agent_detection::DetectedState::Blocked => DetectionOutcome::Status(AgentStatus::Blocked),
        agent_detection::DetectedState::Working => DetectionOutcome::Status(AgentStatus::Working),
        agent_detection::DetectedState::Idle if detection.visible_idle => {
            DetectionOutcome::Status(AgentStatus::Idle)
        }
        agent_detection::DetectedState::Idle => DetectionOutcome::Undecided,
        agent_detection::DetectedState::Unknown => DetectionOutcome::Keep,
    }
}

/// Resolve the next agent status from the available signals, in priority order.
///
/// 1. A connector-reported status (`native_status`) is authoritative. omp, pi,
///    codex and claude each ship a hook connector that delivers the agent's own
///    state here, and every one of them covers the waiting-for-input case
///    (PermissionRequest / Notification → Blocked). The agent knows whether it
///    is working or settled, and that report outranks a screen-content guess:
///    an agent driving subagents reports itself as working even when its own
///    TUI is idle, and a settled agent reports itself as idle even when a
///    spinner frame lingers on screen. `Keep` (an overlay hiding the agent)
///    does not override a live connector signal — the agent is still reporting
///    behind the overlay.
/// 2. Screen-content detection: `blocked` and `working` from a matched rule,
///    or a visible idle prompt.
/// 3. The OSC-reported state and the CPU/output heuristics
///    ([`select_agent_status`]).
///
/// Freshness is enforced upstream: [`SessionActivity::expire_native_state`]
/// clears a non-`Blocked` status once it is older than
/// `NATIVE_EVENT_FRESH_MILLIS`, so a `native_status` present here is either
/// fresh or a held `Blocked`. When the connector stops reporting, the field is
/// `None` and the screen + heuristic tiers take over.
/// Inputs for the fallback tiers (screen detection, then heuristics) of
/// [`resolve_agent_status`], gathered so the resolver stays readable.
struct StatusFallback<'a> {
    agent_kind: &'a str,
    current_status: AgentStatus,
    reported_state: Option<(ReportedAgentState, u64)>,
    now: u64,
    input_submitted_at: u64,
    resumed_after_completion: bool,
    active_samples: u8,
    quiet_samples: u8,
}

fn resolve_agent_status(
    native_status: Option<AgentStatus>,
    detection: Option<&agent_detection::Detection>,
    fallback: StatusFallback,
) -> AgentStatus {
    if let Some(native) = native_status {
        return native;
    }
    match screen_detection_outcome(detection) {
        DetectionOutcome::Keep => fallback.current_status,
        DetectionOutcome::Status(status) => status,
        DetectionOutcome::Undecided => select_agent_status(fallback),
    }
}

fn select_agent_status(fallback: StatusFallback) -> AgentStatus {
    let StatusFallback {
        agent_kind,
        current_status: current,
        reported_state: reported,
        now,
        input_submitted_at,
        resumed_after_completion,
        active_samples,
        quiet_samples,
    } = fallback;
    // Before the first submission an agent's startup output (banners, boot
    // spinners) must not read as work. After a completed task the same gate
    // would be a lie: an autonomous agent resumes without a new prompt (a
    // background task re-invokes it, a loop continues), and its live spinner
    // title is the only truthful signal that it is working again. A working
    // report is trusted only while fresh - spinner frames re-emit the title
    // continuously, so staleness means the animation stopped.
    if input_submitted_at == 0 && !resumed_after_completion {
        return AgentStatus::Idle;
    }
    match reported {
        Some((ReportedAgentState::Blocked, reported_at)) if reported_at >= input_submitted_at => {
            return AgentStatus::Blocked;
        }
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
    if input_submitted_at == 0 {
        return AgentStatus::Idle;
    }
    let (submission_working_millis, quiet_samples_to_idle) = if redraws_signal_activity(agent_kind)
    {
        (PI_SUBMISSION_WORKING_MILLIS, PI_QUIET_SAMPLES_TO_IDLE)
    } else {
        (SUBMISSION_WORKING_MILLIS, QUIET_SAMPLES_TO_IDLE)
    };

    if now.saturating_sub(input_submitted_at) <= submission_working_millis
        || active_samples >= ACTIVE_SAMPLES_TO_WORKING
        || current == AgentStatus::Working && quiet_samples < quiet_samples_to_idle
    {
        AgentStatus::Working
    } else {
        AgentStatus::Idle
    }
}

fn agent_sample_active(agent_kind: &str, cpu_delta: u64, output_delta: u64) -> bool {
    if redraws_signal_activity(agent_kind) {
        output_delta > 0
    } else {
        cpu_delta >= MEANINGFUL_CPU_TICKS || output_delta >= MEANINGFUL_OUTPUT_BYTES
    }
}

#[derive(Debug)]
struct AgentObservation {
    kind: String,
    pid: u32,
    start_ticks: u64,
    cpu_ticks: u64,
}

#[derive(Debug)]
struct ForegroundObservation {
    group: i32,
    name: String,
}

#[derive(Debug)]
struct ForegroundCommandCandidate {
    group: i32,
    name: String,
    first_seen_at: u64,
    live: bool,
}

#[derive(Debug, Default)]
struct ForegroundCommandTracker {
    candidate: Option<ForegroundCommandCandidate>,
}

impl ForegroundCommandTracker {
    fn refresh(
        &mut self,
        current: &mut Option<ForegroundCommandInfo>,
        observation: Option<&ForegroundObservation>,
        alternate_screen: bool,
        agent_active: bool,
        now: u64,
    ) {
        if agent_active {
            self.candidate = None;
            *current = None;
            return;
        }

        let Some(observation) = observation else {
            self.finish(current, now);
            return;
        };
        if self
            .candidate
            .as_ref()
            .is_none_or(|candidate| candidate.group != observation.group)
        {
            self.finish(current, now);
            self.candidate = Some(ForegroundCommandCandidate {
                group: observation.group,
                name: observation.name.clone(),
                first_seen_at: now,
                live: alternate_screen,
            });
        } else if alternate_screen {
            self.candidate
                .as_mut()
                .expect("foreground candidate exists")
                .live = true;
        }

        let candidate = self
            .candidate
            .as_ref()
            .expect("foreground candidate created");
        let status = if candidate.live {
            Some(ForegroundCommandStatus::Live)
        } else if now.saturating_sub(candidate.first_seen_at) >= LONG_RUNNING_COMMAND_MILLIS {
            Some(ForegroundCommandStatus::Running)
        } else {
            None
        };
        let Some(status) = status else {
            return;
        };
        if current
            .as_ref()
            .is_some_and(|command| command.name == candidate.name && command.status == status)
        {
            return;
        }
        *current = Some(ForegroundCommandInfo {
            name: candidate.name.clone(),
            status,
            status_changed_at: now,
            started_at: candidate.first_seen_at,
            completed_at: None,
        });
    }

    fn finish(&mut self, current: &mut Option<ForegroundCommandInfo>, now: u64) {
        let Some(candidate) = self.candidate.take() else {
            return;
        };
        let Some(command) = current.as_mut() else {
            return;
        };
        if command.name != candidate.name {
            return;
        }
        match command.status {
            ForegroundCommandStatus::Running => {
                command.status = ForegroundCommandStatus::Completed;
                command.status_changed_at = now;
                command.completed_at = Some(now);
            }
            ForegroundCommandStatus::Live => *current = None,
            ForegroundCommandStatus::Completed => {}
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct InitialAgentState {
    status: AgentStatus,
    revision: u64,
    input_submitted_at: u64,
    completed_at: Option<u64>,
}

fn initial_agent_state(
    reported_state: Option<(ReportedAgentState, u64)>,
    now: u64,
    startup_revision: u64,
    submitted_at: Option<u64>,
) -> InitialAgentState {
    let Some(submitted_at) = submitted_at else {
        return InitialAgentState {
            status: AgentStatus::Idle,
            revision: startup_revision,
            input_submitted_at: 0,
            completed_at: None,
        };
    };
    let completed = reported_state.is_some_and(|(state, reported_at)| {
        state == ReportedAgentState::Idle && reported_at >= submitted_at
    });
    InitialAgentState {
        status: if completed {
            AgentStatus::Idle
        } else {
            AgentStatus::Working
        },
        revision: startup_revision.saturating_add(if completed { 2 } else { 1 }),
        input_submitted_at: if completed { 0 } else { submitted_at },
        completed_at: completed.then_some(now),
    }
}

#[derive(Debug)]
struct ProcessObservation {
    program: String,
    shell_foreground: bool,
    agent: Option<AgentObservation>,
    foreground: Option<ForegroundObservation>,
}

#[derive(Debug, Default)]
struct RefreshOutcome {
    title: Option<(u64, PiRequest)>,
    summary: Option<(u64, PiRequest)>,
}

#[derive(Debug)]
struct TerminalInputMessage {
    data: Bytes,
    delivered: Option<oneshot::Sender<Result<(), String>>>,
}

#[derive(Debug, Default)]
struct TerminalInputState {
    messages: VecDeque<TerminalInputMessage>,
    queued_bytes: usize,
    responses: VecDeque<Bytes>,
    response_bytes: usize,
    closed: bool,
    failure: Option<String>,
}

#[derive(Debug, Default)]
struct TerminalInputShared {
    state: Mutex<TerminalInputState>,
    ready: Condvar,
}

struct TerminalInputQueue {
    shared: Arc<TerminalInputShared>,
}

struct TerminalInputReceiver {
    shared: Arc<TerminalInputShared>,
}

impl TerminalInputQueue {
    fn spawn(id: Uuid, writer: Box<dyn Write + Send>) -> Result<Self, TerminalError> {
        let (queue, receiver) = terminal_input_channel();
        thread::Builder::new()
            .name(format!("terminal-input-{id}"))
            .spawn(move || {
                if let Err(error) = run_terminal_input_writer(writer, receiver) {
                    tracing::debug!(%error, "terminal input writer failed");
                }
            })
            .map_err(|error| TerminalError::Io(error.to_string()))?;
        Ok(queue)
    }

    fn enqueue(&self, data: &[u8], accepted: impl FnOnce()) -> Result<(), TerminalError> {
        if data.len() > MAX_TERMINAL_INPUT_BYTES {
            return Err(TerminalError::InputTooLarge);
        }
        self.enqueue_message(Bytes::copy_from_slice(data), None, accepted)
    }

    fn enqueue_confirmed(
        &self,
        data: &[u8],
        accepted: impl FnOnce(),
    ) -> Result<oneshot::Receiver<Result<(), String>>, TerminalError> {
        if data.len() > MAX_TERMINAL_INPUT_BYTES {
            return Err(TerminalError::InputTooLarge);
        }
        let (delivered, confirmation) = oneshot::channel();
        self.enqueue_message(Bytes::copy_from_slice(data), Some(delivered), accepted)?;
        Ok(confirmation)
    }

    fn enqueue_unobserved(&self, message: Bytes) -> Result<(), TerminalError> {
        if message.len() > MAX_TERMINAL_INPUT_BYTES {
            return Err(TerminalError::InputTooLarge);
        }
        let mut state = self.shared.state.lock();
        Self::check_open(&state)?;
        if state.responses.len() >= TERMINAL_RESPONSE_QUEUE_MESSAGES
            || state.response_bytes.saturating_add(message.len()) > TERMINAL_RESPONSE_QUEUE_BYTES
        {
            return Err(TerminalError::InputQueueFull);
        }
        state.response_bytes += message.len();
        state.responses.push_back(message);
        drop(state);
        self.shared.ready.notify_one();
        Ok(())
    }

    fn enqueue_message(
        &self,
        data: Bytes,
        delivered: Option<oneshot::Sender<Result<(), String>>>,
        accepted: impl FnOnce(),
    ) -> Result<(), TerminalError> {
        let mut state = self.shared.state.lock();
        Self::check_open(&state)?;
        if state.messages.len() >= TERMINAL_INPUT_QUEUE_MESSAGES
            || state.queued_bytes.saturating_add(data.len()) > TERMINAL_INPUT_QUEUE_BYTES
        {
            return Err(TerminalError::InputQueueFull);
        }
        // The worker cannot observe this message until the accepted-input
        // bookkeeping is complete and the queue lock is released.
        accepted();
        state.queued_bytes += data.len();
        state
            .messages
            .push_back(TerminalInputMessage { data, delivered });
        drop(state);
        self.shared.ready.notify_one();
        Ok(())
    }

    fn check_open(state: &TerminalInputState) -> Result<(), TerminalError> {
        if let Some(error) = &state.failure {
            return Err(TerminalError::Io(format!(
                "terminal input writer stopped: {error}"
            )));
        }
        if state.closed {
            return Err(TerminalError::Io(
                "terminal input writer stopped".to_owned(),
            ));
        }
        Ok(())
    }
}

impl Drop for TerminalInputQueue {
    fn drop(&mut self) {
        self.shared.state.lock().closed = true;
        self.shared.ready.notify_all();
    }
}

impl TerminalInputReceiver {
    fn receive(&self) -> Option<TerminalInputMessage> {
        let mut state = self.shared.state.lock();
        loop {
            if let Some(data) = state.responses.pop_front() {
                state.response_bytes -= data.len();
                return Some(TerminalInputMessage {
                    data,
                    delivered: None,
                });
            }
            if let Some(message) = state.messages.pop_front() {
                state.queued_bytes -= message.data.len();
                return Some(message);
            }
            if state.closed || state.failure.is_some() {
                return None;
            }
            self.shared.ready.wait(&mut state);
        }
    }

    fn fail(&self, error: &std::io::Error) {
        let message = error.to_string();
        let mut state = self.shared.state.lock();
        for pending in state.messages.drain(..) {
            if let Some(delivered) = pending.delivered {
                let _ = delivered.send(Err(message.clone()));
            }
        }
        state.queued_bytes = 0;
        state.responses.clear();
        state.response_bytes = 0;
        state.failure = Some(message);
        self.shared.ready.notify_all();
    }
}

fn terminal_input_channel() -> (TerminalInputQueue, TerminalInputReceiver) {
    let shared = Arc::new(TerminalInputShared::default());
    (
        TerminalInputQueue {
            shared: shared.clone(),
        },
        TerminalInputReceiver { shared },
    )
}

fn run_terminal_input_writer<W: Write>(
    mut writer: W,
    receiver: TerminalInputReceiver,
) -> std::io::Result<()> {
    while let Some(message) = receiver.receive() {
        let TerminalInputMessage { data, delivered } = message;
        if let Err(error) = writer.write_all(&data).and_then(|()| writer.flush()) {
            if let Some(delivered) = delivered {
                let _ = delivered.send(Err(error.to_string()));
            }
            receiver.fail(&error);
            return Err(error);
        }
        if let Some(delivered) = delivered {
            let _ = delivered.send(Ok(()));
        }
    }
    Ok(())
}

#[derive(Debug, Default)]
struct FlowControlState {
    /// Output bytes published but not yet acknowledged by a browser. One counter
    /// for the whole pty, exactly as VS Code keeps one `_unacknowledgedCharCount`
    /// per `TerminalProcess` rather than one per attached client.
    unacknowledged: u64,
    /// Latches at the high watermark and only clears under the low one. Without
    /// the latch a terminal sitting at the watermark would pause and resume on
    /// every chunk.
    paused: bool,
    /// Browsers whose acknowledgements the counter is waiting on. Observer
    /// connections are excluded, and at zero the pty is never paused: agents
    /// here routinely run with nobody watching, and output that no one will ever
    /// acknowledge must not block them.
    clients: usize,
    /// Set once the pty has exited so a blocked read loop can never be stranded.
    released: bool,
}

impl FlowControlState {
    fn blocked(&self) -> bool {
        self.paused && self.clients > 0 && !self.released
    }

    fn published(&mut self, bytes: u64) {
        if self.clients == 0 {
            return;
        }
        self.unacknowledged = self.unacknowledged.saturating_add(bytes);
        if !self.paused && self.unacknowledged > FLOW_CONTROL_HIGH_WATERMARK_BYTES {
            self.paused = true;
        }
    }

    /// Returns true when this acknowledgement resumed the pty.
    fn acknowledged(&mut self, bytes: u64) -> bool {
        // Saturating, like VS Code's `Math.max(count - charCount, 0)`: with
        // several browsers attached the same bytes are acknowledged more than
        // once, and the counter is expected to heal rather than go negative.
        self.unacknowledged = self.unacknowledged.saturating_sub(bytes);
        if self.paused && self.unacknowledged < FLOW_CONTROL_LOW_WATERMARK_BYTES {
            self.paused = false;
            return true;
        }
        false
    }

    /// Drops the outstanding debt and resumes, mirroring VS Code's
    /// `clearUnacknowledgedChars`. Used whenever the set of browsers changes:
    /// what an arriving or departing client owes cannot be reconciled with a
    /// counter that does not track clients individually.
    fn clear(&mut self) {
        self.unacknowledged = 0;
        self.paused = false;
    }
}

/// VS Code's terminal flow control.
///
/// A browser acknowledges output once its parser has consumed it. While the pty
/// has produced more than the high watermark of unacknowledged output the read
/// loop stops draining the master, so the writing process blocks instead of the
/// browser falling behind.
///
/// The counter is per pty, not per browser, which is VS Code's design and its
/// tradeoff: when several browsers watch one terminal they acknowledge the same
/// bytes, the counter drains faster than it fills, and the quickest browser
/// effectively decides when output resumes. A browser slower than that still
/// falls behind and recovers through the existing snapshot path — no browser can
/// throttle the terminal for the others.
#[derive(Debug, Default)]
struct FlowControl {
    state: Mutex<FlowControlState>,
    resumed: Condvar,
}

/// See [`TerminalSession::flow_wait_until_resumed`]. Standalone so tests can
/// drive the wait with a short deadline.
fn flow_wait_until_resumed(flow: &FlowControl, deadline: Duration) {
    let mut state = flow.state.lock();
    let mut expires = std::time::Instant::now() + deadline;
    let mut last_unacknowledged = state.unacknowledged;
    while state.blocked() {
        let remaining = expires.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            // No acknowledgement progress across the whole deadline: the
            // attached browsers are wedged, not slow. Write the debt off rather
            // than keep the agent blocked on a client that will never pay it.
            state.clear();
            break;
        }
        flow.resumed
            .wait_for(&mut state, remaining.min(FLOW_CONTROL_WAIT_BACKSTOP));
        if state.unacknowledged < last_unacknowledged {
            // Acknowledgements are flowing, just not enough to resume yet:
            // an alive browser keeps its full deadline.
            expires = std::time::Instant::now() + deadline;
            last_unacknowledged = state.unacknowledged;
        }
    }
}

pub struct TerminalSession {
    info: RwLock<TerminalInfo>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    input: TerminalInputQueue,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Mutex<TerminalOutputState>,
    events: broadcast::Sender<TerminalEvent>,
    viewports: Mutex<ClientViewports>,
    output_bytes: AtomicU64,
    activity: Mutex<SessionActivity>,
    transcript: Mutex<AgentTranscriptStore>,
    signals: Mutex<TerminalSignals>,
    process_tracker: Mutex<ProcessTracker>,
    flow: FlowControl,
    exit_order: AtomicU64,
    home_directory: PathBuf,
}

impl TerminalSession {
    pub fn info(&self) -> TerminalInfo {
        self.refresh_working_directory();
        let mut info = self.info.read().clone();
        info.clients = self.viewports.lock().sizes.len();
        info
    }

    pub fn subscribe(
        &self,
        requested: Option<TerminalResume>,
        flow_control: bool,
    ) -> (
        broadcast::Receiver<TerminalEvent>,
        TerminalSync,
        TerminalSizeState,
        Option<u32>,
    ) {
        // Publishing takes flow before output. A real client holds the same
        // boundary while constructing its sync plan so output cannot be counted
        // as live flow debt and simultaneously folded into a snapshot that is
        // never acknowledged. Observers do not participate in flow control.
        let mut flow = flow_control.then(|| self.flow.state.lock());
        // Viewports are locked before output, matching resize's lock order, so
        // the accompanying grid dimensions describe this exact snapshot.
        let viewports = self.viewports.lock();
        let output = self.output.lock();
        let receiver = self.events.subscribe();
        let sync = output.sync(requested);
        let exit_code = output.exit_code();
        let size = viewports.published;
        let reset_flow = flow.is_some() && sync.mode == SyncMode::Snapshot;
        if reset_flow {
            flow.as_mut()
                .expect("flow lock held for controlled snapshot")
                .clear();
        }
        drop(output);
        drop(viewports);
        drop(flow);
        if reset_flow {
            self.flow.resumed.notify_all();
        }
        (receiver, sync, size, exit_code)
    }

    pub fn process_inspector(&self) -> ProcessInspectorSnapshot {
        self.process_tracker.lock().snapshot()
    }

    pub fn screen_snapshot(&self, tail_bytes: usize) -> TerminalScreenSnapshot {
        let output = self.output.lock();
        let (rows, cols) = output.screen_size();
        TerminalScreenSnapshot {
            screen: output.detection_text(),
            tail: output.text_tail(tail_bytes),
            rows,
            cols,
            alternate_screen: output.alternate_screen(),
            sequence: output.sequence(),
        }
    }

    pub fn scrollback(
        &self,
        from_sequence: Option<u64>,
        limit_bytes: usize,
    ) -> TerminalScrollbackPage {
        self.output
            .lock()
            .scrollback_page(self.info.read().id, from_sequence, limit_bytes)
    }

    pub fn transcript(
        &self,
        from_sequence: Option<u64>,
        limit: usize,
        kinds: &[AgentTranscriptKind],
    ) -> Option<AgentTranscriptPage> {
        let terminal_id = self.info.read().id;
        let transcript = self.transcript.lock();
        let empty = transcript.is_empty();
        let page = transcript.page(terminal_id, from_sequence, limit, kinds);
        drop(transcript);
        (!empty || self.info.read().agent.is_some()).then_some(page)
    }

    pub fn terminate_process(&self, process_id: &str) -> Result<(), ProcessSignalError> {
        #[cfg(target_os = "linux")]
        {
            let tracked = self
                .process_tracker
                .lock()
                .records
                .iter()
                .any(|process| process.id == process_id);
            if !tracked {
                return Err(ProcessSignalError::NotFound);
            }
            let shell_pid = self.info.read().pid.ok_or(ProcessSignalError::NotFound)?;
            terminate_descendant_process(shell_pid, process_id)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = process_id;
            Err(ProcessSignalError::Unsupported)
        }
    }

    pub fn attach(
        &self,
        client_id: Uuid,
        size: Option<TerminalViewport>,
    ) -> Result<TerminalSizeState, TerminalError> {
        self.update_viewports(|viewports| viewports.attach(client_id, size))
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
        pixel_width: u16,
        pixel_height: u16,
    ) -> Result<TerminalSizeState, TerminalError> {
        self.update_viewports(|viewports| {
            viewports.resize(
                client_id,
                TerminalViewport::new(cols, rows, pixel_width, pixel_height),
            );
        })
    }

    pub fn focus_client(
        &self,
        client_id: Uuid,
        focused: bool,
    ) -> Result<TerminalSizeState, TerminalError> {
        self.update_viewports(|viewports| viewports.focus(client_id, focused))
    }

    pub fn activate_client(&self, client_id: Uuid) -> Result<TerminalSizeState, TerminalError> {
        self.update_viewports(|viewports| viewports.activate(client_id))
    }

    /// Stops measuring the terminal against a client that is still connected.
    pub fn release_client(&self, client_id: Uuid) -> Result<TerminalSizeState, TerminalError> {
        self.update_viewports(|viewports| viewports.release(client_id))
    }

    pub fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        if self.info.read().status != TerminalStatus::Running {
            return Err(TerminalError::NotRunning);
        }
        self.input
            .enqueue(data, || self.observe_accepted_input(data))
    }

    pub async fn write_confirmed(&self, data: &[u8]) -> Result<(), TerminalError> {
        if self.info.read().status != TerminalStatus::Running {
            return Err(TerminalError::NotRunning);
        }
        let confirmation = self
            .input
            .enqueue_confirmed(data, || self.observe_accepted_input(data))?;
        match confirmation.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(TerminalError::Io(error)),
            Err(_) => Err(TerminalError::Io(
                "terminal input writer stopped before delivery".to_owned(),
            )),
        }
    }

    /// Enrols a browser in flow control. Observer connections stay out, so a
    /// preview pane can never pause the pty for the panes that are being read.
    ///
    /// Attaching clears the outstanding debt, mirroring the
    /// `clearUnacknowledgedChars` VS Code performs when a client attaches and
    /// replays: the arriving browser cannot acknowledge output sent before it
    /// existed, so carrying that debt would pause the pty against nobody.
    pub fn flow_attach(&self) {
        let mut state = self.flow.state.lock();
        state.clients += 1;
        state.clear();
        drop(state);
        self.flow.resumed.notify_all();
    }

    #[cfg(feature = "e2e")]
    pub(crate) fn e2e_flow_blocked(&self) -> bool {
        self.flow.state.lock().blocked()
    }

    #[cfg(feature = "e2e")]
    pub(crate) fn e2e_client_count(&self) -> usize {
        self.viewports.lock().sizes.len()
    }

    pub fn flow_detach(&self) {
        let mut state = self.flow.state.lock();
        state.clients = state.clients.saturating_sub(1);
        // What the departing browser owed can no longer be acknowledged, and at
        // zero clients nothing ever will be. Either way the debt is stale.
        state.clear();
        drop(state);
        self.flow.resumed.notify_all();
    }

    pub fn flow_acknowledged(&self, bytes: u64) {
        let mut state = self.flow.state.lock();
        if state.acknowledged(bytes) {
            drop(state);
            self.flow.resumed.notify_all();
        }
    }

    pub fn checkpoint_maximum_bytes(&self) -> usize {
        self.output.lock().checkpoint_maximum_bytes()
    }

    pub fn store_browser_checkpoint(&self, sequence: u64, epoch: u64, bytes: Bytes) -> bool {
        self.output
            .lock()
            .store_browser_checkpoint(sequence, epoch, bytes)
    }

    /// Blocks the pty read loop while output stands unacknowledged above the
    /// high watermark, so the master's buffer fills and the writing process
    /// blocks. This is the only backpressure that reaches a TUI. The pause is
    /// bounded: browsers that stop acknowledging entirely have their debt
    /// written off after `FLOW_CONTROL_PAUSE_DEADLINE` so a wedged client can
    /// never freeze the terminal for the agent or the other clients.
    fn flow_wait_until_resumed(&self) {
        let deadline = FLOW_CONTROL_PAUSE_DEADLINE;
        #[cfg(feature = "e2e")]
        let deadline = e2e_flow_control_pause_deadline().unwrap_or(deadline);
        flow_wait_until_resumed(&self.flow, deadline);
    }

    /// Permanently opens the gate. A parked read loop must not outlive the
    /// process it is reading from.
    fn flow_release(&self) {
        let mut state = self.flow.state.lock();
        state.released = true;
        drop(state);
        self.flow.resumed.notify_all();
    }

    fn observe_accepted_input(&self, data: &[u8]) {
        let now = current_millis();
        let input = self.activity.lock().prompt_capture.observe(data);
        if input.submitted {
            let agent_active = self
                .info
                .read()
                .agent
                .as_ref()
                .is_some_and(|agent| agent.status != AgentStatus::Closed);
            if agent_active {
                let mut activity = self.activity.lock();
                let mut info = self.info.write();
                if let Some(agent) = info.agent.as_mut()
                    && agent.status != AgentStatus::Closed
                {
                    // Anchor the chat title to its first task. Follow-up work cycles keep
                    // that title, and a failed generation retries with the original task.
                    activity.begin_submission(agent, now, input.prompt);
                }
            } else if let Some(prompt) = input.prompt
                && let Some(agent) = self.live_agent_observation()
            {
                let mut activity = self.activity.lock();
                let mut info = self.info.write();
                if activity.agent_pid == Some(agent.pid)
                    && let Some(current) = info.agent.as_mut()
                    && current.kind == agent.kind
                    && current.status != AgentStatus::Closed
                {
                    activity.begin_submission(current, now, Some(prompt));
                } else {
                    activity.pending_agent_submission = Some(PendingAgentSubmission {
                        agent_pid: agent.pid,
                        agent_start_ticks: agent.start_ticks,
                        agent_kind: agent.kind,
                        submitted_at: now,
                        prompt,
                    });
                }
            }
        }
    }

    fn live_agent_observation(&self) -> Option<AgentObservation> {
        let info = self.info.read();
        let shell_pid = info.pid?;
        let shell_name = executable_name(&info.shell);
        drop(info);
        ProcessSnapshot::read(&[shell_pid])
            .observe(shell_pid, &shell_name)
            .agent
    }

    fn update_viewports(
        &self,
        update: impl FnOnce(&mut ClientViewports),
    ) -> Result<TerminalSizeState, TerminalError> {
        let mut viewports = self.viewports.lock();
        update(&mut viewports);
        let mut state = viewports.state();
        let size_changed = (
            state.cols,
            state.rows,
            state.pixel_width,
            state.pixel_height,
        ) != (
            viewports.published.cols,
            viewports.published.rows,
            viewports.published.pixel_width,
            viewports.published.pixel_height,
        );
        let publish = state != viewports.published;
        let running = self.info.read().status == TerminalStatus::Running;
        // Serialize controller/responder changes and resize redraws with PTY
        // output so every browser applies the role and grid before the output
        // whose replies it may be responsible for.
        let mut output = publish.then(|| self.output.lock());
        if size_changed {
            if running {
                self.master
                    .lock()
                    .resize(PtySize {
                        cols: state.cols,
                        rows: state.rows,
                        pixel_width: state.pixel_width,
                        pixel_height: state.pixel_height,
                    })
                    .map_err(|error| TerminalError::Io(error.to_string()))?;
            }
            output
                .as_mut()
                .expect("output state locked for resize")
                .resize(
                    state.rows,
                    state.cols,
                    state.pixel_width,
                    state.pixel_height,
                );
            state.epoch = output
                .as_ref()
                .expect("output state locked for resize")
                .grid_epoch();
        }
        viewports.published = state;
        if publish {
            let _ = self.events.send(TerminalEvent::Size(state));
        }
        drop(output);
        Ok(state)
    }

    pub fn kill(&self) {
        // Open the gate first: a parked read loop would otherwise wait on
        // acknowledgements for a pty that is about to close.
        self.flow_release();
        if self.info.read().status == TerminalStatus::Running {
            let _ = self.killer.lock().kill();
        }
    }

    fn publish(&self, bytes: Bytes) {
        let now = current_millis();
        self.signals.lock().observe(&bytes, now);
        self.output_bytes
            .fetch_add(bytes.len() as u64, Ordering::Relaxed);
        // Counted once here, where the bytes leave the pty, rather than once per
        // browser they are fanned out to. This is VS Code's accounting: the debt
        // belongs to the terminal, and any browser's acknowledgement pays it
        // down. The read loop checks the result before its next read.
        let mut flow = self.flow.state.lock();
        flow.published(bytes.len() as u64);
        // Hold flow through the canonical mutation and event. Snapshot
        // subscription takes the same order, so bytes are either live output
        // with matching debt or part of the snapshot that clears that debt.
        // The output lock also orders this mutation against resize's Size event.
        let mut state = self.output.lock();
        let output = state.publish(bytes);
        let responses = state.drain_responses();
        let _ = self.events.send(TerminalEvent::Output(output));
        drop(state);
        drop(flow);
        for response in responses {
            if let Err(error) = self.input.enqueue_unobserved(response) {
                tracing::warn!(%error, "terminal query response could not be queued");
            }
        }
    }

    fn exited(&self, exit_code: u32, exit_order: u64) {
        self.flow_release();
        // Publish the retention order before exposing the exited status so a
        // concurrent prune can never mistake a freshly exited session for the
        // oldest retained entry (the default order is zero).
        self.exit_order.store(exit_order, Ordering::Release);
        {
            let mut info = self.info.write();
            info.status = TerminalStatus::Exited;
            info.exit_code = Some(exit_code);
            info.pid = None;
        }
        // Serialize exit with output and subscriptions. A subscriber that
        // attaches after the broadcast can observe the stored exit code
        // instead of waiting forever for an event it missed.
        self.output.lock().mark_exited(exit_code);
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

    /// Everything screen detection saw for this terminal and what it concluded.
    ///
    /// This is a debugging surface for a terminal showing the wrong state. It
    /// returns the same screen the caller can already read in the browser, so
    /// it exposes nothing new to an authenticated session, but it is terminal
    /// content and should be treated that way.
    pub fn agent_explain(&self) -> AgentDetectionExplain {
        let agent = self.info.read().agent.clone();
        let screen = self.output.lock().detection_text();
        let signals = self.signals.lock();
        let osc_title = signals.osc_title().to_owned();
        let osc_progress = signals.osc_progress().to_owned();
        drop(signals);

        let detection = agent.as_ref().and_then(|agent| {
            agent_detection::explain(
                &agent.kind,
                agent_detection::DetectionInput {
                    screen: &screen,
                    osc_title: &osc_title,
                    osc_progress: &osc_progress,
                },
            )
        });
        AgentDetectionExplain {
            agent_kind: agent.as_ref().map(|agent| agent.kind.clone()),
            status: agent.map(|agent| agent.status),
            detection,
            osc_title,
            osc_progress,
            screen,
        }
    }

    /// Classifies the live screen for `agent_kind`, or `None` when no manifest
    /// covers that agent.
    fn detect_agent_state(&self, agent_kind: &str) -> Option<agent_detection::Detection> {
        let screen = self.output.lock().detection_text();
        let signals = self.signals.lock();
        agent_detection::detect(
            agent_kind,
            agent_detection::DetectionInput {
                screen: &screen,
                osc_title: signals.osc_title(),
                osc_progress: signals.osc_progress(),
            },
        )
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
        self.process_tracker.lock().update(
            shell_pid,
            &processes.descendants(shell_pid),
            processes.cpu_sample,
        );
        let shell_name = executable_name(&self.info.read().shell);
        let observation = processes.observe(shell_pid, &shell_name);
        let alternate_screen = self.output.lock().alternate_screen();
        let output_bytes = self.output_bytes.load(Ordering::Relaxed);
        let reported_state = self.signals.lock().agent_state;
        // Screen detection only runs for a recognized agent. Rendering the
        // screen for every terminal on every sample would not pay for itself.
        let detection = observation
            .agent
            .as_ref()
            .and_then(|agent| self.detect_agent_state(&agent.kind));
        let mut activity = self.activity.lock();
        let mut info = self.info.write();
        if activity.expire_native_state(now)
            && let Some(agent) = info.agent.as_mut()
        {
            agent.activity = None;
        }
        let previous_program = info.program.clone();
        info.program = observation.program.clone();
        activity.foreground_command.refresh(
            &mut info.command,
            observation.foreground.as_ref(),
            alternate_screen,
            observation.agent.is_some(),
            now,
        );

        let mut outcome = RefreshOutcome::default();
        if let Some(agent) = observation.agent {
            let process_identity_changed = activity.agent_pid.is_some()
                && (activity.agent_pid != Some(agent.pid)
                    || activity
                        .agent_start_ticks
                        .is_some_and(|start_ticks| start_ticks != agent.start_ticks));
            let provider_changed = info
                .agent
                .as_ref()
                .is_some_and(|current| current.kind != agent.kind);
            let is_new_agent = activity.agent_pid != Some(agent.pid)
                || activity
                    .agent_start_ticks
                    .is_some_and(|start_ticks| start_ticks != agent.start_ticks)
                || info
                    .agent
                    .as_ref()
                    .is_none_or(|current| current.kind != agent.kind);
            if is_new_agent {
                if process_identity_changed || provider_changed {
                    activity.clear_native_sequence();
                }
                let preserve_native_state = activity.native_provider.as_deref()
                    == Some(agent.kind.as_str())
                    && info
                        .agent
                        .as_ref()
                        .is_some_and(|current| current.kind == agent.kind);
                let pending_submission =
                    activity
                        .pending_agent_submission
                        .take()
                        .filter(|submission| {
                            submission.agent_pid == agent.pid
                                && submission.agent_start_ticks == agent.start_ticks
                                && submission.agent_kind == agent.kind
                        });
                activity.agent_pid = Some(agent.pid);
                activity.agent_start_ticks = Some(agent.start_ticks);
                activity.last_cpu_ticks = agent.cpu_ticks;
                activity.last_sample_output_bytes = output_bytes;
                activity.active_samples = 0;
                activity.quiet_samples = 0;
                activity.prompt_capture = PromptCapture::default();
                activity.pending_title_prompt = None;
                activity.title_revision = 0;
                activity.title_in_flight_revision = None;
                activity.generated_title = None;
                activity.initial_title_prompt = None;
                activity.summary_in_flight_revision = None;
                if preserve_native_state {
                    activity.input_submitted_at =
                        if activity.native_status == Some(AgentStatus::Working) {
                            now
                        } else {
                            0
                        };
                } else {
                    activity.native_provider = None;
                    activity.native_status = None;
                    activity.native_updated_at = 0;
                    // A new agent starts from a blank OSC slate rather than
                    // inheriting the previous process's title or progress.
                    self.signals.lock().clear_detection_payloads();
                    let revision = info
                        .agent
                        .as_ref()
                        .map_or(1, |current| current.revision.saturating_add(1));
                    let initial_state = initial_agent_state(
                        reported_state,
                        now,
                        revision,
                        pending_submission
                            .as_ref()
                            .map(|submission| submission.submitted_at),
                    );
                    activity.input_submitted_at = initial_state.input_submitted_at;
                    if let Some(submission) = pending_submission {
                        activity.queue_title_for_submission(
                            &AgentStatus::Idle,
                            Some(submission.prompt),
                        );
                    }
                    info.agent = Some(AgentInfo {
                        kind: agent.kind.clone(),
                        status: initial_state.status,
                        status_changed_at: now,
                        started_at: now,
                        revision: initial_state.revision,
                        completed_at: initial_state.completed_at,
                        summary: None,
                        activity: None,
                    });
                    if initial_state.completed_at.is_some() && pi_summaries_enabled {
                        activity.summary_in_flight_revision = Some(initial_state.revision);
                        outcome.summary = Some((
                            initial_state.revision,
                            self.pi_request(PiTaskKind::Summary, &info, &agent.kind, None),
                        ));
                    }
                }
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
                let next_status = resolve_agent_status(
                    activity.native_status.clone(),
                    detection.as_ref(),
                    StatusFallback {
                        agent_kind: &agent.kind,
                        current_status,
                        reported_state,
                        now,
                        input_submitted_at: activity.input_submitted_at,
                        resumed_after_completion: info
                            .agent
                            .as_ref()
                            .is_some_and(|current| current.completed_at.is_some()),
                        active_samples: activity.active_samples,
                        quiet_samples: activity.quiet_samples,
                    },
                );
                if next_status == AgentStatus::Working && activity.input_submitted_at == 0 {
                    // Work resumed without a prompt (an autonomous agent was
                    // re-invoked). Record the resumption as the submission so
                    // the eventual return to idle registers as a completion.
                    activity.input_submitted_at = now;
                }
                if let Some(current) = info.agent.as_mut()
                    && current.status != next_status
                {
                    let was_working = current.status == AgentStatus::Working;
                    current.status = next_status.clone();
                    current.status_changed_at = now;
                    current.revision = current.revision.saturating_add(1);
                    if next_status != AgentStatus::Working {
                        current.activity = None;
                    }
                    if was_working
                        && next_status == AgentStatus::Idle
                        && activity.input_submitted_at > 0
                    {
                        activity.input_submitted_at = 0;
                        current.completed_at = Some(now);
                        current.summary = None;
                        let revision = current.revision;
                        if pi_summaries_enabled
                            && activity.summary_in_flight_revision != Some(revision)
                        {
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
                let completed_task = activity.input_submitted_at > 0;
                current.status = AgentStatus::Closed;
                current.revision = current.revision.saturating_add(1);
                current.activity = None;
                if completed_task {
                    current.completed_at = Some(now);
                    current.summary = None;
                    let revision = current.revision;
                    let kind = current.kind.clone();
                    if pi_summaries_enabled && activity.summary_in_flight_revision != Some(revision)
                    {
                        activity.summary_in_flight_revision = Some(revision);
                        outcome.summary = Some((
                            revision,
                            self.pi_request(PiTaskKind::Summary, &info, &kind, None),
                        ));
                    }
                }
            }
            activity.agent_pid = None;
            activity.agent_start_ticks = None;
            activity.active_samples = 0;
            activity.quiet_samples = 0;
            activity.input_submitted_at = 0;
            activity.pending_title_prompt = None;
            activity.title_in_flight_revision = None;
            activity.native_provider = None;
            activity.native_status = None;
            activity.native_updated_at = 0;
            activity.clear_native_sequence();
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

    fn apply_agent_event(
        &self,
        mut event: AgentEvent,
        pi_summaries_enabled: bool,
        now: u64,
    ) -> RefreshOutcome {
        let transcript = std::mem::take(&mut event.transcript);
        if event.transcript_reset {
            self.transcript
                .lock()
                .replace(&event.provider, transcript, now);
        } else if !transcript.is_empty() {
            self.transcript
                .lock()
                .extend(&event.provider, transcript, now);
        }
        if event.transcript_only {
            return RefreshOutcome::default();
        }
        let mut activity = self.activity.lock();
        let mut info = self.info.write();
        if !activity.accept_native_sequence(&event.provider, event.sequence) {
            return RefreshOutcome::default();
        }
        activity.foreground_command.candidate = None;
        info.command = None;
        let next_status = match event.kind {
            AgentEventKind::Completed => AgentStatus::Idle,
            AgentEventKind::Closed => AgentStatus::Closed,
            // The agent asked for an approval or a decision and is now waiting
            // on a person, which is not the same as being busy.
            AgentEventKind::WaitingForApproval => AgentStatus::Blocked,
            _ => AgentStatus::Working,
        };
        activity.native_provider = Some(event.provider.clone());
        activity.native_status = Some(next_status.clone());
        activity.native_updated_at = now;
        activity.input_submitted_at = match next_status {
            AgentStatus::Working => now,
            // A block happens mid-turn, so the submission that started the turn
            // still stands and has to survive until the agent moves on.
            AgentStatus::Blocked => activity.input_submitted_at,
            _ => 0,
        };

        let next_activity = event.kind.activity_label().map(|label| AgentActivity {
            label: label.to_owned(),
            updated_at: now,
        });
        let current = info.agent.take();
        let mut agent = match current {
            Some(current) if current.kind == event.provider => current,
            previous => AgentInfo {
                kind: event.provider.clone(),
                status: next_status.clone(),
                status_changed_at: now,
                started_at: now,
                revision: previous.map_or(1, |agent| agent.revision.saturating_add(1)),
                completed_at: None,
                summary: None,
                activity: next_activity.clone(),
            },
        };

        let previous_status = agent.status.clone();
        if agent.status != next_status {
            agent.status = next_status.clone();
            agent.status_changed_at = now;
            agent.revision = agent.revision.saturating_add(1);
            if next_status == AgentStatus::Working {
                agent.completed_at = None;
                agent.summary = None;
            } else if previous_status == AgentStatus::Working {
                agent.completed_at = Some(now);
                agent.summary = None;
            }
        }
        agent.activity = next_activity;
        let completed_revision = (previous_status == AgentStatus::Working
            && next_status != AgentStatus::Working)
            .then_some(agent.revision);
        let agent_kind = agent.kind.clone();
        info.agent = Some(agent);

        let mut outcome = RefreshOutcome::default();
        if let Some(revision) = completed_revision
            && pi_summaries_enabled
            && activity.summary_in_flight_revision != Some(revision)
        {
            activity.summary_in_flight_revision = Some(revision);
            outcome.summary = Some((
                revision,
                self.pi_request(PiTaskKind::Summary, &info, &agent_kind, None),
            ));
        }
        if let Some(title) = event.title
            && activity.automatic_name
        {
            // A provider (omp) already titled this conversation; adopt it and stop
            // term-server's own generation so a stale Pi result can't overwrite it.
            activity.pending_title_prompt = None;
            activity.title_in_flight_revision = None;
            activity.generated_title = Some(title.clone());
            info.name = title;
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
                self.output.lock().text_tail(12 * 1024)
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
    default_shell: RwLock<Option<String>>,
    replay_bytes: AtomicUsize,
    next_exit_order: Arc<AtomicU64>,
    home_directory: PathBuf,
    agent_event_socket: Option<PathBuf>,
    executable: Option<PathBuf>,
}

impl TerminalManager {
    pub fn new(default_shell: Option<String>, replay_bytes: usize) -> Self {
        let home_directory = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            default_shell: RwLock::new(default_shell),
            replay_bytes: AtomicUsize::new(replay_bytes),
            next_exit_order: Arc::new(AtomicU64::new(0)),
            home_directory,
            agent_event_socket: None,
            executable: std::env::current_exe().ok(),
        }
    }

    pub fn with_agent_event_socket(mut self, socket: PathBuf) -> Self {
        self.agent_event_socket = Some(socket);
        self
    }

    pub fn configure(&self, default_shell: Option<String>, replay_bytes: usize) {
        *self.default_shell.write() = default_shell;
        self.replay_bytes.store(replay_bytes, Ordering::Relaxed);
    }

    fn prune_exited_sessions(&self) {
        let mut sessions = self.sessions.write();
        let mut exited = sessions
            .iter()
            .filter_map(|(id, session)| {
                (session.info.read().status == TerminalStatus::Exited)
                    .then_some((*id, session.exit_order.load(Ordering::Acquire)))
            })
            .collect::<Vec<_>>();
        if exited.len() <= MAX_RETAINED_EXITED_SESSIONS {
            return;
        }
        exited.sort_unstable_by_key(|(id, order)| (*order, *id));
        let remove_count = exited.len() - MAX_RETAINED_EXITED_SESSIONS;
        let removed = exited
            .into_iter()
            .take(remove_count)
            .filter_map(|(id, _)| sessions.remove(&id))
            .collect::<Vec<_>>();
        drop(sessions);
        // Dropping the manager's Arc releases replay/PTY resources once any
        // active socket has released its own reference. Never kill here: all
        // selected sessions have already reported Exited, and running sessions
        // are not candidates for this list.
        drop(removed);
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        self.prune_exited_sessions();
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
        self.prune_exited_sessions();
        self.sessions.read().get(&id).cloned()
    }

    pub fn running_count(&self) -> usize {
        self.prune_exited_sessions();
        self.sessions
            .read()
            .values()
            .filter(|session| session.info.read().status == TerminalStatus::Running)
            .count()
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

    pub fn apply_agent_event(&self, id: Uuid, event: AgentEvent, pi: Arc<PiService>) -> bool {
        let Some(session) = self.get(id) else {
            return false;
        };
        let outcome = session.apply_agent_event(event, pi.summaries_enabled(), current_millis());
        if let Some((revision, request)) = outcome.summary {
            tokio::spawn(async move {
                session.finish_summary(revision, pi.generate(request).await);
            });
        }
        true
    }

    fn refresh_processes(&self, pi: Arc<PiService>) {
        self.prune_exited_sessions();
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
        self.create_with(request, TerminalKind::Regular, BTreeMap::new())
    }

    pub fn create_supervisor(
        &self,
        request: CreateSupervisorTerminal,
    ) -> Result<TerminalInfo, TerminalError> {
        self.create_with(
            request.terminal,
            TerminalKind::Supervisor,
            request.environment,
        )
    }

    fn create_with(
        &self,
        request: CreateTerminal,
        kind: TerminalKind,
        environment: BTreeMap<String, String>,
    ) -> Result<TerminalInfo, TerminalError> {
        self.prune_exited_sessions();
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
            .unwrap_or_else(|| {
                self.default_shell
                    .read()
                    .clone()
                    .unwrap_or_else(default_shell)
            });

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
            (executable_name(&shell), kind == TerminalKind::Regular)
        };
        let workspace = workspace_for(&cwd, &self.home_directory);
        let path = terminal_path(&workspace, &name);
        let supervisor_root = (kind == TerminalKind::Supervisor).then(|| cwd.clone());

        let id = Uuid::new_v4();
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: DEFAULT_VIEWPORT_SIZE.rows,
                cols: DEFAULT_VIEWPORT_SIZE.cols,
                pixel_width: DEFAULT_VIEWPORT_SIZE.pixel_width,
                pixel_height: DEFAULT_VIEWPORT_SIZE.pixel_height,
            })
            .map_err(|error| TerminalError::Spawn {
                shell: shell.clone(),
                message: error.to_string(),
            })?;
        let mut command = CommandBuilder::new(&shell);
        command.cwd(&cwd);
        configure_terminal_environment(&mut command);
        for (name, value) in environment {
            command.env(name, value);
        }
        command.env_remove("TERM_SERVER_BROKER_CONTROL_TOKEN");
        command.env("TERM_SERVER_SESSION", id.to_string());
        if let (Some(executable), Some(socket)) = (&self.executable, &self.agent_event_socket) {
            command.env("TERM_SERVER_EXECUTABLE", executable);
            command.env("TERM_SERVER_BROKER_SOCKET", socket);
        }
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
        let input = TerminalInputQueue::spawn(id, writer)?;
        let killer = child.clone_killer();
        let (events, _) = broadcast::channel(TERMINAL_EVENT_CAPACITY);
        let replay_bytes = self.replay_bytes.load(Ordering::Relaxed);
        let session = Arc::new(TerminalSession {
            info: RwLock::new(TerminalInfo {
                kind,
                supervisor_root,
                id,
                name,
                color: color_for(&workspace),
                workspace,
                path,
                cwd,
                program: executable_name(&shell),
                shell,
                agent: None,
                command: None,
                created_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                pid,
                status: TerminalStatus::Running,
                exit_code: None,
                clients: 0,
                broker: None,
            }),
            master: Mutex::new(pair.master),
            input,
            killer: Mutex::new(killer),
            output: Mutex::new(TerminalOutputState::new(
                replay_bytes,
                DEFAULT_VIEWPORT_SIZE.rows,
                DEFAULT_VIEWPORT_SIZE.cols,
            )),
            events,
            viewports: Mutex::new(ClientViewports::default()),
            output_bytes: AtomicU64::new(0),
            activity: Mutex::new(SessionActivity {
                automatic_name,
                ..SessionActivity::default()
            }),
            transcript: Mutex::new(AgentTranscriptStore::new(replay_bytes)),
            signals: Mutex::new(TerminalSignals::default()),
            process_tracker: Mutex::new(ProcessTracker::default()),
            flow: FlowControl::default(),
            exit_order: AtomicU64::new(0),
            home_directory: self.home_directory.clone(),
        });
        sessions.insert(id, session.clone());
        drop(sessions);

        let output_session = session.clone();
        let next_exit_order = self.next_exit_order.clone();
        thread::Builder::new()
            .name(format!("terminal-output-{id}"))
            .spawn(move || {
                read_output(reader, output_session.clone());
                let exit_code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
                let exit_order = next_exit_order.fetch_add(1, Ordering::Relaxed);
                output_session.exited(exit_code, exit_order);
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

pub(crate) fn is_terminal_descendant(shell_pid: u32, pid: u32, start_ticks: u64) -> bool {
    #[cfg(target_os = "linux")]
    {
        ProcessSnapshot::read(&[shell_pid])
            .descendants(shell_pid)
            .into_iter()
            .any(|process| process.pid == pid && process.start_ticks == start_ticks)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (shell_pid, pid, start_ticks);
        false
    }
}

pub(crate) fn terminate_descendant_process(
    shell_pid: u32,
    process_id: &str,
) -> Result<(), ProcessSignalError> {
    #[cfg(target_os = "linux")]
    {
        let processes = ProcessSnapshot::read(&[shell_pid]);
        let process = processes
            .descendants(shell_pid)
            .into_iter()
            .find(|process| process.identity().label() == process_id)
            .ok_or(ProcessSignalError::NotFound)?;
        signal_process(process.pid, process_id)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (shell_pid, process_id);
        Err(ProcessSignalError::Unsupported)
    }
}

fn read_output(mut reader: Box<dyn Read + Send>, session: Arc<TerminalSession>) {
    read_output_chunks(
        reader.as_mut(),
        || session.flow_wait_until_resumed(),
        |bytes| session.publish(bytes),
    );
}

/// Drains the pty master. `before_read` gates each read on flow control: while
/// it blocks, the master's buffer fills and the process writing to it blocks
/// too, which is what stops a browser from ever being handed more output than
/// it can parse.
fn read_output_chunks<R: Read + ?Sized>(
    reader: &mut R,
    mut before_read: impl FnMut(),
    mut publish: impl FnMut(Bytes),
) {
    let mut buffer = vec![0_u8; TERMINAL_OUTPUT_FRAME_BYTES];
    loop {
        before_read();
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => publish(Bytes::copy_from_slice(&buffer[..count])),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                tracing::debug!(%error, "terminal output read failed");
                break;
            }
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
    previous_cpu_ticks: HashMap<ProcessIdentity, u64>,
    previous_total_cpu_ticks: Option<u64>,
}

impl ProcessTracker {
    fn update(
        &mut self,
        shell_pid: u32,
        processes: &[&ProcessInfo],
        cpu_sample: Option<CpuSample>,
    ) {
        let identities = processes
            .iter()
            .map(|process| (process.pid, process.identity()))
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
                let cpu_percent = cpu_sample
                    .zip(self.previous_total_cpu_ticks)
                    .and_then(|(current, previous_total)| {
                        let total_delta = current.total_ticks.checked_sub(previous_total)?;
                        let process_delta = process
                            .cpu_ticks
                            .checked_sub(*self.previous_cpu_ticks.get(&identity)?)?;
                        (total_delta > 0).then(|| {
                            process_delta as f64 * f64::from(current.cpu_count) * 100.0
                                / total_delta as f64
                        })
                    })
                    .unwrap_or_default();
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
                    cpu_percent: (cpu_percent * 10.0).round() as f32 / 10.0,
                    memory_bytes: process.memory_bytes,
                }
            })
            .collect();
        self.previous_cpu_ticks = processes
            .iter()
            .map(|process| (process.identity(), process.cpu_ticks))
            .collect();
        self.previous_total_cpu_ticks = cpu_sample.map(|sample| sample.total_ticks);
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
    memory_bytes: u64,
}

impl ProcessInfo {
    fn identity(&self) -> ProcessIdentity {
        ProcessIdentity {
            pid: self.pid,
            start_ticks: self.start_ticks,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct CpuSample {
    total_ticks: u64,
    cpu_count: u32,
}

#[derive(Debug, Default)]
struct ProcessSnapshot {
    processes: HashMap<u32, ProcessInfo>,
    children: HashMap<u32, Vec<u32>>,
    cpu_sample: Option<CpuSample>,
}

impl ProcessSnapshot {
    fn read(shell_pids: &[u32]) -> Self {
        #[cfg(target_os = "linux")]
        {
            let Ok(entries) = std::fs::read_dir("/proc") else {
                return Self::default();
            };
            let mut candidates = HashMap::new();
            let mut children = HashMap::<u32, Vec<u32>>::new();
            for entry in entries.flatten() {
                let Some(pid) = entry
                    .file_name()
                    .to_str()
                    .and_then(|name| name.parse::<u32>().ok())
                else {
                    continue;
                };
                let directory = entry.path();
                let Ok(stat) = std::fs::read_to_string(directory.join("stat")) else {
                    continue;
                };
                let Some(parent) = parse_process_parent(&stat) else {
                    continue;
                };
                children.entry(parent).or_default().push(pid);
                candidates.insert(pid, (directory, stat));
            }

            let descendant_pids = collect_descendant_pids(shell_pids, &children);
            let processes = descendant_pids
                .iter()
                .filter_map(|pid| {
                    let (directory, stat) = candidates.get(pid)?;
                    parse_process_stat(*pid, stat, directory).map(|process| (*pid, process))
                })
                .collect();
            children.retain(|parent, values| {
                if !descendant_pids.contains(parent) {
                    return false;
                }
                values.retain(|pid| descendant_pids.contains(pid));
                true
            });
            Self {
                processes,
                children,
                cpu_sample: std::fs::read_to_string("/proc/stat")
                    .ok()
                    .and_then(|stat| parse_cpu_sample(&stat)),
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
                foreground: None,
            };
        };
        let foreground_group = shell.foreground_group;
        if foreground_group <= 0 || foreground_group == shell.group {
            return ProcessObservation {
                program: shell_name.to_owned(),
                shell_foreground: true,
                agent: None,
                foreground: None,
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
                foreground: None,
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
        let program = process_program(root);
        let agent = candidates.iter().find_map(|process| {
            agent_kind(process).map(|kind| AgentObservation {
                kind,
                pid: root.pid,
                start_ticks: root.start_ticks,
                cpu_ticks: candidates.iter().map(|process| process.cpu_ticks).sum(),
            })
        });
        ProcessObservation {
            program: agent
                .as_ref()
                .map(|agent| agent.kind.clone())
                .unwrap_or_else(|| program.clone()),
            shell_foreground: false,
            agent,
            foreground: Some(ForegroundObservation {
                group: foreground_group,
                name: program,
            }),
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
            if let Some(children) = self.children.get(&pid) {
                pending.extend(children.iter().copied());
            }
            if let Some(process) = self.processes.get(&pid) {
                descendants.push(process);
            }
        }
        descendants
    }
}

#[cfg(target_os = "linux")]
fn collect_descendant_pids(roots: &[u32], children: &HashMap<u32, Vec<u32>>) -> HashSet<u32> {
    let mut descendants = HashSet::new();
    let mut pending = roots.to_vec();
    while let Some(pid) = pending.pop() {
        if !descendants.insert(pid) {
            continue;
        }
        if let Some(children) = children.get(&pid) {
            pending.extend(children.iter().copied());
        }
    }
    descendants
}

#[cfg(target_os = "linux")]
fn parse_process_parent(stat: &str) -> Option<u32> {
    let close = stat.rfind(')')?;
    stat[close + 1..].split_whitespace().nth(1)?.parse().ok()
}

#[cfg(target_os = "linux")]
fn parse_process_identity(pid: u32, stat: &str) -> Option<ProcessIdentity> {
    let close = stat.rfind(')')?;
    let start_ticks = stat[close + 1..].split_whitespace().nth(19)?.parse().ok()?;
    Some(ProcessIdentity { pid, start_ticks })
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
    let memory_bytes = std::fs::read_to_string(directory.join("status"))
        .ok()
        .and_then(|status| parse_resident_memory_bytes(&status))
        .unwrap_or_default();
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
        memory_bytes,
    })
}

#[cfg(target_os = "linux")]
fn parse_resident_memory_bytes(status: &str) -> Option<u64> {
    let kibibytes = status.lines().find_map(|line| {
        line.strip_prefix("VmRSS:")?
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()
    })?;
    Some(kibibytes.saturating_mul(1024))
}

#[cfg(target_os = "linux")]
fn parse_cpu_sample(stat: &str) -> Option<CpuSample> {
    let mut lines = stat.lines();
    let total_ticks = lines
        .next()?
        .strip_prefix("cpu ")?
        .split_whitespace()
        .take(8)
        .try_fold(0_u64, |total, value| {
            value
                .parse::<u64>()
                .ok()
                .map(|ticks| total.saturating_add(ticks))
        })?;
    let cpu_count = lines
        .filter_map(|line| line.split_whitespace().next())
        .filter_map(|label| label.strip_prefix("cpu"))
        .filter(|suffix| !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit()))
        .count()
        .max(1) as u32;
    Some(CpuSample {
        total_ticks,
        cpu_count,
    })
}

#[cfg(target_os = "linux")]
fn signal_process(pid: u32, process_id: &str) -> Result<(), ProcessSignalError> {
    use rustix::process::{Pid, PidfdFlags, Signal, kill_process, pidfd_open, pidfd_send_signal};

    let pid = i32::try_from(pid)
        .ok()
        .and_then(Pid::from_raw)
        .ok_or(ProcessSignalError::NotFound)?;
    let pidfd = pidfd_open(pid, PidfdFlags::empty()).ok();
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_err(|_| ProcessSignalError::NotFound)?;
    let current_id = parse_process_identity(pid.as_raw_pid() as u32, &stat)
        .map(ProcessIdentity::label)
        .ok_or(ProcessSignalError::NotFound)?;
    if current_id != process_id {
        return Err(ProcessSignalError::NotFound);
    }

    let result = if let Some(pidfd) = pidfd {
        pidfd_send_signal(pidfd, Signal::TERM)
    } else {
        kill_process(pid, Signal::TERM)
    };
    if result == Err(rustix::io::Errno::SRCH) {
        Err(ProcessSignalError::NotFound)
    } else {
        result.map_err(|error| ProcessSignalError::Io(error.to_string()))
    }
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
    if tokens.iter().any(|token| token == "omp") {
        return Some("omp".to_owned());
    }
    if tokens
        .iter()
        .any(|token| token == "hermes" || token == "hermes-agent")
    {
        return Some("hermes".to_owned());
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
        "node"
            | "nodejs"
            | "python"
            | "python3"
            | "bun"
            | "bash"
            | "dash"
            | "sh"
            | "zsh"
            | "fish"
            | "ruby"
            | "perl"
            | "php"
    ) && let Some(script) = process.arguments.get(1)
        && !script.starts_with('-')
    {
        let script_name = executable_name(script)
            .trim_end_matches(".js")
            .trim_end_matches(".mjs")
            .trim_end_matches(".cjs")
            .trim_end_matches(".ts")
            .trim_end_matches(".py")
            .trim_end_matches(".sh")
            .trim_end_matches(".rb")
            .trim_end_matches(".pl")
            .trim_end_matches(".php")
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

pub(crate) fn sanitize_terminal_text(input: &str) -> String {
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
    command.env("TERM_SERVER_ARTIFACTS_DIR", artifacts::root_directory());
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
    use std::{
        collections::VecDeque,
        io,
        sync::mpsc,
        time::{Duration, Instant},
    };

    use super::*;

    struct RecordingWriter {
        output: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.output.lock().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct BlockingWriter {
        output: Arc<Mutex<Vec<u8>>>,
        started: Option<mpsc::Sender<()>>,
        release: mpsc::Receiver<()>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if let Some(started) = self.started.take() {
                started.send(()).unwrap();
                self.release.recv().unwrap();
            }
            self.output.lock().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "writer closed"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn spawn_test_input_writer<W: Write + Send + 'static>(
        writer: W,
    ) -> (TerminalInputQueue, thread::JoinHandle<io::Result<()>>) {
        let (queue, receiver) = terminal_input_channel();
        let worker = thread::spawn(move || run_terminal_input_writer(writer, receiver));
        (queue, worker)
    }

    #[test]
    fn terminal_input_writer_preserves_message_order() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let (queue, worker) = spawn_test_input_writer(RecordingWriter {
            output: output.clone(),
        });

        queue.enqueue(b"first", || {}).unwrap();
        queue.enqueue(b"-second", || {}).unwrap();
        queue.enqueue(b"-third", || {}).unwrap();
        drop(queue);
        worker.join().unwrap().unwrap();

        assert_eq!(&*output.lock(), b"first-second-third");
    }

    #[test]
    fn terminal_input_enqueue_does_not_wait_for_a_blocked_writer() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (queue, worker) = spawn_test_input_writer(BlockingWriter {
            output: output.clone(),
            started: Some(started_tx),
            release: release_rx,
        });
        queue.enqueue(b"blocked", || {}).unwrap();
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        queue.enqueue(b"queued", || {}).unwrap();
        assert!(output.lock().is_empty());

        release_tx.send(()).unwrap();
        drop(queue);
        worker.join().unwrap().unwrap();
        assert_eq!(&*output.lock(), b"blockedqueued");
    }

    #[tokio::test]
    async fn confirmed_terminal_input_waits_for_the_writer() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (queue, worker) = spawn_test_input_writer(BlockingWriter {
            output: output.clone(),
            started: Some(started_tx),
            release: release_rx,
        });
        let mut confirmation = queue.enqueue_confirmed(b"wake", || {}).unwrap();
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut confirmation)
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), confirmation)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(&*output.lock(), b"wake");
        drop(queue);
        worker.join().unwrap().unwrap();
    }

    #[tokio::test]
    async fn confirmed_terminal_input_reports_writer_failure() {
        let (queue, worker) = spawn_test_input_writer(FailingWriter);
        let confirmation = queue.enqueue_confirmed(b"wake", || {}).unwrap();

        let error = confirmation.await.unwrap().unwrap_err();
        assert!(error.contains("writer closed"));
        assert!(matches!(
            queue.enqueue(b"later", || {}).unwrap_err(),
            TerminalError::Io(_)
        ));
        drop(queue);
        assert!(worker.join().unwrap().is_err());
    }

    #[test]
    fn terminal_input_queue_rejects_overload_without_accepting_it() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (queue, worker) = spawn_test_input_writer(BlockingWriter {
            output,
            started: Some(started_tx),
            release: release_rx,
        });
        let accepted = AtomicUsize::new(0);
        queue
            .enqueue(b"blocked", || {
                accepted.fetch_add(1, Ordering::Relaxed);
            })
            .unwrap();
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let message = vec![b'x'; MAX_TERMINAL_INPUT_BYTES];
        for _ in 0..TERMINAL_INPUT_QUEUE_BYTES / MAX_TERMINAL_INPUT_BYTES {
            queue
                .enqueue(&message, || {
                    accepted.fetch_add(1, Ordering::Relaxed);
                })
                .unwrap();
        }
        let accepted_before_rejection = accepted.load(Ordering::Relaxed);

        let error = queue
            .enqueue(b"overload", || {
                accepted.fetch_add(1, Ordering::Relaxed);
            })
            .unwrap_err();

        assert!(matches!(error, TerminalError::InputQueueFull));
        assert_eq!(
            error.to_string(),
            "terminal input queue is full; wait for the terminal to catch up"
        );
        assert_eq!(accepted.load(Ordering::Relaxed), accepted_before_rejection);
        release_tx.send(()).unwrap();
        drop(queue);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn terminal_query_responses_bypass_saturated_user_input_queue() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (queue, worker) = spawn_test_input_writer(BlockingWriter {
            output: output.clone(),
            started: Some(started_tx),
            release: release_rx,
        });
        queue.enqueue(b"blocked", || {}).unwrap();
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let message = vec![b'x'; MAX_TERMINAL_INPUT_BYTES];
        for _ in 0..TERMINAL_INPUT_QUEUE_BYTES / MAX_TERMINAL_INPUT_BYTES {
            queue.enqueue(&message, || {}).unwrap();
        }

        let response = queue.enqueue_unobserved(Bytes::from_static(b"RESPONSE"));

        release_tx.send(()).unwrap();
        drop(queue);
        worker.join().unwrap().unwrap();
        response.unwrap();
        assert!(output.lock().starts_with(b"blockedRESPONSE"));
    }

    #[test]
    fn server_terminal_query_response_uses_the_input_writer() {
        let manager = TerminalManager::new(Some("/bin/sh".to_owned()), 1024 * 1024);
        let info = manager
            .create(CreateTerminal {
                path: Some("server-query-response".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/sh".to_owned()),
                clone_from: None,
            })
            .unwrap();
        let session = manager.get(info.id).unwrap();
        let (mut events, _, _, _) = session.subscribe(None, false);
        session
            .write(
                concat!(
                    r#"stty raw -echo; printf '\033[5n'; response=$(dd bs=1 count=4 2>/dev/null); stty sane; if [ "$response" = "$(printf '\033[0n')" ]; then printf '\nSERVER-%s-PASS\n' QUERY; fi"#,
                    "\n"
                )
                .as_bytes(),
            )
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        while Instant::now() < deadline {
            match events.try_recv() {
                Ok(TerminalEvent::Output(chunk)) => {
                    output.extend_from_slice(&chunk.bytes);
                    if output
                        .windows(b"SERVER-QUERY-PASS".len())
                        .any(|window| window == b"SERVER-QUERY-PASS")
                    {
                        break;
                    }
                }
                Ok(_) | Err(broadcast::error::TryRecvError::Empty) => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(broadcast::error::TryRecvError::Closed) => break,
            }
        }

        assert!(
            output
                .windows(b"SERVER-QUERY-PASS".len())
                .any(|window| window == b"SERVER-QUERY-PASS"),
            "shell did not receive the server query response: {}",
            String::from_utf8_lossy(&output)
        );
        assert!(manager.remove(info.id));
    }

    enum ReadStep {
        Interrupted,
        Bytes(&'static [u8]),
        Eof,
    }

    struct ScriptedReader {
        steps: VecDeque<ReadStep>,
    }

    impl Read for ScriptedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            match self.steps.pop_front().unwrap_or(ReadStep::Eof) {
                ReadStep::Interrupted => Err(io::Error::from(io::ErrorKind::Interrupted)),
                ReadStep::Bytes(bytes) => {
                    buffer[..bytes.len()].copy_from_slice(bytes);
                    Ok(bytes.len())
                }
                ReadStep::Eof => Ok(0),
            }
        }
    }

    #[test]
    fn terminal_output_reader_retries_interrupted_reads() {
        let mut reader = ScriptedReader {
            steps: VecDeque::from([
                ReadStep::Interrupted,
                ReadStep::Bytes(b"first "),
                ReadStep::Interrupted,
                ReadStep::Bytes(b"second"),
                ReadStep::Eof,
            ]),
        };
        let mut output = Vec::new();

        read_output_chunks(&mut reader, || {}, |bytes| output.extend_from_slice(&bytes));

        assert_eq!(output, b"first second");
        assert!(reader.steps.is_empty());
    }

    #[test]
    fn terminal_output_reader_gates_every_read_on_flow_control() {
        let mut reader = ScriptedReader {
            steps: VecDeque::from([
                ReadStep::Bytes(b"first "),
                ReadStep::Bytes(b"second"),
                ReadStep::Eof,
            ]),
        };
        let mut gates = 0_usize;
        let mut output = Vec::new();

        read_output_chunks(
            &mut reader,
            || gates += 1,
            |bytes| output.extend_from_slice(&bytes),
        );

        // Every read, including the one that reports end of file. Gating after
        // the read instead would hand over a chunk the browser has no room for.
        assert_eq!(gates, 3);
        assert_eq!(output, b"first second");
    }

    #[test]
    fn terminal_output_reader_keeps_publishes_within_a_frame() {
        let mut reader = io::Cursor::new(vec![b'x'; TERMINAL_OUTPUT_FRAME_BYTES.saturating_add(1)]);
        let mut chunk_sizes = Vec::new();

        read_output_chunks(&mut reader, || {}, |bytes| chunk_sizes.push(bytes.len()));

        assert_eq!(chunk_sizes, [TERMINAL_OUTPUT_FRAME_BYTES, 1]);
    }

    fn attached_flow() -> FlowControlState {
        FlowControlState {
            clients: 1,
            ..FlowControlState::default()
        }
    }

    #[test]
    fn flow_control_pauses_over_the_high_watermark() {
        let mut state = attached_flow();

        state.published(FLOW_CONTROL_HIGH_WATERMARK_BYTES);
        assert!(!state.blocked(), "the watermark itself does not pause");

        state.published(1);
        assert!(state.blocked());
    }

    #[test]
    fn flow_control_holds_until_the_low_watermark_and_not_merely_below_the_high_one() {
        let mut state = attached_flow();
        state.published(FLOW_CONTROL_HIGH_WATERMARK_BYTES + 1);

        // Back under the high watermark but nowhere near drained: resuming here
        // would re-pause on the very next chunk and shred the burst.
        assert!(!state.acknowledged(1));
        assert!(state.blocked());

        let remaining = state.unacknowledged - FLOW_CONTROL_LOW_WATERMARK_BYTES;
        assert!(!state.acknowledged(remaining));
        assert!(state.blocked(), "the low watermark itself keeps the pause");

        assert!(state.acknowledged(1), "resumed under the low watermark");
        assert!(!state.blocked());
    }

    #[test]
    fn flow_control_acknowledgements_cannot_drive_the_window_negative() {
        let mut state = attached_flow();
        state.published(1_000);

        // Several browsers acknowledge the same bytes, so over-acknowledgement
        // is routine rather than an error. VS Code clamps here for the same
        // reason; the counter has to heal instead of wrapping.
        state.acknowledged(50_000);

        assert_eq!(state.unacknowledged, 0);
    }

    #[test]
    fn flow_control_lets_the_quickest_browser_resume_the_terminal() {
        let mut state = attached_flow();
        state.clients = 2;
        state.published(FLOW_CONTROL_HIGH_WATERMARK_BYTES + 1);
        assert!(state.blocked());

        // One counter for the pty means either browser's acknowledgements pay
        // the debt down. A browser slower than that falls behind and recovers
        // through the snapshot path rather than throttling the terminal.
        assert!(state.acknowledged(FLOW_CONTROL_HIGH_WATERMARK_BYTES));
        assert!(!state.blocked());
    }

    #[test]
    fn flow_control_never_pauses_a_terminal_nobody_is_watching() {
        let mut state = FlowControlState::default();

        state.published(FLOW_CONTROL_HIGH_WATERMARK_BYTES * 10);

        // Agents here run unattended for hours. Output that no browser will ever
        // acknowledge must not be allowed to block the process producing it.
        assert!(!state.blocked());
        assert_eq!(state.unacknowledged, 0);
    }

    #[test]
    fn flow_pause_deadline_writes_off_the_debt_of_a_wedged_browser() {
        let flow = FlowControl::default();
        {
            let mut state = flow.state.lock();
            state.clients = 1;
            state.published(FLOW_CONTROL_HIGH_WATERMARK_BYTES + 1);
            assert!(state.blocked());
        }
        let started = Instant::now();
        flow_wait_until_resumed(&flow, Duration::from_millis(50));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a wedged browser must not park the read loop past the deadline"
        );
        let state = flow.state.lock();
        assert!(!state.blocked());
        assert_eq!(state.unacknowledged, 0, "the stale debt is written off");
    }

    #[test]
    fn flow_pause_deadline_extends_while_acknowledgements_make_progress() {
        let flow = std::sync::Arc::new(FlowControl::default());
        {
            let mut state = flow.state.lock();
            state.clients = 1;
            state.published(120_000);
            assert!(state.blocked());
        }
        // An alive browser trickles acknowledgements from another thread. Each
        // one restarts the deadline, so the debt must drain fully through
        // acknowledgements (12 of them) even though draining takes far longer
        // than the initial deadline. A write-off would end the pause early and
        // the browser would get nowhere near 12.
        let acker = {
            let flow = std::sync::Arc::clone(&flow);
            std::thread::spawn(move || {
                let mut acks = 0_u32;
                loop {
                    std::thread::sleep(Duration::from_millis(25));
                    let mut state = flow.state.lock();
                    if !state.blocked() {
                        break;
                    }
                    acks += 1;
                    if state.acknowledged(10_000) {
                        flow.resumed.notify_all();
                    }
                }
                acks
            })
        };
        flow_wait_until_resumed(&flow, Duration::from_millis(250));
        let acks = acker.join().unwrap();
        assert!(
            acks >= 12,
            "the pause must end through acknowledgements, not the write-off (saw {acks})"
        );
        assert_eq!(flow.state.lock().unacknowledged, 0);
    }

    #[test]
    fn flow_control_clears_the_window_when_the_set_of_browsers_changes() {
        let mut state = attached_flow();
        state.published(FLOW_CONTROL_HIGH_WATERMARK_BYTES + 1);
        assert!(state.blocked());

        // An arriving browser cannot acknowledge output sent before it existed,
        // and a departing one takes its outstanding debt with it. Either way the
        // counter is stale, which is what VS Code's clearUnacknowledgedChars is
        // for. Leaving it would pause the pty against nobody.
        state.clear();

        assert!(!state.blocked());
        assert_eq!(state.unacknowledged, 0);
    }

    #[test]
    fn snapshot_subscription_rebases_only_the_acknowledging_clients_flow_debt() {
        let manager = TerminalManager::new(Some("/bin/cat".to_owned()), 1024 * 1024);
        let info = manager
            .create(CreateTerminal {
                path: Some("snapshot-flow-baseline".to_owned()),
                cwd: Some(PathBuf::from("/tmp")),
                shell: Some("/bin/cat".to_owned()),
                clone_from: None,
            })
            .unwrap();
        let session = manager.get(info.id).unwrap();
        session.flow_attach();

        {
            let mut flow = session.flow.state.lock();
            flow.published(FLOW_CONTROL_HIGH_WATERMARK_BYTES + 1);
            assert!(flow.blocked());
        }
        let (_, snapshot, _, _) = session.subscribe(None, true);
        assert_eq!(snapshot.mode, crate::terminal_state::SyncMode::Snapshot);
        assert_eq!(session.flow.state.lock().unacknowledged, 0);

        {
            let mut flow = session.flow.state.lock();
            flow.published(FLOW_CONTROL_HIGH_WATERMARK_BYTES + 1);
        }
        session.subscribe(None, false);
        assert_eq!(
            session.flow.state.lock().unacknowledged,
            FLOW_CONTROL_HIGH_WATERMARK_BYTES + 1,
            "an observer snapshot cannot forgive a real client's debt"
        );

        let (_, baseline, size, _) = session.subscribe(None, true);
        {
            let mut flow = session.flow.state.lock();
            flow.published(FLOW_CONTROL_HIGH_WATERMARK_BYTES + 1);
        }
        let (_, resume, _, _) = session.subscribe(
            Some(TerminalResume {
                sequence: baseline.sequence,
                epoch: size.epoch,
            }),
            true,
        );
        assert_eq!(resume.mode, crate::terminal_state::SyncMode::Resume);
        assert_eq!(
            session.flow.state.lock().unacknowledged,
            FLOW_CONTROL_HIGH_WATERMARK_BYTES + 1,
            "resumed output is acknowledged normally and must remain counted"
        );

        session.flow_detach();
        session.kill();
    }

    #[test]
    fn flow_control_release_opens_the_gate_for_a_parked_reader() {
        let mut state = attached_flow();
        state.published(FLOW_CONTROL_HIGH_WATERMARK_BYTES + 1);
        assert!(state.blocked());

        state.released = true;

        // An exited or killed pty must never leave its read loop parked.
        assert!(!state.blocked());
    }

    fn foreground(group: i32, name: &str) -> ForegroundObservation {
        ForegroundObservation {
            group,
            name: name.to_owned(),
        }
    }

    #[test]
    fn ignores_short_foreground_commands() {
        let mut tracker = ForegroundCommandTracker::default();
        let mut current = None;
        let command = foreground(20, "sleep");

        tracker.refresh(&mut current, Some(&command), false, false, 1_000);
        tracker.refresh(
            &mut current,
            Some(&command),
            false,
            false,
            1_000 + LONG_RUNNING_COMMAND_MILLIS - 1,
        );
        tracker.refresh(&mut current, None, false, false, 7_000);

        assert_eq!(current, None);
    }

    #[test]
    fn reports_long_foreground_commands_and_their_completion() {
        let mut tracker = ForegroundCommandTracker::default();
        let mut current = None;
        let command = foreground(20, "backup");

        tracker.refresh(&mut current, Some(&command), false, false, 1_000);
        tracker.refresh(
            &mut current,
            Some(&command),
            false,
            false,
            1_000 + LONG_RUNNING_COMMAND_MILLIS,
        );
        assert_eq!(
            current,
            Some(ForegroundCommandInfo {
                name: "backup".to_owned(),
                status: ForegroundCommandStatus::Running,
                status_changed_at: 1_000 + LONG_RUNNING_COMMAND_MILLIS,
                started_at: 1_000,
                completed_at: None,
            })
        );

        tracker.refresh(&mut current, None, false, false, 8_000);
        assert_eq!(
            current.as_ref().map(|command| &command.status),
            Some(&ForegroundCommandStatus::Completed)
        );
        assert_eq!(
            current.as_ref().and_then(|command| command.completed_at),
            Some(8_000)
        );
    }

    #[test]
    fn keeps_tuis_live_without_a_timer_or_completion() {
        let mut tracker = ForegroundCommandTracker::default();
        let mut current = None;
        let tui = foreground(20, "btop");

        tracker.refresh(&mut current, Some(&tui), true, false, 1_000);
        assert_eq!(
            current.as_ref().map(|command| &command.status),
            Some(&ForegroundCommandStatus::Live)
        );

        // Once a process group has entered the alternate screen it remains a TUI,
        // including during its exit redraw after it restores the normal screen.
        tracker.refresh(&mut current, Some(&tui), false, false, 20_000);
        assert_eq!(
            current.as_ref().map(|command| &command.status),
            Some(&ForegroundCommandStatus::Live)
        );

        tracker.refresh(&mut current, None, false, false, 21_000);
        assert_eq!(current, None);
    }

    #[test]
    fn suppresses_completion_when_a_running_command_becomes_a_tui() {
        let mut tracker = ForegroundCommandTracker::default();
        let mut current = None;
        let command = foreground(20, "interactive-script");

        tracker.refresh(&mut current, Some(&command), false, false, 1_000);
        tracker.refresh(&mut current, Some(&command), false, false, 6_000);
        tracker.refresh(&mut current, Some(&command), true, false, 7_000);
        assert_eq!(
            current.as_ref().map(|command| &command.status),
            Some(&ForegroundCommandStatus::Live)
        );

        tracker.refresh(&mut current, None, false, false, 8_000);
        assert_eq!(current, None);
    }

    #[test]
    fn tracks_process_groups_across_pipeline_member_changes() {
        let mut tracker = ForegroundCommandTracker::default();
        let mut current = None;
        let first_member = foreground(20, "producer");
        let next_member = foreground(20, "consumer");

        tracker.refresh(&mut current, Some(&first_member), false, false, 1_000);
        tracker.refresh(&mut current, Some(&next_member), false, false, 6_000);

        assert_eq!(
            current.as_ref().map(|command| command.name.as_str()),
            Some("producer")
        );
        assert_eq!(
            current.as_ref().map(|command| &command.status),
            Some(&ForegroundCommandStatus::Running)
        );
    }

    #[test]
    fn replacing_a_command_finishes_the_old_group_and_times_the_new_one() {
        let mut tracker = ForegroundCommandTracker::default();
        let mut current = None;
        let first = foreground(20, "first");
        let second = foreground(30, "second");

        tracker.refresh(&mut current, Some(&first), false, false, 1_000);
        tracker.refresh(&mut current, Some(&first), false, false, 6_000);
        tracker.refresh(&mut current, Some(&second), false, false, 7_000);
        assert_eq!(
            current
                .as_ref()
                .map(|command| (command.name.as_str(), &command.status)),
            Some(("first", &ForegroundCommandStatus::Completed))
        );

        tracker.refresh(&mut current, Some(&second), false, false, 12_000);
        assert_eq!(
            current
                .as_ref()
                .map(|command| (command.name.as_str(), &command.status)),
            Some(("second", &ForegroundCommandStatus::Running))
        );
    }

    #[test]
    fn agent_activity_takes_precedence_over_command_activity() {
        let mut tracker = ForegroundCommandTracker::default();
        let mut current = None;
        let command = foreground(20, "worker");

        tracker.refresh(&mut current, Some(&command), false, false, 1_000);
        tracker.refresh(&mut current, Some(&command), false, false, 6_000);
        tracker.refresh(&mut current, Some(&command), false, true, 7_000);

        assert_eq!(current, None);
        assert!(tracker.candidate.is_none());
    }

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
    fn terminal_size_uses_the_smallest_viewport_until_one_client_is_focused() {
        let desktop = Uuid::from_u128(1);
        let mobile = Uuid::from_u128(2);
        let mut viewports = ClientViewports::default();

        viewports.attach(desktop, Some(TerminalViewport::new(180, 50, 1800, 1000)));
        viewports.attach(mobile, Some(TerminalViewport::new(60, 22, 600, 440)));
        assert_eq!(
            viewports.state(),
            TerminalSizeState {
                cols: 60,
                rows: 22,
                pixel_width: 600,
                pixel_height: 440,
                focused_client: None,
                responder_client: Some(desktop),
                epoch: 0,
            }
        );

        viewports.focus(mobile, true);
        assert_eq!(
            viewports.state(),
            TerminalSizeState {
                cols: 60,
                rows: 22,
                pixel_width: 600,
                pixel_height: 440,
                focused_client: Some(mobile),
                responder_client: Some(mobile),
                epoch: 0,
            }
        );

        viewports.focus(desktop, true);
        assert_eq!(
            viewports.state(),
            TerminalSizeState {
                cols: 180,
                rows: 50,
                pixel_width: 1800,
                pixel_height: 1000,
                focused_client: Some(desktop),
                responder_client: Some(desktop),
                epoch: 0,
            }
        );

        viewports.resize(mobile, TerminalViewport::new(40, 16, 400, 320));
        assert_eq!((viewports.state().cols, viewports.state().rows), (180, 50));

        viewports.detach(desktop);
        assert_eq!(
            viewports.state(),
            TerminalSizeState {
                cols: 40,
                rows: 16,
                pixel_width: 400,
                pixel_height: 320,
                focused_client: None,
                responder_client: Some(mobile),
                epoch: 0,
            }
        );

        viewports.published = viewports.state();
        viewports.detach(mobile);
        assert_eq!(
            viewports.state(),
            TerminalSizeState {
                cols: 40,
                rows: 16,
                pixel_width: 400,
                pixel_height: 320,
                focused_client: None,
                responder_client: None,
                epoch: 0,
            }
        );
    }

    #[test]
    fn terminal_responder_follows_the_client_sending_input() {
        let desktop = Uuid::from_u128(1);
        let mobile = Uuid::from_u128(2);
        let mut viewports = ClientViewports::default();

        viewports.attach(desktop, Some(TerminalViewport::new(180, 50, 1800, 1000)));
        viewports.attach(mobile, Some(TerminalViewport::new(60, 22, 600, 440)));
        viewports.activate(mobile);

        assert_eq!(viewports.state().responder_client, Some(mobile));
        assert_eq!((viewports.state().cols, viewports.state().rows), (60, 22));
        assert_eq!(viewports.state().focused_client, None);
    }

    #[test]
    fn a_released_client_keeps_its_connection_but_stops_constraining_the_size() {
        let visible = Uuid::from_u128(1);
        let cached = Uuid::from_u128(2);
        let mut viewports = ClientViewports::default();

        viewports.attach(visible, Some(TerminalViewport::new(180, 50, 1800, 1000)));
        viewports.attach(cached, Some(TerminalViewport::new(60, 22, 600, 440)));
        viewports.focus(cached, true);
        assert_eq!((viewports.state().cols, viewports.state().rows), (60, 22));

        // Leaving the screen must surrender both the size and the focus that
        // was steering it, or a pane nobody is reading would still be the one
        // the pty is measured against.
        viewports.release(cached);
        assert_eq!(
            viewports.state(),
            TerminalSizeState {
                cols: 180,
                rows: 50,
                pixel_width: 1800,
                pixel_height: 1000,
                focused_client: None,
                responder_client: Some(visible),
                epoch: 0,
            }
        );
        // Still attached: the connection was never closed, so the pane is there
        // to take its size back without resynchronizing.
        assert_eq!(viewports.sizes.len(), 2);

        viewports.resize(cached, TerminalViewport::new(60, 22, 600, 440));
        assert_eq!((viewports.state().cols, viewports.state().rows), (60, 22));
    }

    #[test]
    fn terminal_size_clamps_untrusted_client_dimensions() {
        let client = Uuid::from_u128(1);
        let mut viewports = ClientViewports::default();
        viewports.attach(
            client,
            Some(TerminalViewport::new(0, u16::MAX, u16::MAX, u16::MAX)),
        );

        assert_eq!(
            (
                viewports.state().cols,
                viewports.state().rows,
                viewports.state().pixel_width,
                viewports.state().pixel_height,
            ),
            (2, 300, u16::MAX, u16::MAX)
        );
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
                memory_bytes: 4096,
            };
        let shell = process(10, 1, 10, 20, "bash", 100);
        let child = process(20, 10, 20, 20, "codex", 200);
        let mut tracker = ProcessTracker::default();
        tracker.update(10, &[&shell, &child], None);

        let idle_shell = process(10, 1, 10, 10, "bash", 100);
        tracker.update(10, &[&idle_shell], None);
        let reused = process(20, 10, 20, 20, "btop", 300);
        tracker.update(10, &[&shell, &reused], None);

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

    #[cfg(target_os = "linux")]
    #[test]
    fn process_parent_table_finds_all_nested_descendants() {
        let children = HashMap::from([(10, vec![20, 21]), (20, vec![30]), (30, vec![40])]);
        assert_eq!(
            collect_descendant_pids(&[10], &children),
            HashSet::from([10, 20, 21, 30, 40])
        );
        assert_eq!(
            parse_process_parent("42 (worker with spaces) S 10 42 42 0 -1"),
            Some(10)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn process_tracker_calculates_cpu_usage_between_samples() {
        let process = |cpu_ticks| ProcessInfo {
            pid: 20,
            parent: 10,
            group: 20,
            foreground_group: 20,
            command: "worker".to_owned(),
            arguments: vec!["worker".to_owned()],
            cwd: Some(PathBuf::from("/tmp")),
            start_ticks: 200,
            cpu_ticks,
            memory_bytes: 12 * 1024,
        };
        let first = process(25);
        let second = process(50);
        let mut tracker = ProcessTracker::default();
        tracker.update(
            20,
            &[&first],
            Some(CpuSample {
                total_ticks: 1_000,
                cpu_count: 4,
            }),
        );
        tracker.update(
            20,
            &[&second],
            Some(CpuSample {
                total_ticks: 1_100,
                cpu_count: 4,
            }),
        );

        let record = &tracker.snapshot().processes[0];
        assert_eq!(record.cpu_percent, 100.0);
        assert_eq!(record.memory_bytes, 12 * 1024);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_linux_process_resource_samples() {
        assert_eq!(
            parse_resident_memory_bytes("Name:\tworker\nVmRSS:\t1536 kB\n"),
            Some(1536 * 1024)
        );
        let sample = parse_cpu_sample(
            "cpu  100 2 30 400 5 6 7 8 9 10\ncpu0 1 0 1 1\ncpu1 1 0 1 1\nintr 0\n",
        )
        .unwrap();
        assert_eq!(sample.total_ticks, 558);
        assert_eq!(sample.cpu_count, 2);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn process_signal_revalidates_the_live_identity() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id();
        let snapshot = ProcessSnapshot::read(&[pid]);
        let process_id = snapshot.processes[&pid].identity().label();

        assert!(matches!(
            terminate_descendant_process(pid, &format!("{pid}:0")),
            Err(ProcessSignalError::NotFound)
        ));
        assert!(child.try_wait().unwrap().is_none());

        terminate_descendant_process(pid, &process_id).unwrap();
        assert!(!child.wait().unwrap().success());
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
        assert_eq!(
            command.get_env("TERM_SERVER_ARTIFACTS_DIR"),
            Some(artifacts::root_directory().as_os_str())
        );
    }

    #[test]
    fn bounds_exited_session_retention_and_preserves_running_sessions() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TerminalManager {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            default_shell: RwLock::new(Some("/bin/sh".into())),
            replay_bytes: AtomicUsize::new(1024 * 1024),
            next_exit_order: Arc::new(AtomicU64::new(0)),
            home_directory: directory.path().to_path_buf(),
            agent_event_socket: None,
            executable: None,
        };
        let running = manager
            .create(CreateTerminal {
                path: None,
                cwd: None,
                shell: None,
                clone_from: None,
            })
            .unwrap();
        let running_session = manager.get(running.id).unwrap();
        let mut exited_ids = Vec::with_capacity(MAX_RETAINED_EXITED_SESSIONS + 1);
        let mut first_weak = None;

        for index in 0..=MAX_RETAINED_EXITED_SESSIONS {
            let info = manager
                .create(CreateTerminal {
                    path: None,
                    cwd: None,
                    shell: None,
                    clone_from: None,
                })
                .unwrap();
            let session = manager.get(info.id).unwrap();
            if index == 0 {
                first_weak = Some(Arc::downgrade(&session));
            }
            session.write(b"exit\n").unwrap();
            let exited = (0..100).find(|_| {
                let status = manager
                    .get(info.id)
                    .map(|candidate| candidate.info().status);
                if status == Some(TerminalStatus::Exited) {
                    true
                } else {
                    thread::sleep(Duration::from_millis(10));
                    false
                }
            });
            assert!(exited.is_some(), "terminal {id} did not exit", id = info.id);
            exited_ids.push(info.id);
        }
        drop(running_session);

        assert!(manager.get(exited_ids[0]).is_none());
        assert!(
            manager
                .list()
                .into_iter()
                .filter(|info| info.status == TerminalStatus::Exited)
                .count()
                <= MAX_RETAINED_EXITED_SESSIONS
        );
        assert_eq!(
            manager.get(running.id).unwrap().info().status,
            TerminalStatus::Running
        );

        let first_weak = first_weak.expect("first exited session was not captured");
        let released = (0..100).any(|_| {
            if first_weak.upgrade().is_none() {
                true
            } else {
                thread::sleep(Duration::from_millis(10));
                false
            }
        });
        assert!(
            released,
            "evicted exited session still retains PTY resources"
        );

        manager.remove(running.id);
        for id in exited_ids {
            manager.remove(id);
        }
    }

    #[test]
    fn starts_writes_resizes_and_retains_an_exited_terminal() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TerminalManager {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            default_shell: RwLock::new(Some("/bin/sh".into())),
            replay_bytes: AtomicUsize::new(1024 * 1024),
            next_exit_order: Arc::new(AtomicU64::new(0)),
            home_directory: directory.path().to_path_buf(),
            agent_event_socket: None,
            executable: None,
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
        session
            .attach(client_id, Some(TerminalViewport::new(80, 24, 800, 480)))
            .unwrap();
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
        let exited = (0..100).find_map(|_| {
            let next = manager.get(info.id)?.info();
            if next.status == TerminalStatus::Exited {
                Some(next)
            } else {
                thread::sleep(std::time::Duration::from_millis(10));
                None
            }
        });
        let exited = exited.unwrap();
        assert_eq!(exited.exit_code, Some(0));
        assert_eq!(
            manager.get(info.id).unwrap().info().status,
            TerminalStatus::Exited
        );
        assert!(manager.remove(info.id));
        assert!(!manager.remove(info.id));
        assert!(manager.remove(clone.id));
        assert!(manager.list().is_empty());
    }

    #[test]
    fn native_events_feed_existing_agent_transitions_without_extra_revisions() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TerminalManager {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            default_shell: RwLock::new(Some("/bin/sh".into())),
            replay_bytes: AtomicUsize::new(1024 * 1024),
            next_exit_order: Arc::new(AtomicU64::new(0)),
            home_directory: directory.path().to_path_buf(),
            agent_event_socket: None,
            executable: None,
        };
        let info = manager
            .create(CreateTerminal {
                path: None,
                cwd: None,
                shell: None,
                clone_from: None,
            })
            .unwrap();
        let pi = Arc::new(PiService::new(directory.path()));

        for (kind, label) in [
            (AgentEventKind::Thinking, "thinking"),
            (AgentEventKind::RunningCommand, "running a command"),
        ] {
            assert!(manager.apply_agent_event(
                info.id,
                AgentEvent {
                    provider: "codex".to_owned(),
                    kind,
                    sequence: None,
                    title: None,
                    transcript_only: false,
                    transcript_reset: false,
                    transcript: Vec::new(),
                },
                pi.clone(),
            ));
            let agent = manager.get(info.id).unwrap().info().agent.unwrap();
            assert_eq!(agent.status, AgentStatus::Working);
            assert_eq!(agent.revision, 1);
            assert_eq!(agent.activity.unwrap().label, label);
        }

        let session = manager.get(info.id).unwrap();
        let mut activity = session.activity.lock();
        let updated_at = activity.native_updated_at;
        assert!(!activity.expire_native_state(updated_at + NATIVE_EVENT_FRESH_MILLIS));
        assert!(activity.expire_native_state(updated_at + NATIVE_EVENT_FRESH_MILLIS + 1));
        assert!(activity.native_status.is_none());
        drop(activity);

        manager.get(info.id).unwrap().write(b"true\n").unwrap();
        let fallback = manager.get(info.id).unwrap().info().agent.unwrap();
        assert_eq!(fallback.status, AgentStatus::Working);
        assert_eq!(fallback.revision, 1);
        assert!(fallback.activity.is_none());

        assert!(manager.apply_agent_event(
            info.id,
            AgentEvent {
                provider: "codex".to_owned(),
                kind: AgentEventKind::Completed,
                sequence: None,
                title: None,
                transcript_only: false,
                transcript_reset: false,
                transcript: Vec::new(),
            },
            pi.clone(),
        ));
        let ready = manager.get(info.id).unwrap().info().agent.unwrap();
        assert_eq!(ready.status, AgentStatus::Idle);
        assert_eq!(ready.revision, 2);
        assert!(ready.completed_at.is_some());
        assert!(ready.activity.is_none());

        assert!(manager.apply_agent_event(
            info.id,
            AgentEvent {
                provider: "codex".to_owned(),
                kind: AgentEventKind::Closed,
                sequence: None,
                title: None,
                transcript_only: false,
                transcript_reset: false,
                transcript: Vec::new(),
            },
            pi,
        ));
        let closed = manager.get(info.id).unwrap().info().agent.unwrap();
        assert_eq!(closed.status, AgentStatus::Closed);
        assert_eq!(closed.revision, 3);
        assert!(closed.activity.is_none());
        assert!(manager.remove(info.id));
    }

    #[test]
    fn sequenced_native_events_ignore_stale_reports_and_reset_for_new_sources() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TerminalManager {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            default_shell: RwLock::new(Some("/bin/sh".into())),
            replay_bytes: AtomicUsize::new(1024 * 1024),
            next_exit_order: Arc::new(AtomicU64::new(0)),
            home_directory: directory.path().to_path_buf(),
            agent_event_socket: None,
            executable: None,
        };
        let info = manager
            .create(CreateTerminal {
                path: None,
                cwd: None,
                shell: None,
                clone_from: None,
            })
            .unwrap();
        let pi = Arc::new(PiService::new(directory.path()));
        let event = |provider: &str, kind: AgentEventKind, sequence: Option<u64>| AgentEvent {
            provider: provider.to_owned(),
            kind,
            sequence,
            title: None,
            transcript_only: false,
            transcript_reset: false,
            transcript: Vec::new(),
        };
        let apply = |provider, kind, sequence| {
            manager.apply_agent_event(info.id, event(provider, kind, sequence), pi.clone())
        };
        let agent = || manager.get(info.id).unwrap().info().agent.unwrap();

        // Legacy unsequenced sources remain usable until they establish
        // sequence authority.
        assert!(apply("codex", AgentEventKind::Thinking, None));
        assert!(apply("codex", AgentEventKind::Completed, None));
        assert_eq!(agent().status, AgentStatus::Idle);

        assert!(apply("omp", AgentEventKind::Thinking, Some(10)));
        assert!(apply("omp", AgentEventKind::Completed, Some(12)));
        assert!(apply("omp", AgentEventKind::Thinking, Some(13)));
        let working = agent();
        assert_eq!(working.status, AgentStatus::Working);

        // A delayed completion and a duplicate sequence cannot finish the
        // newer turn.
        assert!(apply("omp", AgentEventKind::Completed, Some(12)));
        assert_eq!(agent().status, AgentStatus::Working);
        assert!(apply("omp", AgentEventKind::Completed, Some(13)));
        assert_eq!(agent().status, AgentStatus::Working);
        assert_eq!(agent().revision, working.revision);

        assert!(apply("omp", AgentEventKind::Completed, Some(14)));
        assert_eq!(agent().status, AgentStatus::Idle);

        // Taking over with another provider starts a fresh sequence domain.
        assert!(apply("codex", AgentEventKind::Thinking, Some(1)));
        assert!(apply("omp", AgentEventKind::Thinking, Some(1)));
        assert_eq!(agent().status, AgentStatus::Working);
        assert!(manager.remove(info.id));
    }

    #[test]
    fn clearing_native_lifecycle_allows_a_fresh_sequence_source() {
        let mut activity = SessionActivity::default();
        assert!(activity.accept_native_sequence("omp", Some(9)));
        assert!(!activity.accept_native_sequence("omp", Some(9)));
        assert!(!activity.accept_native_sequence("omp", None));

        activity.clear_native_sequence();
        assert!(activity.accept_native_sequence("omp", Some(1)));
    }

    #[test]
    fn omp_title_is_adopted_and_suppresses_term_server_generation() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TerminalManager {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            default_shell: RwLock::new(Some("/bin/sh".into())),
            replay_bytes: AtomicUsize::new(1024 * 1024),
            next_exit_order: Arc::new(AtomicU64::new(0)),
            home_directory: directory.path().to_path_buf(),
            agent_event_socket: None,
            executable: None,
        };
        let info = manager
            .create(CreateTerminal {
                path: None,
                cwd: None,
                shell: None,
                clone_from: None,
            })
            .unwrap();
        let pi = Arc::new(PiService::new(directory.path()));

        // omp forwards its own conversation title alongside a lifecycle event.
        assert!(manager.apply_agent_event(
            info.id,
            AgentEvent {
                provider: "omp".to_owned(),
                kind: AgentEventKind::Thinking,
                sequence: None,
                title: Some("checkout latency fix".to_owned()),
                transcript_only: false,
                transcript_reset: false,
                transcript: Vec::new(),
            },
            pi,
        ));

        let session = manager.get(info.id).unwrap();
        let activity = session.activity.lock();
        assert_eq!(
            activity.generated_title.as_deref(),
            Some("checkout latency fix")
        );
        // term-server must not queue or await its own title once omp has supplied one.
        assert!(activity.pending_title_prompt.is_none());
        assert!(activity.title_in_flight_revision.is_none());
        drop(activity);
        assert_eq!(session.info().name, "checkout latency fix");
        assert!(manager.remove(info.id));
    }

    #[test]
    fn retained_agent_transcript_survives_terminal_exit_and_pages() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new(Some("/bin/true".to_owned()), 1024 * 1024);
        let info = manager
            .create(CreateTerminal {
                path: Some("closed-history".to_owned()),
                cwd: Some(directory.path().to_path_buf()),
                shell: Some("/bin/true".to_owned()),
                clone_from: None,
            })
            .unwrap();
        for _ in 0..50 {
            if manager.get(info.id).unwrap().info().status == TerminalStatus::Exited {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            manager.get(info.id).unwrap().info().status,
            TerminalStatus::Exited
        );
        let pi = Arc::new(PiService::new(directory.path()));
        assert!(manager.apply_agent_event(
            info.id,
            AgentEvent {
                provider: "omp".to_owned(),
                kind: AgentEventKind::Thinking,
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
                    crate::history::AgentTranscriptInput {
                        kind: AgentTranscriptKind::ToolResult,
                        source_id: Some("tool-1".to_owned()),
                        timestamp: Some(3),
                        role: None,
                        name: Some("bash".to_owned()),
                        text: Some("done".to_owned()),
                        data: None,
                        truncated: false,
                    },
                ],
            },
            pi,
        ));

        let session = manager.get(info.id).unwrap();
        let first = session.transcript(None, 2, &[]).unwrap();
        assert_eq!(first.records.len(), 2);
        assert!(first.has_more);
        let second = session
            .transcript(Some(first.next_sequence), 2, &[])
            .unwrap();
        assert_eq!(second.records.len(), 1);
        assert_eq!(second.records[0].text.as_deref(), Some("done"));
        assert!(!second.has_more);
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
            memory_bytes: 0,
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
        assert_eq!(
            agent_kind(&process("/home/user/.local/bin/omp", &["omp"])).as_deref(),
            Some("omp")
        );
        assert_eq!(
            agent_kind(&process("/home/user/.local/bin/hermes", &["hermes"])).as_deref(),
            Some("hermes")
        );
        assert_eq!(
            agent_kind(&process(
                "python",
                &["python", "/opt/hermes-agent/venv/bin/hermes"]
            ))
            .as_deref(),
            Some("hermes")
        );
    }

    #[test]
    fn labels_interpreted_scripts_without_exposing_their_arguments() {
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
            memory_bytes: 0,
        };

        assert_eq!(
            process_program(&process(
                "bash",
                &["bash", "/work/nightly-backup.sh", "--token=secret"]
            )),
            "nightly-backup"
        );
        assert_eq!(
            process_program(&process(
                "python3",
                &["python3", "/work/report.py", "--customer", "private"]
            )),
            "report"
        );
        assert_eq!(
            process_program(&process("bash", &["bash", "-c", "private command text"])),
            "bash"
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
    fn ignores_agent_startup_activity_until_a_task_is_submitted() {
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "codex",
                current_status: AgentStatus::Idle,
                reported_state: Some((ReportedAgentState::Working, 1_000)),
                now: 1_000,
                input_submitted_at: 0,
                resumed_after_completion: false,
                active_samples: 3,
                quiet_samples: 0,
            }),
            AgentStatus::Idle
        );
    }

    #[test]
    fn restores_tasks_submitted_before_agent_discovery() {
        assert_eq!(
            initial_agent_state(Some((ReportedAgentState::Working, 1_010)), 1_020, 1, None,),
            InitialAgentState {
                status: AgentStatus::Idle,
                revision: 1,
                input_submitted_at: 0,
                completed_at: None,
            }
        );
        assert_eq!(
            initial_agent_state(None, 1_020, 1, Some(1_000)),
            InitialAgentState {
                status: AgentStatus::Working,
                revision: 2,
                input_submitted_at: 1_000,
                completed_at: None,
            }
        );
        assert_eq!(
            initial_agent_state(
                Some((ReportedAgentState::Idle, 1_010)),
                1_020,
                1,
                Some(1_000),
            ),
            InitialAgentState {
                status: AgentStatus::Idle,
                revision: 3,
                input_submitted_at: 0,
                completed_at: Some(1_020),
            }
        );
    }

    #[test]
    fn debounces_fallback_activity_and_invalidates_stale_idle_signals() {
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "codex",
                current_status: AgentStatus::Idle,
                reported_state: None,
                now: 20_000,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 1,
                quiet_samples: 0,
            }),
            AgentStatus::Idle
        );
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "codex",
                current_status: AgentStatus::Idle,
                reported_state: None,
                now: 20_000,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 2,
                quiet_samples: 0,
            }),
            AgentStatus::Idle
        );
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "codex",
                current_status: AgentStatus::Idle,
                reported_state: None,
                now: 20_000,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 3,
                quiet_samples: 0,
            }),
            AgentStatus::Working
        );
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "codex",
                current_status: AgentStatus::Working,
                reported_state: None,
                now: 20_000,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 0,
                quiet_samples: 4,
            }),
            AgentStatus::Working
        );
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "codex",
                current_status: AgentStatus::Working,
                reported_state: None,
                now: 20_000,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 0,
                quiet_samples: 5,
            }),
            AgentStatus::Idle
        );
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "codex",
                current_status: AgentStatus::Idle,
                reported_state: Some((ReportedAgentState::Idle, 900)),
                now: 1_050,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 0,
                quiet_samples: 0,
            }),
            AgentStatus::Working
        );
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "codex",
                current_status: AgentStatus::Working,
                reported_state: Some((ReportedAgentState::Idle, 1_010)),
                now: 1_050,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 2,
                quiet_samples: 0,
            }),
            AgentStatus::Idle
        );
    }

    #[test]
    fn settles_pi_after_two_quiet_samples() {
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "pi",
                current_status: AgentStatus::Working,
                reported_state: None,
                now: 5_000,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 0,
                quiet_samples: 1,
            }),
            AgentStatus::Working
        );
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "pi",
                current_status: AgentStatus::Working,
                reported_state: None,
                now: 5_000,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 0,
                quiet_samples: 2,
            }),
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
    fn keeps_generated_titles_anchored_to_the_initial_task() {
        let mut activity = SessionActivity::default();
        activity.queue_title_for_submission(
            &AgentStatus::Working,
            Some("approve the command".to_owned()),
        );
        assert_eq!(activity.pending_title_prompt, None);

        activity.queue_title_for_submission(&AgentStatus::Idle, Some("/model".to_owned()));
        assert_eq!(activity.pending_title_prompt, None);
        assert_eq!(activity.initial_title_prompt, None);

        activity.queue_title_for_submission(
            &AgentStatus::Idle,
            Some("fix checkout latency".to_owned()),
        );
        assert_eq!(
            activity.pending_title_prompt,
            Some((1, "fix checkout latency".to_owned()))
        );

        activity.queue_title_for_submission(&AgentStatus::Idle, Some("update".to_owned()));
        assert_eq!(
            activity.pending_title_prompt,
            Some((1, "fix checkout latency".to_owned()))
        );

        activity.pending_title_prompt = None;
        activity.queue_title_for_submission(&AgentStatus::Idle, Some("update".to_owned()));
        assert_eq!(
            activity.pending_title_prompt,
            Some((2, "fix checkout latency".to_owned()))
        );

        activity.pending_title_prompt = None;
        activity.generated_title = Some("checkout latency fix".to_owned());
        activity
            .queue_title_for_submission(&AgentStatus::Idle, Some("add payment retries".to_owned()));
        assert_eq!(activity.pending_title_prompt, None);
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

    #[test]
    fn ignores_terminal_control_replies_in_agent_prompts() {
        let mut capture = PromptCapture::default();
        assert_eq!(
            capture.observe(b"\x1b]10;rgb:ffff/ffff/ffff\x07"),
            PromptInput::default()
        );
        assert_eq!(
            capture.observe(b"\x1b]11;rgb:0000/0000"),
            PromptInput::default()
        );
        assert_eq!(capture.observe(b"/0000\x1b\\"), PromptInput::default());
        assert_eq!(
            capture.observe(b"\x1bP1$r0m\x1b\\fix incorrect terminal title\r"),
            PromptInput {
                submitted: true,
                prompt: Some("fix incorrect terminal title".to_owned()),
            }
        );
    }

    fn detection(state: agent_detection::DetectedState, rule: &str) -> agent_detection::Detection {
        agent_detection::Detection {
            state,
            skip_state_update: false,
            visible_idle: false,
            visible_blocker: false,
            visible_working: false,
            matched_rule: Some(agent_detection::MatchedRule {
                id: rule.to_owned(),
                priority: 100,
                region: "whole_recent".to_owned(),
                state,
            }),
            fallback_reason: None,
        }
    }

    #[test]
    fn screen_detection_applies_blocked_and_working_from_any_matched_rule() {
        use agent_detection::DetectedState;

        assert_eq!(
            screen_detection_outcome(Some(&detection(DetectedState::Blocked, "weak_blocker"))),
            DetectionOutcome::Status(AgentStatus::Blocked)
        );
        assert_eq!(
            screen_detection_outcome(Some(&detection(DetectedState::Working, "spinner"))),
            DetectionOutcome::Status(AgentStatus::Working)
        );
    }

    #[test]
    fn screen_detection_only_applies_idle_from_visible_evidence() {
        use agent_detection::DetectedState;

        // A weak idle match must not pull a working agent to idle; the CPU and
        // output heuristics stay in charge.
        assert_eq!(
            screen_detection_outcome(Some(&detection(DetectedState::Idle, "weak_idle"))),
            DetectionOutcome::Undecided
        );

        let mut visible = detection(DetectedState::Idle, "live_prompt_box");
        visible.visible_idle = true;
        assert_eq!(
            screen_detection_outcome(Some(&visible)),
            DetectionOutcome::Status(AgentStatus::Idle)
        );
    }

    #[test]
    fn screen_detection_holds_the_current_status_for_overlays_and_defers_without_a_match() {
        use agent_detection::DetectedState;

        let mut overlay = detection(DetectedState::Unknown, "transcript_viewer");
        overlay.skip_state_update = true;
        assert_eq!(
            screen_detection_outcome(Some(&overlay)),
            DetectionOutcome::Keep
        );

        // Unknown without the skip flag still means "not showing the agent".
        assert_eq!(
            screen_detection_outcome(Some(&detection(DetectedState::Unknown, "menu"))),
            DetectionOutcome::Keep
        );

        // The engine's no-rule-matched idle fallback must not decide anything.
        let fallback = agent_detection::Detection {
            state: DetectedState::Idle,
            skip_state_update: false,
            visible_idle: false,
            visible_blocker: false,
            visible_working: false,
            matched_rule: None,
            fallback_reason: Some(agent_detection::DEFAULT_KNOWN_AGENT_IDLE_FALLBACK.to_owned()),
        };
        assert_eq!(
            screen_detection_outcome(Some(&fallback)),
            DetectionOutcome::Undecided
        );
        assert_eq!(screen_detection_outcome(None), DetectionOutcome::Undecided);
    }

    #[test]
    fn codex_action_required_title_reports_blocked() {
        let mut signals = TerminalSignals::default();
        signals.observe(b"\x1b]0;\xe2\x9c\xb3 Action Required\x07", 1_000);
        assert_eq!(
            signals.agent_state,
            Some((ReportedAgentState::Blocked, 1_000))
        );
        assert_eq!(signals.osc_title(), "✳ Action Required");

        // The idle marker on its own stays idle.
        signals.observe(b"\x1b]0;\xe2\x9c\xb3 Codex\x07", 2_000);
        assert_eq!(signals.agent_state, Some((ReportedAgentState::Idle, 2_000)));
    }

    #[test]
    fn native_connector_signal_is_authoritative_over_screen_detection() {
        use agent_detection::DetectedState;

        // A connector reporting Working wins over a visible-idle screen rule:
        // an agent driving subagents reports itself as working even when its
        // own TUI looks idle.
        let mut idle_screen = detection(DetectedState::Idle, "live_prompt_box");
        idle_screen.visible_idle = true;
        assert_eq!(
            resolve_agent_status(
                Some(AgentStatus::Working),
                Some(&idle_screen),
                StatusFallback {
                    agent_kind: "omp",
                    current_status: AgentStatus::Idle,
                    reported_state: None,
                    now: 5_000,
                    input_submitted_at: 1_000,
                    resumed_after_completion: false,
                    active_samples: 0,
                    quiet_samples: 5,
                },
            ),
            AgentStatus::Working
        );

        // Symmetric: a connector reporting Idle wins over a working screen rule.
        let working_screen = detection(DetectedState::Working, "spinner");
        assert_eq!(
            resolve_agent_status(
                Some(AgentStatus::Idle),
                Some(&working_screen),
                StatusFallback {
                    agent_kind: "codex",
                    current_status: AgentStatus::Working,
                    reported_state: None,
                    now: 5_000,
                    input_submitted_at: 1_000,
                    resumed_after_completion: false,
                    active_samples: 3,
                    quiet_samples: 0,
                },
            ),
            AgentStatus::Idle
        );

        // A connector Blocked wins even when the screen holds an overlay that
        // would otherwise Keep the previous status.
        let mut overlay = detection(DetectedState::Unknown, "transcript_viewer");
        overlay.skip_state_update = true;
        assert_eq!(
            resolve_agent_status(
                Some(AgentStatus::Blocked),
                Some(&overlay),
                StatusFallback {
                    agent_kind: "claude",
                    current_status: AgentStatus::Working,
                    reported_state: None,
                    now: 5_000,
                    input_submitted_at: 1_000,
                    resumed_after_completion: false,
                    active_samples: 0,
                    quiet_samples: 0,
                },
            ),
            AgentStatus::Blocked
        );
    }

    #[test]
    fn resolve_agent_status_falls_back_to_screen_then_heuristics_without_a_connector() {
        use agent_detection::DetectedState;

        // No connector signal: a screen Blocked rule decides.
        let blocked_screen = detection(DetectedState::Blocked, "permission_prompt");
        assert_eq!(
            resolve_agent_status(
                None,
                Some(&blocked_screen),
                StatusFallback {
                    agent_kind: "codex",
                    current_status: AgentStatus::Working,
                    reported_state: None,
                    now: 5_000,
                    input_submitted_at: 1_000,
                    resumed_after_completion: false,
                    active_samples: 0,
                    quiet_samples: 0,
                },
            ),
            AgentStatus::Blocked
        );

        // No connector signal, screen Undecided: the OSC reported state and
        // CPU/output heuristics decide, exactly as before.
        assert_eq!(
            resolve_agent_status(
                None,
                None,
                StatusFallback {
                    agent_kind: "pi",
                    current_status: AgentStatus::Working,
                    reported_state: None,
                    now: 5_000,
                    input_submitted_at: 1_000,
                    resumed_after_completion: false,
                    active_samples: 0,
                    quiet_samples: 2,
                },
            ),
            AgentStatus::Idle
        );
    }

    #[test]
    fn osc_payloads_are_retained_with_original_case_and_bounded() {
        let mut signals = TerminalSignals::default();
        signals.observe(b"\x1b]2;Claude Code\x07", 1_000);
        signals.observe(b"\x1b]9;4;3;40\x07", 1_000);
        assert_eq!(signals.osc_title(), "Claude Code");
        assert_eq!(signals.osc_progress(), "4;3;40");

        // An empty title payload is a clear.
        signals.observe(b"\x1b]0;\x07", 2_000);
        assert_eq!(signals.osc_title(), "");
        assert_eq!(signals.osc_progress(), "4;3;40");

        let long = format!("\x1b]0;{}\x07", "t".repeat(OSC_PAYLOAD_MAX_CHARS * 2));
        signals.observe(long.as_bytes(), 3_000);
        assert_eq!(signals.osc_title().chars().count(), OSC_PAYLOAD_MAX_CHARS);

        signals.clear_detection_payloads();
        assert_eq!(signals.osc_title(), "");
        assert_eq!(signals.osc_progress(), "");
    }

    #[test]
    fn reported_blocked_state_wins_over_activity_heuristics() {
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "codex",
                current_status: AgentStatus::Working,
                reported_state: Some((ReportedAgentState::Blocked, 2_000)),
                now: 20_000,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 5,
                quiet_samples: 0,
            }),
            AgentStatus::Blocked
        );
        // A blocked report from before the current submission is stale.
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "codex",
                current_status: AgentStatus::Working,
                reported_state: Some((ReportedAgentState::Blocked, 500)),
                now: 20_000,
                input_submitted_at: 1_000,
                resumed_after_completion: false,
                active_samples: 5,
                quiet_samples: 0,
            }),
            AgentStatus::Working
        );
    }

    #[test]
    fn approval_events_block_the_agent_until_it_moves_on() {
        let directory = tempfile::tempdir().unwrap();
        let manager = TerminalManager {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            default_shell: RwLock::new(Some("/bin/sh".into())),
            replay_bytes: AtomicUsize::new(1024 * 1024),
            next_exit_order: Arc::new(AtomicU64::new(0)),
            home_directory: directory.path().to_path_buf(),
            agent_event_socket: None,
            executable: None,
        };
        let info = manager
            .create(CreateTerminal {
                path: None,
                cwd: None,
                shell: None,
                clone_from: None,
            })
            .unwrap();
        let pi = Arc::new(PiService::new(directory.path()));

        let event = |kind| AgentEvent {
            provider: "claude".to_owned(),
            kind,
            sequence: None,
            title: None,
            transcript_only: false,
            transcript_reset: false,
            transcript: Vec::new(),
        };

        assert!(manager.apply_agent_event(info.id, event(AgentEventKind::Thinking), pi.clone()));
        let working = manager.get(info.id).unwrap().info().agent.unwrap();
        assert_eq!(working.status, AgentStatus::Working);

        assert!(manager.apply_agent_event(
            info.id,
            event(AgentEventKind::WaitingForApproval),
            pi.clone(),
        ));
        let blocked = manager.get(info.id).unwrap().info().agent.unwrap();
        assert_eq!(blocked.status, AgentStatus::Blocked);
        assert_eq!(
            blocked.activity.as_ref().unwrap().label,
            "waiting for approval"
        );

        // A block has no repeat events to refresh it, so the freshness timer
        // must not quietly relabel a waiting agent as idle.
        let session = manager.get(info.id).unwrap();
        let mut activity = session.activity.lock();
        let updated_at = activity.native_updated_at;
        assert!(!activity.expire_native_state(updated_at + NATIVE_EVENT_FRESH_MILLIS * 10));
        assert_eq!(activity.native_status, Some(AgentStatus::Blocked));
        // The turn's submission survives the block.
        assert!(activity.input_submitted_at > 0);
        drop(activity);
        drop(session);

        assert!(manager.apply_agent_event(info.id, event(AgentEventKind::Thinking), pi.clone()));
        assert_eq!(
            manager.get(info.id).unwrap().info().agent.unwrap().status,
            AgentStatus::Working
        );
    }

    #[test]
    fn omp_title_glyphs_report_state() {
        let mut signals = TerminalSignals::default();
        signals.observe("\x1b]0;π ⠙ Implement task\x07".as_bytes(), 100);
        assert_eq!(
            signals.agent_state,
            Some((ReportedAgentState::Working, 100))
        );

        signals.observe("\x1b]0;π > Implement task\x07".as_bytes(), 200);
        assert_eq!(signals.agent_state, Some((ReportedAgentState::Idle, 200)));

        signals.observe("\x1b]0;π ⸼ Implement task\x07".as_bytes(), 300);
        assert_eq!(
            signals.agent_state,
            Some((ReportedAgentState::Working, 300))
        );
    }

    #[test]
    fn resumed_agent_trusts_a_fresh_spinner_title_without_a_new_prompt() {
        // After a completed task the agent resumes on its own; the live
        // spinner title outranks the submission gate.
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "omp",
                current_status: AgentStatus::Idle,
                reported_state: Some((ReportedAgentState::Working, 10_400)),
                now: 10_500,
                input_submitted_at: 0,
                resumed_after_completion: true,
                active_samples: 0,
                quiet_samples: 0,
            }),
            AgentStatus::Working
        );
        // A stale working report means the spinner stopped animating.
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "omp",
                current_status: AgentStatus::Idle,
                reported_state: Some((ReportedAgentState::Working, 1_000)),
                now: 10_500,
                input_submitted_at: 0,
                resumed_after_completion: true,
                active_samples: 0,
                quiet_samples: 0,
            }),
            AgentStatus::Idle
        );
        // Before any completed task the startup gate still applies.
        assert_eq!(
            select_agent_status(StatusFallback {
                agent_kind: "omp",
                current_status: AgentStatus::Idle,
                reported_state: Some((ReportedAgentState::Working, 10_400)),
                now: 10_500,
                input_submitted_at: 0,
                resumed_after_completion: false,
                active_samples: 0,
                quiet_samples: 0,
            }),
            AgentStatus::Idle
        );
    }
}
