import { describe, expect, it } from "vitest";
import { captureXtermTailText, firstEventAfter, initialEventCursor } from "./e2e-diagnostics";

describe("E2E xterm diagnostics capture", () => {
  it("keeps the newest 20,000 lines instead of the old prefix", () => {
    const lines = Array.from({ length: 20_001 }, (_, index) => {
      if (index === 0) return "old-prefix";
      if (index === 20_000) return "visible-tail-marker";
      return `line-${index}`;
    });
    const text = captureXtermTailText({
      length: lines.length,
      getLine: (index) => ({ translateToString: () => lines[index]! }),
    });

    expect(text).not.toContain("old-prefix");
    expect(text).toContain("line-1");
    expect(text).toContain("visible-tail-marker");
    expect(text.startsWith("line-1\n")).toBe(true);
  });

  it("starts waits after retained history unless an explicit floor is supplied", () => {
    const events = [{ id: 4 }, { id: 9 }];
    expect(initialEventCursor(events)).toBe(9);
    expect(firstEventAfter(events, initialEventCursor(events), () => true)).toBeUndefined();
    expect(firstEventAfter(events, 4, () => true)).toEqual({ id: 9 });
    expect(initialEventCursor(events, 0)).toBe(0);
  });

  it("rejects an invalid event floor", () => {
    expect(() => initialEventCursor([], -1)).toThrow(/afterId/);
    expect(() => initialEventCursor([], 1.5)).toThrow(/afterId/);
  });
});
