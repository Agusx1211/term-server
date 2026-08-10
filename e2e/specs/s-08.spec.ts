import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import type { Browser, BrowserContext, Page, TestInfo } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { launchIsolatedServer } from "../fixtures/isolated-server.js";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import type {
  NetworkFaultController,
  NetworkFaultEvent,
} from "../fixtures/network-faults.js";
import {
  expectTerminalInteractive,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
} from "../assertions/invariants.js";
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

const WAIT_TIMEOUT_MS = 45_000;
const SEED = "0x5108";
const SOAK_DURATION_MS = 10 * 60 * 1_000;
const BURST_INTERVAL_MS = 2 * 1_000;
const BURST_COUNT = SOAK_DURATION_MS / BURST_INTERVAL_MS;
const BURST_BYTES = 65_536;
const BURST_LINE_WIDTH = 96;
const INPUT_OFFSET_MS = 60 * 1_000;
const RESIZE_OFFSET_MS = 120 * 1_000;
const RECONNECT_OFFSET_MS = 240 * 1_000;
const RATIO_ALERT_BAND = 1.20;
const BROWSER_VIEWPORT = { width: 1_280, height: 720 } as const;
const RESIZE_SEQUENCE = [
  { width: 1_000, height: 650 },
  { width: 1_440, height: 800 },
  { width: 900, height: 600 },
  BROWSER_VIEWPORT,
] as const;
const TIMER_METRICS_KEY = "__TERM_SERVER_E2E_TIMERS__";
const LONG_TASK_METRICS_KEY = "__TERM_SERVER_E2E_LONG_TASKS__";
const E2E_PASSWORD = "e2e-development";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
  __TERM_SERVER_E2E_TIMERS__?: {
    snapshot: () => TimerMetrics;
  };
  __TERM_SERVER_E2E_LONG_TASKS__?: {
    reset: () => void;
    snapshot: () => LongTaskMetrics;
  };
};

type JsonObject = { readonly [key: string]: unknown };
type EventType = E2ETerminalEvent["type"];

interface TimerMetrics {
  readonly status: "ok";
  readonly timeouts: number;
  readonly intervals: number;
  readonly total: number;
}

interface LongTaskMetrics {
  readonly status: "ok" | "unavailable";
  readonly count: number;
  readonly totalDurationMs: number;
  readonly maxDurationMs: number;
  readonly reason?: string;
}

interface SlimSnapshot {
  readonly terminalId: string;
  readonly socketGeneration: number;
  readonly socketState: string;
  readonly activeSocketCount: number;
  readonly cols: number;
  readonly rows: number;
  readonly committedSequence?: number;
  readonly receivedSequence?: number;
  readonly syncMode?: string;
  readonly syncTarget?: number;
  readonly pendingParserWrites: number;
  readonly pendingParserBytes: number;
  readonly renderBacklogBytes: number;
  readonly renderBacklogFrames: number;
  readonly renderBacklogOldestAgeMs: number;
  readonly checkpointResult: string;
  readonly checkpointSerializationDurationMs: number;
  readonly checkpointUploadDurationMs: number;
  readonly checkpointSize: number;
  readonly checkpointChunks: number;
  readonly renderer: string;
  readonly webglLoadCount: number;
  readonly contextLossCount: number;
  readonly fallbackCount: number;
  readonly renderCount: number;
  readonly acceptingInput: boolean;
  readonly mounted: boolean;
  readonly visible: boolean;
  readonly cached: boolean;
  readonly active: boolean;
  readonly focused: boolean;
  readonly serverViewport?: { readonly cols: number; readonly rows: number };
}

interface SlimEvent {
  readonly id: number;
  readonly timestamp: number;
  readonly terminalId: string;
  readonly type: EventType;
  readonly data: JsonObject;
  readonly snapshot: SlimSnapshot;
}

interface BrowserResources {
  readonly heap: {
    readonly status: "ok" | "unavailable";
    readonly usedBytes?: number;
    readonly totalBytes?: number;
    readonly limitBytes?: number;
    readonly reason?: string;
  };
  readonly canvasCount: number;
  readonly canvasDimensions: readonly { readonly width: number; readonly height: number }[];
  readonly timers: TimerMetrics | { readonly status: "unavailable"; readonly reason: string };
  readonly longTasks: LongTaskMetrics;
}

interface ProcessRow {
  readonly pid: number;
  readonly cpuTicks: number;
  readonly rssBytes: number;
}

interface ProcessState {
  readonly sampledAt: number;
  readonly rows: readonly ProcessRow[];
}

interface ProcessResources {
  readonly status: "ok" | "unavailable";
  readonly processCount: number;
  readonly rssBytes: number;
  readonly cpuTicks: number;
  readonly cpuPercent: number;
  readonly reason?: string;
}

interface FaultMetrics {
  readonly connectionOpens: number;
  readonly connectionCloses: number;
  readonly connectionTerminations: number;
  readonly bytesBrowserToServer: number;
  readonly bytesServerToBrowser: number;
  readonly outputFrameBytes: number;
  readonly snapshotFrameBytes: number;
  readonly faultEvents: number;
}

interface ResourceSample {
  readonly atMs: number;
  readonly browser: BrowserResources;
  readonly process: ProcessResources;
  readonly terminal: SlimSnapshot;
  readonly proxy: FaultMetrics;
}

interface Distribution {
  readonly status: "ok" | "na";
  readonly p50?: number;
  readonly p95?: number;
  readonly max?: number;
  readonly count: number;
  readonly reason?: string;
}

interface RunSummary {
  readonly resizeConvergenceLatency: Distribution;
  readonly reconnectToInteractiveLatency: Distribution;
  readonly longTasks: {
    readonly status: "ok" | "unavailable";
    readonly count: number;
    readonly maxDurationMs: number;
    readonly reason?: string;
  };
  readonly checkpointSerialization: Distribution;
  readonly snapshotParse: Distribution;
  readonly peakPendingParserBytes: number;
  readonly peakBacklogAgeMs: number;
  readonly reconnects: number;
  readonly snapshots: number;
  readonly reconnectsPerHour: number;
  readonly snapshotsPerHour: number;
  readonly browserHeap: Distribution & { readonly status: "ok" | "na"; readonly reason?: string };
  readonly rendererResources: {
    readonly maxCanvasCount: number;
    readonly maxWebglLoads: number;
    readonly maxContextLosses: number;
    readonly maxFallbacks: number;
    readonly maxRenderCount: number;
    readonly maxTimers: number;
    readonly maxProcessCount: number;
  };
  readonly serverReplayBytes: number;
  readonly serverSnapshotBytes: number;
  readonly inputRoundTripLatency: Distribution;
  readonly cpu: Distribution;
  readonly rss: Distribution;
  readonly networkBytes: number;
}

interface RecordingStatus {
  readonly active: boolean;
  readonly id: string | null;
  readonly events: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

interface RecordingPayload {
  readonly format?: unknown;
  readonly version?: unknown;
  readonly id?: unknown;
  readonly truncated?: unknown;
  readonly events?: readonly JsonObject[];
  readonly client?: {
    readonly truncated?: unknown;
    readonly events?: readonly JsonObject[];
  };
}

interface RunResult {
  readonly mode: "off" | "on";
  readonly runTag: string;
  readonly terminalId: string;
  readonly transcript: readonly TranscriptEntry[];
  readonly diagnosticEvents: readonly SlimEvent[];
  readonly samples: readonly ResourceSample[];
  readonly fault: FaultMetrics;
  readonly summary: RunSummary;
  readonly finalSnapshot: E2ETerminalSnapshot;
  readonly finalText: string;
  readonly finalPixels: {
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
  };
  readonly recordingStatus: RecordingStatus;
  readonly recordingExport?: RecordingPayload;
  readonly recordingDownload?: RecordingPayload;
}

interface FaultAccumulator {
  connectionOpens: number;
  connectionCloses: number;
  connectionTerminations: number;
  bytesBrowserToServer: number;
  bytesServerToBrowser: number;
  outputFrameBytes: number;
  snapshotFrameBytes: number;
  faultEvents: number;
}

interface EventWaitSpec {
  readonly type: EventType;
  readonly after: number;
  readonly source?: string;
  readonly mode?: string;
  readonly result?: string;
  readonly minGeneration?: number;
  readonly generation?: number;
  readonly cols?: number;
  readonly rows?: number;
}

function runTag(testInfo: TestInfo): string {
  return [
    "S08",
    SEED,
    testInfo.project.name,
    testInfo.workerIndex,
    testInfo.parallelIndex,
    testInfo.repeatEachIndex,
    testInfo.retry,
  ].join("-").replace(/[^A-Za-z0-9_-]+/g, "-");
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as JsonObject)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}


function slimSnapshot(snapshot: E2ETerminalSnapshot): SlimSnapshot {
  return {
    terminalId: snapshot.terminalId,
    socketGeneration: snapshot.socketGeneration,
    socketState: snapshot.socketState,
    activeSocketCount: snapshot.activeSocketCount,
    cols: snapshot.cols,
    rows: snapshot.rows,
    committedSequence: snapshot.committedSequence,
    receivedSequence: snapshot.receivedSequence,
    syncMode: snapshot.syncMode,
    syncTarget: snapshot.syncTarget,
    pendingParserWrites: snapshot.pendingParserWrites,
    pendingParserBytes: snapshot.pendingParserBytes,
    renderBacklogBytes: snapshot.renderBacklogBytes,
    renderBacklogFrames: snapshot.renderBacklogFrames,
    renderBacklogOldestAgeMs: snapshot.renderBacklogOldestAgeMs,
    checkpointResult: snapshot.checkpointResult,
    checkpointSerializationDurationMs: snapshot.checkpointSerializationDurationMs,
    checkpointUploadDurationMs: snapshot.checkpointUploadDurationMs,
    checkpointSize: snapshot.checkpointSize,
    checkpointChunks: snapshot.checkpointChunks,
    renderer: snapshot.renderer,
    webglLoadCount: snapshot.webglLoadCount,
    contextLossCount: snapshot.contextLossCount,
    fallbackCount: snapshot.fallbackCount,
    renderCount: snapshot.renderCount,
    acceptingInput: snapshot.acceptingInput,
    mounted: snapshot.mounted,
    visible: snapshot.visible,
    cached: snapshot.cached,
    active: snapshot.active,
    focused: snapshot.focused,
    ...(snapshot.serverViewport ? {
      serverViewport: {
        cols: snapshot.serverViewport.cols,
        rows: snapshot.serverViewport.rows,
      },
    } : {}),
  };
}

function slimEvent(event: E2ETerminalEvent): SlimEvent {
  return {
    id: event.id,
    timestamp: event.timestamp,
    terminalId: event.terminalId,
    type: event.type,
    data: { ...event.data },
    snapshot: slimSnapshot(event.snapshot),
  };
}

function medianPercentile(values: readonly number[], percentile: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
  return sorted[index];
}

function distribution(values: readonly number[], reason = "no samples were observed"): Distribution {
  if (values.length === 0) return { status: "na", count: 0, reason };
  return {
    status: "ok",
    count: values.length,
    p50: medianPercentile(values, 0.50),
    p95: medianPercentile(values, 0.95),
    max: Math.max(...values),
  };
}

function eventNumber(event: SlimEvent, key: string): number | undefined {
  return numberField(event.data, key);
}

function assertMonotonicEvents(events: readonly SlimEvent[]): void {
  let previousId = -1;
  let previousTimestamp = -1;
  let previousReceived: number | undefined;
  let previousCommitted: number | undefined;
  for (const event of events) {
    expect(event.id).toBeGreaterThan(previousId);
    expect(event.timestamp).toBeGreaterThanOrEqual(previousTimestamp);
    previousId = event.id;
    previousTimestamp = event.timestamp;
    if (event.snapshot.receivedSequence !== undefined && previousReceived !== undefined) {
      expect(event.snapshot.receivedSequence).toBeGreaterThanOrEqual(previousReceived);
    }
    if (event.snapshot.committedSequence !== undefined && previousCommitted !== undefined) {
      expect(event.snapshot.committedSequence).toBeGreaterThanOrEqual(previousCommitted);
    }
    if (event.snapshot.receivedSequence !== undefined && event.snapshot.committedSequence !== undefined) {
      expect(event.snapshot.committedSequence).toBeLessThanOrEqual(event.snapshot.receivedSequence);
    }
    previousReceived = event.snapshot.receivedSequence ?? previousReceived;
    previousCommitted = event.snapshot.committedSequence ?? previousCommitted;
  }
}

function recordFaultEvent(stats: FaultAccumulator, event: NetworkFaultEvent): void {
  if (event.type === "connection-open") stats.connectionOpens += 1;
  if (event.type === "connection-closed") stats.connectionCloses += 1;
  if (event.type === "connection-terminated") stats.connectionTerminations += 1;
  if (event.type === "frame") {
    const bytes = event.bytes ?? 0;
    if (event.direction === "browser-to-server") stats.bytesBrowserToServer += bytes;
    if (event.direction === "server-to-browser") stats.bytesServerToBrowser += bytes;
    if (event.direction === "server-to-browser" && event.frame?.binaryKind === 1) stats.outputFrameBytes += bytes;
    if (event.direction === "server-to-browser" && event.frame?.binaryKind === 0) stats.snapshotFrameBytes += bytes;
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

function copyFaultStats(stats: FaultAccumulator): FaultMetrics {
  return { ...stats };
}

async function childPids(pid: number): Promise<number[]> {
  try {
    const children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return children.trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
  } catch {
    return [];
  }
}

async function processTree(rootPid: number): Promise<number[]> {
  const seen = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    for (const child of await childPids(pid)) if (!seen.has(child)) pending.push(child);
  }
  return [...seen];
}

async function processRow(pid: number): Promise<ProcessRow | undefined> {
  try {
    const [stat, statm] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/statm`, "utf8"),
    ]);
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
    const cpuTicks = Number(fields[11]) + Number(fields[12]);
    const residentPages = Number(statm.trim().split(/\s+/)[1]);
    if (!Number.isFinite(cpuTicks) || !Number.isFinite(residentPages)) return undefined;
    return { pid, cpuTicks, rssBytes: residentPages * 4_096 };
  } catch {
    return undefined;
  }
}

async function processResources(rootPid: number | undefined, previous: ProcessState | undefined): Promise<{ metrics: ProcessResources; state?: ProcessState }> {
  if (process.platform !== "linux") {
    return {
      metrics: {
        status: "unavailable",
        processCount: 0,
        rssBytes: 0,
        cpuTicks: 0,
        cpuPercent: 0,
        reason: "process resource samples require Linux /proc",
      },
    };
  }
  if (rootPid === undefined) {
    return {
      metrics: {
        status: "unavailable",
        processCount: 0,
        rssBytes: 0,
        cpuTicks: 0,
        cpuPercent: 0,
        reason: "isolated server PID is unavailable",
      },
    };
  }
  const sampledAt = Date.now();
  const rows = (await Promise.all((await processTree(rootPid)).map(processRow)))
    .filter((row): row is ProcessRow => row !== undefined);
  const rssBytes = rows.reduce((sum, row) => sum + row.rssBytes, 0);
  const cpuTicks = rows.reduce((sum, row) => sum + row.cpuTicks, 0);
  let cpuPercent = 0;
  if (previous) {
    const elapsedMs = Math.max(1, sampledAt - previous.sampledAt);
    const previousByPid = new Map(previous.rows.map((row) => [row.pid, row]));
    const deltaTicks = rows.reduce((sum, row) => {
      const before = previousByPid.get(row.pid);
      return sum + Math.max(0, row.cpuTicks - (before?.cpuTicks ?? row.cpuTicks));
    }, 0);
    cpuPercent = deltaTicks * 100 / 100 / (elapsedMs / 1_000) * 100;
  }
  return {
    metrics: { status: "ok", processCount: rows.length, rssBytes, cpuTicks, cpuPercent },
    state: { sampledAt, rows },
  };
}

function installTimerInstrumentation(): void {
  const target = window as E2EWindow;
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  const originalSetTimeout = window.setTimeout.bind(window);
  const originalSetInterval = window.setInterval.bind(window);
  const originalClearTimeout = window.clearTimeout.bind(window);
  const originalClearInterval = window.clearInterval.bind(window);
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    let id = 0;
    const callback = () => {
      timeouts.delete(id);
      if (typeof handler === "function") Reflect.apply(handler, window, args);
      else Function(handler)();
    };
    id = originalSetTimeout(callback, timeout);
    timeouts.add(id);
    return id;
  }) as typeof window.setTimeout;
  window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = originalSetInterval(() => {
      if (typeof handler === "function") Reflect.apply(handler, window, args);
      else Function(handler)();
    }, timeout);
    intervals.add(id);
    return id;
  }) as typeof window.setInterval;
  window.clearTimeout = ((id: number) => {
    timeouts.delete(id);
    intervals.delete(id);
    originalClearTimeout(id);
  }) as typeof window.clearTimeout;
  window.clearInterval = ((id: number) => {
    intervals.delete(id);
    timeouts.delete(id);
    originalClearInterval(id);
  }) as typeof window.clearInterval;
  target.__TERM_SERVER_E2E_TIMERS__ = {
    snapshot: () => ({
      status: "ok",
      timeouts: timeouts.size,
      intervals: intervals.size,
      total: timeouts.size + intervals.size,
    }),
  };
}

function installLongTaskInstrumentation(): void {
  const target = window as E2EWindow;
  const entries: Array<{ readonly startTime: number; readonly duration: number }> = [];
  let available = true;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) entries.push({ startTime: entry.startTime, duration: entry.duration });
      if (entries.length > 5_000) entries.splice(0, entries.length - 5_000);
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    available = false;
  }
  target.__TERM_SERVER_E2E_LONG_TASKS__ = {
    reset: () => entries.splice(0, entries.length),
    snapshot: () => {
      if (!available) {
        return {
          status: "unavailable",
          count: 0,
          totalDurationMs: 0,
          maxDurationMs: 0,
          reason: "PerformanceObserver longtask is unavailable in this browser",
        };
      }
      const durations = entries.map((entry) => entry.duration);
      return {
        status: "ok",
        count: durations.length,
        totalDurationMs: durations.reduce((sum, duration) => sum + duration, 0),
        maxDurationMs: Math.max(0, ...durations),
      };
    },
  };
}

async function waitForWallClockBoundary(startedAt: number, offsetMs: number): Promise<void> {
  const remaining = startedAt + offsetMs - Date.now();
  if (remaining <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

async function latestDiagnosticId(page: Page, terminalId?: string): Promise<number> {
  return page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.events(id).at(-1)?.id ?? 0;
  }, terminalId);
}

async function slimEvents(page: Page, terminalId: string, after: number): Promise<SlimEvent[]> {
  return page.evaluate(({ id, floor }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const compact = (event: E2ETerminalEvent): SlimEvent => ({
      id: event.id,
      timestamp: event.timestamp,
      terminalId: event.terminalId,
      type: event.type,
      data: { ...event.data },
      snapshot: {
        terminalId: event.snapshot.terminalId,
        socketGeneration: event.snapshot.socketGeneration,
        socketState: event.snapshot.socketState,
        activeSocketCount: event.snapshot.activeSocketCount,
        cols: event.snapshot.cols,
        rows: event.snapshot.rows,
        committedSequence: event.snapshot.committedSequence,
        receivedSequence: event.snapshot.receivedSequence,
        syncMode: event.snapshot.syncMode,
        syncTarget: event.snapshot.syncTarget,
        pendingParserWrites: event.snapshot.pendingParserWrites,
        pendingParserBytes: event.snapshot.pendingParserBytes,
        renderBacklogBytes: event.snapshot.renderBacklogBytes,
        renderBacklogFrames: event.snapshot.renderBacklogFrames,
        renderBacklogOldestAgeMs: event.snapshot.renderBacklogOldestAgeMs,
        checkpointResult: event.snapshot.checkpointResult,
        checkpointSerializationDurationMs: event.snapshot.checkpointSerializationDurationMs,
        checkpointUploadDurationMs: event.snapshot.checkpointUploadDurationMs,
        checkpointSize: event.snapshot.checkpointSize,
        checkpointChunks: event.snapshot.checkpointChunks,
        renderer: event.snapshot.renderer,
        webglLoadCount: event.snapshot.webglLoadCount,
        contextLossCount: event.snapshot.contextLossCount,
        fallbackCount: event.snapshot.fallbackCount,
        renderCount: event.snapshot.renderCount,
        acceptingInput: event.snapshot.acceptingInput,
        mounted: event.snapshot.mounted,
        visible: event.snapshot.visible,
        cached: event.snapshot.cached,
        active: event.snapshot.active,
        focused: event.snapshot.focused,
        ...(event.snapshot.serverViewport ? {
          serverViewport: {
            cols: event.snapshot.serverViewport.cols,
            rows: event.snapshot.serverViewport.rows,
          },
        } : {}),
      },
    });
    return api.events(id).filter((event) => event.id > floor).map(compact);
  }, { id: terminalId, floor: after });
}

async function waitForSlimEvent(page: Page, terminalId: string, spec: EventWaitSpec): Promise<SlimEvent> {
  return page.evaluate(async ({ id, wait, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const event = await api.waitForEvent(id, (candidate) => {
      if (candidate.id <= wait.after || candidate.type !== wait.type) return false;
      if (wait.source !== undefined && candidate.data.source !== wait.source) return false;
      if (wait.mode !== undefined && candidate.data.mode !== wait.mode) return false;
      if (wait.result !== undefined && candidate.data.result !== wait.result) return false;
      if (wait.generation !== undefined && candidate.snapshot.socketGeneration !== wait.generation) return false;
      if (wait.minGeneration !== undefined && candidate.snapshot.socketGeneration < wait.minGeneration) return false;
      if (wait.cols !== undefined && candidate.data.cols !== wait.cols) return false;
      if (wait.rows !== undefined && candidate.data.rows !== wait.rows) return false;
      return true;
    }, { timeout });
    return {
      id: event.id,
      timestamp: event.timestamp,
      terminalId: event.terminalId,
      type: event.type,
      data: { ...event.data },
      snapshot: {
        terminalId: event.snapshot.terminalId,
        socketGeneration: event.snapshot.socketGeneration,
        socketState: event.snapshot.socketState,
        activeSocketCount: event.snapshot.activeSocketCount,
        cols: event.snapshot.cols,
        rows: event.snapshot.rows,
        committedSequence: event.snapshot.committedSequence,
        receivedSequence: event.snapshot.receivedSequence,
        syncMode: event.snapshot.syncMode,
        syncTarget: event.snapshot.syncTarget,
        pendingParserWrites: event.snapshot.pendingParserWrites,
        pendingParserBytes: event.snapshot.pendingParserBytes,
        renderBacklogBytes: event.snapshot.renderBacklogBytes,
        renderBacklogFrames: event.snapshot.renderBacklogFrames,
        renderBacklogOldestAgeMs: event.snapshot.renderBacklogOldestAgeMs,
        checkpointResult: event.snapshot.checkpointResult,
        checkpointSerializationDurationMs: event.snapshot.checkpointSerializationDurationMs,
        checkpointUploadDurationMs: event.snapshot.checkpointUploadDurationMs,
        checkpointSize: event.snapshot.checkpointSize,
        checkpointChunks: event.snapshot.checkpointChunks,
        renderer: event.snapshot.renderer,
        webglLoadCount: event.snapshot.webglLoadCount,
        contextLossCount: event.snapshot.contextLossCount,
        fallbackCount: event.snapshot.fallbackCount,
        renderCount: event.snapshot.renderCount,
        acceptingInput: event.snapshot.acceptingInput,
        mounted: event.snapshot.mounted,
        visible: event.snapshot.visible,
        cached: event.snapshot.cached,
        active: event.snapshot.active,
        focused: event.snapshot.focused,
        ...(event.snapshot.serverViewport ? {
          serverViewport: {
            cols: event.snapshot.serverViewport.cols,
            rows: event.snapshot.serverViewport.rows,
          },
        } : {}),
      },
    };
  }, { id: terminalId, wait: spec, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettled(page: Page, terminalId: string, expectedSequence: number): Promise<SlimSnapshot> {
  return page.evaluate(async ({ id, sequence, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const snapshot = await api.waitForTerminal(id, (candidate) => (
      candidate.socketState === "connected"
      && candidate.activeSocketCount === 1
      && candidate.pendingParserWrites === 0
      && candidate.pendingParserBytes === 0
      && candidate.renderBacklogBytes === 0
      && candidate.renderBacklogFrames === 0
      && candidate.committedSequence !== undefined
      && candidate.committedSequence >= sequence
    ), { timeout });
    return {
      terminalId: snapshot.terminalId,
      socketGeneration: snapshot.socketGeneration,
      socketState: snapshot.socketState,
      activeSocketCount: snapshot.activeSocketCount,
      cols: snapshot.cols,
      rows: snapshot.rows,
      committedSequence: snapshot.committedSequence,
      receivedSequence: snapshot.receivedSequence,
      syncMode: snapshot.syncMode,
      syncTarget: snapshot.syncTarget,
      pendingParserWrites: snapshot.pendingParserWrites,
      pendingParserBytes: snapshot.pendingParserBytes,
      renderBacklogBytes: snapshot.renderBacklogBytes,
      renderBacklogFrames: snapshot.renderBacklogFrames,
      renderBacklogOldestAgeMs: snapshot.renderBacklogOldestAgeMs,
      checkpointResult: snapshot.checkpointResult,
      checkpointSerializationDurationMs: snapshot.checkpointSerializationDurationMs,
      checkpointUploadDurationMs: snapshot.checkpointUploadDurationMs,
      checkpointSize: snapshot.checkpointSize,
      checkpointChunks: snapshot.checkpointChunks,
      renderer: snapshot.renderer,
      webglLoadCount: snapshot.webglLoadCount,
      contextLossCount: snapshot.contextLossCount,
      fallbackCount: snapshot.fallbackCount,
      renderCount: snapshot.renderCount,
      acceptingInput: snapshot.acceptingInput,
      mounted: snapshot.mounted,
      visible: snapshot.visible,
      cached: snapshot.cached,
      active: snapshot.active,
      focused: snapshot.focused,
      ...(snapshot.serverViewport ? {
        serverViewport: {
          cols: snapshot.serverViewport.cols,
          rows: snapshot.serverViewport.rows,
        },
      } : {}),
    };
  }, { id: terminalId, sequence: expectedSequence, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledMarker(page: Page, terminalId: string, markerText: string): Promise<void> {
  await page.evaluate(async ({ id, marker, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => (
      snapshot.xterm.text.includes(marker)
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, marker: markerText, timeout: WAIT_TIMEOUT_MS });
}

async function transcriptFloor(server: IsolatedServer, terminalId: string): Promise<number> {
  const entries = await server.readTranscript(terminalId);
  return entries.reduce((floor, entry) => Math.max(floor, numberField(entry, "sequence") ?? 0), 0);
}

async function fixtureCommand(
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  command: string,
  predicate: (entry: TranscriptEntry) => boolean,
): Promise<{ readonly command: TranscriptEntry; readonly write: TranscriptEntry }> {
  const floor = await transcriptFloor(server, terminalId);
  await pane.sendInput(command, true);
  const commandEntry = await server.waitForTranscript(
    terminalId,
    (entry) => (numberField(entry, "sequence") ?? 0) > floor && predicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const commandSequence = numberField(commandEntry, "sequence") ?? floor;
  const write = await server.waitForTranscript(
    terminalId,
    (entry) => (numberField(entry, "sequence") ?? 0) > commandSequence && entry.event === "write",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  return { command: commandEntry, write };
}

function writeBytes(entry: TranscriptEntry): number {
  const bytes = numberField(entry, "bytes");
  if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error("fixture write omitted a valid byte count");
  return bytes;
}

async function markerCommand(
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  operation: string,
  id: string,
  text: string,
  page: Page,
): Promise<void> {
  const before = await slimTerminal(page, terminalId);
  const expected = `[E2E:${operation}:${id}:${text}]`;
  const result = await fixtureCommand(server, pane, terminalId, `${operation} ${id} ${text}`, (entry) => entry.event === operation.toLowerCase() && entry.id === id);
  await waitForSettled(page, terminalId, (before.committedSequence ?? 0) + writeBytes(result.write));
  await waitForSettledMarker(page, terminalId, expected);
}

async function slimTerminal(page: Page, terminalId: string): Promise<SlimSnapshot> {
  const snapshot = await page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const value = api.terminal(id);
    if (!value) return undefined;
    return {
      terminalId: value.terminalId,
      socketGeneration: value.socketGeneration,
      socketState: value.socketState,
      activeSocketCount: value.activeSocketCount,
      cols: value.cols,
      rows: value.rows,
      committedSequence: value.committedSequence,
      receivedSequence: value.receivedSequence,
      syncMode: value.syncMode,
      syncTarget: value.syncTarget,
      pendingParserWrites: value.pendingParserWrites,
      pendingParserBytes: value.pendingParserBytes,
      renderBacklogBytes: value.renderBacklogBytes,
      renderBacklogFrames: value.renderBacklogFrames,
      renderBacklogOldestAgeMs: value.renderBacklogOldestAgeMs,
      checkpointResult: value.checkpointResult,
      checkpointSerializationDurationMs: value.checkpointSerializationDurationMs,
      checkpointUploadDurationMs: value.checkpointUploadDurationMs,
      checkpointSize: value.checkpointSize,
      checkpointChunks: value.checkpointChunks,
      renderer: value.renderer,
      webglLoadCount: value.webglLoadCount,
      contextLossCount: value.contextLossCount,
      fallbackCount: value.fallbackCount,
      renderCount: value.renderCount,
      acceptingInput: value.acceptingInput,
      mounted: value.mounted,
      visible: value.visible,
      cached: value.cached,
      active: value.active,
      focused: value.focused,
      ...(value.serverViewport ? {
        serverViewport: { cols: value.serverViewport.cols, rows: value.serverViewport.rows },
      } : {}),
    };
  }, terminalId);
  if (!snapshot) throw new Error(`missing diagnostics snapshot for terminal ${terminalId}`);
  return snapshot;
}

async function browserResources(page: Page): Promise<BrowserResources> {
  return page.evaluate(({ timerKey, longTaskKey }) => {
    const target = window as E2EWindow;
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    const heap = memory && Number.isFinite(memory.usedJSHeapSize)
      ? {
        status: "ok" as const,
        usedBytes: memory.usedJSHeapSize,
        totalBytes: memory.totalJSHeapSize,
        limitBytes: memory.jsHeapSizeLimit,
      }
      : {
        status: "unavailable" as const,
        reason: "performance.memory is unavailable in this browser",
      };
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>("canvas")];
    return {
      heap,
      canvasCount: canvases.length,
      canvasDimensions: canvases.map((canvas) => ({ width: canvas.width, height: canvas.height })),
      timers: target[timerKey as "__TERM_SERVER_E2E_TIMERS__"]?.snapshot()
        ?? { status: "unavailable" as const, reason: "timer instrumentation is unavailable" },
      longTasks: target[longTaskKey as "__TERM_SERVER_E2E_LONG_TASKS__"]?.snapshot()
        ?? { status: "unavailable" as const, count: 0, totalDurationMs: 0, maxDurationMs: 0, reason: "long-task instrumentation is unavailable" },
    };
  }, { timerKey: TIMER_METRICS_KEY, longTaskKey: LONG_TASK_METRICS_KEY });
}

async function collectSample(
  page: Page,
  terminalId: string,
  server: IsolatedServer,
  fault: FaultAccumulator,
  previousProcess: ProcessState | undefined,
  startedAt: number,
): Promise<{ readonly sample: ResourceSample; readonly process?: ProcessState }> {
  const [terminal, browser, process] = await Promise.all([
    slimTerminal(page, terminalId),
    browserResources(page),
    processResources(server.pid, previousProcess),
  ]);
  const snapshot = process.metrics;
  return {
    sample: {
      atMs: Date.now() - startedAt,
      browser,
      process: snapshot,
      terminal,
      proxy: copyFaultStats(fault),
    },
    process: process.state,
  };
}

async function createTerminal(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  run: string,
): Promise<{ readonly id: string; readonly name: string; readonly pane: TerminalPanePage }> {
  const eventFloor = await latestDiagnosticId(page);
  const mountPromise = page.evaluate(async ({ floor, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const event = await api.waitForEvent(
      (candidate) => candidate.id > floor && candidate.type === "mount" && candidate.snapshot.kind === "pane",
      { timeout },
    );
    return { terminalId: event.terminalId, paneId: event.paneId };
  }, { floor: eventFloor, timeout: WAIT_TIMEOUT_MS });
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const [mounted, response] = await Promise.all([mountPromise, responsePromise]);
  if (!response.ok()) throw new Error(`terminal creation failed with HTTP ${response.status()}`);
  const created = await response.json() as { id?: unknown; name?: unknown };
  if (typeof created.id !== "string" || typeof created.name !== "string") throw new Error("terminal creation response omitted id/name");
  expect(mounted.terminalId).toBe(created.id);
  const pane = new TerminalPanePage(page, created.id, created.name);
  await pane.expectVisible();
  const initial = await expectTerminalInteractive(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.socketGeneration).toBe(1);
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.serverViewport).toMatchObject({ cols: initial.cols, rows: initial.rows });

  const readyId = `${run}-READY`;
  const ready = await fixtureCommand(server, pane, created.id, `READY ${readyId}`, (entry) => entry.event === "ready" && entry.id === readyId);
  await waitForSettled(page, created.id, (initial.committedSequence ?? 0) + writeBytes(ready.write));
  await waitForSettledMarker(page, created.id, `[E2E:READY:${readyId}]`);
  return { id: created.id, name: created.name, pane };
}

async function readRecordingStatus(page: Page): Promise<RecordingStatus> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording", { cache: "no-store" });
    if (!response.ok) throw new Error(`debug recording status failed with HTTP ${response.status}`);
    const value = await response.json() as JsonObject;
    const active = value.active;
    const id = value.id;
    const events = value.events;
    const bytes = value.bytes;
    const truncated = value.truncated;
    if (typeof active !== "boolean" || (id !== null && typeof id !== "string") || typeof events !== "number" || typeof bytes !== "number" || typeof truncated !== "boolean") {
      throw new Error("debug recording status omitted required fields");
    }
    return { active, id: id as string | null, events, bytes, truncated };
  });
}

async function readRecordingExport(page: Page): Promise<RecordingPayload> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export", { cache: "no-store" });
    if (!response.ok) throw new Error(`debug recording export failed with HTTP ${response.status}`);
    return await response.json() as RecordingPayload;
  });
}

async function readDownload(download: { path(): Promise<string | null> }): Promise<RecordingPayload> {
  const path = await download.path();
  if (!path) throw new Error("debug recording download did not expose a file path");
  return JSON.parse(await readFile(path, "utf8")) as RecordingPayload;
}

function recordingByteTotals(recording: RecordingPayload | undefined): { replay: number; snapshot: number } {
  let replay = 0;
  let snapshot = 0;
  for (const event of recording?.events ?? []) {
    const data = typeof event.data === "string" ? event.data : undefined;
    if (!data) continue;
    const bytes = Buffer.from(data, "base64").byteLength;
    if (event.type === "output") replay += bytes;
    if (event.type === "snapshot") snapshot += bytes;
  }
  return { replay, snapshot };
}

function eventSequence(entry: TranscriptEntry): number {
  return numberField(entry, "sequence") ?? 0;
}

function canonicalTranscript(entries: readonly TranscriptEntry[]): string {
  return JSON.stringify(entries.map((entry) => {
    const { sequence: _sequence, write_sequence: _writeSequence, chunk: _chunk, chunk_index: _chunkIndex, ...rest } = entry;
    return rest;
  }));
}

async function sendInputRoundTrip(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  run: string,
): Promise<number> {
  const echoId = `${run}-ECHO`;
  const echoText = `${run}-CONTINUED-INPUT`;
  const initial = await slimTerminal(page, terminalId);
  const armed = await fixtureCommand(server, pane, terminalId, `ECHO_INPUT ${echoId}`, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed");
  await waitForSettled(page, terminalId, (initial.committedSequence ?? 0) + writeBytes(armed.write));
  const startedAt = Date.now();
  await pane.sendInput(echoText, true);
  const payload = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64?: string }>(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(payload.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
  const markerText = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;
  await waitForSettledMarker(page, terminalId, markerText);
  return Math.max(0, Date.now() - startedAt);
}

async function resizeSequence(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
): Promise<number[]> {
  const latencies: number[] = [];
  for (const geometry of RESIZE_SEQUENCE) {
    const eventFloor = await latestDiagnosticId(page, terminalId);
    const transcriptFloorValue = await transcriptFloor(server, terminalId);
    const sentPromise = waitForSlimEvent(page, terminalId, {
      type: "viewport",
      after: eventFloor,
      source: "sent",
    });
    const startedAt = Date.now();
    await page.setViewportSize(geometry);
    const sent = await sentPromise;
    const cols = numberField(sent.data, "cols");
    const rows = numberField(sent.data, "rows");
    if (cols === undefined || rows === undefined) throw new Error("sent viewport event omitted rows/cols");
    const selectedPromise = waitForSlimEvent(page, terminalId, {
      type: "size",
      after: sent.id,
      cols,
      rows,
    });
    const winchPromise = server.waitForTranscript(
      terminalId,
      (entry) => eventSequence(entry) > transcriptFloorValue
        && entry.event === "sigwinch"
        && entry.source === "signal"
        && entry.cols === cols
        && entry.rows === rows,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const [selected] = await Promise.all([selectedPromise, winchPromise]);
    const converged = await waitForSettled(page, terminalId, selected.snapshot.committedSequence ?? 0);
    expect(converged.cols).toBe(cols);
    expect(converged.rows).toBe(rows);
    expect(converged.serverViewport).toMatchObject({ cols, rows });
    latencies.push(Math.max(0, Math.max(Date.now(), selected.timestamp) - sent.timestamp, Date.now() - startedAt));
    await markerCommand(server, pane, terminalId, "PRINT", `S08-RESIZE-${cols}x${rows}`, `S08-RESIZED-${cols}x${rows}`, page);
  }
  return latencies;
}
async function reconnect(
  page: Page,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  pane: TerminalPanePage,
  terminalId: string,
): Promise<number> {
  const before = await slimTerminal(page, terminalId);
  const eventFloor = await latestDiagnosticId(page, terminalId);
  const network = [...faultController.events].reverse().find((event) => event.type === "connection-open" && event.terminalId === terminalId && event.generation === before.socketGeneration);
  if (network?.generation === undefined) throw new Error("missing proxy generation before scheduled reconnect");
  const disconnectedPromise = waitForSlimEvent(page, terminalId, {
    type: "socket-close",
    after: eventFloor,
    generation: before.socketGeneration,
  });
  const syncedPromise = waitForSlimEvent(page, terminalId, {
    type: "synced",
    after: eventFloor,
    minGeneration: before.socketGeneration + 1,
  });
  const terminatedPromise = faultController.waitFor(
    (event) => event.type === "connection-terminated" && event.terminalId === terminalId && event.generation === network.generation,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const termination = faultController.terminate({ terminalId, generation: network.generation });
  const [disconnected, synced, terminated] = await Promise.all([disconnectedPromise, syncedPromise, terminatedPromise]);
  termination.dispose();
  expect(terminated.abrupt).toBe(true);
  expect(disconnected.snapshot.activeSocketCount).toBe(0);
  expect(synced.snapshot.socketGeneration).toBeGreaterThan(before.socketGeneration);
  const recovered = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(recovered.activeSocketCount).toBe(1);
  await pane.expectConnected();
  await markerCommand(server, pane, terminalId, "PRINT", "S08-RECONNECTED", "S08-RECONNECTED", page);
  return Math.max(0, synced.timestamp - disconnected.timestamp);
}

async function runWorkload(
  page: Page,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  pane: TerminalPanePage,
  terminalId: string,
  run: string,
  startedAt: number,
  fault: FaultAccumulator,
  samples: ResourceSample[],
  diagnostics: SlimEvent[],
  processState: { value?: ProcessState },
): Promise<{ readonly resizeLatencies: number[]; readonly reconnectLatencies: number[]; readonly inputLatencies: number[]; readonly lastEventId: number }> {
  let lastEventId = await latestDiagnosticId(page, terminalId);
  const initialEvents = await slimEvents(page, terminalId, 0);
  diagnostics.push(...initialEvents);
  lastEventId = Math.max(lastEventId, ...(initialEvents.map((event) => event.id)), 0);
  const resizeLatencies: number[] = [];
  const reconnectLatencies: number[] = [];
  const inputLatencies: number[] = [];
  let inputSent = false;
  let resized = false;
  let reconnected = false;

  const baseline = await collectSample(page, terminalId, server, fault, processState.value, startedAt);
  processState.value = baseline.process;
  samples.push(baseline.sample);

  for (let index = 0; index < BURST_COUNT; index += 1) {
    const offset = (index + 1) * BURST_INTERVAL_MS;
    await waitForWallClockBoundary(startedAt, offset);
    if (!inputSent && offset >= INPUT_OFFSET_MS) {
      inputLatencies.push(await sendInputRoundTrip(page, server, pane, terminalId, run));
      await markerCommand(server, pane, terminalId, "PRINT", "S08-INPUT-ACTIVE", "S08-INPUT-ACTIVE", page);
      inputSent = true;
    }
    if (!resized && offset >= RESIZE_OFFSET_MS) {
      resizeLatencies.push(...await resizeSequence(page, server, pane, terminalId));
      resized = true;
    }
    if (!reconnected && offset >= RECONNECT_OFFSET_MS) {
      reconnectLatencies.push(await reconnect(page, server, faultController, pane, terminalId));
      reconnected = true;
    }

    const before = await slimTerminal(page, terminalId);
    const burstId = `${run}-BURST-${index.toString().padStart(3, "0")}`;
    const burst = await fixtureCommand(
      server,
      pane,
      terminalId,
      `BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`,
      (entry) => entry.event === "burst" && entry.id === burstId,
    );
    const expectedSequence = (before.committedSequence ?? 0) + writeBytes(burst.write);
    await waitForSettled(page, terminalId, expectedSequence);
    const updates = await slimEvents(page, terminalId, lastEventId);
    diagnostics.push(...updates);
    lastEventId = Math.max(lastEventId, ...(updates.map((event) => event.id)), 0);
    const sampled = await collectSample(page, terminalId, server, fault, processState.value, startedAt);
    processState.value = sampled.process;
    samples.push(sampled.sample);

    if (index % 30 === 29) {
      await markerCommand(server, pane, terminalId, "PRINT", `${run}-MARK-${index + 1}`, `${run}-MARK-${index + 1}`, page);
    }
  }
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SOAK_DURATION_MS);
  if (!inputSent) throw new Error("scheduled input phase did not execute");
  if (!resized) throw new Error("scheduled resize phase did not execute");
  if (!reconnected) throw new Error("scheduled reconnect phase did not execute");
  const finalEvents = await slimEvents(page, terminalId, lastEventId);
  diagnostics.push(...finalEvents);
  lastEventId = Math.max(lastEventId, ...(finalEvents.map((event) => event.id)), 0);
  return { resizeLatencies, reconnectLatencies, inputLatencies, lastEventId };
}

function deriveSummary(
  samples: readonly ResourceSample[],
  events: readonly SlimEvent[],
  fault: FaultMetrics,
  resizeLatencies: readonly number[],
  reconnectLatencies: readonly number[],
  inputLatencies: readonly number[],
  recording: RecordingPayload | undefined,
): RunSummary {
  const checkpointLatencies = events
    .filter((event) => event.type === "checkpoint" && event.data.result === "sent")
    .map((event) => eventNumber(event, "serializationDurationMs"))
    .filter((value): value is number => value !== undefined && value >= 0);
  const parseLatencies: number[] = [];
  let openSnapshotSync: SlimEvent | undefined;
  for (const event of events) {
    if (event.type === "sync" && event.data.mode === "snapshot") {
      openSnapshotSync = event;
    } else if (event.type === "synced" && openSnapshotSync && event.id > openSnapshotSync.id) {
      parseLatencies.push(Math.max(0, event.timestamp - openSnapshotSync.timestamp));
      openSnapshotSync = undefined;
    }
  }
  const longTaskSamples = samples.map((sample) => sample.browser.longTasks).filter((metric) => metric.status === "ok");
  const latestLongTasks = longTaskSamples.at(-1);
  const heaps = samples.map((sample) => sample.browser.heap.usedBytes).filter((value): value is number => value !== undefined && value >= 0);
  const cpu = samples.map((sample) => sample.process.cpuPercent).filter((value) => Number.isFinite(value) && value >= 0);
  const rss = samples.map((sample) => sample.process.rssBytes).filter((value) => Number.isFinite(value) && value >= 0);
  const reconnects = Math.max(0, events.filter((event) => event.type === "socket-created").length - 1);
  const snapshots = events.filter((event) => event.type === "sync" && event.data.mode === "snapshot").length;
  const recordingTotals = recordingByteTotals(recording);
  const durationHours = SOAK_DURATION_MS / 3_600_000;
  return {
    resizeConvergenceLatency: distribution(resizeLatencies),
    reconnectToInteractiveLatency: distribution(reconnectLatencies),
    longTasks: latestLongTasks
      ? {
        status: "ok",
        count: latestLongTasks.count,
        maxDurationMs: latestLongTasks.maxDurationMs,
      }
      : {
        status: "unavailable",
        count: 0,
        maxDurationMs: 0,
        reason: "PerformanceObserver longtask is unavailable in this browser",
      },
    checkpointSerialization: distribution(checkpointLatencies),
    snapshotParse: distribution(parseLatencies),
    peakPendingParserBytes: Math.max(0, ...events.map((event) => event.snapshot.pendingParserBytes)),
    peakBacklogAgeMs: Math.max(0, ...events.map((event) => event.snapshot.renderBacklogOldestAgeMs)),
    reconnects,
    snapshots,
    reconnectsPerHour: reconnects / durationHours,
    snapshotsPerHour: snapshots / durationHours,
    browserHeap: heaps.length > 0
      ? { ...distribution(heaps), status: "ok" }
      : { status: "na", count: 0, reason: "performance.memory is unavailable in this browser" },
    rendererResources: {
      maxCanvasCount: Math.max(0, ...samples.map((sample) => sample.browser.canvasCount)),
      maxWebglLoads: Math.max(0, ...events.map((event) => event.snapshot.webglLoadCount)),
      maxContextLosses: Math.max(0, ...events.map((event) => event.snapshot.contextLossCount)),
      maxFallbacks: Math.max(0, ...events.map((event) => event.snapshot.fallbackCount)),
      maxRenderCount: Math.max(0, ...events.map((event) => event.snapshot.renderCount)),
      maxTimers: Math.max(0, ...samples.map((sample) => sample.browser.timers.status === "ok" ? sample.browser.timers.total : 0)),
      maxProcessCount: Math.max(0, ...samples.map((sample) => sample.process.processCount)),
    },
    serverReplayBytes: fault.outputFrameBytes || recordingTotals.replay,
    serverSnapshotBytes: fault.snapshotFrameBytes || recordingTotals.snapshot,
    inputRoundTripLatency: distribution(inputLatencies),
    cpu: distribution(cpu),
    rss: distribution(rss),
    networkBytes: fault.bytesBrowserToServer + fault.bytesServerToBrowser,
  };
}

function ratio(on: number | undefined, off: number | undefined, label: string): number {
  if (on === undefined || off === undefined) return 1;
  if (off === 0) {
    expect(on, `${label} must remain zero when the off run is zero`).toBe(0);
    return 1;
  }
  return on / off;
}

function assertRatioBand(on: number | undefined, off: number | undefined, label: string): void {
  expect(ratio(on, off, label), `${label} recording overhead exceeded ${RATIO_ALERT_BAND}x`).toBeLessThanOrEqual(RATIO_ALERT_BAND);
}

async function launchConfiguredServer(mode: "off" | "on", testInfo: TestInfo): Promise<IsolatedServer> {
  const names = [
    "TERM_SERVER_REPLAY_MB",
    "TERM_SERVER_SCROLLBACK_LINES",
    "TERM_SERVER_MAX_PANES",
    "TERM_SERVER_CACHED_TERMINALS",
  ] as const;
  const previous = new Map<string, string | undefined>(names.map((name) => [name, process.env[name]]));
  process.env.TERM_SERVER_REPLAY_MB = "64";
  process.env.TERM_SERVER_SCROLLBACK_LINES = "200000";
  process.env.TERM_SERVER_MAX_PANES = "1";
  process.env.TERM_SERVER_CACHED_TERMINALS = "0";
  try {
    return await launchIsolatedServer({
      workerIndex: testInfo.workerIndex * 2 + (mode === "on" ? 1 : 0),
      projectName: `soak-s08-${mode}`,
    });
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function attachRunArtifacts(testInfo: TestInfo, run: RunResult): Promise<void> {
  await testInfo.attach(`s-08-${run.mode}-metrics`, {
    body: `${JSON.stringify({ scenario: "S-08", seed: SEED, run: run.mode, summary: run.summary, samples: run.samples })}\n`,
    contentType: "application/jsonl",
  });
  await testInfo.attach(`s-08-${run.mode}-diagnostics`, {
    body: JSON.stringify(run.diagnosticEvents),
    contentType: "application/json",
  });
  await testInfo.attach(`s-08-${run.mode}-faults`, {
    body: JSON.stringify(run.fault),
    contentType: "application/json",
  });
  await testInfo.attach(`s-08-${run.mode}-fixture-transcript`, {
    body: JSON.stringify(run.transcript),
    contentType: "application/json",
  });
  if (run.recordingExport) {
    await testInfo.attach("s-08-recording-export", {
      body: JSON.stringify(run.recordingExport),
      contentType: "application/json",
    });
  }
  if (run.recordingDownload) {
    await testInfo.attach("s-08-recording-download", {
      body: JSON.stringify(run.recordingDownload),
      contentType: "application/json",
    });
  }
}

async function runOne(
  browser: Browser,
  mode: "off" | "on",
  run: string,
  testInfo: TestInfo,
): Promise<RunResult> {
  const isolated = await launchConfiguredServer(mode, testInfo);
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let pane: TerminalPanePage | undefined;
  let terminalId = "";
  const diagnostics: SlimEvent[] = [];
  const samples: ResourceSample[] = [];
  const fault: FaultAccumulator = {
    connectionOpens: 0,
    connectionCloses: 0,
    connectionTerminations: 0,
    bytesBrowserToServer: 0,
    bytesServerToBrowser: 0,
    outputFrameBytes: 0,
    snapshotFrameBytes: 0,
    faultEvents: 0,
  };
  const faultListener = isolated.faultController?.on((event) => {
    if (event.terminalId === terminalId || terminalId === "") recordFaultEvent(fault, event);
  });
  let recordingStatus: RecordingStatus = {
    active: false,
    id: null,
    events: 0,
    bytes: 0,
    truncated: false,
  };
  let recordingExport: RecordingPayload | undefined;
  let recordingDownload: RecordingPayload | undefined;
  const processState: { value?: ProcessState } = {};
  let browserErrors: BrowserErrorCollector | undefined;

  try {
    context = await browser.newContext({ baseURL: isolated.baseURL, viewport: BROWSER_VIEWPORT });
    page = await context.newPage();
    const errors = installBrowserErrorCollectors(page);
    browserErrors = errors;
    await page.addInitScript(installTimerInstrumentation);
    await page.addInitScript(installLongTaskInstrumentation);
    await page.goto(isolated.baseURL);
    await new LoginPage(page).login(E2E_PASSWORD);
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    if (mode === "off") {
      recordingStatus = await readRecordingStatus(page);
      expect(recordingStatus.active).toBe(false);
      expect(recordingStatus.events).toBe(0);
      expect(recordingStatus.bytes).toBe(0);
      expect(recordingStatus.truncated).toBe(false);
    } else {
      const settings = await workbench.openSettings();
      await settings.startRecording();
      await expect(settings.root.getByText("Recording", { exact: true })).toBeVisible();
      recordingStatus = await readRecordingStatus(page);
      expect(recordingStatus.active).toBe(true);
      expect(recordingStatus.id).not.toBeNull();
      await workbench.showTerminals();
    }

    const created = await createTerminal(page, workbench, isolated, run);
    terminalId = created.id;
    pane = created.pane;
    const startedAt = Date.now();
    await page.evaluate(() => {
      const target = window as E2EWindow;
      target.__TERM_SERVER_E2E_LONG_TASKS__?.reset();
    });
    const workload = await runWorkload(page, isolated, isolated.faultController!, pane, terminalId, run, startedAt, fault, samples, diagnostics, processState);

    const checkpointFloor = await latestDiagnosticId(page, terminalId);
    const checkpointPromise = waitForSlimEvent(page, terminalId, {
      type: "checkpoint",
      after: checkpointFloor,
      result: "sent",
    });
    const finalMarker = `${run}-FINAL-MARKER`;
    const beforePixels = await screenshotRegion(page, pane.xtermHost);
    await markerCommand(isolated, pane, terminalId, "PRINT", `${run}-FINAL`, finalMarker, page);
    await checkpointPromise;
    await expectKnownMarkerChanged(page, pane.xtermHost, beforePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: `s-08-${mode}-final-marker-crop`,
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: `s-08-${mode}-final-terminal-crop`,
    });

    const finalSnapshot = await terminalSnapshot(page, terminalId);
    if (!finalSnapshot) throw new Error(`missing final diagnostics snapshot for terminal ${terminalId}`);
    expect(finalSnapshot.socketState).toBe("connected");
    expect(finalSnapshot.activeSocketCount).toBe(1);
    expect(finalSnapshot.acceptingInput).toBe(true);
    expect(finalSnapshot.socket.activeCount).toBe(1);
    expect(finalSnapshot.xterm.text).toContain(`[E2E:PRINT:${run}-FINAL:${finalMarker}]`);
    expect(finalSnapshot.xterm.text.split(`[E2E:PRINT:${run}-FINAL:${finalMarker}]`).length - 1).toBe(1);
    assertNoPendingSynchronization(finalSnapshot);
    assertNoUnexpectedSocketMultiplication([finalSnapshot]);

    const finalInputLatency = await sendInputRoundTrip(page, isolated, pane, terminalId, `${run}-FINAL`);
    workload.inputLatencies.push(finalInputLatency);
    const finalAfterInput = await terminalSnapshot(page, terminalId);
    if (!finalAfterInput) throw new Error("missing final diagnostics snapshot after continued input");
    expect(finalAfterInput.xterm.text).toContain(`[E2E:ECHO_INPUT:${run}-FINAL-ECHO:`);
    expect(finalAfterInput.socketState).toBe("connected");
    expect(finalAfterInput.acceptingInput).toBe(true);

    const finalDiagnosticUpdates = await slimEvents(page, terminalId, workload.lastEventId);
    diagnostics.push(...finalDiagnosticUpdates);
    const transcriptBeforeExit = await isolated.readTranscript(terminalId);
    const finalPixelBuffer = (await screenshotRegion(page, pane.xtermHost)).buffer;

    if (mode === "on") {
      const settings = await workbench.openSettings();
      await settings.stopRecording();
      await expect(settings.root.getByText("Not recording", { exact: true })).toBeVisible();
      recordingStatus = await readRecordingStatus(page);
      expect(recordingStatus.active).toBe(false);
      expect(recordingStatus.truncated).toBe(false);
      recordingExport = await readRecordingExport(page);
      expect(recordingExport.truncated).toBe(false);
      expect(recordingExport.events?.length ?? 0).toBeGreaterThan(0);
      const downloadPromise = page.waitForEvent("download");
      await settings.downloadRecording();
      recordingDownload = await readDownload(await downloadPromise);
      expect(recordingDownload.truncated).toBe(false);
      expect(recordingDownload.client?.truncated).toBe(false);
      expect(recordingDownload.client?.events?.length ?? 0).toBeGreaterThan(0);
      expect(recordingDownload.events?.length ?? 0).toBeGreaterThan(0);
      expect(recordingDownload.id).toBe(recordingExport.id);
      await workbench.showTerminals();
      recordingStatus = await readRecordingStatus(page);
      expect(recordingStatus.active).toBe(false);
    }

    await pane.sendInput("EXIT 0", true);
    await isolated.waitForTranscript(terminalId, (entry) => entry.event === "exit" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    const unmount = pane.waitForEvent("unmount", { timeout: WAIT_TIMEOUT_MS });
    await workbench.sidebar.removeTerminal({ id: terminalId, name: created.name }, false);
    await unmount;
    expect(await workbench.mountedPaneCount()).toBe(0);
    const remaining = await page.evaluate(() => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.terminals().length;
    });
    expect(remaining).toBe(0);
    expect(await page.locator("canvas").count()).toBe(0);

    const transcript = await isolated.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(transcript.filter((entry) => entry.event === "exit" && entry.code === 0)).toHaveLength(1);
    const completeEvents = [...diagnostics, ...finalDiagnosticUpdates].sort((left, right) => left.id - right.id).filter((event, index, all) => index === 0 || event.id !== all[index - 1]?.id);
    assertMonotonicEvents(completeEvents);
    expect(completeEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(completeEvents.filter((event) => event.snapshot.activeSocketCount > 1)).toEqual([]);
    const summary = deriveSummary(samples, completeEvents, copyFaultStats(fault), workload.resizeLatencies, workload.reconnectLatencies, workload.inputLatencies, recordingExport);
    const result: RunResult = {
      mode,
      runTag: run,
      terminalId,
      transcript,
      diagnosticEvents: completeEvents,
      samples,
      fault: copyFaultStats(fault),
      summary,
      finalSnapshot: finalAfterInput,
      finalText: finalAfterInput.xterm.text,
      finalPixels: {
        width: (await screenshotRegion(page, pane.xtermHost)).width,
        height: (await screenshotRegion(page, pane.xtermHost)).height,
        sha256: createHash("sha256").update(finalPixelBuffer).digest("hex"),
      },
      recordingStatus,
      ...(recordingExport ? { recordingExport } : {}),
      ...(recordingDownload ? { recordingDownload } : {}),
    };
    await attachRunArtifacts(testInfo, result);
    expect(errors()).toEqual([]);
    return result;
  } finally {
    browserErrors?.dispose();
    faultListener?.dispose();
    if (context) await context.close();
    await isolated.stop();
    expect(isolated.pid).toBeUndefined();
  }
}

test.setTimeout(22 * 60 * 1_000);

test("S-08 Debug recording overhead @soak @S-08", async ({ browser }, testInfo) => {
  const run = runTag(testInfo);
  const off = await runOne(browser, "off", run, testInfo);
  const on = await runOne(browser, "on", run, testInfo);

  expect(on.transcript.length).toBe(off.transcript.length);
  expect(canonicalTranscript(on.transcript)).toBe(canonicalTranscript(off.transcript));
  expect(on.finalText).toBe(off.finalText);
  expect(on.finalSnapshot.cols).toBe(off.finalSnapshot.cols);
  expect(on.finalSnapshot.rows).toBe(off.finalSnapshot.rows);
  expect(on.finalSnapshot.serverViewport).toEqual(off.finalSnapshot.serverViewport);
  expect(on.finalSnapshot.gridEpoch).toBe(off.finalSnapshot.gridEpoch);
  expect(on.summary.reconnects).toBe(off.summary.reconnects);
  expect(on.summary.snapshots).toBe(off.summary.snapshots);
  expect(on.summary.serverReplayBytes).toBe(off.summary.serverReplayBytes);
  expect(on.summary.serverSnapshotBytes).toBe(off.summary.serverSnapshotBytes);
  expect(on.summary.inputRoundTripLatency.count).toBe(off.summary.inputRoundTripLatency.count);
  expect(on.finalPixels.width).toBe(off.finalPixels.width);
  expect(on.finalPixels.height).toBe(off.finalPixels.height);

  assertRatioBand(on.summary.cpu.p95, off.summary.cpu.p95, "server CPU P95");
  assertRatioBand(on.summary.cpu.max, off.summary.cpu.max, "server CPU maximum");
  assertRatioBand(on.summary.rss.p95, off.summary.rss.p95, "server RSS P95");
  assertRatioBand(on.summary.rss.max, off.summary.rss.max, "server RSS maximum");
  if (on.summary.browserHeap.status === "ok" && off.summary.browserHeap.status === "ok") {
    assertRatioBand(on.summary.browserHeap.p95, off.summary.browserHeap.p95, "browser heap P95");
    assertRatioBand(on.summary.browserHeap.max, off.summary.browserHeap.max, "browser heap maximum");
  }
  if (on.summary.longTasks.status === "ok" && off.summary.longTasks.status === "ok") {
    assertRatioBand(on.summary.longTasks.count, off.summary.longTasks.count, "long-task count");
    assertRatioBand(on.summary.longTasks.maxDurationMs, off.summary.longTasks.maxDurationMs, "long-task maximum duration");
  }
  assertRatioBand(on.summary.networkBytes, off.summary.networkBytes, "network bytes");
  expect(on.summary.resizeConvergenceLatency.status).toBe(off.summary.resizeConvergenceLatency.status);
  expect(on.summary.reconnectToInteractiveLatency.status).toBe(off.summary.reconnectToInteractiveLatency.status);
  expect(on.summary.checkpointSerialization.status).toBe(off.summary.checkpointSerialization.status);
  expect(on.summary.snapshotParse.status).toBe(off.summary.snapshotParse.status);
  expect(on.summary.peakPendingParserBytes).toBe(off.summary.peakPendingParserBytes);
  expect(on.summary.peakBacklogAgeMs).toBe(off.summary.peakBacklogAgeMs);
  expect(on.summary.rendererResources.maxCanvasCount).toBe(off.summary.rendererResources.maxCanvasCount);
  expect(on.summary.rendererResources.maxWebglLoads).toBe(off.summary.rendererResources.maxWebglLoads);
  expect(on.summary.rendererResources.maxContextLosses).toBe(0);
  expect(on.summary.rendererResources.maxFallbacks).toBe(0);
  expect(on.summary.rendererResources.maxContextLosses).toBe(off.summary.rendererResources.maxContextLosses);
  expect(on.summary.rendererResources.maxFallbacks).toBe(off.summary.rendererResources.maxFallbacks);
  expect(on.summary.rendererResources.maxTimers).toBe(off.summary.rendererResources.maxTimers);
  expect(on.fault.connectionOpens).toBe(off.fault.connectionOpens);
  expect(on.fault.connectionCloses).toBe(off.fault.connectionCloses);
  expect(on.fault.connectionTerminations).toBe(off.fault.connectionTerminations);
  expect(on.fault.faultEvents).toBe(0);
  expect(off.fault.faultEvents).toBe(0);
  expect(on.recordingStatus.active).toBe(false);
  expect(on.recordingStatus.truncated).toBe(false);
  expect(on.recordingExport?.truncated).toBe(false);
  expect(on.recordingDownload?.truncated).toBe(false);
  expect(on.recordingDownload?.client?.truncated).toBe(false);

  await testInfo.attach("s-08-paired-summary", {
    body: `${JSON.stringify({ scenario: "S-08", seed: SEED, off: off.summary, on: on.summary })}\n`,
    contentType: "application/json",
  });
});
