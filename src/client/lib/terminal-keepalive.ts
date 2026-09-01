/** How often a pane checks that its stream is still alive. */
export const TERMINAL_KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * How long an unanswered ping may stand before the connection is treated as
 * dead. Measured from the OLDEST unanswered ping rather than from the last
 * message: a background tab under Chrome's intensive throttling only runs its
 * timers once a minute, and an idle shell's only traffic is the pong from the
 * previous wake. Timing that against the last message declared every second
 * wake a timeout, so an idle hidden pane rebuilt its stream every two minutes.
 */
export const TERMINAL_KEEPALIVE_SILENCE_BUDGET_MS = 45_000;

/**
 * How long a pane may hold outstanding writes with no parse progress before its
 * xterm write pump is considered dead and the stream is rebuilt. Generous: a
 * healthy parser settles each frame within milliseconds, and a burst still
 * reports progress per frame.
 */
export const TERMINAL_PARSER_STALL_MS = 30_000;

/** Consecutive ticks a closed-but-uncleaned socket is given before rebuilding. */
export const TERMINAL_KEEPALIVE_DEAD_SOCKET_TICKS = 2;

export type TerminalKeepaliveAction =
  /** Nothing to do this tick. */
  | "idle"
  /**
   * The terminal exited while this pane was mounted. The server closes the
   * socket right after the exit message and the close handler deliberately
   * leaves the pane alone, so the only thing left is to drop the reference to
   * the closed socket. Without this the dead-socket rebuild below fired two
   * ticks later and replaced the exit banner with a recovery spinner that
   * nothing could ever clear.
   */
  | "release"
  /** The socket closed but its cleanup never ran: rebuild the stream. */
  | "rebuild"
  /** xterm's write pump stopped making progress: resynchronize from a snapshot. */
  | "recover-stall"
  /** The server stopped answering: close the socket and let the close handler reconnect. */
  | "timeout"
  /** Healthy: send the periodic ping. */
  | "ping";

export interface TerminalKeepaliveState {
  readonly now: number;
  /** The terminal process has exited; the pane keeps its final buffer. */
  readonly exited: boolean;
  /** `WebSocket.readyState`, or `undefined` when the pane holds no socket. */
  readonly readyState: number | undefined;
  /** Consecutive previous ticks that saw a closed socket. */
  readonly deadSocketTicks: number;
  /** `document.hidden`: a throttled tab parses slowly by design. */
  readonly hidden: boolean;
  /** The pane is on screen rather than cached off screen. */
  readonly visible: boolean;
  readonly unparsedWrites: number;
  readonly lastParseProgressAt: number;
  /** When the oldest unanswered ping was sent, or `undefined` when none is outstanding. */
  readonly pendingPingSince: number | undefined;
}

export interface TerminalKeepaliveDecision {
  readonly action: TerminalKeepaliveAction;
  /** The tick count to carry into the next keepalive tick. */
  readonly deadSocketTicks: number;
}

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;

/** What a pane's keepalive tick should do, given everything it can observe. */
export function terminalKeepaliveAction(state: TerminalKeepaliveState): TerminalKeepaliveDecision {
  if (state.readyState === undefined) return { action: "idle", deadSocketTicks: 0 };
  if (state.exited) return { action: "release", deadSocketTicks: 0 };
  if (state.readyState === WEBSOCKET_CLOSING || state.readyState === WEBSOCKET_CLOSED) {
    const deadSocketTicks = state.deadSocketTicks + 1;
    if (deadSocketTicks < TERMINAL_KEEPALIVE_DEAD_SOCKET_TICKS) {
      return { action: "idle", deadSocketTicks };
    }
    return { action: "rebuild", deadSocketTicks: 0 };
  }
  if (state.readyState !== WEBSOCKET_OPEN) return { action: "idle", deadSocketTicks: 0 };
  if (
    !state.hidden
    && state.visible
    && state.unparsedWrites > 0
    && state.now - state.lastParseProgressAt > TERMINAL_PARSER_STALL_MS
  ) {
    return { action: "recover-stall", deadSocketTicks: 0 };
  }
  if (
    state.pendingPingSince !== undefined
    && state.now - state.pendingPingSince > TERMINAL_KEEPALIVE_SILENCE_BUDGET_MS
  ) {
    return { action: "timeout", deadSocketTicks: 0 };
  }
  return { action: "ping", deadSocketTicks: 0 };
}
