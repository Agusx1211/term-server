import { describe, expect, it, vi } from "vitest";
import {
  parseConfirmTerminalKills,
  terminalKillAllowed,
} from "./terminal-kill";

describe("terminal kill preferences", () => {
  it("keeps confirmation enabled unless it was explicitly disabled", () => {
    expect(parseConfirmTerminalKills(null)).toBe(true);
    expect(parseConfirmTerminalKills("true")).toBe(true);
    expect(parseConfirmTerminalKills("invalid")).toBe(true);
    expect(parseConfirmTerminalKills("false")).toBe(false);
  });

  it("kills immediately without invoking confirmation when confirmation is disabled", () => {
    const confirm = vi.fn(() => false);

    expect(terminalKillAllowed("~/project/server", false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("includes the terminal path and honors confirmation when enabled", () => {
    const confirm = vi.fn(() => false);

    expect(terminalKillAllowed("~/project/server", true, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      "Kill and remove “~/project/server”? The process and its scrollback will be lost.",
    );
  });
});
