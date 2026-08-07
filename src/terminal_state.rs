use std::collections::VecDeque;

use bytes::Bytes;

const DELTA_BUDGET_DIVISOR: usize = 4;
const MIN_RESERVED_VIEWPORT_COLS: usize = 128;
const MAX_VIEWPORT_COLS: usize = 500;
const CELL_BYTES: usize = std::mem::size_of::<vt100::Cell>();
const MAX_PENDING_SEQUENCE_BYTES: usize = 64 * 1024;
const MAX_TRACKED_SGR_BYTES: usize = 64 * 1024;

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

    pub fn resize(&mut self, rows: u16, cols: u16, pixel_width: u16, pixel_height: u16) {
        self.terminal.resize(
            rows,
            cols,
            scrollback_capacity(self.state_bytes, cols),
            pixel_width,
            pixel_height,
        );
    }

    /// Drains replies to terminal status/device queries observed in published
    /// output. The caller must write these bytes back to the PTY exactly once.
    pub fn drain_responses(&mut self) -> Vec<Bytes> {
        self.terminal
            .drain_responses()
            .into_iter()
            .map(Bytes::from)
            .collect()
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

    /// The rendered live screen, rows joined by `\n`, for agent detection.
    ///
    /// This is the canonical server-side screen, so it always reflects the
    /// bottom of the buffer no matter where a browser has scrolled. Full-screen
    /// agents draw their prompt and approval UI on the alternate screen, which
    /// is what `screen()` reports while one is active.
    pub fn detection_text(&self) -> String {
        self.terminal.screen_text()
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
    normal_execution_before_alt: Option<ExecutionState>,
    alternate_entry: Option<AlternateEntry>,
    execution: ExecutionState,
    sequence: EscapeSequence,
    pending: Vec<u8>,
    utf8_pending: Vec<u8>,
    utf8_expected: u8,
    responses: VecDeque<Vec<u8>>,
    pixel_width: u16,
    pixel_height: u16,
}

impl CanonicalTerminal {
    fn new(rows: u16, cols: u16, scrollback_rows: usize) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, scrollback_rows),
            scrollback_rows,
            normal_before_alt: None,
            normal_execution_before_alt: None,
            alternate_entry: None,
            execution: ExecutionState::new(rows),
            sequence: EscapeSequence::Ground,
            pending: Vec::new(),
            utf8_pending: Vec::new(),
            utf8_expected: 0,
            responses: VecDeque::new(),
            pixel_width: 0,
            pixel_height: 0,
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
                self.normal_execution_before_alt = Some(self.execution.clone());
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
            self.execution
                .observe(&sequence.bytes, self.parser.screen());
            if let Some(response) = terminal_query_response(
                &sequence.bytes,
                self.parser.screen(),
                &self.execution,
                self.pixel_width,
                self.pixel_height,
            ) {
                self.responses.push_back(response);
            }
            if sequence.alternate_mode.exits_alternate() && !self.parser.screen().alternate_screen()
            {
                self.normal_before_alt = None;
                self.alternate_entry = None;
                if let Some(execution) = self.normal_execution_before_alt.take() {
                    self.execution = execution;
                }
            }
            start = index + 1;
        }
        self.parser.process(&bytes[start..]);
    }

    fn observe_byte(&mut self, byte: u8) -> Option<CompletedSequence> {
        if self.sequence == EscapeSequence::Ground {
            if self.utf8_expected > 0 {
                if byte & 0b1100_0000 == 0b1000_0000 {
                    self.utf8_pending.push(byte);
                    self.utf8_expected -= 1;
                    if self.utf8_expected == 0 {
                        self.utf8_pending.clear();
                    }
                    return None;
                }
                self.utf8_pending.clear();
                self.utf8_expected = 0;
            }
            self.utf8_expected = match byte {
                0xc2..=0xdf => 1,
                0xe0..=0xef => 2,
                0xf0..=0xf4 => 3,
                _ => 0,
            };
            if self.utf8_expected > 0 {
                self.utf8_pending.clear();
                self.utf8_pending.push(byte);
                return None;
            }
        }
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
            bytes: completed,
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

    fn resize(
        &mut self,
        rows: u16,
        cols: u16,
        scrollback_rows: usize,
        pixel_width: u16,
        pixel_height: u16,
    ) {
        if self.parser.screen().size() == (rows, cols) && self.scrollback_rows == scrollback_rows {
            self.pixel_width = pixel_width;
            self.pixel_height = pixel_height;
            return;
        }
        // panoptes-vt100's set_size truncates physical rows and drops bottom
        // rows. Replaying the logical snapshot at the target dimensions lets
        // wrapping and scrollback behave like a terminal receiving the same
        // output at that size, preserving completed wrapped lines and content
        // displaced by a height shrink.
        let snapshot = self.resize_snapshot(rows, cols);
        let mut resized = Self::new(rows, cols, scrollback_rows);
        resized.process(&snapshot);
        resized.responses.clear();
        resized.pixel_width = pixel_width;
        resized.pixel_height = pixel_height;
        *self = resized;
    }

    fn resize_snapshot(&self, rows: u16, cols: u16) -> Vec<u8> {
        if self.parser.screen().alternate_screen() {
            let mut output = Vec::new();
            if let Some(normal) = self.normal_before_alt.as_ref() {
                let plan = reflow_plan(normal, rows, cols);
                output.extend_from_slice(&plan.bytes);
                let mut execution = self
                    .normal_execution_before_alt
                    .clone()
                    .unwrap_or_else(|| ExecutionState::new(rows));
                execution.remap_positions(&plan);
                execution.write_restore_at(&mut output, plan.cursor, plan.pending_wrap.as_ref());
            }
            output.extend_from_slice(
                self.alternate_entry
                    .unwrap_or(AlternateEntry::Mode1049)
                    .sequence(),
            );
            let plan = reflow_plan(self.parser.screen(), rows, cols);
            output.extend_from_slice(&plan.bytes);
            let mut execution = self.execution.clone();
            execution.remap_positions(&plan);
            execution.write_restore_at(&mut output, plan.cursor, plan.pending_wrap.as_ref());
            output.extend_from_slice(&self.pending);
            output.extend_from_slice(&self.utf8_pending);
            output
        } else {
            let plan = reflow_plan(self.parser.screen(), rows, cols);
            let mut output = plan.bytes.clone();
            let mut execution = self.execution.clone();
            execution.remap_positions(&plan);
            execution.write_restore_at(&mut output, plan.cursor, plan.pending_wrap.as_ref());
            output.extend_from_slice(&self.pending);
            output.extend_from_slice(&self.utf8_pending);
            output
        }
    }

    fn alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    fn screen_text(&self) -> String {
        let screen = self.parser.screen();
        let (_, cols) = screen.size();
        let mut text = String::new();
        for (index, row) in screen.rows(0, cols).enumerate() {
            if index > 0 {
                text.push('\n');
            }
            text.push_str(&row);
        }
        text
    }

    fn snapshot(&self) -> Vec<u8> {
        let mut snapshot = if self.parser.screen().alternate_screen() {
            let mut bytes = match (
                self.normal_before_alt.as_ref(),
                self.normal_execution_before_alt.as_ref(),
            ) {
                (Some(screen), Some(execution)) => {
                    snapshot_screen_with_execution(screen, execution)
                }
                (Some(screen), None) => snapshot_screen(screen),
                _ => Vec::new(),
            };
            bytes.extend_from_slice(
                self.alternate_entry
                    .unwrap_or(AlternateEntry::Mode1049)
                    .sequence(),
            );
            bytes.extend_from_slice(&self.parser.screen().state_formatted());
            self.execution
                .write_restore(&mut bytes, self.parser.screen());
            bytes
        } else {
            snapshot_screen_with_execution(self.parser.screen(), &self.execution)
        };
        snapshot.extend_from_slice(&self.pending);
        snapshot.extend_from_slice(&self.utf8_pending);
        snapshot
    }

    fn drain_responses(&mut self) -> Vec<Vec<u8>> {
        self.responses.drain(..).collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ExecutionState {
    rows: u16,
    scroll_region: Option<(u16, u16)>,
    origin_mode: bool,
    insert_mode: bool,
    auto_wrap_mode: bool,
    reverse_wrap_mode: bool,
    focus_mode: bool,
    alternate_scroll_mode: bool,
    pixel_mouse_mode: bool,
    cursor_style: u16,
    attrs: Vec<Vec<u8>>,
    attrs_bytes: usize,
    saved_cursor: Option<SavedCursor>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SavedCursor {
    row: u16,
    col: u16,
    origin_mode: bool,
    attrs: Vec<Vec<u8>>,
}

impl ExecutionState {
    fn new(rows: u16) -> Self {
        Self {
            rows,
            scroll_region: None,
            origin_mode: false,
            insert_mode: false,
            auto_wrap_mode: true,
            reverse_wrap_mode: false,
            focus_mode: false,
            alternate_scroll_mode: false,
            pixel_mouse_mode: false,
            cursor_style: 0,
            attrs: Vec::new(),
            attrs_bytes: 0,
            saved_cursor: None,
        }
    }

    fn reset_screen(&mut self, rows: u16) {
        *self = Self::new(rows);
    }

    fn observe(&mut self, sequence: &[u8], screen: &vt100::Screen) {
        self.rows = screen.size().0;
        if matches!(sequence, b"\x1bc") {
            self.reset_screen(self.rows);
            return;
        }
        let Some((parameters, intermediates, final_byte)) = csi_parts(sequence) else {
            match sequence {
                b"\x1b7" => self.save_cursor(screen),
                b"\x1b8" => self.restore_cursor(),
                _ => {}
            }
            return;
        };

        match (intermediates, final_byte) {
            (b"", b'r') => {
                let params = numeric_params(parameters);
                let top = params.first().copied().flatten().unwrap_or(1).max(1);
                let bottom = params
                    .get(1)
                    .copied()
                    .flatten()
                    .unwrap_or(self.rows)
                    .min(self.rows);
                self.scroll_region = (top < bottom).then_some((top - 1, bottom - 1));
            }
            (b"", b'h' | b'l') => {
                let enabled = final_byte == b'h';
                if !parameters.starts_with(b"?") {
                    for mode in numeric_params(parameters).into_iter().flatten() {
                        if mode == 4 {
                            self.insert_mode = enabled;
                        }
                    }
                } else {
                    for mode in numeric_params(&parameters[1..]).into_iter().flatten() {
                        match mode {
                            6 => self.origin_mode = enabled,
                            7 => self.auto_wrap_mode = enabled,
                            45 => self.reverse_wrap_mode = enabled,
                            1004 => self.focus_mode = enabled,
                            1007 => self.alternate_scroll_mode = enabled,
                            1016 => self.pixel_mouse_mode = enabled,
                            // Deliberately do not persist synchronized output
                            // (?2026). A snapshot with a missing reset could
                            // otherwise leave a reconnect permanently frozen.
                            _ => {}
                        }
                    }
                }
            }
            (b" ", b'q') => {
                self.cursor_style = numeric_params(parameters)
                    .first()
                    .copied()
                    .flatten()
                    .unwrap_or(0)
                    .min(6);
            }
            (b"", b'm') => self.observe_sgr(sequence, parameters),
            (b"", b's') if parameters.is_empty() => self.save_cursor(screen),
            (b"", b'u') if parameters.is_empty() => self.restore_cursor(),
            (b"!", b'p') => self.reset_screen(self.rows),
            _ => {}
        }
    }

    fn observe_sgr(&mut self, sequence: &[u8], parameters: &[u8]) {
        let params = numeric_params(parameters);
        if sgr_resets(parameters) {
            self.attrs.clear();
            self.attrs_bytes = 0;
        }
        if parameters.is_empty() || (params.len() == 1 && params[0].unwrap_or(0) == 0) {
            return;
        }
        if self.attrs_bytes.saturating_add(sequence.len()) > MAX_TRACKED_SGR_BYTES {
            // Stay bounded under hostile output. Cell rendering still comes
            // from vt100; only saved-cursor restoration may lose old attrs.
            self.attrs.clear();
            self.attrs_bytes = 0;
        }
        self.attrs.push(sequence.to_vec());
        self.attrs_bytes += sequence.len();
    }

    fn save_cursor(&mut self, screen: &vt100::Screen) {
        let (row, col) = screen.cursor_position();
        self.saved_cursor = Some(SavedCursor {
            row,
            col,
            origin_mode: self.origin_mode,
            attrs: self.attrs.clone(),
        });
    }

    fn restore_cursor(&mut self) {
        if let Some(saved) = &self.saved_cursor {
            self.origin_mode = saved.origin_mode;
            self.attrs = saved.attrs.clone();
            self.attrs_bytes = self.attrs.iter().map(Vec::len).sum();
        }
    }

    fn write_restore(&self, output: &mut Vec<u8>, screen: &vt100::Screen) {
        let pending_wrap = pending_wrap_cell(screen);
        self.write_restore_at(output, screen.cursor_position(), pending_wrap.as_ref());
    }

    fn write_restore_at(
        &self,
        output: &mut Vec<u8>,
        cursor: (u16, u16),
        pending_wrap: Option<&PendingWrap>,
    ) {
        if let Some(saved) = &self.saved_cursor {
            self.write_scroll_region(output);
            write_dec_mode(output, 6, saved.origin_mode);
            output.extend_from_slice(b"\x1b[m");
            for attrs in &saved.attrs {
                output.extend_from_slice(attrs);
            }
            self.write_cursor_position(output, saved.row, saved.col, saved.origin_mode);
            output.extend_from_slice(b"\x1b7");
        }

        write_ansi_mode(output, 4, self.insert_mode);
        write_dec_mode(output, 7, self.auto_wrap_mode);
        write_dec_mode(output, 45, self.reverse_wrap_mode);
        write_dec_mode(output, 1004, self.focus_mode);
        write_dec_mode(output, 1007, self.alternate_scroll_mode);
        write_dec_mode(output, 1016, self.pixel_mouse_mode);
        self.write_scroll_region(output);
        write_dec_mode(output, 6, self.origin_mode);
        output.extend_from_slice(format!("\x1b[{} q", self.cursor_style).as_bytes());
        let (row, col) = cursor;
        if let Some(pending_wrap) = pending_wrap {
            self.write_cursor_position(output, row, pending_wrap.start_col, self.origin_mode);
            output.extend_from_slice(&pending_wrap.bytes);
            self.write_attrs(output);
        } else {
            self.write_attrs(output);
            self.write_cursor_position(output, row, col, self.origin_mode);
        }
    }

    fn write_attrs(&self, output: &mut Vec<u8>) {
        output.extend_from_slice(b"\x1b[m");
        for attrs in &self.attrs {
            output.extend_from_slice(attrs);
        }
    }

    fn remap_positions(&mut self, plan: &ReflowPlan) {
        self.rows = plan.rows;
        self.scroll_region = self.scroll_region.and_then(|(top, bottom)| {
            let bottom = bottom.min(plan.rows.saturating_sub(1));
            (top < bottom).then_some((top, bottom))
        });
        if let Some(saved) = self.saved_cursor.as_mut() {
            (saved.row, saved.col) = plan.map_position(saved.row, saved.col);
        }
    }

    fn write_scroll_region(&self, output: &mut Vec<u8>) {
        if let Some((top, bottom)) = self.scroll_region {
            output.extend_from_slice(format!("\x1b[{};{}r", top + 1, bottom + 1).as_bytes());
        } else {
            output.extend_from_slice(b"\x1b[r");
        }
    }

    fn write_cursor_position(&self, output: &mut Vec<u8>, row: u16, col: u16, origin_mode: bool) {
        let row = if origin_mode {
            row.saturating_sub(self.scroll_region.map_or(0, |(top, _)| top))
        } else {
            row
        };
        output.extend_from_slice(format!("\x1b[{};{}H", row + 1, col + 1).as_bytes());
    }
}

fn write_ansi_mode(output: &mut Vec<u8>, mode: u16, enabled: bool) {
    output.extend_from_slice(format!("\x1b[{mode}{}", if enabled { 'h' } else { 'l' }).as_bytes());
}

fn write_dec_mode(output: &mut Vec<u8>, mode: u16, enabled: bool) {
    output.extend_from_slice(format!("\x1b[?{mode}{}", if enabled { 'h' } else { 'l' }).as_bytes());
}

fn csi_parts(sequence: &[u8]) -> Option<(&[u8], &[u8], u8)> {
    let body = if sequence.starts_with(b"\x1b[") {
        &sequence[2..]
    } else if sequence.starts_with(b"\x9b") {
        &sequence[1..]
    } else {
        return None;
    };
    let (&final_byte, before_final) = body.split_last()?;
    if !(0x40..=0x7e).contains(&final_byte) {
        return None;
    }
    let intermediate_start = before_final
        .iter()
        .position(|byte| (0x20..=0x2f).contains(byte))
        .unwrap_or(before_final.len());
    Some((
        &before_final[..intermediate_start],
        &before_final[intermediate_start..],
        final_byte,
    ))
}

fn numeric_params(parameters: &[u8]) -> Vec<Option<u16>> {
    if parameters.is_empty() {
        return Vec::new();
    }
    parameters
        .split(|byte| *byte == b';')
        .map(|parameter| {
            if parameter.is_empty() {
                None
            } else {
                std::str::from_utf8(parameter).ok()?.parse().ok()
            }
        })
        .collect()
}

fn sgr_resets(parameters: &[u8]) -> bool {
    if parameters.is_empty() {
        return true;
    }
    let parameters = parameters.split(|byte| *byte == b';').collect::<Vec<_>>();
    let mut index = 0;
    while index < parameters.len() {
        let value = std::str::from_utf8(parameters[index])
            .ok()
            .and_then(|value| value.parse::<u16>().ok());
        match value {
            None if parameters[index].is_empty() => return true,
            Some(0) => return true,
            Some(38 | 48 | 58) => {
                let color_mode = parameters
                    .get(index + 1)
                    .and_then(|value| std::str::from_utf8(value).ok())
                    .and_then(|value| value.parse::<u16>().ok());
                index += match color_mode {
                    Some(2) => 5,
                    Some(5) => 3,
                    _ => 1,
                };
            }
            _ => index += 1,
        }
    }
    false
}

fn terminal_query_response(
    sequence: &[u8],
    screen: &vt100::Screen,
    execution: &ExecutionState,
    pixel_width: u16,
    pixel_height: u16,
) -> Option<Vec<u8>> {
    if sequence == b"\x1bZ" {
        return Some(b"\x1b[?1;2c".to_vec());
    }
    let (parameters, intermediates, final_byte) = csi_parts(sequence)?;
    if intermediates == b"$" && final_byte == b'p' {
        let private = parameters.starts_with(b"?");
        let mode = numeric_params(if private {
            &parameters[1..]
        } else {
            parameters
        })
        .first()
        .copied()
        .flatten()?;
        let status = terminal_mode_status(mode, private, screen, execution);
        return Some(
            format!(
                "\x1b[{}{};{}$y",
                if private { "?" } else { "" },
                mode,
                status
            )
            .into_bytes(),
        );
    }
    if !intermediates.is_empty() {
        return None;
    }
    match (parameters, final_byte) {
        (b"" | b"0", b'c') => Some(b"\x1b[?1;2c".to_vec()),
        (b">" | b">0", b'c') => Some(b"\x1b[>0;276;0c".to_vec()),
        (b"5", b'n') => Some(b"\x1b[0n".to_vec()),
        (b"6", b'n') | (b"?6", b'n') => {
            let (row, col) = screen.cursor_position();
            let row = if execution.origin_mode {
                row.saturating_sub(execution.scroll_region.map_or(0, |(top, _)| top))
            } else {
                row
            };
            Some(
                format!(
                    "\x1b[{}{};{}R",
                    if parameters.starts_with(b"?") {
                        "?"
                    } else {
                        ""
                    },
                    row + 1,
                    col + 1
                )
                .into_bytes(),
            )
        }
        (b"18", b't') => {
            let (rows, cols) = screen.size();
            Some(format!("\x1b[8;{rows};{cols}t").into_bytes())
        }
        (b"14", b't') => Some(format!("\x1b[4;{pixel_height};{pixel_width}t").into_bytes()),
        (b"16", b't') => {
            let (rows, cols) = screen.size();
            let cell_height = pixel_height.checked_div(rows).unwrap_or(0);
            let cell_width = pixel_width.checked_div(cols).unwrap_or(0);
            Some(format!("\x1b[6;{cell_height};{cell_width}t").into_bytes())
        }
        _ => None,
    }
}

fn terminal_mode_status(
    mode: u16,
    private: bool,
    screen: &vt100::Screen,
    execution: &ExecutionState,
) -> u8 {
    let enabled = if private {
        match mode {
            1 => formatted_mode_enabled(screen, b"\x1b[?1h"),
            6 => execution.origin_mode,
            7 => execution.auto_wrap_mode,
            9 => matches!(
                screen.mouse_protocol_mode(),
                vt100::MouseProtocolMode::Press
            ),
            25 => !screen.hide_cursor(),
            45 => execution.reverse_wrap_mode,
            47 | 1047 | 1049 => screen.alternate_screen(),
            66 => formatted_mode_enabled(screen, b"\x1b="),
            1000 => matches!(
                screen.mouse_protocol_mode(),
                vt100::MouseProtocolMode::PressRelease
            ),
            1002 => matches!(
                screen.mouse_protocol_mode(),
                vt100::MouseProtocolMode::ButtonMotion
            ),
            1003 => matches!(
                screen.mouse_protocol_mode(),
                vt100::MouseProtocolMode::AnyMotion
            ),
            1004 => execution.focus_mode,
            1007 => execution.alternate_scroll_mode,
            1016 => execution.pixel_mouse_mode,
            2004 => formatted_mode_enabled(screen, b"\x1b[?2004h"),
            _ => return 0,
        }
    } else {
        match mode {
            4 => execution.insert_mode,
            _ => return 0,
        }
    };
    if enabled { 1 } else { 2 }
}

fn formatted_mode_enabled(screen: &vt100::Screen, enabled_sequence: &[u8]) -> bool {
    screen
        .input_mode_formatted()
        .windows(enabled_sequence.len())
        .any(|bytes| bytes == enabled_sequence)
}

#[derive(Debug, Clone)]
struct CompletedSequence {
    alternate_mode: AlternateMode,
    erase_scrollback: bool,
    bytes: Vec<u8>,
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

#[derive(Debug)]
struct ReflowPlan {
    bytes: Vec<u8>,
    rows: u16,
    cols: u16,
    source_cols: u16,
    history_rows: usize,
    groups: Vec<ReflowGroup>,
    total_rows: usize,
    cursor: (u16, u16),
    pending_wrap: Option<PendingWrap>,
}

#[derive(Debug)]
struct ReflowGroup {
    source_start: usize,
    source_end: usize,
    target_start: usize,
}

impl ReflowPlan {
    fn map_position(&self, row: u16, col: u16) -> (u16, u16) {
        let source_row = self.history_rows + usize::from(row);
        let Some(group) = self
            .groups
            .iter()
            .find(|group| (group.source_start..=group.source_end).contains(&source_row))
        else {
            return (
                row.min(self.rows.saturating_sub(1)),
                col.min(self.cols.saturating_sub(1)),
            );
        };
        let offset =
            (source_row - group.source_start) * usize::from(self.source_cols) + usize::from(col);
        let pending_wrap = col >= self.source_cols && offset.is_multiple_of(usize::from(self.cols));
        let target_row =
            group.target_start + offset / usize::from(self.cols) - usize::from(pending_wrap);
        let viewport_base = self.total_rows.saturating_sub(usize::from(self.rows));
        (
            u16::try_from(target_row.saturating_sub(viewport_base))
                .unwrap_or(u16::MAX)
                .min(self.rows.saturating_sub(1)),
            if pending_wrap {
                self.cols
            } else {
                u16::try_from(offset % usize::from(self.cols)).unwrap()
            },
        )
    }
}

struct ReflowRow {
    bytes: Vec<u8>,
    wrapped: bool,
    content_width: usize,
}

#[derive(Clone, Debug)]
struct PendingWrap {
    start_col: u16,
    width: u16,
    bytes: Vec<u8>,
}

fn reflow_plan(screen: &vt100::Screen, rows: u16, cols: u16) -> ReflowPlan {
    let mut source = screen.clone();
    let (_, source_cols) = source.size();
    source.set_scrollback(usize::MAX);
    let history_rows = source.scrollback();
    let mut source_rows = Vec::with_capacity(history_rows + usize::from(source.size().0));

    for offset in (1..=history_rows).rev() {
        source.set_scrollback(offset);
        let bytes = source
            .rows_formatted(0, source_cols)
            .next()
            .unwrap_or_default();
        source_rows.push(ReflowRow {
            bytes,
            wrapped: source.row_wrapped(0),
            content_width: row_content_width(&source, 0, source_cols),
        });
    }

    source.set_scrollback(0);
    let formatted_rows = source.rows_formatted(0, source_cols).collect::<Vec<_>>();
    let cursor_row = usize::from(source.cursor_position().0);
    let mut last_live_row = cursor_row;
    for (row, bytes) in formatted_rows.iter().enumerate() {
        if !bytes.is_empty()
            || source.row_wrapped(u16::try_from(row).unwrap())
            || row_content_width(&source, u16::try_from(row).unwrap(), source_cols) > 0
        {
            last_live_row = row;
        }
    }
    for (row, bytes) in formatted_rows
        .into_iter()
        .enumerate()
        .take(last_live_row + 1)
    {
        let row = u16::try_from(row).unwrap();
        source_rows.push(ReflowRow {
            bytes,
            wrapped: source.row_wrapped(row),
            content_width: row_content_width(&source, row, source_cols),
        });
    }

    let mut output = b"\x1b[m\x1b[H\x1b[J".to_vec();
    let mut groups = Vec::new();
    let mut group_start = 0;
    let mut group_width = 0;
    let mut target_start = 0;
    for (index, row) in source_rows.iter().enumerate() {
        output.extend_from_slice(&row.bytes);
        group_width += if row.wrapped {
            usize::from(source_cols)
        } else {
            row.content_width
        };
        if !row.wrapped || index + 1 == source_rows.len() {
            let target_height = group_width.div_ceil(usize::from(cols)).max(1);
            groups.push(ReflowGroup {
                source_start: group_start,
                source_end: index,
                target_start,
            });
            target_start += target_height;
            group_start = index + 1;
            group_width = 0;
            if index + 1 != source_rows.len() {
                output.extend_from_slice(b"\r\n");
            }
        }
    }

    let mut plan = ReflowPlan {
        bytes: output,
        rows,
        cols,
        source_cols,
        history_rows,
        groups,
        total_rows: target_start,
        cursor: (0, 0),
        pending_wrap: None,
    };
    let (cursor_row, cursor_col) = screen.cursor_position();
    plan.cursor = plan.map_position(cursor_row, cursor_col);
    if plan.cursor.1 == cols {
        plan.pending_wrap = pending_wrap_cell(screen).map(|mut pending_wrap| {
            pending_wrap.start_col = cols.saturating_sub(pending_wrap.width);
            pending_wrap
        });
    }
    plan
}

fn row_content_width(screen: &vt100::Screen, row: u16, cols: u16) -> usize {
    (0..cols)
        .rev()
        .find_map(|col| {
            let cell = screen.cell(row, col)?;
            (cell.has_contents() || cell.is_wide_continuation()).then_some(usize::from(col) + 1)
        })
        .unwrap_or(0)
}

fn pending_wrap_cell(screen: &vt100::Screen) -> Option<PendingWrap> {
    let (rows, cols) = screen.size();
    let (row, col) = screen.cursor_position();
    if row >= rows || col < cols || cols == 0 {
        return None;
    }
    let last_col = cols - 1;
    let continuation = screen.cell(row, last_col)?.is_wide_continuation();
    let width = if continuation { 2.min(cols) } else { 1 };
    let start_col = cols - width;
    let bytes = screen
        .rows_formatted(start_col, width)
        .nth(usize::from(row))?;
    (!bytes.is_empty()).then_some(PendingWrap {
        start_col,
        width,
        bytes,
    })
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

fn snapshot_screen_with_execution(screen: &vt100::Screen, execution: &ExecutionState) -> Vec<u8> {
    let mut snapshot = snapshot_screen(screen);
    execution.write_restore(&mut snapshot, screen);
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

        state.resize(10, 500, 0, 0);

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
    fn resize_reflows_completed_lines_at_narrower_and_wider_widths() {
        let mut terminal = CanonicalTerminal::new(4, 5, 20);
        terminal.process(b"abcdefghij\r\nEND");

        terminal.resize(4, 4, 20, 0, 0);
        assert_eq!(terminal.parser.screen().contents(), "abcdefghij\nEND");
        assert!(terminal.parser.screen().row_wrapped(0));
        assert!(terminal.parser.screen().row_wrapped(1));
        assert!(!terminal.parser.screen().row_wrapped(2));
        assert_eq!(terminal.parser.screen().cursor_position(), (3, 3));

        terminal.resize(4, 8, 20, 0, 0);
        assert_eq!(terminal.parser.screen().contents(), "abcdefghij\nEND");
        assert!(terminal.parser.screen().row_wrapped(0));
        assert!(!terminal.parser.screen().row_wrapped(1));
        assert_eq!(terminal.parser.screen().cursor_position(), (2, 3));
    }

    #[test]
    fn resize_moves_height_shrunk_content_into_scrollback_and_restores_it() {
        let mut terminal = CanonicalTerminal::new(3, 10, 20);
        terminal.process(b"one\r\ntwo\r\nthree");

        terminal.resize(2, 10, 20, 0, 0);
        let mut shrunken = terminal.parser.screen().clone();
        shrunken.set_scrollback(usize::MAX);
        assert_eq!(shrunken.scrollback(), 1);
        assert_eq!(shrunken.contents(), "one\ntwo");
        assert_eq!(terminal.parser.screen().contents(), "two\nthree");
        assert_eq!(terminal.parser.screen().cursor_position(), (1, 5));

        terminal.resize(4, 10, 20, 0, 0);
        assert_eq!(terminal.parser.screen().scrollback(), 0);
        assert_eq!(terminal.parser.screen().contents(), "one\ntwo\nthree");
        assert_eq!(terminal.parser.screen().cursor_position(), (2, 5));
    }

    #[test]
    fn snapshot_and_height_resize_preserve_delayed_autowrap() {
        let mut terminal = CanonicalTerminal::new(3, 5, 20);
        terminal.process(b"\x1b[31mabcde\x1b[32m");
        assert_eq!(terminal.parser.screen().cursor_position(), (0, 5));

        let mut reconstructed = CanonicalTerminal::new(3, 5, 20);
        reconstructed.process(&terminal.snapshot());
        assert_screen_eq(reconstructed.parser.screen(), terminal.parser.screen());
        assert_eq!(reconstructed.parser.screen().cursor_position(), (0, 5));

        terminal.process(b"Z");
        reconstructed.process(b"Z");
        assert_screen_eq(reconstructed.parser.screen(), terminal.parser.screen());
        assert!(reconstructed.parser.screen().row_wrapped(0));
        assert_eq!(
            reconstructed.parser.screen().cell(1, 0).unwrap().contents(),
            "Z"
        );
        assert_eq!(reconstructed.parser.screen().cursor_position(), (1, 1));

        let mut resized = CanonicalTerminal::new(3, 5, 20);
        resized.process(b"abcde");
        resized.resize(2, 5, 20, 0, 0);
        assert_eq!(resized.parser.screen().cursor_position(), (0, 5));
        resized.process(b"Z");
        assert!(resized.parser.screen().row_wrapped(0));
        assert_eq!(resized.parser.screen().cell(1, 0).unwrap().contents(), "Z");
    }

    #[test]
    fn snapshots_preserve_every_utf8_split_without_treating_continuations_as_c1() {
        for character in ['؛', '\u{0810}', '😀'] {
            let encoded = character.to_string().into_bytes();
            assert!((2..=4).contains(&encoded.len()));
            for split in 1..encoded.len() {
                let mut terminal = CanonicalTerminal::new(3, 20, 0);
                terminal.process(b"before-");
                terminal.process(&encoded[..split]);
                assert_eq!(terminal.sequence, EscapeSequence::Ground);
                assert!(terminal.pending.is_empty());
                assert_eq!(terminal.utf8_pending, encoded[..split]);

                let mut reconstructed = CanonicalTerminal::new(3, 20, 0);
                reconstructed.process(&terminal.snapshot());
                terminal.process(&encoded[split..]);
                reconstructed.process(&encoded[split..]);

                assert_screen_eq(reconstructed.parser.screen(), terminal.parser.screen());
                assert!(terminal.drain_responses().is_empty());
                assert!(reconstructed.drain_responses().is_empty());
                assert_eq!(
                    terminal.parser.screen().contents(),
                    format!("before-{character}")
                );
            }
        }
    }

    #[test]
    fn snapshot_restores_scroll_region_origin_and_saved_cursor_for_continuation() {
        let mut terminal = CanonicalTerminal::new(6, 12, 20);
        terminal.process(b"\x1b[2;5r\x1b[?6h\x1b[2;4H\x1b[31m\x1b7");
        terminal.process(b"\x1b[m\x1b[1;1Hcurrent");

        let mut reconstructed = CanonicalTerminal::new(6, 12, 20);
        reconstructed.process(&terminal.snapshot());
        terminal.process(b"\x1b8X\r\nnext");
        reconstructed.process(b"\x1b8X\r\nnext");

        assert_screen_eq(reconstructed.parser.screen(), terminal.parser.screen());
        assert_eq!(reconstructed.execution, terminal.execution);
    }

    #[test]
    fn snapshot_reemits_common_tui_execution_modes_but_not_synchronized_output() {
        let mut terminal = CanonicalTerminal::new(6, 12, 20);
        terminal.process(
            b"\x1b[2;5r\x1b[?6h\x1b[4h\x1b[?7l\x1b[?45h\x1b[?1004h\x1b[?1007h\x1b[?1016h\x1b[5 q\x1b[?2026h",
        );
        let snapshot = terminal.snapshot();
        assert!(!snapshot.windows(8).any(|bytes| bytes == b"\x1b[?2026h"));

        let mut reconstructed = CanonicalTerminal::new(6, 12, 20);
        reconstructed.process(&snapshot);
        assert_eq!(reconstructed.execution, terminal.execution);
    }

    #[test]
    fn snapshot_does_not_mistake_zero_rgb_components_for_sgr_reset() {
        let mut terminal = CanonicalTerminal::new(3, 12, 20);
        terminal.process(b"\x1b[1;44m\x1b[38;2;0;128;255mX");

        let mut reconstructed = CanonicalTerminal::new(3, 12, 20);
        reconstructed.process(&terminal.snapshot());
        terminal.process(b"Y");
        reconstructed.process(b"Y");

        assert_screen_eq(reconstructed.parser.screen(), terminal.parser.screen());
        assert!(reconstructed.parser.screen().cell(0, 1).unwrap().bold());
        assert_eq!(
            reconstructed.parser.screen().cell(0, 1).unwrap().bgcolor(),
            vt100::Color::Idx(4)
        );
    }

    #[test]
    fn terminal_queries_are_answered_once_at_their_exact_boundary() {
        let cases: &[(&[u8], &[u8])] = &[
            (b"\x1bZ", b"\x1b[?1;2c"),
            (b"\x1b[c", b"\x1b[?1;2c"),
            (b"\x1b[0c", b"\x1b[?1;2c"),
            (b"\x1b[>c", b"\x1b[>0;276;0c"),
            (b"\x1b[>0c", b"\x1b[>0;276;0c"),
            (b"\x1b[5n", b"\x1b[0n"),
            (b"\x1b[4$p", b"\x1b[4;2$y"),
            (b"\x1b[?7$p", b"\x1b[?7;1$y"),
            (b"\x1b[?2026$p", b"\x1b[?2026;0$y"),
            (b"\x1b[18t", b"\x1b[8;5;20t"),
            (b"\x1b[14t", b"\x1b[4;0;0t"),
            (b"\x1b[16t", b"\x1b[6;0;0t"),
        ];
        for &(query, expected) in cases {
            for split in 1..query.len() {
                let mut state = TerminalOutputState::new(1024 * 1024, 5, 20);
                state.publish(Bytes::copy_from_slice(&query[..split]));
                assert!(state.drain_responses().is_empty());
                state.publish(Bytes::copy_from_slice(&query[split..]));
                assert_eq!(
                    state.drain_responses(),
                    vec![Bytes::copy_from_slice(expected)]
                );
                assert!(state.drain_responses().is_empty());
                assert!(
                    !state
                        .sync(None)
                        .snapshot
                        .unwrap()
                        .windows(query.len())
                        .any(|bytes| bytes == query)
                );
            }
        }
    }

    #[test]
    fn mode_queries_report_tracked_state_across_split_boundaries() {
        let cases: &[(&[u8], &[u8], &[u8])] = &[
            (b"\x1b[4h", b"\x1b[4$p", b"\x1b[4;1$y"),
            (b"\x1b[?6h", b"\x1b[?6$p", b"\x1b[?6;1$y"),
            (b"\x1b[?7l", b"\x1b[?7$p", b"\x1b[?7;2$y"),
            (b"\x1b[?45h", b"\x1b[?45$p", b"\x1b[?45;1$y"),
            (b"\x1b[?1004h", b"\x1b[?1004$p", b"\x1b[?1004;1$y"),
            (b"\x1b[?1007h", b"\x1b[?1007$p", b"\x1b[?1007;1$y"),
            (b"\x1b[?1016h", b"\x1b[?1016$p", b"\x1b[?1016;1$y"),
        ];
        for &(setup, query, expected) in cases {
            for split in 1..query.len() {
                let mut state = TerminalOutputState::new(1024 * 1024, 5, 20);
                state.publish(Bytes::copy_from_slice(setup));
                state.publish(Bytes::copy_from_slice(&query[..split]));
                assert!(state.drain_responses().is_empty());
                state.publish(Bytes::copy_from_slice(&query[split..]));
                assert_eq!(
                    state.drain_responses(),
                    vec![Bytes::copy_from_slice(expected)]
                );
                assert!(state.drain_responses().is_empty());
            }
        }
    }

    #[test]
    fn cursor_position_queries_use_the_position_at_sequence_completion() {
        let mut state = TerminalOutputState::new(1024 * 1024, 5, 20);
        state.publish(Bytes::from_static(b"\x1b[3;4H\x1b[6"));
        assert!(state.drain_responses().is_empty());
        state.publish(Bytes::from_static(b"n\x1b[?6n"));
        assert_eq!(
            state.drain_responses(),
            vec![
                Bytes::from_static(b"\x1b[3;4R"),
                Bytes::from_static(b"\x1b[?3;4R")
            ]
        );
    }

    #[test]
    fn cursor_position_queries_respect_origin_mode() {
        let mut state = TerminalOutputState::new(1024 * 1024, 8, 20);
        state.publish(Bytes::from_static(
            b"\x1b[3;7r\x1b[?6h\x1b[2;4H\x1b[6n\x1b[?6n",
        ));

        assert_eq!(
            state.drain_responses(),
            vec![
                Bytes::from_static(b"\x1b[2;4R"),
                Bytes::from_static(b"\x1b[?2;4R")
            ]
        );
    }

    #[test]
    fn window_queries_report_the_current_pixel_and_cell_dimensions() {
        let mut state = TerminalOutputState::new(1024 * 1024, 24, 80);
        state.resize(24, 80, 800, 480);
        state.publish(Bytes::from_static(b"\x1b[14t\x1b[16t\x1b[18t"));

        assert_eq!(
            state.drain_responses(),
            vec![
                Bytes::from_static(b"\x1b[4;480;800t"),
                Bytes::from_static(b"\x1b[6;20;10t"),
                Bytes::from_static(b"\x1b[8;24;80t"),
            ]
        );
    }

    #[test]
    fn detection_text_renders_the_live_screen_with_leading_indentation() {
        let mut state = TerminalOutputState::new(1024 * 1024, 4, 40);
        state.publish(Bytes::from_static(
            b"Do you want to proceed?\r\n  \xe2\x9d\xaf 1. Yes\r\n    2. No",
        ));

        let text = state.detection_text();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "Do you want to proceed?");
        // Regions such as `bottom_non_empty_lines` depend on the indentation
        // surviving, and trailing blanks being trimmed.
        assert_eq!(lines[1], "  ❯ 1. Yes");
        assert_eq!(lines[2], "    2. No");
        // The unused fourth row contributes an empty trailing line.
        assert_eq!(lines.len(), 3);
        assert!(text.ends_with('\n'), "{text:?}");
    }

    #[test]
    fn detection_text_follows_a_full_screen_agent_onto_the_alternate_screen() {
        let mut state = TerminalOutputState::new(1024 * 1024, 3, 40);
        state.publish(Bytes::from_static(b"shell scrollback\r\n"));
        state.publish(Bytes::from_static(b"\x1b[?1049h\x1b[H\x1b[Jallow command?"));

        assert!(state.alternate_screen());
        let text = state.detection_text();
        assert!(text.contains("allow command?"), "{text:?}");
        assert!(
            !text.contains("shell scrollback"),
            "the alternate screen replaces the shell view: {text:?}"
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
