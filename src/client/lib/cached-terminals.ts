export const CACHED_TERMINALS_STORAGE_KEY = "term-server:cached-terminals";

// A mounted renderer holds its own scrollback and its own stream, so this is
// browser memory rather than anything the server spends. xterm stores a line as
// one Uint32Array of three words per cell, so a wide pane that has actually
// scrolled its full `--scrollback-lines` is hundreds of megabytes on its own.
// Lines are allocated as they are written, so quiet terminals cost close to
// nothing and the ceiling only binds on a workspace full of busy ones.
export const CACHED_TERMINALS_LIMITS = { min: 0, max: 64, step: 1 } as const;

/**
 * The per-browser override, or `undefined` to follow the server's default.
 *
 * The server sets the default because it knows what it was deployed with; the
 * browser overrides it because it is the one holding the memory, and a phone
 * and a workstation looking at the same server should not have to agree.
 */
export function parseCachedTerminals(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return clampCachedTerminals(parsed);
}

export function clampCachedTerminals(value: number): number {
  return Math.round(
    Math.min(CACHED_TERMINALS_LIMITS.max, Math.max(CACHED_TERMINALS_LIMITS.min, value)),
  );
}

export function resolveCachedTerminals(
  override: number | undefined,
  serverDefault: number,
): number {
  return override ?? clampCachedTerminals(serverDefault);
}

export function describeCachedTerminals(value: number): string {
  if (value === 0) return "Visible panes only";
  return `${value} terminal${value === 1 ? "" : "s"}`;
}
