import { describe, expect, it } from "vitest";
import { TerminalKeypressGuard } from "./terminal-keypress";

function keyEvent(
  type: "keydown" | "keypress",
  key: string,
  code: string,
  timeStamp: number,
): KeyboardEvent {
  return { type, key, code, timeStamp } as KeyboardEvent;
}

describe("terminal keypress guard", () => {
  it("suppresses a keypress when xterm already handled its keydown", () => {
    const guard = new TerminalKeypressGuard();
    const keydown = keyEvent("keydown", "c", "KeyC", 10);

    expect(guard.shouldProcess(keydown)).toBe(true);
    guard.markHandled(keydown);
    expect(guard.shouldProcess(keyEvent("keypress", "c", "KeyC", 11))).toBe(false);
  });

  it("keeps keypresses that xterm needs to handle printable input", () => {
    const guard = new TerminalKeypressGuard();
    const keydown = keyEvent("keydown", "C", "KeyC", 10);

    expect(guard.shouldProcess(keydown)).toBe(true);
    expect(guard.shouldProcess(keyEvent("keypress", "C", "KeyC", 11))).toBe(true);
  });

  it("does not suppress unrelated or delayed keypresses", () => {
    const guard = new TerminalKeypressGuard();
    const keydown = keyEvent("keydown", "c", "KeyC", 10);

    guard.shouldProcess(keydown);
    guard.markHandled(keydown);
    expect(guard.shouldProcess(keyEvent("keypress", "x", "KeyX", 11))).toBe(true);
    expect(guard.shouldProcess(keyEvent("keypress", "c", "KeyC", 111))).toBe(true);
  });

  it("uses the key when a browser does not report a physical code", () => {
    const guard = new TerminalKeypressGuard();
    const keydown = keyEvent("keydown", "é", "", 10);

    guard.shouldProcess(keydown);
    guard.markHandled(keydown);
    expect(guard.shouldProcess(keyEvent("keypress", "é", "", 11))).toBe(false);
  });
});
