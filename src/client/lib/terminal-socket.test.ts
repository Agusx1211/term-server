import { describe, expect, it, vi } from "vitest";
import {
  addTerminalStreamProtocol,
  closeTerminalSocket,
  TERMINAL_SOCKET_PRE_SYNC_FAILURE_LIMIT,
  TerminalSocketFailureTracker,
  TERMINAL_STREAM_PROTOCOL,
  type TerminalSocketCloseCause,
} from "./terminal-socket";

describe("terminal stream negotiation", () => {
  it("marks sockets as consumers of framed terminal output", () => {
    const url = addTerminalStreamProtocol(new URL("wss://terminal.test/api/terminals/1/socket"));

    expect(url.searchParams.get("stream")).toBe(String(TERMINAL_STREAM_PROTOCOL));
  });
});

describe("terminal WebSocket pre-sync failure tracking", () => {
  it("bounds failures before synced and resets after a successful sync", () => {
    const tracker = new TerminalSocketFailureTracker();

    for (let attempt = 1; attempt < TERMINAL_SOCKET_PRE_SYNC_FAILURE_LIMIT; attempt += 1) {
      expect(tracker.recordBeforeReady()).toBe(false);
      expect(tracker.count).toBe(attempt);
    }
    expect(tracker.recordBeforeReady()).toBe(true);
    expect(tracker.count).toBe(TERMINAL_SOCKET_PRE_SYNC_FAILURE_LIMIT);

    tracker.reset();
    expect(tracker.count).toBe(0);
    expect(tracker.recordBeforeReady()).toBe(false);
  });
});

describe("terminal WebSocket close handling", () => {
  it.each([
    ["backlog", 4003, "Terminal renderer fell behind"],
    ["protocol-error", 4002, "Invalid terminal stream"],
    ["timeout", 4001, "Terminal connection timed out"],
  ] satisfies [TerminalSocketCloseCause, number, string][])(
    "uses a browser-sendable application close code for %s",
    (cause, code, reason) => {
      const close = vi.fn();
      closeTerminalSocket({ close }, cause);
      expect(close).toHaveBeenCalledWith(code, reason);
      expect(code).toBeGreaterThanOrEqual(3000);
      expect(code).toBeLessThanOrEqual(4999);
    },
  );
});
