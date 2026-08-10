import { test, expect } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type { Locator, Page } from "@playwright/test";
import type { TerminalPanePage } from "../pages/terminal-pane.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  expectTerminalBuffer,
  expectTerminalConverged,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalGeometry = {
  readonly dpr: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly visualViewportScale: number;
  readonly screen: {
    readonly width: number;
    readonly height: number;
  };
  readonly canvases: readonly {
    readonly width: number;
    readonly height: number;
    readonly cssWidth: number;
    readonly cssHeight: number;
  }[];
};

type CssGeometry = {
  readonly width: number;
  readonly height: number;
};

const WAIT_TIMEOUT_MS = 15_000;
const VIEWPORT = { width: 1_280, height: 800 } as const;
const DPR_FACTORS = [1, 1.25, 1.5, 1.8, 2] as const;

async function waitForMount(page: Page): Promise<E2ETerminalEvent> {
  return page.evaluate(async () => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout: 15_000 });
  });
}

async function waitForInteractiveRender(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderCount > 0
    ), { timeout: 15_000 });
  }, { id: terminalId });
}

async function waitForRenderedMarker(
  page: Page,
  terminalId: string,
  marker: string,
  previousRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, markerText, renderCount }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > renderCount
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.xterm.text.includes(markerText)
    ), { timeout: 15_000 });
  }, { id: terminalId, markerText: marker, renderCount: previousRenderCount });
}

async function terminalGeometry(
  screen: Locator,
): Promise<TerminalGeometry> {
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
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualViewportScale: window.visualViewport?.scale ?? 1,
      screen: { width: screenRect.width, height: screenRect.height },
      canvases,
    };
  });
}

function assertBackingPixels(geometry: TerminalGeometry, factor: number): void {
  expect(geometry.canvases.length, "xterm did not mount a compositor canvas").toBeGreaterThan(0);
  const canvas = geometry.canvases.find((candidate) => (
    candidate.cssWidth > 0
    && candidate.cssHeight > 0
    && candidate.width > 0
    && candidate.height > 0
  ));
  if (!canvas) throw new Error("xterm has no visible compositor canvas");
  expect(canvas.width).toBe(Math.round(canvas.cssWidth * factor));
  expect(canvas.height).toBe(Math.round(canvas.cssHeight * factor));
}

function assertCssViewport(
  snapshot: E2ETerminalSnapshot,
  geometry: TerminalGeometry,
  expectedCss: CssGeometry,
): void {
  expect(snapshot.proposedViewport).toBeDefined();
  expect(snapshot.desiredViewport).toBeDefined();
  expect(snapshot.sentViewport).toBeDefined();
  expect(snapshot.serverViewport).toBeDefined();
  expect(Math.abs(snapshot.pixelWidth - Math.round(expectedCss.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(snapshot.pixelHeight - Math.round(expectedCss.height))).toBeLessThanOrEqual(1);
  expect(snapshot.sentViewport?.pixelWidth).toBe(snapshot.pixelWidth);
  expect(snapshot.sentViewport?.pixelHeight).toBe(snapshot.pixelHeight);
  expect(snapshot.serverViewport?.pixelWidth).toBe(snapshot.pixelWidth);
  expect(snapshot.serverViewport?.pixelHeight).toBe(snapshot.pixelHeight);
  expect(Math.abs(geometry.screen.width - expectedCss.width)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(geometry.screen.height - expectedCss.height)).toBeLessThanOrEqual(0.01);
}

function assertCompositorImageScale(
  image: { readonly width: number; readonly height: number },
  geometry: TerminalGeometry,
  factor: number,
): void {
  const expectedWidth = Math.round(Math.ceil(geometry.screen.width) * factor);
  const expectedHeight = Math.round(Math.ceil(geometry.screen.height) * factor);
  expect(Math.abs(image.width - expectedWidth)).toBeLessThanOrEqual(2);
  expect(Math.abs(image.height - expectedHeight)).toBeLessThanOrEqual(2);
}

test("@nightly @dpr @resize V-12 Device-pixel ratio changes", async ({ browser, server }, testInfo) => {
  if (!server.baseURL) throw new Error("isolated E2E server has no proxy base URL");

  const runToken = `${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  let terminalId: string | undefined;
  let terminalName: string | undefined;
  let baselineDimensions: { readonly cols: number; readonly rows: number; readonly pixelWidth: number; readonly pixelHeight: number } | undefined;
  let baselineCss: CssGeometry | undefined;

  for (const factor of DPR_FACTORS) {
    const factorLabel = String(factor).replace(".", "_");
    const context = await browser.newContext({
      baseURL: server.baseURL,
      viewport: VIEWPORT,
      deviceScaleFactor: factor,
    });
    const page = await context.newPage();
    const browserErrors = installBrowserErrorCollectors(page);

    try {
      await test.step(`DPR ${factor}`, async () => {
        await page.goto("/");
        await new LoginPage(page).login();
        const workbench = new WorkbenchPage(page);
        await workbench.expectVisible();

        const mount = waitForMount(page);
        let terminal: TerminalPanePage;
        if (terminalId === undefined) {
          await workbench.createTerminal();
          const mounted = await mount;
          terminalId = mounted.terminalId;
          terminal = workbench.terminal(terminalId);
          terminalName = (await terminal.root.getAttribute("aria-label"))?.replace(/^Terminal(?: pane)?\s+/i, "");
        } else {
          terminal = await workbench.openTerminal(terminalName ? { id: terminalId, name: terminalName } : { id: terminalId });
          const mounted = await mount;
          expect(mounted.terminalId).toBe(terminalId);
        }
        await terminal.expectVisible();
        await expect(terminal.xtermHost.locator(".xterm-screen")).toBeVisible();
        const screen = terminal.xtermHost.locator(".xterm-screen");
        await terminal.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
        const interactive = await waitForInteractiveRender(page, terminalId);
        const geometry = await terminalGeometry(screen);

        expect(geometry.dpr).toBeCloseTo(factor, 3);
        expect(geometry.innerWidth).toBe(VIEWPORT.width);
        expect(geometry.innerHeight).toBe(VIEWPORT.height);
        expect(geometry.visualViewportScale).toBeCloseTo(1, 3);
        expect(interactive.renderer).toMatch(/^(webgl|canvas|dom)$/);
        expect(interactive.rendererState.renderCount).toBeGreaterThan(0);
        assertBackingPixels(geometry, factor);

        if (baselineDimensions === undefined) {
          baselineDimensions = {
            cols: interactive.cols,
            rows: interactive.rows,
            pixelWidth: interactive.pixelWidth,
            pixelHeight: interactive.pixelHeight,
          };
          baselineCss = { ...geometry.screen };
        } else {
          expect(interactive.cols).toBe(baselineDimensions.cols);
          expect(interactive.rows).toBe(baselineDimensions.rows);
          expect(interactive.pixelWidth).toBe(baselineDimensions.pixelWidth);
          expect(interactive.pixelHeight).toBe(baselineDimensions.pixelHeight);
          expect(geometry.screen.width).toBeCloseTo(baselineCss!.width, 2);
          expect(geometry.screen.height).toBeCloseTo(baselineCss!.height, 2);
        }

        const converged = await expectTerminalConverged(page, terminalId, baselineDimensions!, {
          timeout: WAIT_TIMEOUT_MS,
        });
        assertCssViewport(converged, geometry, baselineCss ?? geometry.screen);

        const readyId = `V12-READY-${runToken}-${factorLabel}`;
        const sizeId = `V12-SIZE-${runToken}-${factorLabel}`;
        const queryId = `V12-QUERY-${runToken}-${factorLabel}`;
        const printId = `V12-PRINT-${runToken}-${factorLabel}`;
        const printText = `DPR-${factorLabel}`;
        const expectedPrint = `[E2E:PRINT:${printId}:${printText}]`;
        const echoId = `V12-ECHO-${runToken}-${factorLabel}`;
        const inputMarker = `V12-INPUT-${runToken}-${factorLabel}`;

        await terminal.sendInput(`READY ${readyId}`, true);
        await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId);
        await terminal.sendInput(`SIZE ${sizeId}`, true);
        const size = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeId);
        expect(size.rows).toBe(converged.rows);
        expect(size.cols).toBe(converged.cols);

        await terminal.sendInput(`QUERY ${queryId}`, true);
        await server.waitForTranscript(terminalId, (entry) => entry.event === "query_complete" && entry.id === queryId);

        const beforePrint = await screenshotRegion(page, screen);
        const beforePrintSnapshot = await terminal.snapshot();
        if (!beforePrintSnapshot) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
        await terminal.sendInput(`PRINT ${printId} ${printText}`, true);
        await waitForRenderedMarker(page, terminalId, expectedPrint, beforePrintSnapshot.renderCount);
        await expectTerminalBuffer(page, terminalId, { contains: expectedPrint, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
        const { after: afterPrint } = await expectKnownMarkerChanged(page, screen, beforePrint, {
          minimumChangedRatio: 0.002,
          testInfo,
          artifactName: `v-12-dpr-${factorLabel}-marker-crop`,
        });
        assertCompositorImageScale(afterPrint, geometry, factor);
        await expectTerminalNonBlank(page, screen, {
          minimumNonBackgroundRatio: 0.002,
          testInfo,
          artifactName: `v-12-dpr-${factorLabel}-nonblank-crop`,
        });

        await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
        await server.waitForTranscript(terminalId, (entry) => (
          entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
        ));
        await terminal.sendInput(inputMarker, true);
        const payload = await server.waitForTranscript(terminalId, (entry) => (
          entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload"
        ));
        expect(payload.payload_base64).toBe(Buffer.from(inputMarker, "utf8").toString("base64"));

        const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
        assertNoPendingSynchronization(invariantReport.snapshot);
        expect(invariantReport.events.filter((event) => event.type === "error")).toHaveLength(0);
        expect(invariantReport.snapshot.activeSocketCount).toBe(1);
        expect(invariantReport.snapshot.socket.activeCount).toBe(1);
        expect(invariantReport.snapshot.renderer).toMatch(/^(webgl|canvas|dom)$/);
        const transcript = await server.readTranscript(terminalId);
        expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
        expect(transcript.filter((entry) => entry.event === "print" && entry.id === printId)).toHaveLength(1);
        expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
      });

      const unexpectedBrowserErrors = browserErrors().filter((entry) => (
        entry.kind === "pageerror"
        || entry.kind === "requestfailed"
        || (entry.kind === "console" && /^error:/i.test(entry.message))
      ));
      expect(unexpectedBrowserErrors).toEqual([]);
    } finally {
      browserErrors.dispose();
      await context.close();
    }
  }
});
