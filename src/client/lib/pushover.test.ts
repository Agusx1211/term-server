import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, TerminalInfo } from "../../shared/types";
import {
  buildPushoverMessage,
  loadPushoverBells,
  pushoverBellEnabled,
  setPushoverBell,
} from "./pushover";

function terminal(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: "term-1",
    kind: "regular",
    name: "fix the bug",
    workspace: "workspace",
    path: "/workspace",
    cwd: "/workspace/project",
    shell: "zsh",
    program: "zsh",
    color: "#ffffff",
    createdAt: 0,
    pid: 1,
    status: "running",
    exitCode: null,
    clients: 1,
    agent: null,
    command: null,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    kind: "codex",
    status: "idle",
    statusChangedAt: 1,
    startedAt: 0,
    revision: 1,
    completedAt: 1,
    summary: null,
    ...overrides,
  };
}

function installLocalStorage(): void {
  let store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    clear: () => store.clear(),
  });
}

describe("pushover", () => {
  beforeEach(() => {
    installLocalStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults the bell to on for all and off for select", () => {
    expect(pushoverBellEnabled("a", "all")).toBe(true);
    expect(pushoverBellEnabled("a", "select")).toBe(false);
  });

  it("stores explicit bell overrides", () => {
    setPushoverBell("a", true);
    expect(pushoverBellEnabled("a", "select")).toBe(true);
    expect(loadPushoverBells().get("a")).toBe(true);

    setPushoverBell("a", false);
    expect(pushoverBellEnabled("a", "all")).toBe(false);
  });

  it("builds a message with host, directory, kind, and title", () => {
    const message = buildPushoverMessage(
      terminal({ name: "Refactor API" }),
      agent({ kind: "pi" }),
      "my-machine",
    );
    expect(message.title).toBe("Refactor API");
    expect(message.message).toContain("pi is ready");
    expect(message.message).toContain("/workspace/project");
    expect(message.message).toContain("my-machine");
  });

  it("falls back to the agent kind as the title when the terminal has none", () => {
    const message = buildPushoverMessage(
      terminal({ name: "" }),
      agent({ kind: "claude", status: "closed" }),
      "",
    );
    expect(message.title).toBe("claude");
    expect(message.message).toContain("claude is closed");
  });
});
