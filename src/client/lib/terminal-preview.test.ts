import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_PREVIEW_SETTINGS,
  parseTerminalPreviewMode,
  parseTerminalPreviewSettings,
  terminalPreviewAllowed,
  terminalPreviewFontSize,
  terminalPreviewPosition,
} from "./terminal-preview";

describe("terminal preview preferences", () => {
  it("defaults unknown values to the compact preview", () => {
    expect(parseTerminalPreviewMode(null)).toBe("compact");
    expect(parseTerminalPreviewMode("compact")).toBe("compact");
    expect(parseTerminalPreviewMode("unexpected")).toBe("compact");
    expect(parseTerminalPreviewMode("large")).toBe("large");
  });

  it("loads every control and clamps untrusted durations", () => {
    expect(parseTerminalPreviewSettings(JSON.stringify({
      enabled: false,
      mode: "large",
      hoverDelay: -40,
      animationDuration: 900,
    }))).toEqual({
      enabled: false,
      mode: "large",
      hoverDelay: 0,
      animationDuration: 400,
    });
  });

  it("migrates the legacy size and recovers malformed settings", () => {
    expect(parseTerminalPreviewSettings(null, "large")).toEqual({
      ...DEFAULT_TERMINAL_PREVIEW_SETTINGS,
      mode: "large",
    });
    expect(parseTerminalPreviewSettings("{bad json", "compact"))
      .toEqual(DEFAULT_TERMINAL_PREVIEW_SETTINGS);
    expect(parseTerminalPreviewSettings(JSON.stringify({
      enabled: "yes",
      mode: "unknown",
      hoverDelay: "slow",
      animationDuration: null,
    }))).toEqual(DEFAULT_TERMINAL_PREVIEW_SETTINGS);
  });

  it("does not open hover previews for touch pointers", () => {
    expect(terminalPreviewAllowed(true, "mouse")).toBe(true);
    expect(terminalPreviewAllowed(true, "pen")).toBe(true);
    expect(terminalPreviewAllowed(true, "touch")).toBe(false);
    expect(terminalPreviewAllowed(false, "mouse")).toBe(false);
  });
});

describe("terminalPreviewPosition", () => {
  it("places compact previews beside the hovered row and clamps them vertically", () => {
    expect(terminalPreviewPosition({ right: 270, top: 200 }, 900)).toEqual({
      left: 280,
      top: 158,
    });
    expect(terminalPreviewPosition({ right: 270, top: 5 }, 900).top).toBe(12);
    expect(terminalPreviewPosition({ right: 270, top: 880 }, 900).top).toBe(558);
  });
});

describe("terminalPreviewFontSize", () => {
  it("fits the existing grid without changing its columns or rows", () => {
    expect(terminalPreviewFontSize(100, 30, 500, 280, "compact")).toBe(7.7);
    expect(terminalPreviewFontSize(100, 30, 1000, 650, "large")).toBe(15);
    expect(terminalPreviewFontSize(500, 300, 200, 100, "compact")).toBe(2);
  });
});
