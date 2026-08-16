import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
  TERMINAL_CHECKPOINT_FRAME_HEADER_BYTES,
  TERMINAL_CHECKPOINT_FRAME_KIND,
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

  it("caps scrollback depth for streaming checkpoints but keeps the live screen", async () => {
    const terminal = new Terminal({
      cols: 40,
      rows: 5,
      scrollback: 1_000,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    await write(terminal, Array.from({ length: 300 }, (_, line) => `line-${line}\r\n`).join(""));

    const checkpoint = serializeTerminalCheckpoint(serializer, terminal, 1024 * 1024, {
      maximumScrollbackLines: 50,
    });
    const text = new TextDecoder().decode(checkpoint);
    expect(text).toContain("line-299");
    expect(text).toContain("line-260");
    expect(text).not.toContain("line-200\r");

    terminal.dispose();
  });

  it("seeds the first serialization pass from the previous checkpoint's density", async () => {
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 5_000,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    const filler = "x".repeat(50);
    for (let batch = 0; batch < 20; batch += 1) {
      await write(terminal, Array.from(
        { length: 100 },
        (_, line) => `line-${batch * 100 + line} ${filler}\r\n`,
      ).join(""));
    }

    const budget: { lineBytesEstimate?: number } = {};
    const spy = vi.spyOn(serializer, "serialize");
    const first = serializeTerminalCheckpoint(serializer, terminal, 16 * 1024, { budget });
    expect(first).toBeDefined();
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    expect(spy.mock.calls[0]?.[0]?.scrollback).toBeGreaterThan(1_000);
    expect(budget.lineBytesEstimate).toBeGreaterThan(0);

    spy.mockClear();
    const second = serializeTerminalCheckpoint(serializer, terminal, 16 * 1024, { budget });
    expect(second).toBeDefined();
    expect(second!.byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(spy.mock.calls[0]?.[0]?.scrollback).toBeLessThan(600);

    terminal.dispose();
  });

  it("sends binary checkpoints as one announcement plus headered ordered frames", () => {
    const length = TERMINAL_CHECKPOINT_CHUNK_BYTES * 2 + 17;
    const bytes = Uint8Array.from({ length }, (_, index) => index % 251);
    const send = vi.fn();

    const chunks = sendTerminalCheckpoint({ send }, 123, 7, bytes, { binary: true });

    expect(chunks).toBe(3);
    const [announcement, ...frames] = send.mock.calls.map(([message]) => message);
    expect(JSON.parse(announcement as string)).toEqual({
      type: "checkpointBinary",
      sequence: 123,
      epoch: 7,
      size: length,
    });
    expect(frames).toHaveLength(3);
    const restored = new Uint8Array(length);
    let offset = 0;
    for (const frame of frames as Uint8Array[]) {
      expect(frame).toBeInstanceOf(Uint8Array);
      expect(frame[0]).toBe(TERMINAL_CHECKPOINT_FRAME_KIND);
      expect(new DataView(frame.buffer).getBigUint64(1)).toBe(123n);
      const payload = frame.subarray(TERMINAL_CHECKPOINT_FRAME_HEADER_BYTES);
      expect(payload.byteLength).toBeGreaterThan(0);
      expect(payload.byteLength).toBeLessThanOrEqual(TERMINAL_CHECKPOINT_CHUNK_BYTES);
      restored.set(payload, offset);
      offset += payload.byteLength;
    }
    expect(offset).toBe(length);
    expect(restored).toEqual(bytes);
  });

  it("chunks checkpoints at exact boundaries with ordered offsets below the websocket limit", () => {
    const lengths = [
      TERMINAL_CHECKPOINT_CHUNK_BYTES - 1,
      TERMINAL_CHECKPOINT_CHUNK_BYTES,
      TERMINAL_CHECKPOINT_CHUNK_BYTES + 1,
      TERMINAL_CHECKPOINT_CHUNK_BYTES * 2 + 17,
    ];

    for (const length of lengths) {
      const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
      const send = vi.fn();
      sendTerminalCheckpoint({ send }, 123, 7, bytes);

      const messages = send.mock.calls.map(([message]) => JSON.parse(message as string));
      expect(messages.map((message) => message.offset)).toEqual(
        Array.from({ length: Math.ceil(length / TERMINAL_CHECKPOINT_CHUNK_BYTES) }, (_, index) =>
          index * TERMINAL_CHECKPOINT_CHUNK_BYTES
        ),
      );
      expect(messages.map((message) => message.final)).toEqual(
        messages.map((_, index) => index === messages.length - 1),
      );
      expect(messages.every((message) => JSON.stringify(message).length < 64 * 1024)).toBe(true);

      const restored = Uint8Array.from(messages.flatMap((message) =>
        Array.from(atob(message.data), (character) => character.charCodeAt(0))
      ));
      expect(restored).toEqual(bytes);
    }
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
