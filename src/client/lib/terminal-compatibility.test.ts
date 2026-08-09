import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { Terminal as BrowserTerminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { tuiCompatibilityOptions } from "./terminal-compatibility";

interface WritableTerminal {
  write(data: string, callback: () => void): void;
}

interface InternalKeyboardTerminal {
  _core?: {
    _keyboardService?: {
      evaluateKeyDown(event: KeyboardEvent): { key?: string };
    };
  };
}

const write = (terminal: WritableTerminal, data: string) => new Promise<void>((resolve) => {
  terminal.write(data, resolve);
});

describe("full-screen TUI emulator compatibility", () => {
  it("encodes keys with the Kitty protocol requested by the application", async () => {
    const terminal = new BrowserTerminal({
      allowProposedApi: true,
      ...tuiCompatibilityOptions(),
    });
    await write(terminal, "\x1b[=1u");
    const keyboard = (terminal as BrowserTerminal & InternalKeyboardTerminal)
      ._core?._keyboardService;
    expect(keyboard).toBeDefined();

    expect(keyboard!.evaluateKeyDown(keyEvent("Enter", "Enter", { shiftKey: true })).key)
      .toBe("\x1b[13;2u");
    expect(keyboard!.evaluateKeyDown(keyEvent("c", "KeyC", { ctrlKey: true })).key)
      .toBe("\x1b[99;5u");
    terminal.dispose();
  });

  it("retains a cleared viewport in scrollback like VS Code", async () => {
    const terminal = new HeadlessTerminal({
      cols: 10,
      rows: 3,
      scrollback: 20,
      ...tuiCompatibilityOptions(),
    });
    await write(terminal, "one\r\ntwo\r\nthree\x1b[2J");

    expect(terminal.buffer.active.baseY).toBe(3);
    expect(Array.from(
      { length: 3 },
      (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true),
    )).toEqual(["one", "two", "three"]);
    terminal.dispose();
  });

  it("supports the XTVERSION query used by terminal capability probes", async () => {
    const terminal = new HeadlessTerminal(tuiCompatibilityOptions());
    let response = "";
    const disposable = terminal.onData((data) => {
      response = data;
    });
    await write(terminal, "\x1b[>q");

    expect(response).toMatch(/^\x1bP>\|xterm\.js\(.+\)\x1b\\$/);
    disposable.dispose();
    terminal.dispose();
  });
});

function keyEvent(
  key: string,
  code: string,
  modifiers: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">>,
): KeyboardEvent {
  return {
    key,
    code,
    keyCode: key === "Enter" ? 13 : key.toUpperCase().charCodeAt(0),
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    type: "keydown",
    getModifierState: () => false,
    preventDefault: () => {},
    stopPropagation: () => {},
    ...modifiers,
  } as unknown as KeyboardEvent;
}
