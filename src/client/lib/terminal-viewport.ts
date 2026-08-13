export const TERMINAL_VIEWPORT_SETTLE_MS = 120;
export const TERMINAL_VIEWPORT_MAX_VALUE = 0xffff;
export const TERMINAL_VIEWPORT_MAX_COLS = 500;
export const TERMINAL_VIEWPORT_MAX_ROWS = 300;

export interface TerminalViewportSize {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

type TerminalGridSize = Pick<TerminalViewportSize, "cols" | "rows">;

interface TimerHost {
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(handle: number): void;
}

interface SettledTask {
  schedule(): void;
  cancel(): void;
}

export function terminalViewportSize(
  proposed: TerminalGridSize,
  rendered: TerminalViewportSize,
): TerminalViewportSize | undefined {
  if (![proposed.cols, proposed.rows, rendered.cols, rendered.rows,
    rendered.pixelWidth, rendered.pixelHeight].every((value) => Number.isFinite(value) && value > 0)) {
    return undefined;
  }
  const cols = Math.min(TERMINAL_VIEWPORT_MAX_COLS, terminalViewportValue(proposed.cols));
  const rows = Math.min(TERMINAL_VIEWPORT_MAX_ROWS, terminalViewportValue(proposed.rows));
  return {
    cols,
    rows,
    pixelWidth: terminalViewportValue(rendered.pixelWidth * cols / rendered.cols),
    pixelHeight: terminalViewportValue(rendered.pixelHeight * rows / rendered.rows),
  };
}

export function terminalViewportForServerSize(
  selected: TerminalGridSize,
  latest?: Pick<TerminalViewportSize, "pixelWidth" | "pixelHeight">,
): TerminalViewportSize {
  return {
    ...selected,
    pixelWidth: latest?.pixelWidth ?? 0,
    pixelHeight: latest?.pixelHeight ?? 0,
  };
}

function terminalViewportValue(value: number): number {
  return Math.min(TERMINAL_VIEWPORT_MAX_VALUE, Math.max(1, Math.round(value)));
}

export function nextTerminalViewportReport(
  reportedKey: string,
  nextKey: string,
  socketOpen: boolean,
): string | undefined {
  if (!socketOpen || reportedKey === nextKey) return undefined;
  return nextKey;
}

interface XtermViewportInternal {
  _sync?: () => void;
  queueSync?: () => void;
  scrollToLine?: (line: number, disableSmoothScroll?: boolean) => void;
  _coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } };
}

interface XtermWithViewport {
  buffer?: { active?: { viewportY?: number } };
  _core?: {
    viewport?: XtermViewportInternal;
    _viewport?: XtermViewportInternal;
  };
}

/**
 * Recompute xterm's scrollbar geometry and re-anchor it to the buffer.
 *
 * xterm's Viewport recomputes its scroll range (cell height x buffer length)
 * only on buffer scroll and resize events. Anything that changes the cell
 * metrics without one — a renderer swap (WebGL load or context-loss
 * fallback), font settling, or a snapshot replay parsed while the renderer
 * was paused — leaves the range stale. On a large scrollback the stale range
 * ends short of the real bottom, so the last lines become unreachable until
 * new output happens to arrive. There is no public API for this, so poke the
 * private viewport when it is reachable and fall back to doing nothing.
 *
 * The viewport's sync silently defers while DECSET 2026 (synchronized
 * output) is set, and an agent TUI holds that mode for the whole of every
 * frame — including indefinitely when it stops mid-frame. A deferred sync
 * only flushes on the next render, which a paused or backgrounded renderer
 * never produces, so the gate is lifted for the duration of the explicit
 * re-sync exactly like xterm's own synchronized-output watchdog does.
 */
export function resyncTerminalScrollArea(terminal: unknown): boolean {
  const term = terminal as XtermWithViewport | undefined;
  const core = term?._core;
  const viewport = core?.viewport ?? core?._viewport;
  if (!viewport) return false;
  const modes = viewport._coreService?.decPrivateModes;
  const gated = modes?.synchronizedOutput === true;
  if (gated) modes!.synchronizedOutput = false;
  try {
    if (viewport._sync) viewport._sync();
    else if (viewport.queueSync) viewport.queueSync();
    else return false;
    const viewportY = term?.buffer?.active?.viewportY;
    if (typeof viewportY === "number") viewport.scrollToLine?.(viewportY, true);
  } finally {
    if (gated) modes!.synchronizedOutput = true;
  }
  return true;
}

export function createSettledTask(
  task: () => void,
  delay = TERMINAL_VIEWPORT_SETTLE_MS,
): SettledTask {
  const timers = globalThis as unknown as TimerHost;
  let timer = 0;
  const cancel = () => {
    if (!timer) return;
    timers.clearTimeout(timer);
    timer = 0;
  };
  return {
    schedule() {
      cancel();
      timer = timers.setTimeout(() => {
        timer = 0;
        task();
      }, delay);
    },
    cancel,
  };
}
