import { describe, expect, it } from "vitest";
import { captureXtermTailText } from "./e2e-diagnostics";

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
});
