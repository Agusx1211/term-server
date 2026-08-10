import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

function positiveViewportEvent(event: E2ETerminalEvent, afterEventId: number): boolean {
  if (event.id <= afterEventId || event.type !== "viewport" || event.data.source !== "sent") return false;
  return ["cols", "rows", "pixelWidth", "pixelHeight"].every((key) => {
    const value = event.data[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  });
}

async function waitForMeasuredViewport(
  page: Page,
  terminalId: string,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => {
        if (event.id <= after || event.type !== "viewport" || event.data.source !== "sent") return false;
        return ["cols", "rows", "pixelWidth", "pixelHeight"].every((key) => {
          const value = event.data[key];
          return typeof value === "number" && Number.isFinite(value) && value > 0;
        });
      },
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledViewport(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      const sent = snapshot.sentViewport;
      const server = snapshot.serverViewport;
      if (!desired || !sent || !server) return false;
      return snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.cols === desired.cols
        && snapshot.rows === desired.rows
        && server.pixelWidth === desired.pixelWidth
        && server.pixelHeight === desired.pixelHeight
        && sent.cols === desired.cols
        && sent.rows === desired.rows
        && sent.pixelWidth === desired.pixelWidth
        && sent.pixelHeight === desired.pixelHeight
        && server.cols === desired.cols
        && server.rows === desired.rows
        && (snapshot.syncTarget === undefined
          || snapshot.committedSequence === undefined
          || snapshot.committedSequence >= snapshot.syncTarget);
    }, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

test("V-01 Initial zero-sized container @nightly", async ({ page, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.goto("/");
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const existingTerminalIds = await page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminals().map((snapshot) => snapshot.terminalId);
  });

  // Keep the production pane mounted, but make the actual FitAddon container
  // zero-sized before the terminal component's effects run.
  await workbench.editorGrid.evaluate((element) => {
    element.setAttribute("data-v01-zero-container", "true");
  });
  const zeroSizeStyle = await page.addStyleTag({
    content: `
      .editor-grid[data-v01-zero-container="true"] .xterm-host {
        display: block !important;
        flex: 0 0 0px !important;
        width: 0px !important;
        height: 0px !important;
        min-width: 0px !important;
        min-height: 0px !important;
      }
    `,
  });

  const mountEvent = page.evaluate(async ({ knownIds, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && !knownIds.includes(event.terminalId),
      { timeout },
    );
  }, { knownIds: existingTerminalIds, timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const terminal = workbench.terminal(terminalId);
  const host = terminal.xtermHost;
  await expect(host).toHaveCount(1);
  const fontSettled = terminal.waitForEvent("font-load", { timeout: WAIT_TIMEOUT_MS });

  const zeroGeometry = await host.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      width: bounds.width,
      height: bounds.height,
    };
  });
  expect(zeroGeometry.clientWidth).toBe(0);
  expect(zeroGeometry.clientHeight).toBe(0);
  expect(zeroGeometry.width).toBe(0);
  expect(zeroGeometry.height).toBe(0);

  const zeroSynced = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(zeroSynced.socketState).toBe("connected");
  expect(zeroSynced.pendingParserWrites).toBe(0);
  expect(zeroSynced.proposedViewport).toBeUndefined();
  expect(zeroSynced.desiredViewport).toBeUndefined();
  expect(zeroSynced.urlViewport).toBeUndefined();
  expect(zeroSynced.sentViewport).toBeUndefined();
  await fontSettled;

  const zeroEvents = await terminalEvents(page, terminalId);
  const zeroEventFloor = zeroEvents.at(-1)?.id ?? 0;
  expect(zeroEvents.filter((event) => event.type === "viewport" && event.data.source === "sent")).toHaveLength(0);
  const resizeFramesBeforeReveal = faultController.events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "resize"
  ));
  expect(resizeFramesBeforeReveal, "a zero-sized container must not send a resize frame").toHaveLength(0);

  const token = `V01-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-${Date.now()}`;
  const readyId = `${token}-READY`;
  const sizeId = `${token}-SIZE`;
  const printId = `${token}-PRINT`;
  const printText = `${token}-VISIBLE`;
  const echoId = `${token}-ECHO`;
  const inputText = `${token}-CONTINUED-INPUT`;

  const measuredViewportPromise = waitForMeasuredViewport(page, terminalId, zeroEventFloor);
  const firstResizeFramePromise = faultController.waitFor((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "resize"
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  await zeroSizeStyle.evaluate((element) => {
    if (!(element instanceof HTMLStyleElement)) throw new Error("zero-size style handle is not a style element");
    element.remove();
  });
  await workbench.editorGrid.evaluate((element) => {
    element.removeAttribute("data-v01-zero-container");
  });
  await terminal.expectVisible();

  const [measuredViewportEvent, firstResizeFrame] = await Promise.all([
    measuredViewportPromise,
    firstResizeFramePromise,
  ]);
  expect(measuredViewportEvent.type).toBe("viewport");
  expect(positiveViewportEvent(measuredViewportEvent, zeroEventFloor)).toBe(true);
  expect(measuredViewportEvent.data.source).toBe("sent");
  expect(firstResizeFrame.frame?.jsonType).toBe("resize");

  const measured = {
    cols: Number(measuredViewportEvent.data.cols),
    rows: Number(measuredViewportEvent.data.rows),
    pixelWidth: Number(measuredViewportEvent.data.pixelWidth),
    pixelHeight: Number(measuredViewportEvent.data.pixelHeight),
  } as const;
  for (const value of Object.values(measured)) {
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  }

  const settled = await waitForSettledViewport(page, terminalId);
  const finalViewport = settled.sentViewport;
  if (!finalViewport) throw new Error("terminal did not retain its measured sent viewport");
  expect(finalViewport.cols).toBe(settled.cols);
  expect(finalViewport.rows).toBe(settled.rows);
  expect(finalViewport.pixelWidth).toBeGreaterThan(0);
  expect(finalViewport.pixelHeight).toBeGreaterThan(0);
  expect(settled.desiredViewport?.cols).toBe(finalViewport.cols);
  expect(settled.desiredViewport?.rows).toBe(finalViewport.rows);
  expect(settled.serverViewport?.cols).toBe(finalViewport.cols);
  expect(settled.serverViewport?.rows).toBe(finalViewport.rows);
  expect(settled.serverViewport?.pixelWidth).toBe(finalViewport.pixelWidth);
  expect(settled.serverViewport?.pixelHeight).toBe(finalViewport.pixelHeight);

  const screen = host.locator(".xterm-screen");
  await expect(screen).toBeVisible();
  const screenBox = await screen.boundingBox();
  if (!screenBox) throw new Error("revealed terminal viewport has no compositor bounds");
  expect(Math.abs(finalViewport.pixelWidth - screenBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(finalViewport.pixelHeight - screenBox.height)).toBeLessThanOrEqual(1);
  const canvasMetrics = await host.locator("canvas").first().evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("terminal canvas locator did not resolve to a canvas");
    return {
      width: element.width,
      height: element.height,
      devicePixelRatio: window.devicePixelRatio,
    };
  });
  expect(Math.abs(canvasMetrics.width - Math.round(screenBox.width * canvasMetrics.devicePixelRatio))).toBeLessThanOrEqual(1);
  expect(Math.abs(canvasMetrics.height - Math.round(screenBox.height * canvasMetrics.devicePixelRatio))).toBeLessThanOrEqual(1);

  const readyPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(`READY ${readyId}`, true);
  await readyPromise;

  const sizePromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await sizePromise;
  expect(sizeEntry.cols).toBe(settled.cols);
  expect(sizeEntry.rows).toBe(settled.rows);
  expect(sizeEntry.pixel_width).toBe(finalViewport.pixelWidth);
  expect(sizeEntry.pixel_height).toBe(finalViewport.pixelHeight);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:SIZE:${sizeId}:`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const terminalViewport = host.locator(".xterm-screen");
  const beforePrint = await screenshotRegion(page, terminalViewport);
  const printPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === printId && entry.text === printText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(`PRINT ${printId} ${printText}`, true);
  await printPromise;
  const expectedMarker = `[E2E:PRINT:${printId}:${printText}]`;
  await expectTerminalBuffer(page, terminalId, {
    contains: expectedMarker,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, terminalViewport, beforePrint, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "v-01-revealed-marker-crop",
  });
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "v-01-revealed-terminal-crop",
  });

  const inputArmedPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
  const inputPayloadPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(inputText, true);
  const inputPayload = await inputPayloadPromise;
  expect(inputPayload.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);

  const finalEvents = await terminalEvents(page, terminalId);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(finalEvents.filter((event) => (
    event.type === "state"
    && ["disconnected", "recovering"].includes(String(event.data.state))
  ))).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "viewport" && event.data.source === "sent").length).toBeGreaterThan(0);
  for (const event of finalEvents.filter((candidate) => candidate.type === "viewport" && candidate.data.source === "sent")) {
    for (const key of ["cols", "rows", "pixelWidth", "pixelHeight"]) {
      const value = event.data[key];
      expect(typeof value).toBe("number");
      expect(Number(value)).toBeGreaterThan(0);
    }
  }
  await assertMonotonicSequences(finalEvents);
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  expect(invariantReport.snapshot.activeSocketCount).toBe(1);
  expect(invariantReport.snapshot.socket.activeCount).toBe(1);
  expect(invariantReport.snapshot.acceptingInput).toBe(true);

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || /unhandled(?:promise)?|uncaught/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors, "zero-sized container recovery produced a browser error").toEqual([]);
});
