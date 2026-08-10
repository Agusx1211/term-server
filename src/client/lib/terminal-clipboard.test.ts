import { Terminal } from "@xterm/headless";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  copyTerminalSelection,
  handleTerminalClipboardShortcut,
  pasteTerminalClipboard,
  readTerminalOsc52Clipboard,
  terminalClipboardShortcut,
  writeTerminalOsc52Clipboard,
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

  it("surfaces browser clipboard failures without rejecting the parser", async () => {
    const onNotice = vi.fn();
    const clipboard = {
      readText: vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
      writeText: vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
    };

    await expect(readTerminalOsc52Clipboard(clipboard, onNotice)).resolves.toBe("");
    await expect(writeTerminalOsc52Clipboard("copied", clipboard, onNotice)).resolves.toBeUndefined();

    expect(onNotice).toHaveBeenNthCalledWith(1, "Clipboard permission was denied");
    expect(onNotice).toHaveBeenNthCalledWith(2, "Clipboard permission was denied");
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
    ["Linux Ctrl+Shift+C", "Linux", "KeyC", true, true, false, false, "keydown", "copy"],
    ["Linux Ctrl+Shift+V", "Linux", "KeyV", true, true, false, false, "keydown", "paste"],
    ["Linux Ctrl+Insert", "Linux", "Insert", true, false, false, false, "keydown", "copy"],
    ["Linux Shift+Insert", "Linux", "Insert", false, true, false, false, "keydown", "paste"],
    ["macOS Cmd+C", "MacIntel", "KeyC", false, false, false, true, "keydown", "copy"],
    ["macOS Cmd+V", "MacIntel", "KeyV", false, false, false, true, "keydown", "paste"],
    ["macOS Cmd+Shift+V", "MacIntel", "KeyV", false, true, false, true, "keydown", "paste"],
    ["macOS Ctrl+Shift+C", "MacIntel", "KeyC", true, true, false, false, "keydown", undefined],
    ["Linux Ctrl+C", "Linux", "KeyC", true, false, false, false, "keydown", undefined],
    ["Linux Ctrl+V", "Linux", "KeyV", true, false, false, false, "keydown", undefined],
    ["Linux Ctrl+Shift+C keyup", "Linux", "KeyC", true, true, false, false, "keyup", "copy"],
  ] satisfies [string, string, string, boolean, boolean, boolean, boolean, string, "copy" | "paste" | undefined][])(
    "%s identifies the browser clipboard shortcut",
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
      expect(terminalClipboardShortcut({
        altKey,
        code,
        ctrlKey,
        metaKey,
        preventDefault: () => {},
        shiftKey,
        type,
      }, platform)).toBe(expected);
    },
  );

  it("blocks xterm input while preserving native copy and paste events", () => {
    const copy = vi.fn();
    const copyEvent = shortcutEvent("KeyC");
    const pasteEvent = shortcutEvent("KeyV");
    const releaseEvent = shortcutEvent("KeyV", "keyup");

    expect(handleTerminalClipboardShortcut(copyEvent, "Linux", copy)).toBe(false);
    expect(copyEvent.preventDefault).toHaveBeenCalledOnce();
    expect(copy).toHaveBeenCalledOnce();

    expect(handleTerminalClipboardShortcut(pasteEvent, "Linux", copy)).toBe(false);
    expect(pasteEvent.preventDefault).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledOnce();

    expect(handleTerminalClipboardShortcut(releaseEvent, "Linux", copy)).toBe(false);
    expect(copy).toHaveBeenCalledOnce();
  });

});

function shortcutEvent(code: string, type = "keydown") {
  return {
    altKey: false,
    code,
    ctrlKey: true,
    metaKey: false,
    preventDefault: vi.fn(),
    shiftKey: true,
    type,
  };
}
