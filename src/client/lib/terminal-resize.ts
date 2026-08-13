interface TerminalLineView {
  translateToString(trimRight?: boolean): string;
}

interface TerminalBufferView {
  length: number;
  baseY: number;
  cursorY: number;
  getLine(index: number): TerminalLineView | undefined;
}

interface ResizableTerminal {
  cols: number;
  rows: number;
  resize(cols: number, rows: number): void;
  buffer?: { normal?: TerminalBufferView };
  _core?: { buffers?: { normal?: { y?: number } } };
}

/**
 * Resize the terminal without deleting content below the cursor.
 *
 * When rows shrink, xterm removes lines from the bottom of the primary buffer
 * while the cursor sits above them, assuming they are blank — it never checks.
 * A TUI that parks its cursor mid-screen (an agent composer, a status frame)
 * over a scrollback therefore loses its bottom lines on every rows shrink: the
 * refresh flow replays the snapshot at the pre-font-settle grid and then
 * shrinks to the real one, and the damaged buffer is checkpointed back to the
 * server as the authoritative snapshot. The terminal then "cuts off" before
 * its real bottom, permanently.
 *
 * xterm only takes its content-preserving branch (move rows into scrollback)
 * when the cursor is on the last buffer row, so when a shrink would remove
 * non-blank rows this parks the internal cursor on that row for a rows-only
 * resize, restores the cursor's absolute position, and applies any column
 * change separately. The alternate buffer keeps xterm's native behavior: it
 * has no scrollback and full-screen apps repaint on resize.
 */
export function resizeTerminalPreservingTail(
  terminal: unknown,
  cols: number,
  rows: number,
): void {
  const term = terminal as ResizableTerminal;
  const normal = term.buffer?.normal;
  const internal = term._core?.buffers?.normal;
  if (
    rows < term.rows
    && normal !== undefined
    && internal !== undefined
    && typeof internal.y === "number"
    && shrinkDeletesContent(normal, term.rows, rows)
  ) {
    const yBefore = internal.y;
    const baseBefore = normal.baseY;
    internal.y = Math.min(term.rows - 1, Math.max(0, normal.length - baseBefore - 1));
    term.resize(term.cols, rows);
    internal.y = Math.min(rows - 1, Math.max(0, baseBefore + yBefore - normal.baseY));
    if (cols !== term.cols) term.resize(cols, rows);
    return;
  }
  term.resize(cols, rows);
}

/** Whether xterm's rows-shrink would pop a non-blank line below the cursor. */
function shrinkDeletesContent(
  normal: TerminalBufferView,
  rows: number,
  newRows: number,
): boolean {
  const beyondGrid = normal.length - (newRows + normal.baseY);
  const belowCursor = normal.length - (normal.baseY + normal.cursorY + 1);
  const pops = Math.min(rows - newRows, beyondGrid, belowCursor);
  for (let index = 0; index < pops; index += 1) {
    const line = normal.getLine(normal.length - 1 - index);
    if (line && line.translateToString(true) !== "") return true;
  }
  return false;
}
