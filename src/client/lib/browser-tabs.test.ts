import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabCommand } from "../../shared/types";
import {
  BROWSER_VIEW_ID_STORAGE_KEY,
  DIRTY_RESOURCE_CLOSE_ERROR,
  buildBrowserTabSnapshot,
  decideBrowserTabCommand,
  getBrowserViewId,
} from "./browser-tabs";

function storage(values: Record<string, string> = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("browser view identity", () => {
  it("persists one generated id in session storage", () => {
    const session = storage();
    vi.stubGlobal("crypto", { randomUUID: () => "view-one" });

    expect(getBrowserViewId(session)).toBe("view-one");
    expect(getBrowserViewId(session)).toBe("view-one");
    expect(session.getItem(BROWSER_VIEW_ID_STORAGE_KEY)).toBe("view-one");
  });

  it("keeps an existing session id without generating another", () => {
    const session = storage({ [BROWSER_VIEW_ID_STORAGE_KEY]: "view-existing" });
    const randomUUID = vi.fn(() => "unexpected");
    vi.stubGlobal("crypto", { randomUUID });

    expect(getBrowserViewId(session)).toBe("view-existing");
    expect(randomUUID).not.toHaveBeenCalled();
  });
});

describe("browser tab snapshots", () => {
  it("marks only the visible terminal or resource as active", () => {
    expect(buildBrowserTabSnapshot({
      title: "(1) term-server",
      focused: true,
      visible: true,
      terminalPanes: [
        { terminalId: "one", label: "shell" },
        { terminalId: "two", label: "editor" },
      ],
      activeTerminalId: "two",
      terminalViewActive: false,
      resources: [
        { path: "/tmp/one.txt", name: "one.txt", dirty: true },
        { path: "/tmp/two.txt", name: "two.txt", dirty: false },
      ],
      activeResourcePath: "/tmp/two.txt",
      settingsOpen: true,
      settingsActive: true,
    })).toEqual({
      title: "(1) term-server",
      focused: true,
      visible: true,
      terminalPanes: [
        { terminalId: "one", label: "shell", active: false },
        { terminalId: "two", label: "editor", active: false },
      ],
      resources: [
        { path: "/tmp/one.txt", name: "one.txt", dirty: true, active: false },
        { path: "/tmp/two.txt", name: "two.txt", dirty: false, active: false },
      ],
      settingsOpen: true,
      settingsActive: true,
    });
  });
});

describe("browser tab close commands", () => {
  const state = {
    resources: [
      { path: "/tmp/dirty.txt", dirty: true },
      { path: "/tmp/clean.txt", dirty: false },
    ],
  };

  it.each<BrowserTabCommand>([
    { id: "pane", type: "closeTerminalPane", terminalId: "one" },
    { id: "settings", type: "closeSettings" },
    { id: "missing", type: "closeResource", path: "/tmp/missing.txt" },
    { id: "clean", type: "closeResource", path: "/tmp/clean.txt" },
  ])("accepts idempotent command %s", (command) => {
    expect(decideBrowserTabCommand(command, state)).toEqual({ ok: true });
  });

  it("rejects dirty resources without a prompt", () => {
    expect(decideBrowserTabCommand(
      { id: "dirty", type: "closeResource", path: "/tmp/dirty.txt" },
      state,
    )).toEqual({ ok: false, error: DIRTY_RESOURCE_CLOSE_ERROR });
  });
});
