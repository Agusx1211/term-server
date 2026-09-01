import { describe, expect, it, vi } from "vitest";
import {
  addTerminalStreamProtocol,
  closeTerminalSocket,
  isTerminalProtocolMismatch,
  probeTerminalServerReachability,
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

  it("keeps reporting every failure past the limit so the pane keeps asking why", () => {
    const tracker = new TerminalSocketFailureTracker();

    for (let attempt = 1; attempt < TERMINAL_SOCKET_PRE_SYNC_FAILURE_LIMIT; attempt += 1) {
      tracker.recordBeforeReady();
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(tracker.recordBeforeReady()).toBe(true);
    }
  });
});

describe("terminal stream failure classification", () => {
  const session = (authenticated: boolean) => async () => ({ authenticated });
  const unreachable = async (): Promise<{ authenticated: boolean }> => {
    throw new TypeError("Failed to fetch");
  };

  it("blames the browser's protocol only when the server answers and knows it", async () => {
    await expect(probeTerminalServerReachability(session(true))).resolves.toBe("reachable");
    expect(isTerminalProtocolMismatch("reachable")).toBe(true);
  });

  it("treats a lost network, a stopped server and an expired session as connectivity", async () => {
    // Every one of these closes the socket at 1006 with no `open`, exactly like
    // a real version mismatch, and every one of them heals without a reload.
    await expect(probeTerminalServerReachability(session(true), false)).resolves.toBe("offline");
    await expect(probeTerminalServerReachability(unreachable)).resolves.toBe("unreachable");
    await expect(probeTerminalServerReachability(session(false))).resolves.toBe("signed-out");
    for (const reachability of ["offline", "unreachable", "signed-out"] as const) {
      expect(isTerminalProtocolMismatch(reachability)).toBe(false);
    }
  });

  it("never asks an offline browser to reach the server", async () => {
    const probe = vi.fn(session(true));
    await expect(probeTerminalServerReachability(probe, false)).resolves.toBe("offline");
    expect(probe).not.toHaveBeenCalled();
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
