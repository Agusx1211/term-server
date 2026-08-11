import { createHash } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage, { type TerminalPanePage } from "../pages/workbench-page.js";
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
import {
  expectConnectedTerminalInvariants,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import { TERMINAL_CHECKPOINT_CHUNK_BYTES } from "../../src/client/lib/terminal-checkpoint.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 120_000;
const BROWSER_VIEWPORT = { width: 1_280, height: 800 } as const;
const TERMINAL_COUNT = 16;
const VISIBLE_TERMINAL_COUNT = 4;
const CACHE_LIMIT = 12;
const EXPECTED_MOUNTED_COUNT = VISIBLE_TERMINAL_COUNT + (CACHE_LIMIT - VISIBLE_TERMINAL_COUNT);
const BURST_BYTES = 4_096;
const BURST_LINE_WIDTH = 80;
const INITIAL_BURST_OFFSET_MS = 5_000;
const INITIAL_BURST_STEP_MS = 2_000;
const REVEAL_INTERVAL_MS = 60_000;
const SOAK_DURATION_MS = 15 * 60_000;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const PERFORMANCE_KEY = "__TERM_SERVER_E2E_S02_PERFORMANCE__";
const RUN_SEED = "0x5102";

test.setTimeout(SOAK_DURATION_MS + 5 * 60_000);

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type PerformanceEntryRecord = {
  readonly startTime: number;
  readonly duration: number;
};

type PerformanceStart = {
  readonly supported: boolean;
  readonly startTime: number;
  readonly heapUsedBytes?: number;
};

type PerformanceEnd = {
  readonly supported: boolean;
  readonly endTime: number;
  readonly longTasks: readonly PerformanceEntryRecord[];
  readonly heapUsedBytes?: number;
};

type CreatedTerminal = {
  readonly id: string;
  readonly name: string;
};

type ProcessMetrics = {
  readonly supported: boolean;
  readonly processCount: number;
  readonly cpuPercent: number;
  readonly memoryBytes: number;
};

type ResourceMetrics = {
  readonly canvasCount: number;
  readonly canvasDimensions: readonly { readonly width: number; readonly height: number }[];
  readonly mountedCount: number;
  readonly visibleCount: number;
  readonly cachedCount: number;
  readonly socketCount: number;
  readonly webglPaneCount: number;
  readonly rendererLoads: number;
};

type CheckpointMetric = {
  readonly terminalId: string;
  readonly eventId: number;
  readonly sequence: number;
  readonly epoch: number;
  readonly size: number;
  readonly chunks: number;
  readonly serializationDurationMs: number;
  readonly uploadDurationMs: number;
  readonly timestamp: number;
};

type BurstMetric = {
  readonly terminalId: string;
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly committedSequence: number;
};

type RevealMetric = {
  readonly index: number;
  readonly terminalId: string;
  readonly revealLatencyMs: number;
  readonly printCheckpointSerializationDurationMs: number;
  readonly printCheckpointUploadDurationMs: number;
  readonly inputRoundTripMs: number;
};

type DebugRecordingEvent = Record<string, unknown>;
type DebugRecordingExport = {
  readonly truncated: boolean;
  readonly events: readonly DebugRecordingEvent[];
};

type ProxyAccumulator = {
  connectionOpens: number;
  connectionCloses: number;
  bytesBrowserToServer: number;
  bytesServerToBrowser: number;
  faultEvents: number;
};

function recordProxyEvent(stats: ProxyAccumulator, event: NetworkFaultEvent): void {
  if (event.type === "connection-open") stats.connectionOpens += 1;
  if (event.type === "connection-closed") stats.connectionCloses += 1;
  if (event.type === "frame") {
    if (event.direction === "browser-to-server") stats.bytesBrowserToServer += event.bytes ?? 0;
    if (event.direction === "server-to-browser") stats.bytesServerToBrowser += event.bytes ?? 0;
  }
  if ([
    "paused",
    "resumed",
    "throttled",
    "dropped",
    "restored",
    "close-sent",
    "terminated",
    "injected",
    "malformed-frame",
    "socket-error",
  ].includes(event.type)) stats.faultEvents += 1;
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}


function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function lastEventId(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.id), -1);
}

function transcriptWriteBytes(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.event !== "write" || typeof entry.bytes !== "number" || !Number.isFinite(entry.bytes)) return total;
    return total + entry.bytes;
  }, 0);
}

function burstBytes(bytes: number, lineWidth: number): Buffer {
  const output = Buffer.alloc(bytes);
  let offset = 0;
  let column = 0;
  let visible = 0;
  while (offset < bytes) {
    output[offset] = 65 + (visible % 26);
    offset += 1;
    visible += 1;
    column += 1;
    if (column === lineWidth && offset < bytes - 1) {
      output[offset] = 10;
      offset += 1;
      column = 0;
    }
  }
  return output;
}

function expectedBurstSha256(bytes: number): string {
  return createHash("sha256").update(burstBytes(bytes, BURST_LINE_WIDTH)).digest("hex");
}

function transcriptWriteSha256(entry: TranscriptEntry, name: string): string {
  if (typeof entry.data_base64 !== "string") throw new Error(`${name} write is missing data_base64`);
  const data = Buffer.from(entry.data_base64, "base64");
  if (data.length !== BURST_BYTES) throw new Error(`${name} write has ${data.length} bytes; expected ${BURST_BYTES}`);
  return createHash("sha256").update(data).digest("hex");
}

function percentile(values: readonly number[], rank: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function checkpointFromEvent(terminalId: string, event: E2ETerminalEvent): CheckpointMetric {
  if (event.type !== "checkpoint" || event.data.result !== "sent") {
    throw new Error(`terminal ${terminalId} did not report a sent checkpoint`);
  }
  const sequence = requiredNumber(event.data.sequence, `${terminalId} checkpoint sequence`);
  const epoch = requiredNumber(event.data.epoch, `${terminalId} checkpoint epoch`);
  const size = requiredNumber(event.data.size, `${terminalId} checkpoint size`);
  const chunks = requiredNumber(event.data.chunks, `${terminalId} checkpoint chunks`);
  const serializationDurationMs = requiredNumber(
    event.data.serializationDurationMs,
    `${terminalId} checkpoint serialization duration`,
  );
  const uploadDurationMs = requiredNumber(event.data.uploadDurationMs, `${terminalId} checkpoint upload duration`);
  expect(sequence).toBeGreaterThan(0);
  expect(epoch).toBeGreaterThan(0);
  expect(size).toBeGreaterThan(0);
  expect(size).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
  expect(chunks).toBe(Math.ceil(size / TERMINAL_CHECKPOINT_CHUNK_BYTES));
  expect(serializationDurationMs).toBeGreaterThanOrEqual(0);
  expect(uploadDurationMs).toBeGreaterThanOrEqual(0);
  expect(event.snapshot.checkpointSequence).toBe(sequence);
  expect(event.snapshot.checkpointEpoch).toBe(epoch);
  expect(event.snapshot.checkpointResult).toBe("sent");
  expect(event.snapshot.committedSequence).toBeGreaterThanOrEqual(sequence);
  return {
    terminalId,
    eventId: event.id,
    sequence,
    epoch,
    size,
    chunks,
    serializationDurationMs,
    uploadDurationMs,
    timestamp: event.timestamp,
  };
}


async function waitForMountedPane(page: Page, excludedIds: readonly string[] = []): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ excluded, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.snapshot.kind === "pane" && !excluded.includes(event.terminalId),
      { timeout },
    );
  }, { excluded: [...excludedIds], timeout: WAIT_TIMEOUT_MS });
}

async function waitForTerminalEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEvent["type"],
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after && event.type === eventType,
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, eventType: type, timeout: WAIT_TIMEOUT_MS });
}

async function waitForTerminalSettled(
  page: Page,
  terminalId: string,
  minimumSequence: number,
  acceptingInput = false,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimum, requireInput, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.mounted
      && snapshot.socketState === "connected"
      && (!requireInput || snapshot.acceptingInput)
      && snapshot.serverViewport !== undefined
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
    ), { timeout });
  }, { id: terminalId, minimum: minimumSequence, requireInput: acceptingInput, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function readSnapshot(page: Page, terminalId: string): Promise<E2ETerminalSnapshot | undefined> {
  return page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminal(id);
  }, terminalId);
}

async function readSnapshots(page: Page): Promise<readonly E2ETerminalSnapshot[]> {
  return page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminals();
  });
}

async function readResourceMetrics(page: Page, snapshots: readonly E2ETerminalSnapshot[]): Promise<ResourceMetrics> {
  const dom = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".editor-grid canvas")];
    return {
      canvasCount: canvases.length,
      canvasDimensions: canvases.map((canvas) => ({ width: canvas.width, height: canvas.height })),
    };
  });
  return {
    ...dom,
    mountedCount: snapshots.filter((snapshot) => snapshot.mounted).length,
    visibleCount: snapshots.filter((snapshot) => snapshot.visible && !snapshot.cached).length,
    cachedCount: snapshots.filter((snapshot) => snapshot.cached && !snapshot.visible).length,
    socketCount: snapshots.reduce((total, snapshot) => total + snapshot.activeSocketCount, 0),
    webglPaneCount: snapshots.filter((snapshot) => snapshot.renderer === "webgl").length,
    rendererLoads: snapshots.reduce((total, snapshot) => total + snapshot.webglLoadCount, 0),
  };
}

async function readProcessMetrics(page: Page, terminalId: string): Promise<ProcessMetrics> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}/processes`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`process inspector failed for ${id} with HTTP ${response.status}`);
    const payload = await response.json() as {
      supported?: unknown;
      processes?: unknown;
    };
    if (typeof payload.supported !== "boolean" || !Array.isArray(payload.processes)) {
      throw new Error(`process inspector response for ${id} is malformed`);
    }
    let cpuPercent = 0;
    let memoryBytes = 0;
    for (const process of payload.processes) {
      if (typeof process !== "object" || process === null) throw new Error(`process inspector record for ${id} is malformed`);
      const cpu = (process as { cpuPercent?: unknown }).cpuPercent;
      const memory = (process as { memoryBytes?: unknown }).memoryBytes;
      if (typeof cpu !== "number" || !Number.isFinite(cpu) || cpu < 0) throw new Error(`process CPU for ${id} is invalid`);
      if (typeof memory !== "number" || !Number.isFinite(memory) || memory < 0) throw new Error(`process memory for ${id} is invalid`);
      cpuPercent += cpu;
      memoryBytes += memory;
    }
    return {
      supported: payload.supported,
      processCount: payload.processes.length,
      cpuPercent,
      memoryBytes,
    };
  }, terminalId);
}

async function aggregateProcessMetrics(page: Page, terminals: readonly CreatedTerminal[]): Promise<ProcessMetrics> {
  const metrics = await Promise.all(terminals.map((terminal) => readProcessMetrics(page, terminal.id)));
  return {
    supported: metrics.every((metric) => metric.supported),
    processCount: metrics.reduce((total, metric) => total + metric.processCount, 0),
    cpuPercent: metrics.reduce((total, metric) => total + metric.cpuPercent, 0),
    memoryBytes: metrics.reduce((total, metric) => total + metric.memoryBytes, 0),
  };
}

async function startPerformanceMetrics(page: Page): Promise<PerformanceStart> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    const supported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const longTasks: PerformanceEntryRecord[] = [];
    const state = { supported, longTasks, startTime: performance.now() };
    target[key] = state;
    if (supported) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: "longtask", buffered: true });
      target[`${key}:observer`] = observer;
    }
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: unknown } }).memory;
    const heapUsedBytes = typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : undefined;
    return { supported, startTime: state.startTime, heapUsedBytes };
  }, PERFORMANCE_KEY);
}

async function finishPerformanceMetrics(page: Page): Promise<PerformanceEnd> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const value = target[key] as { supported?: unknown; longTasks?: unknown } | undefined;
    if (!value || typeof value.supported !== "boolean" || !Array.isArray(value.longTasks)) {
      throw new Error("S-02 performance metrics are unavailable");
    }
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: unknown } }).memory;
    const heapUsedBytes = typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : undefined;
    return {
      supported: value.supported,
      endTime: performance.now(),
      longTasks: value.longTasks as PerformanceEntryRecord[],
      heapUsedBytes,
    };
  }, PERFORMANCE_KEY);
}

async function exportDebugRecording(page: Page): Promise<DebugRecordingExport> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`debug recording export failed with HTTP ${response.status}`);
    const value = await response.json() as { truncated?: unknown; events?: unknown };
    if (typeof value.truncated !== "boolean" || !Array.isArray(value.events)) {
      throw new Error("debug recording export omitted its bounded event ledger");
    }
    return { truncated: value.truncated, events: value.events as DebugRecordingEvent[] };
  });
}

function checkpointNotes(recording: DebugRecordingExport, terminalId: string): readonly DebugRecordingEvent[] {
  return recording.events.filter((event) => {
    if (event.terminal !== terminalId || event.type !== "control") return false;
    const message = event.message;
    return typeof message === "object"
      && message !== null
      && (message as { type?: unknown }).type === "recording"
      && (message as { event?: unknown }).event === "xterm checkpoint stored";
  });
}

function recordingBytes(recording: DebugRecordingExport): number {
  return recording.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"), 0);
}

async function waitForWallClockBoundary(deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

async function waitForFixtureWrite(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: TranscriptEntry) => boolean,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(terminalId, (entry) => entry.event === "write" && predicate(entry), { timeoutMs: WAIT_TIMEOUT_MS });
}

async function waitForCheckpointAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  minimumSequence?: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => (
        event.id > after
        && event.type === "checkpoint"
        && event.data.result === "sent"
        && (minimum === undefined || typeof event.data.sequence === "number" && event.data.sequence >= minimum)
      ),
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
}

async function beginAndRelease(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  token: string,
): Promise<void> {
  await pane.sendInput(`HOLD ${token}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === token, { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`RELEASE ${token}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === token, { timeoutMs: WAIT_TIMEOUT_MS });
}

async function processBurst(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  terminal: CreatedTerminal,
  burstId: string,
  checkpoints: CheckpointMetric[],
  bursts: BurstMetric[],
): Promise<void> {
  const pane = await workbench.openTerminal(terminal);
  await pane.expectVisible();
  const interactive = await waitForTerminalSettled(page, terminal.id, 0, true);
  expect(interactive.lifecycle.visible).toBe(true);
  expect(interactive.lifecycle.acceptingInput).toBe(true);
  const floor = lastEventId(await terminalEvents(page, terminal.id));
  const parserCommitPromise = waitForTerminalEventAfter(page, terminal.id, floor, "parser-commit");
  const checkpointPromise = waitForCheckpointAfter(page, terminal.id, floor);
  await pane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
  await server.waitForTranscript(terminal.id, (entry) => (
    entry.event === "burst"
    && entry.id === burstId
    && entry.bytes === BURST_BYTES
    && entry.line_width === BURST_LINE_WIDTH
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const write = await waitForFixtureWrite(server, terminal.id, (entry) => entry.bytes === BURST_BYTES && typeof entry.data_base64 === "string");
  const writeHash = transcriptWriteSha256(write, `${terminal.id} BURST`);
  expect(writeHash).toBe(expectedBurstSha256(BURST_BYTES));
  const transcript = await server.readTranscript(terminal.id);
  const expectedSequence = transcriptWriteBytes(transcript);
  const commit = await parserCommitPromise;
  expect(requiredNumber(commit.data.sequence, `${terminal.id} parser sequence`)).toBeGreaterThanOrEqual(expectedSequence);
  const settled = await waitForTerminalSettled(page, terminal.id, expectedSequence, true);
  const expectedPrefix = burstBytes(BURST_BYTES, BURST_LINE_WIDTH).toString("utf8").slice(0, 64);
  expect(settled.xterm.text).toContain(expectedPrefix);
  const checkpointEvent = await checkpointPromise;
  const checkpoint = checkpointFromEvent(terminal.id, checkpointEvent);
  expect(checkpoint.sequence).toBeGreaterThanOrEqual(expectedSequence);
  checkpoints.push(checkpoint);
  bursts.push({
    terminalId: terminal.id,
    id: burstId,
    bytes: BURST_BYTES,
    sha256: writeHash,
    committedSequence: settled.committedSequence ?? 0,
  });
}

async function currentHiddenTerminal(
  page: Page,
  terminals: readonly CreatedTerminal[],
  anchorId: string,
  revealIndex: number,
): Promise<CreatedTerminal> {
  const snapshots = await readSnapshots(page);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.terminalId, snapshot]));
  const candidates = terminals.filter((terminal) => {
    const snapshot = byId.get(terminal.id);
    return terminal.id !== anchorId
      && snapshot?.mounted === true
      && snapshot.cached === true
      && snapshot.visible === false
      && snapshot.lifecycle.acceptingInput === false;
  });
  if (candidates.length === 0) throw new Error("S-02 had no mounted hidden cached terminal to reveal");
  return candidates[revealIndex % candidates.length]!;
}

async function removeTerminalAndFixture(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  terminal: CreatedTerminal,
): Promise<void> {
  const pane = await workbench.openTerminal(terminal);
  await pane.expectVisible();
  const settled = await waitForTerminalSettled(page, terminal.id, 0, true);
  const floor = lastEventId(await terminalEvents(page, terminal.id));
  const exitPromise = waitForTerminalEventAfter(page, terminal.id, floor, "exit");
  await pane.sendInput("EXIT 0", true);
  await server.waitForTranscript(terminal.id, (entry) => entry.event === "exit_requested" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(terminal.id, (entry) => entry.event === "exit" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
  const exitEvent = await exitPromise;
  expect(exitEvent.snapshot.exitCode).toBe(0);
  const unmountFloor = lastEventId(await terminalEvents(page, terminal.id));
  const unmountPromise = waitForTerminalEventAfter(page, terminal.id, unmountFloor, "unmount");
  await workbench.sidebar.removeTerminal(terminal);
  const unmount = await unmountPromise;
  expect(unmount.snapshot.lifecycle.mounted).toBe(false);
  expect(unmount.snapshot.activeSocketCount).toBe(0);
  expect(unmount.snapshot.socket.activeCount).toBe(0);
  expect(unmount.snapshot.lifecycle.acceptingInput).toBe(false);
  expect(settled.socketState).toBe("connected");
}
test("S-02 Busy cached workspace @soak @S-02", async ({ page, baseURL, server, faultController }, testInfo: TestInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `S02-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}-${Date.now()}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const checkpoints: CheckpointMetric[] = [];
  const bursts: BurstMetric[] = [];
  const reveals: RevealMetric[] = [];
  const terminals: CreatedTerminal[] = [];
  let recording: DebugRecordingExport | undefined;
  let performanceStart: PerformanceStart | undefined;
  let performanceEnd: PerformanceEnd | undefined;
  let processBaseline: ProcessMetrics | undefined;
  let processEnd: ProcessMetrics | undefined;
  let resourceBaseline: ResourceMetrics | undefined;
  let resourceEnd: ResourceMetrics | undefined;
  const proxyStats: ProxyAccumulator = {
    connectionOpens: 0,
    connectionCloses: 0,
    bytesBrowserToServer: 0,
    bytesServerToBrowser: 0,
    faultEvents: 0,
  };
  const proxyListener = faultController.on((event) => recordProxyEvent(proxyStats, event));
  try {
    await page.setViewportSize(BROWSER_VIEWPORT);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const settings = await workbench.openSettings();
    await settings.setToggle("Tile new terminals", true);
    await expect(settings.root.getByRole("checkbox", { name: "Tile new terminals", exact: true })).toBeChecked();
    await settings.setCachedTerminalLimit(CACHE_LIMIT);
    await expect(settings.root.getByRole("slider", { name: "Terminals kept alive off screen", exact: true }))
      .toHaveValue(String(CACHE_LIMIT));
    await workbench.closeSettings();

    const excludedIds: string[] = [];
    for (let index = 0; index < TERMINAL_COUNT; index += 1) {
      const evicted = index >= CACHE_LIMIT ? terminals[index - CACHE_LIMIT] : undefined;
      const evictionPromise = evicted
        ? waitForTerminalEventAfter(page, evicted.id, lastEventId(await terminalEvents(page, evicted.id)), "unmount")
        : undefined;
      const mountPromise = waitForMountedPane(page, excludedIds);
      const createResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "POST"
          && url.pathname === "/api/terminals"
          && response.ok();
      });
      await workbench.createTerminal();
      const [, createResponse] = await Promise.all([mountPromise, createResponsePromise]);
      const payload = await createResponse.json() as { id?: unknown; name?: unknown };
      if (typeof payload.id !== "string" || typeof payload.name !== "string") {
        throw new Error("terminal creation response did not include an id and name");
      }
      const created: CreatedTerminal = { id: payload.id, name: payload.name };
      terminals.push(created);
      excludedIds.push(created.id);
      const pane = workbench.terminal(created.id, created.name);
      await pane.expectVisible();
      const initial = await waitForTerminalSettled(page, created.id, 0, true);
      expect(initial.serverViewport?.cols).toBe(initial.cols);
      expect(initial.serverViewport?.rows).toBe(initial.rows);
      expect(initial.serverViewport?.pixelWidth).toBe(initial.pixelWidth);
      expect(initial.serverViewport?.pixelHeight).toBe(initial.pixelHeight);

      const readyId = `${runTag}-READY-${index}`;
      const readyFloor = lastEventId(await terminalEvents(page, created.id));
      const readyCommitPromise = waitForTerminalEventAfter(page, created.id, readyFloor, "parser-commit");
      await pane.sendInput(`READY ${readyId}`, true);
      await server.waitForTranscript(created.id, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
      await waitForFixtureWrite(server, created.id, (entry) => typeof entry.text === "string" && entry.text.includes(marker("READY", readyId)));
      const readyCommit = await readyCommitPromise;
      const readyTranscript = await server.readTranscript(created.id);
      const readySequence = transcriptWriteBytes(readyTranscript);
      expect(requiredNumber(readyCommit.data.sequence, `${created.id} READY sequence`)).toBeGreaterThanOrEqual(readySequence);
      const readySnapshot = await waitForTerminalSettled(page, created.id, readySequence, true);
      expect(readySnapshot.xterm.text).toContain(marker("READY", readyId));

      const sizeId = `${runTag}-SIZE-${index}`;
      await pane.sendInput(`SIZE ${sizeId}`, true);
      const size = await server.waitForTranscript(created.id, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
      expect(size.rows).toBe(readySnapshot.rows);
      expect(size.cols).toBe(readySnapshot.cols);
      expect(size.pixel_width).toBe(readySnapshot.pixelWidth);
      expect(size.pixel_height).toBe(readySnapshot.pixelHeight);
      const sizeWrite = await waitForFixtureWrite(server, created.id, (entry) => typeof entry.text === "string" && entry.text.startsWith(marker("SIZE", sizeId)));
      expect(sizeWrite.text).toContain(marker("SIZE", sizeId));
      const afterSize = await waitForTerminalSettled(page, created.id, transcriptWriteBytes(await server.readTranscript(created.id)), true);
      expect(afterSize.serverViewport).toEqual(readySnapshot.serverViewport);
      if (evictionPromise) {
        const eviction = await evictionPromise;
        expect(eviction.snapshot.lifecycle.mounted).toBe(false);
        expect(eviction.snapshot.activeSocketCount).toBe(0);
      }
    }
    expect(terminals).toHaveLength(TERMINAL_COUNT);
    expect(await workbench.mountedPaneCount()).toBe(EXPECTED_MOUNTED_COUNT);
    expect(await workbench.visiblePaneCount()).toBe(VISIBLE_TERMINAL_COUNT);
    const configuredSnapshots = await readSnapshots(page);
    expect(configuredSnapshots.filter((snapshot) => snapshot.mounted)).toHaveLength(EXPECTED_MOUNTED_COUNT);
    expect(configuredSnapshots.filter((snapshot) => snapshot.visible && !snapshot.cached)).toHaveLength(VISIBLE_TERMINAL_COUNT);
    expect(configuredSnapshots.filter((snapshot) => snapshot.cached && !snapshot.visible)).toHaveLength(EXPECTED_MOUNTED_COUNT - VISIBLE_TERMINAL_COUNT);

    const anchor = terminals.at(-1);
    if (!anchor) throw new Error("S-02 did not create an anchor terminal");
    const anchorPane = workbench.terminal(anchor.id, anchor.name);
    await anchorPane.expectVisible();
    await waitForTerminalSettled(page, anchor.id, transcriptWriteBytes(await server.readTranscript(anchor.id)), true);

    resourceBaseline = await readResourceMetrics(page, configuredSnapshots);
    processBaseline = await aggregateProcessMetrics(page, terminals);

    const recordingSettings = await workbench.openSettings();
    await recordingSettings.startRecording();
    await expect(recordingSettings.root.getByRole("button", { name: "Stop recording", exact: true })).toBeVisible();
    await workbench.closeSettings();
    await beginAndRelease(anchorPane, server, anchor.id, `${runTag}-BEGIN`);
    await waitForTerminalSettled(page, anchor.id, transcriptWriteBytes(await server.readTranscript(anchor.id)), true);

    performanceStart = await startPerformanceMetrics(page);
    const scheduleStart = Date.now();
    const checkpointByTerminal = new Map<string, CheckpointMetric[]>();
    for (const terminal of terminals) checkpointByTerminal.set(terminal.id, []);

    await waitForWallClockBoundary(scheduleStart + INITIAL_BURST_OFFSET_MS);
    await processBurst(page, workbench, server, anchor, `${runTag}-BURST-${TERMINAL_COUNT - 1}`, checkpoints, bursts);
    checkpointByTerminal.get(anchor.id)?.push(checkpoints.at(-1)!);
    for (let index = 0; index < terminals.length - 1; index += 1) {
      await waitForWallClockBoundary(scheduleStart + INITIAL_BURST_OFFSET_MS + INITIAL_BURST_STEP_MS * (index + 1));
      const terminal = terminals[index]!;
      await processBurst(page, workbench, server, terminal, `${runTag}-BURST-${index}`, checkpoints, bursts);
      checkpointByTerminal.get(terminal.id)?.push(checkpoints.at(-1)!);
      await workbench.openTerminal(anchor);
      await anchorPane.expectVisible();
      await waitForTerminalSettled(page, anchor.id, transcriptWriteBytes(await server.readTranscript(anchor.id)), true);
    }
    expect(bursts).toHaveLength(TERMINAL_COUNT);
    expect(new Set(bursts.map((burst) => burst.terminalId)).size).toBe(TERMINAL_COUNT);

    for (let revealIndex = 0; revealIndex < SOAK_DURATION_MS / REVEAL_INTERVAL_MS; revealIndex += 1) {
      await waitForWallClockBoundary(scheduleStart + REVEAL_INTERVAL_MS * (revealIndex + 1));
      const terminal = await currentHiddenTerminal(page, terminals, anchor.id, revealIndex);
      const beforeSnapshot = await readSnapshot(page, terminal.id);
      if (!beforeSnapshot || !beforeSnapshot.mounted || !beforeSnapshot.cached || beforeSnapshot.visible) {
        throw new Error(`S-02 reveal target ${terminal.id} was not a hidden cached pane at its scheduled boundary`);
      }
      const revealStart = await page.evaluate(() => performance.now());
      const pane = await workbench.openTerminal(terminal);
      await pane.expectVisible();
      const revealed = await waitForTerminalSettled(page, terminal.id, beforeSnapshot.committedSequence ?? 0, true);
      expect(revealed.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true, acceptingInput: true });
      const viewport = pane.xtermHost.locator(".xterm-screen");
      await expect(viewport).toBeVisible();
      const beforePixels = await screenshotRegion(page, viewport);

      const printId = `${runTag}-REVEAL-${revealIndex}`;
      const printText = `${runTag}-REVEAL-TEXT-${revealIndex}`;
      const printFloor = lastEventId(await terminalEvents(page, terminal.id));
      const printCommitPromise = waitForTerminalEventAfter(page, terminal.id, printFloor, "parser-commit");
      const printRenderPromise = waitForTerminalEventAfter(page, terminal.id, printFloor, "render");
      const printCheckpointPromise = waitForCheckpointAfter(page, terminal.id, printFloor);
      await pane.sendInput(`PRINT ${printId} ${printText}`, true);
      await server.waitForTranscript(terminal.id, (entry) => entry.event === "print" && entry.id === printId && entry.text === printText, { timeoutMs: WAIT_TIMEOUT_MS });
      await waitForFixtureWrite(server, terminal.id, (entry) => entry.text === `${marker("PRINT", printId, printText)}\n`);
      const afterPrintTranscript = await server.readTranscript(terminal.id);
      const printSequence = transcriptWriteBytes(afterPrintTranscript);
      const printCommit = await printCommitPromise;
      await printRenderPromise;
      expect(requiredNumber(printCommit.data.sequence, `${terminal.id} reveal parser sequence`)).toBeGreaterThanOrEqual(printSequence);
      await expectTerminalBuffer(page, terminal.id, { contains: marker("PRINT", printId, printText), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
      const { after: afterPixels } = await expectKnownMarkerChanged(page, viewport, beforePixels, {
        minimumChangedRatio: 0.0002,
        testInfo,
        artifactName: `s02-reveal-${revealIndex}-marker`,
      });
      await expectTerminalNonBlank(page, viewport, {
        minimumNonBackgroundRatio: 0.001,
        testInfo,
        artifactName: `s02-reveal-${revealIndex}-terminal`,
      });
      const revealLatencyMs = (await page.evaluate(() => performance.now())) - revealStart;
      expect(revealLatencyMs).toBeGreaterThanOrEqual(0);
      expect(afterPixels.width).toBe(beforePixels.width);
      expect(afterPixels.height).toBe(beforePixels.height);
      const printCheckpoint = checkpointFromEvent(terminal.id, await printCheckpointPromise);
      expect(printCheckpoint.sequence).toBeGreaterThanOrEqual(printSequence);
      checkpoints.push(printCheckpoint);
      checkpointByTerminal.get(terminal.id)?.push(printCheckpoint);

      const echoId = `${runTag}-ECHO-${revealIndex}`;
      const echoPayload = `${runTag}-INPUT-${revealIndex}`;
      const echoEventFloor = lastEventId(await terminalEvents(page, terminal.id));
      await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
      await server.waitForTranscript(terminal.id, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
      const inputStart = Date.now();
      await pane.insertText(echoPayload);
      await pane.press("Enter");
      const echoEntry = await server.waitForTranscript(terminal.id, (entry) => (
        entry.event === "echo_input"
        && entry.id === echoId
        && entry.phase === "payload"
        && entry.payload_base64 === Buffer.from(echoPayload, "utf8").toString("base64")
      ), { timeoutMs: WAIT_TIMEOUT_MS });
      expect(echoEntry.payload_base64).toBe(Buffer.from(echoPayload, "utf8").toString("base64"));
      await waitForFixtureWrite(server, terminal.id, (entry) => entry.text === `${marker("ECHO_INPUT", echoId, Buffer.from(echoPayload, "utf8").toString("base64"))}\n`);
      const echoTranscript = await server.readTranscript(terminal.id);
      const echoSequence = transcriptWriteBytes(echoTranscript);
      const echoCheckpointPromise = waitForCheckpointAfter(page, terminal.id, echoEventFloor, echoSequence);
      await expectTerminalBuffer(page, terminal.id, {
        contains: marker("ECHO_INPUT", echoId, Buffer.from(echoPayload, "utf8").toString("base64")),
        occurrences: 1,
      }, { timeout: WAIT_TIMEOUT_MS });
      const echoSettled = await waitForTerminalSettled(page, terminal.id, echoSequence, true);
      const echoCheckpoint = checkpointFromEvent(terminal.id, await echoCheckpointPromise);
      expect(echoCheckpoint.sequence).toBeGreaterThanOrEqual(echoSequence);
      checkpoints.push(echoCheckpoint);
      checkpointByTerminal.get(terminal.id)?.push(echoCheckpoint);
      reveals.push({
        index: revealIndex,
        terminalId: terminal.id,
        revealLatencyMs,
        printCheckpointSerializationDurationMs: printCheckpoint.serializationDurationMs,
        printCheckpointUploadDurationMs: printCheckpoint.uploadDurationMs,
        inputRoundTripMs: Date.now() - inputStart,
      });
      expect(echoSettled.committedSequence).toBe(echoSequence);
      await workbench.openTerminal(anchor);
      await anchorPane.expectVisible();
      await waitForTerminalSettled(page, anchor.id, transcriptWriteBytes(await server.readTranscript(anchor.id)), true);
    }

    await waitForWallClockBoundary(scheduleStart + SOAK_DURATION_MS);
    await beginAndRelease(anchorPane, server, anchor.id, `${runTag}-END`);
    await waitForTerminalSettled(page, anchor.id, transcriptWriteBytes(await server.readTranscript(anchor.id)), true);
    performanceEnd = await finishPerformanceMetrics(page);
    resourceEnd = await readResourceMetrics(page, await readSnapshots(page));
    processEnd = await aggregateProcessMetrics(page, terminals);

    const recordingSettingsAtEnd = await workbench.openSettings();
    await recordingSettingsAtEnd.stopRecording();
    await expect(recordingSettingsAtEnd.root.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
    recording = await exportDebugRecording(page);
    expect(recording.truncated).toBe(false);
    await workbench.showTerminals();

    const currentSnapshots = await readSnapshots(page);
    expect(currentSnapshots.filter((snapshot) => snapshot.visible && !snapshot.cached)).toHaveLength(VISIBLE_TERMINAL_COUNT);
    expect(currentSnapshots.filter((snapshot) => snapshot.cached && !snapshot.visible)).toHaveLength(CACHE_LIMIT - VISIBLE_TERMINAL_COUNT);
    expect(currentSnapshots).toHaveLength(EXPECTED_MOUNTED_COUNT);
    expect(currentSnapshots.filter((snapshot) => snapshot.active)).toHaveLength(1);
    expect(currentSnapshots.filter((snapshot) => snapshot.focused)).toHaveLength(1);
    for (const snapshot of currentSnapshots) {
      expect(snapshot.activeSocketCount).toBe(1);
      expect(snapshot.socket.activeCount).toBe(1);
      expect(snapshot.socketState).toBe("connected");
      expect(snapshot.socketGeneration).toBeGreaterThan(0);
      expect(snapshot.pendingParserWrites).toBe(0);
      expect(snapshot.pendingParserBytes).toBe(0);
      expect(snapshot.renderBacklogBytes).toBe(0);
      expect(snapshot.renderBacklogFrames).toBe(0);
      expect(snapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
      const transcript = await server.readTranscript(snapshot.terminalId);
      expect(snapshot.receivedSequence).toBe(transcriptWriteBytes(transcript));
      expect(snapshot.committedSequence).toBe(transcriptWriteBytes(transcript));
      expect(snapshot.syncTarget === undefined || snapshot.committedSequence === undefined || snapshot.committedSequence >= snapshot.syncTarget).toBe(true);
      expect(snapshot.xterm.text).toContain(marker("READY", `${runTag}-READY-${terminals.findIndex((terminal) => terminal.id === snapshot.terminalId)}`));
      await assertMonotonicSequences(await terminalEvents(page, snapshot.terminalId));
      const report = await expectTerminalInvariants(page, snapshot.terminalId, { timeout: WAIT_TIMEOUT_MS });
      expect(report.violations).toEqual([]);
      await expectNoPendingRecovery(page, snapshot.terminalId, { timeout: WAIT_TIMEOUT_MS });
      if (snapshot.cached) {
        const hiddenSentViewportEvents = (await terminalEvents(page, snapshot.terminalId)).filter((event) => event.type === "viewport" && event.snapshot.cached && event.data.source === "sent");
        expect(hiddenSentViewportEvents).toHaveLength(0);
      }
    }
    const activeSnapshot = currentSnapshots.find((snapshot) => snapshot.active);
    if (!activeSnapshot) throw new Error("S-02 has no active terminal after the final reveal");
    const activeInvariant = await expectConnectedTerminalInvariants(page, activeSnapshot.terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(activeInvariant.violations).toEqual([]);

    const terminalIds = new Set(terminals.map((terminal) => terminal.id));
    expect(new Set(bursts.map((burst) => burst.terminalId))).toEqual(terminalIds);
    for (const terminal of terminals) {
      const transcript = await server.readTranscript(terminal.id);
      expect(transcript.filter((entry) => entry.event === "burst" && entry.bytes === BURST_BYTES && entry.line_width === BURST_LINE_WIDTH)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
      const burst = bursts.find((candidate) => candidate.terminalId === terminal.id);
      if (!burst) throw new Error(`S-02 did not record BURST metrics for ${terminal.id}`);
      expect(burst.sha256).toBe(expectedBurstSha256(BURST_BYTES));
      expect(transcript.filter((entry) => entry.event === "echo_input" && entry.phase === "payload")).toHaveLength(reveals.filter((reveal) => reveal.terminalId === terminal.id).length);
      expect(checkpointByTerminal.get(terminal.id)?.length ?? 0).toBeGreaterThan(0);
      expect(checkpointNotes(recording, terminal.id).length).toBeGreaterThan(0);
    }

    expect(reveals).toHaveLength(SOAK_DURATION_MS / REVEAL_INTERVAL_MS);
    expect(reveals.every((reveal) => reveal.revealLatencyMs >= 0)).toBe(true);
    expect(reveals.every((reveal) => reveal.inputRoundTripMs >= 0)).toBe(true);
    expect(checkpoints.length).toBeGreaterThanOrEqual(TERMINAL_COUNT);
    expect(checkpoints.every((checkpoint) => checkpoint.size > 0 && checkpoint.size <= MAX_CHECKPOINT_BYTES)).toBe(true);
    expect(checkpoints.every((checkpoint) => checkpoint.chunks === Math.ceil(checkpoint.size / TERMINAL_CHECKPOINT_CHUNK_BYTES))).toBe(true);
    expect(checkpoints.every((checkpoint) => checkpoint.serializationDurationMs >= 0 && checkpoint.uploadDurationMs >= 0)).toBe(true);

    const startMetrics = performanceStart;
    const performanceMetrics = performanceEnd;
    if (!startMetrics || !performanceMetrics) throw new Error("S-02 performance window was not completed");
    const measuredLongTasks = performanceMetrics.longTasks.filter((entry) => entry.startTime >= startMetrics.startTime && entry.startTime <= performanceMetrics.endTime);
    expect(measuredLongTasks.every((entry) => Number.isFinite(entry.startTime) && Number.isFinite(entry.duration) && entry.duration >= 0)).toBe(true);
    if (!performanceMetrics.supported) {
      testInfo.annotations.push({ type: "capability", description: "S-02 browser does not expose PerformanceObserver longtask entries" });
    }
    if (startMetrics.heapUsedBytes === undefined || performanceMetrics.heapUsedBytes === undefined) {
      testInfo.annotations.push({ type: "capability", description: "S-02 browser does not expose performance.memory usedJSHeapSize" });
    } else {
      expect(startMetrics.heapUsedBytes).toBeGreaterThanOrEqual(0);
      expect(performanceMetrics.heapUsedBytes).toBeGreaterThanOrEqual(0);
    }
    if (!processBaseline?.supported || !processEnd?.supported) {
      testInfo.annotations.push({ type: "capability", description: "S-02 process inspector did not expose Linux CPU/RSS samples" });
    }
    expect(resourceBaseline).toBeDefined();
    expect(resourceEnd).toBeDefined();
    if (!resourceBaseline || !resourceEnd || !processBaseline || !processEnd) throw new Error("S-02 resource metrics were not captured");
    expect(resourceEnd.mountedCount).toBe(EXPECTED_MOUNTED_COUNT);
    expect(resourceEnd.socketCount).toBe(EXPECTED_MOUNTED_COUNT);
    expect(resourceEnd.canvasCount).toBeLessThanOrEqual(resourceEnd.mountedCount * 4);

    const recordingExport = recording;
    if (!recordingExport) throw new Error("S-02 debug recording export was not captured");
    const checkpointDurations = checkpoints.map((checkpoint) => checkpoint.serializationDurationMs);
    const uploadDurations = checkpoints.map((checkpoint) => checkpoint.uploadDurationMs);
    const revealLatencies = reveals.map((reveal) => reveal.revealLatencyMs);
    const inputRtts = reveals.map((reveal) => reveal.inputRoundTripMs);
    await testInfo.attach("s-02-metrics.json", {
      body: JSON.stringify({
        scenario: "S-02 Busy cached workspace",
        tier: "scheduled-soak",
        seed: RUN_SEED,
        runTag,
        schedule: {
          durationMs: SOAK_DURATION_MS,
          initialBurstOffsetMs: INITIAL_BURST_OFFSET_MS,
          initialBurstStepMs: INITIAL_BURST_STEP_MS,
          revealIntervalMs: REVEAL_INTERVAL_MS,
          terminalCount: TERMINAL_COUNT,
          visibleCount: VISIBLE_TERMINAL_COUNT,
          cacheLimit: CACHE_LIMIT,
        },
        checkpoint: {
          count: checkpoints.length,
          serializationP50Ms: percentile(checkpointDurations, 0.5),
          serializationP95Ms: percentile(checkpointDurations, 0.95),
          serializationMaxMs: Math.max(...checkpointDurations),
          uploadP50Ms: percentile(uploadDurations, 0.5),
          uploadP95Ms: percentile(uploadDurations, 0.95),
          uploadMaxMs: Math.max(...uploadDurations),
          samples: checkpoints,
        },
        reveal: {
          count: reveals.length,
          latencyP50Ms: percentile(revealLatencies, 0.5),
          latencyP95Ms: percentile(revealLatencies, 0.95),
          latencyMaxMs: Math.max(...revealLatencies),
          inputRttP50Ms: percentile(inputRtts, 0.5),
          inputRttP95Ms: percentile(inputRtts, 0.95),
          inputRttMaxMs: Math.max(...inputRtts),
          samples: reveals,
        },
        browser: {
          longTaskSupported: performanceMetrics.supported,
          longTaskCount: measuredLongTasks.length,
          longTaskMaxMs: measuredLongTasks.reduce((maximum, entry) => Math.max(maximum, entry.duration), 0),
          heapBeforeBytes: startMetrics.heapUsedBytes,
          heapAfterBytes: performanceMetrics.heapUsedBytes,
          heapDeltaBytes: startMetrics.heapUsedBytes !== undefined && performanceMetrics.heapUsedBytes !== undefined
            ? performanceMetrics.heapUsedBytes - startMetrics.heapUsedBytes
            : undefined,
        },
        proxy: proxyStats,
        process: { baseline: processBaseline, end: processEnd },
        resources: { baseline: resourceBaseline, end: resourceEnd },
        fixture: {
          bursts,
          terminals: terminals.map((terminal) => ({ id: terminal.id, name: terminal.name })),
        },
        serverRecording: {
          eventCount: recordingExport.events.length,
          serializedBytes: recordingBytes(recordingExport),
          checkpointNoteCount: terminals.reduce((total, terminal) => total + checkpointNotes(recordingExport, terminal.id).length, 0),
          truncated: recordingExport.truncated,
        },
        comparison: { status: "baseline", key: `${testInfo.project.name}:${RUN_SEED}` },
      }, null, 2),
      contentType: "application/json",
    });

    const proxyEvents = faultController.events;
    expect(proxyEvents.filter((event) => event.type === "malformed-frame" || event.type === "socket-error")).toHaveLength(0);
    expect(proxyEvents.filter((event) => event.type === "paused" || event.type === "dropped" || event.type === "injected")).toHaveLength(0);
    expect(proxyStats.faultEvents).toBe(0);

    for (const terminal of terminals) await removeTerminalAndFixture(page, workbench, server, terminal);
    const remainingTerminals = await page.evaluate(async () => {
      const response = await fetch("/api/terminals", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`final terminal listing failed with HTTP ${response.status}`);
      return await response.json() as unknown[];
    });
    expect(remainingTerminals).toHaveLength(0);
    await expect(page.locator(".editor-grid canvas")).toHaveCount(0);
    expect(await workbench.mountedPaneCount()).toBe(0);
    expect(await readSnapshots(page)).toHaveLength(0);
    for (const terminal of terminals) {
      const transcript = await server.readTranscript(terminal.id);
      expect(transcript.filter((entry) => entry.event === "exit_requested" && entry.code === 0)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "exit" && entry.code === 0)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
    }

    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || entry.kind === "console" && /^error:/i.test(entry.message)
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  } finally {
    proxyListener.dispose();
    browserErrors.dispose();
  }
});
