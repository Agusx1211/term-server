import { test, expect } from "../fixtures/test.js";
import type { Page, TestInfo } from "@playwright/test";
import type { IsolatedServer, TranscriptEntry } from "../fixtures/test.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 60_000;
const BROWSER_HEIGHT = 800;
const INITIAL_BROWSER_WIDTH = 1_680;
const TARGET_COLUMNS = [120, 60, 100, 40] as const;
const BURST_BYTES = 131_072;
const BURST_LINE_WIDTH = 256;
const RESIZE_LATENCY_BUDGET_MS = 5_000;
const LONG_TASK_DURATION_BUDGET_MS = 1_000;
const LONG_TASK_COUNT_BUDGET = 20;
const METRICS_KEY = "__TERM_SERVER_E2E_V07_METRICS__";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type LayoutBaseline = {
  readonly browserWidth: number;
  readonly screenWidth: number;
  readonly cols: number;
  readonly chromeWidth: number;
  readonly cellWidth: number;
};

type ResizeWindow = {
  readonly start: number;
  readonly end: number;
  readonly latency: number;
};

type BrowserMetrics = {
  readonly supported: boolean;
  readonly longTasks: readonly { readonly startTime: number; readonly duration: number }[];
  readonly resizeWindows: readonly ResizeWindow[];
};

type ResizeResult = {
  readonly before: E2ETerminalSnapshot;
  readonly snapshot: E2ETerminalSnapshot;
  readonly signal: TranscriptEntry;
  readonly latency: number;
  readonly browserWidth: number;
};

function numericField(entry: TranscriptEntry, field: string): number | undefined {
  const value = entry[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function transcriptBoundary(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((maximum, entry) => Math.max(maximum, numericField(entry, "sequence") ?? 0), 0);
}

function eventBoundary(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.id), -1);
}

function countOccurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
}

function wrappedSegments(text: string, logicalLine: string): number {
  const compact = text.replace(/\n/g, "");
  const start = compact.indexOf(logicalLine);
  if (start < 0) throw new Error("the width-sensitive logical line is missing from the terminal model");
  const end = start + logicalLine.length;
  let logicalOffset = 0;
  let breaks = 0;
  for (const character of text) {
    if (character === "\n") {
      if (logicalOffset >= start && logicalOffset < end) breaks += 1;
    } else {
      logicalOffset += 1;
    }
  }
  return breaks + 1;
}

async function waitForSettledOutput(
  page: Page,
  terminalId: string,
  previousCommittedSequence: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previousCommittedSequence, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && (snapshot.committedSequence ?? -1) > previousCommittedSequence
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, previousCommittedSequence, timeout: WAIT_TIMEOUT_MS });
}

async function sendFixtureCommand(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  command: string,
  eventName: string,
  predicate: (entry: TranscriptEntry) => boolean,
): Promise<{ readonly transcript: TranscriptEntry; readonly snapshot: E2ETerminalSnapshot }> {
  const before = await pane.snapshot();
  if (!before) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  const transcript = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === eventName && predicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const settled = waitForSettledOutput(page, terminalId, before.committedSequence ?? -1);
  await pane.sendInput(command, true);
  const [transcriptEntry, snapshot] = await Promise.all([transcript, settled]);
  return { transcript: transcriptEntry, snapshot };
}

async function measureLayout(page: Page, pane: TerminalPanePage, snapshot: E2ETerminalSnapshot): Promise<LayoutBaseline> {
  const screen = pane.xtermHost.locator(".xterm-screen");
  const box = await screen.boundingBox();
  if (!box || box.width <= 0) throw new Error("terminal screen has no measurable width");
  const browserWidth = await page.evaluate(() => window.innerWidth);
  const cellWidth = box.width / snapshot.cols;
  if (!Number.isFinite(cellWidth) || cellWidth <= 0) throw new Error("terminal cell width is not measurable");
  return {
    browserWidth,
    screenWidth: box.width,
    cols: snapshot.cols,
    chromeWidth: browserWidth - box.width,
    cellWidth,
  };
}

function browserWidthForColumns(layout: LayoutBaseline, targetColumns: number): number {
  return Math.max(821, Math.round(layout.chromeWidth + layout.cellWidth * targetColumns));
}

async function installPerformanceMetrics(page: Page): Promise<number> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const longTasks: { startTime: number; duration: number }[] = [];
    const supported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    target[key] = { supported, longTasks, resizeWindows: [] as ResizeWindow[] };
    if (supported) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: "longtask", buffered: true });
      target[`${key}:observer`] = observer;
    }
    return longTasks.length;
  }, METRICS_KEY);
}

async function beginResizeMetric(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

async function finishResizeMetric(page: Page, start: number): Promise<number> {
  const end = await page.evaluate(() => performance.now());
  await page.evaluate(({ key, start, end }) => {
    const target = window as unknown as Record<string, unknown>;
    const metrics = target[key] as { resizeWindows?: ResizeWindow[] } | undefined;
    if (!metrics?.resizeWindows) throw new Error("V-07 performance metrics are unavailable");
    metrics.resizeWindows.push({ start, end, latency: end - start });
  }, { key: METRICS_KEY, start, end });
  return end - start;
}

async function readPerformanceMetrics(page: Page): Promise<BrowserMetrics> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const metrics = target[key] as BrowserMetrics | undefined;
    if (!metrics) throw new Error("V-07 performance metrics are unavailable");
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    return {
      supported: metrics.supported,
      longTasks: metrics.longTasks.map((entry) => ({ ...entry })),
      resizeWindows: metrics.resizeWindows.map((entry) => ({ ...entry })),
    };
  }, METRICS_KEY);
}

async function resizeToColumns(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  targetColumns: number,
  layout: LayoutBaseline,
  expectedRows: number,
): Promise<ResizeResult> {
  const before = await pane.snapshot();
  if (!before) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  const beforeEvents = await terminalEvents(page, terminalId);
  const beforeTranscript = await server.readTranscript(terminalId);
  const beforeEventId = eventBoundary(beforeEvents);
  const beforeTranscriptSequence = transcriptBoundary(beforeTranscript);
  let browserWidth = browserWidthForColumns(layout, targetColumns);
  const currentBrowserWidth = await page.evaluate(() => window.innerWidth);
  if (browserWidth === currentBrowserWidth) browserWidth += targetColumns >= before.cols ? 32 : -32;
  browserWidth = Math.max(821, browserWidth);

  const viewportEvent = page.evaluate(async ({ id, boundary, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > boundary
      && event.type === "viewport"
      && ["proposed", "sent"].includes(String(event.data["source"]))
    ), { timeout });
  }, { id: terminalId, boundary: beforeEventId, timeout: WAIT_TIMEOUT_MS });
  const converged = page.evaluate(async ({ id, previousCols, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.cols !== previousCols
      && snapshot.rows === rows
      && snapshot.desiredViewport?.cols === snapshot.cols
      && snapshot.desiredViewport?.rows === rows
      && snapshot.sentViewport?.cols === snapshot.cols
      && snapshot.sentViewport?.rows === rows
      && snapshot.serverViewport?.cols === snapshot.cols
      && snapshot.serverViewport?.rows === rows
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, previousCols: before.cols, rows: expectedRows, timeout: WAIT_TIMEOUT_MS });
  const signal = server.waitForTranscript(
    terminalId,
    (entry) => (
      (numericField(entry, "sequence") ?? 0) > beforeTranscriptSequence
      && entry.event === "sigwinch"
      && entry.source === "signal"
      && numericField(entry, "rows") === expectedRows
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const metricStart = await beginResizeMetric(page);
  await page.setViewportSize({ width: browserWidth, height: BROWSER_HEIGHT });
  const [, snapshot, ptySignal] = await Promise.all([viewportEvent, converged, signal]);
  const latency = await finishResizeMetric(page, metricStart);
  return { before, snapshot, signal: ptySignal, latency, browserWidth };
}

function expectWidthOnly(before: E2ETerminalSnapshot, after: E2ETerminalSnapshot): void {
  expect(after.cols).not.toBe(before.cols);
  expect(after.rows).toBe(before.rows);
  expect(after.pixelHeight).toBe(before.pixelHeight);
  for (const viewport of [after.proposedViewport, after.desiredViewport, after.sentViewport, after.serverViewport]) {
    if (!viewport) continue;
    expect(viewport.cols).toBe(after.cols);
    expect(viewport.rows).toBe(before.rows);
    expect(viewport.pixelHeight).toBe(before.pixelHeight);
  }
}

async function printAndCheckPixels(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  markerId: string,
  markerText: string,
  testInfo: TestInfo,
): Promise<TerminalPixelImage> {
  const before = await screenshotRegion(page, pane.xtermHost);
  const markerLine = `[E2E:PRINT:${markerId}:${markerText}]`;
  const result = await sendFixtureCommand(
    page,
    server,
    pane,
    terminalId,
    `PRINT ${markerId} ${markerText}`,
    "print",
    (entry) => entry.id === markerId && entry.text === markerText,
  );
  expect(result.transcript.text).toBe(markerText);
  await expectTerminalBuffer(page, terminalId, { contains: markerLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const after = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(before, after, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `${markerId}-changed-crop`,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: `${markerId}-terminal-crop`,
  });
  return after;
}

test("V-07 Width-only resize @p1 @nightly @resize", async ({ page, baseURL, server }, testInfo) => {
  await page.setViewportSize({ width: INITIAL_BROWSER_WIDTH, height: BROWSER_HEIGHT });
  await page.goto(baseURL);
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.sidebar.resizeWithKeyboard("max");
  await workbench.createTerminal();

  const paneLocator = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(paneLocator).toBeVisible();
  const terminalId = await paneLocator.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal has no stable terminal ID");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  const initial = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  expect(initial.socketState).toBe("connected");
  expect(initial.acceptingInput).toBe(true);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  expect(initial.serverViewport?.cols).toBe(initial.cols);

  const runToken = `${testInfo.testId}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `v07-${runToken}-ready`;
  const historyId = `v07-${runToken}-history`;
  const burstId = `v07-${runToken}-burst-0`;
  const historyText = `V07-LONG-${runToken}-${"0123456789abcdefghijklmnopqrstuvwxyz".repeat(24)}`;
  const historyLine = `[E2E:PRINT:${historyId}:${historyText}]`;

  await sendFixtureCommand(page, server, pane, terminalId, `READY ${readyId}`, "ready", (entry) => entry.id === readyId);
  await sendFixtureCommand(
    page,
    server,
    pane,
    terminalId,
    `PRINT ${historyId} ${historyText}`,
    "print",
    (entry) => entry.id === historyId && entry.text === historyText,
  );
  const firstBurst = await sendFixtureCommand(
    page,
    server,
    pane,
    terminalId,
    `BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`,
    "burst",
    (entry) => entry.id === burstId && numericField(entry, "bytes") === BURST_BYTES && numericField(entry, "line_width") === BURST_LINE_WIDTH,
  );
  expect(numericField(firstBurst.transcript, "bytes")).toBe(BURST_BYTES);
  expect(numericField(firstBurst.transcript, "line_width")).toBe(BURST_LINE_WIDTH);
  await expectTerminalBuffer(page, terminalId, { contains: historyLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const baselineSnapshot = firstBurst.snapshot;
  expect(baselineSnapshot.cursorX).toBe(BURST_LINE_WIDTH % baselineSnapshot.cols);
  expect(countOccurrences(baselineSnapshot.xterm.text.replace(/\n/g, ""), historyLine)).toBe(1);
  const baselineSegments = wrappedSegments(baselineSnapshot.xterm.text, historyLine);
  expect(baselineSegments).toBeGreaterThan(1);
  const layout = await measureLayout(page, pane, baselineSnapshot);
  const baselineRows = baselineSnapshot.rows;
  const baselinePixelHeight = baselineSnapshot.pixelHeight;
  const baselineLongTasks = await installPerformanceMetrics(page);
  const resizeResults: ResizeResult[] = [];
  const markerImages: TerminalPixelImage[] = [];
  let previousSegments = baselineSegments;
  let previousCols = baselineSnapshot.cols;

  for (const [index, targetColumns] of TARGET_COLUMNS.entries()) {
    if (index > 0) {
      const burstIdForWidth = `v07-${runToken}-burst-${index}`;
      const burst = await sendFixtureCommand(
        page,
        server,
        pane,
        terminalId,
        `BURST ${burstIdForWidth} ${BURST_BYTES} ${BURST_LINE_WIDTH}`,
        "burst",
        (entry) => entry.id === burstIdForWidth
          && numericField(entry, "bytes") === BURST_BYTES
          && numericField(entry, "line_width") === BURST_LINE_WIDTH,
      );
      expect(burst.snapshot.cursorX).toBe(BURST_LINE_WIDTH % previousCols);
    }

    const resize = await resizeToColumns(page, server, pane, terminalId, targetColumns, layout, baselineRows);
    resizeResults.push(resize);
    expect(resize.latency).toBeGreaterThan(0);
    expect(resize.latency).toBeLessThanOrEqual(RESIZE_LATENCY_BUDGET_MS);
    expect(resize.browserWidth).toBeGreaterThan(820);
    expect(await page.evaluate(() => window.innerHeight)).toBe(BROWSER_HEIGHT);
    expectWidthOnly(resize.before, resize.snapshot);
    expect(resize.snapshot.rows).toBe(baselineRows);
    expect(resize.snapshot.pixelHeight).toBe(baselinePixelHeight);
    expect(resize.snapshot.cursorX).toBe(BURST_LINE_WIDTH % resize.snapshot.cols);
    expect(Math.abs(resize.snapshot.cols - targetColumns)).toBeLessThanOrEqual(2);
    if (targetColumns < previousCols) expect(resize.snapshot.cols).toBeLessThan(previousCols);
    else expect(resize.snapshot.cols).toBeGreaterThan(previousCols);
    expect(numericField(resize.signal, "rows")).toBe(baselineRows);
    expect(numericField(resize.signal, "cols")).toBe(resize.snapshot.cols);

    const compact = resize.snapshot.xterm.text.replace(/\n/g, "");
    expect(countOccurrences(compact, historyLine)).toBe(1);
    const segments = wrappedSegments(resize.snapshot.xterm.text, historyLine);
    expect(segments).toBeGreaterThan(1);
    if (resize.snapshot.cols < previousCols) expect(segments).toBeGreaterThan(previousSegments);
    else expect(segments).toBeLessThan(previousSegments);
    previousSegments = segments;
    previousCols = resize.snapshot.cols;

    const widthId = `v07-${runToken}-width-${index}`;
    const winch = await sendFixtureCommand(
      page,
      server,
      pane,
      terminalId,
      `WINCH ${widthId} ${index + 1} ${baselineRows} ${resize.snapshot.cols}`,
      "sigwinch",
      (entry) => entry.id === widthId && entry.source === "command",
    );
    expect(winch.transcript.source).toBe("command");
    expect(numericField(winch.transcript, "actual_rows")).toBe(baselineRows);
    expect(numericField(winch.transcript, "actual_cols")).toBe(resize.snapshot.cols);
    expect(numericField(winch.transcript, "rows")).toBe(baselineRows);
    expect(numericField(winch.transcript, "cols")).toBe(resize.snapshot.cols);

    const sizeId = `v07-${runToken}-size-${index}`;
    const size = await sendFixtureCommand(
      page,
      server,
      pane,
      terminalId,
      `SIZE ${sizeId}`,
      "size",
      (entry) => entry.id === sizeId,
    );
    expect(numericField(size.transcript, "rows")).toBe(baselineRows);
    expect(numericField(size.transcript, "cols")).toBe(resize.snapshot.cols);

    const queryId = `v07-${runToken}-query-${index}`;
    const query = await sendFixtureCommand(
      page,
      server,
      pane,
      terminalId,
      `QUERY ${queryId}`,
      "query_complete",
      (entry) => entry.id === queryId,
    );
    expect(query.transcript.replies).toBe(4);
    const markerId = `v07-${runToken}-marker-${index}`;
    const markerText = `V07-W${resize.snapshot.cols}-${runToken}`;
    markerImages.push(await printAndCheckPixels(page, server, pane, terminalId, markerId, markerText, testInfo));
  }

  const echoId = `v07-${runToken}-echo`;
  await sendFixtureCommand(
    page,
    server,
    pane,
    terminalId,
    `ECHO_INPUT ${echoId}`,
    "echo_input",
    (entry) => entry.id === echoId && entry.phase === "armed",
  );
  const inputPayload = `V07-CONTINUED-INPUT-${runToken}`;
  const payload = await sendFixtureCommand(
    page,
    server,
    pane,
    terminalId,
    inputPayload,
    "echo_input",
    (entry) => entry.id === echoId && entry.phase === "payload",
  );
  expect(payload.transcript.payload_base64).toBe(Buffer.from(inputPayload, "utf8").toString("base64"));
  const encodedPayload = Buffer.from(inputPayload, "utf8").toString("base64");
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${echoId}:${encodedPayload}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const final = await pane.snapshot();
  if (!final) throw new Error(`No final diagnostics snapshot for terminal ${terminalId}`);
  expect(final.socketState).toBe("connected");
  expect(final.activeSocketCount).toBe(1);
  expect(final.socket.activeCount).toBe(1);
  expect(final.acceptingInput).toBe(true);
  expect(final.rows).toBe(baselineRows);
  expect(final.pixelHeight).toBe(baselinePixelHeight);
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  expect(final.syncTarget === undefined || final.committedSequence === undefined || final.committedSequence >= final.syncTarget).toBe(true);
  expect(markerImages).toHaveLength(TARGET_COLUMNS.length);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "v07-final-terminal-crop",
  });

  const metrics = await readPerformanceMetrics(page);
  expect(metrics.supported).toBe(true);
  expect(metrics.resizeWindows).toHaveLength(TARGET_COLUMNS.length);
  expect(metrics.longTasks.length).toBeGreaterThanOrEqual(baselineLongTasks);
  for (const window of metrics.resizeWindows) {
    expect(window.latency).toBeGreaterThan(0);
    expect(window.latency).toBeLessThanOrEqual(RESIZE_LATENCY_BUDGET_MS);
  }
  const resizeLongTasks = metrics.longTasks.filter((entry) => metrics.resizeWindows.some((window) => (
    entry.startTime < window.end && entry.startTime + entry.duration > window.start
  )));
  expect(resizeLongTasks.length).toBeLessThanOrEqual(LONG_TASK_COUNT_BUDGET);
  const longestResizeTask = resizeLongTasks.reduce((maximum, entry) => Math.max(maximum, entry.duration), 0);
  expect(longestResizeTask).toBeLessThanOrEqual(LONG_TASK_DURATION_BUDGET_MS);

  const events = await terminalEvents(page, terminalId);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  await assertMonotonicSequences(events);
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === historyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "burst" && numericField(entry, "bytes") === BURST_BYTES)).toHaveLength(TARGET_COLUMNS.length);
  expect(transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "command")).toHaveLength(TARGET_COLUMNS.length);
  expect(transcript.filter((entry) => entry.event === "size")).toHaveLength(TARGET_COLUMNS.length);
  expect(transcript.filter((entry) => entry.event === "query_complete" && entry.replies === 4)).toHaveLength(TARGET_COLUMNS.length);
  expect(transcript.filter((entry) => entry.event === "print" && String(entry.id).includes(`${runToken}-marker-`))).toHaveLength(TARGET_COLUMNS.length);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
});
