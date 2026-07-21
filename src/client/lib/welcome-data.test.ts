import { describe, expect, it } from "vitest";
import { getAsciiArt, getDailyText, localCalendarDay } from "./welcome-data";

describe("daily welcome content", () => {
  it("keeps the same artwork throughout a local calendar day", () => {
    const morning = new Date(2026, 6, 21, 0, 0, 1);
    const evening = new Date(2026, 6, 21, 23, 59, 59);

    expect(localCalendarDay(morning)).toBe(localCalendarDay(evening));
    expect(getAsciiArt(morning)).toBe(getAsciiArt(evening));
  });

  it("changes artwork on the next local calendar day", () => {
    const today = new Date(2026, 6, 21, 23, 59, 59);
    const tomorrow = new Date(2026, 6, 22, 0, 0, 0);

    expect(localCalendarDay(tomorrow)).toBe(localCalendarDay(today) + 1);
    expect(getAsciiArt(tomorrow)).not.toBe(getAsciiArt(today));
  });

  it("applies runtime values to the daily copy", () => {
    expect(getDailyText(7, new Date(2026, 0, 10)).body).toContain("up to 7 panes");
  });
});
