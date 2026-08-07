import type { AgentInfo, PushoverMode, TerminalInfo } from "../../shared/types";

const BELLS_STORAGE_KEY = "term-server:pushover-bells";

/** Load the per-terminal bell overrides as a map of terminal id -> enabled. */
export function loadPushoverBells(): Map<string, boolean> {
  try {
    const raw = localStorage.getItem(BELLS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
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
  const stored = loadPushoverBells().get(terminalId);
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
