use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::build::BuildIdentity;

/// Upper bound on the serialized size of a recording. Recording stops (and the
/// buffer is flagged as truncated) once this is reached so the server never
/// pays unbounded memory cost for a debugging aid.
pub const DEBUG_RECORDING_MAX_BYTES: usize = 64 * 1024 * 1024;

/// A single captured event. The terminal id and a timestamp are attached by
/// the recorder so events from many terminals can be interleaved and compared
/// with the client-side recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DebugRecordEvent {
    /// Raw output bytes sent to a terminal's browser connection. `data` is
    /// base64. `sequence` is the stream byte offset of the first byte.
    Output { sequence: u64, data: String },
    /// Input bytes received from a browser and forwarded to the PTY. `data`
    /// is base64.
    Input { data: String },
    /// A terminal control message (ready/sync/synced/size/exit/error/pong).
    Control { message: serde_json::Value },
    /// A snapshot frame sent to a browser. `data` is base64.
    Snapshot { sequence: u64, data: String },
    /// A terminal client connected to the server.
    Connect,
    /// A terminal client disconnected. `reason` is a short human string.
    Disconnect { reason: String },
    /// A resize request received from a browser.
    Resize {
        cols: u16,
        rows: u16,
        pixel_width: u16,
        pixel_height: u16,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedEvent {
    pub ts: u64,
    pub terminal: String,
    #[serde(flatten)]
    pub event: DebugRecordEvent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugRecordingStatus {
    pub active: bool,
    pub id: Option<Uuid>,
    pub started_at: Option<u64>,
    pub stopped_at: Option<u64>,
    pub events: u64,
    pub bytes: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugRecordingExport {
    pub format: String,
    pub version: String,
    pub id: Uuid,
    pub started_at: u64,
    pub stopped_at: Option<u64>,
    pub truncated: bool,
    pub server: BuildIdentity,
    pub events: Vec<RecordedEvent>,
}

#[derive(Debug, Deserialize)]
pub struct DebugRecordingControl {
    pub action: DebugRecordingAction,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DebugRecordingAction {
    Start,
    Stop,
    Clear,
}

struct RecordingBuffer {
    id: Uuid,
    started_at: u64,
    stopped_at: Option<u64>,
    events: Vec<RecordedEvent>,
    bytes: usize,
    max_bytes: usize,
    truncated: bool,
}

impl RecordingBuffer {
    fn record(&mut self, terminal: &Uuid, event: DebugRecordEvent) {
        if self.truncated {
            return;
        }
        let ts = current_millis();
        let size = serialized_size(&event);
        self.bytes += size;
        if self.bytes > self.max_bytes {
            self.bytes = self.max_bytes;
            self.truncated = true;
            self.events.push(RecordedEvent {
                ts,
                terminal: terminal.to_string(),
                event: DebugRecordEvent::Control {
                    message: serde_json::json!({
                        "type": "recording",
                        "event": "truncated",
                        "max_bytes": self.max_bytes,
                    }),
                },
            });
            return;
        }
        self.events.push(RecordedEvent {
            ts,
            terminal: terminal.to_string(),
            event,
        });
    }

    fn status(&self) -> DebugRecordingStatus {
        DebugRecordingStatus {
            active: self.stopped_at.is_none(),
            id: Some(self.id),
            started_at: Some(self.started_at),
            stopped_at: self.stopped_at,
            events: self.events.len() as u64,
            bytes: self.bytes as u64,
            truncated: self.truncated,
        }
    }
}

/// Records backend terminal traffic on demand. Capture is gated by an atomic
/// `active` flag so the hot terminal paths only pay a single atomic load (and
/// an early return) while recording is disabled.
pub struct DebugRecordingManager {
    active: AtomicBool,
    max_bytes: usize,
    inner: Mutex<Option<RecordingBuffer>>,
    events: AtomicU64,
}

impl Default for DebugRecordingManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DebugRecordingManager {
    pub fn new() -> Self {
        Self::with_max_bytes(DEBUG_RECORDING_MAX_BYTES)
    }

    /// Constructs a recorder with a custom size cap (used by tests).
    pub fn with_max_bytes(max_bytes: usize) -> Self {
        Self {
            active: AtomicBool::new(false),
            max_bytes,
            inner: Mutex::new(None),
            events: AtomicU64::new(0),
        }
    }

    pub fn start(&self) -> DebugRecordingStatus {
        let mut guard = self.inner.lock().unwrap();
        if let Some(buffer) = guard.as_ref()
            && buffer.stopped_at.is_none()
        {
            return buffer.status();
        }
        let buffer = RecordingBuffer {
            id: Uuid::new_v4(),
            started_at: current_millis(),
            stopped_at: None,
            events: Vec::new(),
            bytes: 0,
            max_bytes: self.max_bytes,
            truncated: false,
        };
        let status = buffer.status();
        self.active.store(true, Ordering::SeqCst);
        self.events.store(0, Ordering::Relaxed);
        *guard = Some(buffer);
        status
    }

    pub fn stop(&self) -> DebugRecordingStatus {
        let mut guard = self.inner.lock().unwrap();
        let Some(buffer) = guard.as_mut() else {
            self.active.store(false, Ordering::SeqCst);
            return idle_status();
        };
        if buffer.stopped_at.is_none() {
            buffer.stopped_at = Some(current_millis());
        }
        self.active.store(false, Ordering::SeqCst);
        buffer.status()
    }

    pub fn status(&self) -> DebugRecordingStatus {
        let guard = self.inner.lock().unwrap();
        match guard.as_ref() {
            Some(buffer) => buffer.status(),
            None => idle_status(),
        }
    }

    pub fn clear(&self) {
        self.active.store(false, Ordering::SeqCst);
        *self.inner.lock().unwrap() = None;
        self.events.store(0, Ordering::Relaxed);
    }

    /// Export the most recent recording, if any. The active (recording) buffer
    /// is exported as-is; callers typically stop first.
    pub fn export(&self) -> Option<DebugRecordingExport> {
        let guard = self.inner.lock().unwrap();
        let buffer = guard.as_ref()?;
        Some(DebugRecordingExport {
            format: "term-server-debug-recording".to_owned(),
            version: "1".to_owned(),
            id: buffer.id,
            started_at: buffer.started_at,
            stopped_at: buffer.stopped_at,
            truncated: buffer.truncated,
            server: BuildIdentity::current(),
            events: buffer.events.clone(),
        })
    }

    #[inline]
    fn record(&self, terminal: &Uuid, event: DebugRecordEvent) {
        // Fast path: single atomic load, no allocation, no locking when off.
        if !self.active.load(Ordering::Relaxed) {
            return;
        }
        self.inner
            .lock()
            .unwrap()
            .as_mut()
            .expect("active recording buffer")
            .record(terminal, event);
        self.events.fetch_add(1, Ordering::Relaxed);
    }

    pub fn output(&self, terminal: &Uuid, sequence: u64, bytes: &[u8]) {
        self.record(
            terminal,
            DebugRecordEvent::Output {
                sequence,
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            },
        );
    }

    pub fn input(&self, terminal: &Uuid, bytes: &[u8]) {
        self.record(
            terminal,
            DebugRecordEvent::Input {
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            },
        );
    }

    pub fn control(&self, terminal: &Uuid, message: impl Serialize) {
        let Ok(message) = serde_json::to_value(message) else {
            return;
        };
        self.record(terminal, DebugRecordEvent::Control { message });
    }

    pub fn snapshot(&self, terminal: &Uuid, sequence: u64, bytes: &[u8]) {
        self.record(
            terminal,
            DebugRecordEvent::Snapshot {
                sequence,
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            },
        );
    }

    pub fn connect(&self, terminal: &Uuid) {
        self.record(terminal, DebugRecordEvent::Connect);
    }

    pub fn disconnect(&self, terminal: &Uuid, reason: &str) {
        self.record(
            terminal,
            DebugRecordEvent::Disconnect {
                reason: reason.to_owned(),
            },
        );
    }

    pub fn resize(
        &self,
        terminal: &Uuid,
        cols: u16,
        rows: u16,
        pixel_width: u16,
        pixel_height: u16,
    ) {
        self.record(
            terminal,
            DebugRecordEvent::Resize {
                cols,
                rows,
                pixel_width,
                pixel_height,
            },
        );
    }

    pub fn note(&self, terminal: &Uuid, event: &str) {
        self.record(
            terminal,
            DebugRecordEvent::Control {
                message: serde_json::json!({ "type": "recording", "event": event }),
            },
        );
    }
}

fn idle_status() -> DebugRecordingStatus {
    DebugRecordingStatus {
        active: false,
        id: None,
        started_at: None,
        stopped_at: None,
        events: 0,
        bytes: 0,
        truncated: false,
    }
}

fn serialized_size(event: &DebugRecordEvent) -> usize {
    // Rough, allocation-free estimate used only for the size cap. Base64 data
    // payloads dominate and are charged by their encoded length.
    match event {
        DebugRecordEvent::Output { data, .. } => data.len() + 48,
        DebugRecordEvent::Input { data } => data.len() + 32,
        DebugRecordEvent::Snapshot { data, .. } => data.len() + 48,
        DebugRecordEvent::Control { message } => message.to_string().len().min(256) + 48,
        DebugRecordEvent::Connect
        | DebugRecordEvent::Disconnect { .. }
        | DebugRecordEvent::Resize { .. } => 96,
    }
}

fn current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_ignores_events_when_inactive() {
        let manager = DebugRecordingManager::new();
        let id = Uuid::new_v4();
        manager.output(&id, 0, b"hello");
        assert_eq!(manager.status().events, 0);
    }

    #[test]
    fn start_stop_and_export_round_trip() {
        let manager = DebugRecordingManager::new();
        let id = Uuid::new_v4();
        let started = manager.start();
        assert!(started.active);
        manager.output(&id, 0, b"hello world");
        manager.control(&id, serde_json::json!({ "type": "pong" }));
        let stopped = manager.stop();
        assert!(!stopped.active);
        assert_eq!(stopped.events, 2);
        let export = manager.export().unwrap();
        assert_eq!(export.events.len(), 2);
        assert_eq!(export.events[0].terminal, id.to_string());
        assert_eq!(export.format, "term-server-debug-recording");
    }

    #[test]
    fn recording_caps_at_the_byte_budget() {
        let manager = DebugRecordingManager::with_max_bytes(1024);
        let id = Uuid::new_v4();
        manager.start();
        // A 4KB payload far exceeds the 1KB cap, so the buffer must truncate.
        manager.output(&id, 0, &vec![0u8; 4096]);
        let status = manager.status();
        assert!(status.truncated);
        assert_eq!(status.bytes as usize, 1024);
    }

    #[test]
    fn recording_survives_stop_then_restart() {
        let manager = DebugRecordingManager::new();
        let id = Uuid::new_v4();
        manager.start();
        manager.input(&id, b"ls");
        let stopped = manager.stop();
        assert_eq!(stopped.events, 1);
        // Events recorded after a stop are dropped.
        manager.output(&id, 1, b"ignored");
        assert_eq!(manager.status().events, 1);
        // Starting again begins a fresh recording.
        let restarted = manager.start();
        assert!(restarted.active);
        assert_eq!(restarted.events, 0);
    }
}
