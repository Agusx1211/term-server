import { Buffer } from "node:buffer";
import { expect, test, type IsolatedServer } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import LoginPage from "../pages/login-page.js";
import TerminalPanePage from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  terminalEvents,
  terminalSnapshot,
  waitForTerminalEvent,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import type { Page, TestInfo } from "@playwright/test";

const WAIT_TIMEOUT_MS = 45_000;
const TRANSCRIPT_TIMEOUT_MS = 45_000;
const CACHE_LIMIT = 2;
const VISIBLE_ONLY_LIMIT = 1;
const TERMINAL_COUNT = 8;
const CHURN_CYCLES = 3;

type RendererResourceTracker = {
  isWebGLCanvas(canvas: HTMLCanvasElement): boolean;
};

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
  __TERM_SERVER_E2E_RENDERER_RESOURCES__?: RendererResourceTracker;
};

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
}

interface ChurnTerminal extends TerminalApiInfo {
  readonly readyId: string;
  readonly printId: string;
  readonly printText: string;
  readonly printLine: string;
}

interface RendererResources {
  readonly mountedPaneCount: number;
  readonly visiblePaneCount: number;
  readonly canvasCount: number;
  readonly attachedCanvasCount: number;
  readonly canvasPixels: number;
  readonly webglCanvasCount?: number;
  readonly diagnosticWebglContextCount: number;
}

interface SizeTranscriptEntry extends Record<string, unknown> {
  readonly event: string;
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
  readonly pixel_width?: number;
  readonly pixel_height?: number;
}

function safeMarker(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function marker(runTag: string, label: string): string {
  return `${runTag}-${label}`;
}

async function waitForMount(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, "mount", { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}


async function waitForCached(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.type === "visibility"
        && event.data.visible === false
        && event.snapshot.lifecycle.mounted
        && event.snapshot.lifecycle.cached
        && !event.snapshot.lifecycle.active
        && !event.snapshot.lifecycle.acceptingInput,
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForUnmount(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, "unmount", { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForInteractiveRendered(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.mounted
      && snapshot.visible
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.webglLoadCount >= 1
      && (snapshot.renderer === "webgl" || snapshot.fallbackCount > 0)
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.renderCount > 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRenderedMarker(
  page: Page,
  terminalId: string,
  markerText: string,
  previousRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, markerText: expectedMarker, renderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.mounted
      && snapshot.visible
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.renderCount > renderCount
      && snapshot.xterm.text.includes(expectedMarker)
    ), { timeout });
  }, { id: terminalId, markerText, renderCount: previousRenderCount, timeout: WAIT_TIMEOUT_MS });
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo | undefined> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    return terminals.find((terminal) => terminal.id === id);
  }, terminalId);
}

async function readRendererResources(page: Page): Promise<RendererResources> {
  return page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const tracker = (window as E2EWindow).__TERM_SERVER_E2E_RENDERER_RESOURCES__;
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".xterm-host canvas")];
    const diagnostics = api.terminals();
    return {
      mountedPaneCount: diagnostics.filter((snapshot) => snapshot.lifecycle.mounted).length,
      visiblePaneCount: diagnostics.filter((snapshot) => snapshot.lifecycle.visible).length,
      canvasCount: canvases.length,
      attachedCanvasCount: canvases.filter((canvas) => canvas.isConnected).length,
      canvasPixels: canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0),
      webglCanvasCount: tracker
        ? canvases.filter((canvas) => tracker.isWebGLCanvas(canvas)).length
        : undefined,
      diagnosticWebglContextCount: diagnostics.filter((snapshot) => (
        snapshot.lifecycle.mounted && snapshot.renderer === "webgl"
      )).length,
    } satisfies RendererResources;
  });
}

function assertNoResourceGrowth(
  baseline: RendererResources,
  current: RendererResources,
  phase: string,
): void {
  expect(current.mountedPaneCount, `${phase}: mounted pane count changed`).toBe(baseline.mountedPaneCount);
  expect(current.visiblePaneCount, `${phase}: visible pane count changed`).toBe(1);
  expect(current.canvasCount, `${phase}: stale canvas remained`).toBe(baseline.canvasCount);
  expect(current.attachedCanvasCount, `${phase}: detached canvas remained in resource count`).toBe(baseline.attachedCanvasCount);
  expect(current.canvasPixels, `${phase}: canvas backing pixels grew`).toBe(baseline.canvasPixels);
  expect(current.diagnosticWebglContextCount, `${phase}: diagnostic WebGL contexts grew`).toBe(
    baseline.diagnosticWebglContextCount,
  );
  if (baseline.webglCanvasCount !== undefined && current.webglCanvasCount !== undefined) {
    expect(current.webglCanvasCount, `${phase}: live WebGL canvas count changed`).toBe(baseline.webglCanvasCount);
  }
}

async function assertPtySize(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminal: ChurnTerminal,
  phase: string,
): Promise<E2ETerminalSnapshot> {
  const before = await pane.snapshot();
  if (!before) throw new Error(`R-10 ${phase}: diagnostics snapshot is unavailable`);
  const sizeId = `${terminal.id}-${phase}-SIZE`;
  const sizeWait = server.waitForTranscript<SizeTranscriptEntry>(
    terminal.id,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await sizeWait;
  expect(size.rows, `${phase}: fixture rows diverged from browser`).toBe(before.rows);
  expect(size.cols, `${phase}: fixture cols diverged from browser`).toBe(before.cols);
  if (size.pixel_width !== undefined) expect(size.pixel_width).toBe(before.pixelWidth);
  if (size.pixel_height !== undefined) expect(size.pixel_height).toBe(before.pixelHeight);
  await expectTerminalBuffer(page, terminal.id, {
    contains: `[E2E:SIZE:${sizeId}:`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  return expectTerminalConverged(page, terminal.id, {
    cols: before.cols,
    rows: before.rows,
    pixelWidth: before.pixelWidth,
    pixelHeight: before.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
}


async function initializeTerminal(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminal: ChurnTerminal,
  testInfo: TestInfo,
): Promise<E2ETerminalSnapshot> {
  const readyWait = server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "ready" && entry.id === terminal.readyId,
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  await pane.sendInput(`READY ${terminal.readyId}`, true);
  await readyWait;
  await expectTerminalBuffer(page, terminal.id, {
    contains: `[E2E:READY:${terminal.readyId}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  const before = await pane.snapshot();
  if (!before) throw new Error(`R-10 ${terminal.id}: missing snapshot before initial marker`);
  const rendered = waitForRenderedMarker(page, terminal.id, terminal.printLine, before.renderCount);
  const printWait = server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "print" && entry.id === terminal.printId && entry.text === terminal.printText,
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  await pane.sendInput(`PRINT ${terminal.printId} ${terminal.printText}`, true);
  await printWait;
  await expectTerminalBuffer(page, terminal.id, {
    contains: terminal.printLine,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const renderedSnapshot = await rendered;
  expect(renderedSnapshot.renderCount).toBeGreaterThan(before.renderCount);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: `r-10-${safeMarker(terminal.id)}-initial-nonblank`,
  });
  const afterPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforePixels, afterPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `r-10-${safeMarker(terminal.id)}-initial-marker`,
  });

  const converged = await assertPtySize(page, server, pane, terminal, "initial");
  const report = await expectConnectedTerminalInvariants(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
  expect(report.violations).toEqual([]);
  return converged;
}

async function openUnmountedTerminal(
  page: Page,
  workbench: WorkbenchPage,
  terminal: ChurnTerminal,
): Promise<{ pane: TerminalPanePage; mounted: E2ETerminalEvent; synchronized: E2ETerminalEvent; snapshot: E2ETerminalSnapshot }> {
  const mountedPromise = waitForMount(page, terminal.id);
  const synchronizedPromise = waitForTerminalEvent(page, terminal.id, "synced", { timeout: WAIT_TIMEOUT_MS });
  const renderedPromise = waitForInteractiveRendered(page, terminal.id);
  const pane = await workbench.openTerminal({ id: terminal.id, name: terminal.name });
  await pane.expectVisible();
  const [mounted, synchronized, snapshot] = await Promise.all([
    mountedPromise,
    synchronizedPromise,
    renderedPromise,
  ]);
  expect(mounted.terminalId).toBe(terminal.id);
  expect(synchronized.terminalId).toBe(terminal.id);
  expect(snapshot.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true });
  expect(snapshot.socketState).toBe("connected");
  expect(snapshot.activeSocketCount).toBe(1);
  expect(snapshot.socket.activeCount).toBe(1);
  expect(snapshot.rendererState.kind).toBe(snapshot.renderer);
  expect(snapshot.renderCount).toBeGreaterThan(0);
  return { pane, mounted, synchronized, snapshot };
}

async function assertRestoredTerminal(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminal: ChurnTerminal,
  testInfo: TestInfo,
  phase: string,
): Promise<E2ETerminalSnapshot> {
  await expectTerminalBuffer(page, terminal.id, {
    contains: terminal.printLine,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const snapshot = await expectTerminalInteractive(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
  expect(snapshot.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true });
  expect(snapshot.socketState).toBe("connected");
  expect(snapshot.activeSocketCount).toBe(1);
  expect(snapshot.socket.activeCount).toBe(1);
  expect(snapshot.rendererState.kind).toBe(snapshot.renderer);
  expect(snapshot.webglLoadCount).toBe(1);
  expect(snapshot.contextLossCount).toBe(0);
  expect(snapshot.fallbackCount).toBeLessThanOrEqual(1);
  expect(snapshot.renderCount).toBeGreaterThan(0);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: `r-10-${safeMarker(terminal.id)}-${phase}-nonblank`,
  });
  await assertPtySize(page, server, pane, terminal, phase);
  return snapshot;
}

test("@p1 @nightly @rendering @cache @churn @soak R-10 Renderer cache churn", async ({
  page,
  baseURL,
  server,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `R10-${safeMarker(testInfo.project.name)}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}`;

  await page.addInitScript(() => {
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    const webglCanvases = new WeakSet<HTMLCanvasElement>();
    HTMLCanvasElement.prototype.getContext = function patchedGetContext(
      this: HTMLCanvasElement,
      contextId: string,
      options?: unknown,
    ): unknown {
      const getContext = nativeGetContext as unknown as (
        id: string,
        attributes?: unknown,
      ) => unknown;
      const context = getContext.call(this, contextId, options);
      if (context && (contextId === "webgl" || contextId === "webgl2" || contextId === "experimental-webgl")) {
        webglCanvases.add(this);
      }
      return context;
    } as typeof HTMLCanvasElement.prototype.getContext;
    const target = window as E2EWindow;
    target.__TERM_SERVER_E2E_RENDERER_RESOURCES__ = {
      isWebGLCanvas: (canvas) => webglCanvases.has(canvas),
    };
  });

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const settings = await workbench.openSettings();
  await settings.setCachedTerminalLimit(CACHE_LIMIT);
  await expect(settings.root.getByRole("slider", {
    name: "Terminals kept alive off screen",
    exact: true,
  })).toHaveValue(String(CACHE_LIMIT));
  await workbench.closeSettings();

  const terminals: ChurnTerminal[] = [];
  let visibleTerminal: ChurnTerminal | undefined;
  let cachedTerminal: ChurnTerminal | undefined;

  for (let index = 0; index < TERMINAL_COUNT; index += 1) {
    const hiddenPromise = visibleTerminal ? waitForCached(page, visibleTerminal.id) : undefined;
    const evictedPromise = cachedTerminal ? waitForUnmount(page, cachedTerminal.id) : undefined;
    const createResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && url.pathname === "/api/terminals";
    });
    await workbench.createTerminal();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    const created = await createResponse.json() as { id: string; name: string };
    expect(created.id).not.toBe("");
    expect(created.name).not.toBe("");
    const mounted = await waitForMount(page, created.id);
    expect(mounted.terminalId).toBe(created.id);
    if (hiddenPromise) await hiddenPromise;
    if (evictedPromise) await evictedPromise;

    const terminalInfo = await readTerminal(page, created.id);
    if (!terminalInfo) throw new Error(`R-10 terminal ${created.id} disappeared after creation`);
    expect(terminalInfo.status).toBe("running");
    expect(terminalInfo.pid).toEqual(expect.any(Number));
    const readyId = marker(runTag, `TERMINAL-${index}-READY`);
    const printId = marker(runTag, `TERMINAL-${index}-PRINT`);
    const printText = marker(runTag, `TERMINAL-${index}-MARK`);
    const terminal: ChurnTerminal = {
      ...terminalInfo,
      readyId,
      printId,
      printText,
      printLine: `[E2E:PRINT:${printId}:${printText}]`,
    };
    const pane = workbench.terminal(terminal.id, terminal.name);
    await pane.expectVisible();
    const synchronized = waitForTerminalEvent(page, terminal.id, "synced", {
      timeout: WAIT_TIMEOUT_MS,
      afterId: 0,
    });
    const rendered = waitForInteractiveRendered(page, terminal.id);
    const [syncEvent, initialSnapshot] = await Promise.all([synchronized, rendered]);
    expect(syncEvent.terminalId).toBe(terminal.id);
    expect(initialSnapshot.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true });
    await initializeTerminal(page, server, pane, terminal, testInfo);

    terminals.push(terminal);
    cachedTerminal = visibleTerminal;
    visibleTerminal = terminal;
  }

  expect(terminals).toHaveLength(TERMINAL_COUNT);
  if (!visibleTerminal || !cachedTerminal) throw new Error("R-10 setup did not leave a visible and cached terminal");
  expect(await workbench.visiblePaneCount()).toBe(1);
  expect(await workbench.mountedPaneCount()).toBe(2);
  const baselineResources = await readRendererResources(page);
  expect(baselineResources.mountedPaneCount).toBe(2);
  expect(baselineResources.visiblePaneCount).toBe(1);
  expect(baselineResources.canvasCount).toBeGreaterThan(0);
  expect(baselineResources.attachedCanvasCount).toBe(baselineResources.canvasCount);
  expect(baselineResources.canvasPixels).toBeGreaterThan(0);
  expect(baselineResources.diagnosticWebglContextCount).toBeGreaterThanOrEqual(0);

  const initialCurrent = await terminalSnapshot(page, visibleTerminal.id);
  if (!initialCurrent) throw new Error("R-10 current terminal diagnostics disappeared before churn");
  expect(initialCurrent.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true });
  const processIds = new Map(terminals.map((terminal) => [terminal.id, terminal.pid]));
  const stableSnapshots: E2ETerminalSnapshot[] = [initialCurrent];
  const unmountedSnapshots: E2ETerminalSnapshot[] = [];

  for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
    const current: ChurnTerminal | undefined = visibleTerminal;
    const target = terminals[cycle * 2];
    const evictor = terminals[cycle * 2 + 1];
    if (!current || !target || !evictor) throw new Error(`R-10 cycle ${cycle} terminal selection is incomplete`);
    if (target.id === current.id || evictor.id === current.id || target.id === evictor.id) {
      throw new Error(`R-10 cycle ${cycle} terminal selection is not distinct`);
    }
    expect(await terminalSnapshot(page, target.id)).toBeUndefined();
    expect(await terminalSnapshot(page, evictor.id)).toBeUndefined();

    const churnId = marker(runTag, `CHURN-${cycle}`);
    const churnText = marker(runTag, `CHURN-${cycle}-MARK`);
    const churnLine = `[E2E:PRINT:${churnId}:${churnText}]`;
    const currentPane = workbench.terminal(current.id, current.name);
    await currentPane.expectVisible();
    const churnBefore = await currentPane.snapshot();
    if (!churnBefore) throw new Error(`R-10 cycle ${cycle}: current snapshot is unavailable before churn marker`);
    const churnRendered = waitForRenderedMarker(page, current.id, churnLine, churnBefore.renderCount);
    const churnPrint = server.waitForTranscript(
      current.id,
      (entry) => entry.event === "print" && entry.id === churnId && entry.text === churnText,
      { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
    );
    await currentPane.sendInput(`READY ${churnId}`, true);
    await server.waitForTranscript(
      current.id,
      (entry) => entry.event === "ready" && entry.id === churnId,
      { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
    );
    await currentPane.sendInput(`PRINT ${churnId} ${churnText}`, true);
    await churnPrint;
    await expectTerminalBuffer(page, current.id, { contains: churnLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await churnRendered;
    await expectTerminalNonBlank(page, currentPane.xtermHost, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: `r-10-${safeMarker(current.id)}-cycle-${cycle}-before-cache`,
    });

    const cachedCurrentPromise = waitForCached(page, current.id);
    const targetOpen = openUnmountedTerminal(page, workbench, target);
    const [cachedCurrent, targetMounted] = await Promise.all([
      cachedCurrentPromise,
      targetOpen,
    ]);
    expect(cachedCurrent.snapshot.lifecycle).toMatchObject({
      mounted: true,
      visible: false,
      cached: true,
      active: false,
      focused: false,
      acceptingInput: false,
    });
    expect(cachedCurrent.snapshot.activeSocketCount).toBe(1);
    expect(cachedCurrent.snapshot.socket.activeCount).toBe(1);
    const targetPane = targetMounted.pane;
    const targetSnapshot = await assertRestoredTerminal(page, server, targetPane, target, testInfo, `cycle-${cycle}-cached-target`);
    stableSnapshots.push(targetSnapshot);
    expect(targetSnapshot.xterm.text).toContain(target.printLine);
    assertNoResourceGrowth(baselineResources, await readRendererResources(page), `cycle ${cycle} cache`);

    const currentUnmountPromise = waitForUnmount(page, current.id);
    const targetCachedPromise = waitForCached(page, target.id);
    const evictorOpen = openUnmountedTerminal(page, workbench, evictor);
    const [currentUnmount, targetCached, evictorMounted] = await Promise.all([
      currentUnmountPromise,
      targetCachedPromise,
      evictorOpen,
    ]);
    expect(currentUnmount.type).toBe("unmount");
    expect(currentUnmount.snapshot.lifecycle).toMatchObject({
      mounted: false,
      visible: false,
      cached: true,
      active: false,
      focused: false,
      acceptingInput: false,
    });
    expect(currentUnmount.snapshot.activeSocketCount).toBe(0);
    expect(currentUnmount.snapshot.socket.activeCount).toBe(0);
    expect(currentUnmount.snapshot.socketState).not.toBe("connected");
    expect(currentUnmount.snapshot.socketState).not.toBe("connecting");
    expect(currentUnmount.snapshot.socketState).not.toBe("recovering");
    unmountedSnapshots.push(currentUnmount.snapshot);
    expect(targetCached.snapshot.lifecycle).toMatchObject({
      mounted: true,
      visible: false,
      cached: true,
      active: false,
      acceptingInput: false,
    });
    expect(targetCached.snapshot.activeSocketCount).toBe(1);
    const evictorPane = evictorMounted.pane;
    const evictorSnapshot = await assertRestoredTerminal(page, server, evictorPane, evictor, testInfo, `cycle-${cycle}-evictor`);
    stableSnapshots.push(evictorSnapshot);
    assertNoResourceGrowth(baselineResources, await readRendererResources(page), `cycle ${cycle} eviction`);

    const reopenedMount = openUnmountedTerminal(page, workbench, current);
    const evictorCachedPromise = waitForCached(page, evictor.id);
    const [reopened, evictorCached] = await Promise.all([reopenedMount, evictorCachedPromise]);
    expect(evictorCached.snapshot.lifecycle).toMatchObject({
      mounted: true,
      visible: false,
      cached: true,
      active: false,
      acceptingInput: false,
    });
    expect(evictorCached.snapshot.activeSocketCount).toBe(1);
    const reopenedSnapshot = await assertRestoredTerminal(
      page,
      server,
      reopened.pane,
      current,
      testInfo,
      `cycle-${cycle}-reopen`,
    );
    expect(reopenedSnapshot.xterm.text).toContain(churnLine);
    expect(reopenedSnapshot.xterm.text.match(new RegExp(`\\[E2E:PRINT:${safeMarker(churnId)}:`))).toHaveLength(1);
    stableSnapshots.push(reopenedSnapshot);
    assertNoResourceGrowth(baselineResources, await readRendererResources(page), `cycle ${cycle} reopen`);

    const events = await terminalEvents(page, current.id);
    expect(events[0]?.type).toBe("mount");
    expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(events.filter((event) => event.type === "renderer-load" || event.type === "renderer-fallback")).toHaveLength(1);
    assertNoPendingSynchronization(reopenedSnapshot);
    await expectConnectedTerminalInvariants(page, current.id, { timeout: WAIT_TIMEOUT_MS });

    const currentInfo = await readTerminal(page, current.id);
    expect(currentInfo?.pid).toBe(processIds.get(current.id));
    const targetInfo = await readTerminal(page, target.id);
    const evictorInfo = await readTerminal(page, evictor.id);
    expect(targetInfo?.pid).toBe(processIds.get(target.id));
    expect(evictorInfo?.pid).toBe(processIds.get(evictor.id));
    expect(await workbench.visiblePaneCount()).toBe(1);
    expect(await workbench.mountedPaneCount()).toBe(2);
    visibleTerminal = current;
    cachedTerminal = evictor;
  }

  const finalCurrent = visibleTerminal;
  const finalCached = cachedTerminal;
  if (!finalCurrent || !finalCached) throw new Error("R-10 final terminal state is incomplete");
  const finalPane = workbench.terminal(finalCurrent.id, finalCurrent.name);
  await finalPane.expectVisible();
  const echoId = marker(runTag, "FINAL-ECHO");
  const echoText = marker(runTag, "FINAL-CONTINUED-INPUT");
  const echoArm = server.waitForTranscript(
    finalCurrent.id,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  await finalPane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await echoArm;
  const echoLine = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;
  const finalBeforeEcho = await finalPane.snapshot();
  if (!finalBeforeEcho) throw new Error("R-10 final snapshot is unavailable before continued input");
  const echoRendered = waitForRenderedMarker(page, finalCurrent.id, echoLine, finalBeforeEcho.renderCount);
  const echoPayload = server.waitForTranscript(
    finalCurrent.id,
    (entry) => entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(echoText, "utf8").toString("base64"),
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  await finalPane.sendInput(echoText, true);
  const echoEntry = await echoPayload;
  expect(echoEntry.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, finalCurrent.id, { contains: echoLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await echoRendered;
  await expectTerminalNonBlank(page, finalPane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-10-final-continued-input",
  });
  const finalSnapshot = await assertPtySize(page, server, finalPane, finalCurrent, "final");
  expect(finalSnapshot.xterm.text).toContain(echoLine);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  assertNoPendingSynchronization(finalSnapshot);
  const finalReport = await expectConnectedTerminalInvariants(page, finalCurrent.id, { timeout: WAIT_TIMEOUT_MS });
  expect(finalReport.violations).toEqual([]);
  await assertMonotonicSequences(finalReport.events);

  const finalTranscript = await server.readTranscript(finalCurrent.id);
  expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
  for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
    const churnId = marker(runTag, `CHURN-${cycle}`);
    const churnText = marker(runTag, `CHURN-${cycle}-MARK`);
    expect(finalTranscript.filter((entry) => entry.event === "ready" && entry.id === churnId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === churnId && entry.text === churnText)).toHaveLength(1);
  }
  for (const terminal of terminals) {
    const transcript = await server.readTranscript(terminal.id);
    expect(transcript.filter((entry) => entry.event === "error"), `${terminal.id}: fixture reported an error`).toHaveLength(0);
    expect(transcript.filter((entry) => entry.event === "ready" && entry.id === terminal.readyId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === terminal.printId)).toHaveLength(1);
    const info = await readTerminal(page, terminal.id);
    expect(info?.pid, `${terminal.id}: PTY identity changed`).toBe(processIds.get(terminal.id));
  }

  const flushPromise = waitForUnmount(page, finalCached.id);
  const finalSettings = await workbench.openSettings();
  await finalSettings.setCachedTerminalLimit(VISIBLE_ONLY_LIMIT);
  await expect(finalSettings.root.getByRole("slider", {
    name: "Terminals kept alive off screen",
    exact: true,
  })).toHaveValue(String(VISIBLE_ONLY_LIMIT));
  await workbench.closeSettings();
  const flushed = await flushPromise;
  expect(flushed.snapshot.lifecycle.mounted).toBe(false);
  expect(flushed.snapshot.activeSocketCount).toBe(0);
  expect(flushed.snapshot.socket.activeCount).toBe(0);
  expect(flushed.snapshot.socketState).not.toBe("connected");
  const finalResources = await readRendererResources(page);
  expect(finalResources.mountedPaneCount).toBe(1);
  expect(finalResources.visiblePaneCount).toBe(1);
  expect(finalResources.canvasCount).toBeLessThan(baselineResources.canvasCount);
  expect(finalResources.attachedCanvasCount).toBe(finalResources.canvasCount);
  expect(finalResources.canvasPixels).toBeLessThanOrEqual(baselineResources.canvasPixels);
  expect(finalResources.diagnosticWebglContextCount).toBeLessThanOrEqual(baselineResources.diagnosticWebglContextCount);
  if (baselineResources.webglCanvasCount !== undefined && finalResources.webglCanvasCount !== undefined) {
    expect(finalResources.webglCanvasCount).toBeLessThanOrEqual(baselineResources.webglCanvasCount);
  }
  await expect(workbench.editorGrid.locator(
    `[data-terminal-id="${finalCached.id.replace(/["\\]/g, "\\$&")}"]`,
  )).toHaveCount(0);
  expect(await workbench.visiblePaneCount()).toBe(1);
  expect(await workbench.mountedPaneCount()).toBe(1);

  expect(stableSnapshots.every((snapshot) => snapshot.activeSocketCount <= 1)).toBe(true);
  expect(unmountedSnapshots.length).toBe(CHURN_CYCLES);
  expect(unmountedSnapshots.every((snapshot) => snapshot.activeSocketCount === 0)).toBe(true);
  const browserFailures = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /^error:/i.test(entry.message)
    || /unhandled(?:promise)?|uncaught/i.test(entry.message)
  ));
  expect(browserFailures).toEqual([]);
  expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);
});
