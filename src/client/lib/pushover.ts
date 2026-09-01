import type { AgentInfo, PushoverMode, TerminalInfo } from "../../shared/types";

const BELLS_STORAGE_KEY = "term-server:pushover-bells";

const EMPTY_BELLS: ReadonlyMap<string, boolean> = new Map();

let parsedRaw: string | null = null;
let parsedBells: ReadonlyMap<string, boolean> = EMPTY_BELLS;

/**
 * The parsed overrides for the current stored value.
 *
 * The sidebar asks for a bell state per terminal row on every render, and it
 * re-renders on each 1.5 s workspace poll, so the parse is memoized on the raw
 * stored string and only the cheap `getItem` runs per row.
 */
function pushoverBells(): ReadonlyMap<string, boolean> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(BELLS_STORAGE_KEY);
  } catch {
    return EMPTY_BELLS;
  }
  if (raw === parsedRaw) return parsedBells;
  parsedRaw = raw;
  try {
    parsedBells = raw
      ? new Map(Object.entries(JSON.parse(raw) as Record<string, boolean>))
      : EMPTY_BELLS;
  } catch {
    parsedBells = EMPTY_BELLS;
  }
  return parsedBells;
}

/** Load the per-terminal bell overrides as a map of terminal id -> enabled. */
export function loadPushoverBells(): Map<string, boolean> {
  return new Map(pushoverBells());
}

function savePushoverBells(bells: Map<string, boolean>): void {
  localStorage.setItem(BELLS_STORAGE_KEY, JSON.stringify(Object.fromEntries(bells)));
}

/**
 * Whether a terminal should trigger a Pushover alert under the given mode.
 * An explicit per-terminal toggle wins; otherwise the mode provides the
 * default (on for "all", off for "select").
 */
export function pushoverBellEnabled(terminalId: string, mode: PushoverMode): boolean {
  const stored = pushoverBells().get(terminalId);
  if (stored !== undefined) return stored;
  return mode === "all";
}

/** Store the explicit bell preference for a terminal. */
export function setPushoverBell(terminalId: string, enabled: boolean): void {
  const bells = loadPushoverBells();
  bells.set(terminalId, enabled);
  savePushoverBells(bells);
}

export interface PushoverMessage {
  title: string;
  message: string;
}

/**
 * Build the Pushover message for a completed agent. Includes the host, agent,
 * working directory, and the terminal title when one is available.
 */
export function buildPushoverMessage(
  terminal: TerminalInfo,
  agent: AgentInfo,
  hostname: string,
): PushoverMessage {
  const kind = agent.kind || "agent";
  const state = agent.status === "blocked"
    ? "waiting for input"
    : agent.status === "idle"
      ? "ready"
      : "closed";
  const title = terminal.name.trim() || kind;
  const lines = [
    `${kind} is ${state}`,
    `Directory: ${terminal.cwd}`,
  ];
  if (hostname) lines.push(`Host: ${hostname}`);
  return {
    title,
    message: lines.join("\n"),
  };
}
