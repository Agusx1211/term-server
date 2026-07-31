import { describe, expect, it, vi } from "vitest";
import {
  addTerminalStreamProtocol,
  closeTerminalSocket,
  TERMINAL_STREAM_PROTOCOL,
  type TerminalSocketCloseCause,
} from "./terminal-socket";

describe("terminal stream negotiation", () => {
  it("marks sockets as consumers of framed terminal output", () => {
    const url = addTerminalStreamProtocol(new URL("wss://terminal.test/api/terminals/1/socket"));

    expect(url.searchParams.get("stream")).toBe(String(TERMINAL_STREAM_PROTOCOL));
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
