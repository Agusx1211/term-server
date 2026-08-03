import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSettledTask,
  terminalViewportSize,
} from "./terminal-viewport";

describe("terminal viewport sizing", () => {
  it("scales the rendered text area to the proposed grid", () => {
    expect(terminalViewportSize(
      { cols: 100, rows: 30 },
      { cols: 80, rows: 24, pixelWidth: 720, pixelHeight: 408 },
    )).toEqual({ cols: 100, rows: 30, pixelWidth: 900, pixelHeight: 510 });
  });

  it("rounds and clamps every client value to the positive u16 range", () => {
    expect(terminalViewportSize(
      { cols: 100_000, rows: 1.6 },
      { cols: 2, rows: 1, pixelWidth: 100_000, pixelHeight: 1.6 },
    )).toEqual({ cols: 500, rows: 2, pixelWidth: 65_535, pixelHeight: 3 });
  });

  it("rejects missing or non-positive rendered geometry", () => {
    expect(terminalViewportSize(
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 408 },
    )).toBeUndefined();
  });
});

describe("settled terminal viewport reporting", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces a resize burst and reports only after it settles", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const task = createSettledTask(report, 100);

    task.schedule();
    vi.advanceTimersByTime(80);
    task.schedule();
    vi.advanceTimersByTime(99);
    expect(report).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending report", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const task = createSettledTask(report, 100);
    task.schedule();
    task.cancel();
    vi.runAllTimers();
    expect(report).not.toHaveBeenCalled();
  });
});
