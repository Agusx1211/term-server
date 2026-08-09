import { describe, expect, it } from "vitest";
import {
  consumeScrollPixels,
  NO_TERMINAL_MODIFIERS,
  transformTerminalInput,
} from "./mobile-terminal";

describe("mobile terminal input", () => {
  it("turns one-shot Ctrl input into terminal control bytes", () => {
    expect(transformTerminalInput("c", { ctrl: true, alt: false })).toBe("\u0003");
    expect(transformTerminalInput("[", { ctrl: true, alt: false })).toBe("\u001b");
    expect(transformTerminalInput("?", { ctrl: true, alt: false })).toBe("\u007f");
  });

  it("prefixes Alt input and encodes modified arrow keys", () => {
    expect(transformTerminalInput("x", { ctrl: false, alt: true })).toBe("\u001bx");
    expect(transformTerminalInput("\u001b[D", { ctrl: true, alt: true })).toBe("\u001b[1;7D");
  });

  it("leaves unmodified terminal input untouched", () => {
    expect(transformTerminalInput("hello", NO_TERMINAL_MODIFIERS)).toBe("hello");
  });

  it("adds one-shot mobile modifiers to Kitty keyboard input", () => {
    expect(transformTerminalInput("c", { ctrl: true, alt: false }, 1))
      .toBe("\u001b[99;5u");
    expect(transformTerminalInput("x", { ctrl: false, alt: true }, 17))
      .toBe("\u001b[120;3;120u");
    expect(transformTerminalInput("\u001b[120u", { ctrl: true, alt: false }, 9))
      .toBe("\u001b[120;5u");
  });

  it("encodes keybar Escape and Tab when the TUI requests Kitty reporting", () => {
    expect(transformTerminalInput("\u001b", NO_TERMINAL_MODIFIERS, 1))
      .toBe("\u001b[27u");
    expect(transformTerminalInput("\t", NO_TERMINAL_MODIFIERS, 8))
      .toBe("\u001b[9u");
  });
});

describe("mobile terminal scrolling", () => {
  it("accumulates sub-line touch movement without losing pixels", () => {
    expect(consumeScrollPixels(0, 7, 15)).toEqual({ lines: 0, remainder: 7 });
    expect(consumeScrollPixels(7, 11, 15)).toEqual({ lines: 1, remainder: 3 });
  });

  it("preserves direction when scrolling upward", () => {
    expect(consumeScrollPixels(0, -31, 15)).toEqual({ lines: -2, remainder: -1 });
  });
});
