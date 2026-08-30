import type {
  BrowserResourceSnapshot,
  BrowserTabCommand,
  BrowserTabCommandAck,
  BrowserTabSnapshot,
  BrowserTerminalPaneSnapshot,
} from "../../shared/types";

export const BROWSER_VIEW_ID_STORAGE_KEY = "term-server:browser-view-id";

export interface BrowserTabSnapshotTerminalInput {
  terminalId: string;
  label: string;
}

export interface BrowserTabSnapshotResourceInput {
  path: string;
  name: string;
  dirty: boolean;
}

export interface BrowserTabSnapshotInput {
  title: string;
  focused: boolean;
  visible: boolean;
  terminalPanes: readonly BrowserTabSnapshotTerminalInput[];
  activeTerminalId?: string;
  terminalViewActive: boolean;
  resources: readonly BrowserTabSnapshotResourceInput[];
  activeResourcePath?: string;
  settingsOpen: boolean;
  settingsActive: boolean;
}

export interface BrowserTabCommandState {
  resources: readonly Pick<BrowserResourceSnapshot, "path" | "dirty">[];
}

export type BrowserTabCommandDecision =
  | { ok: true }
  | { ok: false; error: string };

export const DIRTY_RESOURCE_CLOSE_ERROR = "Cannot close a resource with unsaved changes";

interface BrowserViewIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Return the session-scoped browser view id, creating it once when needed. */
export function getBrowserViewId(
  storage: BrowserViewIdStorage = sessionStorage,
): string {
  const existing = storage.getItem(BROWSER_VIEW_ID_STORAGE_KEY);
  if (existing) return existing;

  const generated = globalThis.crypto?.randomUUID?.();
  if (!generated) throw new Error("crypto.randomUUID is unavailable");
  storage.setItem(BROWSER_VIEW_ID_STORAGE_KEY, generated);
  return generated;
}

/** Build the exact payload sent to the browser-tab supervisor endpoint. */
export function buildBrowserTabSnapshot(input: BrowserTabSnapshotInput): BrowserTabSnapshot {
  const terminalPanes: BrowserTerminalPaneSnapshot[] = input.terminalPanes.map((terminal) => ({
    terminalId: terminal.terminalId,
    label: terminal.label,
    active: input.terminalViewActive && terminal.terminalId === input.activeTerminalId,
  }));
  const resources = input.resources.map((resource) => ({
    path: resource.path,
    name: resource.name,
    dirty: resource.dirty,
    active: !input.settingsActive && resource.path === input.activeResourcePath,
  }));

  return {
    title: input.title,
    focused: input.focused,
    visible: input.visible,
    terminalPanes,
    resources,
    settingsOpen: input.settingsOpen,
    settingsActive: input.settingsActive,
  };
}

/**
 * Decide whether a remote close command may be applied locally. Missing panes,
 * resources, and Settings are intentionally successful: the command protocol
 * is at-least-once, so retries must not make a harmless close fail.
 */
export function decideBrowserTabCommand(
  command: BrowserTabCommand,
  state: BrowserTabCommandState,
): BrowserTabCommandDecision {
  switch (command.type) {
    case "closeTerminalPane":
      return { ok: true };
    case "closeResource": {
      const resource = state.resources.find((candidate) => candidate.path === command.path);
      return resource?.dirty
        ? { ok: false, error: DIRTY_RESOURCE_CLOSE_ERROR }
        : { ok: true };
    }
    case "closeSettings":
      return { ok: true };
  }
}

export function commandAck(decision: BrowserTabCommandDecision): BrowserTabCommandAck {
  return decision.ok ? { ok: true } : { ok: false, error: decision.error };
}
