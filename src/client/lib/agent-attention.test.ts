import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../../shared/types";
import {
  agentNeedsAttention,
  markAgentRevisionViewed,
  parseViewedAgentRevisions,
  pruneViewedAgentRevisions,
} from "./agent-attention";

const agent = (status: AgentInfo["status"], revision: number): AgentInfo => ({
  kind: "codex",
  status,
  statusChangedAt: 1000 + revision,
  startedAt: 1000,
  revision,
  summary: null,
});

describe("agent attention", () => {
  it("only flags unseen idle transitions after the initial agent state", () => {
    expect(agentNeedsAttention(agent("working", 2), undefined)).toBe(false);
    expect(agentNeedsAttention(agent("closed", 2), undefined)).toBe(false);
    expect(agentNeedsAttention(agent("idle", 1), undefined)).toBe(false);
    expect(agentNeedsAttention(agent("idle", 3), 2)).toBe(true);
    expect(agentNeedsAttention(agent("idle", 3), 3)).toBe(false);
  });

  it("marks revisions monotonically", () => {
    const viewed = { terminal: 3 };
    expect(markAgentRevisionViewed(viewed, "terminal", 2)).toBe(viewed);
    expect(markAgentRevisionViewed(viewed, "terminal", 4)).toEqual({ terminal: 4 });
  });

  it("parses valid stored revisions and ignores malformed entries", () => {
    expect(parseViewedAgentRevisions('{"one":2,"two":-1,"three":"3","four":1.5}')).toEqual({ one: 2 });
    expect(parseViewedAgentRevisions("not json")).toEqual({});
    expect(parseViewedAgentRevisions("[]")).toEqual({});
  });

  it("prunes terminals that no longer exist", () => {
    expect(pruneViewedAgentRevisions(
      { keep: 2, remove: 4 },
      new Set(["keep"]),
    )).toEqual({ keep: 2 });
  });
});
