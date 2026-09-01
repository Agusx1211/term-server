use std::collections::{HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const DEFAULT_SCROLLBACK_BYTES: usize = 64 * 1024;
pub const MAX_SCROLLBACK_BYTES: usize = 512 * 1024;
pub const DEFAULT_TRANSCRIPT_RECORDS: usize = 100;
pub const MAX_TRANSCRIPT_RECORDS: usize = 500;
const MIN_TRANSCRIPT_BYTES: usize = 512 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_TEXT_BYTES: usize = 128 * 1024;
const MAX_TRANSCRIPT_DATA_BYTES: usize = 256 * 1024;
const MAX_TRANSCRIPT_SOURCE_ID_BYTES: usize = 256;
const MAX_TRANSCRIPT_LABEL_BYTES: usize = 256;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScrollbackPage {
    pub terminal_id: Uuid,
    pub earliest_sequence: u64,
    pub start_sequence: u64,
    pub end_sequence: u64,
    pub latest_sequence: u64,
    pub truncated: bool,
    pub has_more: bool,
    pub text: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AgentTranscriptKind {
    Message,
    ToolStart,
    ToolResult,
    Status,
    Compaction,
    Summary,
    Marker,
}

impl AgentTranscriptKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::ToolStart => "tool_start",
            Self::ToolResult => "tool_result",
            Self::Status => "status",
            Self::Compaction => "compaction",
            Self::Summary => "summary",
            Self::Marker => "marker",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "message" => Some(Self::Message),
            "tool_start" | "tool-start" => Some(Self::ToolStart),
            "tool_result" | "tool-result" => Some(Self::ToolResult),
            "status" => Some(Self::Status),
            "compaction" => Some(Self::Compaction),
            "summary" => Some(Self::Summary),
            "marker" => Some(Self::Marker),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptInput {
    pub kind: AgentTranscriptKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptRecord {
    pub sequence: u64,
    pub timestamp: u64,
    pub provider: String,
    pub kind: AgentTranscriptKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptPage {
    pub terminal_id: Uuid,
    pub earliest_sequence: u64,
    pub start_sequence: u64,
    pub next_sequence: u64,
    pub latest_sequence: u64,
    pub truncated: bool,
    pub has_more: bool,
    pub records: Vec<AgentTranscriptRecord>,
}

#[derive(Debug)]
struct StoredTranscriptRecord {
    record: AgentTranscriptRecord,
    bytes: usize,
}

#[derive(Debug)]
pub struct AgentTranscriptStore {
    records: VecDeque<StoredTranscriptRecord>,
    seen_source_ids: HashSet<String>,
    retained_bytes: usize,
    maximum_bytes: usize,
    next_sequence: u64,
}

impl AgentTranscriptStore {
    pub fn new(replay_bytes: usize) -> Self {
        Self {
            records: VecDeque::new(),
            seen_source_ids: HashSet::new(),
            retained_bytes: 0,
            maximum_bytes: (replay_bytes / 2).clamp(MIN_TRANSCRIPT_BYTES, MAX_TRANSCRIPT_BYTES),
            next_sequence: 0,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn replace(
        &mut self,
        provider: &str,
        inputs: impl IntoIterator<Item = AgentTranscriptInput>,
        now: u64,
    ) {
        self.records.clear();
        self.seen_source_ids.clear();
        self.retained_bytes = 0;
        self.extend(provider, inputs, now);
    }

    pub fn extend(
        &mut self,
        provider: &str,
        inputs: impl IntoIterator<Item = AgentTranscriptInput>,
        now: u64,
    ) {
        for input in inputs {
            self.push(provider, input, now);
        }
    }

    pub fn page(
        &self,
        terminal_id: Uuid,
        from_sequence: Option<u64>,
        limit: usize,
        kinds: &[AgentTranscriptKind],
    ) -> AgentTranscriptPage {
        let earliest_sequence = self
            .records
            .front()
            .map(|stored| stored.record.sequence)
            .unwrap_or(self.next_sequence);
        let latest_sequence = self.next_sequence.saturating_sub(1);
        let requested_sequence = from_sequence.unwrap_or(earliest_sequence);
        let start_sequence = requested_sequence.max(earliest_sequence);
        let limit = limit.clamp(1, MAX_TRANSCRIPT_RECORDS);
        let accepts =
            |record: &AgentTranscriptRecord| kinds.is_empty() || kinds.contains(&record.kind);
        let records = self
            .records
            .iter()
            .map(|stored| &stored.record)
            .filter(|record| record.sequence >= start_sequence && accepts(record))
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next_sequence = records
            .last()
            .map(|record| record.sequence.saturating_add(1))
            .unwrap_or_else(|| latest_sequence.saturating_add(1).max(start_sequence));
        let has_more = self
            .records
            .iter()
            .any(|stored| stored.record.sequence >= next_sequence && accepts(&stored.record));
        AgentTranscriptPage {
            terminal_id,
            earliest_sequence,
            start_sequence,
            next_sequence,
            latest_sequence,
            truncated: requested_sequence < earliest_sequence,
            has_more,
            records,
        }
    }

    fn push(&mut self, provider: &str, mut input: AgentTranscriptInput, now: u64) {
        input.source_id = input
            .source_id
            .map(|value| truncate_utf8(value.trim(), MAX_TRANSCRIPT_SOURCE_ID_BYTES))
            .filter(|value| !value.is_empty());
        if input
            .source_id
            .as_ref()
            .is_some_and(|source_id| self.seen_source_ids.contains(source_id))
        {
            return;
        }
        input.role = input
            .role
            .map(|value| truncate_utf8(value.trim(), MAX_TRANSCRIPT_LABEL_BYTES))
            .filter(|value| !value.is_empty());
        input.name = input
            .name
            .map(|value| truncate_utf8(value.trim(), MAX_TRANSCRIPT_LABEL_BYTES))
            .filter(|value| !value.is_empty());
        let mut truncated = input.truncated;
        input.text = input
            .text
            .map(|value| {
                let (value, was_truncated) =
                    truncate_utf8_with_flag(value.trim(), MAX_TRANSCRIPT_TEXT_BYTES);
                truncated |= was_truncated;
                value
            })
            .filter(|value| !value.is_empty());
        if let Some(data) = input.data.as_ref() {
            let data_bytes = serde_json::to_vec(data).map_or(usize::MAX, |encoded| encoded.len());
            if data_bytes > MAX_TRANSCRIPT_DATA_BYTES {
                input.data = Some(serde_json::json!({
                    "truncated": true,
                    "originalBytes": data_bytes,
                }));
                truncated = true;
            }
        }
        if input.text.is_none()
            && let Some(data) = input.data.as_ref()
            && let Ok(pretty) = serde_json::to_string_pretty(data)
        {
            let (text, was_truncated) =
                truncate_utf8_with_flag(pretty.trim(), MAX_TRANSCRIPT_TEXT_BYTES);
            input.text = (!text.is_empty()).then_some(text);
            truncated |= was_truncated;
        }
        let record = AgentTranscriptRecord {
            sequence: self.next_sequence,
            timestamp: input.timestamp.unwrap_or(now),
            provider: truncate_utf8(provider.trim(), MAX_TRANSCRIPT_LABEL_BYTES),
            kind: input.kind,
            source_id: input.source_id,
            role: input.role,
            name: input.name,
            text: input.text,
            data: input.data,
            truncated,
        };
        self.next_sequence = self.next_sequence.saturating_add(1);
        let bytes =
            serde_json::to_vec(&record).map_or(MAX_TRANSCRIPT_DATA_BYTES, |value| value.len());
        if let Some(source_id) = record.source_id.as_ref() {
            self.seen_source_ids.insert(source_id.clone());
        }
        self.retained_bytes = self.retained_bytes.saturating_add(bytes);
        self.records
            .push_back(StoredTranscriptRecord { record, bytes });
        while self.retained_bytes > self.maximum_bytes {
            let Some(evicted) = self.records.pop_front() else {
                break;
            };
            self.retained_bytes = self.retained_bytes.saturating_sub(evicted.bytes);
            if let Some(source_id) = evicted.record.source_id {
                self.seen_source_ids.remove(&source_id);
            }
        }
    }
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    truncate_utf8_with_flag(value, maximum_bytes).0
}

fn truncate_utf8_with_flag(value: &str, maximum_bytes: usize) -> (String, bool) {
    if value.len() <= maximum_bytes {
        return (value.to_owned(), false);
    }
    let mut end = maximum_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_owned(), true)
}

pub fn clean_terminal_text(bytes: &[u8]) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Text,
        Escape,
        EscapeIntermediate,
        Csi,
        String,
        StringEscape,
    }

    let mut state = State::Text;
    let mut clean = Vec::with_capacity(bytes.len());
    // C1 controls share their byte range with UTF-8 continuation bytes, so a
    // byte may only be read as a control while no multibyte scalar is open.
    // Without this every `\u{276f}`, emoji, Cyrillic or box-drawing character
    // starts a phantom control string and swallows the rest of the output.
    let mut continuation_expected = 0_u8;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        index += 1;
        state = match state {
            State::Text if continuation_expected > 0 && byte & 0xc0 == 0x80 => {
                clean.push(byte);
                continuation_expected -= 1;
                State::Text
            }
            State::Text => {
                continuation_expected = 0;
                match byte {
                    0x1b => State::Escape,
                    0x9b => State::Csi,
                    0x9d | 0x90 | 0x98 | 0x9e | 0x9f => State::String,
                    b'\r' => {
                        if bytes.get(index) != Some(&b'\n') {
                            clean.push(b'\n');
                        }
                        State::Text
                    }
                    b'\n' | b'\t' => {
                        clean.push(byte);
                        State::Text
                    }
                    0x08 => {
                        // Erase the whole scalar, not its last byte.
                        while clean.last().is_some_and(|value| value & 0xc0 == 0x80) {
                            clean.pop();
                        }
                        clean.pop();
                        State::Text
                    }
                    0x20..=0x7e | 0x80..=0xff => {
                        continuation_expected = match byte {
                            0xc2..=0xdf => 1,
                            0xe0..=0xef => 2,
                            0xf0..=0xf4 => 3,
                            _ => 0,
                        };
                        clean.push(byte);
                        State::Text
                    }
                    _ => State::Text,
                }
            }
            State::Escape => match byte {
                b'[' => State::Csi,
                b']' | b'P' | b'X' | b'^' | b'_' => State::String,
                // `ESC ( B`, `ESC # 8` and friends end on their final byte, so
                // consuming a single byte here would emit that final as text.
                0x20..=0x2f => State::EscapeIntermediate,
                0x1b => State::Escape,
                _ => State::Text,
            },
            State::EscapeIntermediate => match byte {
                0x20..=0x2f => State::EscapeIntermediate,
                0x1b => State::Escape,
                _ => State::Text,
            },
            State::Csi => match byte {
                0x1b => State::Escape,
                0x40..=0x7e => State::Text,
                _ => State::Csi,
            },
            State::String => match byte {
                0x07 => State::Text,
                0x1b => State::StringEscape,
                _ => State::String,
            },
            State::StringEscape => {
                if byte == b'\\' {
                    State::Text
                } else if byte == 0x1b {
                    State::StringEscape
                } else {
                    State::String
                }
            }
        };
    }
    String::from_utf8_lossy(&clean).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_terminal_control_sequences_without_losing_text() {
        let clean = clean_terminal_text(
            b"plain\r\n\x1b[31mred\x1b[0m\x1b]0;secret title\x07\rprogress\tend\n",
        );
        assert_eq!(clean, "plain\nred\nprogress\tend\n");
        assert!(!clean.contains("secret title"));
    }

    #[test]
    fn cleans_terminal_text_keeps_output_after_multibyte_prompt_scalars() {
        // `\u{276f}` is E2 9D AF: its continuation bytes collide with the C1
        // OSC and APC introducers, which used to swallow every later byte.
        let clean = clean_terminal_text("\u{276f} cargo test\r\nrunning 1 test\r\n".as_bytes());
        assert_eq!(clean, "\u{276f} cargo test\nrunning 1 test\n");
    }

    #[test]
    fn cleans_terminal_text_round_trips_scalars_that_contain_c1_bytes() {
        for text in [
            "\u{276f}",
            "\u{1f642}",
            "\u{410}\u{418}\u{41b}\u{41d}\u{41e}\u{41f}",
            "\u{15b}",
            "\u{2550}\u{255d}\u{2590}",
        ] {
            assert_eq!(clean_terminal_text(text.as_bytes()), text);
        }
    }

    #[test]
    fn cleans_terminal_text_still_strips_single_byte_c1_controls() {
        assert_eq!(clean_terminal_text(b"before\x9b31mafter"), "beforeafter");
        assert_eq!(clean_terminal_text(b"a\x9dtitle\x07b"), "ab");
    }

    #[test]
    fn cleans_terminal_text_backspaces_a_whole_scalar() {
        assert_eq!(clean_terminal_text("caf\u{e9}\x08o".as_bytes()), "cafo");
    }

    #[test]
    fn cleans_terminal_text_drops_escape_finals_and_control_strings() {
        // `\x1b(B` is what `tput sgr0` emits on xterm-256color.
        assert_eq!(clean_terminal_text(b"\x1b(Bplain\x1b)0\x1b#8"), "plain");
        assert_eq!(clean_terminal_text(b"a\x1bP0;1|payload\x1b\\b"), "ab");
    }

    fn transcript_input(
        kind: AgentTranscriptKind,
        source_id: &str,
        text: &str,
    ) -> AgentTranscriptInput {
        AgentTranscriptInput {
            kind,
            source_id: Some(source_id.to_owned()),
            timestamp: None,
            role: None,
            name: None,
            text: Some(text.to_owned()),
            data: None,
            truncated: false,
        }
    }

    #[test]
    fn transcript_store_pages_filters_and_deduplicates_records() {
        let terminal_id = Uuid::from_u128(7);
        let mut store = AgentTranscriptStore::new(1024 * 1024);
        store.extend(
            "omp",
            [
                transcript_input(AgentTranscriptKind::Status, "status-1", "working"),
                transcript_input(AgentTranscriptKind::Message, "message-1", "hello"),
                transcript_input(AgentTranscriptKind::ToolResult, "tool-1", "done"),
                transcript_input(AgentTranscriptKind::Message, "message-1", "duplicate"),
            ],
            42,
        );

        let first = store.page(terminal_id, None, 2, &[]);
        assert_eq!(first.records.len(), 2);
        assert_eq!(first.next_sequence, 2);
        assert!(first.has_more);
        let second = store.page(terminal_id, Some(first.next_sequence), 2, &[]);
        assert_eq!(second.records.len(), 1);
        assert!(!second.has_more);
        let messages = store.page(terminal_id, Some(0), 10, &[AgentTranscriptKind::Message]);
        assert_eq!(messages.records.len(), 1);
        assert_eq!(messages.records[0].text.as_deref(), Some("hello"));
    }

    #[test]
    fn transcript_snapshot_replacement_keeps_monotonic_cursors() {
        let terminal_id = Uuid::from_u128(8);
        let mut store = AgentTranscriptStore::new(1024 * 1024);
        store.extend(
            "omp",
            [transcript_input(AgentTranscriptKind::Message, "old", "old")],
            1,
        );
        store.replace(
            "omp",
            [transcript_input(AgentTranscriptKind::Message, "new", "new")],
            2,
        );

        let page = store.page(terminal_id, Some(0), 10, &[]);
        assert!(page.truncated);
        assert_eq!(page.earliest_sequence, 1);
        assert_eq!(page.records[0].sequence, 1);
        assert_eq!(page.records[0].text.as_deref(), Some("new"));
    }
}
