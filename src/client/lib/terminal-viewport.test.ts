import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSettledTask,
  nextTerminalViewportReport,
  resyncTerminalScrollArea,
  terminalViewportForServerSize,
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

describe("server-selected terminal viewport diagnostics", () => {
  it("pairs size control cells with the latest sent or URL viewport pixels", () => {
    const initial = { cols: 80, rows: 24, pixelWidth: 720, pixelHeight: 408 };
    const latest = { cols: 120, rows: 36, pixelWidth: 1080, pixelHeight: 612 };

    expect(terminalViewportForServerSize(
      { cols: latest.cols, rows: latest.rows },
      latest,
    )).toEqual(latest);
    expect(terminalViewportForServerSize(
      { cols: 120, rows: 36 },
      initial,
    )).toEqual({
      cols: 120,
      rows: 36,
      pixelWidth: initial.pixelWidth,
      pixelHeight: initial.pixelHeight,
    });
  });
});

describe("socket-ready viewport reporting", () => {
  it("keeps a connecting resize pending until the socket opens", () => {
    const initial = "80x24@720x408";
    const resized = "120x36@1080x612";

    expect(nextTerminalViewportReport(initial, resized, false)).toBeUndefined();
    expect(nextTerminalViewportReport(initial, resized, true)).toBe(resized);
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

describe("xterm scroll area re-sync", () => {
  const fakeTerminal = (viewport: Record<string, unknown>) => ({
    buffer: { active: { viewportY: 42 } },
    _core: { viewport },
  });

  it("re-syncs the private viewport and re-anchors the scrollbar", () => {
    const sync = vi.fn();
    const scrollToLine = vi.fn();
    const terminal = fakeTerminal({ _sync: sync, scrollToLine });

    expect(resyncTerminalScrollArea(terminal)).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(scrollToLine).toHaveBeenCalledWith(42, true);
  });

  it("falls back to queueSync when _sync is unavailable", () => {
    const queueSync = vi.fn();
    const terminal = fakeTerminal({ queueSync });

    expect(resyncTerminalScrollArea(terminal)).toBe(true);
    expect(queueSync).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the internals are unreachable", () => {
    expect(resyncTerminalScrollArea(undefined)).toBe(false);
    expect(resyncTerminalScrollArea({})).toBe(false);
    expect(resyncTerminalScrollArea({ _core: { viewport: {} } })).toBe(false);
  });
});
