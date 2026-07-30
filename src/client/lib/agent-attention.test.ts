import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../../shared/types";
import {
  agentNeedsAttention,
  parseViewedAgentRevisions,
} from "./agent-attention";

const agent = (status: AgentInfo["status"], revision: number): AgentInfo => ({
  kind: "codex",
  status,
  statusChangedAt: 1000 + revision,
  startedAt: 1000,
  revision,
  completedAt: status === "idle" ? 1000 + revision : null,
  summary: null,
});

describe("agent attention", () => {
  it("only flags unseen idle transitions after the initial agent state", () => {
    expect(agentNeedsAttention(agent("working", 2), undefined)).toBe(false);
    expect(agentNeedsAttention(agent("closed", 2), undefined)).toBe(false);
    expect(agentNeedsAttention(agent("idle", 1), undefined)).toBe(false);
    expect(agentNeedsAttention(agent("idle", 3), 1002)).toBe(true);
    expect(agentNeedsAttention(agent("idle", 3), 1003)).toBe(false);
  });

  it("does not flag startup idleness before a task completes", () => {
    expect(agentNeedsAttention({ ...agent("idle", 2), completedAt: null }, undefined)).toBe(false);
  });

  it("does not hide a new agent lifecycle when its revision restarts", () => {
    expect(agentNeedsAttention(
      { ...agent("idle", 2), completedAt: 2000 },
      1500,
    )).toBe(true);
  });

  it("parses valid stored revisions and ignores malformed entries", () => {
    expect(parseViewedAgentRevisions('{"one":2,"two":-1,"three":"3","four":1.5}')).toEqual({ one: 2 });
    expect(parseViewedAgentRevisions("not json")).toEqual({});
    expect(parseViewedAgentRevisions("[]")).toEqual({});
  });

});
