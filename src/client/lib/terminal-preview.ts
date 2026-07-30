export type TerminalPreviewMode = "compact" | "large";

export interface TerminalPreviewSettings {
  enabled: boolean;
  mode: TerminalPreviewMode;
  hoverDelay: number;
  animationDuration: number;
}

export const TERMINAL_PREVIEW_MODE_STORAGE_KEY = "term-server:terminal-preview-mode";
export const TERMINAL_PREVIEW_SETTINGS_STORAGE_KEY = "term-server:terminal-preview-settings";
export const DEFAULT_TERMINAL_PREVIEW_MODE: TerminalPreviewMode = "compact";
export const TERMINAL_PREVIEW_LIMITS = {
  hoverDelay: { min: 0, max: 1_000, step: 20 },
  animationDuration: { min: 0, max: 400, step: 20 },
} as const;
export const DEFAULT_TERMINAL_PREVIEW_SETTINGS: TerminalPreviewSettings = {
  enabled: true,
  mode: DEFAULT_TERMINAL_PREVIEW_MODE,
  hoverDelay: 260,
  animationDuration: 120,
};

export function parseTerminalPreviewMode(value: string | null): TerminalPreviewMode {
  return value === "large" ? "large" : DEFAULT_TERMINAL_PREVIEW_MODE;
}

const parseDuration = (
  value: unknown,
  fallback: number,
  limits: { min: number; max: number },
) => (
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(limits.min, Math.min(limits.max, value)))
    : fallback
);

export function parseTerminalPreviewSettings(
  value: string | null,
  legacyMode: string | null = null,
): TerminalPreviewSettings {
  let parsed: Partial<TerminalPreviewSettings> = {};
  try {
    const candidate = value ? JSON.parse(value) : null;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate as Partial<TerminalPreviewSettings>;
    }
  } catch {
    // Fall back to defaults and the legacy mode preference.
  }
  return {
    enabled: typeof parsed.enabled === "boolean"
      ? parsed.enabled
      : DEFAULT_TERMINAL_PREVIEW_SETTINGS.enabled,
    mode: parseTerminalPreviewMode(
      typeof parsed.mode === "string" ? parsed.mode : legacyMode,
    ),
    hoverDelay: parseDuration(
      parsed.hoverDelay,
      DEFAULT_TERMINAL_PREVIEW_SETTINGS.hoverDelay,
      TERMINAL_PREVIEW_LIMITS.hoverDelay,
    ),
    animationDuration: parseDuration(
      parsed.animationDuration,
      DEFAULT_TERMINAL_PREVIEW_SETTINGS.animationDuration,
      TERMINAL_PREVIEW_LIMITS.animationDuration,
    ),
  };
}

export function terminalPreviewAllowed(enabled: boolean, pointerType: string): boolean {
  return enabled && pointerType !== "touch";
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
