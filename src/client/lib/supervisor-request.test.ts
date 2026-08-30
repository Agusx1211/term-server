import { afterEach, describe, expect, it, vi } from "vitest";
import { armSupervisorRequestTimeout } from "./supervisor-request";

afterEach(() => vi.useRealTimers());

describe("supervisor request timeout", () => {
  it("aborts a request that does not settle", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    armSupervisorRequestTimeout(controller, 100);
    vi.advanceTimersByTime(99);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("can be cancelled after a request settles", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancel = armSupervisorRequestTimeout(controller, 100);
    cancel();
    vi.advanceTimersByTime(100);
    expect(controller.signal.aborted).toBe(false);
  });
});
