import { describe, expect, it, vi } from "vitest";

describe("installed E2E diagnostics facade", () => {
  it.runIf(import.meta.env.VITE_E2E === "true")("honors explicit event floors", async () => {
    vi.stubGlobal("WebSocket", { CLOSED: 3 });
    vi.stubGlobal("window", {
      clearTimeout,
      setTimeout,
    });

    const { installE2EDiagnostics, registerE2ETerminal } = await import("./e2e-diagnostics");
    const api = installE2EDiagnostics();
    if (!api) throw new Error("E2E diagnostics facade was not installed");

    const terminalId = "diagnostics-api-test";
    const handle = registerE2ETerminal({ terminalId, paneId: "diagnostics-api-pane" });
    try {
      handle.record("mount");
      const floor = api.events(terminalId).at(-1)?.id;
      if (floor === undefined) throw new Error("mount event was not recorded");

      const nextEvent = api.waitForEvent(
        terminalId,
        (event) => event.type === "parser-commit",
        { afterId: floor, timeout: 100 },
      );
      handle.record("parser-commit");

      await expect(nextEvent).resolves.toMatchObject({ type: "parser-commit" });
      await expect(api.waitForEvent(terminalId, "mount", { timeout: 0 })).rejects.toThrow(/Timed out/);
    } finally {
      handle.dispose();
      vi.unstubAllGlobals();
    }
  });
});
