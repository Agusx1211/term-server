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

function terminalViewportValue(value: number): number {
  return Math.min(TERMINAL_VIEWPORT_MAX_VALUE, Math.max(1, Math.round(value)));
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
