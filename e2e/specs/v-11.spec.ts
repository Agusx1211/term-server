import { test, expect } from "../fixtures/test.js";
import type { IsolatedServer } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
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
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;
const INITIAL_DESKTOP_VIEWPORT = { width: 1280, height: 720 } as const;
// The terminal zoom controls are in the touch keybar. Keep the browser rect
// fixed at a desktop-browser size that exposes that production control surface.
const TERMINAL_ZOOM_VIEWPORT = { width: 800, height: 680 } as const;
const DEFAULT_FONT_SIZE = 13;
const NATIVE_BROWSER_ZOOM_FACTORS = [1, 1.25, 0.8, 1] as const;
const TERMINAL_FONT_SIZES = [14, 24, 8, 13] as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type CdpSessionLike = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
};

interface BrowserMetrics {
  readonly dpr: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly visualViewportScale: number;
  readonly pageZoom?: number;
}

interface TerminalMeasure {
  readonly dpr: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly visualViewportScale: number;
  readonly pageZoom?: number;
  readonly hostWidth: number;
  readonly hostHeight: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly canvasCssWidth: number;
  readonly canvasCssHeight: number;
}

interface PtySize {
  readonly rows: number;
  readonly cols: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

interface StateRecord {
  readonly label: string;
  readonly browserZoomFactor: number;
  readonly fontSize: number;
  readonly snapshot: E2ETerminalSnapshot;
  readonly measure: TerminalMeasure;
  readonly pty: PtySize;
}

function expectWithin(actual: number, expected: number, tolerance: number, message: string): void {
  expect(Math.abs(actual - expected), message).toBeLessThanOrEqual(tolerance);
}

async function readBrowserMetrics(page: Page): Promise<BrowserMetrics> {
  return page.evaluate(() => {
    const visualViewport = window.visualViewport;
    const pageZoom = visualViewport && "zoom" in visualViewport
      ? (visualViewport as VisualViewport & { zoom?: unknown }).zoom
      : undefined;
    return {
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      visualViewportScale: visualViewport?.scale ?? 1,
      ...(typeof pageZoom === "number" ? { pageZoom } : {}),
    } satisfies BrowserMetrics;
  });
}

async function waitForBrowserMetrics(
  page: Page,
  target: { readonly dpr: number; readonly innerWidth: number; readonly innerHeight: number },
): Promise<BrowserMetrics> {
  return page.evaluate(async ({ targetDpr, targetWidth, targetHeight, timeout }) => {
    const read = (): BrowserMetrics => {
      const visualViewport = window.visualViewport;
      const pageZoom = visualViewport && "zoom" in visualViewport
        ? (visualViewport as VisualViewport & { zoom?: unknown }).zoom
        : undefined;
      return {
        dpr: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        visualViewportScale: visualViewport?.scale ?? 1,
        ...(typeof pageZoom === "number" ? { pageZoom } : {}),
      } satisfies BrowserMetrics;
    };
    const matches = (metrics: BrowserMetrics): boolean => (
      Math.abs(metrics.dpr - targetDpr) <= Math.max(0.03, targetDpr * 0.03)
      && Math.abs(metrics.innerWidth - targetWidth) <= 1
      && Math.abs(metrics.innerHeight - targetHeight) <= 1
    );
    return new Promise<BrowserMetrics>((resolve, reject) => {
      let timeoutId = 0;
      let frameId = 0;
      let settled = false;
      let observer: ResizeObserver | undefined;
      let check: () => void;
      const visualViewport = window.visualViewport;
      const cleanup = (): void => {
        window.removeEventListener("resize", check);
        visualViewport?.removeEventListener("resize", check);
        observer?.disconnect();
        window.cancelAnimationFrame(frameId);
        window.clearTimeout(timeoutId);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(read());
      };
      check = (): void => {
        const metrics = read();
        if (matches(metrics)) finish();
        else frameId = window.requestAnimationFrame(check);
      };
      window.addEventListener("resize", check);
      visualViewport?.addEventListener("resize", check);
      observer = new ResizeObserver(check);
      observer.observe(document.documentElement);
      timeoutId = window.setTimeout(() => {
        finish(new Error(`browser zoom did not settle at ${targetWidth}x${targetHeight} @ ${targetDpr}`));
      }, timeout);
      check();
    });
  }, {
    targetDpr: target.dpr,
    targetWidth: target.innerWidth,
    targetHeight: target.innerHeight,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function setBrowserZoom(
  page: Page,
  cdp: CdpSessionLike,
  baseline: BrowserMetrics,
  factor: number,
): Promise<BrowserMetrics> {
  const width = Math.max(1, Math.round(baseline.innerWidth / factor));
  const height = Math.max(1, Math.round(baseline.innerHeight / factor));
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: baseline.dpr * factor,
    mobile: false,
    screenWidth: baseline.screenWidth,
    screenHeight: baseline.screenHeight,
  });
  return waitForBrowserMetrics(page, {
    dpr: baseline.dpr * factor,
    innerWidth: width,
    innerHeight: height,
  });
}

async function restoreBrowserViewport(page: Page, cdp: CdpSessionLike, baseline: BrowserMetrics): Promise<void> {
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await page.setViewportSize(TERMINAL_ZOOM_VIEWPORT);
  await waitForBrowserMetrics(page, {
    dpr: baseline.dpr,
    innerWidth: baseline.innerWidth,
    innerHeight: baseline.innerHeight,
  });
}

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  updatedAfter?: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, floor, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewports = [snapshot.desiredViewport, snapshot.sentViewport, snapshot.serverViewport];
      const dimensionsAgree = viewports.every((viewport) => (
        viewport !== undefined
        && viewport.cols === snapshot.cols
        && viewport.rows === snapshot.rows
        && Math.abs(viewport.pixelWidth - snapshot.pixelWidth) <= 1
        && Math.abs(viewport.pixelHeight - snapshot.pixelHeight) <= 1
      ));
      return (floor === undefined || snapshot.updatedAt > floor)
        && snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.cols > 0
        && snapshot.rows > 0
        && snapshot.pixelWidth > 0
        && snapshot.pixelHeight > 0
        && dimensionsAgree;
    }, { timeout });
  }, { id: terminalId, floor: updatedAfter, timeout: WAIT_TIMEOUT_MS });
}


async function measureTerminalWithSnapshot(
  pane: TerminalPanePage,
  snapshot: E2ETerminalSnapshot,
): Promise<TerminalMeasure> {
  const measured = await pane.xtermHost.evaluate((host, dimensions) => {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const canvas = host.querySelector<HTMLCanvasElement>("canvas");
    if (!screen || !canvas) throw new Error("xterm compositor screen and canvas are unavailable");
    const hostRect = host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const browser = window.visualViewport;
    const pageZoom = browser && "zoom" in browser
      ? (browser as VisualViewport & { zoom?: unknown }).zoom
      : undefined;
    if (screenRect.width <= 0 || screenRect.height <= 0) throw new Error("xterm screen has no measurable size");
    return {
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualViewportScale: browser?.scale ?? 1,
      ...(typeof pageZoom === "number" ? { pageZoom } : {}),
      hostWidth: hostRect.width,
      hostHeight: hostRect.height,
      screenWidth: screenRect.width,
      screenHeight: screenRect.height,
      cellWidth: screenRect.width / dimensions.cols,
      cellHeight: screenRect.height / dimensions.rows,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      canvasCssWidth: canvasRect.width,
      canvasCssHeight: canvasRect.height,
    } satisfies TerminalMeasure;
  }, { cols: snapshot.cols, rows: snapshot.rows });
  return measured;
}

function numberField(entry: Record<string, unknown>, key: string): number {
  const value = entry[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`transcript field ${key} is not a finite number`);
  return value;
}

function assertGeometry(
  snapshot: E2ETerminalSnapshot,
  measure: TerminalMeasure,
  pty: PtySize,
  compositorWidth: number,
  compositorHeight: number,
): void {
  expect(snapshot.cols).toBeGreaterThan(0);
  expect(snapshot.rows).toBeGreaterThan(0);
  expect(snapshot.pixelWidth).toBeGreaterThan(0);
  expect(snapshot.pixelHeight).toBeGreaterThan(0);
  for (const viewport of [snapshot.proposedViewport, snapshot.desiredViewport, snapshot.sentViewport, snapshot.serverViewport]) {
    expect(viewport).toBeDefined();
    if (!viewport) continue;
    expect(viewport.cols).toBe(snapshot.cols);
    expect(viewport.rows).toBe(snapshot.rows);
    expectWithin(viewport.pixelWidth, snapshot.pixelWidth, 1, "viewport pixel width diverged from xterm");
    expectWithin(viewport.pixelHeight, snapshot.pixelHeight, 1, "viewport pixel height diverged from xterm");
  }
  expect(pty.cols).toBe(snapshot.cols);
  expect(pty.rows).toBe(snapshot.rows);
  expect(pty.pixelWidth).toBe(snapshot.pixelWidth);
  expect(pty.pixelHeight).toBe(snapshot.pixelHeight);
  expect(measure.cellWidth).toBeGreaterThan(0);
  expect(measure.cellHeight).toBeGreaterThan(0);
  expectWithin(measure.screenWidth, measure.cellWidth * snapshot.cols, 1, "screen width is not cell width times columns");
  expectWithin(measure.screenHeight, measure.cellHeight * snapshot.rows, 1, "screen height is not cell height times rows");
  expect(measure.screenWidth).toBeLessThanOrEqual(measure.hostWidth + 1);
  expect(measure.screenHeight).toBeLessThanOrEqual(measure.hostHeight + 1);
  expectWithin(measure.canvasCssWidth, measure.screenWidth, 2, "canvas CSS width is clipped from the xterm screen");
  expectWithin(measure.canvasCssHeight, measure.screenHeight, 2, "canvas CSS height is clipped from the xterm screen");
  expectWithin(measure.canvasWidth, measure.screenWidth * measure.dpr, 3, "canvas backing width does not track CSS width and DPR");
  expectWithin(measure.canvasHeight, measure.screenHeight * measure.dpr, 3, "canvas backing height does not track CSS height and DPR");
  expectWithin(compositorWidth, Math.round(measure.screenWidth * measure.dpr), 3, "compositor screenshot width does not track CSS width and DPR");
  expectWithin(compositorHeight, Math.round(measure.screenHeight * measure.dpr), 3, "compositor screenshot height does not track CSS height and DPR");
}

async function expectFontControl(pane: TerminalPanePage, fontSize: number): Promise<void> {
  const percent = Math.round((fontSize / DEFAULT_FONT_SIZE) * 100);
  await expect(pane.root.getByRole("button", { name: new RegExp(`Current zoom ${percent}%`) }).first()).toBeVisible();
}

async function setTerminalFontSize(
  page: Page,
  pane: TerminalPanePage,
  fontSize: number,
  currentFontSize: number,
): Promise<void> {
  const before = await pane.snapshot();
  if (!before) throw new Error(`No diagnostics snapshot for terminal ${pane.terminalId}`);
  if (fontSize > currentFontSize) {
    for (let value = currentFontSize; value < fontSize; value += 1) await pane.zoomIn();
  } else if (fontSize < currentFontSize) {
    for (let value = currentFontSize; value > fontSize; value -= 1) await pane.zoomOut();
  } else {
    await pane.resetZoom();
  }
  await expectFontControl(pane, fontSize);
  await page.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
  await waitForSettledTerminal(page, pane.terminalId, before.updatedAt);
}

async function runState(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  token: string,
  stateIndex: number,
  label: string,
  browserZoomFactor: number,
  fontSize: number,
  baselineDpr: number,
  baselineInnerWidth: number,
  baselineInnerHeight: number,
): Promise<StateRecord> {
  await expectFontControl(pane, fontSize);
  const screen = pane.xtermHost.locator(".xterm-screen");
  const beforeImage = await screenshotRegion(page, screen);
  const sizeId = `${token}-${label}-SIZE`;
  const winchId = `${token}-${label}-WINCH`;
  const queryId = `${token}-${label}-QUERY`;
  const markerId = `${token}-${label}-PRINT`;

  await pane.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await server.waitForTranscript(pane.terminalId, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
  const pty = {
    rows: numberField(sizeEntry, "rows"),
    cols: numberField(sizeEntry, "cols"),
    pixelWidth: numberField(sizeEntry, "pixel_width"),
    pixelHeight: numberField(sizeEntry, "pixel_height"),
  } satisfies PtySize;

  await pane.sendInput(`WINCH ${winchId} ${stateIndex}`, true);
  const winchEntry = await server.waitForTranscript(pane.terminalId, (entry) => entry.event === "sigwinch" && entry.id === winchId, { timeoutMs: WAIT_TIMEOUT_MS });
  expect(numberField(winchEntry, "rows")).toBe(pty.rows);
  expect(numberField(winchEntry, "cols")).toBe(pty.cols);
  expect(numberField(winchEntry, "actual_rows")).toBe(pty.rows);
  expect(numberField(winchEntry, "actual_cols")).toBe(pty.cols);

  await pane.sendInput(`QUERY ${queryId}`, true);
  const queryComplete = await server.waitForTranscript(pane.terminalId, (entry) => entry.event === "query_complete" && entry.id === queryId, { timeoutMs: WAIT_TIMEOUT_MS });
  expect(numberField(queryComplete, "replies")).toBe(4);
  const queryEntries = await server.readTranscript(pane.terminalId);
  expect(queryEntries.filter((entry) => entry.event === "query_reply" && entry.id === queryId)).toHaveLength(4);
  expect(queryEntries.filter((entry) => entry.event === "query_incomplete" && entry.id === queryId)).toHaveLength(0);

  await pane.sendInput(`PRINT ${markerId} ${label}`, true);
  await server.waitForTranscript(pane.terminalId, (entry) => entry.event === "print" && entry.id === markerId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, pane.terminalId, {
    contains: `[E2E:PRINT:${markerId}:${label}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const { after: afterImage } = await expectKnownMarkerChanged(page, screen, beforeImage, {
    minimumChangedRatio: 0.002,
    testInfo: undefined,
    artifactName: `v11-${label}-marker-crop`,
  });
  await expectTerminalNonBlank(page, screen, {
    minimumNonBackgroundRatio: 0.002,
    testInfo: undefined,
    artifactName: `v11-${label}-terminal-crop`,
  });

  const snapshot = await waitForSettledTerminal(page, pane.terminalId);
  const measure = await measureTerminalWithSnapshot(pane, snapshot);
  const compositor = afterImage;
  assertGeometry(snapshot, measure, pty, compositor.width, compositor.height);
  expectWithin(measure.dpr / baselineDpr, browserZoomFactor, 0.04, "browser zoom factor diverged from the requested factor");
  expectWithin(measure.innerWidth, Math.round(baselineInnerWidth / browserZoomFactor), 1, "browser zoom did not settle the CSS width");
  expectWithin(measure.innerHeight, Math.round(baselineInnerHeight / browserZoomFactor), 1, "browser zoom did not settle the CSS height");

  return { label, browserZoomFactor, fontSize, snapshot, measure, pty };
}

test("V-11 Browser zoom and terminal zoom @nightly @zoom @resize", async ({ page, server }, testInfo) => {
  await page.setViewportSize(INITIAL_DESKTOP_VIEWPORT);
  await page.goto("/");
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const mountEvent = page.evaluate(async ({ timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, { timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const pane = workbench.terminal(mounted.terminalId);
  await pane.expectVisible();
  const initial = await expectTerminalSynchronized(page, mounted.terminalId, { timeout: WAIT_TIMEOUT_MS });

  const token = `V11-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-${Date.now()}`;
  const readyId = `${token}-READY`;
  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(mounted.terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });

  await page.setViewportSize(TERMINAL_ZOOM_VIEWPORT);
  await pane.expectVisible();
  await waitForSettledTerminal(page, mounted.terminalId, initial.updatedAt);
  await pane.resetZoom();
  await expectFontControl(pane, DEFAULT_FONT_SIZE);
  await waitForSettledTerminal(page, mounted.terminalId);
  const baselineBrowser = await readBrowserMetrics(page);

  const states: StateRecord[] = [];
  states.push(await runState(
    page,
    pane,
    server,
    token,
    1,
    "browser-100-font-13",
    1,
    DEFAULT_FONT_SIZE,
    baselineBrowser.dpr,
    baselineBrowser.innerWidth,
    baselineBrowser.innerHeight,
  ));

  const browserName = page.context().browser()?.browserType().name();
  let browserZoomSupported = browserName === "chromium";
  let cdp: CdpSessionLike | undefined;
  if (browserZoomSupported) {
    try {
      cdp = await page.context().newCDPSession(page) as unknown as CdpSessionLike;
      await setBrowserZoom(page, cdp, baselineBrowser, NATIVE_BROWSER_ZOOM_FACTORS[1]);
    } catch (error) {
      browserZoomSupported = false;
      testInfo.annotations.push({
        type: "skip",
        description: `native browser zoom capability unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
      if (cdp) {
        try {
          await restoreBrowserViewport(page, cdp, baselineBrowser);
        } catch {
          // The terminal zoom phase still runs at the original page viewport.
        }
      }
    }
  } else {
    testInfo.annotations.push({
      type: "skip",
      description: `native browser zoom is unsupported by ${browserName ?? "this browser engine"}; terminal zoom remains covered`,
    });
  }

  if (browserZoomSupported && cdp) {
    states.push(await runState(
      page,
      pane,
      server,
      token,
      2,
      "browser-125-font-13",
      NATIVE_BROWSER_ZOOM_FACTORS[1],
      DEFAULT_FONT_SIZE,
      baselineBrowser.dpr,
      baselineBrowser.innerWidth,
      baselineBrowser.innerHeight,
    ));
    await setBrowserZoom(page, cdp, baselineBrowser, NATIVE_BROWSER_ZOOM_FACTORS[2]);
    states.push(await runState(
      page,
      pane,
      server,
      token,
      3,
      "browser-80-font-13",
      NATIVE_BROWSER_ZOOM_FACTORS[2],
      DEFAULT_FONT_SIZE,
      baselineBrowser.dpr,
      baselineBrowser.innerWidth,
      baselineBrowser.innerHeight,
    ));
    await setBrowserZoom(page, cdp, baselineBrowser, NATIVE_BROWSER_ZOOM_FACTORS[3]);
    states.push(await runState(
      page,
      pane,
      server,
      token,
      4,
      "browser-100-restored-font-13",
      NATIVE_BROWSER_ZOOM_FACTORS[3],
      DEFAULT_FONT_SIZE,
      baselineBrowser.dpr,
      baselineBrowser.innerWidth,
      baselineBrowser.innerHeight,
    ));
  }

  if (cdp) {
    try {
      await restoreBrowserViewport(page, cdp, baselineBrowser);
    } finally {
      await cdp.detach();
    }
  }
  await page.setViewportSize(TERMINAL_ZOOM_VIEWPORT);
  await waitForSettledTerminal(page, mounted.terminalId);
  await expectFontControl(pane, DEFAULT_FONT_SIZE);

  let currentFontSize = DEFAULT_FONT_SIZE;
  for (const [stateIndex, fontSize] of TERMINAL_FONT_SIZES.entries()) {
    await setTerminalFontSize(page, pane, fontSize, currentFontSize);
    currentFontSize = fontSize;
    states.push(await runState(
      page,
      pane,
      server,
      token,
      stateIndex + 5,
      `browser-100-terminal-font-${fontSize}`,
      1,
      fontSize,
      baselineBrowser.dpr,
      baselineBrowser.innerWidth,
      baselineBrowser.innerHeight,
    ));
  }

  const browserStates = states.filter((state) => state.fontSize === DEFAULT_FONT_SIZE && !state.label.includes("terminal-font-"));
  const terminalStates = states.slice(-TERMINAL_FONT_SIZES.length);
  const baselineTerminalState = terminalStates[terminalStates.length - 1];
  if (!baselineTerminalState) throw new Error("V-11 terminal zoom states were not collected");
  const font14 = terminalStates.find((state) => state.fontSize === 14);
  const font24 = terminalStates.find((state) => state.fontSize === 24);
  const font8 = terminalStates.find((state) => state.fontSize === 8);
  if (!font14 || !font24 || !font8) throw new Error("V-11 terminal zoom states are incomplete");
  expect(font14.measure.cellHeight).toBeGreaterThan(baselineTerminalState.measure.cellHeight);
  expect(font24.measure.cellHeight).toBeGreaterThan(font14.measure.cellHeight);
  expect(font8.measure.cellHeight).toBeLessThan(baselineTerminalState.measure.cellHeight);
  expectWithin(
    baselineTerminalState.measure.cellHeight,
    states[0]!.measure.cellHeight,
    1.5,
    "resetting terminal zoom did not restore the baseline cell height",
  );
  if (browserZoomSupported) expect(browserStates.map((state) => state.browserZoomFactor)).toEqual([...NATIVE_BROWSER_ZOOM_FACTORS]);

  const echoId = `${token}-ECHO`;
  const inputMarker = `${token}-continued-input`;
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(mounted.terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(inputMarker, true);
  const payload = await server.waitForTranscript(mounted.terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
  expect(payload.payload_base64).toBe(Buffer.from(inputMarker, "utf8").toString("base64"));
  await expectTerminalBuffer(page, mounted.terminalId, {
    contains: `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(inputMarker, "utf8").toString("base64")}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const transcript = await server.readTranscript(mounted.terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "query_incomplete")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  const events = await terminalEvents(page, mounted.terminalId);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "state" && ["disconnected", "recovering"].includes(String(event.data.state)))).toHaveLength(0);
  await assertMonotonicSequences(events);
  await expectNoPendingRecovery(page, mounted.terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, mounted.terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, mounted.terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  const final = await waitForSettledTerminal(page, mounted.terminalId);
  expect(final.activeSocketCount).toBe(1);
  expect(final.socket.activeCount).toBe(1);
  expect(final.socketState).toBe("connected");
  expect(final.acceptingInput).toBe(true);
  expect(final.pendingParserWrites).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
});
