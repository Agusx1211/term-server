import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  createMessageChannelScheduler,
  unthrottleTerminalWritePump,
  type WritePumpScheduler,
} from "./terminal-write-pump";

interface CancelAndSet {
  (runner: () => void, timeout: number): void;
}

interface TimerLike {
  cancelAndSet: CancelAndSet;
  cancel: () => void;
}

const fakeTerminal = (timer: TimerLike) => ({
  _core: { _writeBuffer: { _innerWriteTimer: timer } },
}) as unknown as Terminal;

/** A scheduler the test controls: tasks queue up until flushed. */
interface ManualScheduler extends WritePumpScheduler {
  queued: number;
  flush(): void;
}

const manualScheduler = (): ManualScheduler => {
  const tasks: (() => void)[] = [];
  return {
    queued: 0,
    schedule(task: () => void): () => void {
      tasks.push(task);
      this.queued = tasks.length;
      return () => {
        const index = tasks.indexOf(task);
        if (index >= 0) tasks.splice(index, 1);
        this.queued = tasks.length;
      };
    },
    flush(): void {
      const pending = tasks.splice(0);
      this.queued = tasks.length;
      for (const task of pending) task();
    },
  };
};

interface FreshTimer {
  timer: TimerLike;
  originalCancelAndSet: CancelAndSet;
}

const freshTimer = (): FreshTimer => {
  const originalCancelAndSet = vi.fn() as CancelAndSet;
  return {
    timer: {
      cancelAndSet: originalCancelAndSet,
      cancel: vi.fn(),
    },
    originalCancelAndSet,
  };
};

describe("unthrottleTerminalWritePump", () => {
  it("routes zero-delay scheduling away from setTimeout while the page is visible", () => {
    const { timer, originalCancelAndSet } = freshTimer();
    const scheduler = manualScheduler();
    const hidden = vi.fn(() => false);

    expect(unthrottleTerminalWritePump(fakeTerminal(timer), { scheduler, isHidden: hidden }))
      .toBe(true);
    const runner = vi.fn();
    timer.cancelAndSet(runner, 0);

    expect(originalCancelAndSet).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    scheduler.flush();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("runs only the latest scheduled task", () => {
    const { timer } = freshTimer();
    const scheduler = manualScheduler();
    unthrottleTerminalWritePump(fakeTerminal(timer), { scheduler, isHidden: () => false });
    const first = vi.fn();
    const second = vi.fn();
    timer.cancelAndSet(first, 0);
    timer.cancelAndSet(second, 0);

    scheduler.flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps delegating to xterm's timer while the page is hidden", () => {
    const { timer, originalCancelAndSet } = freshTimer();
    const scheduler = manualScheduler();
    unthrottleTerminalWritePump(fakeTerminal(timer), { scheduler, isHidden: () => true });
    const runner = vi.fn();
    timer.cancelAndSet(runner, 0);

    expect(originalCancelAndSet).toHaveBeenCalledTimes(1);
    expect(originalCancelAndSet).toHaveBeenCalledWith(runner, 0);
    scheduler.flush();
    expect(runner).not.toHaveBeenCalled();
  });

  it("cancels a pending channel task when falling back to xterm's timer", () => {
    const { timer, originalCancelAndSet } = freshTimer();
    const scheduler = manualScheduler();
    let hidden = false;
    unthrottleTerminalWritePump(fakeTerminal(timer), { scheduler, isHidden: () => hidden });
    const stale = vi.fn();
    timer.cancelAndSet(stale, 0);

    hidden = true;
    const runner = vi.fn();
    timer.cancelAndSet(runner, 0);

    expect(originalCancelAndSet).toHaveBeenCalledWith(runner, 0);
    scheduler.flush();
    expect(stale).not.toHaveBeenCalled();
  });

  it("delegates nonzero timeouts to xterm's timer", () => {
    const { timer, originalCancelAndSet } = freshTimer();
    const scheduler = manualScheduler();
    unthrottleTerminalWritePump(fakeTerminal(timer), { scheduler, isHidden: () => false });
    const runner = vi.fn();
    timer.cancelAndSet(runner, 12);

    expect(originalCancelAndSet).toHaveBeenCalledWith(runner, 12);
    scheduler.flush();
    expect(runner).not.toHaveBeenCalled();
  });

  it("clears xterm's timer when taking over the scheduling", () => {
    const { timer } = freshTimer();
    const scheduler = manualScheduler();
    unthrottleTerminalWritePump(fakeTerminal(timer), { scheduler, isHidden: () => false });

    timer.cancelAndSet(vi.fn(), 0);

    expect(timer.cancel).toHaveBeenCalledTimes(1);
  });

  it("leaves terminals without the expected internals untouched", () => {
    expect(unthrottleTerminalWritePump({} as unknown as Terminal)).toBe(false);
    const bare = { _core: {} } as unknown as Terminal;
    expect(unthrottleTerminalWritePump(bare)).toBe(false);
  });
});

describe("createMessageChannelScheduler", () => {
  it("runs scheduled tasks as macrotasks and cancels them", async () => {
    const scheduler = createMessageChannelScheduler();
    const ran: string[] = [];
    const cancelStale = scheduler.schedule(() => ran.push("stale"));
    // MessagePort delivery is a platform macrotask that vitest's fake timers
    // cannot drive, and a `setTimeout(0)` races it (the two come from different
    // task sources, and under load the timer fires first). Resolve from inside
    // the task instead, so the wait ends exactly when the port delivered it.
    // The client tsconfig predates Promise.withResolvers, so use the executor
    // form.
    const fresh = new Promise<void>((resolve) => {
      scheduler.schedule(() => {
        ran.push("fresh");
        resolve();
      });
    });

    cancelStale();
    await fresh;
    expect(ran).toEqual(["fresh"]);

    // The stale task's own port message is still queued behind the one that
    // ran "fresh"; let it arrive and confirm it finds nothing to run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(ran).toEqual(["fresh"]);
  });
});
