import { Buffer } from "node:buffer";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import {
  installBrowserErrorCollectors,
  type BrowserErrorCollector,
} from "../fixtures/artifacts.js";
import type {
  NetworkFaultController,
  NetworkFaultDisposer,
  NetworkFaultEvent,
} from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 45_000;
const SOAK_DURATION_MS = 30 * 60_000;
const CYCLE_DURATION_MS = 5 * 60_000;
const CYCLE_COUNT = 6;
const BURST_FIRST_OFFSET_MS = 5_000;
const BURST_PERIOD_MS = 5_000;
const BURST_BYTES = 32_768;
const BURST_LINE_WIDTH = 96;
const BURST_COUNT = Math.floor((SOAK_DURATION_MS - BURST_FIRST_OFFSET_MS - 1) / BURST_PERIOD_MS) + 1;
const METRICS_KEY = "__TERM_SERVER_E2E_S05_METRICS__";

const FAULT_OFFSETS = Object.freeze({
  pause: 60_000,
  pauseRestore: 62_000,
  terminate: 120_000,
  drop: 180_000,
  dropRestore: 183_000,
  syncTerminate: 240_000,
});

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

type JsonObject = Record<string, unknown>;
type DiagnosticEventType = E2ETerminalEvent["type"];

type MetricDistribution = {
  readonly status: "ok";
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
};

type UnavailableMetric = {
  readonly status: "na";
  readonly reason: string;
};

type Metric = MetricDistribution | UnavailableMetric;

type BrowserPerformance = {
  readonly supported: boolean;
  readonly longTaskCount: number;
  readonly maxLongTaskDurationMs: number;
  readonly totalLongTaskDurationMs: number;
};

type BrowserResources = {
  readonly canvasCount: number;
  readonly canvasPixels: number;
  readonly heapUsedBytes?: number;
};

type RecordingStatus = {
  readonly active: boolean;
  readonly events: number;
  readonly bytes: number;
  readonly truncated: boolean;
};

type RecoveryMetrics = {
  readonly socketGeneration: number;
  readonly closeTimestamp: number;
  readonly syncedTimestamp: number;
  readonly syncMode: "snapshot" | "resume";
  readonly snapshot: E2ETerminalSnapshot;
};

type SyncCloseRecord = {
  readonly cycle: number;
  readonly scheduledOffsetMs: number;
  readonly targetGeneration: number;
  readonly armedAt: number;
  observedAt?: number;
  closeCode?: number;
  abrupt?: boolean;
  pending?: boolean;
};

type FaultCycleRecord = {
  readonly cycle: number;
  readonly scheduled: {
    readonly pauseAtMs: number;
    readonly pauseRestoreAtMs: number;
    readonly terminateAtMs: number;
    readonly dropAtMs: number;
    readonly dropRestoreAtMs: number;
    readonly syncTerminateAtMs: number;
  };
  pause?: { readonly generation: number; readonly pausedAt: number; readonly resumedAt: number };
  drop?: { readonly generation: number; readonly droppedAt: number; readonly restoredAt: number };
  terminate?: { readonly generation: number; readonly closeCode: number; readonly abrupt: boolean };
  syncClose?: SyncCloseRecord;
};

type BurstPlan = {
  readonly index: number;
  readonly offsetMs: number;
  readonly id: string;
  readonly text: string;
  readonly line: string;
};

type InputMeasurement = {
  readonly cycle: number;
  readonly fault: "pause" | "drop" | "terminate" | "sync-terminate";
  readonly id: string;
  readonly marker: string;
  readonly latencyMs: number;
};

type RecordingSummary = {
  readonly outputBytes: number;
  readonly snapshotBytes: number;
  readonly outputEvents: number;
  readonly snapshotEvents: number;
  readonly connectEvents: number;
  readonly disconnectEvents: number;
  readonly resumeSyncEvents: number;
  readonly snapshotSyncEvents: number;
  readonly exportValue: unknown;
};

function safeMarker(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function runTag(testInfo: TestInfo): string {
  return safeMarker(
    `S05-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`,
  );
}

function marker(operation: string, id: string, ...fields: string[]): string {
  return `[E2E:${operation}:${id}${fields.length > 0 ? `:${fields.join(":")}` : ""}]`;
}

function outputByteCount(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.event !== "write") return total;
    const bytes = entry.bytes;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("S-05 fixture write entry omitted a non-negative byte count");
    }
    return total + bytes;
  }, 0);
}

function countEntries(entries: readonly TranscriptEntry[], predicate: (entry: TranscriptEntry) => boolean): number {
  return entries.reduce((count, entry) => count + (predicate(entry) ? 1 : 0), 0);
}

function eventGeneration(event: E2ETerminalEvent): number {
  const generation = event.data.generation;
  return typeof generation === "number" ? generation : event.snapshot.socketGeneration;
}

function numberField(value: JsonObject, key: string, label = key): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`${label} was not a finite number`);
  return field;
}

function safeIntegerField(value: JsonObject, key: string, label = key): number {
  const field = numberField(value, key, label);
  if (!Number.isSafeInteger(field)) throw new Error(`${label} was not a safe integer`);
  return field;
}

function booleanField(value: JsonObject, key: string, label = key): boolean {
  const field = value[key];
  if (typeof field !== "boolean") throw new Error(`${label} was not a boolean`);
  return field;
}

function stringField(value: JsonObject, key: string, label = key): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`${label} was not a string`);
  return field;
}

function objectField(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as JsonObject;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error("cannot calculate a percentile for an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function distribution(values: readonly number[], label: string): MetricDistribution {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (finite.length === 0) throw new Error(`${label} did not produce a finite sample`);
  return {
    status: "ok",
    count: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: Math.max(...finite),
  };
}

function unavailable(reason: string): UnavailableMetric {
  return { status: "na", reason };
}

function waitForScheduleOffset(startedAt: number, offsetMs: number): Promise<void> {
  const target = startedAt + offsetMs;
  const delay = target - Date.now();
  if (delay <= 0) return Promise.resolve();
  // This is the deterministic schedule boundary. It is not a settle delay or
  // retry: every phase has an absolute wall-clock offset and event barriers
  // determine completion after the boundary fires.
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delay);
  });
}

async function waitForMountedPane(page: Page): Promise<E2ETerminalEvent> {
  return page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.snapshot.kind === "pane",
      { timeout },
    );
  }, WAIT_TIMEOUT_MS);
}


async function waitForDiagnosticEventMatch(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: DiagnosticEventType,
  options: {
    readonly generation?: number;
    readonly minimumGeneration?: number;
    readonly state?: string;
  } = {},
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, generation, minimumGeneration, state, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.id <= after || event.type !== eventType) return false;
      const eventGeneration = typeof event.data.generation === "number"
        ? event.data.generation
        : event.snapshot.socketGeneration;
      if (generation !== undefined && eventGeneration !== generation) return false;
      if (minimumGeneration !== undefined && eventGeneration < minimumGeneration) return false;
      return state === undefined || event.data.state === state;
    }, { timeout });
  }, {
    id: terminalId,
    after: afterEventId,
    eventType: type,
    ...options,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForSyncAndInteractive(
  page: Page,
  terminalId: string,
  afterEventId: number,
  minimumGeneration: number,
): Promise<{ readonly sync: E2ETerminalEvent; readonly synced: E2ETerminalEvent; readonly snapshot: E2ETerminalSnapshot }> {
  const syncPromise = waitForDiagnosticEventMatch(page, terminalId, afterEventId, "sync", { minimumGeneration });
  const syncedPromise = waitForDiagnosticEventMatch(page, terminalId, afterEventId, "synced", { minimumGeneration });
  const synced = await syncedPromise;
  const sync = await syncPromise;
  const snapshot = await page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (candidate) => (
      candidate.socketGeneration >= generation
      && candidate.socketState === "connected"
      && candidate.activeSocketCount === 1
      && candidate.acceptingInput
      && candidate.pendingParserWrites === 0
      && candidate.pendingParserBytes === 0
      && candidate.renderBacklogBytes === 0
      && candidate.renderBacklogFrames === 0
      && (candidate.syncTarget === undefined
        || candidate.committedSequence === undefined
        || candidate.committedSequence >= candidate.syncTarget)
    ), { timeout });
  }, { id: terminalId, generation: minimumGeneration, timeout: WAIT_TIMEOUT_MS });
  return { sync, synced, snapshot };
}

async function waitForProxyEvent(
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
  type: NetworkFaultEvent["type"],
  direction?: NetworkFaultEvent["direction"],
): Promise<NetworkFaultEvent> {
  return faultController.waitFor((event) => (
    event.type === type
    && event.terminalId === terminalId
    && event.generation === generation
    && (direction === undefined || event.direction === direction)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

async function snapshotOrThrow(page: Page, terminalId: string, label: string): Promise<E2ETerminalSnapshot> {
  const snapshot = await terminalSnapshot(page, terminalId);
  if (!snapshot) throw new Error(`S-05 ${label} diagnostics snapshot disappeared`);
  return snapshot;
}

async function waitForRenderedMarker(
  page: Page,
  terminalId: string,
  afterEventId: number,
  markerText: string,
  previousRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, after, marker, renderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > renderCount
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.xterm.text.includes(marker)
      && api.events(id).some((event) => event.id > after && event.type === "render")
    ), { timeout });
  }, { id: terminalId, after: afterEventId, marker: markerText, renderCount: previousRenderCount, timeout: WAIT_TIMEOUT_MS });
}

async function beginBrowserPerformance(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    const supported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const metrics = { supported, longTasks: [] as { startTime: number; duration: number }[] };
    target[key] = metrics;
    if (!supported) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) metrics.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    observer.observe({ type: "longtask", buffered: true });
    target[`${key}:observer`] = observer;
  }, METRICS_KEY);
}

async function finishBrowserPerformance(page: Page): Promise<BrowserPerformance> {
  const result = await page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const value = target[key] as { supported?: unknown; longTasks?: unknown } | undefined;
    if (!value || typeof value.supported !== "boolean" || !Array.isArray(value.longTasks)) {
      throw new Error("S-05 browser performance metrics are unavailable");
    }
    return {
      supported: value.supported,
      longTasks: value.longTasks as { startTime: number; duration: number }[],
    };
  }, METRICS_KEY);
  await page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    delete target[`${key}:observer`];
    delete target[key];
  }, METRICS_KEY);
  const durations = result.longTasks.map((entry) => {
    if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.duration) || entry.duration < 0) {
      throw new Error("S-05 long-task metrics contained an invalid entry");
    }
    return entry.duration;
  });
  return {
    supported: result.supported,
    longTaskCount: durations.length,
    maxLongTaskDurationMs: Math.max(0, ...durations),
    totalLongTaskDurationMs: durations.reduce((total, duration) => total + duration, 0),
  };
}

async function readBrowserResources(page: Page): Promise<BrowserResources> {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>("canvas")];
    const memory = (performance as Performance & {
      memory?: { readonly usedJSHeapSize?: unknown };
    }).memory;
    const heapUsedBytes = typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : undefined;
    return {
      canvasCount: canvases.length,
      canvasPixels: canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0),
      ...(heapUsedBytes === undefined ? {} : { heapUsedBytes }),
    };
  });
}

async function controlRecording(page: Page, action: "start" | "stop"): Promise<RecordingStatus> {
  const value = await page.evaluate(async (requestedAction) => {
    const response = await fetch("/api/debug/recording", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: requestedAction }),
    });
    if (!response.ok) throw new Error(`S-05 recording ${requestedAction} failed with HTTP ${response.status}`);
    return await response.json() as unknown;
  }, action);
  const fields = objectField(value, "S-05 recording control response");
  return {
    active: booleanField(fields, "active"),
    events: safeIntegerField(fields, "events"),
    bytes: safeIntegerField(fields, "bytes"),
    truncated: booleanField(fields, "truncated"),
  };
}

async function readRecordingExport(page: Page): Promise<unknown> {
  const value = await page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export", { cache: "no-store" });
    if (!response.ok) throw new Error(`S-05 recording export failed with HTTP ${response.status}`);
    return await response.json() as unknown;
  });
  const fields = objectField(value, "S-05 recording export");
  if (!Array.isArray(fields.events)) throw new Error("S-05 recording export omitted server events");
  return value;
}

function summarizeRecording(exportValue: unknown, terminalId: string): RecordingSummary {
  const fields = objectField(exportValue, "S-05 recording export");
  const events = fields.events;
  if (!Array.isArray(events)) throw new Error("S-05 recording export events were not an array");
  const terminalEvents = events.map((event) => objectField(event, "S-05 server recording event"))
    .filter((event) => event.terminal === terminalId);
  const outputEvents = terminalEvents.filter((event) => event.type === "output");
  const snapshotEvents = terminalEvents.filter((event) => event.type === "snapshot");
  const bytesFor = (event: JsonObject): number => {
    const encoded = stringField(event, "data", "S-05 recording frame data");
    return Buffer.from(encoded, "base64").byteLength;
  };
  const outputBytes = outputEvents.reduce((total, event) => total + bytesFor(event), 0);
  const snapshotBytes = snapshotEvents.reduce((total, event) => total + bytesFor(event), 0);
  const controls = terminalEvents.filter((event) => event.type === "control");
  let resumeSyncEvents = 0;
  let snapshotSyncEvents = 0;
  for (const control of controls) {
    const message = objectField(control.message, "S-05 recording control message");
    if (message.type !== "sync") continue;
    if (message.mode === "resume") resumeSyncEvents += 1;
    if (message.mode === "snapshot") snapshotSyncEvents += 1;
  }
  return {
    outputBytes,
    snapshotBytes,
    outputEvents: outputEvents.length,
    snapshotEvents: snapshotEvents.length,
    connectEvents: terminalEvents.filter((event) => event.type === "connect").length,
    disconnectEvents: terminalEvents.filter((event) => event.type === "disconnect").length,
    resumeSyncEvents,
    snapshotSyncEvents,
    exportValue,
  };
}

async function sendEchoAfterRecovery(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  cycle: number,
  fault: InputMeasurement["fault"],
  runId: string,
  measurements: InputMeasurement[],
): Promise<void> {
  const id = `${runId}-ECHO-C${cycle}-${fault}`;
  const text = `${runId}-CONTINUED-${cycle}-${fault}`;
  const inputBase64 = Buffer.from(text, "utf8").toString("base64");
  const inputMarker = marker("ECHO_INPUT", id, inputBase64);
  await pane.sendInput(`ECHO_INPUT ${id}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === id && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const before = await snapshotOrThrow(page, terminalId, `${fault} input baseline`);
  const eventsBefore = await terminalEvents(page, terminalId);
  const eventFloor = eventsBefore.at(-1)?.id ?? 0;
  const rendered = waitForRenderedMarker(page, terminalId, eventFloor, inputMarker, before.renderCount);
  const startedAt = Date.now();
  await pane.sendInput(text, true);
  const echoed = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === id
      && entry.phase === "payload"
      && entry.payload_base64 === inputBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoed.payload_base64).toBe(inputBase64);
  await expectTerminalBuffer(page, terminalId, { contains: inputMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await rendered;
  measurements.push({
    cycle,
    fault,
    id,
    marker: inputMarker,
    latencyMs: Math.max(0, Date.now() - startedAt),
  });
}

async function runPauseFault(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  faultController: NetworkFaultController,
  cycle: number,
  startedAt: number,
  outputGate: OutputGate,
  runId: string,
  inputs: InputMeasurement[],
  currentSnapshot: { value?: E2ETerminalSnapshot },
): Promise<FaultCycleRecord["pause"]> {
  await waitForScheduleOffset(startedAt, cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.pause);
  const current = await snapshotOrThrow(page, terminalId, `cycle ${cycle} pause baseline`);
  const generation = current.socketGeneration;
  outputGate.block();
  const paused = waitForProxyEvent(faultController, terminalId, generation, "paused", "server-to-browser");
  const rule = faultController.pause("server-to-browser", { terminalId, generation });
  try {
    const pausedEvent = await paused;
    const resumed = waitForProxyEvent(faultController, terminalId, generation, "resumed", "server-to-browser");
    await waitForScheduleOffset(startedAt, cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.pauseRestore);
    faultController.resume("server-to-browser", { terminalId, generation });
    const resumedEvent = await resumed;
    expect(resumedEvent.direction).toBe("server-to-browser");
    const interactive = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    currentSnapshot.value = interactive;
    await sendEchoAfterRecovery(page, server, pane, terminalId, cycle, "pause", runId, inputs);
    return { generation, pausedAt: pausedEvent.at, resumedAt: resumedEvent.at };
  } finally {
    rule.dispose();
    outputGate.release();
  }
}

async function runDropFault(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  faultController: NetworkFaultController,
  cycle: number,
  startedAt: number,
  outputGate: OutputGate,
  runId: string,
  inputs: InputMeasurement[],
  currentSnapshot: { value?: E2ETerminalSnapshot },
): Promise<FaultCycleRecord["drop"]> {
  await waitForScheduleOffset(startedAt, cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.drop);
  const current = await snapshotOrThrow(page, terminalId, `cycle ${cycle} drop baseline`);
  const generation = current.socketGeneration;
  outputGate.block();
  const droppedBrowser = waitForProxyEvent(faultController, terminalId, generation, "dropped", "browser-to-server");
  const droppedServer = waitForProxyEvent(faultController, terminalId, generation, "dropped", "server-to-browser");
  const rule = faultController.drop({ terminalId, generation });
  try {
    const [browserDroppedEvent, serverDroppedEvent] = await Promise.all([droppedBrowser, droppedServer]);
    const restoredBrowser = waitForProxyEvent(faultController, terminalId, generation, "restored", "browser-to-server");
    const restoredServer = waitForProxyEvent(faultController, terminalId, generation, "restored", "server-to-browser");
    await waitForScheduleOffset(startedAt, cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.dropRestore);
    faultController.restore({ terminalId, generation });
    const [browserRestoredEvent, serverRestoredEvent] = await Promise.all([restoredBrowser, restoredServer]);
    expect(browserRestoredEvent.direction).toBe("browser-to-server");
    expect(serverRestoredEvent.direction).toBe("server-to-browser");
    const interactive = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    currentSnapshot.value = interactive;
    await sendEchoAfterRecovery(page, server, pane, terminalId, cycle, "drop", runId, inputs);
    return {
      generation,
      droppedAt: Math.min(browserDroppedEvent.at, serverDroppedEvent.at),
      restoredAt: Math.max(browserRestoredEvent.at, serverRestoredEvent.at),
    };
  } finally {
    rule.dispose();
    outputGate.release();
  }
}

async function runTerminateFault(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  faultController: NetworkFaultController,
  cycle: number,
  startedAt: number,
  outputGate: OutputGate,
  runId: string,
  inputs: InputMeasurement[],
  currentSnapshot: { value?: E2ETerminalSnapshot },
  syncCloseRules: Map<number, { readonly record: SyncCloseRecord; readonly disposer: NetworkFaultDisposer }>,
  reconnectDurations: number[],
  snapshotParseDurations: number[],
  recoveryMetrics: RecoveryMetrics[],
  recoveryModes: ("snapshot" | "resume")[],
): Promise<FaultCycleRecord["terminate"]> {
  await waitForScheduleOffset(startedAt, cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.terminate);
  const current = await snapshotOrThrow(page, terminalId, `cycle ${cycle} terminate baseline`);
  const previousGeneration = current.socketGeneration;
  const nextGeneration = previousGeneration + 1;
  const syncClose = syncCloseRules.get(nextGeneration);
  const hasSyncClose = syncClose !== undefined;
  const beforeEvents = await terminalEvents(page, terminalId);
  const eventFloor = beforeEvents.at(-1)?.id ?? 0;
  outputGate.block();

  const oldSocketClose = waitForDiagnosticEventMatch(page, terminalId, eventFloor, "socket-close", { generation: previousGeneration });
  const firstCreated = waitForDiagnosticEventMatch(page, terminalId, eventFloor, "socket-created", { generation: nextGeneration });
  const firstSync = waitForDiagnosticEventMatch(page, terminalId, eventFloor, "sync", { generation: nextGeneration });
  const firstProxyTermination = waitForProxyEvent(faultController, terminalId, previousGeneration, "connection-terminated");
  const terminateRule = faultController.terminate({ terminalId, generation: previousGeneration });

  try {
    const [oldClose, firstSocket, firstSyncEvent, firstProxy] = await Promise.all([
      oldSocketClose,
      firstCreated,
      firstSync,
      firstProxyTermination,
    ]);
    expect(eventGeneration(oldClose)).toBe(previousGeneration);
    expect(firstSocket.snapshot.socketGeneration).toBe(nextGeneration);
    expect(firstProxy.type).toBe("connection-terminated");
    expect(firstProxy.code).toBe(1006);
    expect(firstProxy.abrupt).toBe(true);
    const firstMode = firstSyncEvent.data.mode;
    if (firstMode !== "snapshot" && firstMode !== "resume") throw new Error("S-05 first recovery omitted a sync mode");
    recoveryModes.push(firstMode);

    let finalRecovery: { readonly sync: E2ETerminalEvent; readonly synced: E2ETerminalEvent; readonly snapshot: E2ETerminalSnapshot };
    if (hasSyncClose) {
      const firstClose = waitForDiagnosticEventMatch(page, terminalId, eventFloor, "socket-close", { generation: nextGeneration });
      const firstProxyClose = waitForProxyEvent(faultController, terminalId, nextGeneration, "connection-terminated");
      const finalGeneration = nextGeneration + 1;
      const finalRecoveryPromise = waitForSyncAndInteractive(page, terminalId, eventFloor, finalGeneration);
      const [interruptedClose, interruptedProxy] = await Promise.all([firstClose, firstProxyClose]);
      expect(interruptedProxy.type).toBe("connection-terminated");
      expect(interruptedProxy.code).toBe(1006);
      expect(interruptedProxy.abrupt).toBe(true);
      finalRecovery = await finalRecoveryPromise;
      const finalMode = finalRecovery.sync.data.mode;
      if (finalMode !== "snapshot" && finalMode !== "resume") throw new Error("S-05 post-sync recovery omitted a sync mode");
      recoveryModes.push(finalMode);
      syncClose.record.observedAt = interruptedProxy.at;
      syncClose.record.closeCode = interruptedProxy.code;
      syncClose.record.abrupt = interruptedProxy.abrupt;
      syncCloseRules.delete(nextGeneration);
      syncClose.disposer.dispose();
      reconnectDurations.push(Math.max(0, finalRecovery.synced.timestamp - oldClose.timestamp));
      reconnectDurations.push(Math.max(0, finalRecovery.synced.timestamp - interruptedClose.timestamp));
      snapshotParseDurations.push(Math.max(0, finalRecovery.synced.timestamp - finalRecovery.sync.timestamp));
      recoveryMetrics.push({
        socketGeneration: finalGeneration,
        closeTimestamp: interruptedClose.timestamp,
        syncedTimestamp: finalRecovery.synced.timestamp,
        syncMode: finalMode,
        snapshot: finalRecovery.snapshot,
      });
    } else {
      const firstSynced = waitForDiagnosticEventMatch(page, terminalId, eventFloor, "synced", { generation: nextGeneration });
      const firstRecovery = await waitForSyncAndInteractive(page, terminalId, eventFloor, nextGeneration);
      await firstSynced;
      finalRecovery = firstRecovery;
      const mode = finalRecovery.sync.data.mode;
      if (mode !== "snapshot" && mode !== "resume") throw new Error("S-05 recovery omitted a sync mode");
      // The first sync event was observed above; this mode is the same event
      // and is retained as the recovery sample for the reconnect metric.
      recoveryModes[recoveryModes.length - 1] = mode;
      reconnectDurations.push(Math.max(0, finalRecovery.synced.timestamp - oldClose.timestamp));
      snapshotParseDurations.push(Math.max(0, finalRecovery.synced.timestamp - finalRecovery.sync.timestamp));
      recoveryMetrics.push({
        socketGeneration: nextGeneration,
        closeTimestamp: oldClose.timestamp,
        syncedTimestamp: finalRecovery.synced.timestamp,
        syncMode: mode,
        snapshot: finalRecovery.snapshot,
      });
    }

    currentSnapshot.value = finalRecovery.snapshot;
    await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await sendEchoAfterRecovery(page, server, pane, terminalId, cycle, hasSyncClose ? "sync-terminate" : "terminate", runId, inputs);
    return {
      generation: previousGeneration,
      closeCode: firstProxy.code ?? 1006,
      abrupt: firstProxy.abrupt === true,
    };
  } finally {
    terminateRule.dispose();
    outputGate.release();
  }
}

async function armSyncTerminate(
  page: Page,
  terminalId: string,
  faultController: NetworkFaultController,
  cycle: number,
  startedAt: number,
  syncCloseRules: Map<number, { readonly record: SyncCloseRecord; readonly disposer: NetworkFaultDisposer }>,
): Promise<SyncCloseRecord> {
  await waitForScheduleOffset(startedAt, cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.syncTerminate);
  const current = await snapshotOrThrow(page, terminalId, `cycle ${cycle} sync-terminate baseline`);
  const targetGeneration = current.socketGeneration + 1;
  const record: SyncCloseRecord = {
    cycle,
    scheduledOffsetMs: cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.syncTerminate,
    targetGeneration,
    armedAt: Date.now(),
  };
  const disposer = faultController.terminate({
    terminalId,
    generation: targetGeneration,
    direction: "server-to-browser",
    jsonType: "sync",
  });
  syncCloseRules.set(targetGeneration, { record, disposer });
  return record;
}

class OutputGate {
  private blockedState = false;
  private readonly waiters = new Set<() => void>();

  block(): void {
    this.blockedState = true;
  }

  release(): void {
    this.blockedState = false;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async wait(): Promise<void> {
    if (!this.blockedState) return;
    await new Promise<void>((resolve) => this.waiters.add(resolve));
  }
}

async function runOutputSchedule(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  startedAt: number,
  outputGate: OutputGate,
  bursts: readonly BurstPlan[],
): Promise<void> {
  for (const burst of bursts) {
    await waitForScheduleOffset(startedAt, burst.offsetMs);
    await outputGate.wait();
    await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await pane.sendInput(`BURST ${burst.id} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "burst" && entry.id === burst.id && entry.bytes === BURST_BYTES && entry.line_width === BURST_LINE_WIDTH,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(`PRINT ${burst.id} ${burst.text}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === burst.id && entry.text === burst.text,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
  }
}

function diagnosticsPeakMetrics(events: readonly E2ETerminalEvent[]): {
  readonly pendingParserBytes: number;
  readonly pendingRenderBacklogBytes: number;
  readonly oldestRenderBacklogAgeMs: number;
} {
  return events.reduce((peak, event) => ({
    pendingParserBytes: Math.max(peak.pendingParserBytes, event.snapshot.pendingParserBytes),
    pendingRenderBacklogBytes: Math.max(peak.pendingRenderBacklogBytes, event.snapshot.renderBacklogBytes),
    oldestRenderBacklogAgeMs: Math.max(peak.oldestRenderBacklogAgeMs, event.snapshot.renderBacklogOldestAgeMs),
  }), { pendingParserBytes: 0, pendingRenderBacklogBytes: 0, oldestRenderBacklogAgeMs: 0 });
}

async function attachS05Artifacts(
  testInfo: TestInfo,
  schedule: readonly FaultCycleRecord[],
  metrics: JsonObject,
  networkEvents: readonly NetworkFaultEvent[],
  recording: RecordingSummary,
): Promise<void> {
  await testInfo.attach("s05-fault-schedule", {
    body: JSON.stringify({
      seed: "0x5105",
      durationMs: SOAK_DURATION_MS,
      cycleDurationMs: CYCLE_DURATION_MS,
      burst: {
        firstOffsetMs: BURST_FIRST_OFFSET_MS,
        periodMs: BURST_PERIOD_MS,
        count: BURST_COUNT,
        bytes: BURST_BYTES,
        lineWidth: BURST_LINE_WIDTH,
      },
      faults: schedule,
      controllerEvents: networkEvents,
    }, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("s05-metrics", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("s05-server-recording", {
    body: JSON.stringify(recording.exportValue, null, 2),
    contentType: "application/json",
  });
}

async function stopRecordingBestEffort(page: Page, active: { value: boolean }): Promise<void> {
  if (!active.value) return;
  try {
    await controlRecording(page, "stop");
  } catch {
    // Preserve the original scenario failure; the fixture teardown still
    // closes the isolated server and its recording manager.
  } finally {
    active.value = false;
  }
}

async function disposeMetricsObserver(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    delete target[`${key}:observer`];
    delete target[key];
  }, METRICS_KEY).catch(() => undefined);
}

test("S-05 Network instability @soak @S-05", async ({ page, server, faultController, baseURL }, testInfo) => {
  test.setTimeout(SOAK_DURATION_MS + 8 * WAIT_TIMEOUT_MS);
  const browserErrors: BrowserErrorCollector = installBrowserErrorCollectors(page);
  const runId = runTag(testInfo);
  const outputGate = new OutputGate();
  const currentSnapshot: { value?: E2ETerminalSnapshot } = {};
  const inputs: InputMeasurement[] = [];
  const reconnectDurations: number[] = [];
  const snapshotParseDurations: number[] = [];
  const recoveryMetrics: RecoveryMetrics[] = [];
  const recoveryModes: ("snapshot" | "resume")[] = [];
  const syncCloseRules = new Map<number, { readonly record: SyncCloseRecord; readonly disposer: NetworkFaultDisposer }>();
  const faultRecords: FaultCycleRecord[] = [];
  const recordingActive = { value: false };
  let performance: BrowserPerformance | undefined;
  let recordingSummary: RecordingSummary | undefined;
  let terminalId = "";
  let pane: TerminalPanePage | undefined;

  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const recording = await controlRecording(page, "start");
    expect(recording.active).toBe(true);
    recordingActive.value = true;
    await beginBrowserPerformance(page);

    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const mountedPromise = waitForMountedPane(page);
    await workbench.createTerminal();
    const mounted = await mountedPromise;
    terminalId = mounted.terminalId;
    pane = new TerminalPanePage(page, terminalId);
    await pane.expectVisible();
    await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

    const readyId = `${runId}-READY`;
    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: marker("READY", readyId), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const holdId = `${runId}-START-HOLD`;
    await pane.sendInput(`HOLD ${holdId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdId, { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.insertText(`RELEASE ${holdId}`);
    await pane.press("Enter");
    await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdId, { timeoutMs: WAIT_TIMEOUT_MS });

    const initialPrintId = `${runId}-INITIAL`;
    const initialText = `${runId}-INITIAL-MARKER`;
    const initialLine = marker("PRINT", initialPrintId, initialText);
    const beforePixels = await screenshotRegion(page, pane.xtermHost);
    await pane.sendInput(`PRINT ${initialPrintId} ${initialText}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === initialPrintId && entry.text === initialText, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: initialLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: "s05-initial-terminal",
    });

    const initial = await snapshotOrThrow(page, terminalId, "initial synchronization");
    currentSnapshot.value = initial;
    expect(initial.socketState).toBe("connected");
    expect(initial.activeSocketCount).toBe(1);
    expect(initial.gridEpoch).toEqual(expect.any(Number));
    const initialEvents = await terminalEvents(page, terminalId);
    const initialEventId = initialEvents.at(-1)?.id ?? mounted.id;

    const bursts: BurstPlan[] = Array.from({ length: BURST_COUNT }, (_, index) => {
      const id = `${runId}-BURST-${String(index).padStart(3, "0")}`;
      const text = `${runId}-BURST-${String(index).padStart(3, "0")}-MARKER`;
      return {
        index,
        offsetMs: BURST_FIRST_OFFSET_MS + index * BURST_PERIOD_MS,
        id,
        text,
        line: marker("PRINT", id, text),
      };
    });

    const scheduleStartedAt = Date.now();
    const faultSchedulePromise = (async (): Promise<void> => {
      for (let cycle = 0; cycle < CYCLE_COUNT; cycle += 1) {
        const record: FaultCycleRecord = {
          cycle,
          scheduled: {
            pauseAtMs: cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.pause,
            pauseRestoreAtMs: cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.pauseRestore,
            terminateAtMs: cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.terminate,
            dropAtMs: cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.drop,
            dropRestoreAtMs: cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.dropRestore,
            syncTerminateAtMs: cycle * CYCLE_DURATION_MS + FAULT_OFFSETS.syncTerminate,
          },
        };
        record.pause = await runPauseFault(
          page,
          server,
          pane!,
          terminalId,
          faultController,
          cycle,
          scheduleStartedAt,
          outputGate,
          runId,
          inputs,
          currentSnapshot,
        );
        record.terminate = await runTerminateFault(
          page,
          server,
          pane!,
          terminalId,
          faultController,
          cycle,
          scheduleStartedAt,
          outputGate,
          runId,
          inputs,
          currentSnapshot,
          syncCloseRules,
          reconnectDurations,
          snapshotParseDurations,
          recoveryMetrics,
          recoveryModes,
        );
        record.drop = await runDropFault(
          page,
          server,
          pane!,
          terminalId,
          faultController,
          cycle,
          scheduleStartedAt,
          outputGate,
          runId,
          inputs,
          currentSnapshot,
        );
        record.syncClose = await armSyncTerminate(
          page,
          terminalId,
          faultController,
          cycle,
          scheduleStartedAt,
          syncCloseRules,
        );
        faultRecords.push(record);
      }
    })();
    const outputSchedulePromise = runOutputSchedule(page, server, pane, terminalId, scheduleStartedAt, outputGate, bursts);
    await Promise.all([faultSchedulePromise, outputSchedulePromise]);
    await waitForScheduleOffset(scheduleStartedAt, SOAK_DURATION_MS);

    const finalPrintId = `${runId}-FINAL`;
    const finalText = `${runId}-FINAL-MARKER`;
    const finalLine = marker("PRINT", finalPrintId, finalText);
    const finalBeforePixels = await screenshotRegion(page, pane.xtermHost);
    const finalBeforeSnapshot = await snapshotOrThrow(page, terminalId, "before final marker");
    const finalBeforeEvents = await terminalEvents(page, terminalId);
    const finalRenderPromise = waitForRenderedMarker(page, terminalId, finalBeforeEvents.at(-1)?.id ?? initialEventId, finalLine, finalBeforeSnapshot.renderCount);
    await pane.sendInput(`PRINT ${finalPrintId} ${finalText}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === finalPrintId && entry.text === finalText, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: finalLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await finalRenderPromise;
    const finalAfterPixels = await screenshotRegion(page, pane.xtermHost);
    await expectTerminalPixelsChanged(finalBeforePixels, finalAfterPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "s05-final-marker-pixels",
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: "s05-final-terminal",
    });

    const sizeId = `${runId}-SIZE`;
    await pane.sendInput(`SIZE ${sizeId}`, true);
    const ptySize = await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const current = await expectTerminalConverged(page, terminalId, {
      cols: finalBeforeSnapshot.cols,
      rows: finalBeforeSnapshot.rows,
      pixelWidth: finalBeforeSnapshot.pixelWidth,
      pixelHeight: finalBeforeSnapshot.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    expect(ptySize.cols).toBe(current.cols);
    expect(ptySize.rows).toBe(current.rows);
    expect(ptySize.pixel_width).toBe(current.pixelWidth);
    expect(ptySize.pixel_height).toBe(current.pixelHeight);

    const finalTranscriptBeforeExit = await server.readTranscript(terminalId);
    expect(countEntries(finalTranscriptBeforeExit, (entry) => entry.event === "burst")).toBe(BURST_COUNT);
    expect(countEntries(finalTranscriptBeforeExit, (entry) => entry.event === "print" && entry.id === initialPrintId)).toBe(1);
    expect(countEntries(finalTranscriptBeforeExit, (entry) => entry.event === "print" && entry.id === finalPrintId)).toBe(1);
    for (const burst of bursts) {
      expect(countEntries(finalTranscriptBeforeExit, (entry) => entry.event === "burst" && entry.id === burst.id && entry.bytes === BURST_BYTES)).toBe(1);
      expect(countEntries(finalTranscriptBeforeExit, (entry) => entry.event === "print" && entry.id === burst.id && entry.text === burst.text)).toBe(1);
      await expectTerminalBuffer(page, terminalId, { contains: burst.line, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    }
    expect(countEntries(finalTranscriptBeforeExit, (entry) => entry.event === "error")).toBe(0);
    expect(finalTranscriptBeforeExit.some((entry) => entry.event === "exit")).toBe(false);

    const finalEventsBeforeExit = await terminalEvents(page, terminalId);
    await assertMonotonicSequences(finalEventsBeforeExit);
    const finalSnapshot = await snapshotOrThrow(page, terminalId, "final synchronized terminal");
    expect(finalSnapshot.socketState).toBe("connected");
    expect(finalSnapshot.activeSocketCount).toBe(1);
    expect(finalSnapshot.socket.activeCount).toBe(1);
    expect(finalSnapshot.acceptingInput).toBe(true);
    expect(finalSnapshot.pendingParserWrites).toBe(0);
    expect(finalSnapshot.pendingParserBytes).toBe(0);
    expect(finalSnapshot.renderBacklogBytes).toBe(0);
    expect(finalSnapshot.renderBacklogFrames).toBe(0);
    expect(finalSnapshot.renderBacklogOldestAgeMs).toBe(0);
    expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(finalSnapshot.gridEpoch).toEqual(expect.any(Number));
    expect(finalSnapshot.xterm.text).toContain(initialLine);
    expect(finalSnapshot.xterm.text).toContain(finalLine);
    expect(finalSnapshot.receivedSequence).toBe(outputByteCount(finalTranscriptBeforeExit));
    expect(finalSnapshot.committedSequence).toBe(outputByteCount(finalTranscriptBeforeExit));
    assertNoUnexpectedSocketMultiplication([initial, ...recoveryMetrics.map((sample) => sample.snapshot), finalSnapshot]);
    assertNoPendingSynchronization(finalSnapshot);
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);

    performance = await finishBrowserPerformance(page);
    const browserResources = await readBrowserResources(page);
    const peak = diagnosticsPeakMetrics(finalEventsBeforeExit);
    const syncEvents = finalEventsBeforeExit.filter((event) => event.type === "sync");
    const syncedEvents = finalEventsBeforeExit.filter((event) => event.type === "synced");
    const checkpointDurations = finalEventsBeforeExit
      .map((event) => event.snapshot.checkpointSerializationDurationMs)
      .filter((duration) => Number.isFinite(duration) && duration > 0);
    const serverExportBeforeStop = await controlRecording(page, "stop");
    recordingActive.value = false;
    expect(serverExportBeforeStop.active).toBe(false);
    recordingSummary = summarizeRecording(await readRecordingExport(page), terminalId);
    expect(recordingSummary.outputBytes).toBeGreaterThanOrEqual(outputByteCount(finalTranscriptBeforeExit));
    expect(recordingSummary.connectEvents).toBeGreaterThanOrEqual(1);
    expect(recordingSummary.disconnectEvents).toBeGreaterThanOrEqual(1);
    expect(recordingSummary.snapshotSyncEvents).toBeLessThanOrEqual(1);
    expect(recordingSummary.resumeSyncEvents).toBeGreaterThanOrEqual(recoveryModes.filter((mode) => mode === "resume").length);

    const durationHours = SOAK_DURATION_MS / 3_600_000;
    const metrics: JsonObject = {
      scenario: "S-05",
      tier: "scheduled-soak",
      project: testInfo.project.name,
      seed: "0x5105",
      durationMs: SOAK_DURATION_MS,
      scheduleStartedAt,
      burstCount: bursts.length,
      faultCycles: faultRecords.length,
      reconnectToInteractive: reconnectDurations.length > 0 ? distribution(reconnectDurations, "reconnect-to-interactive") : unavailable("no socket recovery completed"),
      resizeConvergence: unavailable("S-05 does not resize the terminal"),
      longTasks: {
        status: performance.supported ? "ok" : "na",
        ...(performance.supported
          ? {
            count: performance.longTaskCount,
            maxDurationMs: performance.maxLongTaskDurationMs,
            totalDurationMs: performance.totalLongTaskDurationMs,
          }
          : { reason: "PerformanceObserver longtask is unavailable in this browser" }),
      },
      checkpointSerialization: checkpointDurations.length > 0
        ? distribution(checkpointDurations, "checkpoint serialization")
        : unavailable("no checkpoint serialization event was committed"),
      snapshotParse: snapshotParseDurations.length > 0
        ? distribution(snapshotParseDurations, "snapshot parse")
        : unavailable("no recovery snapshot was required"),
      parserAndRenderBacklog: {
        peakPendingParserBytes: peak.pendingParserBytes,
        peakRenderBacklogBytes: peak.pendingRenderBacklogBytes,
        peakRenderBacklogAgeMs: peak.oldestRenderBacklogAgeMs,
        finalPendingParserBytes: finalSnapshot.pendingParserBytes,
        finalRenderBacklogBytes: finalSnapshot.renderBacklogBytes,
      },
      reconnectsPerHour: reconnectDurations.length / durationHours,
      snapshotsPerHour: recoveryModes.filter((mode) => mode === "snapshot").length / durationHours,
      browserHeap: browserResources.heapUsedBytes === undefined
        ? unavailable("performance.memory is unavailable in this browser")
        : { status: "ok", bytes: browserResources.heapUsedBytes },
      rendererResources: {
        renderer: finalSnapshot.renderer,
        webglLoadCount: finalSnapshot.webglLoadCount,
        contextLossCount: finalSnapshot.contextLossCount,
        fallbackCount: finalSnapshot.fallbackCount,
        renderCount: finalSnapshot.renderCount,
        canvasCount: browserResources.canvasCount,
        canvasPixels: browserResources.canvasPixels,
      },
      serverReplaySnapshotBytes: {
        replayBytes: recordingSummary.outputBytes,
        snapshotBytes: recordingSummary.snapshotBytes,
        outputEvents: recordingSummary.outputEvents,
        snapshotEvents: recordingSummary.snapshotEvents,
      },
      inputRoundTrip: inputs.length > 0 ? distribution(inputs.map((input) => input.latencyMs), "input round-trip") : unavailable("no continued input completed"),
      inputMeasurements: inputs,
      syncModes: {
        observed: recoveryModes,
        diagnosticSyncEvents: syncEvents.length,
        diagnosticSyncedEvents: syncedEvents.length,
      },
      schedule: faultRecords,
    };
    await attachS05Artifacts(testInfo, faultRecords, metrics, faultController.events, recordingSummary);

    expect(recoveryModes.filter((mode) => mode === "snapshot").length).toBe(0);
    expect(faultRecords).toHaveLength(CYCLE_COUNT);
    for (const record of faultRecords) {
      expect(record.pause).toBeDefined();
      expect(record.drop).toBeDefined();
      expect(record.terminate?.closeCode).toBe(1006);
      expect(record.terminate?.abrupt).toBe(true);
      expect(record.syncClose).toBeDefined();
    }
    expect(faultRecords.filter((record) => record.syncClose?.observedAt !== undefined).length).toBeGreaterThanOrEqual(CYCLE_COUNT - 1);
    expect(finalEventsBeforeExit.filter((event) => event.type === "error")).toHaveLength(0);
    expect(browserErrors()).toEqual([]);

    // Dispose the final pending sync matcher before asking the fixture to exit;
    // it targets a future sync that is intentionally outside the 30-minute
    // measurement window and must not leak a proxy rule into cleanup.
    for (const pending of syncCloseRules.values()) {
      pending.record.pending = true;
      pending.disposer.dispose();
    }
    syncCloseRules.clear();
    faultController.reset();

    const exitCursor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? 0;
    const exitPromise = waitForDiagnosticEventMatch(page, terminalId, exitCursor, "exit");
    const unmountCursor = exitCursor;
    const unmountPromise = waitForDiagnosticEventMatch(page, terminalId, unmountCursor, "unmount");
    await pane.sendInput("EXIT 0", true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "exit" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    const exitEvent = await exitPromise;
    expect(exitEvent.snapshot.exitCode).toBe(0);
    const exitedSnapshot = await pane.waitForSnapshot({ timeout: WAIT_TIMEOUT_MS });
    expect(exitedSnapshot.socketState).toBe("exited");
    expect(exitedSnapshot.activeSocketCount).toBe(0);
    expect(exitedSnapshot.socket.activeCount).toBe(0);
    expect(exitedSnapshot.acceptingInput).toBe(false);
    await pane.closePane();
    const unmounted = await unmountPromise;
    expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
    expect(unmounted.snapshot.activeSocketCount).toBe(0);
    expect(unmounted.snapshot.socket.activeCount).toBe(0);
    const cleanupResources = await readBrowserResources(page);
    expect(cleanupResources.canvasCount).toBe(0);
  } finally {
    await stopRecordingBestEffort(page, recordingActive);
    await disposeMetricsObserver(page);
    browserErrors.dispose();
  }
});
