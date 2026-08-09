import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
  sendTerminalCheckpoint,
  serializeTerminalCheckpoint,
} from "./terminal-checkpoint";
import { terminalCheckpointCompatibilityState } from "./terminal-compatibility";

const write = (terminal: Terminal, data: string | Uint8Array) => new Promise<void>((resolve) => {
  terminal.write(data, resolve);
});

const visibleLines = (terminal: Terminal) => Array.from(
  { length: terminal.rows },
  (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)
    ?.translateToString(true) ?? "",
);

describe("terminal xterm checkpoints", () => {
  it("round-trips the same xterm model used by the browser", async () => {
    const source = new Terminal({ cols: 24, rows: 5, scrollback: 100, allowProposedApi: true });
    const serializer = new SerializeAddon();
    source.loadAddon(serializer);
    await write(source, "shell history\r\n\x1b[31mred\x1b[m\r\n\x1b[?1049hagent tui\x1b[3;7Hcursor");

    const checkpoint = serializeTerminalCheckpoint(serializer, source, 64 * 1024);
    expect(checkpoint).toBeDefined();

    const restored = new Terminal({ cols: 24, rows: 5, scrollback: 100, allowProposedApi: true });
    await write(restored, checkpoint!);
    expect(restored.buffer.active.type).toBe(source.buffer.active.type);
    expect(restored.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
    expect(restored.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
    expect(visibleLines(restored)).toEqual(visibleLines(source));
    await Promise.all([
      write(source, "\x1b[?1049l"),
      write(restored, "\x1b[?1049l"),
    ]);
    expect(visibleLines(restored)).toEqual(visibleLines(source));
    expect(visibleLines(restored).join("\n")).toContain("shell history");

    source.dispose();
    restored.dispose();
  });

  it("restores Kitty keyboard flags and stacks for both screen buffers", async () => {
    const source = new Terminal({
      cols: 24,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true },
    });
    const serializer = new SerializeAddon();
    source.loadAddon(serializer);
    await write(source, "\x1b[=1u\x1b[>3u\x1b[>7u\x1b[?1049h");
    await write(source, "\x1b[=2u\x1b[>5u\x1b[>9uagent tui");

    const checkpoint = serializeTerminalCheckpoint(serializer, source, 64 * 1024);
    expect(checkpoint).toBeDefined();

    const restored = new Terminal({
      cols: 24,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true },
    });
    await write(restored, checkpoint!);
    expect(await queryKittyFlags(restored)).toBe(9);
    await write(restored, "\x1b[<u");
    expect(await queryKittyFlags(restored)).toBe(5);
    await write(restored, "\x1b[?1049l");
    expect(await queryKittyFlags(restored)).toBe(7);
    await write(restored, "\x1b[<u");
    expect(await queryKittyFlags(restored)).toBe(3);

    source.dispose();
    restored.dispose();
  });

  it("retains hidden alternate-buffer Kitty state from a normal-screen checkpoint", async () => {
    const source = new Terminal({
      cols: 24,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true },
    });
    const serializer = new SerializeAddon();
    source.loadAddon(serializer);
    await write(source, "shell\x1b[=1u\x1b[>3u\x1b[>7u\x1b[?1049h");
    await write(source, "tui\x1b[=2u\x1b[>5u\x1b[>9u\x1b[?1049l");

    const checkpoint = serializeTerminalCheckpoint(serializer, source, 64 * 1024);
    const restored = new Terminal({
      cols: 24,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true },
    });
    await write(restored, checkpoint!);
    expect(restored.buffer.active.type).toBe("normal");
    expect(await queryKittyFlags(restored)).toBe(7);
    await write(restored, "\x1b[?1049h");
    expect(await queryKittyFlags(restored)).toBe(9);
    await write(restored, "\x1b[<u");
    expect(await queryKittyFlags(restored)).toBe(5);

    source.dispose();
    restored.dispose();
  });

  it("restores mouse encoding and cursor shape omitted by the official serializer", async () => {
    for (const [sequence, mouseEncoding] of [
      ["\x1b[?1006h", "SGR"],
      ["\x1b[?1016h", "SGR_PIXELS"],
    ] as const) {
      const source = new Terminal({ cols: 24, rows: 5, allowProposedApi: true });
      const serializer = new SerializeAddon();
      source.loadAddon(serializer);
      await write(source, `\x1b[?1002h${sequence}\x1b[6 q`);

      const checkpoint = serializeTerminalCheckpoint(serializer, source, 64 * 1024);
      const restored = new Terminal({ cols: 24, rows: 5, allowProposedApi: true });
      await write(restored, checkpoint!);

      expect(restored.modes.mouseTrackingMode).toBe("drag");
      expect(terminalCheckpointCompatibilityState(restored)).toMatchObject({
        mouseEncoding,
        cursorStyle: "bar",
        cursorBlink: false,
      });
      source.dispose();
      restored.dispose();
    }
  });

  it("does not freeze recovery inside a temporary synchronized-output frame", async () => {
    const source = new Terminal({ cols: 24, rows: 5, allowProposedApi: true });
    const serializer = new SerializeAddon();
    source.loadAddon(serializer);
    await write(source, "\x1b[?2026hpartial frame");
    expect(source.modes.synchronizedOutputMode).toBe(true);

    const checkpoint = serializeTerminalCheckpoint(serializer, source, 64 * 1024);
    expect(new TextDecoder().decode(checkpoint)).not.toContain("\x1b[?2026h");
    const restored = new Terminal({ cols: 24, rows: 5, allowProposedApi: true });
    await write(restored, checkpoint!);
    expect(restored.modes.synchronizedOutputMode).toBe(false);

    source.dispose();
    restored.dispose();
  });

  it("trims old scrollback but never the live screen to fit the broker bound", async () => {
    const terminal = new Terminal({
      cols: 40,
      rows: 6,
      scrollback: 1_000,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    await write(terminal, Array.from({ length: 300 }, (_, line) => `line-${line}\r\n`).join(""));

    const checkpoint = serializeTerminalCheckpoint(serializer, terminal, 2_000);
    expect(checkpoint?.byteLength).toBeLessThanOrEqual(2_000);
    const restored = new Terminal({
      cols: 40,
      rows: 6,
      scrollback: 1_000,
      allowProposedApi: true,
    });
    await write(restored, checkpoint!);
    expect(visibleLines(restored).join("\n")).toContain("line-299");

    terminal.dispose();
    restored.dispose();
  });

  it("chunks checkpoints with exact ordered offsets below the websocket limit", () => {
    const bytes = Uint8Array.from({ length: TERMINAL_CHECKPOINT_CHUNK_BYTES * 2 + 17 }, (_, i) => i % 251);
    const send = vi.fn();
    sendTerminalCheckpoint({ send }, 123, 7, bytes);

    const messages = send.mock.calls.map(([message]) => JSON.parse(message as string));
    expect(messages.map((message) => message.offset)).toEqual([
      0,
      TERMINAL_CHECKPOINT_CHUNK_BYTES,
      TERMINAL_CHECKPOINT_CHUNK_BYTES * 2,
    ]);
    expect(messages.map((message) => message.final)).toEqual([false, false, true]);
    expect(messages.every((message) => JSON.stringify(message).length < 64 * 1024)).toBe(true);

    const restored = Uint8Array.from(messages.flatMap((message) =>
      Array.from(atob(message.data), (character) => character.charCodeAt(0))
    ));
    expect(restored).toEqual(bytes);
  });
});

async function queryKittyFlags(terminal: Terminal): Promise<number> {
  let reply = "";
  const disposable = terminal.onData((data) => {
    reply = data;
  });
  try {
    await write(terminal, "\x1b[?u");
  } finally {
    disposable.dispose();
  }
  const match = /^\x1b\[\?(\d+)u$/.exec(reply);
  if (!match) throw new Error(`unexpected Kitty keyboard reply: ${JSON.stringify(reply)}`);
  return Number(match[1]);
}
