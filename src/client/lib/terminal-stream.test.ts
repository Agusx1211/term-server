import { describe, expect, it } from "vitest";
import {
  TERMINAL_ACK_BYTES,
  TERMINAL_FRAME_OUTPUT,
  TERMINAL_FRAME_SNAPSHOT,
  TerminalOutputAck,
  TerminalRenderBacklog,
  TerminalStreamState,
  decodeTerminalFrame,
} from "./terminal-stream";

function frame(kind: number, sequence: bigint, data: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(9 + data.length);
  const view = new DataView(buffer);
  view.setUint8(0, kind);
  view.setBigUint64(1, sequence);
  new Uint8Array(buffer, 9).set(data);
  return buffer;
}

describe("terminal stream protocol", () => {
  it("decodes framed terminal bytes", () => {
    expect(decodeTerminalFrame(frame(TERMINAL_FRAME_OUTPUT, 42n, [1, 2, 3]))).toEqual({
      kind: TERMINAL_FRAME_OUTPUT,
      sequence: 42,
      data: new Uint8Array([1, 2, 3]),
    });
    expect(() => decodeTerminalFrame(new ArrayBuffer(8))).toThrow(/header/);
    expect(() => decodeTerminalFrame(frame(TERMINAL_FRAME_OUTPUT, 2n ** 53n, []))).toThrow(/safe/);
  });

  it("commits a snapshot only after the parser finishes it", () => {
    const state = new TerminalStreamState();
    expect(state.begin("snapshot", 120)).toBe(true);
    expect(state.accept(decodeTerminalFrame(frame(TERMINAL_FRAME_SNAPSHOT, 120n, [1])))).toBeUndefined();
    expect(state.resumeSequence).toBeUndefined();
    state.finish(120);
    expect(state.resumeSequence).toBe(120);
    expect(state.synchronizing).toBe(false);
  });

  it("resumes from the last parser-committed byte", () => {
    const state = new TerminalStreamState();
    state.begin("snapshot", 10);
    state.accept(decodeTerminalFrame(frame(TERMINAL_FRAME_SNAPSHOT, 10n, [1])));
    state.finish(10);
    expect(state.begin("resume", 15)).toBe(false);
    expect(state.accept(decodeTerminalFrame(frame(TERMINAL_FRAME_OUTPUT, 10n, [1, 2, 3])))).toBe(13);
    state.commit(13);
    expect(state.resumeSequence).toBe(13);
    expect(state.accept(decodeTerminalFrame(frame(TERMINAL_FRAME_OUTPUT, 13n, [4, 5])))).toBe(15);
    state.commit(15);
    state.finish(15);
    expect(state.resumeSequence).toBe(15);
  });

  it("rejects gaps, stale snapshots, and incomplete syncs", () => {
    const state = new TerminalStreamState();
    expect(() => state.begin("resume", 1)).toThrow(/uninitialized/);
    state.begin("snapshot", 5);
    expect(() => state.finish(5)).toThrow(/no state/);
    expect(() => state.accept(decodeTerminalFrame(frame(TERMINAL_FRAME_SNAPSHOT, 4n, [])))).toThrow(
      /unexpected/,
    );
    state.accept(decodeTerminalFrame(frame(TERMINAL_FRAME_SNAPSHOT, 5n, [1])));
    state.finish(5);
    state.begin("resume", 8);
    expect(() => state.accept(decodeTerminalFrame(frame(TERMINAL_FRAME_OUTPUT, 6n, [1])))).toThrow(
      /gap/,
    );
    expect(() => state.finish(8)).toThrow(/unexpected/);
  });

  it("forgets stale resume state before a fresh snapshot", () => {
    const state = new TerminalStreamState();
    state.begin("snapshot", 10);
    state.accept(decodeTerminalFrame(frame(TERMINAL_FRAME_SNAPSHOT, 10n, [1])));
    state.finish(10);
    state.restart();
    expect(state.resumeSequence).toBeUndefined();
    expect(state.synchronizing).toBe(false);
    expect(state.begin("snapshot", 20)).toBe(true);
  });
});

describe("terminal renderer backlog", () => {
  it("bounds queued output by size and sustained parser delay", () => {
    const backlog = new TerminalRenderBacklog();
    expect(backlog.enqueue(3 * 1024 * 1024, 1_000)).toBe(false);
    expect(backlog.enqueue(2 * 1024 * 1024, 6_001)).toBe(true);
    expect(backlog.pendingBytes).toBe(5 * 1024 * 1024);

    backlog.reset();
    expect(backlog.enqueue(16 * 1024 * 1024, 3_000)).toBe(false);
    expect(backlog.enqueue(1, 3_001)).toBe(true);

    backlog.reset();
    for (let index = 0; index < 8_192; index += 1) {
      expect(backlog.enqueue(1, 4_000)).toBe(false);
    }
    expect(backlog.enqueue(1, 4_000)).toBe(true);
  });

  it("tolerates a full-screen redraw the renderer keeps up with", () => {
    const backlog = new TerminalRenderBacklog();
    // A 1.3 MB TUI repaint arriving as 4 KB frames, parsed a beat behind.
    for (let index = 0; index < 320; index += 1) {
      expect(backlog.enqueue(4_095, 1_000 + index)).toBe(false);
      if (index >= 16) backlog.settle(4_095);
    }
    expect(backlog.pendingBytes).toBeLessThan(128 * 1024);
  });

  it("ages the oldest unparsed frame, not the last idle moment", () => {
    const backlog = new TerminalRenderBacklog();
    // A terminal that never falls idle still settles every frame it is handed,
    // so a steady stream must not age out however long it runs.
    for (let index = 0; index < 5_000; index += 1) {
      expect(backlog.enqueue(64 * 1024, 1_000 + index * 10)).toBe(false);
      backlog.settle(64 * 1024);
    }
    expect(backlog.pendingBytes).toBe(0);
  });

  it("clears its age once xterm catches up", () => {
    const backlog = new TerminalRenderBacklog();
    backlog.enqueue(64 * 1024, 1_000);
    backlog.settle(64 * 1024);
    expect(backlog.pendingBytes).toBe(0);
    expect(backlog.enqueue(64 * 1024, 10_000)).toBe(false);
  });
});

describe("terminal output acknowledgements", () => {
  it("batches parsed bytes instead of acknowledging every frame", () => {
    const ack = new TerminalOutputAck();

    expect(ack.parsed(TERMINAL_ACK_BYTES - 1)).toBeUndefined();
    expect(ack.parsed(1)).toBe(TERMINAL_ACK_BYTES);
  });

  it("carries the remainder so the server's window cannot drift", () => {
    const ack = new TerminalOutputAck();
    const chunk = 3_000;
    let acknowledged = 0;
    let parsed = 0;

    for (let index = 0; index < 100; index += 1) {
      parsed += chunk;
      acknowledged += ack.parsed(chunk) ?? 0;
    }

    // Anything dropped rather than carried would accumulate as bytes the server
    // believes this browser still owes, and would eventually pause it forever.
    expect(parsed - acknowledged).toBeLessThan(TERMINAL_ACK_BYTES);
  });

  it("leaves a remainder smaller than the amount that keeps a terminal paused", () => {
    const ack = new TerminalOutputAck();

    // The server resumes below TERMINAL_ACK_BYTES owed, so a stream that stops
    // mid-batch must never strand more than that unacknowledged.
    expect(ack.parsed(TERMINAL_ACK_BYTES * 4 - 1)).toBe(TERMINAL_ACK_BYTES * 4 - 1);
    expect(ack.parsed(TERMINAL_ACK_BYTES - 1)).toBeUndefined();
  });

  it("ignores empty and invalid counts", () => {
    const ack = new TerminalOutputAck();

    expect(ack.parsed(0)).toBeUndefined();
    expect(ack.parsed(-5)).toBeUndefined();
    expect(ack.parsed(Number.NaN)).toBeUndefined();
    expect(ack.parsed(TERMINAL_ACK_BYTES)).toBe(TERMINAL_ACK_BYTES);
  });
});
