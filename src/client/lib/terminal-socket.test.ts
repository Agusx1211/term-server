import { describe, expect, it, vi } from "vitest";
import { closeTerminalSocket, type TerminalSocketCloseCause } from "./terminal-socket";

describe("terminal WebSocket close handling", () => {
  it.each([
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
