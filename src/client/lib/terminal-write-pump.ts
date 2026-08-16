import type { Terminal } from "@xterm/xterm";

interface TimerInternals {
  cancelAndSet?: (this: unknown, runner: () => void, timeout: number) => void;
  cancel?: (this: unknown) => void;
}

interface TerminalInternals {
  _core?: {
    _writeBuffer?: {
      _innerWriteTimer?: TimerInternals;
    };
  };
}

/** Schedules a task to run on a future macrotask and can undo the scheduling. */
export interface WritePumpScheduler {
  schedule(task: () => void): () => void;
}

/**
 * A scheduler that escapes DOM-timer throttling.
 *
 * xterm paces terminal parsing in ~12 ms slices, one slice per `setTimeout(0)`
 * tick (WriteBuffer._scheduleInnerWrite → TimeoutTimer.cancelAndSet). A page
 * whose timers are throttled — a backgrounded tab, an occluded window, an
 * embedded webview, or a headless session, some of which report
 * `document.visibilityState === "visible"` the whole time — only wakes that
 * timer a handful of times per second. Parsing then runs at a few dozen
 * milliseconds per second of wall time, and a snapshot replay of a megabyte or
 * more (a pane remounting after its cache slot was taken) crawls for the best
 * part of a minute while the viewport follows the parse frontier. MessagePort
 * tasks are regular event-loop tasks rather than DOM timers, so they keep
 * firing at full speed in exactly those states.
 */
export const createMessageChannelScheduler = (): WritePumpScheduler => {
  const channel = new MessageChannel();
  let pending: (() => void) | undefined;
  channel.port1.onmessage = () => {
    const task = pending;
    pending = undefined;
    task?.();
  };
  return {
    schedule(task: () => void): () => void {
      pending = task;
      channel.port2.postMessage(null);
      return () => {
        if (pending === task) pending = undefined;
      };
    },
  };
};

export interface UnthrottleTerminalWritePumpOptions {
  scheduler?: WritePumpScheduler;
  isHidden?: () => boolean;
}

/**
 * Keeps xterm's write pump parsing at full speed while the page is being
 * viewed, by re-routing its zero-delay scheduling away from `setTimeout`.
 *
 * Only the zero-delay, page-visible path is re-routed: a nonzero delay keeps
 * using xterm's timer (the pump always passes 0 today, so this is purely
 * future-proofing), and a hidden page keeps today's deliberately slow pacing
 * so background tabs parse exactly as they did before. Every call still passes
 * through xterm's own disposed checks before running: a task that fires after
 * the terminal was disposed is a no-op inside `_innerWrite`.
 *
 * Reaches into private xterm internals by name; property names survive the
 * production build, and a mismatch after an xterm upgrade degrades to the
 * upstream behaviour.
 */
export function unthrottleTerminalWritePump(
  terminal: Terminal,
  options: UnthrottleTerminalWritePumpOptions = {},
): boolean {
  // Reach into the private core terminal; xterm ships no public handle on the
  // write pump. Property names survive the production build and the whole
  // install degrades to upstream behaviour if an upgrade renames them.
  const internals = terminal as unknown as TerminalInternals;
  const timer = internals._core?._writeBuffer?._innerWriteTimer;
  const original = timer?.cancelAndSet;
  if (!timer || typeof original !== "function") return false;
  const scheduler = options.scheduler ?? createMessageChannelScheduler();
  const isHidden = options.isHidden ?? (() => globalThis.document?.hidden === true);
  let cancelScheduled: (() => void) | undefined;
  timer.cancelAndSet = function cancelAndSetUnthrottled(runner: () => void, timeout: number): void {
    cancelScheduled?.();
    cancelScheduled = undefined;
    if (timeout > 0 || isHidden()) {
      original.call(timer, runner, timeout);
      return;
    }
    timer.cancel?.call(timer);
    cancelScheduled = scheduler.schedule(runner);
  };
  return true;
}
