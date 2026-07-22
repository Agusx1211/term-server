import { describe, expect, it } from "vitest";
import { formatWorkingDuration } from "./agent-status";

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
