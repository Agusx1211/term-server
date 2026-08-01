use std::collections::VecDeque;

use bytes::Bytes;

const DELTA_BUDGET_DIVISOR: usize = 4;
const MIN_RESERVED_VIEWPORT_COLS: usize = 128;
const MAX_VIEWPORT_COLS: usize = 500;
const CELL_BYTES: usize = std::mem::size_of::<vt100::Cell>();
const MAX_PENDING_SEQUENCE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SequencedOutput {
    pub sequence: u64,
    pub bytes: Bytes,
}

impl SequencedOutput {
    pub fn end_sequence(&self) -> u64 {
        self.sequence + self.bytes.len() as u64
    }

    pub fn slice_from(&self, sequence: u64) -> Option<Self> {
        if sequence >= self.end_sequence() {
            return None;
        }
        let offset = sequence.saturating_sub(self.sequence) as usize;
        Some(Self {
            sequence: self.sequence + offset as u64,
            bytes: self.bytes.slice(offset..),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    Snapshot,
    Resume,
}

#[derive(Debug)]
pub struct TerminalSync {
    pub mode: SyncMode,
    pub sequence: u64,
    pub snapshot: Option<Bytes>,
    pub output: Vec<SequencedOutput>,
}

pub struct TerminalOutputState {
    sequence: u64,
    delta: DeltaBuffer,
    state_bytes: usize,
    terminal: CanonicalTerminal,
    exit_code: Option<u32>,
}

impl TerminalOutputState {
    pub fn new(maximum_bytes: usize, rows: u16, cols: u16) -> Self {
        let delta_bytes = (maximum_bytes / DELTA_BUDGET_DIVISOR).max(64 * 1024);
        let state_bytes = maximum_bytes.saturating_sub(delta_bytes);
        Self {
            sequence: 0,
            delta: DeltaBuffer::new(delta_bytes),
            state_bytes,
            terminal: CanonicalTerminal::new(rows, cols, scrollback_capacity(state_bytes, cols)),
            exit_code: None,
        }
    }

    pub fn publish(&mut self, bytes: Bytes) -> SequencedOutput {
        let output = SequencedOutput {
            sequence: self.sequence,
            bytes,
        };
        self.sequence = output.end_sequence();
        self.terminal.process(&output.bytes);
        self.delta.push(output.clone());
        output
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.terminal
            .resize(rows, cols, scrollback_capacity(self.state_bytes, cols));
    }

    pub fn sync(&self, requested_sequence: Option<u64>) -> TerminalSync {
        if let Some(sequence) = requested_sequence
            && let Some(output) = self.delta.outputs_since(sequence, self.sequence)
        {
            return TerminalSync {
                mode: SyncMode::Resume,
                sequence: self.sequence,
                snapshot: None,
                output,
            };
        }
        TerminalSync {
            mode: SyncMode::Snapshot,
            sequence: self.sequence,
            snapshot: Some(Bytes::from(self.terminal.snapshot())),
            output: Vec::new(),
        }
    }

    pub fn text_tail(&self, maximum_bytes: usize) -> String {
        self.delta.text_tail(maximum_bytes)
    }

    pub fn alternate_screen(&self) -> bool {
        self.terminal.alternate_screen()
    }

    pub fn mark_exited(&mut self, exit_code: u32) {
        self.exit_code = Some(exit_code);
    }

    pub fn exit_code(&self) -> Option<u32> {
        self.exit_code
    }
}

#[derive(Debug)]
struct DeltaBuffer {
    chunks: VecDeque<SequencedOutput>,
    bytes: usize,
    maximum_bytes: usize,
}

impl DeltaBuffer {
    fn new(maximum_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            maximum_bytes,
        }
    }

    fn push(&mut self, mut chunk: SequencedOutput) {
        if chunk.bytes.is_empty() {
            return;
        }
        if chunk.bytes.len() > self.maximum_bytes {
            let offset = chunk.bytes.len() - self.maximum_bytes;
            chunk.sequence += offset as u64;
            chunk.bytes = chunk.bytes.slice(offset..);
        }
        self.bytes += chunk.bytes.len();
        self.chunks.push_back(chunk);
        while self.bytes > self.maximum_bytes {
            let excess = self.bytes - self.maximum_bytes;
            let Some(front) = self.chunks.front_mut() else {
                break;
            };
            if front.bytes.len() <= excess {
                self.bytes -= front.bytes.len();
                self.chunks.pop_front();
            } else {
                front.sequence += excess as u64;
                front.bytes = front.bytes.slice(excess..);
                self.bytes -= excess;
            }
        }
    }

    fn outputs_since(&self, sequence: u64, current_sequence: u64) -> Option<Vec<SequencedOutput>> {
        if sequence > current_sequence {
            return None;
        }
        let earliest = self
            .chunks
            .front()
            .map_or(current_sequence, |chunk| chunk.sequence);
        if sequence < earliest {
            return None;
        }
        Some(
            self.chunks
                .iter()
                .filter_map(|chunk| chunk.slice_from(sequence))
                .collect(),
        )
    }

    fn text_tail(&self, maximum_bytes: usize) -> String {
        let mut remaining = maximum_bytes;
        let mut chunks = Vec::new();
        for chunk in self.chunks.iter().rev() {
            if remaining == 0 {
                break;
            }
            let start = chunk.bytes.len().saturating_sub(remaining);
            chunks.push(chunk.bytes.slice(start..));
            remaining = remaining.saturating_sub(chunk.bytes.len() - start);
        }
        chunks.reverse();
        let bytes = chunks.concat();
        crate::terminal::sanitize_terminal_text(&String::from_utf8_lossy(&bytes))
    }
}

struct CanonicalTerminal {
    parser: vt100::Parser,
    scrollback_rows: usize,
    normal_before_alt: Option<vt100::Screen>,
    alternate_entry: Option<AlternateEntry>,
    sequence: EscapeSequence,
    pending: Vec<u8>,
}

impl CanonicalTerminal {
    fn new(rows: u16, cols: u16, scrollback_rows: usize) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, scrollback_rows),
            scrollback_rows,
            normal_before_alt: None,
            alternate_entry: None,
            sequence: EscapeSequence::Ground,
            pending: Vec::new(),
        }
    }

    fn process(&mut self, bytes: &[u8]) {
        let mut start = 0;
        for (index, byte) in bytes.iter().copied().enumerate() {
            let completed = self.observe_byte(byte);
            let Some(sequence) = completed else {
                continue;
            };
            self.parser.process(&bytes[start..index]);
            if let Some(entry) = sequence.alternate_mode.entry()
                && !self.parser.screen().alternate_screen()
            {
                self.normal_before_alt = Some(self.parser.screen().clone());
                self.alternate_entry = Some(entry);
            }
            self.parser.process(&bytes[index..=index]);
            if sequence.alternate_mode == AlternateMode::Enter1047 {
                self.parser.process(b"\x1b[?47h");
            } else if sequence.alternate_mode == AlternateMode::Exit1047 {
                self.parser.process(b"\x1b[?47l");
            }
            if sequence.erase_scrollback && !self.parser.screen().alternate_screen() {
                self.clear_scrollback();
            }
            if sequence.alternate_mode.exits_alternate() && !self.parser.screen().alternate_screen()
            {
                self.normal_before_alt = None;
                self.alternate_entry = None;
            }
            start = index + 1;
        }
        self.parser.process(&bytes[start..]);
    }

    fn observe_byte(&mut self, byte: u8) -> Option<CompletedSequence> {
        let was_tracking = self.sequence != EscapeSequence::Ground || !self.pending.is_empty();
        let was_ground = self.sequence == EscapeSequence::Ground;
        self.sequence = self.sequence.advance(byte);
        if was_ground && self.sequence != EscapeSequence::Ground {
            self.pending.clear();
        }
        if (self.sequence != EscapeSequence::Ground || !self.pending.is_empty())
            && self.pending.len() < MAX_PENDING_SEQUENCE_BYTES
        {
            self.pending.push(byte);
        }
        if self.sequence != EscapeSequence::Ground {
            return None;
        }
        if !was_tracking {
            return None;
        }
        let completed = std::mem::take(&mut self.pending);
        Some(CompletedSequence {
            alternate_mode: alternate_mode(&completed),
            erase_scrollback: erases_scrollback(&completed),
        })
    }

    fn clear_scrollback(&mut self) {
        // vt100 does not expose a saved-line purge. Replaying only the live
        // state into a fresh parser preserves the screen and drops its history.
        let (rows, cols) = self.parser.screen().size();
        let visible_state = self.parser.screen().state_formatted();
        self.parser = vt100::Parser::new(rows, cols, self.scrollback_rows);
        self.parser.process(&visible_state);
    }

    fn resize(&mut self, rows: u16, cols: u16, scrollback_rows: usize) {
        if self.scrollback_rows != scrollback_rows {
            let (current_rows, current_cols) = self.parser.screen().size();
            let snapshot = self.snapshot();
            let mut resized = Self::new(current_rows, current_cols, scrollback_rows);
            resized.process(&snapshot);
            *self = resized;
        }
        self.parser.screen_mut().set_size(rows, cols);
        if let Some(normal) = self.normal_before_alt.as_mut() {
            normal.set_size(rows, cols);
        }
    }

    fn alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    fn snapshot(&self) -> Vec<u8> {
        let mut snapshot = if self.parser.screen().alternate_screen() {
            let mut bytes = self
                .normal_before_alt
                .as_ref()
                .map(snapshot_screen)
                .unwrap_or_default();
            bytes.extend_from_slice(
                self.alternate_entry
                    .unwrap_or(AlternateEntry::Mode1049)
                    .sequence(),
            );
            bytes.extend_from_slice(&self.parser.screen().state_formatted());
            bytes
        } else {
            snapshot_screen(self.parser.screen())
        };
        snapshot.extend_from_slice(&self.pending);
        snapshot
    }
}

#[derive(Debug, Clone, Copy)]
struct CompletedSequence {
    alternate_mode: AlternateMode,
    erase_scrollback: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EscapeSequence {
    Ground,
    Escape,
    EscapeIntermediate,
    Csi,
    Osc { escape: bool },
    ControlString { escape: bool },
}

impl EscapeSequence {
    fn advance(self, byte: u8) -> Self {
        match self {
            Self::Ground => match byte {
                0x1b => Self::Escape,
                0x9b => Self::Csi,
                0x9d => Self::Osc { escape: false },
                0x90 | 0x98 | 0x9e | 0x9f => Self::ControlString { escape: false },
                _ => Self::Ground,
            },
            Self::Escape => match byte {
                b'[' => Self::Csi,
                b']' => Self::Osc { escape: false },
                b'P' | b'X' | b'^' | b'_' => Self::ControlString { escape: false },
                0x20..=0x2f => Self::EscapeIntermediate,
                0x1b => Self::Escape,
                _ => Self::Ground,
            },
            Self::EscapeIntermediate => match byte {
                0x20..=0x2f => Self::EscapeIntermediate,
                0x1b => Self::Escape,
                _ => Self::Ground,
            },
            Self::Csi => match byte {
                0x18 | 0x1a => Self::Ground,
                0x1b => Self::Escape,
                0x40..=0x7e => Self::Ground,
                _ => Self::Csi,
            },
            Self::Osc { escape } => match byte {
                0x07 | 0x9c => Self::Ground,
                b'\\' if escape => Self::Ground,
                0x1b => Self::Osc { escape: true },
                _ => Self::Osc { escape: false },
            },
            Self::ControlString { escape } => match byte {
                0x9c => Self::Ground,
                b'\\' if escape => Self::Ground,
                0x1b => Self::ControlString { escape: true },
                _ => Self::ControlString { escape: false },
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AlternateMode {
    None,
    Enter47,
    Enter1047,
    Enter1049,
    Exit47,
    Exit1047,
    Exit1049,
}

impl AlternateMode {
    fn entry(self) -> Option<AlternateEntry> {
        match self {
            Self::Enter47 => Some(AlternateEntry::Mode47),
            Self::Enter1047 => Some(AlternateEntry::Mode1047),
            Self::Enter1049 => Some(AlternateEntry::Mode1049),
            _ => None,
        }
    }

    fn exits_alternate(self) -> bool {
        matches!(self, Self::Exit47 | Self::Exit1047 | Self::Exit1049)
    }
}

#[derive(Debug, Clone, Copy)]
enum AlternateEntry {
    Mode47,
    Mode1047,
    Mode1049,
}

impl AlternateEntry {
    fn sequence(self) -> &'static [u8] {
        match self {
            Self::Mode47 => b"\x1b[?47h",
            Self::Mode1047 => b"\x1b[?1047h",
            Self::Mode1049 => b"\x1b[?1049h",
        }
    }
}

fn alternate_mode(sequence: &[u8]) -> AlternateMode {
    if sequence.len() < 5 || !(sequence.starts_with(b"\x1b[?") || sequence.starts_with(b"\x9b?")) {
        return AlternateMode::None;
    }
    let Some(&final_byte) = sequence.last() else {
        return AlternateMode::None;
    };
    if !matches!(final_byte, b'h' | b'l') {
        return AlternateMode::None;
    }
    let prefix = if sequence[0] == 0x1b { 3 } else { 2 };
    let Ok(modes) = std::str::from_utf8(&sequence[prefix..sequence.len() - 1]) else {
        return AlternateMode::None;
    };
    let mode = if modes.split(';').any(|mode| mode == "1049") {
        1049
    } else if modes.split(';').any(|mode| mode == "1047") {
        1047
    } else if modes.split(';').any(|mode| mode == "47") {
        47
    } else {
        return AlternateMode::None;
    };
    match (final_byte, mode) {
        (b'h', 47) => AlternateMode::Enter47,
        (b'h', 1047) => AlternateMode::Enter1047,
        (b'h', 1049) => AlternateMode::Enter1049,
        (b'l', 47) => AlternateMode::Exit47,
        (b'l', 1047) => AlternateMode::Exit1047,
        (b'l', 1049) => AlternateMode::Exit1049,
        _ => AlternateMode::None,
    }
}

fn erases_scrollback(sequence: &[u8]) -> bool {
    matches!(sequence, b"\x1b[3J" | b"\x9b3J")
}

fn scrollback_capacity(state_bytes: usize, cols: u16) -> usize {
    let reserved_cols = usize::from(cols)
        .next_power_of_two()
        .clamp(MIN_RESERVED_VIEWPORT_COLS, MAX_VIEWPORT_COLS);
    state_bytes / (reserved_cols * CELL_BYTES)
}

fn snapshot_screen(screen: &vt100::Screen) -> Vec<u8> {
    let mut source = screen.clone();
    source.set_scrollback(usize::MAX);
    let scrollback_rows = source.scrollback();
    source.set_scrollback(0);
    if scrollback_rows == 0 {
        return source.state_formatted();
    }

    let (rows, cols) = source.size();
    let mut snapshot = b"\x1b[m\x1b[H\x1b[J".to_vec();
    for offset in (1..=scrollback_rows).rev() {
        source.set_scrollback(offset);
        snapshot.extend_from_slice(b"\x1b[m");
        if let Some(row) = source.rows_formatted(0, cols).next() {
            snapshot.extend_from_slice(&row);
        }
        if source.row_wrapped(0) {
            // Trigger pending autowrap without leaving a cell behind. Calling
            // rows_formatted for one history row at a time would otherwise
            // let the next row's cursor movement cancel the wrap.
            snapshot.extend_from_slice(b" \x08\x1b[X");
        } else {
            snapshot.extend_from_slice(b"\r\n");
        }
    }
    snapshot.extend(std::iter::repeat_n(
        b'\n',
        usize::from(rows.saturating_sub(1)),
    ));
    source.set_scrollback(0);
    snapshot.extend_from_slice(&source.state_formatted());
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(sequence: u64, bytes: &'static [u8]) -> SequencedOutput {
        SequencedOutput {
            sequence,
            bytes: Bytes::from_static(bytes),
        }
    }

    fn assert_screen_eq(actual: &vt100::Screen, expected: &vt100::Screen) {
        assert_eq!(actual.size(), expected.size());
        assert_eq!(actual.contents(), expected.contents());
        assert_eq!(actual.cursor_position(), expected.cursor_position());
        assert_eq!(actual.alternate_screen(), expected.alternate_screen());
        assert_eq!(
            actual.input_mode_formatted(),
            expected.input_mode_formatted()
        );
        let (rows, cols) = expected.size();
        for row in 0..rows {
            assert_eq!(actual.row_wrapped(row), expected.row_wrapped(row));
            for col in 0..cols {
                assert_eq!(actual.cell(row, col), expected.cell(row, col));
            }
        }
    }

    fn assert_history_eq(actual: &vt100::Screen, expected: &vt100::Screen) {
        let mut actual = actual.clone();
        let mut expected = expected.clone();
        actual.set_scrollback(usize::MAX);
        expected.set_scrollback(usize::MAX);
        assert_eq!(actual.scrollback(), expected.scrollback());
        for offset in 0..=expected.scrollback() {
            actual.set_scrollback(offset);
            expected.set_scrollback(offset);
            assert_screen_eq(&actual, &expected);
        }
    }

    #[test]
    fn delta_buffer_slices_and_evicts_exactly() {
        let mut delta = DeltaBuffer::new(5);
        delta.push(output(0, b"abc"));
        delta.push(output(3, b"def"));
        assert_eq!(delta.bytes, 5);
        assert!(delta.outputs_since(0, 6).is_none());
        assert_eq!(
            delta.outputs_since(2, 6).unwrap(),
            vec![output(2, b"c"), output(3, b"def")]
        );
        assert_eq!(delta.outputs_since(4, 6).unwrap(), vec![output(4, b"ef")]);
        assert_eq!(delta.outputs_since(6, 6).unwrap(), Vec::new());
        assert!(delta.outputs_since(7, 6).is_none());
    }

    #[test]
    fn output_state_resumes_recent_bytes_and_snapshots_after_eviction() {
        let mut state = TerminalOutputState::new(256 * 1024, 4, 20);
        state.publish(Bytes::from(vec![b'x'; 70 * 1024]));
        let current = state.sequence;

        let recent = state.sync(Some(current - 100));
        assert_eq!(recent.mode, SyncMode::Resume);
        assert_eq!(
            recent
                .output
                .iter()
                .flat_map(|output| output.bytes.iter().copied())
                .collect::<Vec<_>>(),
            vec![b'x'; 100]
        );

        let old = state.sync(Some(0));
        assert_eq!(old.mode, SyncMode::Snapshot);
        assert!(old.output.is_empty());
        assert!(old.snapshot.unwrap().len() < 4 * 1024);
    }

    #[test]
    fn default_reconnect_budget_retains_typical_terminal_history() {
        let mut state = TerminalOutputState::new(16 * 1024 * 1024, 10, 100);
        for line in 0..2_000 {
            state.publish(Bytes::from(format!("away-{line:04}\r\n")));
        }

        let snapshot = state.sync(None).snapshot.unwrap();
        let mut reconstructed = vt100::Parser::new(10, 100, 200_000);
        reconstructed.process(&snapshot);
        reconstructed.screen_mut().set_scrollback(usize::MAX);

        assert!(reconstructed.screen().contents().contains("away-0000"));
    }

    #[test]
    fn resize_rebalances_scrollback_within_the_state_budget() {
        let mut state = TerminalOutputState::new(16 * 1024 * 1024, 10, 100);
        let initial_capacity = state.terminal.scrollback_rows;
        for line in 0..2_000 {
            state.publish(Bytes::from(format!("line-{line:04}\r\n")));
        }

        state.resize(10, 500);

        assert!(state.terminal.scrollback_rows < initial_capacity);
        assert_eq!(
            state.terminal.scrollback_rows,
            scrollback_capacity(state.state_bytes, 500)
        );
        let snapshot = state.sync(None).snapshot.unwrap();
        let mut reconstructed = vt100::Parser::new(10, 500, 200_000);
        reconstructed.process(&snapshot);
        assert!(reconstructed.screen().contents().contains("line-1999"));
    }

    #[test]
    fn snapshot_reconstructs_formatted_screen_and_input_modes() {
        let mut terminal = CanonicalTerminal::new(4, 12, 20);
        terminal.process(
            b"plain\r\n\x1b[31;1mred\x1b[m\r\nwide: \xe7\x8c\xab\x1b[?25l\x1b[?1h\x1b[?2004h",
        );
        let mut reconstructed = vt100::Parser::new(4, 12, 20);
        reconstructed.process(&terminal.snapshot());
        assert_screen_eq(reconstructed.screen(), terminal.parser.screen());
    }

    #[test]
    fn snapshot_reconstructs_scrollback_in_order() {
        let mut terminal = CanonicalTerminal::new(3, 10, 20);
        for line in 0..12 {
            terminal.process(format!("\x1b[3{}mline-{line:02}\x1b[m\r\n", line % 8).as_bytes());
        }
        terminal.process(b"wrapped-0123456789-abcdefghij\r\n");
        terminal.process("wide-猫猫猫猫\r\n".as_bytes());
        terminal.process(b"1234567890          after-blanks\r\n");
        let snapshot = terminal.snapshot();
        assert!(snapshot.len() < 4 * 1024);

        let mut reconstructed = vt100::Parser::new(3, 10, 20);
        reconstructed.process(&snapshot);
        assert_history_eq(reconstructed.screen(), terminal.parser.screen());
    }

    #[test]
    fn top_anchored_scroll_region_preserves_history() {
        let mut terminal = CanonicalTerminal::new(5, 20, 20);
        terminal.process(b"\x1b[1;4r\x1b[4;1H");
        for line in 0..8 {
            terminal.process(format!("transcript {line}\r\n").as_bytes());
        }

        let mut screen = terminal.parser.screen().clone();
        screen.set_scrollback(usize::MAX);
        assert_eq!(screen.scrollback(), 8);
        assert!(screen.contents().contains("transcript 0"));

        let mut reconstructed = vt100::Parser::new(5, 20, 20);
        reconstructed.process(&terminal.snapshot());
        assert_history_eq(reconstructed.screen(), terminal.parser.screen());
    }

    #[test]
    fn erase_saved_lines_keeps_the_visible_screen_and_input_modes() {
        let mut terminal = CanonicalTerminal::new(3, 20, 20);
        for line in 0..8 {
            terminal.process(format!("old line {line}\r\n").as_bytes());
        }
        terminal.process(b"\x1b[31mvisible\x1b[?25l\x1b[?2004h");
        let expected = terminal.parser.screen().clone();

        terminal.process(b"\x1b[3J");

        assert_screen_eq(terminal.parser.screen(), &expected);
        let mut screen = terminal.parser.screen().clone();
        screen.set_scrollback(usize::MAX);
        assert_eq!(screen.scrollback(), 0);
    }

    #[test]
    fn codex_resize_replay_replaces_old_history() {
        let mut terminal = CanonicalTerminal::new(5, 20, 20);
        terminal.process(b"\x1b[1;4r\x1b[4;1H");
        for line in 0..6 {
            terminal.process(format!("old transcript {line}\r\n").as_bytes());
        }

        terminal.process(b"\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3");
        terminal.process(b"J\x1b[H\x1b[1;4r\x1b[4;1H");
        for line in 0..6 {
            terminal.process(format!("new transcript {line}\r\n").as_bytes());
        }

        let snapshot = terminal.snapshot();
        let mut reconstructed = vt100::Parser::new(5, 20, 20);
        reconstructed.process(&snapshot);
        assert_history_eq(reconstructed.screen(), terminal.parser.screen());

        let mut screen = reconstructed.screen().clone();
        screen.set_scrollback(usize::MAX);
        assert_eq!(screen.scrollback(), 6);
        assert!(!screen.contents().contains("old transcript"));
        assert!(screen.contents().contains("new transcript 0"));
    }

    #[test]
    fn snapshot_preserves_normal_screen_while_tui_uses_alternate_screen() {
        let mut terminal = CanonicalTerminal::new(4, 16, 20);
        for line in 0..8 {
            terminal.process(format!("shell line {line}\r\n").as_bytes());
        }
        terminal.process(b"prompt$ ");
        terminal.process(b"\x1b[?1049");
        terminal.process(b"h\x1b[H\x1b[2J\x1b[32mTUI frame\x1b[m\x1b[?25l");
        assert!(terminal.parser.screen().alternate_screen());

        let mut reconstructed = vt100::Parser::new(4, 16, 20);
        reconstructed.process(&terminal.snapshot());
        assert_screen_eq(reconstructed.screen(), terminal.parser.screen());

        terminal.process(b"\x1b[?1049l");
        reconstructed.process(b"\x1b[?1049l");
        assert_history_eq(reconstructed.screen(), terminal.parser.screen());
        assert!(reconstructed.screen().contents().contains("prompt$"));
    }

    #[test]
    fn output_state_reports_the_canonical_alternate_screen() {
        let mut output = TerminalOutputState::new(1024 * 1024, 4, 16);
        assert!(!output.alternate_screen());
        output.publish(Bytes::from_static(b"\x1b[?1049hTUI"));
        assert!(output.alternate_screen());
        output.publish(Bytes::from_static(b"\x1b[?1049l"));
        assert!(!output.alternate_screen());
    }

    #[test]
    fn snapshot_carries_an_incomplete_escape_sequence() {
        let mut terminal = CanonicalTerminal::new(3, 20, 0);
        terminal.process(b"prompt\x1b[6");
        let mut reconstructed = vt100::Parser::new(3, 20, 0);
        reconstructed.process(&terminal.snapshot());
        terminal.process(b"n");
        reconstructed.process(b"n");
        assert_screen_eq(reconstructed.screen(), terminal.parser.screen());
    }

    #[test]
    fn completed_terminal_queries_are_not_replayed() {
        let mut terminal = CanonicalTerminal::new(3, 20, 0);
        terminal.process(b"ready\x1b[6n");
        assert!(
            !terminal
                .snapshot()
                .windows(4)
                .any(|bytes| bytes == b"\x1b[6n")
        );
    }

    #[test]
    fn redraw_heavy_tui_snapshot_stays_bounded() {
        let mut terminal = CanonicalTerminal::new(40, 160, 800);
        terminal.process(b"normal screen\x1b[?1049h");
        for frame in 0..10_000 {
            terminal.process(format!("\x1b[Hframe {frame}\x1b[J\x1b[40;160Hstatus").as_bytes());
        }
        assert!(terminal.snapshot().len() < 128 * 1024);
    }
}
