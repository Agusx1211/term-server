export const TERMINAL_FONT_SIZE_STORAGE_KEY = "term-server:terminal-font-size";
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 24;

export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(value)));
}

export function parseTerminalFontSize(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_TERMINAL_FONT_SIZE;
  return clampTerminalFontSize(Number(value));
}

export function terminalZoomPercent(fontSize: number): number {
  return Math.round((clampTerminalFontSize(fontSize) / DEFAULT_TERMINAL_FONT_SIZE) * 100);
}
