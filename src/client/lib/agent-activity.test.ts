import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../../shared/types";
import { agentSubtitle } from "./agent-activity";

const agent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  kind: "codex",
  status: "working",
  statusChangedAt: 1,
  startedAt: 1,
  revision: 1,
  completedAt: null,
  summary: null,
  ...overrides,
});

describe("agent activity subtitle", () => {
  it("shows native transient activity inside the existing subtitle", () => {
    expect(agentSubtitle(agent({
      activity: { label: "running a command", updatedAt: 2 },
    }))).toBe("codex · running a command…");
  });

  it("keeps the existing fallback label without active native metadata", () => {
    expect(agentSubtitle(agent())).toBe("codex agent");
    expect(agentSubtitle(agent({
      status: "idle",
      activity: { label: "thinking", updatedAt: 2 },
    }))).toBe("codex agent");
  });
});
