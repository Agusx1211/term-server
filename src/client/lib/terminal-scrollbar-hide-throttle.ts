import type { Terminal } from "@xterm/xterm";

// Mirrors Constants.HIDE_TIMEOUT in xterm's ScrollableElement.
const XTERM_SCROLLBAR_HIDE_TIMEOUT_MS = 500;
// How stale a pending hide may grow before it is re-armed. The scrollbar may
// fade this much earlier than upstream, in exchange for a bounded ~10 timer
// operations per second.
const REARM_SLACK_MS = 100;

interface ScrollableElementInternals {
  _scheduleHide?: (this: unknown) => void;
}

interface TerminalInternals {
  _core?: {
    _viewport?: {
      _scrollableElement?: ScrollableElementInternals;
    };
  };
}

/**
 * xterm's overlay scrollbar re-arms its hide timeout (clearTimeout +
 * setTimeout) on every scroll event, and terminal output emits one scroll
 * event per scrolled line — hundreds of timer churns per second during a
 * burst. Wraps the private scheduler so a pending hide is reused until it is
 * within REARM_SLACK_MS of firing.
 *
 * Reaches into private xterm internals by name; property names survive the
 * production build, and a mismatch after an xterm upgrade degrades to the
 * upstream behaviour.
 */
export function throttleTerminalScrollbarHide(terminal: Terminal): boolean {
  const scrollable = (terminal as TerminalInternals)._core?._viewport?._scrollableElement;
  const original = scrollable?._scheduleHide;
  if (!scrollable || typeof original !== "function") return false;
  let armedUntil = 0;
  scrollable._scheduleHide = function scheduleHideThrottled(this: unknown) {
    const now = Date.now();
    if (armedUntil - now > XTERM_SCROLLBAR_HIDE_TIMEOUT_MS - REARM_SLACK_MS) return;
    armedUntil = now + XTERM_SCROLLBAR_HIDE_TIMEOUT_MS;
    original.call(this);
  };
  return true;
}
