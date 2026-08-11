import { test, expect } from "../fixtures/test.js";
import { expectTerminalNonBlank, expectTerminalPixelsChanged, screenshotRegion } from "../assertions/terminal-pixels.js";
import {
  expectTerminalBuffer,
  expectTerminalConnected,
  expectTerminalInteractive,
  terminalEvents,
  waitForTerminalEvent,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { Page } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const DIAGNOSTICS_TIMEOUT = 15_000;
const TRANSCRIPT_TIMEOUT = 15_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

function marker(testId: string, label: string): string {
  const safeTestId = testId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `P012-${safeTestId}-${label}`;
}

async function waitForRendererStatus(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => (snapshot.renderer === "webgl" && snapshot.webglLoadCount >= 1) || snapshot.fallbackCount > 0,
      { timeout },
    );
  }, { id: terminalId, timeout: DIAGNOSTICS_TIMEOUT });
}

async function waitForViewportEvent(
  page: Page,
  terminalId: string,
  afterEventId: number,
  previous?: E2ETerminalSnapshot["desiredViewport"],
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, cursor, previousViewport, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.id <= cursor || event.type !== "viewport") return false;
      const data = event.data as {
        source?: unknown;
        cols?: unknown;
        rows?: unknown;
        pixelWidth?: unknown;
        pixelHeight?: unknown;
      };
      if (data.source !== "proposed") return false;
      if (!previousViewport) return true;
      return data.cols !== previousViewport.cols
        || data.rows !== previousViewport.rows
        || data.pixelWidth !== previousViewport.pixelWidth
        || data.pixelHeight !== previousViewport.pixelHeight;
    }, { timeout, afterId: cursor });
  }, { id: terminalId, cursor: afterEventId, previousViewport: previous, timeout: DIAGNOSTICS_TIMEOUT });
}

async function requestContextLoss(page: Page, terminalId: string): Promise<"requested" | "unavailable"> {
  return page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api || typeof api.controls.renderer.loseContext !== "function") return "unavailable" as const;
    try {
      api.controls.renderer.loseContext(id);
      return "requested" as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("WEBGL_lose_context is unavailable")) return "unavailable" as const;
      throw error;
    }
  }, terminalId);
}

test("@p0 @smoke P0-12 Forced WebGL context loss", async ({ page, server }, testInfo) => {
  const workbench = new WorkbenchPage(page);
  await page.goto("/");
  await new LoginPage(page).login();
  await workbench.expectVisible();
  await workbench.createTerminal();

  const paneHost = workbench.editorGrid.locator("[data-terminal-id]").first();
  await expect(paneHost).toHaveAttribute("data-terminal-id", /.+/);
  const terminalId = await paneHost.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("new terminal did not expose a stable terminal id");
  const terminal = new TerminalPanePage(page, terminalId);
  await terminal.expectVisible();
  await expectTerminalConnected(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalInteractive(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });

  const initial = await waitForRendererStatus(page, terminalId);
  if (initial.renderer !== "webgl") {
    const lossCapability = await requestContextLoss(page, terminalId);
    testInfo.annotations.push({
      type: "webgl-context-loss-capability",
      description: `available=${lossCapability === "requested"}`,
    });
    if (lossCapability === "unavailable") {
      test.skip(true, "WEBGL_lose_context and the supported E2E loss seam are unavailable");
      return;
    }
    throw new Error("WebGL initialization did not produce an active renderer for context-loss coverage");
  }
  expect(initial.renderer).toBe("webgl");
  expect(initial.webglLoadCount).toBe(1);
  expect(initial.contextLossCount).toBe(0);
  expect(initial.fallbackCount).toBe(0);
  expect(initial.activeSocketCount).toBe(1);

  const readyId = marker(testInfo.testId, "ready");
  await terminal.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, {
    timeoutMs: TRANSCRIPT_TIMEOUT,
  });
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:READY:${readyId}]`, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  const existingId = marker(testInfo.testId, "existing");
  const existingText = marker(testInfo.testId, "history");
  await terminal.sendInput(`PRINT ${existingId} ${existingText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === existingId, {
    timeoutMs: TRANSCRIPT_TIMEOUT,
  });
  const existingLine = `[E2E:PRINT:${existingId}:${existingText}]`;
  await expectTerminalBuffer(page, terminalId, { contains: existingLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalNonBlank(page, terminal.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "p0-12-before-loss",
  });
  const beforeLossPixels = await screenshotRegion(page, terminal.xtermHost);
  const beforeLossEvents = await terminalEvents(page, terminalId);
  const beforeLossEventId = beforeLossEvents.at(-1)?.id ?? 0;
  const beforeLoss = await terminal.snapshot();
  if (!beforeLoss) throw new Error("missing diagnostics snapshot before context loss");

  const lossPromise = waitForTerminalEvent(page, terminalId, "renderer-context-loss", { timeout: DIAGNOSTICS_TIMEOUT });
  const fallbackPromise = waitForTerminalEvent(page, terminalId, "renderer-fallback", { timeout: DIAGNOSTICS_TIMEOUT });
  const lossMode = await requestContextLoss(page, terminalId);
  testInfo.annotations.push({
    type: "webgl-context-loss-capability",
    description: `available=${lossMode === "requested"}`,
  });
  if (lossMode === "unavailable") {
    test.skip(true, "WEBGL_lose_context and the supported E2E loss seam are unavailable");
    return;
  }
  const lossEvent = await lossPromise;
  const fallbackEvent = await fallbackPromise;
  expect(lossEvent.type).toBe("renderer-context-loss");
  expect(fallbackEvent.data.reason).toBe("context-loss");

  const afterLossEvents = await terminalEvents(page, terminalId);
  const afterLossCursor = afterLossEvents.at(-1)?.id ?? beforeLossEventId;
  const lossViewportEvent = await waitForViewportEvent(page, terminalId, afterLossCursor);
  expect(lossViewportEvent.data.source).toBe("proposed");
  expect(lossViewportEvent.snapshot.renderer).toBe("canvas");
  expect(lossViewportEvent.snapshot.contextLossCount).toBe(1);

  const afterLoss = await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderer === "canvas"
      && snapshot.contextLossCount === 1
      && snapshot.fallbackCount === 1
      && snapshot.activeSocketCount === 1
      && snapshot.socketState === "connected"
    ), { timeout });
  }, { id: terminalId, timeout: DIAGNOSTICS_TIMEOUT });
  expect(afterLoss.renderer).toBe("canvas");
  expect(afterLoss.contextLossCount).toBe(1);
  expect(afterLoss.fallbackCount).toBe(1);
  expect(afterLoss.activeSocketCount).toBe(1);
  expect(afterLoss.socketGeneration).toBe(beforeLoss.socketGeneration);
  expect(afterLoss.desiredViewport?.cols).toBeGreaterThan(0);
  expect(afterLoss.desiredViewport?.rows).toBeGreaterThan(0);

  const newId = marker(testInfo.testId, "after-loss");
  const newText = marker(testInfo.testId, "new-content");
  await terminal.sendInput(`PRINT ${newId} ${newText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === newId, {
    timeoutMs: TRANSCRIPT_TIMEOUT,
  });
  const newLine = `[E2E:PRINT:${newId}:${newText}]`;
  await expectTerminalBuffer(page, terminalId, { contains: existingLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalBuffer(page, terminalId, { contains: newLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalNonBlank(page, terminal.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "p0-12-after-loss",
  });
  const afterLossPixels = await screenshotRegion(page, terminal.xtermHost);
  await expectTerminalPixelsChanged(beforeLossPixels, afterLossPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-12-content-after-loss",
  });

  const beforeResize = await terminal.snapshot();
  if (!beforeResize) throw new Error("missing diagnostics snapshot before resize");
  const previousViewport = beforeResize.desiredViewport ?? beforeResize.proposedViewport;
  const beforeResizeEvents = await terminalEvents(page, terminalId);
  const beforeResizeCursor = beforeResizeEvents.at(-1)?.id ?? 0;
  const resizeViewportPromise = waitForViewportEvent(page, terminalId, beforeResizeCursor, previousViewport);
  await workbench.setViewport(1024, 768);
  const resizeViewportEvent = await resizeViewportPromise;
  const resizeData = resizeViewportEvent.data as {
    cols?: number;
    rows?: number;
    pixelWidth?: number;
    pixelHeight?: number;
  };
  expect(resizeData.cols).toBeGreaterThan(0);
  expect(resizeData.rows).toBeGreaterThan(0);
  expect(resizeData.pixelWidth).toBeGreaterThan(0);
  expect(resizeData.pixelHeight).toBeGreaterThan(0);

  const resized = await page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const serverViewport = snapshot.serverViewport;
      const desiredViewport = snapshot.desiredViewport;
      return snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
        && snapshot.acceptingInput
        && snapshot.cols === expected.cols
        && snapshot.rows === expected.rows
        && desiredViewport?.cols === expected.cols
        && desiredViewport.rows === expected.rows
        && desiredViewport.pixelWidth === expected.pixelWidth
        && desiredViewport.pixelHeight === expected.pixelHeight
        && serverViewport?.cols === expected.cols
        && serverViewport.rows === expected.rows;
    }, { timeout });
  }, {
    id: terminalId,
    expected: {
      cols: resizeData.cols,
      rows: resizeData.rows,
      pixelWidth: resizeData.pixelWidth,
      pixelHeight: resizeData.pixelHeight,
    },
    timeout: DIAGNOSTICS_TIMEOUT,
  });
  expect(resized.renderer).toBe("canvas");
  expect(resized.contextLossCount).toBe(1);
  expect(resized.fallbackCount).toBe(1);
  expect(resized.activeSocketCount).toBe(1);
  expect(resized.socketGeneration).toBe(beforeLoss.socketGeneration);
  expect(resized.cols).toBe(resizeData.cols);
  expect(resized.rows).toBe(resizeData.rows);
  expect(resized.desiredViewport?.cols).toBe(resizeData.cols);
  expect(resized.desiredViewport?.rows).toBe(resizeData.rows);
  expect(resized.desiredViewport?.pixelWidth).toBe(resizeData.pixelWidth);
  expect(resized.desiredViewport?.pixelHeight).toBe(resizeData.pixelHeight);
  expect(resized.serverViewport?.cols).toBe(resizeData.cols);
  expect(resized.serverViewport?.rows).toBe(resizeData.rows);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "sigwinch" && entry.rows === resizeData.rows && entry.cols === resizeData.cols, {
    timeoutMs: TRANSCRIPT_TIMEOUT,
  });

  const repeatLossMode = await requestContextLoss(page, terminalId);
  expect(repeatLossMode).toBe("requested");
  await expectTerminalInteractive(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
  const afterRepeat = await terminal.snapshot();
  if (!afterRepeat) throw new Error("missing diagnostics snapshot after repeated context-loss request");
  expect(afterRepeat.contextLossCount).toBe(1);
  expect(afterRepeat.fallbackCount).toBe(1);
  expect(afterRepeat.renderer).toBe("canvas");
  expect(afterRepeat.activeSocketCount).toBe(1);
  expect(afterRepeat.socketGeneration).toBe(beforeLoss.socketGeneration);
  expect(afterRepeat.webglLoadCount).toBe(1);

  const finalEchoId = marker(testInfo.testId, "input");
  await terminal.sendInput(`ECHO_INPUT ${finalEchoId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === finalEchoId && entry.phase === "armed", {
    timeoutMs: TRANSCRIPT_TIMEOUT,
  });
  const inputText = marker(testInfo.testId, "continued-input");
  await terminal.sendInput(inputText, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === finalEchoId && entry.phase === "payload", {
    timeoutMs: TRANSCRIPT_TIMEOUT,
  });
  const inputLine = `[E2E:ECHO_INPUT:${finalEchoId}:${Buffer.from(inputText).toString("base64")}]`;
  await expectTerminalBuffer(page, terminalId, { contains: inputLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalBuffer(page, terminalId, { contains: existingLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalBuffer(page, terminalId, { contains: newLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  const final = await expectTerminalConnected(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
  expect(final.webglLoadCount).toBe(1);
  expect(final.renderer).toBe("canvas");
  expect(final.contextLossCount).toBe(1);
  expect(final.fallbackCount).toBe(1);
  expect(final.activeSocketCount).toBe(1);
  expect(final.socketGeneration).toBe(beforeLoss.socketGeneration);
  expect(final.socketState).toBe("connected");
  expect(final.pendingParserWrites).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
  expect(invariantReport.violations).toEqual([]);

  const allEvents = await terminalEvents(page, terminalId);
  expect(allEvents.filter((event) => event.type === "renderer-context-loss")).toHaveLength(1);
  expect(allEvents.filter((event) => event.type === "renderer-fallback")).toHaveLength(1);
  expect(allEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(allEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(allEvents.some((event) => event.type === "viewport" && event.data.source === "proposed")).toBe(true);
  expect(invariantReport.snapshot.renderer).toBe("canvas");
  expect(allEvents.some((event) => event.type === "viewport" && event.data.source === "sent")).toBe(true);
});
