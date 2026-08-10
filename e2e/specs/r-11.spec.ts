import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { Page } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultController } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import LoginPage from "../pages/login-page.js";
import TerminalPanePage from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 45_000;
const REPAINT_BYTES = 131_072;
const PERFORMANCE_KEY = "__TERM_SERVER_E2E_R11_PERFORMANCE__";

// Recording captures model lines and compositor screenshots. This is an explicit
// paired-run budget rather than an unbounded allowance for the capture path.
const OVERHEAD_RATIO_BUDGET = 0.5;
const OVERHEAD_SLACK_MS = 750;
const LONG_TASK_COUNT_SLACK = 5;

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

type JsonObject = Record<string, unknown>;
type DiagnosticEventType = E2ETerminalEvent["type"];

type CreatedTerminal = {
  readonly id: string;
  readonly name: string;
  readonly pane: TerminalPanePage;
};

type LongTask = {
  readonly startTime: number;
  readonly duration: number;
};

type BrowserPerformance = {
  readonly supported: boolean;
  readonly wallMs: number;
  readonly longTaskCount: number;
  readonly longTaskTotalMs: number;
  readonly longestLongTaskMs: number;
};

type WorkloadMetrics = {
  readonly performance: BrowserPerformance;
  readonly receiveToParserMs: number;
  readonly receiveToRenderMs: number;
  readonly inputLatencyMs: number;
};

type WorkloadResult = {
  readonly mode: "off" | "on";
  readonly initial: E2ETerminalSnapshot;
  readonly recovered: E2ETerminalSnapshot;
  readonly final: E2ETerminalSnapshot;
  readonly events: readonly E2ETerminalEvent[];
  readonly transcript: readonly TranscriptEntry[];
  readonly metrics: WorkloadMetrics;
  readonly beforeColors: TerminalPixelImage;
  readonly afterColors: TerminalPixelImage;
  readonly beforeRepaint: TerminalPixelImage;
  readonly afterRepaint: TerminalPixelImage;
  readonly proxyEventFloor: number;
  readonly proxyEvents: number;
  readonly networkBytes: number;
};

type RecordingStatus = {
  readonly active: boolean;
  readonly events: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly stoppedAt?: number;
};

type RecordingPayload = {
  readonly format: unknown;
  readonly version: unknown;
  readonly stoppedAt?: unknown;
  readonly truncated: unknown;
  readonly events: readonly JsonObject[];
  readonly client: {
    readonly truncated: unknown;
    readonly events: readonly JsonObject[];
  };
};

type EventMatch = {
  readonly dataSequence?: number;
  readonly dataGeneration?: number;
  readonly dataMode?: string;
  readonly dataVisible?: boolean;
  readonly socketGenerationGreaterThan?: number;
};

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as JsonObject;
}

function stringField(value: JsonObject, key: string, label = key): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw new Error(`${label} was not a non-empty string`);
  return field;
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

function markerOccurrences(text: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(marker, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, marker.length);
  }
  return count;
}

function transcriptSequence(entry: TranscriptEntry): number {
  const sequence = entry.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("fixture transcript entry omitted a non-negative sequence");
  }
  return sequence;
}

function transcriptFloor(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
}

function outputByteCount(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.event !== "write") return total;
    const bytes = entry.bytes;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("fixture write transcript omitted a non-negative byte count");
    }
    return total + bytes;
  }, 0);
}

function commandCount(entries: readonly TranscriptEntry[], command: string): number {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return entries.filter((entry) => entry.event === "command" && entry.command_base64 === encoded).length;
}

function canonicalTranscript(entries: readonly TranscriptEntry[]): string {
  return JSON.stringify(entries.map((entry) => {
    const { sequence: _sequence, write_sequence: _writeSequence, chunk: _chunk, chunk_index: _chunkIndex, ...rest } = entry;
    return rest;
  }));
}

function sumNetworkFrameBytes(events: readonly { readonly type: string; readonly frame?: { readonly bytes?: number } }[]): number {
  return events.reduce((total, event) => {
    if (event.type !== "frame") return total;
    const bytes = event.frame?.bytes;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("network frame omitted a non-negative byte count");
    }
    return total + bytes;
  }, 0);
}

function runTag(testInfo: { readonly project: { readonly name: string }; readonly workerIndex: number; readonly parallelIndex: number; readonly repeatEachIndex: number }): string {
  return `R11-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-e${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
}

async function installPerformanceObserver(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    const supported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const metrics = { supported, longTasks: [] as LongTask[] };
    target[key] = metrics;
    if (!supported) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        metrics.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
    target[`${key}:observer`] = observer;
  }, PERFORMANCE_KEY);
}

async function clearPerformanceObserver(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const metrics = target[key] as { longTasks?: unknown } | undefined;
    if (!metrics || !Array.isArray(metrics.longTasks)) throw new Error("R-11 performance metrics are unavailable");
    metrics.longTasks.length = 0;
  }, PERFORMANCE_KEY);
}

async function finishPerformanceMeasurement(page: Page, startedAt: number): Promise<BrowserPerformance> {
  const wallEnd = await page.evaluate(() => performance.now());
  const metrics = await page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const value = target[key] as { supported?: unknown; longTasks?: unknown } | undefined;
    if (!value || typeof value.supported !== "boolean" || !Array.isArray(value.longTasks)) {
      throw new Error("R-11 performance metrics are unavailable");
    }
    const longTasks = value.longTasks as LongTask[];
    return {
      supported: value.supported,
      longTasks: longTasks.map((entry) => ({ startTime: entry.startTime, duration: entry.duration })),
    };
  }, PERFORMANCE_KEY);
  const durations = metrics.longTasks.map((entry) => {
    if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.duration) || entry.duration < 0) {
      throw new Error("R-11 long-task metrics contained an invalid duration");
    }
    return entry.duration;
  });
  return {
    supported: metrics.supported,
    wallMs: Math.max(0, wallEnd - startedAt),
    longTaskCount: durations.length,
    longTaskTotalMs: durations.reduce((total, duration) => total + duration, 0),
    longestLongTaskMs: Math.max(0, ...durations),
  };
}

async function disposePerformanceObserver(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    delete target[`${key}:observer`];
    delete target[key];
  }, PERFORMANCE_KEY);
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: DiagnosticEventType,
  match: EventMatch = {},
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, eventMatch, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.id <= after || event.type !== eventType) return false;
      const data = event.data as Record<string, unknown>;
      if (eventMatch.dataSequence !== undefined && data.sequence !== eventMatch.dataSequence) return false;
      if (eventMatch.dataGeneration !== undefined && data.generation !== eventMatch.dataGeneration) return false;
      if (eventMatch.dataMode !== undefined && data.mode !== eventMatch.dataMode) return false;
      if (eventMatch.dataVisible !== undefined && data.visible !== eventMatch.dataVisible) return false;
      if (
        eventMatch.socketGenerationGreaterThan !== undefined
        && event.snapshot.socketGeneration <= eventMatch.socketGenerationGreaterThan
      ) return false;
      return true;
    }, { timeout });
  }, {
    id: terminalId,
    after: afterEventId,
    eventType: type,
    eventMatch: match,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForRenderedMarker(
  page: Page,
  terminalId: string,
  afterEventId: number,
  marker: string,
  previousRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, after, markerText, renderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const events = api.events(id);
      const hasNewRender = events.some((event) => event.id > after && event.type === "render");
      return snapshot.renderCount > renderCount
        && hasNewRender
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && snapshot.xterm.text.includes(markerText);
    }, { timeout });
  }, {
    id: terminalId,
    after: afterEventId,
    markerText: marker,
    renderCount: previousRenderCount,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForRecoveredTerminal(
  page: Page,
  terminalId: string,
  previousGeneration: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration > generation
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
    ), { timeout });
  }, { id: terminalId, generation: previousGeneration, timeout: WAIT_TIMEOUT_MS });
}

async function readRecordingStatus(page: Page): Promise<RecordingStatus> {
  const value = await page.evaluate(async () => {
    const response = await fetch("/api/debug/recording", { cache: "no-store" });
    if (!response.ok) throw new Error(`debug recording status failed with HTTP ${response.status}`);
    return await response.json() as unknown;
  });
  const fields = asObject(value, "debug recording status");
  const stoppedAt = fields.stoppedAt === undefined || fields.stoppedAt === null
    ? undefined
    : numberField(fields, "stoppedAt");
  return {
    active: booleanField(fields, "active"),
    events: safeIntegerField(fields, "events"),
    bytes: safeIntegerField(fields, "bytes"),
    truncated: booleanField(fields, "truncated"),
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
  };
}

async function controlRecording(page: Page, action: "start" | "stop" | "clear"): Promise<RecordingStatus> {
  const value = await page.evaluate(async (requestedAction) => {
    const response = await fetch("/api/debug/recording", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: requestedAction }),
    });
    if (!response.ok) throw new Error(`debug recording ${requestedAction} failed with HTTP ${response.status}`);
    return await response.json() as unknown;
  }, action);
  const fields = asObject(value, "debug recording control response");
  const stoppedAt = fields.stoppedAt === undefined || fields.stoppedAt === null
    ? undefined
    : numberField(fields, "stoppedAt");
  return {
    active: booleanField(fields, "active"),
    events: safeIntegerField(fields, "events"),
    bytes: safeIntegerField(fields, "bytes"),
    truncated: booleanField(fields, "truncated"),
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
  };
}

function parseRecordingPayload(value: unknown): RecordingPayload {
  const fields = asObject(value, "debug recording download");
  const eventsValue = fields.events;
  if (!Array.isArray(eventsValue)) throw new Error("debug recording download omitted server events");
  const client = asObject(fields.client, "debug recording client payload");
  const clientEvents = client.events;
  if (!Array.isArray(clientEvents)) throw new Error("debug recording download omitted client events");
  return {
    format: fields.format,
    version: fields.version,
    stoppedAt: fields.stoppedAt,
    truncated: fields.truncated,
    events: eventsValue.map((event) => asObject(event, "debug recording server event")),
    client: {
      truncated: client.truncated,
      events: clientEvents.map((event) => asObject(event, "debug recording client event")),
    },
  };
}

function assertRecordingEvents(
  payload: RecordingPayload,
  terminalId: string,
  finalSnapshot: E2ETerminalSnapshot,
): { readonly backendOutputBytes: number; readonly clientTypes: ReadonlySet<string> } {
  expect(payload.format).toBe("term-server-debug-recording");
  expect(String(payload.version)).toBe("1");
  expect(payload.truncated).toBe(false);
  expect(payload.client.truncated).toBe(false);
  expect(payload.events.length).toBeGreaterThan(0);
  expect(payload.client.events.length).toBeGreaterThan(0);

  const backendEvents = payload.events;
  const outputEvents = backendEvents.filter((event) => event.type === "output");
  expect(outputEvents.length).toBeGreaterThan(0);
  let previousSequence = 0;
  let backendOutputBytes = 0;
  for (const [index, event] of outputEvents.entries()) {
    expect(stringField(event, "terminal", "recording server terminal")).toBe(terminalId);
    const sequence = safeIntegerField(event, "sequence", "recording output sequence");
    const data = stringField(event, "data", "recording output data");
    const bytes = Buffer.from(data, "base64");
    expect(bytes.length).toBeGreaterThan(0);
    if (index === 0) expect(sequence).toBe(0);
    else expect(sequence).toBe(previousSequence);
    previousSequence = sequence + bytes.length;
    backendOutputBytes += bytes.length;
  }
  expect(previousSequence).toBe(finalSnapshot.committedSequence);

  const clientTypes = new Set<string>();
  let maximumClientTimestamp = 0;
  for (const event of payload.client.events) {
    const terminal = stringField(event, "terminal", "recording client terminal");
    expect(terminal).toBe(terminalId);
    const timestamp = safeIntegerField(event, "ts", "recording client timestamp");
    maximumClientTimestamp = Math.max(maximumClientTimestamp, timestamp);
    const nested = asObject(event.event, "recording client event body");
    clientTypes.add(stringField(nested, "type", "recording client event type"));
  }
  const requiredClientTypes = ["connect", "output", "write", "sync", "synced", "render", "renderer", "screenshot", "visibility"];
  for (const type of requiredClientTypes) expect(clientTypes.has(type)).toBe(true);
  const stoppedAt = numberField(asObject(payload, "recording payload"), "stoppedAt", "recording stoppedAt");
  expect(maximumClientTimestamp).toBeLessThanOrEqual(stoppedAt);
  return { backendOutputBytes, clientTypes };
}

function assertOverheadBudget(
  baseline: WorkloadResult,
  recording: WorkloadResult,
): void {
  const withinBudget = (actual: number, reference: number, slack = OVERHEAD_SLACK_MS): void => {
    expect(actual).toBeLessThanOrEqual(reference * (1 + OVERHEAD_RATIO_BUDGET) + slack);
  };
  withinBudget(recording.metrics.performance.wallMs, baseline.metrics.performance.wallMs);
  withinBudget(recording.metrics.receiveToParserMs, baseline.metrics.receiveToParserMs, 250);
  withinBudget(recording.metrics.receiveToRenderMs, baseline.metrics.receiveToRenderMs, 250);
  withinBudget(recording.metrics.inputLatencyMs, baseline.metrics.inputLatencyMs, 250);
  if (baseline.metrics.performance.supported && recording.metrics.performance.supported) {
    withinBudget(recording.metrics.performance.longTaskTotalMs, baseline.metrics.performance.longTaskTotalMs, 250);
    withinBudget(recording.metrics.performance.longestLongTaskMs, baseline.metrics.performance.longestLongTaskMs, 250);
    expect(recording.metrics.performance.longTaskCount).toBeLessThanOrEqual(
      baseline.metrics.performance.longTaskCount + LONG_TASK_COUNT_SLACK,
    );
  }
}

async function createTerminal(page: Page, workbench: WorkbenchPage): Promise<CreatedTerminal> {
  const mountPromise = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.snapshot.kind === "pane",
      { timeout },
    );
  }, WAIT_TIMEOUT_MS);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`terminal creation failed with HTTP ${response.status}`);
  const fields = asObject(await response.json() as unknown, "terminal creation response");
  const id = stringField(fields, "id", "created terminal ID");
  const name = stringField(fields, "name", "created terminal name");
  const mounted = await mountPromise;
  expect(mounted.terminalId).toBe(id);
  const pane = workbench.terminal(id, name);
  await pane.expectVisible();
  const synchronized = await expectTerminalSynchronized(page, id, { timeout: WAIT_TIMEOUT_MS });
  expect(synchronized.socketState).toBe("connected");
  expect(synchronized.activeSocketCount).toBe(1);
  expect(synchronized.acceptingInput).toBe(true);
  return { id, name, pane };
}

async function removeTerminal(page: Page, workbench: WorkbenchPage, created: CreatedTerminal): Promise<void> {
  const events = await terminalEvents(page, created.id);
  const floor = events.at(-1)?.id ?? 0;
  const unmountPromise = waitForEventAfter(page, created.id, floor, "unmount");
  await workbench.sidebar.removeTerminal({ id: created.id, name: created.name });
  await unmountPromise;
}

async function issueRenderedCommand(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  command: string,
  transcriptPredicate: (entry: TranscriptEntry) => boolean,
  marker: string,
): Promise<E2ETerminalSnapshot> {
  const before = await terminalSnapshot(page, terminalId);
  if (!before) throw new Error(`missing diagnostics snapshot before ${command}`);
  const events = await terminalEvents(page, terminalId);
  const floor = events.at(-1)?.id ?? 0;
  const rendered = waitForRenderedMarker(page, terminalId, floor, marker, before.renderCount);
  const transcript = server.waitForTranscript(terminalId, transcriptPredicate, { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(command, true);
  await transcript;
  await expectTerminalBuffer(page, terminalId, { contains: marker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  return rendered;
}

function latestProxyGeneration(
  events: readonly { readonly type: string; readonly terminalId?: string; readonly generation?: number }[],
  terminalId: string,
): number {
  const event = [...events].reverse().find((candidate) => candidate.type === "connection-open" && candidate.terminalId === terminalId);
  if (!event || event.generation === undefined) throw new Error(`missing proxy generation for terminal ${terminalId}`);
  return event.generation;
}

async function runWorkload(
  page: Page,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  created: CreatedTerminal,
  mode: "off" | "on",
  tag: string,
): Promise<WorkloadResult> {
  const { id: terminalId, pane } = created;
  const initial = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  if (initial.gridEpoch === undefined) throw new Error("initial terminal diagnostics omitted grid epoch");
  const initialEvents = await terminalEvents(page, terminalId);
  const initialEventId = initialEvents.at(-1)?.id ?? 0;
  const beforeTranscript = await server.readTranscript(terminalId);
  const beforeTranscriptSequence = transcriptFloor(beforeTranscript);
  const proxyEventFloor = faultController.events.length;
  await clearPerformanceObserver(page);
  const performanceStart = await page.evaluate(() => performance.now());

  const eraseId = `${tag}-ERASE`;
  const readyId = `${tag}-READY`;
  const colorsId = `${tag}-COLORS`;
  const repaintId = `${tag}-REPAINT`;
  const sizeId = `${tag}-SIZE`;
  const echoId = `${tag}-ECHO`;
  const finalId = `${tag}-FINAL`;
  const echoText = `${tag}-CONTINUED-INPUT`;
  const eraseMarker = `[E2E:ERASE:${eraseId}:scrollback]`;
  const readyMarker = `[E2E:READY:${readyId}]`;
  const indexedColorsMarker = `[E2E:COLORS:${colorsId}:INDEXED]`;
  const trueColorsMarker = `[E2E:COLORS:${colorsId}:TRUECOLOR]`;
  const repaintMarker = `[E2E:REPAINT:${repaintId}:FRAME]`;
  const finalMarker = `[E2E:PRINT:${finalId}:${tag}-FINAL-VISIBLE]`;
  const echoReadyMarker = `[E2E:ECHO_INPUT:${echoId}:READY]`;
  const echoPayloadMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;

  await issueRenderedCommand(
    page,
    server,
    pane,
    terminalId,
    `ERASE ${eraseId} scrollback`,
    (entry) => entry.event === "erase" && entry.id === eraseId,
    eraseMarker,
  );
  await issueRenderedCommand(
    page,
    server,
    pane,
    terminalId,
    `READY ${readyId}`,
    (entry) => entry.event === "ready" && entry.id === readyId,
    readyMarker,
  );

  const beforeColors = await screenshotRegion(page, pane.xtermHost);
  const colorsBefore = await terminalSnapshot(page, terminalId);
  if (!colorsBefore) throw new Error("missing diagnostics snapshot before COLORS");
  const colorsRendered = issueRenderedCommand(
    page,
    server,
    pane,
    terminalId,
    `COLORS ${colorsId}`,
    (entry) => entry.event === "colors" && entry.id === colorsId,
    indexedColorsMarker,
  );
  await colorsRendered;
  await expectTerminalBuffer(page, terminalId, { contains: trueColorsMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const afterColors = await screenshotRegion(page, pane.xtermHost);
  expect(afterColors.width).toBe(beforeColors.width);
  expect(afterColors.height).toBe(beforeColors.height);
  await expectKnownMarkerChanged(page, pane.xtermHost, beforeColors, {
    minimumChangedRatio: 0.002,
    artifactName: `r-11-${mode}-colors`,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    artifactName: `r-11-${mode}-colors-nonblank`,
  });

  const beforeRepaint = await screenshotRegion(page, pane.xtermHost);
  const repaintBefore = await terminalSnapshot(page, terminalId);
  if (!repaintBefore || repaintBefore.receivedSequence === undefined) {
    throw new Error("missing received sequence before REPAINT");
  }
  const repaintEvents = await terminalEvents(page, terminalId);
  const repaintEventFloor = repaintEvents.at(-1)?.id ?? initialEventId;
  const repaintTarget = repaintBefore.receivedSequence + REPAINT_BYTES;
  const outputReceivedPromise = waitForEventAfter(
    page,
    terminalId,
    repaintEventFloor,
    "output-received",
    { dataSequence: repaintTarget },
  );
  const parserCommitPromise = waitForEventAfter(
    page,
    terminalId,
    repaintEventFloor,
    "parser-commit",
    { dataSequence: repaintTarget },
  );
  const repaintRenderedPromise = waitForRenderedMarker(
    page,
    terminalId,
    repaintEventFloor,
    repaintMarker,
    repaintBefore.renderCount,
  );
  const repaintRenderEventPromise = waitForEventAfter(page, terminalId, repaintEventFloor, "render");
  const repaintTranscriptPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === REPAINT_BYTES,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`REPAINT ${repaintId} ${REPAINT_BYTES}`, true);
  const [outputReceived, parserCommit, repaintRendered, repaintRenderEvent, repaintEntry] = await Promise.all([
    outputReceivedPromise,
    parserCommitPromise,
    repaintRenderedPromise,
    repaintRenderEventPromise,
    repaintTranscriptPromise,
  ]);
  expect(repaintEntry.bytes).toBe(REPAINT_BYTES);
  expect(outputReceived.data.bytes).toBeGreaterThan(0);
  expect(parserCommit.data.sequence).toBe(repaintTarget);
  expect(repaintRendered.xterm.text).toContain(repaintMarker);
  const afterRepaint = await screenshotRegion(page, pane.xtermHost);
  expect(afterRepaint.width).toBe(beforeRepaint.width);
  expect(afterRepaint.height).toBe(beforeRepaint.height);
  await expectKnownMarkerChanged(page, pane.xtermHost, beforeRepaint, {
    minimumChangedRatio: 0.002,
    artifactName: `r-11-${mode}-repaint`,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    artifactName: `r-11-${mode}-repaint-nonblank`,
  });

  const beforeReconnect = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    activeSocketCount: 1,
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  const previousGeneration = beforeReconnect.socketGeneration;
  const previousProxyGeneration = latestProxyGeneration(faultController.events, terminalId);
  expect(previousProxyGeneration).toBe(previousGeneration);
  const recoveryEventFloor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? 0;
  const socketClosePromise = waitForEventAfter(
    page,
    terminalId,
    recoveryEventFloor,
    "socket-close",
    { dataGeneration: previousGeneration },
  );
  const recoverySyncPromise = waitForEventAfter(
    page,
    terminalId,
    recoveryEventFloor,
    "sync",
    { socketGenerationGreaterThan: previousGeneration },
  );
  const recoverySyncedPromise = waitForEventAfter(
    page,
    terminalId,
    recoveryEventFloor,
    "synced",
    { socketGenerationGreaterThan: previousGeneration },
  );
  const proxyClosePromise = faultController.waitFor((event) => (
    (event.type === "connection-terminated" || event.type === "connection-closed")
    && event.terminalId === terminalId
    && event.generation === previousProxyGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const terminate = faultController.terminate({ terminalId, generation: previousProxyGeneration });
  const [socketClose, proxyClose] = await Promise.all([socketClosePromise, proxyClosePromise]);
  terminate.dispose();
  expect(socketClose.data.generation).toBe(previousGeneration);
  expect(proxyClose.generation).toBe(previousProxyGeneration);
  const [recoverySync, recoverySynced, recovered] = await Promise.all([
    recoverySyncPromise,
    recoverySyncedPromise,
    waitForRecoveredTerminal(page, terminalId, previousGeneration),
  ]);
  expect(recoverySync.data.mode).toBe("resume");
  expect(recoverySynced.snapshot.socketGeneration).toBe(previousGeneration + 1);
  expect(recovered.socketGeneration).toBe(previousGeneration + 1);
  expect(recovered.gridEpoch).toBe(beforeReconnect.gridEpoch);
  expect(recovered.serverViewport?.cols).toBe(recovered.cols);
  expect(recovered.serverViewport?.rows).toBe(recovered.rows);

  const beforeFinal = await terminalSnapshot(page, terminalId);
  if (!beforeFinal) throw new Error("missing diagnostics snapshot before final reconnect marker");
  const beforeFinalPixels = await screenshotRegion(page, pane.xtermHost);
  const finalRendered = issueRenderedCommand(
    page,
    server,
    pane,
    terminalId,
    `PRINT ${finalId} ${tag}-FINAL-VISIBLE`,
    (entry) => entry.event === "print" && entry.id === finalId,
    finalMarker,
  );
  await finalRendered;
  await expectKnownMarkerChanged(page, pane.xtermHost, beforeFinalPixels, {
    minimumChangedRatio: 0.002,
    artifactName: `r-11-${mode}-reconnected-marker`,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    artifactName: `r-11-${mode}-reconnected-nonblank`,
  });

  const sizeBefore = await terminalSnapshot(page, terminalId);
  if (!sizeBefore) throw new Error("missing diagnostics snapshot before final SIZE");
  const sizeEventFloor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? 0;
  const sizeTranscriptPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await sizeTranscriptPromise;
  const ptyRows = safeIntegerField(sizeEntry, "rows", "PTY rows");
  const ptyCols = safeIntegerField(sizeEntry, "cols", "PTY columns");
  expect(ptyRows).toBe(sizeBefore.rows);
  expect(ptyCols).toBe(sizeBefore.cols);
  if (sizeEntry.pixel_width !== undefined) expect(sizeEntry.pixel_width).toBe(sizeBefore.pixelWidth);
  if (sizeEntry.pixel_height !== undefined) expect(sizeEntry.pixel_height).toBe(sizeBefore.pixelHeight);
  const sizeMarker = `[E2E:SIZE:${sizeId}:${ptyRows}:${ptyCols}]`;
  const sizeRendered = waitForRenderedMarker(page, terminalId, sizeEventFloor, sizeMarker, sizeBefore.renderCount);
  await sizeRendered;
  await expectTerminalBuffer(page, terminalId, { contains: sizeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const echoBefore = await terminalSnapshot(page, terminalId);
  if (!echoBefore) throw new Error("missing diagnostics snapshot before continued input");
  const echoEventFloor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? 0;
  const echoArmPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const echoReadyRendered = waitForRenderedMarker(page, terminalId, echoEventFloor, echoReadyMarker, echoBefore.renderCount);
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await echoArmPromise;
  await echoReadyRendered;
  await expectTerminalBuffer(page, terminalId, { contains: echoReadyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const echoPayloadPromise = server.waitForTranscript<JsonObject>(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const inputStart = performance.now();
  const inputBefore = await terminalSnapshot(page, terminalId);
  if (!inputBefore) throw new Error("missing diagnostics snapshot before input payload");
  const inputEventFloor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? echoEventFloor;
  const inputRendered = waitForRenderedMarker(page, terminalId, inputEventFloor, echoPayloadMarker, inputBefore.renderCount);
  await pane.sendInput(echoText, true);
  const echoEntry = await echoPayloadPromise;
  const inputLatencyMs = performance.now() - inputStart;
  expect(echoEntry.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
  await inputRendered;
  await expectTerminalBuffer(page, terminalId, { contains: echoPayloadMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const final = await expectTerminalConverged(page, terminalId, {
    cols: initial.cols,
    rows: initial.rows,
    pixelWidth: initial.pixelWidth,
    pixelHeight: initial.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(final.socketGeneration).toBe(previousGeneration + 1);
  expect(final.socketState).toBe("connected");
  expect(final.activeSocketCount).toBe(1);
  expect(final.socket.activeCount).toBe(1);
  expect(final.acceptingInput).toBe(true);
  expect(final.gridEpoch).toBe(beforeReconnect.gridEpoch);
  expect(final.serverViewport?.cols).toBe(final.cols);
  expect(final.serverViewport?.rows).toBe(final.rows);
  expect(final.serverViewport?.pixelWidth).toBe(final.pixelWidth);
  expect(final.serverViewport?.pixelHeight).toBe(final.pixelHeight);
  expect(final.xterm.text).toContain(readyMarker);
  expect(final.xterm.text).toContain(indexedColorsMarker);
  expect(final.xterm.text).toContain(trueColorsMarker);
  expect(final.xterm.text).toContain(repaintMarker);
  expect(final.xterm.text).toContain(finalMarker);
  expect(final.xterm.text).toContain(sizeMarker);
  expect(final.xterm.text).toContain(echoReadyMarker);
  expect(final.xterm.text).toContain(echoPayloadMarker);
  expect(markerOccurrences(final.xterm.text, readyMarker)).toBe(1);
  expect(markerOccurrences(final.xterm.text, indexedColorsMarker)).toBe(1);
  expect(markerOccurrences(final.xterm.text, trueColorsMarker)).toBe(1);
  expect(markerOccurrences(final.xterm.text, finalMarker)).toBe(1);
  expect(markerOccurrences(final.xterm.text, sizeMarker)).toBe(1);
  expect(markerOccurrences(final.xterm.text, echoPayloadMarker)).toBe(1);
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  assertNoPendingSynchronization(final);
  assertNoUnexpectedSocketMultiplication([initial, beforeReconnect, recovered, final]);

  const transcript = await server.readTranscript(terminalId);
  const runTranscript = transcript.filter((entry) => transcriptSequence(entry) > beforeTranscriptSequence);
  expect(runTranscript.length).toBeGreaterThan(0);
  const expectedCommands = [
    `ERASE ${eraseId} scrollback`,
    `READY ${readyId}`,
    `COLORS ${colorsId}`,
    `REPAINT ${repaintId} ${REPAINT_BYTES}`,
    `PRINT ${finalId} ${tag}-FINAL-VISIBLE`,
    `SIZE ${sizeId}`,
    `ECHO_INPUT ${echoId}`,
    echoText,
  ];
  for (const command of expectedCommands) expect(commandCount(runTranscript, command)).toBe(1);
  expect(runTranscript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(runTranscript.filter((entry) => entry.event === "colors" && entry.id === colorsId)).toHaveLength(1);
  expect(runTranscript.filter((entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === REPAINT_BYTES)).toHaveLength(1);
  expect(runTranscript.filter((entry) => entry.event === "write" && entry.bytes === REPAINT_BYTES)).toHaveLength(1);
  expect(runTranscript.filter((entry) => entry.event === "print" && entry.id === finalId)).toHaveLength(1);
  expect(runTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(runTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(runTranscript.filter((entry) => entry.event === "exit")).toHaveLength(0);
  expect(final.receivedSequence).toBe(outputByteCount(transcript));
  expect(final.committedSequence).toBe(outputByteCount(transcript));
  const winches = transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal");
  expect(winches.length).toBeGreaterThan(0);
  expect(winches.some((entry) => entry.rows === final.rows && entry.cols === final.cols)).toBe(true);

  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(2);
  expect(events.filter((event) => event.type === "socket-open")).toHaveLength(2);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(1);
  expect(events.filter((event) => event.type === "sync")).toHaveLength(2);
  expect(events.filter((event) => event.type === "sync")[1]?.data.mode).toBe("resume");
  expect(events.filter((event) => event.type === "synced")).toHaveLength(2);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.some((event) => event.type === "state" && event.data.state === "disconnected")).toBe(true);
  const proxyEvents = faultController.events.slice(proxyEventFloor).filter((event) => event.terminalId === terminalId);
  const proxyConnections = faultController.events.filter((event) => event.type === "connection-open" && event.terminalId === terminalId);
  const proxyDisconnects = faultController.events.filter((event) => (
    (event.type === "connection-terminated" || event.type === "connection-closed")
      && event.terminalId === terminalId
      && event.generation === previousProxyGeneration
  ));
  expect(proxyConnections).toHaveLength(2);
  expect(proxyDisconnects).toHaveLength(1);
  const networkBytes = sumNetworkFrameBytes(proxyEvents);
  const performanceMetrics = await finishPerformanceMeasurement(page, performanceStart);
  expect(performanceMetrics.wallMs).toBeGreaterThanOrEqual(0);
  const receiveToParserMs = parserCommit.timestamp - outputReceived.timestamp;
  const receiveToRenderMs = repaintRenderEvent.timestamp - outputReceived.timestamp;
  expect(receiveToParserMs).toBeGreaterThanOrEqual(0);
  expect(receiveToRenderMs).toBeGreaterThanOrEqual(0);

  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  return {
    mode,
    initial,
    recovered,
    final,
    events,
    transcript,
    metrics: {
      performance: performanceMetrics,
      receiveToParserMs,
      receiveToRenderMs,
      inputLatencyMs,
    },
    beforeColors,
    afterColors,
    beforeRepaint,
    afterRepaint,
    proxyEventFloor,
    proxyEvents: proxyConnections.length - 1,
    networkBytes,
  };
}

async function downloadRecording(page: Page, workbench: WorkbenchPage): Promise<{ readonly payload: RecordingPayload; readonly status: RecordingStatus }> {
  const settings = await workbench.openSettings();
  await settings.stopRecording();
  const status = await readRecordingStatus(page);
  expect(status.active).toBe(false);
  const downloadPromise = page.waitForEvent("download");
  await settings.downloadRecording();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("debug recording download did not expose a local path");
  const payload = parseRecordingPayload(JSON.parse(await readFile(path, "utf8")) as unknown);
  return { payload, status };
}

test.setTimeout(240_000);

test("R-11 Debug recording enabled @p1 @nightly @debug @recording @rendering @reconnect", async ({ page, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let recordingActive = false;
  try {
    await page.goto("/");
    await new LoginPage(page).login();
    await installPerformanceObserver(page);
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const cleared = await controlRecording(page, "clear");
    expect(cleared.active).toBe(false);
    expect(cleared.events).toBe(0);
    expect(cleared.bytes).toBe(0);

    const baselineCreated = await createTerminal(page, workbench);
    const baseline = await runWorkload(
      page,
      server,
      faultController,
      baselineCreated,
      "off",
      runTag(testInfo),
    );
    await removeTerminal(page, workbench, baselineCreated);

    const settings = await workbench.openSettings();
    await settings.startRecording();
    recordingActive = true;
    const recordingStatus = await readRecordingStatus(page);
    expect(recordingStatus.active).toBe(true);
    await workbench.showTerminals();
    const recordingCreated = await createTerminal(page, workbench);
    const recording = await runWorkload(
      page,
      server,
      faultController,
      recordingCreated,
      "on",
      runTag(testInfo),
    );

    const recordingDownload = await downloadRecording(page, workbench);
    recordingActive = false;
    const stoppedStatus = recordingDownload.status;
    expect(stoppedStatus.active).toBe(false);
    expect(stoppedStatus.events).toBeGreaterThan(0);
    expect(stoppedStatus.bytes).toBeGreaterThan(0);
    expect(stoppedStatus.truncated).toBe(false);
    const recorded = assertRecordingEvents(recordingDownload.payload, recordingCreated.id, recording.final);
    expect(recorded.backendOutputBytes).toBe(recording.final.committedSequence);

    expect(recording.initial.cols).toBe(baseline.initial.cols);
    expect(recording.transcript.length).toBe(baseline.transcript.length);
    expect(canonicalTranscript(recording.transcript)).toBe(canonicalTranscript(baseline.transcript));
    expect(recording.initial.rows).toBe(baseline.initial.rows);
    expect(recording.final.cols).toBe(baseline.final.cols);
    expect(recording.final.rows).toBe(baseline.final.rows);
    expect(recording.final.serverViewport?.cols).toBe(baseline.final.serverViewport?.cols);
    expect(recording.final.serverViewport?.rows).toBe(baseline.final.serverViewport?.rows);
    expect(recording.final.committedSequence).toBe(recording.final.receivedSequence);
    expect(baseline.final.committedSequence).toBe(baseline.final.receivedSequence);
    expect(recording.proxyEvents).toBe(1);
    expect(baseline.proxyEvents).toBe(1);
    expect(recording.networkBytes).toBe(baseline.networkBytes);
    expect(recording.transcript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(baseline.transcript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(recording.events.filter((event) => event.type === "error")).toEqual([]);
    expect(baseline.events.filter((event) => event.type === "error")).toEqual([]);
    expect(recording.final.xterm.text).toContain(`[E2E:PRINT:${runTag(testInfo)}-FINAL:${runTag(testInfo)}-FINAL-VISIBLE]`);
    expect(baseline.final.xterm.text).toContain(`[E2E:PRINT:${runTag(testInfo)}-FINAL:${runTag(testInfo)}-FINAL-VISIBLE]`);
    assertOverheadBudget(baseline, recording);

    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "console" && /^error:/i.test(entry.message)
      || /unhandled(?:promise)?|uncaught/i.test(entry.message)
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error|internal server error)/i);
  } finally {
    if (recordingActive) await controlRecording(page, "stop");
    await disposePerformanceObserver(page);
    browserErrors.dispose();
  }
});
