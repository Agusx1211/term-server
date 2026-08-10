import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, type IsolatedServer } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalInteractive,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectTerminalInvariants,
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
const TERMINAL_COUNT = 20;
const VISIBLE_COUNT = 4;
const CACHED_COUNT = TERMINAL_COUNT - VISIBLE_COUNT;
const SOAK_DURATION_MS = 30 * 60 * 1_000;
const SAMPLE_INTERVAL_MS = 15 * 1_000;
const SEED = "0x5101";
const TIMER_METRICS_KEY = "__TERM_SERVER_E2E_TIMERS__";
const LONG_TASK_METRICS_KEY = "__TERM_SERVER_E2E_LONG_TASKS__";
const TICKS_PER_SECOND = 100;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
  __TERM_SERVER_E2E_TIMERS__?: {
    snapshot: () => TimerMetrics;
  };
  __TERM_SERVER_E2E_LONG_TASKS__?: {
    snapshot: () => LongTaskMetrics;
  };
};

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
}

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

interface BrowserResourceMetrics {
  readonly heap: {
    readonly status: "ok" | "unavailable";
    readonly usedBytes?: number;
    readonly totalBytes?: number;
    readonly limitBytes?: number;
    readonly reason?: string;
  };
  readonly canvasCount: number;
  readonly canvasDimensions: readonly { readonly width: number; readonly height: number }[];
  readonly webglContexts: number;
  readonly webglLoads: number;
  readonly contextLosses: number;
  readonly fallbackCount: number;
  readonly renderCount: number;
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

interface ProcessResourceMetrics {
  readonly status: "ok" | "unavailable";
  readonly processCount: number;
  readonly rssBytes: number;
  readonly cpuTicks: number;
  readonly cpuPercent: number;
  readonly reason?: string;
}

interface ProxyMetrics {
  readonly connectionOpens: number;
  readonly connectionCloses: number;
  readonly bytesBrowserToServer: number;
  readonly bytesServerToBrowser: number;
  readonly faultEvents: number;
}

interface ResourceSample {
  readonly atMs: number;
  readonly browser: BrowserResourceMetrics;
  readonly process: ProcessResourceMetrics;
  readonly proxy: ProxyMetrics;
  readonly terminals: readonly {
    readonly id: string;
    readonly mounted: boolean;
    readonly visible: boolean;
    readonly cached: boolean;
    readonly active: boolean;
    readonly focused: boolean;
    readonly socketState: string;
    readonly socketGeneration: number;
    readonly activeSocketCount: number;
    readonly renderer: string;
    readonly webglLoadCount: number;
    readonly contextLossCount: number;
    readonly checkpointResult: string;
    readonly pendingParserWrites: number;
    readonly pendingParserBytes: number;
    readonly renderBacklogBytes: number;
    readonly renderBacklogFrames: number;
  }[];
}

interface TerminalHandle {
  readonly id: string;
  readonly name: string;
  readonly index: number;
}

interface ProcSampleResult {
  readonly metrics: ProcessResourceMetrics;
  readonly state: ProcessState | undefined;
}

function runTag(testInfo: TestInfo): string {
  return [
    "S01",
    SEED,
    testInfo.project.name,
    testInfo.workerIndex,
    testInfo.parallelIndex,
    testInfo.repeatEachIndex,
    testInfo.retry,
  ].join("-").replace(/[^A-Za-z0-9_-]+/g, "-");
}


async function waitForInteractive(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCached(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.lifecycle.mounted
      && snapshot.lifecycle.cached
      && !snapshot.lifecycle.visible
      && !snapshot.lifecycle.active
      && !snapshot.lifecycle.focused
      && !snapshot.lifecycle.acceptingInput
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCheckpoint(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.checkpointResult !== "idle", { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function allTerminalSnapshots(page: Page, terminalIds: readonly string[]): Promise<E2ETerminalSnapshot[]> {
  return page.evaluate((ids) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return ids.map((id) => api.terminal(id)).filter((snapshot): snapshot is E2ETerminalSnapshot => snapshot !== undefined);
  }, terminalIds);
}

async function browserResourceMetrics(page: Page, snapshots: readonly E2ETerminalSnapshot[]): Promise<BrowserResourceMetrics> {
  const browser = await page.evaluate(({ timerKey, longTaskKey }) => {
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
    const timers = target[timerKey as "__TERM_SERVER_E2E_TIMERS__"]?.snapshot();
    const longTasks = target[longTaskKey as "__TERM_SERVER_E2E_LONG_TASKS__"]?.snapshot();
    return {
      heap,
      canvasCount: canvases.length,
      canvasDimensions: canvases.map((canvas) => ({ width: canvas.width, height: canvas.height })),
      timers: timers ?? { status: "unavailable" as const, reason: "timer instrumentation is unavailable" },
      longTasks: longTasks ?? {
        status: "unavailable" as const,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        reason: "long-task instrumentation is unavailable",
      },
    };
  }, { timerKey: TIMER_METRICS_KEY, longTaskKey: LONG_TASK_METRICS_KEY });
  const webglContexts = snapshots.filter((snapshot) => snapshot.renderer === "webgl").length;
  return {
    ...browser,
    webglContexts,
    webglLoads: snapshots.reduce((sum, snapshot) => sum + snapshot.webglLoadCount, 0),
    contextLosses: snapshots.reduce((sum, snapshot) => sum + snapshot.contextLossCount, 0),
    fallbackCount: snapshots.reduce((sum, snapshot) => sum + snapshot.fallbackCount, 0),
    renderCount: snapshots.reduce((sum, snapshot) => sum + snapshot.renderCount, 0),
  };
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
    for (const child of await childPids(pid)) {
      if (!seen.has(child)) pending.push(child);
    }
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

async function processResourceMetrics(rootPid: number | undefined, previous: ProcessState | undefined): Promise<ProcSampleResult> {
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
      state: undefined,
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
      state: undefined,
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
    cpuPercent = deltaTicks / TICKS_PER_SECOND / (elapsedMs / 1_000) * 100;
  }
  return {
    metrics: { status: "ok", processCount: rows.length, rssBytes, cpuTicks, cpuPercent },
    state: { sampledAt, rows },
  };
}


function terminalMetricSnapshot(snapshot: E2ETerminalSnapshot): ResourceSample["terminals"][number] {
  return {
    id: snapshot.terminalId,
    mounted: snapshot.lifecycle.mounted,
    visible: snapshot.lifecycle.visible,
    cached: snapshot.lifecycle.cached,
    active: snapshot.lifecycle.active,
    focused: snapshot.lifecycle.focused,
    socketState: snapshot.socketState,
    socketGeneration: snapshot.socketGeneration,
    activeSocketCount: snapshot.activeSocketCount,
    renderer: snapshot.renderer,
    webglLoadCount: snapshot.webglLoadCount,
    contextLossCount: snapshot.contextLossCount,
    checkpointResult: snapshot.checkpointResult,
    pendingParserWrites: snapshot.pendingParserWrites,
    pendingParserBytes: snapshot.pendingParserBytes,
    renderBacklogBytes: snapshot.renderBacklogBytes,
    renderBacklogFrames: snapshot.renderBacklogFrames,
  };
}

async function collectResourceSample(
  page: Page,
  terminalIds: readonly string[],
  server: IsolatedServer,
  proxyStats: ProxyMetrics,
  previousProcess: ProcessState | undefined,
  startedAt: number,
): Promise<{ readonly sample: ResourceSample; readonly process: ProcessState | undefined }> {
  const snapshots = await allTerminalSnapshots(page, terminalIds);
  const [browser, process] = await Promise.all([
    browserResourceMetrics(page, snapshots),
    processResourceMetrics(server.pid, previousProcess),
  ]);
  return {
    sample: {
      atMs: Date.now() - startedAt,
      browser,
      process: process.metrics,
      proxy: { ...proxyStats },
      terminals: snapshots.map(terminalMetricSnapshot),
    },
    process: process.state,
  };
}

function assertFlatResourceSeries(field: string, values: readonly number[], allowance: number): void {
  const baseline = values[0];
  if (baseline === undefined) throw new Error(`${field} series is empty`);
  const maximum = Math.max(...values);
  expect(Number.isFinite(baseline), `${field} baseline must be finite`).toBe(true);
  expect(maximum, `${field} exceeded its baseline band`).toBeLessThanOrEqual(baseline + allowance);
}

function latestEvent(events: readonly E2ETerminalEvent[], type: E2ETerminalEvent["type"]): E2ETerminalEvent | undefined {
  return [...events].reverse().find((event) => event.type === type);
}

function forbiddenMeasurementEvents(events: readonly E2ETerminalEvent[], baselineLastId: number): E2ETerminalEvent[] {
  const forbidden = new Set<E2ETerminalEvent["type"]>([
    "socket-created",
    "socket-open",
    "socket-close",
    "socket-stale",
    "state",
    "sync",
    "synced",
    "snapshot",
    "output-received",
    "parser-commit",
    "checkpoint",
    "error",
  ]);
  return events.filter((event) => event.id > baselineLastId && forbidden.has(event.type));
}

async function waitForWallClockBoundary(startedAt: number, offsetMs: number): Promise<void> {
  const target = startedAt + offsetMs;
  const remaining = target - Date.now();
  if (remaining <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remaining));
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
  const entries: PerformanceEntry[] = [];
  let available = true;
  try {
    const observer = new PerformanceObserver((list) => {
      entries.push(...list.getEntries());
      if (entries.length > 2_000) entries.splice(0, entries.length - 2_000);
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    available = false;
  }
  target.__TERM_SERVER_E2E_LONG_TASKS__ = {
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

async function attachMetrics(testInfo: TestInfo, run: string, samples: readonly ResourceSample[]): Promise<void> {
  const jsonl = samples.map((sample) => JSON.stringify({ scenario: "S-01", seed: SEED, run, ...sample })).join("\n");
  await testInfo.attach("s-01-resource-metrics", {
    body: `${jsonl}\n`,
    contentType: "application/jsonl",
  });
}

interface FaultAccumulator {
  connectionOpens: number;
  connectionCloses: number;
  bytesBrowserToServer: number;
  bytesServerToBrowser: number;
  faultEvents: number;
}

function recordFaultEvent(stats: FaultAccumulator, event: NetworkFaultEvent): void {
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

async function createTerminal(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  terminalIndex: number,
  run: string,
): Promise<TerminalHandle> {
  const mount = page.evaluate(async () => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout: 15_000 });
  });
  const createResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const [mounted, response] = await Promise.all([mount, createResponse]);
  expect(response.ok()).toBe(true);
  const created = await response.json() as TerminalApiInfo;
  expect(created.id).not.toBe("");
  expect(created.name).not.toBe("");
  expect(mounted.terminalId).toBe(created.id);
  const pane = new TerminalPanePage(page, created.id, created.name);
  await pane.expectVisible();
  await waitForInteractive(page, created.id);

  const readyId = `${run}-READY-${terminalIndex}`;
  const sizeId = `${run}-SIZE-${terminalIndex}`;
  const holdToken = `S01-END-${created.id}`;
  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: `[E2E:READY:${readyId}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`SIZE ${sizeId}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: `[E2E:SIZE:${sizeId}:`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "hold" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: `[E2E:HOLD:${holdToken}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  return { id: created.id, name: created.name, index: terminalIndex };
}


async function removeTerminal(
  page: Page,
  workbench: WorkbenchPage,
  terminal: TerminalHandle,
): Promise<void> {
  const pane = new TerminalPanePage(page, terminal.id, terminal.name);
  const unmount = pane.waitForEvent("unmount", { timeout: WAIT_TIMEOUT_MS });
  await workbench.sidebar.removeTerminal({ id: terminal.id, name: terminal.name }, false);
  await unmount;
}

test("S-01 Quiet workspace @soak @S-01", async ({ page, server, faultController }, testInfo) => {
  test.setTimeout(35 * 60 * 1_000);
  const run = runTag(testInfo);
  const browserErrors = installBrowserErrorCollectors(page);
  const faultStats: FaultAccumulator = {
    connectionOpens: 0,
    connectionCloses: 0,
    bytesBrowserToServer: 0,
    bytesServerToBrowser: 0,
    faultEvents: 0,
  };
  const faultListener = faultController.on((event) => recordFaultEvent(faultStats, event));
  const samples: ResourceSample[] = [];
  let processState: ProcessState | undefined;
  let terminalHandles: TerminalHandle[] = [];
  let baselineEventIds = new Map<string, number>();
  let baselineTranscriptLengths = new Map<string, number>();

  await page.addInitScript(() => {
    window.localStorage.setItem("term-server:tile-new-terminals", "true");
  });
  await page.addInitScript(installTimerInstrumentation);
  await page.addInitScript(installLongTaskInstrumentation);
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  for (let index = 0; index < TERMINAL_COUNT; index += 1) {
    const created = await createTerminal(page, workbench, server, index, run);
    terminalHandles.push({ ...created, index });
  }
  const initialActive = terminalHandles.at(-1);
  if (!initialActive) throw new Error("S-01 did not create an initial active terminal");
  const activePane = await workbench.openTerminal({ id: initialActive.id, name: initialActive.name });
  await activePane.expectVisible();

  expect(await workbench.mountedPaneCount()).toBe(TERMINAL_COUNT);
  expect(await workbench.visiblePaneCount()).toBe(VISIBLE_COUNT);
  const terminalIds = terminalHandles.map((terminal) => terminal.id);
  const snapshots = await allTerminalSnapshots(page, terminalIds);
  expect(snapshots).toHaveLength(TERMINAL_COUNT);
  const visible = snapshots.filter((snapshot) => snapshot.lifecycle.visible);
  const cached = snapshots.filter((snapshot) => snapshot.lifecycle.cached);
  expect(visible).toHaveLength(VISIBLE_COUNT);
  expect(cached).toHaveLength(CACHED_COUNT);
  expect(visible.filter((snapshot) => snapshot.lifecycle.active)).toHaveLength(1);
  expect(visible.filter((snapshot) => snapshot.lifecycle.focused)).toHaveLength(1);
  expect(visible.find((snapshot) => snapshot.lifecycle.active)?.terminalId).toBe(
    visible.find((snapshot) => snapshot.lifecycle.focused)?.terminalId,
  );
  for (const snapshot of snapshots) {
    expect(snapshot.socketState).toBe("connected");
    expect(snapshot.activeSocketCount).toBe(1);
    expect(snapshot.socket.activeCount).toBe(1);
    expect(snapshot.socketGeneration).toBe(1);
    expect(snapshot.pendingParserWrites).toBe(0);
    expect(snapshot.renderBacklogBytes).toBe(0);
    expect(snapshot.renderBacklogFrames).toBe(0);
    expect(snapshot.serverViewport).toMatchObject({ cols: snapshot.cols, rows: snapshot.rows });
    if (snapshot.lifecycle.cached) {
      expect(snapshot.lifecycle.visible).toBe(false);
      expect(snapshot.lifecycle.active).toBe(false);
      expect(snapshot.lifecycle.focused).toBe(false);
      expect(snapshot.lifecycle.acceptingInput).toBe(false);
      const focus = latestEvent(await terminalEvents(page, snapshot.terminalId), "focus");
      expect(focus?.data.controller).not.toBe(true);
      expect(focus?.data.responder).not.toBe(true);
    } else {
      expect(snapshot.lifecycle.acceptingInput).toBe(snapshot.lifecycle.active);
    }
    await assertMonotonicSequences(await terminalEvents(page, snapshot.terminalId));
    const invariantReport = await expectTerminalInvariants(page, snapshot.terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
  }
  for (const snapshot of visible) await workbench.expectVisibleTerminal(snapshot.terminalId);
  for (const snapshot of cached) {
    await workbench.expectCached(snapshot.terminalId);
    await waitForCached(page, snapshot.terminalId);
  }
  await Promise.all(terminalIds.map((terminalId) => waitForCheckpoint(page, terminalId)));
  const baselineSnapshots = await allTerminalSnapshots(page, terminalIds);
  expect(baselineSnapshots).toHaveLength(TERMINAL_COUNT);
  for (const snapshot of baselineSnapshots) {
    expect(snapshot.checkpointResult).not.toBe("failed");
    const terminalIndex = terminalHandles.find((terminal) => terminal.id === snapshot.terminalId)?.index;
    if (terminalIndex === undefined) throw new Error(`no fixture index for terminal ${snapshot.terminalId}`);
    const transcript = await server.readTranscript(snapshot.terminalId);
    const size = transcript.find((entry) => entry.event === "size" && entry.id === `${run}-SIZE-${terminalIndex}`);
    if (!size) throw new Error(`fixture did not record SIZE for terminal ${snapshot.terminalId}`);
    expect(size.rows).toBe(snapshot.rows);
    expect(size.cols).toBe(snapshot.cols);
    expect(size.pixel_width).toBe(snapshot.pixelWidth);
    expect(size.pixel_height).toBe(snapshot.pixelHeight);
    expect(snapshot.serverViewport).toMatchObject({
      cols: size.cols,
      rows: size.rows,
      pixelWidth: size.pixel_width,
      pixelHeight: size.pixel_height,
    });
  }
  const baselineEvents = await Promise.all(terminalIds.map(async (terminalId) => [terminalId, await terminalEvents(page, terminalId)] as const));
  baselineEventIds = new Map(baselineEvents.map(([terminalId, events]) => [terminalId, events.at(-1)?.id ?? -1]));
  baselineTranscriptLengths = new Map(
    await Promise.all(terminalIds.map(async (terminalId) => [terminalId, (await server.readTranscript(terminalId)).length] as const)),
  );
  const baselineProxy = { ...faultStats };
  const baselineStartedAt = Date.now();
  const baselineSample = await collectResourceSample(
    page,
    terminalIds,
    server,
    { ...baselineProxy },
    processState,
    baselineStartedAt,
  );
  processState = baselineSample.process;
  samples.push(baselineSample.sample);
  for (let offset = SAMPLE_INTERVAL_MS; offset <= SOAK_DURATION_MS; offset += SAMPLE_INTERVAL_MS) {
    await waitForWallClockBoundary(baselineStartedAt, offset);
    const sampled = await collectResourceSample(
      page,
      terminalIds,
      server,
      { ...faultStats },
      processState,
      baselineStartedAt,
    );
    processState = sampled.process;
    samples.push(sampled.sample);
  }
  expect(Date.now() - baselineStartedAt).toBeGreaterThanOrEqual(SOAK_DURATION_MS);
  await attachMetrics(testInfo, run, samples);

  const postMeasurementSnapshots = await allTerminalSnapshots(page, terminalIds);
  expect(postMeasurementSnapshots).toHaveLength(TERMINAL_COUNT);
  for (const snapshot of postMeasurementSnapshots) {
    expect(snapshot.socketState).toBe("connected");
    expect(snapshot.activeSocketCount).toBe(1);
    expect(snapshot.socketGeneration).toBe(1);
    expect(snapshot.lifecycle.mounted).toBe(true);
    expect(snapshot.lifecycle.cached).toBe(snapshot.lifecycle.visible === false);
    expect(snapshot.lifecycle.acceptingInput).toBe(snapshot.lifecycle.active);
    expect(forbiddenMeasurementEvents(
      await terminalEvents(page, snapshot.terminalId),
      baselineEventIds.get(snapshot.terminalId) ?? -1,
    )).toEqual([]);
    expect((await server.readTranscript(snapshot.terminalId)).length).toBe(baselineTranscriptLengths.get(snapshot.terminalId));
    expect((await server.readTranscript(snapshot.terminalId)).filter((entry) => entry.event === "error")).toEqual([]);
  }
  expect(faultStats.faultEvents).toBe(0);
  expect(faultStats.connectionOpens).toBe(baselineProxy.connectionOpens);
  expect(faultStats.connectionCloses).toBe(baselineProxy.connectionCloses);

  const totalSockets = samples.map((sample) => sample.terminals.reduce((sum, terminal) => sum + terminal.activeSocketCount, 0));
  const totalContexts = samples.map((sample) => sample.browser.webglContexts);
  const totalCanvases = samples.map((sample) => sample.browser.canvasCount);
  const totalTimers = samples.map((sample) => {
    expect(sample.browser.timers.status).toBe("ok");
    return sample.browser.timers.status === "ok" ? sample.browser.timers.total : -1;
  });
  const rssValues = samples.map((sample) => sample.process.rssBytes).filter((value) => value > 0);
  const heapValues = samples.map((sample) => sample.browser.heap.usedBytes ?? 0).filter((value) => value > 0);
  expect(new Set(totalSockets)).toEqual(new Set([TERMINAL_COUNT]));
  expect(new Set(totalContexts).size).toBe(1);
  expect(new Set(totalCanvases).size).toBe(1);
  expect(new Set(totalTimers).size).toBe(1);
  const firstRss = rssValues[0];
  if (firstRss !== undefined) assertFlatResourceSeries("server tree RSS", rssValues, Math.max(8 * 1024 * 1024, firstRss * 0.2));
  const firstHeap = heapValues[0];
  if (firstHeap !== undefined) assertFlatResourceSeries("browser heap", heapValues, Math.max(8 * 1024 * 1024, firstHeap * 0.2));
  for (const sample of samples) {
    expect(sample.process.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(sample.browser.contextLosses).toBe(0);
    expect(sample.browser.fallbackCount).toBe(0);
    expect(sample.terminals.every((terminal) => terminal.socketGeneration === 1)).toBe(true);
    expect(sample.terminals.every((terminal) => terminal.activeSocketCount === 1)).toBe(true);
  }
  for (const terminal of terminalHandles) {
    const pane = await workbench.openTerminal({ id: terminal.id, name: terminal.name });
    await pane.expectVisible();
    await waitForInteractive(page, terminal.id);
    const holdToken = `S01-END-${terminal.id}`;
    await pane.sendInput(`RELEASE ${holdToken}`, true);
    await server.waitForTranscript(terminal.id, (entry) => entry.event === "release" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
  }

  const finalVisibleId = visible.find((snapshot) => snapshot.lifecycle.active)?.terminalId ?? visible.at(-1)?.terminalId;
  if (!finalVisibleId) throw new Error("no final visible terminal was found");
  const finalPane = new TerminalPanePage(page, finalVisibleId, terminalHandles.find((terminal) => terminal.id === finalVisibleId)?.name);
  await finalPane.expectVisible();
  await waitForInteractive(page, finalVisibleId);
  const beforePixels = await screenshotRegion(page, finalPane.xtermHost);
  const finalPrintId = `${run}-FINAL-PRINT`;
  const finalPrintText = `${run}-QUIET-FINAL`;
  await finalPane.sendInput(`PRINT ${finalPrintId} ${finalPrintText}`, true);
  await server.waitForTranscript(finalVisibleId, (entry) => entry.event === "print" && entry.id === finalPrintId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, finalVisibleId, {
    contains: `[E2E:PRINT:${finalPrintId}:${finalPrintText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, finalPane.xtermHost, beforePixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "s-01-final-marker-crop",
  });
  await expectTerminalNonBlank(page, finalPane.xtermHost, {
    testInfo,
    artifactName: "s-01-final-terminal-crop",
  });

  const echoId = `${run}-CONTINUED-ECHO`;
  const echoText = `${run}-CONTINUED-INPUT`;
  await finalPane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(finalVisibleId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await finalPane.sendInput(echoText, true);
  const echo = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64?: string }>(
    finalVisibleId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echo.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, finalVisibleId, {
    contains: `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const finalInteractive = await expectTerminalInteractive(page, finalVisibleId, { timeout: WAIT_TIMEOUT_MS });
  expect(finalInteractive.acceptingInput).toBe(true);
  expect(finalInteractive.activeSocketCount).toBe(1);
  assertNoPendingSynchronization(finalInteractive);

  const finalEvents = await terminalEvents(page, finalVisibleId);
  expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
  await assertMonotonicSequences(finalEvents);
  expect((await server.readTranscript(finalVisibleId)).filter((entry) => entry.event === "error")).toEqual([]);
  expect(browserErrors()).toEqual([]);

  for (const terminal of terminalHandles) {
    const pane = await workbench.openTerminal({ id: terminal.id, name: terminal.name });
    await pane.expectVisible();
    await waitForInteractive(page, terminal.id);
    await pane.sendInput("EXIT 0", true);
    await server.waitForTranscript(terminal.id, (entry) => entry.event === "exit" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
  }
  for (const terminal of terminalHandles) await removeTerminal(page, workbench, terminal);

  expect(await workbench.mountedPaneCount()).toBe(0);
  const remainingSnapshots = await page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminals();
  });
  expect(remainingSnapshots).toEqual([]);
  const finalCanvasCount = await page.locator("canvas").count();
  expect(finalCanvasCount).toBe(0);
  for (const terminal of terminalHandles) {
    const transcript = await server.readTranscript(terminal.id);
    expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(transcript.filter((entry) => entry.event === "exit" && entry.code === 0)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "ready" && entry.id === `${run}-READY-${terminal.index}`)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "size" && entry.id === `${run}-SIZE-${terminal.index}`)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "hold" && entry.token === `S01-END-${terminal.id}`)).toHaveLength(1);
  }
  expect(browserErrors()).toEqual([]);
  browserErrors.dispose();
  faultListener.dispose();
});
