import { describe, expect, it } from "vitest";
import {
  clampTerminalFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  parseTerminalFontSize,
  terminalZoomPercent,
} from "./terminal-zoom";

describe("terminal zoom", () => {
  it("uses the default for missing or invalid stored values", () => {
    expect(parseTerminalFontSize(null)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(parseTerminalFontSize("")).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(parseTerminalFontSize("not-a-number")).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("rounds and bounds font sizes to the supported range", () => {
    expect(clampTerminalFontSize(11.6)).toBe(12);
    expect(parseTerminalFontSize("1")).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(parseTerminalFontSize("100")).toBe(MAX_TERMINAL_FONT_SIZE);
  });

  it("reports zoom relative to the default font size", () => {
    expect(terminalZoomPercent(DEFAULT_TERMINAL_FONT_SIZE)).toBe(100);
    expect(terminalZoomPercent(MIN_TERMINAL_FONT_SIZE)).toBe(62);
  });
});
