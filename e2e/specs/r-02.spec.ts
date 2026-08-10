import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.js";
import type { IsolatedServer } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalInteractive,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;
const FIXED_BROWSER_SIZE = { width: 1280, height: 800 };

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type ViewportTuple = {
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
};

interface CreatedTerminal {
  readonly id: string;
  readonly name: string;
}

function runMarker(testInfo: { workerIndex: number; parallelIndex: number; repeatEachIndex: number; retry: number }, label: string): string {
  return `R02-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}-${label}`;
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, needle.length);
  }
  return count;
}

function viewportTuple(value: unknown): ViewportTuple | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const cols = candidate.cols;
  const rows = candidate.rows;
  const pixelWidth = candidate.pixelWidth;
  const pixelHeight = candidate.pixelHeight;
  const isPositiveFiniteNumber = (entry: unknown): entry is number => (
    typeof entry === "number" && Number.isFinite(entry) && entry > 0
  );
  if (
    !isPositiveFiniteNumber(cols)
    || !isPositiveFiniteNumber(rows)
    || !isPositiveFiniteNumber(pixelWidth)
    || !isPositiveFiniteNumber(pixelHeight)
  ) {
    return undefined;
  }
  return {
    cols,
    rows,
    pixelWidth,
    pixelHeight,
  };
}

function tuplesEqual(first: ViewportTuple | undefined, second: ViewportTuple | undefined): boolean {
  return Boolean(first && second)
    && first!.cols === second!.cols
    && first!.rows === second!.rows
    && first!.pixelWidth === second!.pixelWidth
    && first!.pixelHeight === second!.pixelHeight;
}

function expectViewportTuple(value: unknown, expected: ViewportTuple): void {
  const actual = viewportTuple(value);
  expect(actual).toBeDefined();
  expect(actual).toEqual(expected);
}

async function waitForRendererOutcome(page: Page, terminalId: string, afterEventId: number): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after && (event.type === "renderer-load" || event.type === "renderer-fallback"),
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRendererEvent(
  page: Page,
  terminalId: string,
  type: "renderer-context-loss" | "renderer-fallback",
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, eventType, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after && event.type === eventType,
      { timeout },
    );
  }, { id: terminalId, eventType: type, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForViewportAfter(page: Page, terminalId: string, afterEventId: number): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => {
        if (event.id <= after || event.type !== "viewport") return false;
        const data = event.data as Record<string, unknown>;
        return data.source === "proposed"
          && [data.cols, data.rows, data.pixelWidth, data.pixelHeight]
            .every((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
      },
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForInitialTerminal(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const proposed = snapshot.proposedViewport;
      const server = snapshot.serverViewport;
      return snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.renderBacklogBytes === 0
        && proposed !== undefined
        && proposed.cols > 0
        && proposed.rows > 0
        && proposed.pixelWidth > 0
        && proposed.pixelHeight > 0
        && server !== undefined
        && server.cols > 0
        && server.rows > 0;
    }, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForViewportSettled(
  page: Page,
  terminalId: string,
  expected: ViewportTuple,
  requireServerViewport: boolean,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expectedViewport, requireServer, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const matches = (value: E2EViewport | undefined): boolean => value?.cols === expectedViewport.cols
      && value.rows === expectedViewport.rows
      && value.pixelWidth === expectedViewport.pixelWidth
      && value.pixelHeight === expectedViewport.pixelHeight;
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && matches(snapshot.proposedViewport)
      && (!requireServer || (
        matches(snapshot.desiredViewport)
        && matches(snapshot.sentViewport)
        && matches(snapshot.serverViewport)
      ))
    ), { timeout });
  }, {
    id: terminalId,
    expectedViewport: expected,
    requireServer: requireServerViewport,
    timeout: WAIT_TIMEOUT_MS,
  });
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

async function assertDimensionRefresh(
  page: Page,
  server: IsolatedServer,
  terminalId: string,
  before: E2ETerminalSnapshot,
  viewportEvent: E2ETerminalEvent,
  priorSigwinchCount: number,
  label: string,
): Promise<{ readonly snapshot: E2ETerminalSnapshot; readonly changed: boolean }> {
  const measured = viewportTuple(viewportEvent.data);
  if (!measured) throw new Error(`${label} viewport event did not carry positive dimensions`);
  const previous = viewportTuple(
    before.serverViewport
    ?? before.sentViewport
    ?? before.desiredViewport
    ?? before.proposedViewport,
  );
  if (!previous) throw new Error(`${label} did not have a positive pre-transition viewport`);
  const changed = !tuplesEqual(previous, measured);
  const settled = await waitForViewportSettled(page, terminalId, measured, changed);
  if (changed) {
    expect(before.gridEpoch).toBeDefined();
    expect(settled.gridEpoch).toBeDefined();
    expect(settled.gridEpoch!).toBeGreaterThan(before.gridEpoch!);
    expectViewportTuple(settled.desiredViewport, measured);
    expectViewportTuple(settled.sentViewport, measured);
    expectViewportTuple(settled.serverViewport, measured);
    await server.waitForTranscript(
      terminalId,
      (entry, entries) => entry.event === "sigwinch"
        && entry.rows === measured.rows
        && entry.cols === measured.cols
        && entries.filter((candidate) => candidate.event === "sigwinch").length > priorSigwinchCount,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
  } else {
    expectViewportTuple(settled.proposedViewport, measured);
    if (before.gridEpoch !== undefined && settled.gridEpoch !== undefined) {
      expect(settled.gridEpoch).toBe(before.gridEpoch);
    }
    const previousSent = viewportTuple(before.sentViewport);
    if (previousSent) expectViewportTuple(settled.sentViewport, previousSent);
    const previousServer = viewportTuple(before.serverViewport);
    if (previousServer) expectViewportTuple(settled.serverViewport, previousServer);
  }
  return { snapshot: settled, changed };
}

test("R-02 Renderer transition dimension refresh @p1 @nightly @rendering @transition @fallback", async ({ page, server }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.setViewportSize(FIXED_BROWSER_SIZE);
  await page.goto("/");
  const webglCapability = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  });
  testInfo.annotations.push({
    type: "webgl-capability",
    description: `available=${webglCapability}`,
  });

  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountEvent = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, WAIT_TIMEOUT_MS);
  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as CreatedTerminal;
  expect(created.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

  // Hold the real addon import so the initial DOM renderer can be measured and
  // exercised before the WebGL transition. The timer is a renderer lifecycle
  // control, not a test sleep; all progress below is event/barrier-driven.
  await page.evaluate(({ id }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.renderer.delayWebGL(id, 10_000);
  }, { id: created.id });

  const mounted = await mountEvent;
  expect(mounted.terminalId).toBe(created.id);
  const terminal = workbench.terminal(created.id, created.name);
  await terminal.expectVisible();
  const terminalContainer = terminal.xtermHost;
  const terminalViewport = terminalContainer.locator(".xterm-screen");
  await expect(terminalContainer).toBeVisible();
  await expect(terminalViewport).toBeVisible();
  const initialContainerBox = await terminalContainer.boundingBox();
  if (!initialContainerBox || initialContainerBox.width <= 0 || initialContainerBox.height <= 0) {
    throw new Error("terminal container has no measurable dimensions");
  }
  const initial = await waitForInitialTerminal(page, created.id);
  expect(initial.renderer).not.toBe("webgl");
  expect(initial.cols).toBe(initial.serverViewport?.cols);
  expect(initial.rows).toBe(initial.serverViewport?.rows);

  const readyId = runMarker(testInfo, "READY");
  const initialSizeId = runMarker(testInfo, "INITIAL-SIZE");
  const preId = runMarker(testInfo, "PRE");
  const webglId = runMarker(testInfo, "WEBGL");
  const fallbackId = runMarker(testInfo, "FALLBACK");
  const echoId = runMarker(testInfo, "ECHO");
  const inputMarker = runMarker(testInfo, "CONTINUED-INPUT");
  const sizeId = runMarker(testInfo, "FINAL-SIZE");
  const preText = runMarker(testInfo, "DOM-PIXELS");
  const webglText = runMarker(testInfo, "WEBGL-PIXELS");
  const fallbackText = runMarker(testInfo, "FALLBACK-PIXELS");
  const preLine = `[E2E:PRINT:${preId}:${preText}]`;
  const webglLine = `[E2E:PRINT:${webglId}:${webglText}]`;
  const fallbackLine = `[E2E:PRINT:${fallbackId}:${fallbackText}]`;

  await terminal.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: `[E2E:READY:${readyId}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await terminal.sendInput(`SIZE ${initialSizeId}`, true);
  const initialSize = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number }>(
    created.id,
    (entry) => entry.event === "size" && entry.id === initialSizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(initialSize.rows).toBe(initial.rows);
  expect(initialSize.cols).toBe(initial.cols);

  await terminal.sendInput(`PRINT ${preId} ${preText}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === preId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: preLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const prePixels = await screenshotRegion(page, terminalViewport);
  await expectTerminalNonBlank(page, terminalViewport, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-02-dom-before-webgl",
  });

  const beforeRendererEvents = await terminalEvents(page, created.id);
  const rendererCursor = beforeRendererEvents.at(-1)?.id ?? 0;
  const rendererOutcome = await waitForRendererOutcome(page, created.id, rendererCursor);
  const outcomeIsWebgl = rendererOutcome.type === "renderer-load" && rendererOutcome.snapshot.renderer === "webgl";
  testInfo.annotations.push({
    type: "webgl-transition",
    description: outcomeIsWebgl ? "executed" : "skipped: renderer did not activate WebGL",
  });

  let finalRenderer: "canvas" | "webgl" = "canvas";
  let transitionSnapshot = rendererOutcome.snapshot;
  let contextLossTransitionChanged = false;
  let webglBranchExecuted = false;

  if (outcomeIsWebgl) {
    webglBranchExecuted = true;
    expect(rendererOutcome.data.kind).toBe("webgl");
    expect(rendererOutcome.snapshot.webglLoadCount).toBe(1);
    expect(rendererOutcome.snapshot.fallbackCount).toBe(0);
    expect(rendererOutcome.snapshot.contextLossCount).toBe(0);
    const beforeWebgl = await terminal.snapshot();
    if (!beforeWebgl) throw new Error("missing diagnostics snapshot before WebGL refresh");
    const sigwinchCountBeforeWebgl = (await server.readTranscript(created.id)).filter((entry) => entry.event === "sigwinch").length;
    const webglViewportEvent = await waitForViewportAfter(page, created.id, rendererOutcome.id);
    const webglRefresh = await assertDimensionRefresh(
      page,
      server,
      created.id,
      beforeWebgl,
      webglViewportEvent,
      sigwinchCountBeforeWebgl,
      "WebGL load",
    );
    transitionSnapshot = webglRefresh.snapshot;
    expect(transitionSnapshot.renderer).toBe("webgl");
    expect(transitionSnapshot.webglLoadCount).toBe(1);
    expect(transitionSnapshot.contextLossCount).toBe(0);
    expect(transitionSnapshot.fallbackCount).toBe(0);

    const webglContainerBox = await terminalContainer.boundingBox();
    if (!webglContainerBox) throw new Error("terminal container disappeared after WebGL load");
    expect(webglContainerBox.width).toBe(initialContainerBox.width);
    expect(webglContainerBox.height).toBe(initialContainerBox.height);
    // Renderer activation may renegotiate the terminal grid. Capture the
    // post-settle dimensions before asserting a marker repaint; comparing
    // against the pre-transition crop would conflate a valid resize with
    // the marker's pixels.
    const webglBeforePixels = await screenshotRegion(page, terminalViewport);

    await terminal.sendInput(`PRINT ${webglId} ${webglText}`, true);
    await server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === webglId, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, created.id, { contains: webglLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const webglPixels = await screenshotRegion(page, terminalViewport);
    await expectTerminalPixelsChanged(webglBeforePixels, webglPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "r-02-webgl-marker",
    });
    await expectTerminalNonBlank(page, terminalViewport, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "r-02-webgl-compositor",
    });

    const beforeLoss = await terminal.snapshot();
    if (!beforeLoss) throw new Error("missing diagnostics snapshot before context loss");
    const lossEvents = await terminalEvents(page, created.id);
    const lossCursor = lossEvents.at(-1)?.id ?? 0;
    const sigwinchCountBeforeLoss = (await server.readTranscript(created.id)).filter((entry) => entry.event === "sigwinch").length;
    const lossEventPromise = waitForRendererEvent(page, created.id, "renderer-context-loss", lossCursor);
    const fallbackEventPromise = waitForRendererEvent(page, created.id, "renderer-fallback", lossCursor);
    const lossMode = await requestContextLoss(page, created.id);
    testInfo.annotations.push({
      type: "webgl-context-loss",
      description: lossMode === "requested" ? "executed" : "skipped: WEBGL_lose_context unavailable",
    });

    if (lossMode === "requested") {
      const lossEvent = await lossEventPromise;
      const fallbackEvent = await fallbackEventPromise;
      expect(lossEvent.type).toBe("renderer-context-loss");
      expect(fallbackEvent.type).toBe("renderer-fallback");
      expect(fallbackEvent.data.reason).toBe("context-loss");
      const lossViewportEvent = await waitForViewportAfter(page, created.id, fallbackEvent.id);
      const lossRefresh = await assertDimensionRefresh(
        page,
        server,
        created.id,
        beforeLoss,
        lossViewportEvent,
        sigwinchCountBeforeLoss,
        "WebGL context loss",
      );
      contextLossTransitionChanged = lossRefresh.changed;
      transitionSnapshot = lossRefresh.snapshot;
      expect(transitionSnapshot.renderer).toBe("canvas");
      expect(transitionSnapshot.webglLoadCount).toBe(1);
      expect(transitionSnapshot.contextLossCount).toBe(1);
      expect(transitionSnapshot.fallbackCount).toBe(1);
      finalRenderer = "canvas";

      const fallbackContainerBox = await terminalContainer.boundingBox();
      if (!fallbackContainerBox) throw new Error("terminal container disappeared after WebGL context loss");
      expect(fallbackContainerBox.width).toBe(initialContainerBox.width);
      expect(fallbackContainerBox.height).toBe(initialContainerBox.height);
      const fallbackBeforePixels = await screenshotRegion(page, terminalViewport);

      await terminal.sendInput(`PRINT ${fallbackId} ${fallbackText}`, true);
      await server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === fallbackId, { timeoutMs: WAIT_TIMEOUT_MS });
      await expectTerminalBuffer(page, created.id, { contains: fallbackLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
      const fallbackPixels = await screenshotRegion(page, terminalViewport);
      await expectTerminalPixelsChanged(fallbackBeforePixels, fallbackPixels, {
        minimumChangedRatio: 0.002,
        testInfo,
        artifactName: "r-02-fallback-marker",
      });
      await expectTerminalNonBlank(page, terminalViewport, {
        minimumNonBackgroundRatio: 0.002,
        testInfo,
        artifactName: "r-02-fallback-compositor",
      });
    } else {
      finalRenderer = "webgl";
      transitionSnapshot = await expectTerminalInteractive(page, created.id, { timeout: WAIT_TIMEOUT_MS });
      const unchangedContainerBox = await terminalContainer.boundingBox();
      if (!unchangedContainerBox) throw new Error("terminal container disappeared after skipped context loss");
      expect(unchangedContainerBox.width).toBe(initialContainerBox.width);
      expect(unchangedContainerBox.height).toBe(initialContainerBox.height);
      const postWebglBeforePixels = await screenshotRegion(page, terminalViewport);

      await terminal.sendInput(`PRINT ${fallbackId} ${fallbackText}`, true);
      await server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === fallbackId, { timeoutMs: WAIT_TIMEOUT_MS });
      await expectTerminalBuffer(page, created.id, { contains: fallbackLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
      const postWebglPixels = await screenshotRegion(page, terminalViewport);
      await expectTerminalPixelsChanged(postWebglBeforePixels, postWebglPixels, {
        minimumChangedRatio: 0.002,
        testInfo,
        artifactName: "r-02-post-webgl-marker",
      });
      await expectTerminalNonBlank(page, terminalViewport, {
        minimumNonBackgroundRatio: 0.002,
        testInfo,
        artifactName: "r-02-post-webgl-compositor",
      });
    }
  } else {
    expect(rendererOutcome.type).toBe("renderer-fallback");
    expect(rendererOutcome.snapshot.renderer).not.toBe("webgl");
    expect(rendererOutcome.snapshot.fallbackCount).toBe(1);
    expect(rendererOutcome.data.reason).toBe("load-failed");
    const fallbackContainerBox = await terminalContainer.boundingBox();
    if (!fallbackContainerBox) throw new Error("terminal container disappeared during fallback");
    expect(fallbackContainerBox.width).toBe(initialContainerBox.width);
    expect(fallbackContainerBox.height).toBe(initialContainerBox.height);
    const fallbackOnlyBeforePixels = await screenshotRegion(page, terminalViewport);
    await terminal.sendInput(`PRINT ${fallbackId} ${fallbackText}`, true);
    await server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === fallbackId, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, created.id, { contains: fallbackLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const fallbackPixels = await screenshotRegion(page, terminalViewport);
    await expectTerminalPixelsChanged(fallbackOnlyBeforePixels, fallbackPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "r-02-fallback-only-marker",
    });
    await expectTerminalNonBlank(page, terminalViewport, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "r-02-fallback-only-compositor",
    });
    transitionSnapshot = await expectTerminalInteractive(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  }

  const finalSizeWaiter = server.waitForTranscript<{ event: string; id: string; rows: number; cols: number }>(
    created.id,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(`SIZE ${sizeId}`, true);
  const finalSize = await finalSizeWaiter;
  const finalBeforeSize = await terminal.snapshot();
  if (!finalBeforeSize) throw new Error("missing diagnostics snapshot before final dimension check");
  expect(finalSize.rows).toBe(finalBeforeSize.rows);
  expect(finalSize.cols).toBe(finalBeforeSize.cols);
  expect(finalBeforeSize.serverViewport?.rows).toBe(finalBeforeSize.rows);
  expect(finalBeforeSize.serverViewport?.cols).toBe(finalBeforeSize.cols);
  expect(finalBeforeSize.pixelWidth).toBeGreaterThan(0);
  expect(finalBeforeSize.pixelHeight).toBeGreaterThan(0);

  const echoArmed = server.waitForTranscript(
    created.id,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
  await echoArmed;
  const echoPayload = server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
    created.id,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(inputMarker, true);
  const echoed = await echoPayload;
  expect(echoed.payload_base64).toBe(Buffer.from(inputMarker, "utf8").toString("base64"));

  await expectTerminalBuffer(page, created.id, { contains: `[E2E:ECHO_INPUT:${echoId}:`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const finalSnapshot = await expectTerminalInteractive(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  expect(finalSnapshot.renderer).toBe(finalRenderer);
  expect(finalSnapshot.webglLoadCount).toBe(1);
  expect(finalSnapshot.contextLossCount).toBe(finalRenderer === "canvas" && webglBranchExecuted ? 1 : 0);
  expect(finalSnapshot.fallbackCount).toBe(finalRenderer === "canvas" ? 1 : 0);
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.socketGeneration).toBe(initial.socketGeneration);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.syncTarget === undefined || finalSnapshot.committedSequence === undefined || finalSnapshot.committedSequence >= finalSnapshot.syncTarget).toBe(true);
  expect(finalSnapshot.cols).toBe(finalSize.cols);
  expect(finalSnapshot.rows).toBe(finalSize.rows);

  const finalText = finalSnapshot.xterm.text;
  expect(countOccurrences(finalText, preLine)).toBe(1);
  expect(countOccurrences(finalText, fallbackLine)).toBe(1);
  if (webglBranchExecuted) expect(countOccurrences(finalText, webglLine)).toBe(1);
  expect(countOccurrences(finalText, `[E2E:ECHO_INPUT:${echoId}:`)).toBe(1);
  const transcript = await server.readTranscript(created.id);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === preId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === fallbackId)).toHaveLength(1);
  if (webglBranchExecuted) expect(transcript.filter((entry) => entry.event === "print" && entry.id === webglId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);

  const events = await terminalEvents(page, created.id);
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "state" && ["disconnected", "recovering"].includes(String(event.data.state)))).toHaveLength(0);
  expect(events.filter((event) => event.type === "renderer-load")).toHaveLength(webglBranchExecuted ? 1 : 0);
  expect(events.filter((event) => event.type === "renderer-context-loss")).toHaveLength(contextLossTransitionChanged || (webglBranchExecuted && finalRenderer === "canvas") ? 1 : 0);
  expect(events.filter((event) => event.type === "renderer-fallback")).toHaveLength(finalRenderer === "canvas" ? 1 : 0);

  let previousWebglLoads = 0;
  let previousContextLosses = 0;
  let previousFallbacks = 0;
  for (const event of events) {
    expect(event.snapshot.webglLoadCount).toBeGreaterThanOrEqual(previousWebglLoads);
    expect(event.snapshot.contextLossCount).toBeGreaterThanOrEqual(previousContextLosses);
    expect(event.snapshot.fallbackCount).toBeGreaterThanOrEqual(previousFallbacks);
    previousWebglLoads = event.snapshot.webglLoadCount;
    previousContextLosses = event.snapshot.contextLossCount;
    previousFallbacks = event.snapshot.fallbackCount;
  }
  expect(transitionSnapshot.cols).toBeGreaterThan(0);
  expect(transitionSnapshot.rows).toBeGreaterThan(0);
  expect(transitionSnapshot.pixelWidth).toBeGreaterThan(0);
  expect(transitionSnapshot.pixelHeight).toBeGreaterThan(0);

  const invariantReport = await expectConnectedTerminalInvariants(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || /unhandled(?:promise)?|uncaught/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors, "renderer transition produced an unexpected browser error").toEqual([]);
  browserErrors.dispose();
});
