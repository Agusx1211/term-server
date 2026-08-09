import { describe, expect, it, vi } from "vitest";
import { loadTerminalNerdFont, TERMINAL_FONT_FAMILY } from "./terminal-font";

describe("terminal Nerd Font fallback", () => {
  it("keeps the existing text fonts ahead of the bundled symbol face", () => {
    expect(TERMINAL_FONT_FAMILY).toContain(
      "Menlo, 'Symbols Nerd Font Mono', monospace",
    );
  });

  it("loads the Powerline probe once per document font set", async () => {
    const load = vi.fn(async () => []);
    const fonts = { load };

    const first = loadTerminalNerdFont(fonts);
    const second = loadTerminalNerdFont(fonts);
    expect(second).toBe(first);
    await first;

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith('16px "Symbols Nerd Font Mono"', "\ue0b0");
  });

  it("does not block the terminal when a browser rejects font loading", async () => {
    const fonts = { load: vi.fn(() => Promise.reject(new Error("font unavailable"))) };
    await expect(loadTerminalNerdFont(fonts)).resolves.toBeUndefined();
  });
});
