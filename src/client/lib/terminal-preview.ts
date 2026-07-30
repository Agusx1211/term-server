export type TerminalPreviewMode = "compact" | "large";

export const TERMINAL_PREVIEW_MODE_STORAGE_KEY = "term-server:terminal-preview-mode";
export const DEFAULT_TERMINAL_PREVIEW_MODE: TerminalPreviewMode = "compact";

export function parseTerminalPreviewMode(value: string | null): TerminalPreviewMode {
  return value === "large" ? "large" : DEFAULT_TERMINAL_PREVIEW_MODE;
}

export function terminalPreviewAllowed(pointerType: string): boolean {
  return pointerType !== "touch";
}

export function terminalPreviewPosition(
  anchor: Pick<DOMRect, "right" | "top">,
  viewportHeight: number,
  previewHeight = 330,
) {
  return {
    left: Math.round(anchor.right + 10),
    top: Math.round(Math.max(12, Math.min(anchor.top - 42, viewportHeight - previewHeight - 12))),
  };
}

export function terminalPreviewFontSize(
  cols: number,
  rows: number,
  width: number,
  height: number,
  mode: TerminalPreviewMode,
) {
  const availableWidth = Math.max(1, width - 18);
  const availableHeight = Math.max(1, height - 14);
  const widthBound = availableWidth / (Math.max(2, cols) * 0.61);
  const heightBound = availableHeight / (Math.max(1, rows) * 1.15);
  const maximum = mode === "large" ? 15 : 11;
  return Math.max(2, Math.min(maximum, Math.floor(Math.min(widthBound, heightBound) * 10) / 10));
}
