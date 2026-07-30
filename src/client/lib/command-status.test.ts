import { describe, expect, it } from "vitest";
import type { ForegroundCommandInfo } from "../../shared/types";
import {
  commandCompletionEvent,
  commandNeedsAttention,
  commandSubtitle,
  markCommandCompletionViewed,
  parseViewedCommandCompletions,
  pruneViewedCommandCompletions,
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

  it("marks completion timestamps monotonically", () => {
    const viewed = { terminal: 20 };
    expect(markCommandCompletionViewed(viewed, "terminal", 19)).toBe(viewed);
    expect(markCommandCompletionViewed(viewed, "terminal", 21)).toEqual({ terminal: 21 });
  });

  it("parses and prunes valid stored completion timestamps", () => {
    expect(parseViewedCommandCompletions(
      '{"one":2,"two":-1,"three":"3","four":1.5}',
    )).toEqual({ one: 2 });
    expect(parseViewedCommandCompletions("not json")).toEqual({});
    expect(parseViewedCommandCompletions("[]")).toEqual({});
    expect(pruneViewedCommandCompletions(
      { keep: 2, remove: 4 },
      new Set(["keep"]),
    )).toEqual({ keep: 2 });
  });

  it("describes running commands, TUIs, and completed commands distinctly", () => {
    expect(commandSubtitle(command({ status: "running" }))).toBe("backup · running");
    expect(commandSubtitle(command({ status: "live" }))).toBe("backup · live");
    expect(commandSubtitle(command())).toBe("backup · finished");
  });
});
