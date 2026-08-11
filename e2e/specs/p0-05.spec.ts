import { test, expect } from "../fixtures/test.js";
import type { Page, TestInfo } from "@playwright/test";
import { assertMonotonicSequences, terminalEvents } from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { E2ETerminalEvent, E2ETerminalSnapshot } from "../../src/client/lib/e2e-diagnostics.js";
import type { IsolatedServer, TranscriptEntry } from "../fixtures/test.js";

const BURST_BYTES = 2_000_000;
const BURST_LINE_WIDTH = 160;

// These are the release-regression budgets used when no CI override is supplied.
const RESIZE_LATENCY_BUDGET_MS = 5_000;
const RESPONSIVENESS_FRAME_BUDGET_MS = 1_000;
const LONG_TASK_DURATION_BUDGET_MS = 1_000;
const LONG_TASK_COUNT_BUDGET = 20;
const WAIT_TIMEOUT_MS = 60_000;
const METRICS_KEY = "__TERM_SERVER_E2E_P005_METRICS__";

type ResizeWindow = {
  readonly start: number;
  readonly end: number;
  readonly latency: number;
  readonly frameDelay: number;
};

type BrowserMetrics = {
  readonly supported: boolean;
  readonly longTasks: readonly { readonly startTime: number; readonly duration: number }[];
  readonly resizeWindows: readonly ResizeWindow[];
};

type ResizeResult = {
  readonly snapshot: E2ETerminalSnapshot;
  readonly ptySignal: TranscriptEntry;
};

type CommandResult = {
  readonly transcript: TranscriptEntry;
  readonly snapshot: E2ETerminalSnapshot;
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

async function waitForTranscriptAfter(
  server: IsolatedServer,
  terminalId: string,
  boundary: number,
  eventName: string,
  predicate: (entry: TranscriptEntry) => boolean = () => true,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(
    terminalId,
    (entry) => (numericField(entry, "sequence") ?? 0) > boundary && entry.event === eventName && predicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  boundary: number,
  eventName: E2ETerminalEvent["type"],
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, boundary, eventName, timeout }) => {
    const api = (window as Window & { __TERM_SERVER_E2E__?: {
      waitForEvent: (
        terminalId: string,
        predicate: (event: E2ETerminalEvent) => boolean,
        options?: { timeout?: number; afterId?: number },
      ) => Promise<E2ETerminalEvent>;
    } }).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.id > boundary && event.type === eventName, { timeout, afterId: boundary });
  }, { id: terminalId, boundary, eventName, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCommittedOutput(
  page: Page,
  terminalId: string,
  previousSequence: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previousSequence, timeout }) => {
    const api = (window as Window & { __TERM_SERVER_E2E__?: {
      waitForTerminal: (
        terminalId: string,
        predicate: (snapshot: E2ETerminalSnapshot) => boolean,
        options?: { timeout?: number },
      ) => Promise<E2ETerminalSnapshot>;
    } }).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && (snapshot.committedSequence ?? -1) > previousSequence
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout });
  }, { id: terminalId, previousSequence, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCommittedSequence(
  page: Page,
  terminalId: string,
  minimumSequence: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimum, timeout }) => {
    const api = (window as Window & { __TERM_SERVER_E2E__?: {
      waitForTerminal: (
        terminalId: string,
        predicate: (snapshot: E2ETerminalSnapshot) => boolean,
        options?: { timeout?: number },
      ) => Promise<E2ETerminalSnapshot>;
    } }).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && (snapshot.committedSequence ?? -1) >= minimum
      && snapshot.receivedSequence === snapshot.committedSequence
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
}

async function issueCommand(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  command: string,
  transcriptEvent: string,
  predicate: (entry: TranscriptEntry) => boolean = () => true,
): Promise<CommandResult> {
  const [entries, beforeSnapshot] = await Promise.all([
    server.readTranscript(terminalId),
    pane.snapshot(),
  ]);
  const boundary = transcriptBoundary(entries);
  const previousSequence = beforeSnapshot?.committedSequence ?? -1;
  const transcript = waitForTranscriptAfter(server, terminalId, boundary, transcriptEvent, predicate);
  await pane.sendInput(command, true);
  const transcriptEntry = await transcript;
  const snapshot = await waitForCommittedOutput(page, terminalId, previousSequence);
  return { transcript: transcriptEntry, snapshot };
}

async function issueScrollbackBurst(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
): Promise<CommandResult> {
  const [entries, beforeSnapshot] = await Promise.all([
    server.readTranscript(terminalId),
    pane.snapshot(),
  ]);
  const previousSequence = beforeSnapshot?.committedSequence;
  if (previousSequence === undefined) throw new Error("terminal diagnostics omitted the pre-burst committed sequence");
  const boundary = transcriptBoundary(entries);
  const burstEntry = waitForTranscriptAfter(
    server,
    terminalId,
    boundary,
    "burst",
    (entry) => numericField(entry, "bytes") === BURST_BYTES
      && numericField(entry, "line_width") === BURST_LINE_WIDTH,
  );
  const completedWrite = waitForTranscriptAfter(
    server,
    terminalId,
    boundary,
    "write",
    (entry) => numericField(entry, "bytes") === BURST_BYTES,
  );
  await pane.sendInput(`BURST p005-scrollback ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
  const [transcript] = await Promise.all([burstEntry, completedWrite]);
  const snapshot = await waitForCommittedSequence(page, terminalId, previousSequence + BURST_BYTES);
  return { transcript, snapshot };
}

async function installPerformanceMetrics(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const longTasks: { startTime: number; duration: number }[] = [];
    const supported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const metrics = {
      supported,
      longTasks,
      resizeWindows: [] as ResizeWindow[],
      activeResizeStart: undefined as number | undefined,
    };
    target[key] = metrics;
    if (!supported) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
    target[`${key}:observer`] = observer;
  }, METRICS_KEY);
}

async function beginResizeMetric(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const metrics = (window as unknown as Record<string, unknown>)[key] as {
      activeResizeStart?: number;
      longTasks: { startTime: number; duration: number }[];
      resizeWindows: readonly ResizeWindow[];
    } | undefined;
    if (!metrics) throw new Error("P0-05 performance metrics are unavailable");
    // Discard setup and prior-command work before the first resize. Retain
    // observations for later windows so the final gate covers every resize.
    if (metrics.resizeWindows.length === 0) metrics.longTasks.length = 0;
    metrics.activeResizeStart = performance.now();
  }, METRICS_KEY);
}

async function finishResizeMetric(page: Page): Promise<number> {
  const frameDelay = await page.evaluate(() => new Promise<number>((resolve) => {
    const start = performance.now();
    requestAnimationFrame(() => resolve(performance.now() - start));
  }));
  await page.evaluate(({ key, frameDelay }) => {
    const target = window as unknown as Record<string, unknown>;
    const metrics = target[key] as {
      activeResizeStart?: number;
      resizeWindows: ResizeWindow[];
    } | undefined;
    if (!metrics || metrics.activeResizeStart === undefined) throw new Error("P0-05 resize metric was not started");
    const end = performance.now();
    metrics.resizeWindows.push({
      start: metrics.activeResizeStart,
      end,
      latency: end - metrics.activeResizeStart,
      frameDelay,
    });
    metrics.activeResizeStart = undefined;
  }, { key: METRICS_KEY, frameDelay });
  return frameDelay;
}

async function readPerformanceMetrics(page: Page): Promise<BrowserMetrics> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const metrics = target[key] as BrowserMetrics & { activeResizeStart?: number } | undefined;
    if (!metrics) throw new Error("P0-05 performance metrics are unavailable");
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    if (metrics.activeResizeStart !== undefined) throw new Error("P0-05 resize metric is still active");
    return {
      supported: metrics.supported,
      longTasks: metrics.longTasks.map((entry) => ({ ...entry })),
      resizeWindows: metrics.resizeWindows.map((window) => ({ ...window })),
    };
  }, METRICS_KEY);
}

async function resizeTo(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  width: number,
  height: number,
): Promise<ResizeResult> {
  const beforeSnapshot = await pane.snapshot();
  if (!beforeSnapshot) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  const [beforeEvents, beforeTranscript] = await Promise.all([
    pane.events(),
    server.readTranscript(terminalId),
  ]);
  const beforeEventId = eventBoundary(beforeEvents);
  const beforeTranscriptSequence = transcriptBoundary(beforeTranscript);

  await beginResizeMetric(page);
  await page.setViewportSize({ width, height });
  await waitForEventAfter(page, terminalId, beforeEventId, "viewport");

  const snapshot = await page.evaluate(async ({ id, previous, timeout }) => {
    const api = (window as Window & { __TERM_SERVER_E2E__?: {
      waitForTerminal: (
        terminalId: string,
        predicate: (snapshot: E2ETerminalSnapshot) => boolean,
        options?: { timeout?: number },
      ) => Promise<E2ETerminalSnapshot>;
    } }).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (current) => {
      const serverViewport = current.serverViewport;
      return current.socketState === "connected"
        && (current.cols !== previous.cols || current.rows !== previous.rows)
        && serverViewport !== undefined
        && serverViewport.cols === current.cols
        && serverViewport.rows === current.rows
        && current.pendingParserWrites === 0
        && current.renderBacklogBytes === 0;
    }, { timeout });
  }, { id: terminalId, previous: { cols: beforeSnapshot.cols, rows: beforeSnapshot.rows }, timeout: WAIT_TIMEOUT_MS });

  const ptySignal = await waitForTranscriptAfter(
    server,
    terminalId,
    beforeTranscriptSequence,
    "sigwinch",
    (entry) => entry.source === "signal"
      && numericField(entry, "rows") === snapshot.rows
      && numericField(entry, "cols") === snapshot.cols,
  );
  await finishResizeMetric(page);
  return { snapshot, ptySignal };
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
  if (start < 0) throw new Error("selected history line is missing from the diagnostics model");
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

function expectHistoryReflow(
  snapshot: E2ETerminalSnapshot,
  logicalLines: readonly string[],
): number {
  const compact = snapshot.xterm.text.replace(/\n/g, "");
  const segmentCounts = logicalLines.map((line) => {
    expect(countOccurrences(compact, line)).toBe(1);
    const segments = wrappedSegments(snapshot.xterm.text, line);
    expect(segments).toBeGreaterThan(1);
    return segments;
  });
  return Math.max(...segmentCounts);
}

async function expectSearchExactlyOnce(pane: TerminalPanePage, query: string): Promise<void> {
  await pane.searchScrollback(query);
  await expect(pane.root.locator(".terminal-search-results")).toHaveText("1/1");
  await pane.closeSearch();
}

async function printMarker(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  markerId: string,
  markerText: string,
  testInfo: TestInfo,
): Promise<{ readonly snapshot: E2ETerminalSnapshot; readonly before: TerminalPixelImage; readonly after: TerminalPixelImage }> {
  const before = await screenshotRegion(page, pane.xtermHost);
  const beforeEvents = await pane.events();
  const result = await issueCommand(
    page,
    server,
    pane,
    terminalId,
    `PRINT ${markerId} ${markerText}`,
    "print",
    (entry) => entry.id === markerId && entry.text === markerText,
  );
  await waitForEventAfter(page, terminalId, eventBoundary(beforeEvents), "render");
  const after = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(before, after, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `${markerId}-after`,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: `${markerId}-crop`,
  });
  return { snapshot: result.snapshot, before, after };
}

test("@p0 P0-05 Width resize with substantial scrollback", async ({ page, baseURL, server }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto(baseURL);
  await new LoginPage(page).login();
  await installPerformanceMetrics(page);

  const workbench = new WorkbenchPage(page);
  await workbench.createTerminal();
  const paneLocator = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(paneLocator).toBeVisible();
  const terminalId = await paneLocator.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal has no stable terminal ID");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await pane.expectConnected();
  const initial = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  expect(initial.socketState).toBe("connected");
  expect(initial.acceptingInput).toBe(true);

  const historyA = `P005_HISTORY_A_${"0123456789".repeat(80)}`;
  const historyB = `P005_HISTORY_B_${"9876543210".repeat(80)}`;
  const historyLineA = `[E2E:PRINT:p005-history-a:${historyA}]`;
  const historyLineB = `[E2E:PRINT:p005-history-b:${historyB}]`;

  await issueCommand(page, server, pane, terminalId, "READY p005-ready", "ready", (entry) => entry.id === "p005-ready");
  const burst = await issueScrollbackBurst(page, server, pane, terminalId);
  expect(numericField(burst.transcript, "bytes")).toBe(BURST_BYTES);
  expect(numericField(burst.transcript, "line_width")).toBe(BURST_LINE_WIDTH);
  expect(BURST_BYTES / BURST_LINE_WIDTH).toBeGreaterThan(10_000);

  await issueCommand(
    page,
    server,
    pane,
    terminalId,
    `PRINT p005-history-a ${historyA}`,
    "print",
    (entry) => entry.id === "p005-history-a" && entry.text === historyA,
  );
  const historyBResult = await issueCommand(
    page,
    server,
    pane,
    terminalId,
    `PRINT p005-history-b ${historyB}`,
    "print",
    (entry) => entry.id === "p005-history-b" && entry.text === historyB,
  );

  const preResizeHistorySegments = expectHistoryReflow(historyBResult.snapshot, [historyLineA, historyLineB]);
  expect(preResizeHistorySegments).toBeGreaterThan(1);

  const narrowResize = await resizeTo(page, server, pane, terminalId, 900, 650);
  const narrowMarker = await printMarker(
    page,
    server,
    pane,
    terminalId,
    "p005-narrow-marker",
    "NARROW_MARKER",
    testInfo,
  );
  const narrowHistorySegments = expectHistoryReflow(narrowMarker.snapshot, [historyLineA, historyLineB]);
  expect(narrowHistorySegments).toBeGreaterThan(preResizeHistorySegments);

  const wideResize = await resizeTo(page, server, pane, terminalId, 1_440, 850);
  const wideMarker = await printMarker(
    page,
    server,
    pane,
    terminalId,
    "p005-wide-marker",
    "WIDE_MARKER",
    testInfo,
  );
  const wideHistorySegments = expectHistoryReflow(wideMarker.snapshot, [historyLineA, historyLineB]);
  expect(wideHistorySegments).toBeLessThan(narrowHistorySegments);
  expect(wideMarker.snapshot.cols).toBeGreaterThan(narrowMarker.snapshot.cols);
  expect(wideMarker.snapshot.rows).toBeGreaterThan(narrowMarker.snapshot.rows);

  await expectSearchExactlyOnce(pane, "P005_HISTORY_A_");
  await expectSearchExactlyOnce(pane, "P005_HISTORY_B_");
  await expectSearchExactlyOnce(pane, "NARROW_MARKER");
  await expectSearchExactlyOnce(pane, "WIDE_MARKER");

  const echoId = "p005-continued-input";
  await issueCommand(
    page,
    server,
    pane,
    terminalId,
    `ECHO_INPUT ${echoId}`,
    "echo_input",
    (entry) => entry.id === echoId && entry.phase === "armed",
  );
  const payload = "p005-continued-input-payload";
  const payloadBase64 = Buffer.from(payload, "utf8").toString("base64");
  const payloadBefore = await server.readTranscript(terminalId);
  const payloadSnapshot = await pane.snapshot();
  const payloadBoundary = transcriptBoundary(payloadBefore);
  const payloadPreviousSequence = payloadSnapshot?.committedSequence ?? -1;
  const payloadTranscript = waitForTranscriptAfter(
    server,
    terminalId,
    payloadBoundary,
    "echo_input",
    (entry) => entry.id === echoId && entry.phase === "payload" && entry.payload_base64 === payloadBase64,
  );
  await pane.sendInput(payload, true);
  const payloadEntry = await payloadTranscript;
  await waitForCommittedOutput(page, terminalId, payloadPreviousSequence);
  await expectSearchExactlyOnce(pane, `ECHO_INPUT:${echoId}:${payloadBase64}`);
  expect(payloadEntry.phase).toBe("payload");

  const finalSnapshot = await pane.snapshot();
  if (!finalSnapshot) throw new Error(`No final diagnostics snapshot for terminal ${terminalId}`);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.syncTarget === undefined || finalSnapshot.committedSequence === undefined || finalSnapshot.committedSequence >= finalSnapshot.syncTarget).toBe(true);
  await assertMonotonicSequences(await terminalEvents(page, terminalId));

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === "p005-history-a")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === "p005-history-b")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === "p005-narrow-marker")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === "p005-wide-marker")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);

  expect(narrowResize.ptySignal.source).toBe("signal");
  expect(numericField(narrowResize.ptySignal, "cols")).toBe(narrowMarker.snapshot.cols);
  expect(numericField(narrowResize.ptySignal, "rows")).toBe(narrowMarker.snapshot.rows);
  expect(wideResize.ptySignal.source).toBe("signal");
  expect(numericField(wideResize.ptySignal, "cols")).toBe(wideMarker.snapshot.cols);
  expect(numericField(wideResize.ptySignal, "rows")).toBe(wideMarker.snapshot.rows);

  const metrics = await readPerformanceMetrics(page);
  expect(metrics.supported).toBe(true);
  expect(metrics.resizeWindows).toHaveLength(2);
  for (const window of metrics.resizeWindows) {
    expect(window.latency).toBeGreaterThan(0);
    expect(window.latency).toBeLessThanOrEqual(RESIZE_LATENCY_BUDGET_MS);
    expect(window.frameDelay).toBeLessThanOrEqual(RESPONSIVENESS_FRAME_BUDGET_MS);
  }
  const resizeLongTasks = metrics.longTasks.filter((entry) => metrics.resizeWindows.some((window) => (
    entry.startTime < window.end && entry.startTime + entry.duration > window.start
  )));
  expect(resizeLongTasks.length).toBeLessThanOrEqual(LONG_TASK_COUNT_BUDGET);
  const longestResizeTask = resizeLongTasks.reduce((maximum, entry) => Math.max(maximum, entry.duration), 0);
  expect(longestResizeTask).toBeLessThanOrEqual(LONG_TASK_DURATION_BUDGET_MS);

  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "p005-final-terminal-crop",
  });
  expect(browserErrors).toHaveLength(0);
});
