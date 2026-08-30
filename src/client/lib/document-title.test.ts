import { describe, expect, it } from "vitest";
import type {
  AgentStatus,
  ForegroundCommandStatus,
  TerminalInfo,
} from "../../shared/types";
import { documentTitle } from "./document-title";

const terminal = (
  agentStatus?: AgentStatus,
  commandStatus?: ForegroundCommandStatus,
): TerminalInfo => ({
  id: "terminal",
  kind: "regular",
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
  command: commandStatus
    ? {
        name: "backup",
        status: commandStatus,
        statusChangedAt: 0,
        startedAt: 0,
        completedAt: commandStatus === "completed" ? 1 : null,
      }
    : null,
  createdAt: 0,
  pid: 1,
  status: "running",
  exitCode: null,
  clients: 1,
});

describe("document title", () => {
  it("counts working agents and long-running commands", () => {
    expect(documentTitle([
      terminal("working"),
      terminal("working"),
      terminal("idle"),
      terminal("closed"),
      terminal(undefined, "running"),
      terminal(undefined, "completed"),
      terminal(undefined, "live"),
      terminal(),
    ])).toBe("(3) term-server");
  });

  it("shows zero when no agents are working", () => {
    expect(documentTitle([])).toBe("(0) term-server");
  });
});
