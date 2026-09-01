import { describe, expect, it } from "vitest";
import {
  TERMINAL_KEEPALIVE_DEAD_SOCKET_TICKS,
  TERMINAL_KEEPALIVE_SILENCE_BUDGET_MS,
  TERMINAL_PARSER_STALL_MS,
  terminalKeepaliveAction,
  type TerminalKeepaliveState,
} from "./terminal-keepalive";

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const NOW = 1_000_000;

function state(overrides: Partial<TerminalKeepaliveState> = {}): TerminalKeepaliveState {
  return {
    now: NOW,
    exited: false,
    readyState: OPEN,
    deadSocketTicks: 0,
    hidden: false,
    visible: true,
    unparsedWrites: 0,
    lastParseProgressAt: NOW,
    pendingPingSince: undefined,
    ...overrides,
  };
}

describe("terminal keepalive", () => {
  it("does nothing for a pane that holds no socket", () => {
    expect(terminalKeepaliveAction(state({ readyState: undefined, deadSocketTicks: 1 })))
      .toEqual({ action: "idle", deadSocketTicks: 0 });
  });

  it("pings a healthy socket", () => {
    expect(terminalKeepaliveAction(state())).toEqual({ action: "ping", deadSocketTicks: 0 });
  });

  it("rebuilds a socket that closed without its cleanup running", () => {
    let ticks = 0;
    for (let tick = 1; tick < TERMINAL_KEEPALIVE_DEAD_SOCKET_TICKS; tick += 1) {
      const decision = terminalKeepaliveAction(state({ readyState: CLOSED, deadSocketTicks: ticks }));
      expect(decision.action).toBe("idle");
      ticks = decision.deadSocketTicks;
    }
    expect(terminalKeepaliveAction(state({ readyState: CLOSING, deadSocketTicks: ticks })))
      .toEqual({ action: "rebuild", deadSocketTicks: 0 });
  });

  it("releases an exited terminal's socket instead of recovering it", () => {
    // The exit banner is final: the process is gone, so a closed socket is
    // expected and must never turn into a "Catching up" spinner.
    for (const readyState of [OPEN, CLOSING, CLOSED]) {
      expect(terminalKeepaliveAction(state({
        exited: true,
        readyState,
        deadSocketTicks: TERMINAL_KEEPALIVE_DEAD_SOCKET_TICKS - 1,
      }))).toEqual({ action: "release", deadSocketTicks: 0 });
    }
  });

  it("recovers a foreground pane whose parser stopped making progress", () => {
    const stalled = state({
      unparsedWrites: 3,
      lastParseProgressAt: NOW - TERMINAL_PARSER_STALL_MS - 1,
    });
    expect(terminalKeepaliveAction(stalled).action).toBe("recover-stall");
    expect(terminalKeepaliveAction({ ...stalled, hidden: true }).action).toBe("ping");
    expect(terminalKeepaliveAction({ ...stalled, visible: false }).action).toBe("ping");
  });

  it("times out only once a ping has gone unanswered for the whole budget", () => {
    const sentAt = NOW - TERMINAL_KEEPALIVE_SILENCE_BUDGET_MS;
    expect(terminalKeepaliveAction(state({ pendingPingSince: sentAt })).action).toBe("ping");
    expect(terminalKeepaliveAction(state({ pendingPingSince: sentAt - 1 })).action).toBe("timeout");
  });

  it("keeps an idle pane in a throttled background tab connected", () => {
    // Chrome runs a hidden tab's timers about once a minute, so the newest
    // message from an idle shell is always about a minute old. Measuring
    // silence from the last message closed the socket on every second wake.
    const throttledTick = 60_000;
    let pendingPingSince: number | undefined;
    let now = NOW;
    for (let tick = 0; tick < 10; tick += 1) {
      const decision = terminalKeepaliveAction(state({ now, pendingPingSince }));
      expect(decision.action).toBe("ping");
      pendingPingSince = pendingPingSince ?? now;
      // The pong lands right after the ping and clears the outstanding ping.
      pendingPingSince = undefined;
      now += throttledTick;
    }
  });

  it("still times out a throttled tab whose server has gone silent", () => {
    let pendingPingSince: number | undefined;
    let now = NOW;
    const actions: string[] = [];
    for (let tick = 0; tick < 2; tick += 1) {
      const decision = terminalKeepaliveAction(state({ now, pendingPingSince }));
      actions.push(decision.action);
      if (decision.action === "ping") pendingPingSince = pendingPingSince ?? now;
      now += 60_000;
    }
    expect(actions).toEqual(["ping", "timeout"]);
  });
});
