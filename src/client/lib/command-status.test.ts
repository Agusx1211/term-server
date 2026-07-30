import { describe, expect, it } from "vitest";
import type { ForegroundCommandInfo } from "../../shared/types";
import {
  commandCompletionEvent,
  commandNeedsAttention,
  commandSubtitle,
  parseViewedCommandCompletions,
} from "./command-status";

const command = (
  overrides: Partial<ForegroundCommandInfo> = {},
): ForegroundCommandInfo => ({
  name: "backup",
  status: "completed",
  statusChangedAt: 20,
  startedAt: 10,
  completedAt: 20,
  ...overrides,
});

describe("foreground command status", () => {
  it("only exposes completion events for completed long commands", () => {
    expect(commandCompletionEvent(null)).toBeNull();
    expect(commandCompletionEvent(command({ status: "running", completedAt: null }))).toBeNull();
    expect(commandCompletionEvent(command({ status: "live", completedAt: null }))).toBeNull();
    expect(commandCompletionEvent(command())).toBe(20);
  });

  it("flags only unseen completions", () => {
    expect(commandNeedsAttention(command(), undefined)).toBe(true);
    expect(commandNeedsAttention(command(), 19)).toBe(true);
    expect(commandNeedsAttention(command(), 20)).toBe(false);
    expect(commandNeedsAttention(command({ status: "live", completedAt: null }), undefined)).toBe(false);
  });

  it("parses valid stored completion timestamps", () => {
    expect(parseViewedCommandCompletions(
      '{"one":2,"two":-1,"three":"3","four":1.5}',
    )).toEqual({ one: 2 });
    expect(parseViewedCommandCompletions("not json")).toEqual({});
    expect(parseViewedCommandCompletions("[]")).toEqual({});
  });

  it("describes running commands, TUIs, and completed commands distinctly", () => {
    expect(commandSubtitle(command({ status: "running" }))).toBe("backup · running");
    expect(commandSubtitle(command({ status: "live" }))).toBe("backup · live");
    expect(commandSubtitle(command())).toBe("backup · finished");
  });
});
