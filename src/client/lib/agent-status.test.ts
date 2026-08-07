import { describe, expect, it } from "vitest";
import { agentStatusPresentation, formatWorkingDuration } from "./agent-status";

describe("agent status presentation", () => {
  const agent = (status: "working" | "blocked" | "idle" | "closed") => ({
    kind: "codex",
    status,
  });

  it("marks a blocked agent as needing a person", () => {
    expect(agentStatusPresentation(agent("blocked"), false)).toEqual({
      tone: "blocked",
      label: "Needs you",
      description: "codex is waiting for input",
    });
  });

  it("keeps a block visible even once the terminal has been seen", () => {
    // A completion is dismissed by looking at it; a block is not, because the
    // agent is still waiting no matter who looked.
    expect(agentStatusPresentation(agent("blocked"), true).tone).toBe("blocked");
  });

  it("shows an unseen completion as ready", () => {
    expect(agentStatusPresentation(agent("idle"), true)).toEqual({
      tone: "attention",
      label: "Ready",
      description: "codex is ready",
    });
  });

  it("describes the remaining states", () => {
    expect(agentStatusPresentation(agent("working"), false).tone).toBe("working");
    expect(agentStatusPresentation(agent("idle"), false).tone).toBe("idle");
    expect(agentStatusPresentation(agent("closed"), false).tone).toBe("closed");
  });

  it("falls back to a generic name when the agent kind is empty", () => {
    expect(agentStatusPresentation({ kind: "", status: "blocked" }, false).description)
      .toBe("agent is waiting for input");
  });
});

describe("working duration", () => {
  it("shows seconds for the first minute", () => {
    expect(formatWorkingDuration(-1_000)).toBe("0s");
    expect(formatWorkingDuration(999)).toBe("0s");
    expect(formatWorkingDuration(59_999)).toBe("59s");
  });

  it("keeps minute and hour transitions compact and readable", () => {
    expect(formatWorkingDuration(60_000)).toBe("1m 00s");
    expect(formatWorkingDuration(3_599_999)).toBe("59m 59s");
    expect(formatWorkingDuration(3_600_000)).toBe("1h 00m");
    expect(formatWorkingDuration(86_399_999)).toBe("23h 59m");
  });

  it("continues counting long-running agents in days", () => {
    expect(formatWorkingDuration(86_400_000)).toBe("1d 00h");
    expect(formatWorkingDuration(187_200_000)).toBe("2d 04h");
  });
});
