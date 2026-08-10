import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { test, expect, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  analyzePixels,
  attachPixelCrop,
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type { TerminalPanePage } from "../pages/terminal-pane.js";
import type { Download, Locator, Page, Response } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface CanvasEvidence {
  readonly present: boolean;
  readonly canvasCount: number;
  readonly width: number;
  readonly height: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
  readonly webgl: boolean;
  readonly loseContextExtension: boolean;
  readonly dataUrlState: "captured" | "unavailable";
  readonly dataUrlBytes: number;
  readonly dataUrlPrefix: string;
}

interface SettledInput {
  readonly output: E2ETerminalEvent;
  readonly parserCommit: E2ETerminalEvent;
  readonly rendered: E2ETerminalSnapshot;
}

interface DownloadedRecording {
  readonly format: string;
  readonly version: string;
  readonly events: readonly Record<string, unknown>[];
  readonly client: {
    readonly truncated: boolean;
    readonly events: readonly FrontendRecordingEvent[];
  };
}

interface FrontendRecordingEvent {
  readonly ts: number;
  readonly terminal: string;
  readonly event: Record<string, unknown>;
}

interface CanvasScreenshotSample {
  readonly width: number;
  readonly height: number;
  readonly dataUrlBytes: number;
  readonly dataUrlPrefix: string;
}

function runMarker(testInfo: { readonly project: { readonly name: string }; readonly workerIndex: number; readonly parallelIndex: number; readonly retry: number; readonly repeatEachIndex: number }): string {
  return `R12-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
}

function countOccurrences(text: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(marker, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, marker.length);
  }
  return count;
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEventType,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.id > after && event.type === eventType, { timeout });
  }, { id: terminalId, after: afterEventId, eventType: type, timeout: WAIT_TIMEOUT_MS });
}
async function waitForRendererReady(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.webglLoadCount > 0 || snapshot.fallbackCount > 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForContextLossFallback(
  page: Page,
  terminalId: string,
  before: E2ETerminalSnapshot,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, contextLossCount, fallbackCount, renderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.contextLossCount > contextLossCount
      && snapshot.fallbackCount > fallbackCount
      && snapshot.renderer !== "webgl"
      && snapshot.renderCount > renderCount
    ), { timeout });
  }, {
    id: terminalId,
    contextLossCount: before.contextLossCount,
    fallbackCount: before.fallbackCount,
    renderCount: before.renderCount,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForSettledRender(
  page: Page,
  terminalId: string,
  minimumRenderCount: number,
  marker: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimum, markerText, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > minimum
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.xterm.text.includes(markerText)
    ), { timeout });
  }, { id: terminalId, minimum: minimumRenderCount, markerText: marker, timeout: WAIT_TIMEOUT_MS });
}

async function driveAndSettle(
  page: Page,
  pane: TerminalPanePage,
  server: { waitForTranscript<T extends TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean, options?: { timeoutMs?: number }): Promise<T> },
  terminalId: string,
  command: string,
  marker: string,
  previous: E2ETerminalSnapshot,
  transcriptPredicate: (entry: TranscriptEntry) => boolean,
): Promise<SettledInput> {
  const events = await terminalEvents(page, terminalId);
  const floor = events.at(-1)?.id ?? 0;
  const outputPromise = waitForEventAfter(page, terminalId, floor, "output-received");
  const transcriptPromise = server.waitForTranscript(
    terminalId,
    (entry) => transcriptPredicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(command, true);
  await transcriptPromise;
  const output = await outputPromise;
  const parserCommit = await waitForEventAfter(page, terminalId, output.id, "parser-commit");
  const rendered = await waitForSettledRender(page, terminalId, previous.renderCount, marker);
  const settledEvents = await terminalEvents(page, terminalId);
  expect(settledEvents.some((event) => event.id > floor && event.type === "render")).toBe(true);
  await expectTerminalBuffer(page, terminalId, { contains: marker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  return { output, parserCommit, rendered };
}

async function readCanvasEvidence(target: Locator): Promise<CanvasEvidence> {
  return target.evaluate((host) => {
    const canvases = [...host.querySelectorAll<HTMLCanvasElement>("canvas")];
    const canvas = canvases[0];
    if (!canvas) {
      return {
        present: false,
        canvasCount: 0,
        width: 0,
        height: 0,
        cssWidth: 0,
        cssHeight: 0,
        dpr: window.devicePixelRatio || 1,
        webgl: false,
        loseContextExtension: false,
        dataUrlState: "unavailable" as const,
        dataUrlBytes: 0,
        dataUrlPrefix: "",
      };
    }
    const rect = canvas.getBoundingClientRect();
    const webglContext = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const loseContextExtension = Boolean(webglContext?.getExtension("WEBGL_lose_context"));
    let dataUrlState: CanvasEvidence["dataUrlState"] = "unavailable";
    let dataUrlBytes = 0;
    let dataUrlPrefix = "";
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const comma = dataUrl.indexOf(",");
      dataUrlPrefix = comma >= 0 ? dataUrl.slice(0, comma + 1) : dataUrl;
      if (comma >= 0) {
        try {
          dataUrlBytes = atob(dataUrl.slice(comma + 1)).length;
          dataUrlState = "captured";
        } catch {
          dataUrlState = "unavailable";
        }
      }
    } catch {
      dataUrlState = "unavailable";
    }
    return {
      present: true,
      canvasCount: canvases.length,
      width: canvas.width,
      height: canvas.height,
      cssWidth: rect.width,
      cssHeight: rect.height,
      dpr: window.devicePixelRatio || 1,
      webgl: Boolean(webglContext),
      loseContextExtension,
      dataUrlState,
      dataUrlBytes,
      dataUrlPrefix,
    };
  });
}

async function readDownloadedRecording(download: Download): Promise<DownloadedRecording> {
  const path = await download.path();
  let text: string;
  if (path) {
    text = await readFile(path, "utf8");
  } else {
    const stream = await download.createReadStream();
    if (!stream) throw new Error("debug recording download did not expose a file or stream");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    text = Buffer.concat(chunks).toString("utf8");
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const client = parsed.client as Record<string, unknown> | undefined;
  const events = parsed.events;
  const clientEvents = client?.events;
  if (!client || !Array.isArray(events) || !Array.isArray(clientEvents)) {
    throw new Error("debug recording export is missing server or client events");
  }
  return {
    format: String(parsed.format ?? ""),
    version: String(parsed.version ?? ""),
    events: events.filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === "object"),
    client: {
      truncated: client.truncated === true,
      events: clientEvents.filter((event): event is FrontendRecordingEvent => (
        Boolean(event)
        && typeof event === "object"
        && typeof (event as Record<string, unknown>).terminal === "string"
        && Boolean((event as Record<string, unknown>).event)
        && typeof (event as Record<string, unknown>).event === "object"
      )),
    },
  };
}

function canvasScreenshotSamples(
  events: readonly FrontendRecordingEvent[],
  terminalId: string,
): CanvasScreenshotSample[] {
  return events
    .filter((entry) => entry.terminal === terminalId && entry.event.type === "screenshot")
    .map((entry) => {
      const dataUrl = entry.event.dataUrl;
      const width = entry.event.width;
      const height = entry.event.height;
      if (typeof dataUrl !== "string" || typeof width !== "number" || typeof height !== "number") {
        throw new Error("debug recording screenshot sample is malformed");
      }
      const comma = dataUrl.indexOf(",");
      if (comma < 0 || !dataUrl.startsWith("data:image/png;base64,")) {
        throw new Error("debug recording screenshot sample is not a base64 PNG drawing-buffer sample");
      }
      const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
      return {
        width,
        height,
        dataUrlBytes: bytes.length,
        dataUrlPrefix: dataUrl.slice(0, comma + 1),
      };
    });
}

function renderLinesWithMarkers(
  events: readonly FrontendRecordingEvent[],
  terminalId: string,
  firstMarker: string,
  secondMarker: string,
): { readonly first: string[]; readonly second: string[]; readonly combined: string[] } {
  const renderEvents = events.filter((entry) => entry.terminal === terminalId && entry.event.type === "render");
  const linesFor = (entry: FrontendRecordingEvent): string[] => {
    const lines = entry.event.lines;
    if (!Array.isArray(lines)) throw new Error("debug recording render sample is missing lines");
    return lines.filter((line): line is string => typeof line === "string");
  };
  const first = renderEvents.find((entry) => linesFor(entry).join("\n").includes(firstMarker));
  const second = renderEvents.find((entry) => linesFor(entry).join("\n").includes(secondMarker));
  const combined = renderEvents.find((entry) => {
    const text = linesFor(entry).join("\n");
    return text.includes(firstMarker) && text.includes(secondMarker);
  });
  if (!first || !second || !combined) throw new Error("debug recording did not capture both rendered model markers");
  return {
    first: linesFor(first),
    second: linesFor(second),
    combined: linesFor(combined),
  };
}

function outputText(events: readonly Record<string, unknown>[]): string {
  return events
    .filter((event) => event.type === "output" && typeof event.data === "string")
    .map((event) => Buffer.from(event.data as string, "base64").toString("utf8"))
    .join("");
}

function clientOutputText(events: readonly FrontendRecordingEvent[], terminalId: string): string {
  return events
    .filter((entry) => entry.terminal === terminalId && entry.event.type === "output" && typeof entry.event.data === "string")
    .map((entry) => Buffer.from(entry.event.data as string, "base64").toString("utf8"))
    .join("");
}

function recordingResponse(page: Page, method: "POST" | "GET"): Promise<Response> {
  return page.waitForResponse((response) => (
    response.request().method() === method
    && new URL(response.url()).pathname === "/api/debug/recording"
  ));
}

async function waitForReadyAndSettle(
  page: Page,
  pane: TerminalPanePage,
  server: { waitForTranscript<T extends TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean, options?: { timeoutMs?: number }): Promise<T> },
  terminalId: string,
  readyId: string,
  readyMarker: string,
  previous: E2ETerminalSnapshot,
): Promise<SettledInput> {
  return driveAndSettle(
    page,
    pane,
    server,
    terminalId,
    `READY ${readyId}`,
    readyMarker,
    previous,
    (entry) => entry.event === "ready" && entry.id === readyId,
  );
}

test("R-12 Debug visual evidence validity @p1 @nightly @debug @visual-oracle @rendering", async ({ page, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.goto("/");
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const region = workbench.editorGrid.locator("[data-terminal-id]").first();
  await expect(region).toBeVisible();
  const terminalId = await region.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal did not expose a stable terminal ID");
  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();
  const synchronized = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  const rendererReady = await waitForRendererReady(page, terminalId);
  expect(rendererReady.socketState).toBe("connected");
  expect(rendererReady.activeSocketCount).toBe(1);
  expect(rendererReady.acceptingInput).toBe(true);
  expect(rendererReady.pendingParserWrites).toBe(0);
  expect(rendererReady.rendererState.kind).toBe(rendererReady.renderer);
  await expectTerminalConverged(page, terminalId, {
    cols: synchronized.cols,
    rows: synchronized.rows,
    pixelWidth: synchronized.pixelWidth,
    pixelHeight: synchronized.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });

  const runId = runMarker(testInfo);
  const readyId = `${runId}-READY`;
  const beforeId = `${runId}-COMPOSITOR`;
  const afterId = `${runId}-AFTER-LOSS`;
  const sizeId = `${runId}-SIZE`;
  const winchId = `${runId}-WINCH`;
  const echoId = `${runId}-ECHO`;
  const echoText = `${runId}-CONTINUED-INPUT`;
  const readyMarker = `[E2E:READY:${readyId}]`;
  const beforeText = `${runId}-VISIBLE-BEFORE-LOSS`;
  const beforeMarker = `[E2E:PRINT:${beforeId}:${beforeText}]`;
  const afterText = `${runId}-VISIBLE-AFTER-LOSS`;
  const afterMarker = `[E2E:PRINT:${afterId}:${afterText}]`;
  const echoMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;

  const settings = await workbench.openSettings();
  const startResponsePromise = recordingResponse(page, "POST");
  await settings.startRecording();
  const startResponse = await startResponsePromise;
  expect(startResponse.ok()).toBe(true);
  const startStatus = await startResponse.json() as { active?: unknown };
  expect(startStatus.active).toBe(true);
  await workbench.showTerminals();
  await pane.expectVisible();

  const initialPixels = await screenshotRegion(page, pane.xtermHost);
  const initialCanvas = await readCanvasEvidence(pane.xtermHost);
  expect(initialCanvas.present).toBe(true);
  expect(initialCanvas.width).toBeGreaterThan(0);
  expect(initialCanvas.height).toBeGreaterThan(0);
  expect(initialCanvas.cssWidth).toBeGreaterThan(0);
  expect(initialCanvas.cssHeight).toBeGreaterThan(0);
  expect(initialCanvas.width).toBe(Math.round(initialCanvas.cssWidth * initialCanvas.dpr));
  expect(initialCanvas.height).toBe(Math.round(initialCanvas.cssHeight * initialCanvas.dpr));

  const readyBefore = await pane.snapshot();
  if (!readyBefore) throw new Error(`missing diagnostics snapshot before READY for ${terminalId}`);
  const ready = await waitForReadyAndSettle(page, pane, server, terminalId, readyId, readyMarker, readyBefore);
  expect(ready.rendered.xterm.text).toContain(readyMarker);

  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  const beforeSnapshot = await pane.snapshot();
  if (!beforeSnapshot) throw new Error(`missing diagnostics snapshot before compositor marker for ${terminalId}`);
  const before = await driveAndSettle(
    page,
    pane,
    server,
    terminalId,
    `PRINT ${beforeId} ${beforeText}`,
    beforeMarker,
    beforeSnapshot,
    (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText,
  );
  const compositorBefore = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforePixels, compositorBefore, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "r-12-compositor-before-marker-changed",
  });
  const compositorBeforeAnalysis = analyzePixels(compositorBefore);
  expect(compositorBeforeAnalysis.nonBackgroundRatio).toBeGreaterThanOrEqual(0.002);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-12-compositor-before-marker-nonblank",
  });
  await attachPixelCrop(testInfo, "r-12-compositor-before-marker", compositorBefore);
  const canvasBeforeLoss = await readCanvasEvidence(pane.xtermHost);

  const pauseRule = faultController.pause("server-to-browser", { terminalId });
  await faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalId
    && event.direction === "server-to-browser"
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  const afterFloor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? 0;
  const afterOutputPromise = waitForEventAfter(page, terminalId, afterFloor, "output-received");
  const afterTranscriptPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === afterId && entry.text === afterText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`PRINT ${afterId} ${afterText}`, true);
  await afterTranscriptPromise;

  const canLoseDrawingBuffer = rendererReady.renderer === "webgl"
    && canvasBeforeLoss.webgl
    && canvasBeforeLoss.loseContextExtension;
  let lossEvent: E2ETerminalEvent | undefined;
  let fallbackEvent: E2ETerminalEvent | undefined;
  let afterLossSnapshot: E2ETerminalSnapshot;
  if (canLoseDrawingBuffer) {
    const lossPromise = waitForEventAfter(page, terminalId, afterFloor, "renderer-context-loss");
    const fallbackPromise = waitForEventAfter(page, terminalId, afterFloor, "renderer-fallback");
    const lossBefore = await pane.snapshot();
    if (!lossBefore) throw new Error(`missing diagnostics snapshot before WebGL context loss for ${terminalId}`);
    const lossStatePromise = waitForContextLossFallback(page, terminalId, lossBefore);
    await page.evaluate((id) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      api.controls.renderer.loseContext(id);
    }, terminalId);
    [lossEvent, fallbackEvent, afterLossSnapshot] = await Promise.all([
      lossPromise,
      fallbackPromise,
      lossStatePromise,
    ]);
    if (!lossEvent || !fallbackEvent) throw new Error(`renderer context loss did not produce diagnostics events for ${terminalId}`);
    expect(lossEvent.type).toBe("renderer-context-loss");
    expect(fallbackEvent.type).toBe("renderer-fallback");
    expect(fallbackEvent.data.reason).toBe("context-loss");
    expect(afterLossSnapshot.contextLossCount).toBe(lossBefore.contextLossCount + 1);
    expect(afterLossSnapshot.fallbackCount).toBe(lossBefore.fallbackCount + 1);
    expect(afterLossSnapshot.renderer).not.toBe("webgl");
  } else {
    testInfo.annotations.push({
      type: "webgl-context-loss-capability",
      description: rendererReady.renderer === "webgl"
        ? "WEBGL_lose_context is unavailable; retained model and compositor evidence"
        : "active renderer is already the built-in fallback; retained model and compositor evidence",
    });
    afterLossSnapshot = await pane.snapshot() ?? rendererReady;
  }

  const compositorDuringLoss = await screenshotRegion(page, pane.xtermHost);
  const canvasAfterLoss = await readCanvasEvidence(pane.xtermHost);
  const lossAnalysis = analyzePixels(compositorDuringLoss);
  expect(lossAnalysis.nonBackgroundRatio).toBeGreaterThanOrEqual(0.002);
  await attachPixelCrop(testInfo, "r-12-compositor-after-loss-before-release", compositorDuringLoss);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-12-compositor-after-loss-nonblank",
  });

  const resumedPromise = faultController.waitFor((event) => (
    event.type === "resumed"
    && event.terminalId === terminalId
    && event.direction === "server-to-browser"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  faultController.resume("server-to-browser", { terminalId });
  await resumedPromise;
  pauseRule.dispose();

  const afterOutput = await afterOutputPromise;
  const afterParserCommit = await waitForEventAfter(page, terminalId, afterOutput.id, "parser-commit");
  const afterRendered = await waitForSettledRender(page, terminalId, afterLossSnapshot.renderCount, afterMarker);
  const afterEvents = await terminalEvents(page, terminalId);
  expect(afterEvents.some((event) => event.id > afterFloor && event.type === "render")).toBe(true);
  await expectTerminalBuffer(page, terminalId, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  expect(afterOutput.type).toBe("output-received");
  expect(afterParserCommit.type).toBe("parser-commit");
  expect(afterRendered.xterm.text).toContain(afterMarker);

  const echoArmPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await echoArmPromise;
  const echoPayloadPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(echoText, true);
  const echoPayload = await echoPayloadPromise;
  expect(echoPayload.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, terminalId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const sizePromise = server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await sizePromise;
  const finalBeforeSize = await pane.snapshot();
  if (!finalBeforeSize) throw new Error(`missing diagnostics snapshot before SIZE assertion for ${terminalId}`);
  const sizeRows = Number(sizeEntry.rows);
  const sizeCols = Number(sizeEntry.cols);
  expect(sizeRows).toBe(finalBeforeSize.rows);
  expect(sizeCols).toBe(finalBeforeSize.cols);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:SIZE:${sizeId}:${sizeRows}:${sizeCols}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const winchPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sigwinch" && entry.id === winchId && entry.signal_sequence === 1,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`WINCH ${winchId} 1`, true);
  const winchEntry = await winchPromise;
  const winchRows = Number(winchEntry.rows);
  const winchCols = Number(winchEntry.cols);
  expect(winchRows).toBe(finalBeforeSize.rows);
  expect(winchCols).toBe(finalBeforeSize.cols);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:WINCH:${winchId}:1:${winchRows}:${winchCols}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const finalSnapshot = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.serverViewport?.cols).toBe(finalSnapshot.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(finalSnapshot.rows);
  expect(finalSnapshot.serverViewport?.pixelWidth).toBe(finalSnapshot.pixelWidth);
  expect(finalSnapshot.serverViewport?.pixelHeight).toBe(finalSnapshot.pixelHeight);
  expect(finalSnapshot.xterm.text).toContain(beforeMarker);
  expect(finalSnapshot.xterm.text).toContain(afterMarker);
  expect(finalSnapshot.xterm.text).toContain(echoMarker);

  const compositorAfter = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(compositorDuringLoss, compositorAfter, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "r-12-compositor-after-marker-changed",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-12-compositor-after-marker-nonblank",
  });
  await attachPixelCrop(testInfo, "r-12-compositor-after-marker", compositorAfter);

  const stopResponsePromise = recordingResponse(page, "POST");
  const settingsAfter = await workbench.openSettings();
  await settingsAfter.stopRecording();
  const stopResponse = await stopResponsePromise;
  expect(stopResponse.ok()).toBe(true);
  const stopStatus = await stopResponse.json() as { active?: unknown };
  expect(stopStatus.active).toBe(false);
  const exportResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/debug/recording/export"
  ));
  const downloadPromise = page.waitForEvent("download");
  await settingsAfter.downloadRecording();
  const [download, exportResponse] = await Promise.all([downloadPromise, exportResponsePromise]);
  expect(exportResponse.ok()).toBe(true);
  const recording = await readDownloadedRecording(download);
  expect(recording.format).toBe("term-server-debug-recording");
  expect(recording.version).toBe("1");
  expect(recording.client.truncated).toBe(false);

  const relevantClientEvents = recording.client.events.filter((entry) => entry.terminal === terminalId);
  expect(relevantClientEvents.length).toBeGreaterThan(0);
  const clientRawOutput = clientOutputText(recording.client.events, terminalId);
  expect(clientRawOutput).toContain(beforeMarker);
  expect(clientRawOutput).toContain(afterMarker);
  const serverRawOutput = outputText(recording.events);
  expect(serverRawOutput).toContain(beforeMarker);
  expect(serverRawOutput).toContain(afterMarker);

  const renderedLines = renderLinesWithMarkers(recording.client.events, terminalId, beforeMarker, afterMarker);
  expect(countOccurrences(renderedLines.first.join("\n"), beforeMarker)).toBe(1);
  expect(countOccurrences(renderedLines.second.join("\n"), afterMarker)).toBe(1);
  expect(countOccurrences(renderedLines.combined.join("\n"), beforeMarker)).toBe(1);
  expect(countOccurrences(renderedLines.combined.join("\n"), afterMarker)).toBe(1);

  const screenshotSamples = canvasScreenshotSamples(recording.client.events, terminalId);
  expect(screenshotSamples.length).toBeGreaterThan(0);
  expect(screenshotSamples.every((sample) => sample.dataUrlBytes > 0)).toBe(true);
  expect(screenshotSamples.some((sample) => (
    sample.width === canvasBeforeLoss.width && sample.height === canvasBeforeLoss.height
  ))).toBe(true);
  expect(canvasBeforeLoss.dataUrlState).toBe("captured");
  expect(canvasBeforeLoss.dataUrlBytes).toBeGreaterThan(0);
  expect(initialPixels.buffer.length).toBeGreaterThan(0);
  expect(compositorBefore.buffer.length).toBeGreaterThan(0);
  expect(compositorDuringLoss.buffer.length).toBeGreaterThan(0);
  expect(compositorAfter.buffer.length).toBeGreaterThan(0);
  expect(canvasAfterLoss.dataUrlState === "captured" || canvasAfterLoss.dataUrlState === "unavailable").toBe(true);
  await testInfo.attach("r-12-visual-evidence-comparison", {
    body: JSON.stringify({
      drawingBuffer: {
        beforeLoss: canvasBeforeLoss,
        afterLoss: canvasAfterLoss,
        samples: screenshotSamples,
      },
      compositor: {
        initial: { width: initialPixels.width, height: initialPixels.height, bytes: initialPixels.buffer.length },
        beforeMarker: { width: compositorBefore.width, height: compositorBefore.height, bytes: compositorBefore.buffer.length },
        duringLoss: { width: compositorDuringLoss.width, height: compositorDuringLoss.height, bytes: compositorDuringLoss.buffer.length },
        afterMarker: { width: compositorAfter.width, height: compositorAfter.height, bytes: compositorAfter.buffer.length },
      },
      model: {
        beforeMarker,
        afterMarker,
        renderLines: renderedLines.combined,
      },
    }, null, 2),
    contentType: "application/json",
  });

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === afterId && entry.text === afterText)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);

  const finalEvents = await terminalEvents(page, terminalId);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "output-received").length).toBeGreaterThanOrEqual(4);
  expect(finalEvents.filter((event) => event.type === "parser-commit").length).toBeGreaterThanOrEqual(4);
  expect(finalEvents.filter((event) => event.type === "render").length).toBeGreaterThan(0);
  if (canLoseDrawingBuffer) {
    expect(finalEvents.filter((event) => event.type === "renderer-context-loss")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "renderer-fallback")).toHaveLength(1);
    expect(lossEvent?.snapshot.contextLossCount).toBeGreaterThan(0);
    expect(fallbackEvent?.snapshot.fallbackCount).toBeGreaterThan(0);
  }
  const faultEvents = faultController.events.filter((event) => event.terminalId === terminalId && event.direction === "server-to-browser");
  expect(faultEvents.filter((event) => event.type === "paused")).toHaveLength(1);
  expect(faultEvents.filter((event) => event.type === "resumed")).toHaveLength(1);

  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  await assertMonotonicSequences(invariantReport.events);
  expect(finalSnapshot.renderCount).toBeGreaterThan(before.rendered.renderCount);
  expect(finalSnapshot.renderCount).toBeGreaterThan(afterRendered.renderCount);
  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || (entry.kind === "console" && /^error:/i.test(entry.message))
    || /unhandled(?:promise)?|uncaught/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
  browserErrors.dispose();
});
