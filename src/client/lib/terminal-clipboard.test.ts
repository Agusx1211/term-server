import { Terminal } from "@xterm/headless";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
