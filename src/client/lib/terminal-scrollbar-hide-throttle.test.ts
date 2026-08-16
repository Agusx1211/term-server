import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { throttleTerminalScrollbarHide } from "./terminal-scrollbar-hide-throttle";

const fakeTerminal = (scheduleHide: () => void) => ({
  _core: { _viewport: { _scrollableElement: { _scheduleHide: scheduleHide } } },
}) as unknown as Terminal;

const wrappedScheduler = (terminal: Terminal) =>
  (terminal as unknown as {
    _core: { _viewport: { _scrollableElement: { _scheduleHide: () => void } } };
  })._core._viewport._scrollableElement._scheduleHide;

describe("throttleTerminalScrollbarHide", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses per-scroll re-arms while the pending hide stays fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const scheduleHide = vi.fn();
    const terminal = fakeTerminal(scheduleHide);

    expect(throttleTerminalScrollbarHide(terminal)).toBe(true);
    const wrapped = wrappedScheduler(terminal);
    for (let scroll = 0; scroll < 100; scroll += 1) wrapped();
    expect(scheduleHide).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + 150);
    wrapped();
    expect(scheduleHide).toHaveBeenCalledTimes(2);
  });

  it("re-arms freely once the previous hide window has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const scheduleHide = vi.fn();
    const terminal = fakeTerminal(scheduleHide);
    throttleTerminalScrollbarHide(terminal);
    const wrapped = wrappedScheduler(terminal);

    wrapped();
    vi.setSystemTime(1_000_000 + 700);
    wrapped();
    expect(scheduleHide).toHaveBeenCalledTimes(2);
  });

  it("leaves terminals without the expected internals untouched", () => {
    expect(throttleTerminalScrollbarHide({} as Terminal)).toBe(false);
    expect(
      throttleTerminalScrollbarHide({ _core: { _viewport: {} } } as unknown as Terminal),
    ).toBe(false);
  });
});
