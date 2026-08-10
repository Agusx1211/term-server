import { test, expect } from "../fixtures/test.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  analyzePixels,
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import type { Locator, Page } from "@playwright/test";

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

type CompositorGeometry = {
  readonly dpr: number;
  readonly css: { readonly width: number; readonly height: number };
  readonly canvases: readonly {
    readonly width: number;
    readonly height: number;
    readonly cssWidth: number;
    readonly cssHeight: number;
  }[];
};

const WAIT_TIMEOUT_MS = 20_000;

async function waitForRenderedMarker(
  page: Page,
  terminalId: string,
  marker: string,
  previousRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, markerText, renderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const renderedText = snapshot.xterm.text.replaceAll("\r", "").replaceAll("\n", "");
      const expectedMarker = markerText.replaceAll("\r", "").replaceAll("\n", "");
      return (
        snapshot.renderer === "webgl"
        && snapshot.renderCount > renderCount
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && renderedText.includes(expectedMarker)
      );
    }, { timeout });
  }, { id: terminalId, markerText: marker, renderCount: previousRenderCount, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSelectionRendered(
  page: Page,
  terminalId: string,
  selectedText: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, selected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderer === "webgl"
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.xterm.selectionText === selected
    ), { timeout });
  }, {
    id: terminalId,
    selected: selectedText,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function selectText(
  pane: Page,
  screen: Locator,
  snapshot: E2ETerminalSnapshot,
  selectedText: string,
): Promise<void> {
  const lines = snapshot.xterm.text.split("\n");
  const lineIndex = lines.findIndex((line) => line.includes(selectedText));
  if (lineIndex < 0) throw new Error(`Unable to locate ${selectedText} in the terminal model`);
  const column = lines[lineIndex]!.indexOf(selectedText);
  const visualRow = lineIndex - snapshot.viewportY;
  if (visualRow < 0 || visualRow >= snapshot.rows) {
    throw new Error(`Selection marker ${selectedText} is outside the visible terminal viewport`);
  }

  const box = await screen.boundingBox();
  if (!box || snapshot.cols <= 0 || snapshot.rows <= 0) {
    throw new Error("Terminal screen geometry is unavailable for selection");
  }
  const cellWidth = box.width / snapshot.cols;
  const cellHeight = box.height / snapshot.rows;
  const y = box.y + (visualRow + 0.5) * cellHeight;
  const startX = box.x + (column + 0.25) * cellWidth;
  const endX = box.x + (column + selectedText.length - 0.25) * cellWidth;
  await pane.mouse.move(startX, y);
  await pane.mouse.down();
  await pane.mouse.move(endX, y);
  await pane.mouse.up();
}

async function compositorGeometry(screen: Locator): Promise<CompositorGeometry> {
  return screen.evaluate((element) => {
    const screenRect = element.getBoundingClientRect();
    const canvases = [...element.querySelectorAll<HTMLCanvasElement>("canvas")].map((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return {
        width: canvas.width,
        height: canvas.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
      };
    });
    return {
      dpr: window.devicePixelRatio,
      css: { width: screenRect.width, height: screenRect.height },
      canvases,
    };
  });
}

function assertCompositorGeometry(
  geometry: CompositorGeometry,
  snapshot: E2ETerminalSnapshot,
): void {
  expect(geometry.css.width).toBeGreaterThan(0);
  expect(geometry.css.height).toBeGreaterThan(0);
  expect(geometry.canvases.length).toBeGreaterThan(0);
  const canvas = geometry.canvases.find((candidate) => (
    candidate.cssWidth > 0
    && candidate.cssHeight > 0
    && candidate.width > 0
    && candidate.height > 0
  ));
  if (!canvas) throw new Error("WebGL terminal has no visible compositor canvas");
  expect(canvas.width).toBe(Math.round(canvas.cssWidth * geometry.dpr));
  expect(canvas.height).toBe(Math.round(canvas.cssHeight * geometry.dpr));
  expect(snapshot.pixelWidth).toBeGreaterThan(0);
  expect(snapshot.pixelHeight).toBeGreaterThan(0);
  expect(snapshot.viewport.pixelWidth).toBe(snapshot.pixelWidth);
  expect(snapshot.viewport.pixelHeight).toBe(snapshot.pixelHeight);
}

function expectSocketAndRendererLifecycle(
  events: readonly E2ETerminalEvent[],
  snapshot: E2ETerminalSnapshot,
): void {
  expect(events.filter((event) => event.type === "renderer-load")).toHaveLength(1);
  expect(events.filter((event) => event.type === "renderer-fallback")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-open")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "sync")).toHaveLength(1);
  expect(events.filter((event) => event.type === "synced")).toHaveLength(1);
  expect(events.filter((event) => (
    event.type === "state" && ["disconnected", "recovering"].includes(String(event.data.state))
  ))).toHaveLength(0);
  expect(events.filter((event) => event.type === "render").length).toBeGreaterThan(0);
  expect(snapshot.socketGeneration).toBe(1);
  expect(snapshot.activeSocketCount).toBe(1);
  expect(snapshot.socket.activeCount).toBe(1);
  expect(snapshot.socketState).toBe("connected");
  expect(snapshot.acceptingInput).toBe(true);
  expect(snapshot.renderer).toBe("webgl");
  expect(snapshot.rendererState.kind).toBe("webgl");
  expect(snapshot.webglLoadCount).toBe(1);
  expect(snapshot.contextLossCount).toBe(0);
  expect(snapshot.fallbackCount).toBe(0);
  expect(snapshot.renderCount).toBeGreaterThan(0);
  expect(snapshot.pendingParserWrites).toBe(0);
  expect(snapshot.pendingParserBytes).toBe(0);
  expect(snapshot.renderBacklogBytes).toBe(0);
  expect(snapshot.renderBacklogFrames).toBe(0);
}

test("@p1 @pr @nightly @render @webgl R-01 Ordinary WebGL render", async ({ page, server }, testInfo) => {
  await page.goto("/");
  const webglAvailable = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  });
  testInfo.annotations.push({
    type: "webgl-capability",
    description: `webglAvailable=${webglAvailable}`,
  });
  if (!webglAvailable) {
    test.skip(true, "WebGL is unavailable in this browser configuration");
    return;
  }

  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountEvent = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, WAIT_TIMEOUT_MS);
  const rendererReadyEvent = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "renderer-load" || event.type === "renderer-fallback",
      { timeout },
    );
  }, WAIT_TIMEOUT_MS);
  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as { id: string; name: string };
  expect(created.id).not.toBe("");

  const mounted = await mountEvent;
  expect(mounted.terminalId).toBe(created.id);
  const terminal = workbench.terminal(created.id, created.name);
  await terminal.expectVisible();
  const terminalScreen = terminal.xtermHost.locator(".xterm-screen");
  await expect(terminalScreen).toBeVisible();

  const rendererReady = await rendererReadyEvent;
  expect(rendererReady.terminalId).toBe(created.id);
  if (rendererReady.type !== "renderer-load" || rendererReady.data.kind !== "webgl" || rendererReady.snapshot.renderer !== "webgl") {
    testInfo.annotations.push({
      type: "webgl-capability",
      description: `active WebGL renderer unavailable: ${rendererReady.type}`,
    });
    test.skip(true, "Active WebGL renderer could not be obtained");
    return;
  }
  expect(rendererReady.data.kind).toBe("webgl");
  expect(rendererReady.snapshot.renderer).toBe("webgl");
  expect(rendererReady.snapshot.webglLoadCount).toBe(1);

  const runToken = `${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}`;
  const readyId = `R01-${runToken}-READY`;
  const colorsId = `R01-${runToken}-COLORS`;
  const sizeId = `R01-${runToken}-SIZE`;
  const cursorId = `R01-${runToken}-CURSOR`;
  const updateId = `R01-${runToken}-UPDATE`;
  const echoId = `R01-${runToken}-ECHO`;
  const echoText = `R01-${runToken}-CONTINUED-INPUT`;
  const readyMarker = `[E2E:READY:${readyId}]`;
  const indexedMarker = `[E2E:COLORS:${colorsId}:INDEXED]`;
  const trueColorMarker = `[E2E:COLORS:${colorsId}:TRUECOLOR]`;
  const cursorMarker = `[E2E:CURSOR:${cursorId}:4:3]`;
  const updateMarker = `[E2E:PRINT:${updateId}:COMPOSITOR-UPDATE]`;
  const echoMarkerPrefix = `[E2E:ECHO_INPUT:${echoId}:`;
  const echoPayload = Buffer.from(echoText, "utf8").toString("base64");
  const echoMarker = `${echoMarkerPrefix}${echoPayload}]`;

  const synchronized = await terminal.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  expect(synchronized.socketState).toBe("connected");
  expect(synchronized.acceptingInput).toBe(true);
  expect(synchronized.renderer).toBe("webgl");
  expect(synchronized.webglLoadCount).toBe(1);
  expect(synchronized.pendingParserWrites).toBe(0);

  const readyBefore = await terminal.snapshot();
  if (!readyBefore) throw new Error(`No diagnostics snapshot for terminal ${created.id}`);
  const readyRendered = waitForRenderedMarker(page, created.id, readyMarker, readyBefore.renderCount);
  await terminal.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "ready" && entry.id === readyId);
  await expectTerminalBuffer(page, created.id, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const afterReady = await readyRendered;
  expect(afterReady.renderer).toBe("webgl");
  expect(afterReady.renderCount).toBeGreaterThan(readyBefore.renderCount);

  const beforeColors = await screenshotRegion(page, terminalScreen);
  const colorsBefore = await terminal.snapshot();
  if (!colorsBefore) throw new Error(`No diagnostics snapshot before colors for terminal ${created.id}`);
  const colorsRendered = waitForRenderedMarker(page, created.id, indexedMarker, colorsBefore.renderCount);
  await terminal.sendInput(`COLORS ${colorsId}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "colors" && entry.id === colorsId);
  await expectTerminalBuffer(page, created.id, {
    contains: indexedMarker,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, {
    contains: trueColorMarker,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const afterColors = await colorsRendered;
  expect(afterColors.renderer).toBe("webgl");
  expect(afterColors.renderCount).toBeGreaterThan(colorsBefore.renderCount);
  const colorImage = await screenshotRegion(page, terminalScreen);
  expect(colorImage.width).toBe(beforeColors.width);
  expect(colorImage.height).toBe(beforeColors.height);
  await expectTerminalPixelsChanged(beforeColors, colorImage, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "r-01-colored-text-crop",
  });
  const colorAnalysis = analyzePixels(colorImage);
  expect(colorAnalysis.nonBackgroundRatio).toBeGreaterThanOrEqual(0.002);
  expect(colorAnalysis.uniqueColorCount).toBeGreaterThan(2);
  await expectTerminalNonBlank(page, terminalScreen, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-01-colored-text-nonblank-crop",
  });

  const sizeBefore = await terminal.snapshot();
  if (!sizeBefore) throw new Error(`No diagnostics snapshot before SIZE for terminal ${created.id}`);
  const sizeMarker = `[E2E:SIZE:${sizeId}:`;
  const sizeRendered = waitForRenderedMarker(page, created.id, sizeMarker, sizeBefore.renderCount);
  await terminal.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number; pixel_width?: number; pixel_height?: number }>(
    created.id,
    (entry) => entry.event === "size" && entry.id === sizeId,
  );
  expect(size.rows).toBe(sizeBefore.rows);
  expect(size.cols).toBe(sizeBefore.cols);
  if (size.pixel_width !== undefined) expect(size.pixel_width).toBe(sizeBefore.pixelWidth);
  if (size.pixel_height !== undefined) expect(size.pixel_height).toBe(sizeBefore.pixelHeight);
  await expectTerminalBuffer(page, created.id, { contains: sizeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await sizeRendered;

  const cursorBefore = await terminal.snapshot();
  if (!cursorBefore) throw new Error(`No diagnostics snapshot before cursor for terminal ${created.id}`);
  const cursorRendered = waitForRenderedMarker(page, created.id, cursorMarker, cursorBefore.renderCount);
  await terminal.sendInput(`CURSOR ${cursorId} 4 3`, true);
  const cursorEntry = await server.waitForTranscript<{ event: string; id: string; row: number; col: number }>(
    created.id,
    (entry) => entry.event === "cursor" && entry.id === cursorId,
  );
  expect(cursorEntry.row).toBe(4);
  expect(cursorEntry.col).toBe(3);
  await expectTerminalBuffer(page, created.id, { contains: cursorMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const afterCursor = await cursorRendered;
  expect(afterCursor.renderer).toBe("webgl");
  expect(afterCursor.renderCount).toBeGreaterThan(cursorBefore.renderCount);
  expect(afterCursor.xterm.cursorY).toBeGreaterThanOrEqual(3);
  const afterCursorImage = await screenshotRegion(page, terminalScreen);
  await expectTerminalPixelsChanged(colorImage, afterCursorImage, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "r-01-cursor-crop",
  });
  await expectTerminalNonBlank(page, terminalScreen, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-01-cursor-nonblank-crop",
  });

  const beforeSelection = await screenshotRegion(page, terminalScreen);
  const selectionBefore = await terminal.snapshot();
  if (!selectionBefore) throw new Error(`No diagnostics snapshot before selection for terminal ${created.id}`);
  const selectionRendered = waitForSelectionRendered(page, created.id, colorsId);
  await selectText(page, terminalScreen, selectionBefore, colorsId);
  const selected = await selectionRendered;
  expect(selected.selectionText).toBe(colorsId);
  expect(selected.xterm.text).toContain(indexedMarker);
  const afterSelection = await screenshotRegion(page, terminalScreen);
  await expectTerminalPixelsChanged(beforeSelection, afterSelection, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "r-01-selection-crop",
  });
  await expectTerminalNonBlank(page, terminalScreen, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-01-selection-nonblank-crop",
  });

  const beforeUpdate = await screenshotRegion(page, terminalScreen);
  const updateBefore = await terminal.snapshot();
  if (!updateBefore) throw new Error(`No diagnostics snapshot before update for terminal ${created.id}`);
  const updateRendered = waitForRenderedMarker(page, created.id, updateMarker, updateBefore.renderCount);
  await terminal.sendInput(`PRINT ${updateId} COMPOSITOR-UPDATE`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === updateId);
  await expectTerminalBuffer(page, created.id, { contains: updateMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const afterUpdate = await updateRendered;
  expect(afterUpdate.renderer).toBe("webgl");
  expect(afterUpdate.renderCount).toBeGreaterThan(updateBefore.renderCount);
  const updateImage = await screenshotRegion(page, terminalScreen);
  expect(updateImage.width).toBe(beforeUpdate.width);
  expect(updateImage.height).toBe(beforeUpdate.height);
  await expectTerminalPixelsChanged(beforeUpdate, updateImage, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "r-01-update-crop",
  });
  await expectTerminalNonBlank(page, terminalScreen, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-01-update-nonblank-crop",
  });

  const echoBefore = await terminal.snapshot();
  if (!echoBefore) throw new Error(`No diagnostics snapshot before continued input for terminal ${created.id}`);
  const echoRendered = waitForRenderedMarker(page, created.id, echoMarker, echoBefore.renderCount);
  await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(created.id, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
  ));
  await terminal.sendInput(echoText, true);
  const echo = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
    created.id,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
  );
  expect(echo.payload_base64).toBe(echoPayload);
  await expectTerminalBuffer(page, created.id, {
    contains: echoMarker,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const afterEcho = await echoRendered;
  expect(afterEcho.renderer).toBe("webgl");
  expect(afterEcho.renderCount).toBeGreaterThan(echoBefore.renderCount);

  const finalSnapshot = await terminal.snapshot();
  if (!finalSnapshot) throw new Error(`No final diagnostics snapshot for terminal ${created.id}`);
  const geometry = await compositorGeometry(terminalScreen);
  assertCompositorGeometry(geometry, finalSnapshot);
  expect(finalSnapshot.cols).toBe(size.cols);
  expect(finalSnapshot.rows).toBe(size.rows);
  expect(finalSnapshot.serverViewport?.cols).toBe(finalSnapshot.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(finalSnapshot.rows);
  expect(finalSnapshot.serverViewport?.pixelWidth).toBe(finalSnapshot.pixelWidth);
  expect(finalSnapshot.serverViewport?.pixelHeight).toBe(finalSnapshot.pixelHeight);
  await expectTerminalBuffer(page, created.id, { contains: indexedMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: trueColorMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: updateMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: `${echoMarkerPrefix}${echo.payload_base64}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const transcript = await server.readTranscript(created.id);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "colors" && entry.id === colorsId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "cursor" && entry.id === cursorId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === updateId)).toHaveLength(1);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);

  const events = await terminalEvents(page, created.id);
  expectSocketAndRendererLifecycle(events, finalSnapshot);
  const invariantReport = await expectConnectedTerminalInvariants(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
});
