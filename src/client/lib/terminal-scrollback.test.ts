import { describe, expect, it } from "vitest";
import {
  TERMINAL_SCROLLBACK_LIMITS,
  clampTerminalScrollback,
  commitTerminalScrollbackDraft,
  parseTerminalScrollback,
  resolveTerminalScrollback,
} from "./terminal-scrollback";

describe("parseTerminalScrollback", () => {
  it("treats missing or unreadable values as no override", () => {
    expect(parseTerminalScrollback(null)).toBeUndefined();
    expect(parseTerminalScrollback("")).toBeUndefined();
    expect(parseTerminalScrollback("   ")).toBeUndefined();
    expect(parseTerminalScrollback("many lines")).toBeUndefined();
  });

  it("clamps stored values to the server's supported bounds", () => {
    expect(parseTerminalScrollback("-1")).toBe(TERMINAL_SCROLLBACK_LIMITS.min);
    expect(parseTerminalScrollback("3000000")).toBe(TERMINAL_SCROLLBACK_LIMITS.max);
    expect(parseTerminalScrollback("1200.6")).toBe(1201);
  });
});

describe("resolveTerminalScrollback", () => {
  it("follows the server default until the browser overrides it", () => {
    expect(resolveTerminalScrollback(undefined, 200_000)).toBe(200_000);
    expect(resolveTerminalScrollback(12_000, 200_000)).toBe(12_000);
  });

  it("keeps the resolved value within the supported bounds", () => {
    expect(resolveTerminalScrollback(undefined, 900)).toBe(TERMINAL_SCROLLBACK_LIMITS.min);
    expect(resolveTerminalScrollback(3_000_000, 200_000)).toBe(TERMINAL_SCROLLBACK_LIMITS.max);
  });
});

describe("clampTerminalScrollback", () => {
  it("rounds fractional rows to a whole line count", () => {
    expect(clampTerminalScrollback(12_000.4)).toBe(12_000);
    expect(clampTerminalScrollback(12_000.6)).toBe(12_001);
  });
});

describe("commitTerminalScrollbackDraft", () => {
  it("commits nothing while the field is empty or unreadable", () => {
    // Clamping "" to the 1,000 minimum and writing it back mid-typing made the
    // field append digits to "1000": 5,000 could never be entered.
    expect(commitTerminalScrollbackDraft("")).toBeUndefined();
    expect(commitTerminalScrollbackDraft("   ")).toBeUndefined();
    expect(commitTerminalScrollbackDraft("-")).toBeUndefined();
    expect(commitTerminalScrollbackDraft("many")).toBeUndefined();
  });

  it("commits a clamped whole line count once the field holds a number", () => {
    expect(commitTerminalScrollbackDraft("5000")).toBe(5_000);
    expect(commitTerminalScrollbackDraft(" 12000.6 ")).toBe(12_001);
    expect(commitTerminalScrollbackDraft("5")).toBe(TERMINAL_SCROLLBACK_LIMITS.min);
    expect(commitTerminalScrollbackDraft("9000000")).toBe(TERMINAL_SCROLLBACK_LIMITS.max);
  });
});
