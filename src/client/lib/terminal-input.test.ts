import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import {
  encodeTerminalBinary,
  encodeTerminalText,
  isServerOwnedTerminalReply,
  sendTerminalChunks,
  terminalDataDisposition,
  trackTerminalUserInput,
} from "./terminal-input";

describe("terminal input encoding", () => {
  it("encodes text as bounded UTF-8 chunks without losing code points", () => {
    const chunks = encodeTerminalText("aé👩z", 3);
    expect(chunks.every((chunk) => chunk.byteLength <= 3)).toBe(true);
    expect(new TextDecoder().decode(concatenate(chunks))).toBe("aé👩z");
  });

  it("preserves xterm binary string bytes exactly", () => {
    expect([...concatenate(encodeTerminalBinary("\u0000\u007f\u0080\u00ff", 2))]).toEqual([
      0x00,
      0x7f,
      0x80,
      0xff,
    ]);
  });

  it("sends each encoded chunk as its own websocket message", () => {
    const send = vi.fn();
    sendTerminalChunks({ send }, encodeTerminalText("abcdef", 2));
    expect(send.mock.calls.map(([chunk]) => [...chunk as Uint8Array])).toEqual([
      [97, 98],
      [99, 100],
      [101, 102],
    ]);
  });

  it("distinguishes genuine user data during an asynchronous parser write", async () => {
    let listener = () => {};
    const dispose = vi.fn();
    const tracker = trackTerminalUserInput({
      _core: {
        coreService: {
          onUserInput(next: () => void) {
            listener = next;
            return { dispose };
          },
        },
      },
    });

    expect(tracker.consume()).toBe(false);
    listener();
    expect(tracker.consume()).toBe(true);
    expect(tracker.consume()).toBe(false);
    listener();
    await Promise.resolve();
    expect(tracker.consume()).toBe(false);
    tracker.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("observes xterm's real wasUserInput signal synchronously", () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const tracker = trackTerminalUserInput(terminal);
    const sources: boolean[] = [];
    const data = terminal.onData(() => sources.push(tracker.consume()));

    try {
      terminal.input("keyboard", true);
      terminal.input("parser reply", false);
      expect(sources).toEqual([true, false]);
    } finally {
      data.dispose();
      tracker.dispose();
      terminal.dispose();
    }
  });

  it("preserves user input while an asynchronous output write is pending", () => {
    expect(terminalDataDisposition({
      acceptingInput: true,
      data: "keyboard",
      parsingOutput: true,
      responder: false,
      userInput: true,
    })).toBe("user");
  });

  it("suppresses only replies that protocol v2 already generates on the server", () => {
    const owned = [
      "\x1b[?1;2c",
      "\x1b[>0;276;0c",
      "\x1b[0n",
      "\x1b[24;80R",
      "\x1b[?24;80R",
      "\x1b[4;1$y",
      "\x1b[?2026;0$y",
      "\x1b[4;1080;1920t",
      "\x1b[6;20;10t",
      "\x1b[8;24;80t",
      "\x1b[?7u",
      "\x1bP>|term-server(0.10.1)\x1b\\",
      "\x1bP>|xterm.js(6.0.0)\x1b\\",
    ];
    const browserOwned = [
      "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
      "\x1b[3;10;20t",
      "\x1b[?1;2c trailing",
      "\x1b[?7;1$p",
    ];

    for (const data of owned) expect(isServerOwnedTerminalReply(data)).toBe(true);
    for (const data of browserOwned) expect(isServerOwnedTerminalReply(data)).toBe(false);
  });

  it("forwards browser-owned parser replies from only the elected responder", () => {
    const context = {
      acceptingInput: false,
      data: "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
      parsingOutput: true,
      userInput: false,
    };
    expect(terminalDataDisposition({ ...context, responder: true })).toBe("response");
    expect(terminalDataDisposition({ ...context, responder: false })).toBe("ignore");
    expect(terminalDataDisposition({
      ...context,
      data: "\x1b[?1;2c",
      responder: true,
    })).toBe("ignore");
  });

  it("recognizes replies emitted by xterm while it parses server output", async () => {
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      vtExtensions: { kittyKeyboard: true },
    });
    const dispositions: Array<[string, string]> = [];
    const data = terminal.onData((reply) => {
      dispositions.push([reply, terminalDataDisposition({
        acceptingInput: true,
        data: reply,
        parsingOutput: true,
        responder: true,
        userInput: false,
      })]);
    });

    try {
      await new Promise<void>((resolve) => {
        terminal.write("\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[?7$p\x1b[=7u\x1b[?u\x1b[>q", resolve);
      });
      expect(dispositions).toEqual([
        ["\x1b[?1;2c", "ignore"],
        ["\x1b[>0;276;0c", "ignore"],
        ["\x1b[0n", "ignore"],
        ["\x1b[1;1R", "ignore"],
        ["\x1b[?1;1R", "ignore"],
        ["\x1b[?7;1$y", "ignore"],
        ["\x1b[?7u", "ignore"],
        ["\x1bP>|xterm.js(6.0.0)\x1b\\", "ignore"],
      ]);
    } finally {
      data.dispose();
      terminal.dispose();
    }
  });

  it("lets the consumed user-input latch win over reply-shaped data", () => {
    expect(terminalDataDisposition({
      acceptingInput: true,
      data: "\x1b[?1;2c",
      parsingOutput: true,
      responder: true,
      userInput: true,
    })).toBe("user");
  });

  it("filters all user input before sync", () => {
    expect(terminalDataDisposition({
      acceptingInput: false,
      data: "keyboard",
      parsingOutput: false,
      responder: true,
      userInput: false,
    })).toBe("ignore");
    expect(terminalDataDisposition({
      acceptingInput: false,
      data: "keyboard",
      parsingOutput: true,
      responder: true,
      userInput: true,
    })).toBe("ignore");
  });
  it("rejects keyboard and keybar data while connecting or recovering", () => {
    for (const data of ["keyboard", "\u001b", "\t", "\u001b[D"]) {
      expect(terminalDataDisposition({
        acceptingInput: false,
        data,
        parsingOutput: false,
        responder: true,
        userInput: true,
      })).toBe("ignore");
    }
  });

});

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
