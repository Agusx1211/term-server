import { describe, expect, it } from "vitest";
import {
  TERMINAL_FRAME_OUTPUT,
  TERMINAL_FRAME_SNAPSHOT,
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
});
