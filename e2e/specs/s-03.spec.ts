import type { Page, TestInfo } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  assertMonotonicSequences,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import { assertNoPendingSynchronization, expectTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import LoginPage from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 180_000;
const SCROLLBACK_TIERS = [1_000, 10_000, 50_000, 200_000] as const;
const BURST_LINE_WIDTH = 128;
const REPLAY_BUDGET_BYTES = 64 * 1024 * 1024;
const CHECKPOINT_BUDGET_BYTES = 4 * 1024 * 1024;
const PERFORMANCE_KEY = "__TERM_SERVER_E2E_S03_PERFORMANCE__";
const SEED = "0x5103";
const GEOMETRIES = [
  { width: 1_280, height: 900 },
  { width: 640, height: 700 },
  { width: 1_600, height: 900 },
  { width: 900, height: 500 },
  { width: 1_280, height: 900 },
] as const;

test.setTimeout(35 * 60 * 1_000);

type E2EWindow = Window & { __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi };

type PerformanceEntrySample = {
  readonly startTime: number;
  readonly duration: number;
};

type ResizeWindow = {
  readonly geometryIndex: number;
  readonly start: number;
  readonly end: number;
  readonly latencyMs: number;
  readonly frameDelayMs: number;
};

type PerformanceMetrics = {
  readonly supported: boolean;
  readonly startTime: number;
  readonly endTime: number;
  readonly heapStartBytes?: number;
  readonly heapEndBytes?: number;
  readonly longTasks: readonly PerformanceEntrySample[];
  readonly resizeWindows: readonly ResizeWindow[];
};

type RuntimeConfig = {
  readonly scrollbackLines: number;
  readonly maxPanes: number;
  readonly cachedTerminals: number;
};

type CreatedTerminal = {
  readonly id: string;
  readonly name: string;
  readonly pane: TerminalPanePage;
};

type OutputCommandResult = {
  readonly event: TranscriptEntry;
  readonly write: TranscriptEntry;
  readonly snapshot: E2ETerminalSnapshot;
  readonly sequence: number;
  readonly bytes: number;
};

type ResizeSample = {
  readonly geometryIndex: number;
  readonly target: { readonly width: number; readonly height: number };
  readonly latencyMs: number;
  readonly frameDelayMs: number;
  readonly parserPendingBytes: number;
  readonly parserPendingWrites: number;
  readonly renderBacklogBytes: number;
  readonly renderBacklogFrames: number;
  readonly renderBacklogOldestAgeMs: number;
  readonly longTaskCount: number;
  readonly maxLongTaskDurationMs: number;
  readonly heapUsedBytes?: number;
  readonly serverGridEpoch: number;
  readonly serverReflowTimeMs: number;
  readonly browser: {
    readonly cols: number;
    readonly rows: number;
    readonly pixelWidth: number;
    readonly pixelHeight: number;
  };
  readonly server: {
    readonly cols: number;
    readonly rows: number;
    readonly pixelWidth: number;
    readonly pixelHeight: number;
  };
  readonly pty: {
    readonly cols: number;
    readonly rows: number;
  };
};

type CaseMetrics = {
  readonly lines: number;
  readonly burstBytes: number;
  readonly burstNewlineCount: number;
  readonly expectedBurstNewlineCount: number;
  readonly replayBudgetBytes: number;
  readonly checkpointBudgetBytes: number;
  readonly checkpoint: {
    readonly sequence: number;
    readonly epoch: number;
    readonly size: number;
    readonly chunks: number;
    readonly serializationDurationMs: number;
    readonly uploadDurationMs: number;
    readonly result: string;
  };
  readonly resizeLatencyDistributionMs: readonly number[];
  readonly resizeLatencyP50Ms: number;
  readonly resizeLatencyP95Ms: number;
  readonly resizeLatencyMaxMs: number;
  readonly responsivenessDistributionMs: readonly number[];
  readonly responsivenessP50Ms: number;
  readonly responsivenessP95Ms: number;
  readonly responsivenessMaxMs: number;
  readonly longTaskCount: number;
  readonly maxLongTaskDurationMs: number;
  readonly longTaskSupported: boolean;
  readonly heapStartBytes?: number;
  readonly heapEndBytes?: number;
  readonly parserPendingBytesMax: number;
  readonly parserPendingWritesMax: number;
  readonly renderBacklogBytesMax: number;
  readonly renderBacklogFramesMax: number;
  readonly renderBacklogOldestAgeMsMax: number;
  readonly inputRoundTripMs: number;
  readonly final: {
    readonly browser: ResizeSample["browser"];
    readonly server: ResizeSample["server"];
    readonly pty: ResizeSample["pty"];
    readonly gridEpoch: number;
    readonly committedSequence: number;
  };
  readonly resizes: readonly ResizeSample[];
};

function runTag(testInfo: TestInfo): string {
  return [
    "S03",
    SEED,
    testInfo.project.name,
    testInfo.workerIndex,
    testInfo.parallelIndex,
    testInfo.repeatEachIndex,
    testInfo.retry,
  ].join("-").replace(/[^A-Za-z0-9_-]+/g, "-");
}

function numberField(entry: TranscriptEntry | E2ETerminalEvent, field: string): number | undefined {
  let raw: unknown;
  if ("data" in entry && entry.data !== null && typeof entry.data === "object") {
    raw = (entry.data as Record<string, unknown>)[field];
  } else if ("event" in entry) {
    raw = entry[field];
  } else {
    raw = undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function requiredNumber(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${description} is not a finite number`);
  return value;
}

function transcriptBoundary(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((maximum, entry) => Math.max(maximum, numberField(entry, "sequence") ?? 0), 0);
}

function transcriptWriteBytes(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((total, entry) => (
    entry.event === "write" ? total + requiredNumber(entry.bytes, "fixture write bytes") : total
  ), 0);
}

function percentile(values: readonly number[], rank: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function countNewlines(data: Buffer): number {
  let count = 0;
  for (const byte of data) if (byte === 0x0a) count += 1;
  return count;
}

/** Mirrors the fixture's exact burst_bytes loop, including its no-trailing-newline rule. */
function expectedBurstNewlineCount(bytes: number, lineWidth: number): number {
  if (bytes <= lineWidth + 1) return 0;
  return Math.floor((bytes - lineWidth - 2) / (lineWidth + 1)) + 1;
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
    (entry) => (numberField(entry, "sequence") ?? 0) > boundary
      && entry.event === eventName
      && predicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}


async function waitForEventTypeAfter(
  page: Page,
  terminalId: string,
  boundary: number,
  type: E2ETerminalEvent["type"],
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, floor, eventType, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.id > floor && event.type === eventType, { timeout, afterId: floor });
  }, { id: terminalId, floor: boundary, eventType: type, timeout: WAIT_TIMEOUT_MS });
}

async function waitForParserCommit(
  page: Page,
  terminalId: string,
  boundary: number,
  minimumSequence: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, floor, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.id > floor
      && event.type === "parser-commit"
      && typeof event.data.sequence === "number"
      && event.data.sequence >= minimum, { timeout, afterId: floor });
  }, { id: terminalId, floor: boundary, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  minimumSequence: number,
  dimensions?: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimum, expected, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.serverViewport;
      return snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.receivedSequence !== undefined
        && snapshot.committedSequence !== undefined
        && snapshot.receivedSequence >= minimum
        && snapshot.committedSequence >= minimum
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
        && (snapshot.syncTarget === undefined || snapshot.committedSequence >= snapshot.syncTarget)
        && (expected === undefined || (
          viewport !== undefined
          && snapshot.cols === expected.cols
          && snapshot.rows === expected.rows
          && viewport.cols === expected.cols
          && viewport.rows === expected.rows
        ));
    }, { timeout });
  }, { id: terminalId, minimum: minimumSequence, expected: dimensions, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForResizeSelection(
  page: Page,
  terminalId: string,
  before: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previous, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      const selected = snapshot.serverViewport;
      return snapshot.socketState === "connected"
        && desired !== undefined
        && selected !== undefined
        && selected.cols === desired.cols
        && selected.rows === desired.rows
        && selected.cols !== previous.cols
        && selected.rows !== previous.rows
        && snapshot.pendingParserWrites === 0
        && snapshot.renderBacklogBytes === 0;
    }, { timeout });
  }, { id: terminalId, previous: before, timeout: WAIT_TIMEOUT_MS });
}

async function waitForResizeSizeEvent(
  page: Page,
  terminalId: string,
  boundary: number,
  before: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, floor, previous, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      const cols = event.data.cols;
      const rows = event.data.rows;
      return event.id > floor
        && event.type === "size"
        && typeof cols === "number"
        && typeof rows === "number"
        && (cols !== previous.cols || rows !== previous.rows);
    }, { timeout, afterId: floor });
  }, { id: terminalId, floor: boundary, previous: before, timeout: WAIT_TIMEOUT_MS });
}
async function waitForCheckpoint(
  page: Page,
  terminalId: string,
  afterEventId: number,
  minimumSequence: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "checkpoint"
      && event.data.result === "sent"
      && typeof event.data.sequence === "number"
      && event.data.sequence >= minimum
    ), { timeout, afterId: after });
  }, { id: terminalId, after: afterEventId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
}


async function readRuntimeConfig(page: Page): Promise<RuntimeConfig> {
  return page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`runtime config request failed with HTTP ${response.status}`);
    const config = await response.json() as Record<string, unknown>;
    const scrollbackLines = config.scrollbackLines;
    const maxPanes = config.maxPanes;
    const cachedTerminals = config.cachedTerminals;
    if (typeof scrollbackLines !== "number" || !Number.isSafeInteger(scrollbackLines)) {
      throw new Error("runtime config omitted a safe scrollback line count");
    }
    if (typeof maxPanes !== "number" || !Number.isSafeInteger(maxPanes)) {
      throw new Error("runtime config omitted a safe max pane count");
    }
    if (typeof cachedTerminals !== "number" || !Number.isSafeInteger(cachedTerminals)) {
      throw new Error("runtime config omitted a safe cached-terminal count");
    }
    return { scrollbackLines, maxPanes, cachedTerminals };
  });
}

async function installPerformanceMetrics(page: Page): Promise<PerformanceMetrics> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    const supported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const longTasks: PerformanceEntrySample[] = [];
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: unknown } }).memory;
    const heapStartBytes = typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : undefined;
    const metrics = {
      supported,
      startTime: performance.now(),
      longTasks,
      resizeWindows: [] as ResizeWindow[],
      activeResize: undefined as { readonly geometryIndex: number; readonly start: number } | undefined,
      heapStartBytes,
    };
    target[key] = metrics;
    if (supported) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: "longtask", buffered: true });
      target[`${key}:observer`] = observer;
    }
    return {
      supported,
      startTime: metrics.startTime,
      endTime: metrics.startTime,
      heapStartBytes,
      longTasks: [],
      resizeWindows: [],
    } satisfies PerformanceMetrics;
  }, PERFORMANCE_KEY);
}

async function beginResizeMetric(page: Page, geometryIndex: number): Promise<void> {
  await page.evaluate(({ key, geometryIndex }) => {
    const metrics = (window as unknown as Record<string, unknown>)[key] as {
      activeResize?: { readonly geometryIndex: number; readonly start: number };
    } | undefined;
    if (!metrics) throw new Error("S-03 performance metrics are unavailable");
    metrics.activeResize = { geometryIndex, start: performance.now() };
  }, { key: PERFORMANCE_KEY, geometryIndex });
}

async function finishResizeMetric(page: Page): Promise<void> {
  const frameDelayMs = await page.evaluate(() => new Promise<number>((resolve) => {
    const started = performance.now();
    requestAnimationFrame(() => resolve(performance.now() - started));
  }));
  await page.evaluate(({ key, frameDelayMs }) => {
    const metrics = (window as unknown as Record<string, unknown>)[key] as {
      activeResize?: { readonly geometryIndex: number; readonly start: number };
      resizeWindows: ResizeWindow[];
    } | undefined;
    if (!metrics?.activeResize) throw new Error("S-03 resize metric was not started");
    const end = performance.now();
    metrics.resizeWindows.push({
      geometryIndex: metrics.activeResize.geometryIndex,
      start: metrics.activeResize.start,
      end,
      latencyMs: end - metrics.activeResize.start,
      frameDelayMs,
    });
    metrics.activeResize = undefined;
  }, { key: PERFORMANCE_KEY, frameDelayMs });
}

async function readPerformanceMetrics(page: Page): Promise<PerformanceMetrics> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const metrics = target[key] as {
      supported: boolean;
      startTime: number;
      longTasks: PerformanceEntrySample[];
      resizeWindows: ResizeWindow[];
      activeResize?: unknown;
      heapStartBytes?: number;
    } | undefined;
    if (!metrics) throw new Error("S-03 performance metrics are unavailable");
    if (metrics.activeResize !== undefined) throw new Error("S-03 resize metric is still active");
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: unknown } }).memory;
    const heapEndBytes = typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : undefined;
    const endTime = performance.now();
    return {
      supported: metrics.supported,
      startTime: metrics.startTime,
      endTime,
      heapStartBytes: metrics.heapStartBytes,
      heapEndBytes,
      longTasks: metrics.longTasks.map((entry) => ({ startTime: entry.startTime, duration: entry.duration })),
      resizeWindows: metrics.resizeWindows.map((window) => ({ ...window })),
    } satisfies PerformanceMetrics;
  }, PERFORMANCE_KEY);
}

async function emitOutputCommand(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  command: string,
  eventName: string,
  eventPredicate: (entry: TranscriptEntry) => boolean,
  writePredicate: (entry: TranscriptEntry) => boolean,
): Promise<OutputCommandResult> {
  const [beforeEvents, beforeTranscript, beforeSnapshot] = await Promise.all([
    pane.events(),
    server.readTranscript(pane.terminalId),
    pane.snapshot(),
  ]);
  if (!beforeSnapshot) throw new Error(`No diagnostics snapshot for terminal ${pane.terminalId}`);
  const eventFloor = beforeEvents.at(-1)?.id ?? -1;
  const transcriptFloor = transcriptBoundary(beforeTranscript);
  const beforeWriteBytes = transcriptWriteBytes(beforeTranscript);
  const event = waitForTranscriptAfter(server, pane.terminalId, transcriptFloor, eventName, eventPredicate);
  const write = waitForTranscriptAfter(server, pane.terminalId, transcriptFloor, "write", writePredicate);
  await pane.sendInput(command, true);
  const [eventEntry, writeEntry] = await Promise.all([event, write]);
  const bytes = requiredNumber(writeEntry.bytes, `${eventName} output bytes`);
  const sequence = beforeWriteBytes + bytes;
  await waitForParserCommit(page, pane.terminalId, eventFloor, sequence);
  const snapshot = await waitForSettledTerminal(page, pane.terminalId, sequence);
  return { event: eventEntry, write: writeEntry, snapshot, sequence, bytes };
}

async function emitSizeCommand(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  sizeId: string,
): Promise<OutputCommandResult> {
  return emitOutputCommand(
    page,
    server,
    pane,
    `SIZE ${sizeId}`,
    "size",
    (entry) => entry.id === sizeId && entry.source === "ioctl",
    (entry) => typeof entry.text === "string" && entry.text.startsWith(`[E2E:SIZE:${sizeId}:`),
  );
}

async function emitPrintCommand(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  markerId: string,
  markerText: string,
): Promise<OutputCommandResult> {
  const marker = `[E2E:PRINT:${markerId}:${markerText}]\n`;
  return emitOutputCommand(
    page,
    server,
    pane,
    `PRINT ${markerId} ${markerText}`,
    "print",
    (entry) => entry.id === markerId && entry.text === markerText,
    (entry) => entry.text === marker,
  );
}

async function emitBurstCommand(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  burstId: string,
  bytes: number,
): Promise<OutputCommandResult & { readonly data: Buffer }> {
  const [beforeEvents, beforeTranscript, beforeSnapshot] = await Promise.all([
    pane.events(),
    server.readTranscript(pane.terminalId),
    pane.snapshot(),
  ]);
  if (!beforeSnapshot) throw new Error(`No diagnostics snapshot for terminal ${pane.terminalId}`);
  const eventFloor = beforeEvents.at(-1)?.id ?? -1;
  const transcriptFloor = transcriptBoundary(beforeTranscript);
  const beforeWriteBytes = transcriptWriteBytes(beforeTranscript);
  const burst = waitForTranscriptAfter(server, pane.terminalId, transcriptFloor, "burst", (entry) => (
    entry.id === burstId
    && numberField(entry, "bytes") === bytes
    && numberField(entry, "line_width") === BURST_LINE_WIDTH
  ));
  const write = waitForTranscriptAfter(server, pane.terminalId, transcriptFloor, "write", (entry) => (
    numberField(entry, "bytes") === bytes && typeof entry.data_base64 === "string"
  ));
  await pane.sendInput(`BURST ${burstId} ${bytes} ${BURST_LINE_WIDTH}`, true);
  const [burstEntry, writeEntry] = await Promise.all([burst, write]);
  const data = Buffer.from(String(writeEntry.data_base64), "base64");
  expect(data.length).toBe(bytes);
  const writeBytes = requiredNumber(writeEntry.bytes, "burst output bytes");
  expect(writeBytes).toBe(bytes);
  const sequence = beforeWriteBytes + writeBytes;
  await waitForParserCommit(page, pane.terminalId, eventFloor, sequence);
  const snapshot = await waitForSettledTerminal(page, pane.terminalId, sequence);
  return { event: burstEntry, write: writeEntry, snapshot, sequence, bytes: writeBytes, data };
}

async function emitEchoPayload(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  echoId: string,
  payload: string,
): Promise<{ readonly transcript: TranscriptEntry; readonly snapshot: E2ETerminalSnapshot; readonly sequence: number; readonly latencyMs: number }> {
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  const marker = `[E2E:ECHO_INPUT:${echoId}:${encoded}]\n`;
  const [beforeEvents, beforeTranscript] = await Promise.all([pane.events(), server.readTranscript(pane.terminalId)]);
  const eventFloor = beforeEvents.at(-1)?.id ?? -1;
  const transcriptFloor = transcriptBoundary(beforeTranscript);
  const beforeWriteBytes = transcriptWriteBytes(beforeTranscript);
  const transcript = waitForTranscriptAfter(server, pane.terminalId, transcriptFloor, "echo_input", (entry) => (
    entry.id === echoId && entry.phase === "payload" && entry.payload_base64 === encoded
  ));
  const write = waitForTranscriptAfter(server, pane.terminalId, transcriptFloor, "write", (entry) => entry.text === marker);
  const startedAt = Date.now();
  await pane.sendInput(payload, true);
  const [transcriptEntry, writeEntry] = await Promise.all([transcript, write]);
  const sequence = beforeWriteBytes + requiredNumber(writeEntry.bytes, "echo output bytes");
  await waitForParserCommit(page, pane.terminalId, eventFloor, sequence);
  const snapshot = await waitForSettledTerminal(page, pane.terminalId, sequence);
  return { transcript: transcriptEntry, snapshot, sequence, latencyMs: Date.now() - startedAt };
}

async function expectSearchExactlyOnce(pane: TerminalPanePage, query: string): Promise<void> {
  await pane.searchScrollback(query);
  await expect(pane.root.locator(".terminal-search-results")).toHaveText("1/1");
  await pane.closeSearch();
}

async function createTerminal(page: Page, workbench: WorkbenchPage): Promise<CreatedTerminal> {
  const createResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const response = await createResponse;
  expect(response.ok()).toBe(true);
  const created = await response.json() as { readonly id?: unknown; readonly name?: unknown };
  if (typeof created.id !== "string" || typeof created.name !== "string") throw new Error("terminal creation response omitted identity");
  const pane = new TerminalPanePage(page, created.id, created.name);
  await pane.expectVisible();
  await pane.waitForConnected({ timeout: WAIT_TIMEOUT_MS });
  return { id: created.id, name: created.name, pane };
}

async function removeTerminal(page: Page, workbench: WorkbenchPage, terminal: CreatedTerminal): Promise<void> {
  const before = await terminal.pane.events();
  const floor = before.at(-1)?.id ?? -1;
  const unmount = waitForEventTypeAfter(page, terminal.id, floor, "unmount");
  await workbench.sidebar.removeTerminal({ id: terminal.id, name: terminal.name }, true);
  const event = await unmount;
  expect(event.snapshot.lifecycle.mounted).toBe(false);
  expect(event.snapshot.activeSocketCount).toBe(0);
  await expect(terminal.pane.root).toHaveCount(0);
  const remaining = await terminalSnapshot(page, terminal.id);
  expect(remaining).toBeUndefined();
}

async function exitFixture(server: IsolatedServer, pane: TerminalPanePage): Promise<void> {
  const entries = await server.readTranscript(pane.terminalId);
  const boundary = transcriptBoundary(entries);
  const exit = waitForTranscriptAfter(server, pane.terminalId, boundary, "exit", (entry) => entry.code === 0);
  await pane.sendInput("EXIT 0", true);
  await exit;
}

function maxLongTaskDuration(entries: readonly PerformanceEntrySample[]): number {
  return entries.reduce((maximum, entry) => Math.max(maximum, entry.duration), 0);
}

function longTasksForWindow(entries: readonly PerformanceEntrySample[], window: ResizeWindow): PerformanceEntrySample[] {
  return entries.filter((entry) => entry.startTime < window.end && entry.startTime + entry.duration > window.start);
}

function serverReflowTime(events: readonly E2ETerminalEvent[], floor: number, sizeEvent: E2ETerminalEvent): number {
  const cols = numberField(sizeEvent, "cols");
  const rows = numberField(sizeEvent, "rows");
  const sent = events.find((event) => event.id > floor
    && event.type === "viewport"
    && event.data.source === "sent"
    && event.data.cols === cols
    && event.data.rows === rows);
  return Math.max(0, (sizeEvent.timestamp - (sent?.timestamp ?? sizeEvent.timestamp)));
}

async function attachMetrics(testInfo: TestInfo, run: string, config: RuntimeConfig, cases: readonly CaseMetrics[]): Promise<void> {
  const jsonl = cases.map((result) => JSON.stringify({
    scenario: "S-03",
    seed: SEED,
    run,
    runtimeConfig: config,
    ...result,
  })).join("\n");
  await testInfo.attach("s-03-resize-metrics", {
    body: `${jsonl}\n`,
    contentType: "application/jsonl",
  });
  await testInfo.attach("s-03-resize-summary", {
    body: JSON.stringify({ scenario: "S-03", seed: SEED, run, runtimeConfig: config, cases }, null, 2),
    contentType: "application/json",
  });
}

test("S-03 Deep scrollback resize @soak @S-03", async ({ page, baseURL, server }, testInfo) => {
  const run = runTag(testInfo);
  const browserErrors = installBrowserErrorCollectors(page);
  const config = { scrollbackLines: 0, maxPanes: 0, cachedTerminals: 0 } as RuntimeConfig;
  const caseMetrics: CaseMetrics[] = [];
  let activeTerminal: CreatedTerminal | undefined;

  try {
    await page.setViewportSize(GEOMETRIES[0]);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const runtimeConfig = await readRuntimeConfig(page);
    Object.assign(config, runtimeConfig);
    expect(runtimeConfig.scrollbackLines).toBeGreaterThanOrEqual(SCROLLBACK_TIERS.at(-1)!);
    expect(runtimeConfig.maxPanes).toBeGreaterThanOrEqual(1);
    expect(runtimeConfig.cachedTerminals).toBeGreaterThanOrEqual(0);
    expect(SCROLLBACK_TIERS.at(-1)! * BURST_LINE_WIDTH).toBeLessThan(REPLAY_BUDGET_BYTES);

    const settings = await workbench.openSettings();
    await settings.setCachedTerminalLimit(0);
    await expect(settings.root.getByRole("slider", { name: "Terminals kept alive off screen", exact: true })).toHaveValue("0");
    await workbench.closeSettings();

    for (const lines of SCROLLBACK_TIERS) {
      const caseTag = `${run}-L${lines}`;
      activeTerminal = await createTerminal(page, workbench);
      expect(await workbench.visiblePaneCount()).toBe(1);
      expect(await workbench.mountedPaneCount()).toBe(1);
      const pane = activeTerminal.pane;
      await pane.expectVisible();

      const performanceStart = await installPerformanceMetrics(page);
      const markerIds: string[] = [];
      const readyId = `${caseTag}-READY`;
      const sizeId = `${caseTag}-SIZE`;
      const historyId = `${caseTag}-HISTORY`;
      const historyText = `${caseTag}-HISTORY-${"0123456789".repeat(24)}`;
      markerIds.push(readyId, sizeId, historyId);

      const ready = await emitOutputCommand(
        page,
        server,
        pane,
        `READY ${readyId}`,
        "ready",
        (entry) => entry.id === readyId,
        (entry) => entry.text === `[E2E:READY:${readyId}]\n`,
      );
      const initial = ready.snapshot;
      expect(initial.socketState).toBe("connected");
      expect(initial.acceptingInput).toBe(true);
      expect(initial.activeSocketCount).toBe(1);
      expect(initial.serverViewport).toMatchObject({ cols: initial.cols, rows: initial.rows });

      const size = await emitSizeCommand(page, server, pane, sizeId);
      expect(numberField(size.event, "rows")).toBe(initial.rows);
      expect(numberField(size.event, "cols")).toBe(initial.cols);

      const history = await emitPrintCommand(page, server, pane, historyId, historyText);
      expect(history.snapshot.xterm.text).toContain(`[E2E:PRINT:${historyId}:${historyText}]`);

      const burstBytes = lines * BURST_LINE_WIDTH;
      const burstId = `${caseTag}-BURST`;
      const checkpointFloor = (await terminalEvents(page, activeTerminal.id)).at(-1)?.id ?? -1;
      const burst = await emitBurstCommand(page, server, pane, burstId, burstBytes);
      const newlineCount = countNewlines(burst.data);
      const expectedNewlines = expectedBurstNewlineCount(burstBytes, BURST_LINE_WIDTH);
      expect(newlineCount).toBe(expectedNewlines);
      expect(numberField(burst.event, "bytes")).toBe(burstBytes);
      expect(numberField(burst.event, "line_width")).toBe(BURST_LINE_WIDTH);
      expect(burst.snapshot.committedSequence).toBe(burst.sequence);
      expect(burst.snapshot.pendingParserBytes).toBe(0);
      expect(burst.snapshot.renderBacklogBytes).toBe(0);

      const checkpoint = await waitForCheckpoint(page, activeTerminal.id, checkpointFloor, burst.sequence);
      const checkpointSize = requiredNumber(checkpoint.data.size, "checkpoint size");
      const checkpointSequence = requiredNumber(checkpoint.data.sequence, "checkpoint sequence");
      const checkpointEpoch = requiredNumber(checkpoint.data.epoch, "checkpoint epoch");
      const checkpointChunks = requiredNumber(checkpoint.data.chunks, "checkpoint chunks");
      const serializationDurationMs = requiredNumber(checkpoint.data.serializationDurationMs, "checkpoint serialization duration");
      const uploadDurationMs = requiredNumber(checkpoint.data.uploadDurationMs, "checkpoint upload duration");
      expect(checkpoint.data.result).toBe("sent");
      expect(checkpointSize).toBeGreaterThan(0);
      expect(checkpointSize).toBeLessThanOrEqual(CHECKPOINT_BUDGET_BYTES);
      expect(checkpointSequence).toBeGreaterThanOrEqual(burst.sequence);
      expect(checkpointChunks).toBe(Math.ceil(checkpointSize / (32 * 1024)));
      expect(serializationDurationMs).toBeGreaterThanOrEqual(0);
      expect(uploadDurationMs).toBeGreaterThanOrEqual(0);

      let previousEpoch = requiredNumber(initial.gridEpoch, `${caseTag} initial grid epoch`);
      let previousDimensions = { cols: initial.cols, rows: initial.rows };
      const resizeSamples: ResizeSample[] = [];
      let currentSequence = burst.sequence;
      for (let geometryIndex = 1; geometryIndex < GEOMETRIES.length; geometryIndex += 1) {
        const geometry = GEOMETRIES[geometryIndex]!;
        const holdToken = `${caseTag}-HOLD-${geometryIndex}`;
        const hold = await emitOutputCommand(
          page,
          server,
          pane,
          `HOLD ${holdToken}`,
          "hold",
          (entry) => entry.token === holdToken,
          (entry) => entry.text === `[E2E:HOLD:${holdToken}]\n`,
        );
        currentSequence = hold.sequence;
        const beforeEvents = await pane.events();
        const eventFloor = beforeEvents.at(-1)?.id ?? -1;
        const beforeTranscript = await server.readTranscript(activeTerminal.id);
        const transcriptFloor = transcriptBoundary(beforeTranscript);
        const ptySignal = waitForTranscriptAfter(server, activeTerminal.id, transcriptFloor, "sigwinch", (entry) => entry.source === "signal");
        const sizeEventPromise = waitForResizeSizeEvent(page, activeTerminal.id, eventFloor, previousDimensions);
        const selectedPromise = waitForResizeSelection(page, activeTerminal.id, previousDimensions);
        await beginResizeMetric(page, geometryIndex);
        await page.setViewportSize(geometry);
        const [sizeEvent, selected, pty] = await Promise.all([sizeEventPromise, selectedPromise, ptySignal]);
        expect(numberField(pty, "rows")).toBe(selected.rows);
        expect(numberField(pty, "cols")).toBe(selected.cols);
        expect(numberField(sizeEvent, "rows")).toBe(selected.rows);
        expect(numberField(sizeEvent, "cols")).toBe(selected.cols);
        expect(selected.serverViewport).toMatchObject({ cols: selected.cols, rows: selected.rows });

        const releaseToken = `${caseTag}-RELEASE-${geometryIndex}`;
        const release = await emitOutputCommand(
          page,
          server,
          pane,
          `RELEASE ${holdToken}`,
          "release",
          (entry) => entry.token === holdToken,
          (entry) => entry.text === `[E2E:RELEASE:${holdToken}]\n`,
        );
        currentSequence = release.sequence;
        const beforeMarkerPixels = await screenshotRegion(page, pane.xtermHost);
        const markerId = `${caseTag}-G${geometryIndex}`;
        const markerText = `${caseTag}-GEOMETRY-${geometryIndex}`;
        markerIds.push(markerId, holdToken);
        const marker = await emitPrintCommand(page, server, pane, markerId, markerText);
        currentSequence = marker.sequence;
        const renderFloor = (await pane.events()).findLast((event) => event.type === "parser-commit" && event.id > eventFloor)?.id ?? eventFloor;
        await waitForEventTypeAfter(page, activeTerminal.id, renderFloor, "render");
        await finishResizeMetric(page);
        const afterMarkerPixels = await expectKnownMarkerChanged(page, pane.xtermHost, beforeMarkerPixels, {
          minimumChangedRatio: 0.0002,
          testInfo,
          artifactName: `${caseTag}-geometry-${geometryIndex}-pixels`,
        });
        await expectTerminalNonBlank(page, pane.xtermHost, {
          minimumNonBackgroundRatio: 0.001,
          testInfo,
          artifactName: `${caseTag}-geometry-${geometryIndex}-terminal`,
        });
        expect(afterMarkerPixels.changedRatio).toBeGreaterThanOrEqual(0.0002);

        const events = await pane.events();
        const transitionEvents = events.filter((event) => event.id > eventFloor);
        const sizeEvents = transitionEvents.filter((event) => event.type === "size");
        expect(sizeEvents.length).toBeGreaterThan(0);
        for (const event of sizeEvents) {
          expect(numberField(event, "cols")).toBe(selected.cols);
          expect(numberField(event, "rows")).toBe(selected.rows);
        }
        const transitionEpochs = [...new Set(sizeEvents
          .map((event) => numberField(event, "epoch"))
          .filter((epoch): epoch is number => epoch !== undefined))];
        expect(transitionEpochs.length).toBeGreaterThan(0);
        for (const epoch of transitionEpochs) expect(epoch).toBeGreaterThan(previousEpoch);
        previousEpoch = Math.max(...transitionEpochs);
        const markerLongTasks = [] as PerformanceEntrySample[];
        const metricWindows = (await page.evaluate((key) => {
          const target = window as unknown as Record<string, unknown>;
          const metrics = target[key] as { resizeWindows?: readonly ResizeWindow[] } | undefined;
          return metrics?.resizeWindows?.map((window) => ({ ...window })) ?? [];
        }, PERFORMANCE_KEY));
        const metricWindow = metricWindows.find((window) => window.geometryIndex === geometryIndex);
        if (!metricWindow) throw new Error(`missing S-03 resize metric for geometry ${geometryIndex}`);
        const performanceNow = await page.evaluate((key) => {
          const target = window as unknown as Record<string, unknown>;
          const metrics = target[key] as { longTasks?: readonly PerformanceEntrySample[] } | undefined;
          return metrics?.longTasks?.map((entry) => ({ ...entry })) ?? [];
        }, PERFORMANCE_KEY);
        markerLongTasks.push(...longTasksForWindow(performanceNow, metricWindow));
        const maxParserPendingBytes = transitionEvents.reduce((maximum, event) => Math.max(maximum, event.snapshot.pendingParserBytes), selected.pendingParserBytes);
        const maxParserPendingWrites = transitionEvents.reduce((maximum, event) => Math.max(maximum, event.snapshot.pendingParserWrites), selected.pendingParserWrites);
        const maxRenderBacklogBytes = transitionEvents.reduce((maximum, event) => Math.max(maximum, event.snapshot.renderBacklogBytes), selected.renderBacklogBytes);
        const maxRenderBacklogFrames = transitionEvents.reduce((maximum, event) => Math.max(maximum, event.snapshot.renderBacklogFrames), selected.renderBacklogFrames);
        const maxRenderBacklogAge = transitionEvents.reduce((maximum, event) => Math.max(maximum, event.snapshot.renderBacklogOldestAgeMs), selected.renderBacklogOldestAgeMs);
        const selectedServer = selected.serverViewport;
        if (!selectedServer) throw new Error(`S-03 geometry ${geometryIndex} has no selected server viewport`);
        const epoch = requiredNumber(selected.gridEpoch, `${caseTag} geometry ${geometryIndex} grid epoch`);
        const reflowMs = serverReflowTime(events, eventFloor, sizeEvent);
        const heapUsedBytes = await page.evaluate(() => {
          const memory = (performance as Performance & { memory?: { usedJSHeapSize?: unknown } }).memory;
          return typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
            ? memory.usedJSHeapSize
            : undefined;
        });
        resizeSamples.push({
          geometryIndex,
          target: geometry,
          latencyMs: metricWindow.latencyMs,
          frameDelayMs: metricWindow.frameDelayMs,
          parserPendingBytes: maxParserPendingBytes,
          parserPendingWrites: maxParserPendingWrites,
          renderBacklogBytes: maxRenderBacklogBytes,
          renderBacklogFrames: maxRenderBacklogFrames,
          renderBacklogOldestAgeMs: maxRenderBacklogAge,
          longTaskCount: markerLongTasks.length,
          maxLongTaskDurationMs: maxLongTaskDuration(markerLongTasks),
          ...(heapUsedBytes === undefined ? {} : { heapUsedBytes }),
          serverGridEpoch: epoch,
          serverReflowTimeMs: reflowMs,
          browser: {
            cols: marker.snapshot.cols,
            rows: marker.snapshot.rows,
            pixelWidth: marker.snapshot.pixelWidth,
            pixelHeight: marker.snapshot.pixelHeight,
          },
          server: {
            cols: selectedServer.cols,
            rows: selectedServer.rows,
            pixelWidth: selectedServer.pixelWidth,
            pixelHeight: selectedServer.pixelHeight,
          },
          pty: {
            cols: requiredNumber(pty.cols, `${caseTag} geometry ${geometryIndex} PTY cols`),
            rows: requiredNumber(pty.rows, `${caseTag} geometry ${geometryIndex} PTY rows`),
          },
        });
        expect(currentSequence).toBe(marker.sequence);
        previousDimensions = { cols: marker.snapshot.cols, rows: marker.snapshot.rows };
      }

      const echoId = `${caseTag}-ECHO`;
      const echoText = `${caseTag}-INPUT`;
      markerIds.push(echoId);
      const armed = await emitOutputCommand(
        page,
        server,
        pane,
        `ECHO_INPUT ${echoId}`,
        "echo_input",
        (entry) => entry.id === echoId && entry.phase === "armed",
        (entry) => entry.text === `[E2E:ECHO_INPUT:${echoId}:READY]\n`,
      );
      currentSequence = armed.sequence;
      const echo = await emitEchoPayload(page, server, pane, echoId, echoText);
      currentSequence = echo.sequence;
      expect(echo.transcript.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
      await expectSearchExactlyOnce(pane, echoId);
      expect(echo.snapshot.acceptingInput).toBe(true);

      const finalSnapshot = await waitForSettledTerminal(page, pane.terminalId, currentSequence);
      const finalServer = finalSnapshot.serverViewport;
      if (!finalServer) throw new Error(`S-03 ${caseTag} final server viewport is unavailable`);
      const finalPty = resizeSamples.at(-1)?.pty;
      if (!finalPty) throw new Error(`S-03 ${caseTag} has no final PTY geometry`);
      expect(finalSnapshot.cols).toBe(finalServer.cols);
      expect(finalSnapshot.rows).toBe(finalServer.rows);
      expect(finalSnapshot.cols).toBe(finalPty.cols);
      expect(finalSnapshot.rows).toBe(finalPty.rows);
      expect(finalSnapshot.activeSocketCount).toBe(1);
      expect(finalSnapshot.socketGeneration).toBe(1);
      expect(finalSnapshot.pendingParserWrites).toBe(0);
      expect(finalSnapshot.pendingParserBytes).toBe(0);
      expect(finalSnapshot.renderBacklogBytes).toBe(0);
      expect(finalSnapshot.renderBacklogFrames).toBe(0);
      assertNoPendingSynchronization(finalSnapshot);
      await expectTerminalNonBlank(page, pane.xtermHost, {
        minimumNonBackgroundRatio: 0.001,
        testInfo,
        artifactName: `${caseTag}-final-terminal`,
      });
      for (const markerId of markerIds) await expectSearchExactlyOnce(pane, markerId);

      const transcriptBeforeExit = await server.readTranscript(activeTerminal.id);
      expect(transcriptBeforeExit.filter((entry) => entry.event === "error")).toHaveLength(0);
      expect(transcriptBeforeExit.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
      expect(transcriptWriteBytes(transcriptBeforeExit)).toBe(finalSnapshot.committedSequence);
      expect(finalSnapshot.receivedSequence).toBe(finalSnapshot.committedSequence);
      expect(finalSnapshot.gridEpoch).toBe(previousEpoch);
      for (const markerId of markerIds) {
        const printCount = transcriptBeforeExit.filter((entry) => (
          (entry.event === "print" && entry.id === markerId)
          || (entry.event === "ready" && entry.id === markerId)
          || (entry.event === "size" && entry.id === markerId)
          || (entry.event === "echo_input" && entry.id === markerId)
        )).length;
        expect(printCount, `${markerId} transcript count`).toBe(1);
      }
      for (let geometryIndex = 1; geometryIndex < GEOMETRIES.length; geometryIndex += 1) {
        const holdToken = `${caseTag}-HOLD-${geometryIndex}`;
        expect(transcriptBeforeExit.filter((entry) => entry.event === "hold" && entry.token === holdToken)).toHaveLength(1);
        expect(transcriptBeforeExit.filter((entry) => entry.event === "release" && entry.token === holdToken)).toHaveLength(1);
        const signal = transcriptBeforeExit.findLast((entry) => entry.event === "sigwinch" && entry.source === "signal");
        expect(signal).toBeDefined();
      }
      await assertMonotonicSequences(await terminalEvents(page, activeTerminal.id));
      const invariantReport = await expectTerminalInvariants(page, activeTerminal.id, { timeout: WAIT_TIMEOUT_MS });
      expect(invariantReport.violations).toEqual([]);

      const performanceMetrics = await readPerformanceMetrics(page);
      const longTaskCount = performanceMetrics.longTasks.length;
      const maxLongTaskDurationMs = maxLongTaskDuration(performanceMetrics.longTasks);
      const resizeLatencyDistributionMs = resizeSamples.map((sample) => sample.latencyMs);
      const responsivenessDistributionMs = resizeSamples.map((sample) => sample.frameDelayMs);
      const finalPtySnapshot = resizeSamples.at(-1)!.pty;
      caseMetrics.push({
        lines,
        burstBytes,
        burstNewlineCount: newlineCount,
        expectedBurstNewlineCount: expectedNewlines,
        replayBudgetBytes: REPLAY_BUDGET_BYTES,
        checkpointBudgetBytes: CHECKPOINT_BUDGET_BYTES,
        checkpoint: {
          sequence: checkpointSequence,
          epoch: checkpointEpoch,
          size: checkpointSize,
          chunks: checkpointChunks,
          serializationDurationMs,
          uploadDurationMs,
          result: String(checkpoint.data.result),
        },
        resizeLatencyDistributionMs,
        resizeLatencyP50Ms: percentile(resizeLatencyDistributionMs, 0.5),
        resizeLatencyP95Ms: percentile(resizeLatencyDistributionMs, 0.95),
        resizeLatencyMaxMs: Math.max(...resizeLatencyDistributionMs),
        responsivenessDistributionMs,
        responsivenessP50Ms: percentile(responsivenessDistributionMs, 0.5),
        responsivenessP95Ms: percentile(responsivenessDistributionMs, 0.95),
        responsivenessMaxMs: Math.max(...responsivenessDistributionMs),
        longTaskCount,
        maxLongTaskDurationMs,
        longTaskSupported: performanceMetrics.supported,
        ...(performanceMetrics.heapStartBytes === undefined ? {} : { heapStartBytes: performanceMetrics.heapStartBytes }),
        ...(performanceMetrics.heapEndBytes === undefined ? {} : { heapEndBytes: performanceMetrics.heapEndBytes }),
        parserPendingBytesMax: Math.max(...resizeSamples.map((sample) => sample.parserPendingBytes)),
        parserPendingWritesMax: Math.max(...resizeSamples.map((sample) => sample.parserPendingWrites)),
        renderBacklogBytesMax: Math.max(...resizeSamples.map((sample) => sample.renderBacklogBytes)),
        renderBacklogFramesMax: Math.max(...resizeSamples.map((sample) => sample.renderBacklogFrames)),
        renderBacklogOldestAgeMsMax: Math.max(...resizeSamples.map((sample) => sample.renderBacklogOldestAgeMs)),
        inputRoundTripMs: echo.latencyMs,
        final: {
          browser: {
            cols: finalSnapshot.cols,
            rows: finalSnapshot.rows,
            pixelWidth: finalSnapshot.pixelWidth,
            pixelHeight: finalSnapshot.pixelHeight,
          },
          server: {
            cols: finalServer.cols,
            rows: finalServer.rows,
            pixelWidth: finalServer.pixelWidth,
            pixelHeight: finalServer.pixelHeight,
          },
          pty: finalPtySnapshot,
          gridEpoch: previousEpoch,
          committedSequence: requiredNumber(finalSnapshot.committedSequence, `${caseTag} committed sequence`),
        },
        resizes: resizeSamples,
      });
      await exitFixture(server, pane);
      await removeTerminal(page, workbench, activeTerminal);
      activeTerminal = undefined;
    }

    await attachMetrics(testInfo, run, runtimeConfig, caseMetrics);
    expect(caseMetrics).toHaveLength(SCROLLBACK_TIERS.length);
    const lowerTierP95 = caseMetrics.slice(0, -1).map((result) => result.resizeLatencyP95Ms);
    const lowerTierLines = caseMetrics.slice(0, -1).map((result) => result.lines);
    const maxTier = caseMetrics.at(-1)!;
    const slope = (lowerTierP95.at(-1)! - lowerTierP95[0]!) / (lowerTierLines.at(-1)! - lowerTierLines[0]!);
    const trendEstimate = Math.max(...lowerTierP95, lowerTierP95[0]! + Math.max(0, slope) * (maxTier.lines - lowerTierLines[0]!));
    const trendBandMs = Math.max(5_000, trendEstimate * 4);
    expect(maxTier.resizeLatencyMaxMs, "200,000-line resize exceeded the established lower-tier trend band").toBeLessThanOrEqual(trendBandMs);
    expect(browserErrors()).toEqual([]);
    expect(await workbench.mountedPaneCount()).toBe(0);
    expect(await page.locator("canvas").count()).toBe(0);
    const remaining = await page.evaluate(() => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.terminals();
    });
    expect(remaining).toEqual([]);
  } finally {
    if (activeTerminal) await removeTerminal(page, new WorkbenchPage(page), activeTerminal);
    browserErrors.dispose();
  }
});
