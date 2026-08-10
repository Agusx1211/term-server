import { Terminal } from "@xterm/headless";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  copyTerminalSelection,
  isTerminalCopyShortcut,
  pasteTerminalClipboard,
} from "./terminal-clipboard";

let clipboardModule: typeof import("@xterm/addon-clipboard");

beforeAll(async () => {
  vi.stubGlobal("self", globalThis);
  clipboardModule = await import("@xterm/addon-clipboard");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => {
  terminal.write(data, resolve);
});

describe("terminal OSC 52 clipboard compatibility", () => {
  it("writes UTF-8 clipboard data requested by a TUI", async () => {
    const { Base64, ClipboardAddon } = clipboardModule;
    const writeText = vi.fn();
    const terminal = new Terminal({ allowProposedApi: true });
    terminal.loadAddon(new ClipboardAddon(undefined, {
      readText: () => "",
      writeText,
    }));
    const encoded = new Base64().encodeText("copied 猫");

    await write(terminal, `\x1b]52;c;${encoded}\x07`);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("c", "copied 猫");
    terminal.dispose();
  });

  it("returns clipboard text to a querying TUI as parser-owned input", async () => {
    const { Base64, ClipboardAddon } = clipboardModule;
    const terminal = new Terminal({ allowProposedApi: true });
    terminal.loadAddon(new ClipboardAddon(undefined, {
      readText: async () => "pasted text",
      writeText: () => {},
    }));
    let response = "";
    const disposable = terminal.onData((data) => {
      response = data;
    });

    await write(terminal, "\x1b]52;c;?\x07");

    expect(response).toBe(`\x1b]52;c;${new Base64().encodeText("pasted text")}\x07`);
    disposable.dispose();
    terminal.dispose();
  });
});

describe("terminal native clipboard fallbacks", () => {
  it("copies the exact terminal selection through a user-gesture clipboard API", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    const onNotice = vi.fn();

    await copyTerminalSelection("first line\r\ncopied 猫", { writeText }, onNotice);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("first line\r\ncopied 猫");
    expect(onNotice).toHaveBeenCalledWith("Copied selection");
  });

  it("reports denied and unavailable copy APIs without changing the selection", async () => {
    const onNotice = vi.fn();
    const deniedWrite = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });

    await copyTerminalSelection("selected", { writeText: deniedWrite }, onNotice);
    await copyTerminalSelection("selected", undefined, onNotice);

    expect(deniedWrite).toHaveBeenCalledWith("selected");
    expect(onNotice).toHaveBeenNthCalledWith(1, "Clipboard permission was denied");
    expect(onNotice).toHaveBeenNthCalledWith(2, "Clipboard access requires HTTPS or localhost");
  });

  it("pastes clipboard text exactly once through the xterm paste path", async () => {
    const readText = vi.fn(async () => "pasted 猫\r\n");
    const paste = vi.fn();
    const focus = vi.fn();
    const onNotice = vi.fn();

    await pasteTerminalClipboard({ readText }, paste, focus, onNotice);

    expect(readText).toHaveBeenCalledOnce();
    expect(paste).toHaveBeenCalledOnce();
    expect(paste).toHaveBeenCalledWith("pasted 猫\r\n");
    expect(focus).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("reports denied and unavailable paste APIs without injecting input", async () => {
    const paste = vi.fn();
    const focus = vi.fn();
    const onNotice = vi.fn();
    const deniedRead = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });

    await pasteTerminalClipboard(undefined, paste, focus, onNotice);
    await pasteTerminalClipboard({ readText: deniedRead }, paste, focus, onNotice);

    expect(focus).toHaveBeenCalledOnce();
    expect(paste).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenNthCalledWith(1, "Clipboard access requires HTTPS or localhost");
    expect(onNotice).toHaveBeenNthCalledWith(2, "Clipboard permission was denied");
  });

  it.each([
    ["Linux Ctrl+Shift+C", "Linux", "KeyC", true, true, false, false, "keydown", true],
    ["macOS Ctrl+Shift+C", "MacIntel", "KeyC", true, true, false, false, "keydown", false],
    ["macOS Cmd+C", "MacIntel", "KeyC", false, false, false, true, "keydown", false],
    ["Linux Ctrl+C", "Linux", "KeyC", true, false, false, false, "keydown", false],
    ["Linux Ctrl+Shift+V", "Linux", "KeyV", true, true, false, false, "keydown", false],
    ["Linux Ctrl+Shift+C keyup", "Linux", "KeyC", true, true, false, false, "keyup", false],
  ] satisfies [string, string, string, boolean, boolean, boolean, boolean, string, boolean][])(
    "%s uses the native browser copy path only when appropriate",
    (
      _name,
    platform,
    code,
    ctrlKey,
    shiftKey,
    altKey,
    metaKey,
    type,
    expected,
  ) => {
    expect(isTerminalCopyShortcut({
      altKey,
      code,
      ctrlKey,
      metaKey,
      shiftKey,
      type,
    }, platform)).toBe(expected);
  });

});
