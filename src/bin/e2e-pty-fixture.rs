use base64::Engine as _;
use serde_json::{Map, Value, json};
use std::env;
use std::fs::{File, OpenOptions, create_dir_all};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use uuid::Uuid;
const TRANSCRIPT_VERSION: u64 = 1;
const QUERY_COUNT: usize = 6;
const QUERY_NAMES: [&str; QUERY_COUNT] = [
    "cursor",
    "mode",
    "identity",
    "window_size",
    "window_pixels",
    "cell_pixels",
];
const MAX_BYTE_SEQUENCE: usize = 64 * 1024;
const MAX_CAPTURE_BYTES: usize = 64 * 1024;
const MAX_KITTY_STACK_POP: usize = 16;
const MAX_ARTIFACT_FILENAME_BYTES: usize = 128;
const MAX_ARTIFACT_TEXT_BYTES: usize = 64 * 1024;
const MAX_KITTY_FLAGS: u16 = u16::MAX;
const MAX_GENERATED_BYTES: usize = 64 * 1024 * 1024;
const MAX_LINE_WIDTH: usize = 64 * 1024;
const MAX_INPUT_LINE_BYTES: usize = 256 * 1024;
const MAX_QUERY_ESCAPE_BYTES: usize = 4 * 1024;
const MAX_ESCAPE_DELAY_MS: u64 = 60_000;

fn main() {
    let output = Arc::new(SharedOutput::new());
    output.record(
        "start",
        json!({"transcript_version": TRANSCRIPT_VERSION, "pid": std::process::id()}),
    );
    let _raw_mode = match install_raw_mode() {
        Ok(guard) => guard,
        Err(error) => {
            output.record(
                "error",
                json!({"operation": "raw_mode", "kind": io_error_kind(&error)}),
            );
            None
        }
    };

    let runtime = Arc::new(RuntimeState::new());
    spawn_winch_listener(Arc::clone(&output), Arc::clone(&runtime));
    let query = Arc::new(QueryTracker::new());
    let (commands_tx, commands_rx) = mpsc::channel();
    let reader_output = Arc::clone(&output);
    let reader_runtime = Arc::clone(&runtime);
    let reader_query = Arc::clone(&query);
    thread::spawn(move || read_protocol(commands_tx, reader_output, reader_runtime, reader_query));

    let (exit_code, reason) = run_commands(
        commands_rx,
        Arc::clone(&output),
        Arc::clone(&runtime),
        query,
    );
    runtime.request_stop();
    output.record("exit", json!({"code": exit_code, "reason": reason}));
    std::process::exit(exit_code);
}

struct SharedOutput {
    inner: Mutex<OutputInner>,
}
struct OutputInner {
    stdout: io::Stdout,
    transcript: Transcript,
    event_sequence: u64,
    write_sequence: u64,
}

impl SharedOutput {
    fn new() -> Self {
        Self {
            inner: Mutex::new(OutputInner {
                stdout: io::stdout(),
                transcript: Transcript::from_environment(),
                event_sequence: 0,
                write_sequence: 0,
            }),
        }
    }

    fn record(&self, event: &str, fields: Value) {
        lock_unpoisoned(&self.inner).record(event, fields);
    }

    fn write_chunk(&self, bytes: &[u8]) -> bool {
        let mut inner = lock_unpoisoned(&self.inner);
        if let Err(error) = inner
            .stdout
            .write_all(bytes)
            .and_then(|_| inner.stdout.flush())
        {
            inner.record(
                "error",
                json!({"operation": "write", "kind": io_error_kind(&error), "bytes": bytes.len()}),
            );
            return false;
        }
        inner.write_sequence = inner.write_sequence.saturating_add(1);
        let write_sequence = inner.write_sequence;
        inner.record(
            "write",
            json!({
                "write_sequence": write_sequence,
                "chunk": write_sequence,
                "chunk_index": write_sequence,
                "bytes": bytes.len(),
                "data_base64": base64::engine::general_purpose::STANDARD.encode(bytes),
                "text": String::from_utf8(bytes.to_vec()).ok(),
            }),
        );
        true
    }

    fn marker(&self, operation: &str, fields: &[String]) -> bool {
        self.write_chunk(&marker_bytes_with_fields(operation, fields))
    }

    fn error(&self, raw: &[u8], reason: &str) {
        self.record(
            "error",
            json!({
                "operation": "command",
                "reason": reason,
                "command_base64": base64::engine::general_purpose::STANDARD.encode(raw),
            }),
        );
        self.marker(
            "ERROR",
            &[
                reason.to_owned(),
                base64::engine::general_purpose::STANDARD.encode(raw),
            ],
        );
    }
}

impl OutputInner {
    fn record(&mut self, event: &str, fields: Value) {
        let mut object = match fields {
            Value::Object(object) => object,
            _ => Map::new(),
        };
        self.event_sequence = self.event_sequence.saturating_add(1);
        object.insert("version".to_owned(), json!(TRANSCRIPT_VERSION));
        object.insert("sequence".to_owned(), json!(self.event_sequence));
        object.insert("event".to_owned(), json!(event));
        self.transcript.write(&Value::Object(object));
    }
}

struct Transcript {
    writer: Option<io::BufWriter<File>>,
}
impl Transcript {
    fn from_environment() -> Self {
        let Some(directory) = env::var_os("TERM_SERVER_FIXTURE_TRANSCRIPT_DIR") else {
            return Self { writer: None };
        };
        let Some(session) = env::var_os("TERM_SERVER_SESSION") else {
            return Self { writer: None };
        };
        let session = session.to_string_lossy();
        if session.is_empty()
            || !session
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            eprintln!("e2e-pty-fixture: TERM_SERVER_SESSION is not filename-safe");
            return Self { writer: None };
        }
        let directory = Path::new(&directory);
        if let Err(error) = create_dir_all(directory) {
            eprintln!(
                "e2e-pty-fixture: could not create transcript directory: {}",
                io_error_kind(&error)
            );
            return Self { writer: None };
        }
        let path = directory.join(format!("{session}.jsonl"));
        match OpenOptions::new().create(true).append(true).open(path) {
            Ok(file) => Self {
                writer: Some(io::BufWriter::new(file)),
            },
            Err(error) => {
                eprintln!(
                    "e2e-pty-fixture: could not create transcript: {}",
                    io_error_kind(&error)
                );
                Self { writer: None }
            }
        }
    }

    fn write(&mut self, value: &Value) {
        let Some(writer) = self.writer.as_mut() else {
            return;
        };
        let result = (|| -> io::Result<()> {
            serde_json::to_writer(&mut *writer, value)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
            writer.write_all(b"\n")?;
            writer.flush()
        })();
        if let Err(error) = result {
            eprintln!(
                "e2e-pty-fixture: transcript write failed: {}",
                io_error_kind(&error)
            );
            self.writer = None;
        }
    }
}

struct RuntimeState {
    stopping: AtomicBool,
    winch_sequence: AtomicU64,
    hold: Mutex<Option<String>>,
    hold_changed: Condvar,
}
impl RuntimeState {
    fn new() -> Self {
        Self {
            stopping: AtomicBool::new(false),
            winch_sequence: AtomicU64::new(0),
            hold: Mutex::new(None),
            hold_changed: Condvar::new(),
        }
    }
    fn request_stop(&self) {
        self.stopping.store(true, Ordering::Release);
        self.hold_changed.notify_all();
    }
    fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }
    fn wait_if_held(&self) {
        let mut hold = lock_unpoisoned(&self.hold);
        while hold.is_some() && !self.is_stopping() {
            hold = match self.hold_changed.wait(hold) {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
    }
    fn begin_hold(&self, token: String) -> bool {
        let mut hold = lock_unpoisoned(&self.hold);
        if hold.is_some() {
            return false;
        }
        *hold = Some(token);
        true
    }
    fn release(&self, token: &str) -> bool {
        let mut hold = lock_unpoisoned(&self.hold);
        if hold.as_deref() != Some(token) {
            return false;
        }
        *hold = None;
        self.hold_changed.notify_all();
        true
    }
}

struct QueryTracker {
    active: Mutex<Option<QuerySession>>,
}
struct QuerySession {
    id: String,
    replies: usize,
    expected: usize,
    kind: QueryKind,
}
#[derive(Clone, Copy)]
enum QueryKind {
    Standard,
    Kitty,
}
impl QueryTracker {
    fn new() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }
    fn begin(&self, id: String) -> bool {
        self.begin_with(id, QueryKind::Standard, QUERY_COUNT)
    }
    fn begin_kitty(&self, id: String) -> bool {
        self.begin_with(id, QueryKind::Kitty, 1)
    }
    fn begin_with(&self, id: String, kind: QueryKind, expected: usize) -> bool {
        let mut active = lock_unpoisoned(&self.active);
        if active.is_some() {
            return false;
        }
        *active = Some(QuerySession {
            id,
            replies: 0,
            expected,
            kind,
        });
        true
    }
    fn is_active(&self) -> bool {
        lock_unpoisoned(&self.active).is_some()
    }
    fn capture(&self, response: Vec<u8>, output: &SharedOutput) -> bool {
        let (id, index, complete, expected, kind) = {
            let mut active = lock_unpoisoned(&self.active);
            let Some(session) = active.as_mut() else {
                return false;
            };
            if matches!(session.kind, QueryKind::Kitty) && !is_kitty_keyboard_reply(&response) {
                return false;
            }
            let index = session.replies;
            session.replies = session.replies.saturating_add(1);
            let complete = session.replies >= session.expected;
            let id = session.id.clone();
            let expected = session.expected;
            let kind = session.kind;
            if complete {
                *active = None;
            }
            (id, index, complete, expected, kind)
        };
        match kind {
            QueryKind::Standard => {
                output.record(
                    "query_reply",
                    json!({
                        "id": id.clone(),
                        "index": index,
                        "name": QUERY_NAMES.get(index).copied().unwrap_or("additional"),
                        "bytes": response.len(),
                        "raw_base64": base64::engine::general_purpose::STANDARD.encode(&response),
                    }),
                );
                if complete {
                    output.marker(
                        "QUERY",
                        &[id.clone(), "COMPLETE".to_owned(), expected.to_string()],
                    );
                    output.record("query_complete", json!({"id": id, "replies": expected}));
                }
            }
            QueryKind::Kitty => {
                output.record("kitty_reply", json!({
                    "id": id.clone(),
                    "payload_base64": base64::engine::general_purpose::STANDARD.encode(&response),
                }));
                if complete {
                    output.marker("KITTY", &[id, "COMPLETE".to_owned()]);
                }
            }
        }
        true
    }
    fn abort(&self, raw: &[u8], output: &SharedOutput, reason: &str) {
        let session = lock_unpoisoned(&self.active).take();
        if let Some(session) = session {
            output.record(
                "query_incomplete",
                json!({
                    "id": session.id,
                    "replies": session.replies,
                    "reason": reason,
                }),
            );
        }
        output.error(raw, reason);
    }
    fn finish(&self, output: &SharedOutput) {
        let session = lock_unpoisoned(&self.active).take();
        if let Some(session) = session {
            output.record(
                "query_incomplete",
                json!({"id": session.id, "replies": session.replies}),
            );
        }
    }
}

#[derive(Debug)]
struct Command {
    raw: Vec<u8>,
    kind: CommandKind,
}
#[derive(Debug)]
enum CommandKind {
    Ready(String),
    Print {
        id: String,
        text: String,
    },
    Size(String),
    Winch {
        id: String,
        sequence: u64,
        rows: Option<u16>,
        cols: Option<u16>,
    },
    Burst {
        id: String,
        bytes: usize,
        line_width: usize,
    },
    Repaint {
        id: String,
        bytes: usize,
    },
    AltEnter(Option<String>),
    AltExit(Option<String>),
    SyncBegin(Option<String>),
    SyncEnd(Option<String>),
    Cursor {
        id: String,
        row: u16,
        col: u16,
    },
    Colors(String),
    Margins {
        id: String,
        top: u16,
        bottom: u16,
    },
    Origin {
        id: String,
        enabled: bool,
    },
    Wrap {
        id: String,
        enabled: bool,
    },
    Erase {
        id: String,
        mode: EraseMode,
    },
    Utf8Split {
        id: String,
        text: String,
        split: usize,
    },
    EscapeSplit {
        id: String,
        sequence: Vec<u8>,
        split: usize,
    },
    EscapeDelay {
        id: String,
        sequence: Vec<u8>,
        split: usize,
        delay_ms: u64,
    },
    Query(String),
    Bytes {
        id: String,
        bytes: Vec<u8>,
    },
    QueryBytes {
        id: String,
        reply_bytes: usize,
        bytes: Vec<u8>,
    },
    CaptureInput {
        id: String,
        bytes: usize,
    },
    Artifact {
        id: String,
        filename: String,
        text: String,
    },
    Kitty {
        id: String,
        action: KittyAction,
    },
    Mouse {
        id: String,
        action: MouseAction,
    },
    EchoStart(String),
    EchoImmediate {
        id: String,
        text: String,
    },
    EchoPayload {
        id: String,
        bytes: Vec<u8>,
    },
    Hold(String),
    Release(String),
    Exit(i32),
    Malformed(String),
    InputEof,
}
#[derive(Debug, Clone, Copy)]
enum EraseMode {
    Display,
    Scrollback,
    Line,
}
#[derive(Debug, Clone, Copy)]
enum KittyAction {
    Set(u16),
    Push(u16),
    Pop(usize),
    Query,
    Reset,
}
#[derive(Debug, Clone, Copy)]
enum MouseAction {
    Enable(MouseMode),
    Disable(MouseMode),
}
#[derive(Debug, Clone, Copy)]
enum MouseMode {
    Button,
    Drag,
    Any,
    Sgr,
}
impl CommandKind {
    fn name(&self) -> &'static str {
        match self {
            Self::Ready(_) => "READY",
            Self::Print { .. } => "PRINT",
            Self::Size(_) => "SIZE",
            Self::Winch { .. } => "WINCH",
            Self::Burst { .. } => "BURST",
            Self::Repaint { .. } => "REPAINT",
            Self::AltEnter(_) => "ALT_ENTER",
            Self::AltExit(_) => "ALT_EXIT",
            Self::SyncBegin(_) => "SYNC_BEGIN",
            Self::SyncEnd(_) => "SYNC_END",
            Self::Cursor { .. } => "CURSOR",
            Self::Colors(_) => "COLORS",
            Self::Margins { .. } => "MARGINS",
            Self::Origin { .. } => "ORIGIN",
            Self::Wrap { .. } => "WRAP",
            Self::Erase { .. } => "ERASE",
            Self::Utf8Split { .. } => "UTF8_SPLIT",
            Self::EscapeSplit { .. } => "ESCAPE_SPLIT",
            Self::EscapeDelay { .. } => "ESCAPE_DELAY",
            Self::Query(_) => "QUERY",
            Self::Bytes { .. } => "BYTES",
            Self::QueryBytes { .. } => "QUERY_BYTES",
            Self::CaptureInput { .. } => "CAPTURE_INPUT",
            Self::Artifact { .. } => "ARTIFACT",
            Self::Kitty { .. } => "KITTY",
            Self::Mouse { .. } => "MOUSE",
            Self::EchoStart(_) | Self::EchoImmediate { .. } | Self::EchoPayload { .. } => {
                "ECHO_INPUT"
            }
            Self::Hold(_) => "HOLD",
            Self::Release(_) => "RELEASE",
            Self::Exit(_) => "EXIT",
            Self::Malformed(_) => "MALFORMED",
            Self::InputEof => "EOF",
        }
    }
}

fn read_protocol(
    commands: Sender<Command>,
    output: Arc<SharedOutput>,
    runtime: Arc<RuntimeState>,
    query: Arc<QueryTracker>,
) {
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let mut parser = InputParser {
        line: Vec::new(),
        line_overflowed: false,
        query_escape: Vec::new(),
        echo_pending: None,
        capture: None,
        commands,
        output: Arc::clone(&output),
        runtime: Arc::clone(&runtime),
        query: Arc::clone(&query),
    };
    let mut bytes = [0_u8; 4096];
    loop {
        if runtime.is_stopping() {
            break;
        }
        match stdin.read(&mut bytes) {
            Ok(0) => {
                parser.finish();
                query.finish(&output);
                runtime.request_stop();
                let _ = parser.commands.send(Command {
                    raw: Vec::new(),
                    kind: CommandKind::InputEof,
                });
                break;
            }
            Ok(count) => {
                for byte in &bytes[..count] {
                    parser.push(*byte);
                    if runtime.is_stopping() {
                        break;
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                output.record(
                    "error",
                    json!({"operation": "read", "kind": io_error_kind(&error)}),
                );
                parser.finish();
                query.finish(&output);
                runtime.request_stop();
                let _ = parser.commands.send(Command {
                    raw: Vec::new(),
                    kind: CommandKind::InputEof,
                });
                break;
            }
        }
    }
}

struct InputCapture {
    id: String,
    expected: usize,
    bytes: Vec<u8>,
}
const KITTY_ENTER_SEQUENCE: &[u8] = b"\x1b[13u";

struct InputParser {
    line: Vec<u8>,
    line_overflowed: bool,
    query_escape: Vec<u8>,
    echo_pending: Option<String>,
    capture: Option<InputCapture>,
    commands: Sender<Command>,
    output: Arc<SharedOutput>,
    runtime: Arc<RuntimeState>,
    query: Arc<QueryTracker>,
}
impl InputParser {
    fn push(&mut self, byte: u8) {
        if let Some(capture) = self.capture.as_mut() {
            capture.bytes.push(byte);
            if capture.bytes.len() == capture.expected {
                let Some(capture) = self.capture.take() else {
                    return;
                };
                self.complete_capture(capture);
            }
            return;
        }
        if !self.query_escape.is_empty() {
            self.query_escape.push(byte);
            if is_complete_csi(&self.query_escape) {
                let response = std::mem::take(&mut self.query_escape);
                if !self.query.capture(response.clone(), &self.output) {
                    self.append_line(&response);
                }
            } else if self.query_escape.len() > MAX_QUERY_ESCAPE_BYTES {
                let response = std::mem::take(&mut self.query_escape);
                self.query
                    .abort(&response, &self.output, "query-escape-exceeds-limit");
            }
            return;
        }
        if self.query.is_active() && self.line.is_empty() && byte == 0x1b {
            self.query_escape.push(byte);
            return;
        }
        if byte == b'\n' || byte == b'\r' {
            let line = std::mem::take(&mut self.line);
            let line_overflowed = std::mem::replace(&mut self.line_overflowed, false);
            self.process_line(line, line_overflowed);
        } else {
            self.append_line(std::slice::from_ref(&byte));
            if self.line.ends_with(KITTY_ENTER_SEQUENCE) {
                self.line
                    .truncate(self.line.len() - KITTY_ENTER_SEQUENCE.len());
                let line = std::mem::take(&mut self.line);
                let line_overflowed = std::mem::replace(&mut self.line_overflowed, false);
                self.process_line(line, line_overflowed);
            }
        }
    }
    fn process_line(&mut self, line: Vec<u8>, line_overflowed: bool) {
        if self.runtime.is_stopping() {
            return;
        }
        if line_overflowed {
            self.echo_pending = None;
            self.send(Command {
                raw: line,
                kind: CommandKind::Malformed("line-exceeds-limit".to_owned()),
            });
            return;
        }
        if let Some(id) = self.echo_pending.take() {
            self.send(Command {
                raw: line.clone(),
                kind: CommandKind::EchoPayload { id, bytes: line },
            });
            return;
        }
        if line.is_empty() {
            return;
        }
        let command = parse_command(&line);
        if let CommandKind::EchoStart(id) = &command.kind {
            self.echo_pending = Some(id.clone());
            self.send(command);
        } else if let CommandKind::Release(id) = command.kind {
            self.release_immediately(&line, id);
        } else if let CommandKind::CaptureInput { id, bytes } = &command.kind {
            self.arm_capture(id.clone(), *bytes);
            self.send(command);
        } else if let CommandKind::QueryBytes {
            id, reply_bytes, ..
        } = &command.kind
        {
            self.arm_capture(id.clone(), *reply_bytes);
            self.send(command);
        } else {
            self.send(command);
        }
    }
    fn append_line(&mut self, bytes: &[u8]) {
        if self.line_overflowed {
            return;
        }
        let remaining = MAX_INPUT_LINE_BYTES.saturating_sub(self.line.len());
        if bytes.len() > remaining {
            if remaining > 0 {
                self.line.extend_from_slice(&bytes[..remaining]);
            }
            self.line_overflowed = true;
        } else {
            self.line.extend_from_slice(bytes);
        }
    }
    fn arm_capture(&mut self, id: String, expected: usize) {
        self.output.record(
            "capture_input",
            json!({"id": id.clone(), "phase": "armed", "bytes": expected}),
        );
        self.output
            .marker("CAPTURE_INPUT", &[id.clone(), "ARMED".to_owned()]);
        self.capture = Some(InputCapture {
            id,
            expected,
            bytes: Vec::with_capacity(expected),
        });
    }
    fn complete_capture(&self, capture: InputCapture) {
        let payload_base64 = base64::engine::general_purpose::STANDARD.encode(&capture.bytes);
        self.output.record(
            "capture_input",
            json!({
                "id": capture.id.clone(),
                "phase": "complete",
                "bytes": capture.bytes.len(),
                "payload_base64": payload_base64,
            }),
        );
        self.output
            .marker("CAPTURE_INPUT", &[capture.id, "COMPLETE".to_owned()]);
    }
    fn finish(&mut self) {
        if self.line_overflowed {
            let line = std::mem::take(&mut self.line);
            self.line_overflowed = false;
            self.process_line(line, true);
        }
        let Some(capture) = self.capture.take() else {
            return;
        };
        let payload_base64 = base64::engine::general_purpose::STANDARD.encode(&capture.bytes);
        self.output.record(
            "error",
            json!({
                "operation": "CAPTURE_INPUT",
                "reason": "capture-input-incomplete",
                "id": capture.id.clone(),
                "bytes": capture.bytes.len(),
                "expected_bytes": capture.expected,
                "payload_base64": payload_base64,
            }),
        );
        self.output
            .marker("CAPTURE_INPUT", &[capture.id, "ERROR".to_owned()]);
    }
    fn release_immediately(&self, raw: &[u8], token: String) {
        self.output.record("command", json!({"operation": "RELEASE", "command_base64": base64::engine::general_purpose::STANDARD.encode(raw)}));
        if self.runtime.release(&token) {
            self.output
                .record("release", json!({"token": token.clone()}));
            self.output.marker("RELEASE", &[token]);
        } else {
            self.output.error(raw, "release-token-not-held");
        }
    }
    fn send(&self, command: Command) {
        if self.commands.send(command).is_err() {
            self.runtime.request_stop();
        }
    }
}

fn run_commands(
    commands: Receiver<Command>,
    output: Arc<SharedOutput>,
    runtime: Arc<RuntimeState>,
    query: Arc<QueryTracker>,
) -> (i32, &'static str) {
    while let Ok(command) = commands.recv() {
        if matches!(&command.kind, CommandKind::InputEof) {
            return (0, "eof");
        }
        if runtime.is_stopping() {
            return (0, "stopped");
        }
        output.record("command", json!({"operation": command.kind.name(), "command_base64": base64::engine::general_purpose::STANDARD.encode(&command.raw)}));
        if !matches!(
            &command.kind,
            CommandKind::Hold(_) | CommandKind::Malformed(_)
        ) {
            runtime.wait_if_held();
            if runtime.is_stopping() {
                return (0, "stopped");
            }
        }
        match execute(command, &output, &runtime, &query) {
            Execution::Continue => {}
            Execution::Exit(code) => return (code, "selected"),
        }
    }
    (0, "eof")
}
enum Execution {
    Continue,
    Exit(i32),
}

fn execute(
    command: Command,
    output: &SharedOutput,
    runtime: &RuntimeState,
    query: &QueryTracker,
) -> Execution {
    let raw = command.raw;
    match command.kind {
        CommandKind::Ready(id) => {
            output.record("ready", json!({"id": id.clone()}));
            output.marker("READY", &[id]);
        }
        CommandKind::Print { id, text } => {
            output.record("print", json!({"id": id.clone(), "text": text.clone()}));
            output.marker("PRINT", &[id, text]);
        }
        CommandKind::Size(id) => match read_pty_size() {
            Ok(size) => {
                output.record("size", json!({"id": id.clone(), "rows": size.rows, "cols": size.cols, "pixel_width": size.pixel_width, "pixel_height": size.pixel_height, "source": "ioctl"}));
                output.marker("SIZE", &[id, size.rows.to_string(), size.cols.to_string()]);
            }
            Err(error) => output.error(&raw, &format!("size-{}", io_error_kind(&error))),
        },
        CommandKind::Winch {
            id,
            sequence,
            rows,
            cols,
        } => {
            let actual = read_pty_size().ok();
            let rows = rows.or_else(|| actual.map(|size| size.rows));
            let cols = cols.or_else(|| actual.map(|size| size.cols));
            let (Some(rows), Some(cols)) = (rows, cols) else {
                output.error(&raw, "winch-size-unavailable");
                return Execution::Continue;
            };
            output.record("sigwinch", json!({"id": id.clone(), "signal_sequence": sequence, "rows": rows, "cols": cols, "source": "command", "actual_rows": actual.map(|size| size.rows), "actual_cols": actual.map(|size| size.cols)}));
            output.marker(
                "WINCH",
                &[id, sequence.to_string(), rows.to_string(), cols.to_string()],
            );
        }
        CommandKind::Burst {
            id,
            bytes,
            line_width,
        } => {
            output.record(
                "burst",
                json!({"id": id, "bytes": bytes, "line_width": line_width}),
            );
            output.write_chunk(&burst_bytes(bytes, line_width));
        }
        CommandKind::Repaint { id, bytes } => {
            output.record("repaint", json!({"id": id, "bytes": bytes}));
            output.write_chunk(&repaint_bytes(&id, bytes));
        }
        CommandKind::AltEnter(id) => {
            let mut data = b"\x1b[?1049h\x1b[2J\x1b[H".to_vec();
            data.extend_from_slice(&marker_bytes("ALT_ENTER", id.as_deref()));
            output.record("alt_enter", json!({"id": id}));
            output.write_chunk(&data);
        }
        CommandKind::AltExit(id) => {
            let mut data = b"\x1b[?1049l".to_vec();
            data.extend_from_slice(&marker_bytes("ALT_EXIT", id.as_deref()));
            output.record("alt_exit", json!({"id": id}));
            output.write_chunk(&data);
        }
        CommandKind::SyncBegin(id) => {
            let mut data = b"\x1b[?2026h".to_vec();
            data.extend_from_slice(&marker_bytes("SYNC_BEGIN", id.as_deref()));
            output.record("sync_begin", json!({"id": id}));
            output.write_chunk(&data);
        }
        CommandKind::SyncEnd(id) => {
            let mut data = b"\x1b[?2026l".to_vec();
            data.extend_from_slice(&marker_bytes("SYNC_END", id.as_deref()));
            output.record("sync_end", json!({"id": id}));
            output.write_chunk(&data);
        }
        CommandKind::Cursor { id, row, col } => {
            let mut data = format!("\x1b[{row};{col}H").into_bytes();
            data.extend_from_slice(&marker_bytes_with_fields(
                "CURSOR",
                &[id.clone(), row.to_string(), col.to_string()],
            ));
            output.record("cursor", json!({"id": id, "row": row, "col": col}));
            output.write_chunk(&data);
        }
        CommandKind::Colors(id) => {
            let data = format!("\x1b[38;5;196m[E2E:COLORS:{}:INDEXED]\x1b[0m\x1b[38;2;12;164;232m[E2E:COLORS:{}:TRUECOLOR]\x1b[0m\n", visible_field(&id), visible_field(&id)).into_bytes();
            output.record(
                "colors",
                json!({"id": id, "indexed": 196, "truecolor": [12, 164, 232]}),
            );
            output.write_chunk(&data);
        }
        CommandKind::Margins { id, top, bottom } => {
            let mut data = format!("\x1b[{top};{bottom}r").into_bytes();
            data.extend_from_slice(&marker_bytes_with_fields(
                "MARGINS",
                &[id.clone(), top.to_string(), bottom.to_string()],
            ));
            output.record("margins", json!({"id": id, "top": top, "bottom": bottom}));
            output.write_chunk(&data);
        }
        CommandKind::Origin { id, enabled } => {
            let mode = if enabled { 'h' } else { 'l' };
            let mut data = format!("\x1b[?6{mode}").into_bytes();
            data.extend_from_slice(&marker_bytes_with_fields(
                "ORIGIN",
                &[
                    id.clone(),
                    if enabled {
                        "on".to_owned()
                    } else {
                        "off".to_owned()
                    },
                ],
            ));
            output.record("origin", json!({"id": id, "enabled": enabled}));
            output.write_chunk(&data);
        }
        CommandKind::Wrap { id, enabled } => {
            let mode = if enabled { 'h' } else { 'l' };
            let mut data = format!("\x1b[?7{mode}").into_bytes();
            data.extend_from_slice(&marker_bytes_with_fields(
                "WRAP",
                &[
                    id.clone(),
                    if enabled {
                        "on".to_owned()
                    } else {
                        "off".to_owned()
                    },
                ],
            ));
            output.record("wrap", json!({"id": id, "enabled": enabled}));
            output.write_chunk(&data);
        }
        CommandKind::Erase { id, mode } => {
            let (sequence, mode_name) = match mode {
                EraseMode::Display => ("\x1b[2J\x1b[H", "display"),
                EraseMode::Scrollback => ("\x1b[3J\x1b[2J\x1b[H", "scrollback"),
                EraseMode::Line => ("\x1b[2K\x1b[1G", "line"),
            };
            let mut data = sequence.as_bytes().to_vec();
            data.extend_from_slice(&marker_bytes_with_fields(
                "ERASE",
                &[id.clone(), mode_name.to_owned()],
            ));
            output.record("erase", json!({"id": id, "mode": mode_name}));
            output.write_chunk(&data);
        }
        CommandKind::Utf8Split { id, text, split } => {
            let bytes = text.as_bytes();
            output.record(
                "utf8_split",
                json!({"id": id, "text": text, "split": split, "bytes": bytes.len()}),
            );
            output.write_chunk(&bytes[..split]);
            output.write_chunk(&bytes[split..]);
        }
        CommandKind::EscapeSplit {
            id,
            sequence,
            split,
        } => {
            output.record("escape_split", json!({"id": id.clone(), "split": split, "bytes": sequence.len(), "sequence_base64": base64::engine::general_purpose::STANDARD.encode(&sequence)}));
            output.write_chunk(&sequence[..split]);
            output.write_chunk(&sequence[split..]);
            output.marker("ESCAPE_SPLIT", &[id]);
        }
        CommandKind::EscapeDelay {
            id,
            sequence,
            split,
            delay_ms,
        } => {
            output.write_chunk(&sequence[..split]);
            output.record(
                "escape_delay",
                json!({
                    "id": id.clone(),
                    "phase": "prefix",
                    "split": split,
                    "bytes": sequence.len(),
                    "delay_ms": delay_ms,
                    "sequence_base64": base64::engine::general_purpose::STANDARD.encode(&sequence),
                }),
            );
            thread::sleep(Duration::from_millis(delay_ms));
            output.write_chunk(&sequence[split..]);
            output.record(
                "escape_delay",
                json!({
                    "id": id.clone(),
                    "phase": "complete",
                    "split": split,
                    "bytes": sequence.len(),
                    "delay_ms": delay_ms,
                }),
            );
            output.marker("ESCAPE_DELAY", &[id]);
        }
        CommandKind::Query(id) => {
            if query.begin(id.clone()) {
                let requests: [(&str, &[u8]); QUERY_COUNT] = [
                    ("cursor", b"\x1b[6n"),
                    ("mode", b"\x1b[?25$p"),
                    ("identity", b"\x1b[c"),
                    ("window_size", b"\x1b[18t"),
                    ("window_pixels", b"\x1b[14t"),
                    ("cell_pixels", b"\x1b[16t"),
                ];
                for (name, request) in requests {
                    output.record("query", json!({"id": id.clone(), "name": name, "request_base64": base64::engine::general_purpose::STANDARD.encode(request)}));
                    output.write_chunk(request);
                }
            } else {
                output.error(&raw, "query-already-active");
            }
        }
        CommandKind::Bytes { id, bytes } => {
            let payload_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            output.record(
                "bytes",
                json!({"id": id.clone(), "bytes": bytes.len(), "payload_base64": payload_base64}),
            );
            output.write_chunk(&bytes);
            output.marker("BYTES", &[id, "EMIT".to_owned()]);
        }
        CommandKind::QueryBytes { id, bytes, .. } => {
            let payload_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            output.record(
                "bytes",
                json!({"id": id.clone(), "bytes": bytes.len(), "payload_base64": payload_base64}),
            );
            output.write_chunk(&bytes);
            output.marker("BYTES", &[id, "EMIT".to_owned()]);
        }
        CommandKind::Artifact { id, filename, text } => match create_artifact(&filename, &text) {
            Ok(path) => {
                output.record("artifact", json!({"id": id.clone(), "filename": filename, "path": path.display().to_string()}));
                output.marker("ARTIFACT", &[id, "COMPLETE".to_owned()]);
            }
            Err(reason) => output.error(&raw, &reason),
        },
        CommandKind::CaptureInput { .. } => {}
        CommandKind::Kitty { id, action } => {
            let sequence = kitty_sequence(action);
            let action_name = kitty_action_name(action);
            let sequence_base64 = base64::engine::general_purpose::STANDARD.encode(&sequence);
            let mut fields = Map::new();
            fields.insert("id".to_owned(), json!(id.clone()));
            fields.insert("action".to_owned(), json!(action_name));
            if let Some(value) = kitty_action_value(action) {
                fields.insert("value".to_owned(), json!(value));
            }
            fields.insert("sequence_base64".to_owned(), json!(sequence_base64));
            output.record("kitty", Value::Object(fields));
            if matches!(action, KittyAction::Query) && !query.begin_kitty(id.clone()) {
                output.error(&raw, "kitty-query-already-active");
            }
            output.write_chunk(&sequence);
            output.marker("KITTY", &[id, action_name.to_ascii_uppercase()]);
        }
        CommandKind::Mouse { id, action } => {
            let sequence = mouse_sequence(action);
            let action_name = mouse_action_name(action);
            let mode_name = mouse_mode_name(mouse_action_mode(action));
            output.record(
                "mouse",
                json!({
                    "id": id.clone(),
                    "action": action_name,
                    "mode": mode_name,
                    "sequence_base64": base64::engine::general_purpose::STANDARD.encode(&sequence),
                }),
            );
            output.write_chunk(&sequence);
            output.marker("MOUSE", &[id, action_name.to_ascii_uppercase()]);
        }
        CommandKind::EchoStart(id) => {
            output.record("echo_input", json!({"id": id.clone(), "phase": "armed"}));
            output.marker("ECHO_INPUT", &[id, "READY".to_owned()]);
        }
        CommandKind::EchoImmediate { id, text } => {
            output.record(
                "echo_input",
                json!({"id": id.clone(), "phase": "payload", "text": text.clone()}),
            );
            output.marker("ECHO_INPUT", &[id, text]);
        }
        CommandKind::EchoPayload { id, bytes } => {
            output.record("echo_input", json!({"id": id.clone(), "phase": "payload", "bytes": bytes.len(), "payload_base64": base64::engine::general_purpose::STANDARD.encode(&bytes)}));
            output.marker(
                "ECHO_INPUT",
                &[id, base64::engine::general_purpose::STANDARD.encode(bytes)],
            );
        }
        CommandKind::Hold(token) => {
            if runtime.begin_hold(token.clone()) {
                output.record("hold", json!({"token": token.clone()}));
                output.marker("HOLD", &[token]);
            } else {
                output.error(&raw, "hold-already-active");
            }
        }
        CommandKind::Exit(code) => {
            output.record("exit_requested", json!({"code": code}));
            output.marker("EXIT", &[code.to_string()]);
            runtime.request_stop();
            return Execution::Exit(code);
        }
        CommandKind::Malformed(reason) => output.error(&raw, &reason),
        CommandKind::Release(_) | CommandKind::InputEof => return Execution::Exit(0),
    }
    Execution::Continue
}

fn parse_command(raw: &[u8]) -> Command {
    let Ok(line) = std::str::from_utf8(raw) else {
        return Command {
            raw: raw.to_vec(),
            kind: CommandKind::Malformed("invalid-utf8".to_owned()),
        };
    };
    let mut op_and_rest = line.splitn(2, |c: char| c.is_ascii_whitespace());
    let op = op_and_rest.next().unwrap_or("").to_ascii_uppercase();
    let rest = op_and_rest
        .next()
        .unwrap_or("")
        .trim_start_matches(|c: char| c.is_ascii_whitespace());
    let kind = match op.as_str() {
        "READY" => one_id(rest).map(CommandKind::Ready),
        "PRINT" => parse_print(rest),
        "SIZE" => one_id(rest).map(CommandKind::Size),
        "WINCH" => parse_winch(rest),
        "BURST" => parse_burst(rest),
        "REPAINT" => parse_repaint(rest),
        "ALT_ENTER" => optional_id(rest).map(CommandKind::AltEnter),
        "ALT_EXIT" => optional_id(rest).map(CommandKind::AltExit),
        "SYNC_BEGIN" => optional_id(rest).map(CommandKind::SyncBegin),
        "SYNC_END" => optional_id(rest).map(CommandKind::SyncEnd),
        "CURSOR" => parse_cursor(rest),
        "COLORS" => one_id(rest).map(CommandKind::Colors),
        "MARGINS" => parse_margins(rest),
        "ORIGIN" => parse_mode(rest).map(|(id, enabled)| CommandKind::Origin { id, enabled }),
        "WRAP" => parse_mode(rest).map(|(id, enabled)| CommandKind::Wrap { id, enabled }),
        "ERASE" => parse_erase(rest),
        "UTF8_SPLIT" => parse_utf8_split(rest),
        "ESCAPE_SPLIT" => parse_escape_split(rest),
        "ESCAPE_DELAY" => parse_escape_delay(rest),
        "QUERY" => one_id(rest).map(CommandKind::Query),
        "BYTES" => parse_bytes(rest),
        "QUERY_BYTES" => parse_query_bytes(rest),
        "CAPTURE_INPUT" => parse_capture_input(rest),
        "ARTIFACT" => parse_artifact(rest),
        "KITTY" => parse_kitty(rest),
        "MOUSE" => parse_mouse(rest),
        "ECHO_INPUT" => parse_echo(rest),
        "HOLD" => one_id(rest).map(CommandKind::Hold),
        "RELEASE" => one_id(rest).map(CommandKind::Release),
        "EXIT" => parse_exit(rest),
        "" => Err("empty-command".to_owned()),
        _ => Err(format!("unknown-command-{op}")),
    }
    .unwrap_or_else(CommandKind::Malformed);
    Command {
        raw: raw.to_vec(),
        kind,
    }
}
fn one_id(rest: &str) -> Result<String, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 1 || tokens[0].is_empty() {
        return Err("expected-one-id".to_owned());
    }
    Ok(tokens[0].to_owned())
}
fn optional_id(rest: &str) -> Result<Option<String>, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() > 1 {
        return Err("expected-zero-or-one-id".to_owned());
    }
    Ok(tokens.first().map(|token| (*token).to_owned()))
}
fn parse_print(rest: &str) -> Result<CommandKind, String> {
    let mut parts = rest.splitn(2, |c: char| c.is_ascii_whitespace());
    let id = parts
        .next()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "expected-id-and-text".to_owned())?;
    let text = parts
        .next()
        .ok_or_else(|| "expected-id-and-text".to_owned())?
        .trim_start_matches(|c: char| c.is_ascii_whitespace())
        .to_owned();
    Ok(CommandKind::Print {
        id: id.to_owned(),
        text,
    })
}
fn parse_winch(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 2 && tokens.len() != 4 {
        return Err("expected-id-sequence-and-optional-rows-cols".to_owned());
    }
    let (rows, cols) = if tokens.len() == 4 {
        (
            Some(parse_u16(tokens[2], "rows")?),
            Some(parse_u16(tokens[3], "cols")?),
        )
    } else {
        (None, None)
    };
    Ok(CommandKind::Winch {
        id: tokens[0].to_owned(),
        sequence: parse_u64(tokens[1], "sequence")?,
        rows,
        cols,
    })
}
fn parse_burst(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 3 {
        return Err("expected-id-bytes-line-width".to_owned());
    }
    let bytes = parse_usize(tokens[1], "bytes")?;
    if bytes > MAX_GENERATED_BYTES {
        return Err("bytes-exceed-limit".to_owned());
    }
    let line_width = parse_usize(tokens[2], "line-width")?;
    if line_width == 0 {
        return Err("line-width-must-be-positive".to_owned());
    }
    if line_width > MAX_LINE_WIDTH {
        return Err("line-width-exceeds-limit".to_owned());
    }
    Ok(CommandKind::Burst {
        id: tokens[0].to_owned(),
        bytes,
        line_width,
    })
}
fn parse_repaint(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 2 {
        return Err("expected-id-bytes".to_owned());
    }
    let bytes = parse_usize(tokens[1], "bytes")?;
    if bytes > MAX_GENERATED_BYTES {
        return Err("bytes-exceed-limit".to_owned());
    }
    Ok(CommandKind::Repaint {
        id: tokens[0].to_owned(),
        bytes,
    })
}
fn parse_bytes(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 2 {
        return Err("expected-id-and-hex".to_owned());
    }
    let bytes = decode_hex_bytes(tokens[1])?;
    Ok(CommandKind::Bytes {
        id: tokens[0].to_owned(),
        bytes,
    })
}
fn parse_query_bytes(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 3 {
        return Err("expected-id-reply-byte-count-and-hex".to_owned());
    }
    let reply_bytes = parse_usize(tokens[1], "reply-byte-count")?;
    if reply_bytes == 0 {
        return Err("reply-byte-count-must-be-positive".to_owned());
    }
    if reply_bytes > MAX_CAPTURE_BYTES {
        return Err("reply-byte-count-exceeds-limit".to_owned());
    }
    let bytes = decode_hex_bytes(tokens[2])?;
    Ok(CommandKind::QueryBytes {
        id: tokens[0].to_owned(),
        reply_bytes,
        bytes,
    })
}
fn parse_artifact(rest: &str) -> Result<CommandKind, String> {
    let mut fields = rest.splitn(2, |character: char| character.is_ascii_whitespace());
    let id = fields
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "expected-id-filename-and-text".to_owned())?;
    let remainder = fields
        .next()
        .ok_or_else(|| "expected-id-filename-and-text".to_owned())?
        .trim_start_matches(|character: char| character.is_ascii_whitespace());
    let mut fields = remainder.splitn(2, |character: char| character.is_ascii_whitespace());
    let filename = fields
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "expected-id-filename-and-text".to_owned())?;
    let text = fields
        .next()
        .ok_or_else(|| "expected-id-filename-and-text".to_owned())?
        .trim_start_matches(|character: char| character.is_ascii_whitespace());
    validate_artifact_filename(filename)?;
    if text.len() > MAX_ARTIFACT_TEXT_BYTES {
        return Err("artifact-text-exceeds-limit".to_owned());
    }
    Ok(CommandKind::Artifact {
        id: id.to_owned(),
        filename: filename.to_owned(),
        text: text.to_owned(),
    })
}
fn parse_capture_input(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 2 {
        return Err("expected-id-and-byte-count".to_owned());
    }
    let bytes = parse_usize(tokens[1], "byte-count")?;
    if bytes == 0 {
        return Err("byte-count-must-be-positive".to_owned());
    }
    if bytes > MAX_CAPTURE_BYTES {
        return Err("byte-count-exceeds-limit".to_owned());
    }
    Ok(CommandKind::CaptureInput {
        id: tokens[0].to_owned(),
        bytes,
    })
}
fn parse_kitty(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() < 2 {
        return Err("expected-id-and-action".to_owned());
    }
    let id = tokens[0].to_owned();
    let action = tokens[1].to_ascii_lowercase();
    let action = match action.as_str() {
        "set" | "push" => {
            if tokens.len() != 3 {
                return Err("expected-id-action-and-flags".to_owned());
            }
            let value = parse_usize(tokens[2], "flags")?;
            if value > usize::from(MAX_KITTY_FLAGS) {
                return Err("flags-exceed-u16".to_owned());
            }
            let value = value as u16;
            if action == "set" {
                KittyAction::Set(value)
            } else {
                KittyAction::Push(value)
            }
        }
        "pop" => {
            if tokens.len() != 3 {
                return Err("expected-id-pop-and-count".to_owned());
            }
            let count = parse_usize(tokens[2], "count")?;
            if !(1..=MAX_KITTY_STACK_POP).contains(&count) {
                return Err("count-must-be-between-one-and-16".to_owned());
            }
            KittyAction::Pop(count)
        }
        "query" => {
            if tokens.len() != 2 {
                return Err("query-does-not-take-a-value".to_owned());
            }
            KittyAction::Query
        }
        "reset" => {
            if tokens.len() != 2 {
                return Err("reset-does-not-take-a-value".to_owned());
            }
            KittyAction::Reset
        }
        _ => return Err("kitty-action-must-be-set-push-pop-query-or-reset".to_owned()),
    };
    Ok(CommandKind::Kitty { id, action })
}
fn parse_mouse(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 3 {
        return Err("expected-id-action-and-mode".to_owned());
    }
    let mode = parse_mouse_mode(tokens[2])?;
    let action = match tokens[1].to_ascii_lowercase().as_str() {
        "enable" => MouseAction::Enable(mode),
        "disable" => MouseAction::Disable(mode),
        _ => return Err("mouse-action-must-be-enable-or-disable".to_owned()),
    };
    Ok(CommandKind::Mouse {
        id: tokens[0].to_owned(),
        action,
    })
}
fn parse_mouse_mode(value: &str) -> Result<MouseMode, String> {
    match value.to_ascii_lowercase().as_str() {
        "button" => Ok(MouseMode::Button),
        "drag" => Ok(MouseMode::Drag),
        "any" => Ok(MouseMode::Any),
        "sgr" => Ok(MouseMode::Sgr),
        _ => Err("mouse-mode-must-be-button-drag-any-or-sgr".to_owned()),
    }
}
fn parse_cursor(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 3 {
        return Err("expected-id-row-col".to_owned());
    }
    Ok(CommandKind::Cursor {
        id: tokens[0].to_owned(),
        row: parse_u16(tokens[1], "row")?,
        col: parse_u16(tokens[2], "col")?,
    })
}
fn parse_margins(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 3 {
        return Err("expected-id-top-bottom".to_owned());
    }
    Ok(CommandKind::Margins {
        id: tokens[0].to_owned(),
        top: parse_u16(tokens[1], "top")?,
        bottom: parse_u16(tokens[2], "bottom")?,
    })
}
fn parse_mode(rest: &str) -> Result<(String, bool), String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 2 {
        return Err("expected-id-and-on-off".to_owned());
    }
    let enabled = match tokens[1].to_ascii_lowercase().as_str() {
        "on" | "1" | "true" => true,
        "off" | "0" | "false" => false,
        _ => return Err("mode-must-be-on-or-off".to_owned()),
    };
    Ok((tokens[0].to_owned(), enabled))
}
fn parse_erase(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 2 {
        return Err("expected-id-and-mode".to_owned());
    }
    let mode = match tokens[1].to_ascii_lowercase().as_str() {
        "display" => EraseMode::Display,
        "scrollback" => EraseMode::Scrollback,
        "line" => EraseMode::Line,
        _ => return Err("erase-mode-must-be-display-scrollback-or-line".to_owned()),
    };
    Ok(CommandKind::Erase {
        id: tokens[0].to_owned(),
        mode,
    })
}
fn parse_utf8_split(rest: &str) -> Result<CommandKind, String> {
    let (prefix, split) = split_last_token(rest, "expected-id-text-split-byte")?;
    let mut parts = prefix.splitn(2, |c: char| c.is_ascii_whitespace());
    let id = parts
        .next()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "expected-id-text-split-byte".to_owned())?;
    let text = parts
        .next()
        .ok_or_else(|| "expected-id-text-split-byte".to_owned())?
        .trim_start_matches(|c: char| c.is_ascii_whitespace())
        .to_owned();
    if text.is_empty() {
        return Err("utf8-text-must-not-be-empty".to_owned());
    }
    let split = parse_usize(split, "split-byte")?;
    if split == 0 || split >= text.len() || !text.is_char_boundary(split) {
        return Err("split-byte-must-be-inside-utf8".to_owned());
    }
    Ok(CommandKind::Utf8Split {
        id: id.to_owned(),
        text,
        split,
    })
}
fn parse_escape_split(rest: &str) -> Result<CommandKind, String> {
    let (id, sequence, split) = parse_escape_split_fields(rest, "expected-id-sequence-split-byte")?;
    Ok(CommandKind::EscapeSplit {
        id,
        sequence,
        split,
    })
}
fn parse_escape_delay(rest: &str) -> Result<CommandKind, String> {
    let reason = "expected-id-sequence-split-byte-delay-ms";
    let (prefix, delay_ms) = split_last_token(rest, reason)?;
    let delay_ms = parse_u64(delay_ms, "delay-ms")?;
    if delay_ms == 0 || delay_ms > MAX_ESCAPE_DELAY_MS {
        return Err("delay-ms-must-be-between-one-and-60000".to_owned());
    }
    let (id, sequence, split) = parse_escape_split_fields(prefix, reason)?;
    Ok(CommandKind::EscapeDelay {
        id,
        sequence,
        split,
        delay_ms,
    })
}
fn parse_escape_split_fields(rest: &str, reason: &str) -> Result<(String, Vec<u8>, usize), String> {
    let (prefix, split) = split_last_token(rest, reason)?;
    let mut parts = prefix.splitn(2, |c: char| c.is_ascii_whitespace());
    let id = parts
        .next()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| reason.to_owned())?;
    let sequence = parts
        .next()
        .ok_or_else(|| reason.to_owned())?
        .trim_start_matches(|c: char| c.is_ascii_whitespace());
    let sequence = decode_escape_sequence(sequence)?;
    let split = parse_usize(split, "split-byte")?;
    if split == 0 || split >= sequence.len() {
        return Err("split-byte-must-be-inside-sequence".to_owned());
    }
    Ok((id.to_owned(), sequence, split))
}
fn parse_echo(rest: &str) -> Result<CommandKind, String> {
    let mut parts = rest.splitn(2, |c: char| c.is_ascii_whitespace());
    let id = parts
        .next()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "expected-id".to_owned())?;
    let Some(text) = parts.next() else {
        return Ok(CommandKind::EchoStart(id.to_owned()));
    };
    Ok(CommandKind::EchoImmediate {
        id: id.to_owned(),
        text: text
            .trim_start_matches(|c: char| c.is_ascii_whitespace())
            .to_owned(),
    })
}
fn parse_exit(rest: &str) -> Result<CommandKind, String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() != 1 {
        return Err("expected-exit-code".to_owned());
    }
    let code = tokens[0]
        .parse::<i32>()
        .map_err(|_| "exit-code-must-be-integer".to_owned())?;
    if !(0..=255).contains(&code) {
        return Err("exit-code-must-be-between-zero-and-255".to_owned());
    }
    Ok(CommandKind::Exit(code))
}
fn split_last_token<'a>(rest: &'a str, reason: &str) -> Result<(&'a str, &'a str), String> {
    let Some(index) = rest.rfind(|c: char| c.is_ascii_whitespace()) else {
        return Err(reason.to_owned());
    };
    let (prefix, suffix) = rest.split_at(index);
    let suffix = suffix.trim_start_matches(|c: char| c.is_ascii_whitespace());
    if prefix.trim().is_empty() || suffix.is_empty() {
        return Err(reason.to_owned());
    }
    Ok((prefix.trim_end(), suffix))
}
fn parse_u16(value: &str, name: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .map_err(|_| format!("{name}-must-be-u16"))
}
fn parse_u64(value: &str, name: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("{name}-must-be-u64"))
}
fn parse_usize(value: &str, name: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .map_err(|_| format!("{name}-must-be-nonnegative-integer"))
}

fn decode_escape_sequence(value: &str) -> Result<Vec<u8>, String> {
    if value.eq_ignore_ascii_case("CSI_31M") {
        return Ok(b"\x1b[31m".to_vec());
    }
    if value.eq_ignore_ascii_case("CSI_2J") {
        return Ok(b"\x1b[2J".to_vec());
    }
    let mut result = Vec::new();
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            if !character.is_ascii() {
                return Err("escape-sequence-must-be-ascii-or-escaped".to_owned());
            }
            result.push(character as u8);
            continue;
        }
        let Some(escaped) = chars.next() else {
            return Err("unterminated-escape".to_owned());
        };
        match escaped {
            'e' | 'E' => result.push(0x1b),
            'n' => result.push(b'\n'),
            'r' => result.push(b'\r'),
            't' => result.push(b'\t'),
            '\\' => result.push(b'\\'),
            'x' | 'X' => {
                let high = chars
                    .next()
                    .and_then(hex_value)
                    .ok_or_else(|| "invalid-hex-escape".to_owned())?;
                let low = chars
                    .next()
                    .and_then(hex_value)
                    .ok_or_else(|| "invalid-hex-escape".to_owned())?;
                result.push((high << 4) | low);
            }
            _ => return Err("unsupported-escape".to_owned()),
        }
    }
    if result.is_empty() {
        return Err("escape-sequence-must-not-be-empty".to_owned());
    }
    Ok(result)
}
fn hex_value(value: char) -> Option<u8> {
    match value {
        '0'..='9' => Some(value as u8 - b'0'),
        'a'..='f' => Some(value as u8 - b'a' + 10),
        'A'..='F' => Some(value as u8 - b'A' + 10),
        _ => None,
    }
}
fn decode_hex_bytes(value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty() {
        return Err("hex-must-not-be-empty".to_owned());
    }
    if !value.is_ascii() {
        return Err("hex-must-be-ascii".to_owned());
    }
    if !value.len().is_multiple_of(2) {
        return Err("hex-must-have-even-length".to_owned());
    }
    let bytes = value.len() / 2;
    if bytes > MAX_BYTE_SEQUENCE {
        return Err("hex-exceeds-byte-limit".to_owned());
    }
    let mut result = Vec::with_capacity(bytes);
    let mut chars = value.chars();
    while let (Some(high), Some(low)) = (chars.next(), chars.next()) {
        let high = hex_value(high).ok_or_else(|| "hex-contains-invalid-digit".to_owned())?;
        let low = hex_value(low).ok_or_else(|| "hex-contains-invalid-digit".to_owned())?;
        result.push((high << 4) | low);
    }
    Ok(result)
}
fn validate_artifact_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.len() > MAX_ARTIFACT_FILENAME_BYTES
        || filename == "."
        || filename == ".."
        || filename == ".artifact.json"
    {
        return Err("artifact-filename-is-invalid".to_owned());
    }
    if filename.contains('/') || filename.contains('\\') || filename.chars().any(char::is_control) {
        return Err("artifact-filename-must-be-a-safe-basename".to_owned());
    }
    if Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(filename)
    {
        return Err("artifact-filename-must-be-a-safe-basename".to_owned());
    }
    Ok(())
}
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("artifact-open-{}", io_error_kind(&error)))?;
    file.write_all(bytes)
        .map_err(|error| format!("artifact-write-{}", io_error_kind(&error)))?;
    file.flush()
        .map_err(|error| format!("artifact-flush-{}", io_error_kind(&error)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = file
            .metadata()
            .map_err(|error| format!("artifact-stat-{}", io_error_kind(&error)))?
            .permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(path, permissions)
            .map_err(|error| format!("artifact-permissions-{}", io_error_kind(&error)))?;
    }
    Ok(())
}
fn create_artifact(filename: &str, text: &str) -> Result<PathBuf, String> {
    validate_artifact_filename(filename)?;
    if text.len() > MAX_ARTIFACT_TEXT_BYTES {
        return Err("artifact-text-exceeds-limit".to_owned());
    }
    let root = env::var_os("TERM_SERVER_ARTIFACTS_DIR")
        .ok_or_else(|| "artifact-root-is-unset".to_owned())
        .map(PathBuf::from)?;
    if !root.is_absolute() {
        return Err("artifact-root-must-be-absolute".to_owned());
    }
    let session =
        env::var_os("TERM_SERVER_SESSION").ok_or_else(|| "artifact-session-is-unset".to_owned())?;
    let session = session.to_string_lossy().into_owned();
    if session.is_empty()
        || !session
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("artifact-session-is-not-safe".to_owned());
    }
    let session_directory = root.join(&session);
    create_dir_all(&session_directory)
        .map_err(|error| format!("artifact-directory-{}", io_error_kind(&error)))?;
    let artifact_id = Uuid::new_v4().to_string();
    let staging = session_directory.join(format!(".artifact-{artifact_id}"));
    std::fs::create_dir(&staging)
        .map_err(|error| format!("artifact-staging-{}", io_error_kind(&error)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&staging)
            .map_err(|error| format!("artifact-stat-{}", io_error_kind(&error)))?
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&staging, permissions)
            .map_err(|error| format!("artifact-permissions-{}", io_error_kind(&error)))?;
    }
    let result = (|| {
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let metadata = format!(r#"{{"createdAt":{created_at},"producer":"e2e-fixture"}}"#);
        write_private_file(&staging.join(".artifact.json"), metadata.as_bytes())?;
        write_private_file(&staging.join(filename), text.as_bytes())?;
        let final_directory = session_directory.join(&artifact_id);
        std::fs::rename(&staging, &final_directory)
            .map_err(|error| format!("artifact-commit-{}", io_error_kind(&error)))?;
        Ok(final_directory.join(filename))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}
fn kitty_sequence(action: KittyAction) -> Vec<u8> {
    match action {
        KittyAction::Set(flags) => format!("\x1b[={flags}u").into_bytes(),
        KittyAction::Push(flags) => format!("\x1b[>{flags}u").into_bytes(),
        KittyAction::Pop(count) => format!("\x1b[<{count}u").into_bytes(),
        KittyAction::Query => b"\x1b[?u".to_vec(),
        KittyAction::Reset => b"\x1b[=0u".to_vec(),
    }
}
fn kitty_action_name(action: KittyAction) -> &'static str {
    match action {
        KittyAction::Set(_) => "set",
        KittyAction::Push(_) => "push",
        KittyAction::Pop(_) => "pop",
        KittyAction::Query => "query",
        KittyAction::Reset => "reset",
    }
}
fn kitty_action_value(action: KittyAction) -> Option<usize> {
    match action {
        KittyAction::Set(flags) | KittyAction::Push(flags) => Some(usize::from(flags)),
        KittyAction::Pop(count) => Some(count),
        KittyAction::Query | KittyAction::Reset => None,
    }
}
fn mouse_action_name(action: MouseAction) -> &'static str {
    match action {
        MouseAction::Enable(_) => "enable",
        MouseAction::Disable(_) => "disable",
    }
}
fn mouse_action_mode(action: MouseAction) -> MouseMode {
    match action {
        MouseAction::Enable(mode) | MouseAction::Disable(mode) => mode,
    }
}
fn mouse_mode_name(mode: MouseMode) -> &'static str {
    match mode {
        MouseMode::Button => "button",
        MouseMode::Drag => "drag",
        MouseMode::Any => "any",
        MouseMode::Sgr => "sgr",
    }
}
fn mouse_sequence(action: MouseAction) -> Vec<u8> {
    let mode = match mouse_action_mode(action) {
        MouseMode::Button => 1000,
        MouseMode::Drag => 1002,
        MouseMode::Any => 1003,
        MouseMode::Sgr => 1006,
    };
    let suffix = match action {
        MouseAction::Enable(_) => 'h',
        MouseAction::Disable(_) => 'l',
    };
    format!("\x1b[?{mode}{suffix}").into_bytes()
}

fn burst_bytes(bytes: usize, line_width: usize) -> Vec<u8> {
    let mut output = Vec::with_capacity(bytes);
    let mut column = 0_usize;
    let mut visible = 0_usize;
    while output.len() < bytes {
        output.push(b'A' + (visible % 26) as u8);
        visible = visible.saturating_add(1);
        column = column.saturating_add(1);
        if column == line_width && output.len() < bytes.saturating_sub(1) {
            output.push(b'\n');
            column = 0;
        }
    }
    output
}
fn repaint_bytes(id: &str, bytes: usize) -> Vec<u8> {
    let frame = format!("\x1b[2J\x1b[H\x1b[1;1Hagent-00\x1b[2;1Hagent-01\x1b[3;1Hagent-02\x1b[4;1H\x1b[2Kfooter\x1b[5;1H[E2E:REPAINT:{}:FRAME]\x1b[6;1H", visible_field(id)).into_bytes();
    let mut output = Vec::with_capacity(bytes);
    if bytes < frame.len() {
        output.extend_from_slice(&frame[..bytes]);
        return output;
    }

    // Keep one complete frame at the end so the repaint leaves a stable
    // marker and cursor position for output emitted by the next command.
    let prefix_bytes = bytes - frame.len();
    let full_frames = prefix_bytes / frame.len();
    for _ in 0..full_frames {
        output.extend_from_slice(&frame);
    }
    output.resize(prefix_bytes, b'X');
    output.extend_from_slice(&frame);
    output
}
fn marker_bytes(operation: &str, id: Option<&str>) -> Vec<u8> {
    match id {
        Some(id) => marker_bytes_with_fields(operation, &[id.to_owned()]),
        None => marker_bytes_with_fields(operation, &[]),
    }
}
fn marker_bytes_with_fields(operation: &str, fields: &[String]) -> Vec<u8> {
    let mut marker = String::from("[E2E:");
    marker.push_str(operation);
    for field in fields {
        marker.push(':');
        marker.push_str(&visible_field(field));
    }
    marker.push_str("]\n");
    marker.into_bytes()
}
fn visible_field(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if character.is_control() {
            result.push_str(&format!("\\x{:02X}", character as u32));
        } else if character == '[' || character == ']' {
            result.push('\\');
            result.push(character);
        } else {
            result.push(character);
        }
    }
    result
}
fn io_error_kind(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::NotFound => "not-found",
        io::ErrorKind::PermissionDenied => "permission-denied",
        io::ErrorKind::ConnectionRefused => "connection-refused",
        io::ErrorKind::ConnectionReset => "connection-reset",
        io::ErrorKind::ConnectionAborted => "connection-aborted",
        io::ErrorKind::NotConnected => "not-connected",
        io::ErrorKind::AddrInUse => "address-in-use",
        io::ErrorKind::BrokenPipe => "broken-pipe",
        io::ErrorKind::AlreadyExists => "already-exists",
        io::ErrorKind::WouldBlock => "would-block",
        io::ErrorKind::InvalidInput => "invalid-input",
        io::ErrorKind::InvalidData => "invalid-data",
        io::ErrorKind::TimedOut => "timed-out",
        io::ErrorKind::Interrupted => "interrupted",
        io::ErrorKind::UnexpectedEof => "unexpected-eof",
        _ => "other",
    }
}
fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}
fn is_complete_csi(sequence: &[u8]) -> bool {
    if sequence.len() < 3 || sequence[0] != 0x1b || sequence[1] != b'[' {
        return false;
    }
    let final_byte = *sequence.last().unwrap_or(&0);
    (0x40..=0x7e).contains(&final_byte) && final_byte != b'['
}
fn is_kitty_keyboard_reply(sequence: &[u8]) -> bool {
    if sequence.len() < 5 || !sequence.starts_with(b"\x1b[?") || sequence.last() != Some(&b'u') {
        return false;
    }
    sequence[3..sequence.len() - 1]
        .iter()
        .all(u8::is_ascii_digit)
}

#[derive(Debug, Clone, Copy)]
struct PtySize {
    rows: u16,
    cols: u16,
    pixel_width: u16,
    pixel_height: u16,
}
#[cfg(unix)]
fn read_pty_size() -> io::Result<PtySize> {
    let mut size = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let result = unsafe { libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ, &mut size) };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(PtySize {
        rows: size.ws_row,
        cols: size.ws_col,
        pixel_width: size.ws_xpixel,
        pixel_height: size.ws_ypixel,
    })
}
#[cfg(not(unix))]
fn read_pty_size() -> io::Result<PtySize> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "pty-size-unsupported",
    ))
}
#[cfg(unix)]
struct RawModeGuard {
    fd: libc::c_int,
    original: libc::termios,
}
#[cfg(unix)]
impl Drop for RawModeGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = libc::tcsetattr(self.fd, libc::TCSANOW, &self.original);
        }
    }
}
#[cfg(unix)]
fn install_raw_mode() -> io::Result<Option<RawModeGuard>> {
    let fd = libc::STDIN_FILENO;
    let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
    if unsafe { libc::tcgetattr(fd, &mut original) } == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOTTY) {
            return Ok(None);
        }
        return Err(error);
    }
    let mut raw = original;
    unsafe {
        libc::cfmakeraw(&mut raw);
        if libc::tcsetattr(fd, libc::TCSANOW, &raw) == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(Some(RawModeGuard { fd, original }))
}
#[cfg(not(unix))]
fn install_raw_mode() -> io::Result<Option<()>> {
    Ok(None)
}

fn spawn_winch_listener(output: Arc<SharedOutput>, runtime: Arc<RuntimeState>) {
    #[cfg(unix)]
    {
        thread::spawn(move || {
            let Ok(runtime_handle) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            runtime_handle.block_on(async move {
                let Ok(mut signals) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change()) else { return; };
                while let Some(()) = signals.recv().await {
                    if runtime.is_stopping() { break; }
                    let sequence = runtime.winch_sequence.fetch_add(1, Ordering::AcqRel) + 1;
                    match read_pty_size() {
                        Ok(size) => {
                            output.record("sigwinch", json!({"signal_sequence": sequence, "rows": size.rows, "cols": size.cols, "pixel_width": size.pixel_width, "pixel_height": size.pixel_height, "source": "signal"}));
                            output.marker("WINCH", &[sequence.to_string(), size.rows.to_string(), size.cols.to_string()]);
                        }
                        Err(error) => output.error(&[], &format!("sigwinch-size-{}", io_error_kind(&error))),
                    }
                }
            });
        });
    }
    #[cfg(not(unix))]
    {
        let _ = (output, runtime);
    }
}
