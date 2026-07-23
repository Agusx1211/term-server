import { describe, expect, it } from "vitest";
import type { AgentStatus, TerminalInfo } from "../../shared/types";
import { documentTitle } from "./document-title";

const terminal = (agentStatus?: AgentStatus): TerminalInfo => ({
  id: "terminal",
  name: "terminal",
  workspace: "~",
  path: "terminal",
  cwd: "/tmp",
  shell: "/bin/bash",
  program: "bash",
  color: "#ffffff",
  agent: agentStatus
    ? {
        kind: "codex",
        status: agentStatus,
        statusChangedAt: 0,
        startedAt: 0,
        revision: 1,
        completedAt: null,
        summary: null,
      }
    : null,
  createdAt: 0,
  pid: 1,
  status: "running",
  exitCode: null,
  clients: 1,
});

describe("document title", () => {
  it("counts only agents that are currently working", () => {
    expect(documentTitle([
      terminal("working"),
      terminal("working"),
      terminal("idle"),
      terminal("closed"),
      terminal(),
    ])).toBe("(2) term-server");
  });

  it("shows zero when no agents are working", () => {
    expect(documentTitle([])).toBe("(0) term-server");
  });
});
