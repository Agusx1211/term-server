import { test, expect } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type { TerminalPanePage } from "../pages/terminal-pane.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import type { Locator, Page } from "@playwright/test";

const WAIT_TIMEOUT_MS = 30_000;
const LARGE_VIEWPORT = { width: 1_920, height: 1_080 } as const;
const DPR_FACTORS = [1, 1.25, 1.5, 1.8, 2] as const;
const REPAINT_BYTES = 262_144;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type CompositorCanvas = {
  readonly width: number;
  readonly height: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly connected: boolean;
  readonly maxTextureSize: number | null;
  readonly maxRenderbufferSize: number | null;
};
type CompositorGeometry = {
  readonly dpr: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly screen: { readonly width: number; readonly height: number };
  readonly canvases: readonly CompositorCanvas[];
};

type FixtureSize = {
  readonly event: string;
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
  readonly pixel_width?: number;
  readonly pixel_height?: number;
};


async function waitForRenderedMarker(
  page: Page,
  terminalId: string,
  marker: string,
  previousRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, markerText, renderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > renderCount
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.xterm.text.includes(markerText)
    ), { timeout });
  }, {
    id: terminalId,
    markerText: marker,
    renderCount: previousRenderCount,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  eventType: E2ETerminalEventType,
  previousEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, type, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.id > after && event.type === type, { timeout });
  }, {
    id: terminalId,
    type: eventType,
    after: previousEventId,
    timeout: WAIT_TIMEOUT_MS,
  });
}

/**
 * Arm output, parser, and render barriers before sending a fixture command.
 * The marker predicate additionally requires an idle parser/render backlog, so
 * a successful return means the visible frame has caught up with the model.
 */
async function waitForRenderedCommand(
  page: Page,
  terminalId: string,
  marker: string,
  previousEventId: number,
  previousRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  const outputReceived = waitForEventAfter(page, terminalId, "output-received", previousEventId);
  const parserCommit = waitForEventAfter(page, terminalId, "parser-commit", previousEventId);
  const rendered = waitForEventAfter(page, terminalId, "render", previousEventId);
  const markerRendered = waitForRenderedMarker(page, terminalId, marker, previousRenderCount);
  const [output, parser, render, snapshot] = await Promise.all([
    outputReceived,
    parserCommit,
    rendered,
    markerRendered,
  ]);
  expect(output.id).toBeGreaterThan(previousEventId);
  expect(parser.id).toBeGreaterThan(output.id);
  expect(render.id).toBeGreaterThan(output.id);
  return snapshot;
}

async function waitForViewportConvergence(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const server = snapshot.serverViewport;
      return Boolean(
        server
        && server.cols === snapshot.cols
        && server.rows === snapshot.rows
        && server.pixelWidth === snapshot.pixelWidth
        && server.pixelHeight === snapshot.pixelHeight
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0,
      );
    }, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function compositorGeometry(screen: Locator): Promise<CompositorGeometry> {
  return screen.evaluate((element) => {
    const screenRect = element.getBoundingClientRect();
    const canvases = [...element.querySelectorAll<HTMLCanvasElement>("canvas")].map((canvas) => {
      const rect = canvas.getBoundingClientRect();
      let maxTextureSize: number | null = null;
      let maxRenderbufferSize: number | null = null;
      try {
        const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        if (context) {
          const textureLimit = Number(context.getParameter(0x0D33));
          const renderbufferLimit = Number(context.getParameter(0x84E8));
          if (Number.isFinite(textureLimit) && textureLimit > 0) maxTextureSize = textureLimit;
          if (Number.isFinite(renderbufferLimit) && renderbufferLimit > 0) maxRenderbufferSize = renderbufferLimit;
        }
      } catch {
        // A context can be unavailable after a controlled renderer fallback.
      }
      return {
        width: canvas.width,
        height: canvas.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
        connected: canvas.isConnected,
        maxTextureSize,
        maxRenderbufferSize,
      };
    });
    return {
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screen: { width: screenRect.width, height: screenRect.height },
      canvases,
    };
  });
}

function assertCompositorGeometry(
  geometry: CompositorGeometry,
  snapshot: E2ETerminalSnapshot,
  factor: number,
): void {
  expect(geometry.dpr).toBeCloseTo(factor, 3);
  expect(geometry.innerWidth).toBe(LARGE_VIEWPORT.width);
  expect(geometry.innerHeight).toBe(LARGE_VIEWPORT.height);
  expect(geometry.screen.width).toBeGreaterThan(0);
  expect(geometry.screen.height).toBeGreaterThan(0);
  expect(geometry.screen.width).toBeLessThanOrEqual(LARGE_VIEWPORT.width);
  expect(geometry.screen.height).toBeLessThanOrEqual(LARGE_VIEWPORT.height);
  expect(geometry.canvases.length).toBeGreaterThan(0);

  const visibleCanvases = geometry.canvases.filter((canvas) => (
    canvas.cssWidth > 0
    && canvas.cssHeight > 0
    && canvas.width > 0
    && canvas.height > 0
  ));
  expect(visibleCanvases.length).toBeGreaterThan(0);
  for (const canvas of visibleCanvases) {
    expect(canvas.connected).toBe(true);
    const expectedWidth = Math.round(canvas.cssWidth * factor);
    const expectedHeight = Math.round(canvas.cssHeight * factor);
    expect(Math.abs(canvas.width - expectedWidth)).toBeLessThanOrEqual(2);
    expect(Math.abs(canvas.height - expectedHeight)).toBeLessThanOrEqual(2);
    expect(canvas.width).toBeLessThanOrEqual(Math.ceil(LARGE_VIEWPORT.width * factor) + 2);
    expect(canvas.height).toBeLessThanOrEqual(Math.ceil(LARGE_VIEWPORT.height * factor) + 2);
    if (canvas.maxTextureSize !== null) expect(canvas.width).toBeLessThanOrEqual(canvas.maxTextureSize);
    if (canvas.maxRenderbufferSize !== null) expect(canvas.width).toBeLessThanOrEqual(canvas.maxRenderbufferSize);
    if (canvas.maxTextureSize !== null) expect(canvas.height).toBeLessThanOrEqual(canvas.maxTextureSize);
    if (canvas.maxRenderbufferSize !== null) expect(canvas.height).toBeLessThanOrEqual(canvas.maxRenderbufferSize);
  }

  expect(snapshot.pixelWidth).toBe(Math.round(geometry.screen.width));
  expect(snapshot.pixelHeight).toBe(Math.round(geometry.screen.height));
  expect(snapshot.viewport.pixelWidth).toBe(snapshot.pixelWidth);
  expect(snapshot.viewport.pixelHeight).toBe(snapshot.pixelHeight);
  expect(snapshot.serverViewport?.pixelWidth).toBe(snapshot.pixelWidth);
  expect(snapshot.serverViewport?.pixelHeight).toBe(snapshot.pixelHeight);
}

function assertCompositorImageScale(
  image: { readonly width: number; readonly height: number },
  geometry: CompositorGeometry,
  factor: number,
): void {
  const expectedWidth = Math.round(Math.ceil(geometry.screen.width) * factor);
  const expectedHeight = Math.round(Math.ceil(geometry.screen.height) * factor);
  expect(Math.abs(image.width - expectedWidth)).toBeLessThanOrEqual(2);
  expect(Math.abs(image.height - expectedHeight)).toBeLessThanOrEqual(2);
}

async function lastEventId(terminal: TerminalPanePage): Promise<number> {
  const events = await terminal.events();
  return events.length ? events[events.length - 1]!.id : 0;
}

function assertRendererReady(
  rendererReady: E2ETerminalEvent,
  snapshot: E2ETerminalSnapshot,
): void {
  expect(["renderer-load", "renderer-fallback"]).toContain(rendererReady.type);
  expect(snapshot.rendererState.kind).toBe(snapshot.renderer);
  expect(snapshot.renderer).toMatch(/^(webgl|canvas|dom)$/);
  if (rendererReady.type === "renderer-load") {
    expect(snapshot.renderer).toBe("webgl");
    expect(snapshot.webglLoadCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.fallbackCount).toBe(0);
  } else {
    expect(snapshot.renderer).not.toBe("webgl");
    expect(snapshot.fallbackCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.contextLossCount).toBe(0);
  }
}

test("R-09 Large canvas and high DPR @p1 @nightly @rendering @dpr", async ({ browser, server }, testInfo) => {
  if (!server.baseURL) throw new Error("isolated E2E server has no proxy base URL");

  let terminalId: string | undefined;
  for (const factor of DPR_FACTORS) {
    const label = String(factor).replace(".", "_");
    const context = await browser.newContext({
      baseURL: server.baseURL,
      viewport: LARGE_VIEWPORT,
      deviceScaleFactor: factor,
    });
    const page = await context.newPage();
    const browserErrors = installBrowserErrorCollectors(page);

    try {
      await test.step(`DPR ${factor}`, async () => {
        await page.goto("/");
        const actualDpr = await page.evaluate(() => window.devicePixelRatio);
        if (Math.abs(actualDpr - factor) > 0.01) {
          if (factor === 1) throw new Error(`browser reported DPR ${actualDpr} instead of the requested DPR ${factor}`);
          testInfo.annotations.push({
            type: "dpr-capability",
            description: `requested DPR ${factor} is unsupported; browser reported ${actualDpr}`,
          });
          return;
        }
        await new LoginPage(page).login();
        const workbench = new WorkbenchPage(page);
        await workbench.expectVisible();

        const mountEvent = page.evaluate(async ({ timeout }) => {
          const api = (window as E2EWindow).__TERM_SERVER_E2E__;
          if (!api) throw new Error("term-server E2E diagnostics are unavailable");
          return api.waitForEvent((event) => event.type === "mount", { timeout });
        }, { timeout: WAIT_TIMEOUT_MS });
        const rendererEvent = page.evaluate(async ({ timeout }) => {
          const api = (window as E2EWindow).__TERM_SERVER_E2E__;
          if (!api) throw new Error("term-server E2E diagnostics are unavailable");
          return api.waitForEvent(
            (event) => event.type === "renderer-load" || event.type === "renderer-fallback",
            { timeout },
          );
        }, { timeout: WAIT_TIMEOUT_MS });

        let terminal: TerminalPanePage;
        if (terminalId === undefined) {
          const createResponsePromise = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return response.request().method() === "POST" && url.pathname === "/api/terminals";
          });
          await workbench.createTerminal();
          const createResponse = await createResponsePromise;
          expect(createResponse.ok()).toBe(true);
          const created = await createResponse.json() as { readonly id: string; readonly name?: string };
          expect(created.id).not.toBe("");
          terminalId = created.id;
          const mounted = await mountEvent;
          expect(mounted.terminalId).toBe(terminalId);
          terminal = workbench.terminal(terminalId, created.name);
        } else {
          terminal = await workbench.openTerminal({ id: terminalId });
          const mounted = await mountEvent;
          expect(mounted.terminalId).toBe(terminalId);
        }

        await terminal.expectVisible();
        const screen = terminal.xtermHost.locator(".xterm-screen");
        await expect(screen).toBeVisible();
        const rendererReady = await rendererEvent;
        expect(rendererReady.terminalId).toBe(terminalId);
        const rendererSnapshot = rendererReady.snapshot;
        assertRendererReady(rendererReady, rendererSnapshot);

        const synchronized = await terminal.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
        expect(synchronized.socketState).toBe("connected");
        expect(synchronized.acceptingInput).toBe(true);
        expect(synchronized.activeSocketCount).toBe(1);
        expect(synchronized.pendingParserWrites).toBe(0);

        const interactive = await page.evaluate(async ({ id, timeout }) => {
          const api = (window as E2EWindow).__TERM_SERVER_E2E__;
          if (!api) throw new Error("term-server E2E diagnostics are unavailable");
          return api.waitForTerminal(id, (snapshot) => (
            snapshot.socketState === "connected"
            && snapshot.acceptingInput
            && snapshot.renderCount > 0
          ), { timeout });
        }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
        const converged = await waitForViewportConvergence(page, terminalId);
        expect(converged.cols).toBeGreaterThan(0);
        expect(converged.rows).toBeGreaterThan(0);
        expect(converged.proposedViewport).toBeDefined();
        expect(converged.desiredViewport).toBeDefined();
        expect(converged.sentViewport).toBeDefined();
        expect(converged.serverViewport).toBeDefined();
        expect(interactive.renderer).toBe(converged.renderer);

        const geometry = await compositorGeometry(screen);
        assertCompositorGeometry(geometry, converged, factor);

        const token = `W${testInfo.workerIndex}-P${testInfo.parallelIndex}-I${testInfo.repeatEachIndex}-R${testInfo.retry}-D${String(factor).replace(".", "_")}`;
        const readyId = `R09-${token}-READY`;
        const colorsId = `R09-${token}-COLORS`;
        const printId = `R09-${token}-PRINT`;
        const repaintId = `R09-${token}-REPAINT`;
        const sizeId = `R09-${token}-SIZE`;
        const echoId = `R09-${token}-ECHO`;
        const echoText = `R09-${token}-CONTINUED-INPUT`;
        const readyMarker = `[E2E:READY:${readyId}]`;
        const indexedMarker = `[E2E:COLORS:${colorsId}:INDEXED]`;
        const trueColorMarker = `[E2E:COLORS:${colorsId}:TRUECOLOR]`;
        const printMarker = `[E2E:PRINT:${printId}:HIGH-DPR]`;
        const repaintMarker = `[E2E:REPAINT:${repaintId}:FRAME]`;
        const sizeMarker = `[E2E:SIZE:${sizeId}:`;
        const echoReadyMarker = `[E2E:ECHO_INPUT:${echoId}:READY]`;
        const echoPayloadMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;

        const readyBefore = await terminal.snapshot();
        if (!readyBefore) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
        const readyEventId = await lastEventId(terminal);
        const readyTranscript = server.waitForTranscript(
          terminalId,
          (entry) => entry.event === "ready" && entry.id === readyId,
          { timeoutMs: WAIT_TIMEOUT_MS },
        );
        const readyRendered = waitForRenderedCommand(page, terminalId, readyMarker, readyEventId, readyBefore.renderCount);
        await terminal.sendInput(`READY ${readyId}`, true);
        await readyTranscript;
        await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
        const afterReady = await readyRendered;
        expect(afterReady.renderCount).toBeGreaterThan(readyBefore.renderCount);

        const colorsBeforePixels = await screenshotRegion(page, screen);
        const colorsBefore = await terminal.snapshot();
        if (!colorsBefore) throw new Error(`No diagnostics snapshot before COLORS for terminal ${terminalId}`);
        const colorsEventId = await lastEventId(terminal);
        const colorsTranscript = server.waitForTranscript(
          terminalId,
          (entry) => entry.event === "colors" && entry.id === colorsId,
          { timeoutMs: WAIT_TIMEOUT_MS },
        );
        const colorsRendered = waitForRenderedCommand(page, terminalId, indexedMarker, colorsEventId, colorsBefore.renderCount);
        await terminal.sendInput(`COLORS ${colorsId}`, true);
        await colorsTranscript;
        await expectTerminalBuffer(page, terminalId, { contains: indexedMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
        await expectTerminalBuffer(page, terminalId, { contains: trueColorMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
        const afterColors = await colorsRendered;
        expect(afterColors.renderCount).toBeGreaterThan(colorsBefore.renderCount);
        const colorsChanged = await expectKnownMarkerChanged(page, screen, colorsBeforePixels, {
          minimumChangedRatio: 0.001,
          testInfo,
          artifactName: `r-09-${label}-colors-crop`,
        });
        assertCompositorImageScale(colorsChanged.after, geometry, factor);
        await expectTerminalNonBlank(page, screen, {
          minimumNonBackgroundRatio: 0.002,
          testInfo,
          artifactName: `r-09-${label}-colors-nonblank`,
        });

        const printBeforePixels = await screenshotRegion(page, screen);
        const printBefore = await terminal.snapshot();
        if (!printBefore) throw new Error(`No diagnostics snapshot before PRINT for terminal ${terminalId}`);
        const printEventId = await lastEventId(terminal);
        const printTranscript = server.waitForTranscript(
          terminalId,
          (entry) => entry.event === "print" && entry.id === printId && entry.text === "HIGH-DPR",
          { timeoutMs: WAIT_TIMEOUT_MS },
        );
        const printRendered = waitForRenderedCommand(page, terminalId, printMarker, printEventId, printBefore.renderCount);
        await terminal.sendInput(`PRINT ${printId} HIGH-DPR`, true);
        await printTranscript;
        await expectTerminalBuffer(page, terminalId, { contains: printMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
        const afterPrint = await printRendered;
        expect(afterPrint.renderCount).toBeGreaterThan(printBefore.renderCount);
        const printChanged = await expectKnownMarkerChanged(page, screen, printBeforePixels, {
          minimumChangedRatio: 0.001,
          testInfo,
          artifactName: `r-09-${label}-print-crop`,
        });
        assertCompositorImageScale(printChanged.after, geometry, factor);
        await expectTerminalNonBlank(page, screen, {
          minimumNonBackgroundRatio: 0.002,
          testInfo,
          artifactName: `r-09-${label}-print-nonblank`,
        });

        const repaintBeforePixels = await screenshotRegion(page, screen);
        const repaintBefore = await terminal.snapshot();
        if (!repaintBefore) throw new Error(`No diagnostics snapshot before REPAINT for terminal ${terminalId}`);
        const repaintEventId = await lastEventId(terminal);
        const repaintTranscript = server.waitForTranscript<{
          readonly event: string;
          readonly id: string;
          readonly bytes: number;
        }>(
          terminalId,
          (entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === REPAINT_BYTES,
          { timeoutMs: WAIT_TIMEOUT_MS },
        );
        const repaintRendered = waitForRenderedCommand(page, terminalId, repaintMarker, repaintEventId, repaintBefore.renderCount);
        await terminal.sendInput(`REPAINT ${repaintId} ${REPAINT_BYTES}`, true);
        const repaintEntry = await repaintTranscript;
        expect(repaintEntry.bytes).toBe(REPAINT_BYTES);
        await expectTerminalBuffer(page, terminalId, { contains: repaintMarker }, { timeout: WAIT_TIMEOUT_MS });
        const afterRepaint = await repaintRendered;
        expect(afterRepaint.renderCount).toBeGreaterThan(repaintBefore.renderCount);
        const repaintChanged = await expectKnownMarkerChanged(page, screen, repaintBeforePixels, {
          minimumChangedRatio: 0.002,
          testInfo,
          artifactName: `r-09-${label}-repaint-crop`,
        });
        assertCompositorImageScale(repaintChanged.after, geometry, factor);
        await expectTerminalNonBlank(page, screen, {
          minimumNonBackgroundRatio: 0.002,
          testInfo,
          artifactName: `r-09-${label}-repaint-nonblank`,
        });

        const settledForSize = await terminal.snapshot();
        if (!settledForSize) throw new Error(`No diagnostics snapshot before SIZE for terminal ${terminalId}`);
        const sizeEventId = await lastEventId(terminal);
        const sizeTranscript = server.waitForTranscript<FixtureSize>(
          terminalId,
          (entry) => entry.event === "size" && entry.id === sizeId,
          { timeoutMs: WAIT_TIMEOUT_MS },
        );
        const sizeRendered = waitForRenderedCommand(page, terminalId, sizeMarker, sizeEventId, settledForSize.renderCount);
        await terminal.sendInput(`SIZE ${sizeId}`, true);
        const size = await sizeTranscript;
        expect(size.rows).toBe(settledForSize.rows);
        expect(size.cols).toBe(settledForSize.cols);
        if (size.pixel_width !== undefined) expect(size.pixel_width).toBe(settledForSize.pixelWidth);
        if (size.pixel_height !== undefined) expect(size.pixel_height).toBe(settledForSize.pixelHeight);
        await sizeRendered;
        await expectTerminalBuffer(page, terminalId, { contains: sizeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

        const echoBeforePixels = await screenshotRegion(page, screen);
        const echoBefore = await terminal.snapshot();
        if (!echoBefore) throw new Error(`No diagnostics snapshot before continued input for terminal ${terminalId}`);
        const echoEventId = await lastEventId(terminal);
        const echoArmed = server.waitForTranscript(
          terminalId,
          (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
          { timeoutMs: WAIT_TIMEOUT_MS },
        );
        await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
        await echoArmed;
        await expectTerminalBuffer(page, terminalId, { contains: echoReadyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
        const echoPayloadEventId = await lastEventId(terminal);
        const echoPayload = server.waitForTranscript<{
          readonly event: string;
          readonly id: string;
          readonly phase: string;
          readonly payload_base64: string;
        }>(
          terminalId,
          (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
          { timeoutMs: WAIT_TIMEOUT_MS },
        );
        const echoRendered = waitForRenderedCommand(page, terminalId, echoPayloadMarker, echoPayloadEventId, echoBefore.renderCount);
        await terminal.sendInput(echoText, true);
        const echoEntry = await echoPayload;
        expect(echoEntry.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
        await expectTerminalBuffer(page, terminalId, { contains: echoPayloadMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
        const afterEcho = await echoRendered;
        expect(afterEcho.renderCount).toBeGreaterThan(echoBefore.renderCount);
        const echoChanged = await expectKnownMarkerChanged(page, screen, echoBeforePixels, {
          minimumChangedRatio: 0.001,
          testInfo,
          artifactName: `r-09-${label}-echo-crop`,
        });
        assertCompositorImageScale(echoChanged.after, geometry, factor);
        await expectTerminalNonBlank(page, screen, {
          minimumNonBackgroundRatio: 0.002,
          testInfo,
          artifactName: `r-09-${label}-echo-nonblank`,
        });

        const final = await waitForViewportConvergence(page, terminalId);
        assertCompositorGeometry(await compositorGeometry(screen), final, factor);
        expect(final.cols).toBe(settledForSize.cols);
        expect(final.rows).toBe(settledForSize.rows);
        expect(final.socketState).toBe("connected");
        expect(final.socketGeneration).toBe(1);
        expect(final.activeSocketCount).toBe(1);
        expect(final.socket.activeCount).toBe(1);
        expect(final.mounted).toBe(true);
        expect(final.visible).toBe(true);
        expect(final.active).toBe(true);
        expect(final.lifecycle.mounted).toBe(true);
        expect(final.lifecycle.visible).toBe(true);
        expect(final.lifecycle.active).toBe(true);
        expect(final.acceptingInput).toBe(true);
        expect(final.cursorX).toBeGreaterThanOrEqual(0);
        expect(final.cursorX).toBeLessThanOrEqual(final.cols);
        expect(final.cursorY).toBeGreaterThanOrEqual(0);
        expect(final.cursorY).toBeLessThanOrEqual(final.rows);
        expect(final.rendererState.kind).toBe(final.renderer);
        expect(final.renderCount).toBeGreaterThan(0);
        expect(final.pendingParserWrites).toBe(0);
        expect(final.pendingParserBytes).toBe(0);
        expect(final.renderBacklogBytes).toBe(0);
        expect(final.renderBacklogFrames).toBe(0);
        expect(final.flowControlled).toBe(false);
        expect(final.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
        if (final.receivedSequence !== undefined && final.committedSequence !== undefined) {
          expect(final.committedSequence).toBe(final.receivedSequence);
        }
        expect(final.xterm.text).toContain(echoReadyMarker);
        expect(final.xterm.text).toContain(indexedMarker);
        expect(final.xterm.text).toContain(trueColorMarker);
        expect(final.xterm.text).toContain(printMarker);
        expect(final.xterm.text).toContain(repaintMarker);
        expect(final.xterm.text).toContain(echoPayloadMarker);

        const events = await terminalEvents(page, terminalId);
        expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
        expect(events.filter((event) => event.type === "socket-open")).toHaveLength(1);
        expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
        expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
        expect(events.filter((event) => event.type === "sync")).toHaveLength(1);
        expect(events.filter((event) => event.type === "synced")).toHaveLength(1);
        expect(events.filter((event) => event.type === "error")).toHaveLength(0);
        expect(events.filter((event) => event.type === "render").length).toBeGreaterThan(0);
        const rendererLoads = events.filter((event) => event.type === "renderer-load");
        const rendererFallbacks = events.filter((event) => event.type === "renderer-fallback");
        if (final.renderer === "webgl") {
          expect(rendererLoads).toHaveLength(1);
          expect(rendererFallbacks).toHaveLength(0);
          expect(final.webglLoadCount).toBe(1);
          expect(final.fallbackCount).toBe(0);
          expect(final.contextLossCount).toBe(0);
        } else {
          expect(rendererFallbacks.length).toBeGreaterThanOrEqual(1);
          expect(rendererLoads.length).toBeLessThanOrEqual(1);
          expect(final.fallbackCount).toBeGreaterThanOrEqual(1);
          for (const fallback of rendererFallbacks) {
            expect(["load-failed", "context-loss"]).toContain(String(fallback.data.reason));
          }
        }
        await assertMonotonicSequences(events);
        const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
        expect(invariantReport.violations).toEqual([]);
        await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

        const transcript = await server.readTranscript(terminalId);
        expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
        expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
        expect(transcript.filter((entry) => entry.event === "colors" && entry.id === colorsId)).toHaveLength(1);
        expect(transcript.filter((entry) => entry.event === "print" && entry.id === printId)).toHaveLength(1);
        expect(transcript.filter((entry) => entry.event === "repaint" && entry.id === repaintId)).toHaveLength(1);
        expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
        expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
      });

      const unexpectedBrowserErrors = browserErrors().filter((entry) => (
        entry.kind === "pageerror"
        || entry.kind === "requestfailed"
        || (entry.kind === "console" && /^error:/i.test(entry.message))
        || /unhandled(?:promise)?|uncaught/i.test(entry.message)
      ));
      expect(unexpectedBrowserErrors, `R-09 DPR ${factor} produced an unexpected browser error`).toEqual([]);
    } finally {
      browserErrors.dispose();
      await context.close();
    }
  }
});
