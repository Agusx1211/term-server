import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { expectNoPendingRecovery, expectSingleTerminalSocket, expectTerminalInteractive, assertMonotonicSequences } from "../assertions/terminal-state.js";
import { expectTerminalNonBlank } from "../assertions/terminal-pixels.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import TerminalPanePage from "../pages/terminal-pane.js";

const DIAGNOSTICS_TIMEOUT = 15_000;
const GEOMETRY_A = { width: 1_024, height: 768 };
const GEOMETRY_B = { width: 1_920, height: 1_200 };

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

async function waitForConnectingViewport(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.socketState === "connecting" && snapshot.socketReadyState === 0 && snapshot.urlViewport !== undefined,
      { timeout },
    );
  }, { id: terminalId, timeout: DIAGNOSTICS_TIMEOUT });
}

async function waitForConnectingResize(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const original = api.terminal(id)?.urlViewport;
    if (!original) throw new Error(`No connecting URL viewport for terminal ${id}`);
    return api.waitForTerminal(
      id,
      (snapshot) => {
        const desired = snapshot.desiredViewport;
        return snapshot.socketState === "connecting"
          && snapshot.socketReadyState === 0
          && desired !== undefined
          && (desired.cols !== original.cols || desired.rows !== original.rows);
      },
      { timeout },
    );
  }, { id: terminalId, timeout: DIAGNOSTICS_TIMEOUT });
}

async function waitForConvergedViewport(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => {
        const desired = snapshot.desiredViewport;
        const sent = snapshot.sentViewport;
        const server = snapshot.serverViewport;
        if (!desired || !sent || !server) return false;
        const sameViewport = (
          left: { cols: number; rows: number; pixelWidth: number; pixelHeight: number },
          right: { cols: number; rows: number; pixelWidth: number; pixelHeight: number },
        ): boolean => left.cols === right.cols
          && left.rows === right.rows
          && left.pixelWidth === right.pixelWidth
          && left.pixelHeight === right.pixelHeight;
        return snapshot.socketState === "connected"
          && snapshot.acceptingInput
          && snapshot.syncMode === undefined
          && snapshot.syncTarget === undefined
          && sameViewport(desired, sent)
          && sameViewport(desired, server)
          && snapshot.cols === desired.cols
          && snapshot.rows === desired.rows
          && snapshot.viewport.cols === desired.cols
          && snapshot.viewport.rows === desired.rows;
      },
      { timeout },
    );
  }, { id: terminalId, timeout: DIAGNOSTICS_TIMEOUT });
}

async function waitForBufferMarker(page: Page, terminalId: string, marker: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, marker: expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.xterm.text.replaceAll("\n", "").includes(expected),
      { timeout },
    );
  }, { id: terminalId, marker, timeout: DIAGNOSTICS_TIMEOUT });
}

function isFrameForResize(event: { type: string; terminalId?: string; direction?: string; frame?: { jsonType?: string } }, terminalId: string): boolean {
  return event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "resize";
}

test("P0-03 Resize while WebSocket is connecting @p0 @smoke", async ({ page, server, faultController }) => {
  await page.setViewportSize(GEOMETRY_A);
  const delayedUpgrade = faultController.delayUpgrade(undefined, 5_000);
  try {
    await page.goto("/");
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const mounted = page.evaluate(async (timeout) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount", { timeout });
    }, DIAGNOSTICS_TIMEOUT);
    await workbench.createTerminal();
    const mount = await mounted;
    const terminalId = mount.terminalId;
    const pane = new TerminalPanePage(page, terminalId);

    const delayed = faultController.waitFor(
      (event) => event.type === "upgrade-delay" && event.terminalId === terminalId,
      { timeoutMs: DIAGNOSTICS_TIMEOUT },
    );
    const connecting = await waitForConnectingViewport(page, terminalId);
    await delayed;
    await pane.expectVisible();
    expect(connecting.urlViewport).toBeDefined();
    expect(connecting.socketReadyState).toBe(0);
    expect(connecting.socketState).toBe("connecting");

    const resizeFrame = faultController.waitFor(
      (event) => isFrameForResize(event, terminalId),
      { timeoutMs: DIAGNOSTICS_TIMEOUT },
    );
    const upgradeOpen = faultController.waitFor(
      (event) => event.type === "upgrade-open" && event.terminalId === terminalId,
      { timeoutMs: DIAGNOSTICS_TIMEOUT },
    );
    expect(faultController.events.filter((event) => isFrameForResize(event, terminalId))).toHaveLength(0);
    await page.setViewportSize(GEOMETRY_B);
    const resized = await waitForConnectingResize(page, terminalId);
    const initialViewport = connecting.urlViewport!;
    const connectingViewport = resized.desiredViewport!;
    expect(resized.socketState).toBe("connecting");
    expect(resized.socketReadyState).toBe(0);
    expect(connectingViewport.cols !== initialViewport.cols || connectingViewport.rows !== initialViewport.rows).toBe(true);

    const [resizeFrameEvent, upgradeOpenEvent] = await Promise.all([resizeFrame, upgradeOpen]);
    expect(resizeFrameEvent.direction).toBe("browser-to-server");
    expect(resizeFrameEvent.frame?.jsonType).toBe("resize");
    expect(upgradeOpenEvent.type).toBe("upgrade-open");

    const synchronized = await pane.waitForSynchronized({ timeout: DIAGNOSTICS_TIMEOUT });
    expect(synchronized.socketState).toBe("connected");
    const converged = await waitForConvergedViewport(page, terminalId);
    const desiredViewport = converged.desiredViewport;
    if (!desiredViewport) throw new Error("synchronized terminal did not expose a desired viewport");
    expect(desiredViewport.cols !== initialViewport.cols || desiredViewport.rows !== initialViewport.rows).toBe(true);
    expect(converged.sentViewport).toEqual({ ...desiredViewport, source: "sent" });
    expect(converged.serverViewport).toEqual({ ...desiredViewport, source: "server" });
    expect(converged.cols).toBe(desiredViewport.cols);
    expect(converged.rows).toBe(desiredViewport.rows);
    expect(converged.viewport).toEqual({ ...desiredViewport, source: "server" });

    const sizeId = "P003-SIZE-B";
    const readyId = "P003-READY";
    const winchEntry = await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "sigwinch" && entry.rows === desiredViewport.rows && entry.cols === desiredViewport.cols
    ), { timeoutMs: DIAGNOSTICS_TIMEOUT }) as { rows: number; cols: number };
    expect(winchEntry.rows).toBe(desiredViewport.rows);
    expect(winchEntry.cols).toBe(desiredViewport.cols);
    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: DIAGNOSTICS_TIMEOUT });

    await pane.sendInput(`SIZE ${sizeId}`, true);
    const sizeEntry = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: DIAGNOSTICS_TIMEOUT }) as { rows: number; cols: number };
    expect(sizeEntry.rows).toBe(desiredViewport.rows);
    expect(sizeEntry.cols).toBe(desiredViewport.cols);

    const cursorId = "P003-CURSOR-B";
    const wrapId = "P003-WRAP-B";
    await pane.sendInput(`CURSOR ${cursorId} 1 1`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "cursor" && entry.id === cursorId, { timeoutMs: DIAGNOSTICS_TIMEOUT });
    const wrapPayload = "W".repeat(desiredViewport.cols + 17);
    const wrapMarker = `[E2E:PRINT:${wrapId}:${wrapPayload}]`;
    await pane.sendInput(`PRINT ${wrapId} ${wrapPayload}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === wrapId, { timeoutMs: DIAGNOSTICS_TIMEOUT });
    const wrapped = await waitForBufferMarker(page, terminalId, wrapMarker);
    const markerStart = wrapped.xterm.text.indexOf(wrapMarker.slice(0, 16));
    expect(markerStart).toBeGreaterThanOrEqual(0);
    const lineStart = wrapped.xterm.text.lastIndexOf("\n", markerStart - 1) + 1;
    const markerColumn = markerStart - lineStart;
    expect(markerColumn).toBeGreaterThanOrEqual(0);
    expect(markerColumn).toBeLessThan(desiredViewport.cols);
    expect(wrapMarker.length).toBeGreaterThan(desiredViewport.cols);
    let expectedRendered = "";
    let expectedOffset = 0;
    let expectedColumn = markerColumn;
    while (expectedOffset < wrapMarker.length) {
      const count = Math.min(desiredViewport.cols - expectedColumn, wrapMarker.length - expectedOffset);
      expectedRendered += wrapMarker.slice(expectedOffset, expectedOffset + count);
      expectedOffset += count;
      expectedColumn = 0;
      if (expectedOffset < wrapMarker.length) expectedRendered += "\n";
    }
    let actualRendered = "";
    let actualOffset = 0;
    for (let index = markerStart; index < wrapped.xterm.text.length && actualOffset < wrapMarker.length; index += 1) {
      const character = wrapped.xterm.text[index]!;
      if (character === "\n") {
        actualRendered += character;
      } else {
        expect(character).toBe(wrapMarker[actualOffset]);
        actualRendered += character;
        actualOffset += 1;
      }
    }
    expect(actualOffset).toBe(wrapMarker.length);
    expect(actualRendered).toBe(expectedRendered);

    const echoId = "P003-ECHO-B";
    const echoPayload = "P003-CONTINUED-INPUT";
    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: DIAGNOSTICS_TIMEOUT });
    await pane.sendInput(echoPayload, true);
    const echoEntry = await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload", { timeoutMs: DIAGNOSTICS_TIMEOUT }) as { payload_base64?: string };
    expect(echoEntry.payload_base64).toBe(Buffer.from(echoPayload).toString("base64"));
    await waitForBufferMarker(page, terminalId, `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoPayload).toString("base64")}]`);

    const final = await expectTerminalInteractive(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
    await expectSingleTerminalSocket(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
    await expectNoPendingRecovery(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
    await assertMonotonicSequences(await pane.events());
    const events = await pane.events();
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
    const sentViewportEvents = events.filter((event) => event.type === "viewport" && event.data.source === "sent" && event.data.cols === desiredViewport.cols && event.data.rows === desiredViewport.rows);
    expect(sentViewportEvents.length).toBeGreaterThanOrEqual(1);
    const latestSentViewportEvent = sentViewportEvents[sentViewportEvents.length - 1];
    expect(latestSentViewportEvent?.data.pixelWidth).toBe(desiredViewport.pixelWidth);
    expect(latestSentViewportEvent?.data.pixelHeight).toBe(desiredViewport.pixelHeight);
    expect(final.socketState).toBe("connected");
    expect(final.activeSocketCount).toBe(1);
    expect(final.cols).toBe(desiredViewport.cols);
    expect(final.rows).toBe(desiredViewport.rows);
    expect(final.sentViewport).toEqual({ ...desiredViewport, source: "sent" });
    expect(final.serverViewport).toEqual({ ...desiredViewport, source: "server" });
    await expectTerminalNonBlank(page, pane.xtermHost);
  } finally {
    delayedUpgrade.dispose();
  }
});
