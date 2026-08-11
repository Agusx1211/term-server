export const TERMINAL_SCROLLBACK_STORAGE_KEY = "term-server:scrollback-lines";

export const TERMINAL_SCROLLBACK_LIMITS = {
  min: 1_000,
  max: 2_000_000,
  step: 1_000,
} as const;

/**
 * The per-browser scrollback override, or `undefined` to follow the server's
 * configured default.
 */
export function parseTerminalScrollback(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return clampTerminalScrollback(parsed);
}

export function clampTerminalScrollback(value: number): number {
  return Math.round(
    Math.min(TERMINAL_SCROLLBACK_LIMITS.max, Math.max(TERMINAL_SCROLLBACK_LIMITS.min, value)),
  );
}

export function resolveTerminalScrollback(
  override: number | undefined,
  serverDefault: number,
): number {
  return override === undefined
    ? clampTerminalScrollback(serverDefault)
    : clampTerminalScrollback(override);
}
