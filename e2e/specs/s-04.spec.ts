import { Buffer } from "node:buffer";
import { Terminal as HeadlessTerminal } from "../fixtures/headless-terminal.js"
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConnected,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants, expectTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 30_000;
const SOAK_DURATION_MS = 30 * 60 * 1_000;
const SCHEDULE_INTERVAL_MS = 5 * 60 * 1_000;
const REPAINT_BYTES = 320 * 4_096;
const CACHE_LIMIT = 8;
const TERMINAL_COUNT = 8;
const SEED = 0x5104;
const PERF_KEY = "__TERM_SERVER_S04_PERFORMANCE__";
const INITIAL_VIEWPORT = { width: 1_280, height: 900 } as const;
const RESIZE_SEQUENCE = [
  { width: 900, height: 600 },
  { width: 1_440, height: 900 },
  { width: 760, height: 600 },
  { width: 1_280, height: 900 },
  { width: 900, height: 600 },
] as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalId = string;

interface TerminalIdentity {
  readonly terminalId: TerminalId;
  readonly name: string;
  readonly pane: TerminalPanePage;
}

interface ResourceCanvas {
  readonly terminalId: string;
  readonly width: number;
  readonly height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

interface PerformanceMetrics {
  readonly supported: boolean;
  readonly longTasks: readonly { readonly startTime: number; readonly duration: number }[];
  readonly heapUsedBytes?: number;
}

interface PhaseMetric {
  readonly phase: number;
  readonly repaintId: string;
  readonly repaintBytes: number;
  readonly outputBytes: number;
  readonly renderLatencyMs: number;
  readonly maxPendingParserBytes: number;
  readonly maxRenderBacklogBytes: number;
  readonly maxRenderBacklogFrames: number;
  readonly maxRenderBacklogAgeMs: number;
  readonly flowControlled: boolean;
  readonly flowPendingAcknowledgementBytes: number;
  readonly renderer: E2ETerminalSnapshot["renderer"];
  readonly webglLoadCount: number;
  readonly contextLossCount: number;
  readonly fallbackCount: number;
  readonly renderCount: number;
}

interface ResizeMetric {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly convergenceMs: number;
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

interface InputMetric {
  readonly index: number;
  readonly roundTripMs: number;
  readonly bytes: number;
}

function apiOrThrow(): E2ETerminalDiagnosticsApi {
  const api = (window as E2EWindow).__TERM_SERVER_E2E__;
  if (!api) throw new Error("term-server E2E diagnostics are unavailable");
  return api;
}

function numberField(entry: TranscriptEntry, key: string): number | undefined {
  const value = entry[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringField(entry: TranscriptEntry, key: string): string | undefined {
  const value = entry[key];
  return typeof value === "string" ? value : undefined;
}

function entrySequence(entry: TranscriptEntry): number {
  return numberField(entry, "sequence") ?? 0;
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(1, needle.length);
  }
}

function summarize(values: readonly number[]): { readonly count: number; readonly p50?: number; readonly p95?: number; readonly max?: number } {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1],
  };
}

function compactSnapshot(snapshot: E2ETerminalSnapshot): Record<string, unknown> {
  return {
    terminalId: snapshot.terminalId,
    paneId: snapshot.paneId,
    socketGeneration: snapshot.socketGeneration,
    socketState: snapshot.socketState,
    activeSocketCount: snapshot.activeSocketCount,
    cols: snapshot.cols,
    rows: snapshot.rows,
    pixelWidth: snapshot.pixelWidth,
    pixelHeight: snapshot.pixelHeight,
    proposedViewport: snapshot.proposedViewport,
    desiredViewport: snapshot.desiredViewport,
    sentViewport: snapshot.sentViewport,
    serverViewport: snapshot.serverViewport,
    gridEpoch: snapshot.gridEpoch,
    receivedSequence: snapshot.receivedSequence,
    committedSequence: snapshot.committedSequence,
    syncMode: snapshot.syncMode,
    syncTarget: snapshot.syncTarget,
    pendingParserBytes: snapshot.pendingParserBytes,
    renderBacklogBytes: snapshot.renderBacklogBytes,
    renderBacklogFrames: snapshot.renderBacklogFrames,
    renderBacklogOldestAgeMs: snapshot.renderBacklogOldestAgeMs,
    flowPendingAcknowledgementBytes: snapshot.flowPendingAcknowledgementBytes,
    checkpoint: snapshot.checkpoint,
    renderer: snapshot.renderer,
    webglLoadCount: snapshot.webglLoadCount,
    contextLossCount: snapshot.contextLossCount,
    fallbackCount: snapshot.fallbackCount,
    renderCount: snapshot.renderCount,
    activeBuffer: snapshot.activeBuffer,
    cursorX: snapshot.cursorX,
    cursorY: snapshot.cursorY,
    lifecycle: snapshot.lifecycle,
  };
}

async function installPerformanceObserver(page: Page): Promise<void> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const supported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const longTasks: { startTime: number; duration: number }[] = [];
    target[key] = { supported, longTasks };
    if (!supported) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    observer.observe({ type: "longtask", buffered: true });
    target[`${key}:observer`] = observer;
  }, PERF_KEY);
}

async function readPerformanceMetrics(page: Page): Promise<PerformanceMetrics> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const metrics = target[key] as { supported?: unknown; longTasks?: unknown } | undefined;
    if (!metrics || typeof metrics.supported !== "boolean" || !Array.isArray(metrics.longTasks)) {
      throw new Error("S-04 performance metrics were not installed");
    }
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    const performanceWithMemory = performance as Performance & {
      memory?: { usedJSHeapSize?: unknown };
    };
    const heap = performanceWithMemory.memory?.usedJSHeapSize;
    return {
      supported: metrics.supported,
      longTasks: metrics.longTasks as { startTime: number; duration: number }[],
      heapUsedBytes: typeof heap === "number" && Number.isFinite(heap) ? heap : undefined,
    };
  }, PERF_KEY);
}

async function canvasResources(page: Page): Promise<readonly ResourceCanvas[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLCanvasElement>(".editor-grid canvas")]
    .map((canvas) => {
      const pane = canvas.closest<HTMLElement>("[data-terminal-id]");
      const bounds = canvas.getBoundingClientRect();
      return {
        terminalId: pane?.dataset.terminalId ?? "",
        width: canvas.width,
        height: canvas.height,
        clientWidth: Math.round(bounds.width),
        clientHeight: Math.round(bounds.height),
      };
    })
    .sort((left, right) => (
      left.terminalId.localeCompare(right.terminalId)
        || left.width - right.width
        || left.height - right.height
    )));
}

async function eventFloor(page: Page, terminalId: string): Promise<number> {
  const events = await terminalEvents(page, terminalId);
  return events.reduce((floor, event) => Math.max(floor, event.id), 0);
}

async function transcriptFloor(server: IsolatedServer, terminalId: string): Promise<number> {
  const entries = await server.readTranscript(terminalId);
  return entries.reduce((floor, entry) => Math.max(floor, entrySequence(entry)), 0);
}

function entriesAfter(entries: readonly TranscriptEntry[], floor: number): readonly TranscriptEntry[] {
  return entries.filter((entry) => entrySequence(entry) > floor);
}

function writesAfter(entries: readonly TranscriptEntry[], floor: number): readonly { readonly bytes: Buffer; readonly byteLength: number }[] {
  return entriesAfter(entries, floor)
    .filter((entry) => entry.event === "write")
    .map((entry) => {
      const encoded = stringField(entry, "data_base64");
      if (!encoded) throw new Error("fixture write transcript entry omitted data_base64");
      const bytes = Buffer.from(encoded, "base64");
      const declared = numberField(entry, "bytes");
      if (declared !== undefined && declared !== bytes.length) {
        throw new Error(`fixture write transcript byte count mismatch: declared ${declared}, decoded ${bytes.length}`);
      }
      return { bytes, byteLength: bytes.length };
    });
}

async function waitForMountedTerminal(
  page: Page,
  terminalId: string,
  visible: boolean,
  active: boolean,
  minimumReceived?: number,
  minimumRender = 1,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, visible, active, minimumReceived, minimumRender, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      if (snapshot.socketState !== "connected" || snapshot.activeSocketCount !== 1) return false;
      if (!snapshot.lifecycle.mounted || snapshot.lifecycle.visible !== visible || snapshot.lifecycle.cached !== !visible) return false;
      if (snapshot.lifecycle.active !== active) return false;
      if (snapshot.pendingParserWrites !== 0 || snapshot.pendingParserBytes !== 0) return false;
      if (snapshot.renderBacklogBytes !== 0 || snapshot.renderBacklogFrames !== 0 || snapshot.flowPendingAcknowledgementBytes >= acknowledgementLimit) return false;
      if (snapshot.syncMode !== undefined || snapshot.syncTarget !== undefined) return false;
      if (snapshot.renderCount < minimumRender) return false;
      return minimumReceived === undefined || (snapshot.receivedSequence ?? -1) >= minimumReceived;
    }, { timeout });
  }, { id: terminalId, visible, active, minimumReceived, minimumRender, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  floor: number,
  type: E2ETerminalEventType,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, floor, type, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.type === type && event.id > floor, { timeout });
  }, { id: terminalId, floor, type, timeout: WAIT_TIMEOUT_MS });
}

async function waitForNewPaneMount(
  page: Page,
  existingIds: readonly string[],
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ existingIds, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount"
      && event.snapshot.kind === "pane"
      && !existingIds.includes(event.terminalId), { timeout });
  }, { existingIds, timeout: WAIT_TIMEOUT_MS });
}

async function writeHeadless(terminal: HeadlessTerminal, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      terminal.write(bytes, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

function headlessText(terminal: HeadlessTerminal): string {
  const active = terminal.buffer.active;
  let text = "";
  const length = Math.max(0, Math.min(active.length, 20_000));
  for (let index = 0; index < length && text.length < 256_000; index += 1) {
    const line = active.getLine(index);
    if (!line) continue;
    text += line.translateToString(true);
    if (index + 1 < length) text += "\n";
  }
  return text;
}

function compareCanvasResources(
  baseline: readonly ResourceCanvas[],
  current: readonly ResourceCanvas[],
): void {
  expect(current.length, "cache switches must not change the live canvas count").toBe(baseline.length);
  expect(current).toEqual(baseline);
}

function compactEvent(event: E2ETerminalEvent): Record<string, unknown> {
  return {
    id: event.id,
    timestamp: event.timestamp,
    terminalId: event.terminalId,
    paneId: event.paneId,
    type: event.type,
    data: event.data,
    snapshot: compactSnapshot(event.snapshot),
  };
}

async function sendInputMarker(
  pane: TerminalPanePage,
  server: IsolatedServer,
  page: Page,
  terminalId: string,
  id: string,
  text: string,
): Promise<InputMetric> {
  const startedAt = Date.now();
  const payloadBase64 = Buffer.from(text, "utf8").toString("base64");
  await pane.sendInput(`ECHO_INPUT ${id}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === id && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(text, true);
  const payload = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === id
      && entry.phase === "payload"
      && entry.payload_base64 === payloadBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(payload.payload_base64).toBe(payloadBase64);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${id}:${payloadBase64}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await waitForMountedTerminal(page, terminalId, true, true);
  return { index: 0, roundTripMs: Date.now() - startedAt, bytes: Buffer.byteLength(text, "utf8") };
}

async function assertNoFaults(events: readonly NetworkFaultEvent[]): Promise<void> {
  const faultEvents = events.filter((event) => [
    "upgrade-delay",
    "paused",
    "resumed",
    "throttled",
    "dropped",
    "restored",
    "close-sent",
    "terminated",
    "injected",
    "malformed-frame",
    "connection-terminated",
    "socket-error",
  ].includes(event.type));
  expect(faultEvents, "S-04 is a deterministic fault-free scheduled workload").toEqual([]);
}

async function transitionGeometry(
  page: Page,
  workbench: WorkbenchPage,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  index: number,
  geometry: { readonly width: number; readonly height: number },
): Promise<ResizeMetric> {
  const beforeEvents = await terminalEvents(page, terminalId);
  const beforeEventId = beforeEvents.reduce((floor, event) => Math.max(floor, event.id), 0);
  const beforeTranscript = await transcriptFloor(server, terminalId);
  const startedAt = Date.now();
  const viewportEvent = waitForEventAfter(page, terminalId, beforeEventId, "viewport");
  const sizeEvent = waitForEventAfter(page, terminalId, beforeEventId, "size");
  await workbench.setViewport(geometry.width, geometry.height);
  await viewportEvent;
  const selectedEvent = await sizeEvent;
  await waitForMountedTerminal(page, terminalId, true, true);

  const sizeId = `${terminalId}-S04-SIZE-${index}`;
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await server.waitForTranscript(
    terminalId,
    (entry) => entrySequence(entry) > beforeTranscript && entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const rows = numberField(sizeEntry, "rows");
  const cols = numberField(sizeEntry, "cols");
  const pixelWidth = numberField(sizeEntry, "pixel_width");
  const pixelHeight = numberField(sizeEntry, "pixel_height");
  if (!rows || !cols || pixelWidth === undefined || pixelHeight === undefined) {
    throw new Error("fixture SIZE omitted PTY dimensions after a scheduled resize");
  }
  const signal = await server.waitForTranscript(
    terminalId,
    (entry) => entrySequence(entry) > beforeTranscript
      && entry.event === "sigwinch"
      && entry.source === "signal"
      && numberField(entry, "rows") === rows
      && numberField(entry, "cols") === cols,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(signal.source).toBe("signal");
  const selectedViewport = selectedEvent.snapshot.serverViewport;
  expect(selectedViewport).toBeDefined();
  expect(selectedViewport?.cols).toBe(cols);
  expect(selectedViewport?.rows).toBe(rows);
  expect(selectedViewport?.pixelWidth).toBe(pixelWidth);
  expect(selectedViewport?.pixelHeight).toBe(pixelHeight);

  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:SIZE:${sizeId}:${rows}:${cols}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const settled = await waitForMountedTerminal(page, terminalId, true, true);
  expect(settled.serverViewport).toMatchObject({ cols, rows, pixelWidth, pixelHeight });
  expect(settled.cols).toBe(cols);
  expect(settled.rows).toBe(rows);
  expect(settled.pixelWidth).toBe(pixelWidth);
  expect(settled.pixelHeight).toBe(pixelHeight);
  return {
    index,
    width: geometry.width,
    height: geometry.height,
    convergenceMs: Date.now() - startedAt,
    cols,
    rows,
    pixelWidth,
    pixelHeight,
  };
}

async function repaintPhase(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  phase: number,
  prefix: string,
): Promise<PhaseMetric> {
  const repaintId = `${prefix}-REPAINT-${phase}`;
  const syncId = `${prefix}-SYNC-${phase}`;
  const frameId = `${prefix}-FRAME-${phase}`;
  const frameText = `${prefix}-FRAME-TEXT-${phase}`;
  const transcriptBefore = await transcriptFloor(server, terminalId);
  const eventsBefore = await eventFloor(page, terminalId);
  const before = await terminalSnapshot(page, terminalId);
  if (!before || before.receivedSequence === undefined) throw new Error("S-04 repaint phase omitted the received sequence");
  const startedAt = Date.now();

  await pane.sendInput(`SYNC_BEGIN ${syncId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sync_begin" && entry.id === syncId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`REPAINT ${repaintId} ${REPAINT_BYTES}`, true);
  const repaint = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "repaint" && entry.id === repaintId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(numberField(repaint, "bytes")).toBe(REPAINT_BYTES);
  await pane.sendInput(`SYNC_END ${syncId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sync_end" && entry.id === syncId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`PRINT ${frameId} ${frameText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === frameId && entry.text === frameText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const transcript = await server.readTranscript(terminalId);
  const writes = writesAfter(transcript, transcriptBefore);
  const outputBytes = writes.reduce((total, write) => total + write.byteLength, 0);
  expect(outputBytes).toBeGreaterThan(REPAINT_BYTES);
  const expectedReceived = before.receivedSequence + outputBytes;
  const settled = await waitForMountedTerminal(page, terminalId, true, true, expectedReceived, before.renderCount + 1);
  expect(settled.committedSequence).toBeGreaterThanOrEqual(expectedReceived);
  expect(settled.renderBacklogBytes).toBe(0);
  expect(settled.renderBacklogFrames).toBe(0);
  expect(settled.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(settled.syncMode).toBeUndefined();
  expect(settled.syncTarget).toBeUndefined();
  expect(settled.xterm.text).toContain(`[E2E:REPAINT:${repaintId}:FRAME]`);
  expect(settled.xterm.text).toContain(frameText);
  expect(countOccurrences(settled.xterm.text, "footer"), "each repaint must leave one current TUI footer").toBe(1);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.001,
  });

  const events = (await terminalEvents(page, terminalId)).filter((event) => event.id > eventsBefore);
  const maxPendingParserBytes = Math.max(settled.pendingParserBytes, ...events.map((event) => event.snapshot.pendingParserBytes));
  const maxRenderBacklogBytes = Math.max(settled.renderBacklogBytes, ...events.map((event) => event.snapshot.renderBacklogBytes));
  const maxRenderBacklogFrames = Math.max(settled.renderBacklogFrames, ...events.map((event) => event.snapshot.renderBacklogFrames));
  const maxRenderBacklogAgeMs = Math.max(settled.renderBacklogOldestAgeMs, ...events.map((event) => event.snapshot.renderBacklogOldestAgeMs));
  return {
    phase,
    repaintId,
    repaintBytes: REPAINT_BYTES,
    outputBytes,
    renderLatencyMs: Date.now() - startedAt,
    maxPendingParserBytes,
    maxRenderBacklogBytes,
    maxRenderBacklogFrames,
    maxRenderBacklogAgeMs,
    flowControlled: settled.flowControlled,
    flowPendingAcknowledgementBytes: settled.flowPendingAcknowledgementBytes,
    renderer: settled.renderer,
    webglLoadCount: settled.webglLoadCount,
    contextLossCount: settled.contextLossCount,
    fallbackCount: settled.fallbackCount,
    renderCount: settled.renderCount,
  };
}

async function cacheSwitch(
  page: Page,
  workbench: WorkbenchPage,
  active: TerminalIdentity,
  cached: TerminalIdentity,
  baselineResources: ReadonlyMap<string, E2ETerminalSnapshot>,
  baselineCanvases: readonly ResourceCanvas[],
): Promise<void> {
  const cachedPane = await workbench.sidebar.openTerminal({ id: cached.terminalId, name: cached.name });
  await workbench.expectVisibleTerminal(cached.terminalId);
  await cachedPane.expectVisible();
  await waitForMountedTerminal(page, active.terminalId, false, false);
  await waitForMountedTerminal(page, cached.terminalId, true, true);
  await expectTerminalNonBlank(page, cachedPane.xtermHost, { minimumNonBackgroundRatio: 0.001 });

  const activePane = await workbench.sidebar.openTerminal({ id: active.terminalId, name: active.name });
  await workbench.expectVisibleTerminal(active.terminalId);
  await activePane.expectVisible();
  const activeSnapshot = await waitForMountedTerminal(page, active.terminalId, true, true);
  await waitForMountedTerminal(page, cached.terminalId, false, false);
  expect(activeSnapshot.socketState).toBe("connected");
  expect(activeSnapshot.activeSocketCount).toBe(1);
  expect(activeSnapshot.renderBacklogBytes).toBe(0);
  expect(activeSnapshot.renderBacklogFrames).toBe(0);

  const currentResources = new Map<string, E2ETerminalSnapshot>();
  for (const id of baselineResources.keys()) {
    const snapshot = await terminalSnapshot(page, id);
    if (!snapshot) throw new Error(`cached terminal ${id} disappeared during cache switch`);
    currentResources.set(id, snapshot);
    const baseline = baselineResources.get(id);
    if (!baseline) throw new Error(`missing S-04 resource baseline for ${id}`);
    expect(snapshot.socketGeneration).toBe(baseline.socketGeneration);
    expect(snapshot.webglLoadCount).toBe(baseline.webglLoadCount);
    expect(snapshot.contextLossCount).toBe(baseline.contextLossCount);
    expect(snapshot.fallbackCount).toBe(baseline.fallbackCount);
    expect(snapshot.activeSocketCount).toBe(1);
  }
  compareCanvasResources(baselineCanvases, await canvasResources(page));
  await expectTerminalNonBlank(page, activePane.xtermHost, { minimumNonBackgroundRatio: 0.001 });
}

async function cleanupTerminal(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  identity: TerminalIdentity,
): Promise<void> {
  const pane = await workbench.sidebar.openTerminal({ id: identity.terminalId, name: identity.name });
  await pane.expectVisible();
  await pane.sendInput("EXIT 0", true);
  await server.waitForTranscript(
    identity.terminalId,
    (entry) => entry.event === "exit_requested" && numberField(entry, "code") === 0,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await server.waitForTranscript(
    identity.terminalId,
    (entry) => entry.event === "exit" && numberField(entry, "code") === 0,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const exited = await page.evaluate(async (id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.socketState === "exited" && snapshot.activeSocketCount === 0, { timeout: 30_000 });
  }, identity.terminalId);
  expect(exited.acceptingInput).toBe(false);

  const floor = await eventFloor(page, identity.terminalId);
  const unmounted = waitForEventAfter(page, identity.terminalId, floor, "unmount");
  await workbench.sidebar.removeTerminal({ id: identity.terminalId, name: identity.name });
  const unmountEvent = await unmounted;
  expect(unmountEvent.snapshot.lifecycle.mounted).toBe(false);
  expect(unmountEvent.snapshot.activeSocketCount).toBe(0);
  await expect(pane.root).toHaveCount(0);
}

function noFaultEvent(event: NetworkFaultEvent): boolean {
  return [
    "upgrade-delay",
    "paused",
    "resumed",
    "throttled",
    "dropped",
    "restored",
    "close-sent",
    "terminated",
    "injected",
    "malformed-frame",
    "connection-terminated",
    "socket-error",
  ].includes(event.type);
}

test("S-04 Continuous TUI @soak @S-04", async ({ page, baseURL, server, faultController }, testInfo) => {
  test.setTimeout(SOAK_DURATION_MS + 5 * 60 * 1_000);
  await page.setViewportSize(INITIAL_VIEWPORT);
  await page.goto(baseURL);
  await new LoginPage(page).login();
  await installPerformanceObserver(page);

  const prefix = `S04-${SEED.toString(16)}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}`;
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const settings = await workbench.openSettings();
  await settings.setCachedTerminalLimit(CACHE_LIMIT);
  await workbench.showTerminals();

  const identities: TerminalIdentity[] = [];
  const knownIds: string[] = [];
  for (let index = 0; index < TERMINAL_COUNT; index += 1) {
    const mount = waitForNewPaneMount(page, knownIds);
    await workbench.createTerminal();
    const mounted = await mount;
    const terminalId = mounted.terminalId;
    if (knownIds.includes(terminalId)) throw new Error(`terminal id ${terminalId} was reused in S-04`);
    knownIds.push(terminalId);
    const pane = new TerminalPanePage(page, terminalId);
    await pane.expectVisible();
    const name = (await pane.root.getAttribute("aria-label"))?.replace(/^Terminal(?: pane)?\s+/i, "");
    if (!name) throw new Error(`terminal ${terminalId} omitted its accessible name`);
    await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const readyId = `${prefix}-READY-${index}`;
    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "ready" && entry.id === readyId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, terminalId, { contains: `[E2E:READY:${readyId}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    identities.push({ terminalId, name, pane });
  }

  const active = identities[0];
  if (!active) throw new Error("S-04 failed to create the active terminal");
  const cached = identities.slice(1);
  await workbench.sidebar.openTerminal({ id: active.terminalId, name: active.name });
  await workbench.expectVisibleTerminal(active.terminalId);
  await active.pane.expectVisible();
  await Promise.all(identities.map((identity) => waitForMountedTerminal(
    page,
    identity.terminalId,
    identity.terminalId === active.terminalId,
    identity.terminalId === active.terminalId,
  )));
  expect(await workbench.visiblePaneCount()).toBe(1);
  expect(await workbench.mountedPaneCount()).toBe(TERMINAL_COUNT);
  for (const identity of cached) await workbench.expectCached(identity.terminalId);

  await expectTerminalConnected(page, active.terminalId, { timeout: WAIT_TIMEOUT_MS });
  const baselineSnapshots = new Map<string, E2ETerminalSnapshot>();
  for (const identity of identities) {
    const snapshot = await terminalSnapshot(page, identity.terminalId);
    if (!snapshot) throw new Error(`missing S-04 baseline diagnostics for ${identity.terminalId}`);
    baselineSnapshots.set(identity.terminalId, snapshot);
    expect(snapshot.socketGeneration).toBeGreaterThanOrEqual(1);
    expect(snapshot.activeSocketCount).toBe(1);
    expect(snapshot.socket.activeCount).toBe(1);
    expect(snapshot.socketState).toBe("connected");
    expect(snapshot.renderCount).toBeGreaterThan(0);
    expect(snapshot.renderer).toMatch(/^(webgl|canvas|dom)$/);
  }
  const baselineCanvases = await canvasResources(page);
  const baselineFaultEventCount = faultController.events.length;
  const baselineFaultEvents = faultController.events.slice();
  const baselineSocketEvents = new Map<string, number>();
  for (const identity of identities) baselineSocketEvents.set(identity.terminalId, await eventFloor(page, identity.terminalId));
  await assertNoFaults(baselineFaultEvents);

  const altId = `${prefix}-ALT-ENTER`;
  await active.pane.sendInput(`ALT_ENTER ${altId}`, true);
  await server.waitForTranscript(active.terminalId, (entry) => entry.event === "alt_enter" && entry.id === altId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalConnected(page, active.terminalId, { timeout: WAIT_TIMEOUT_MS });
  const altSnapshot = await page.evaluate(async (id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.activeBuffer === "alternate" && snapshot.pendingParserWrites === 0, { timeout: 30_000 });
  }, active.terminalId);
  expect(altSnapshot.activeBuffer).toBe("alternate");

  const phaseMetrics: PhaseMetric[] = [];
  const resizeMetrics: ResizeMetric[] = [];
  const inputMetrics: InputMetric[] = [];
  const boundaryMetrics: { index: number; scheduledAt: number; startedAt: number; cacheTerminalId: string; geometry: typeof RESIZE_SEQUENCE[number] }[] = [];
  const measurementStartedAt = Date.now();
  const deadline = measurementStartedAt + SOAK_DURATION_MS;
  const boundarySignals = Array.from({ length: Math.floor(SOAK_DURATION_MS / SCHEDULE_INTERVAL_MS) }, (_, index) => {
    let resolveSignal!: () => void;
    const promise = new Promise<void>((resolve) => { resolveSignal = resolve; });
    const scheduledAt = measurementStartedAt + (index + 1) * SCHEDULE_INTERVAL_MS;
    const timer = setTimeout(resolveSignal, Math.max(0, scheduledAt - Date.now()));
    return { index, promise, timer, scheduledAt };
  });
  let nextBoundary = 0;
  let phase = 0;
  try {
    while (Date.now() < deadline) {
      const phasePromise = repaintPhase(page, active.pane, server, active.terminalId, phase, prefix);
      if (nextBoundary < boundarySignals.length) {
        const boundaryReached = await Promise.race([
          phasePromise.then(() => false),
          boundarySignals[nextBoundary]!.promise.then(() => true),
        ]);
        if (boundaryReached) {
          await phasePromise;
        } else {
          phaseMetrics.push(await phasePromise);
          phase += 1;
          continue;
        }
      } else {
        phaseMetrics.push(await phasePromise);
        phase += 1;
        continue;
      }

      const boundary = boundarySignals[nextBoundary]!;
      const boundaryStartedAt = Date.now();
      const cacheTarget = cached[nextBoundary % cached.length];
      if (!cacheTarget) throw new Error("S-04 cache schedule lost its cached terminal set");
      const inputId = `${prefix}-INPUT-${nextBoundary}`;
      const inputText = `${prefix}-SUBMITTED-${nextBoundary}`;
      const input = await sendInputMarker(active.pane, server, page, active.terminalId, inputId, inputText);
      inputMetrics.push({ ...input, index: nextBoundary });
      await cacheSwitch(page, workbench, active, cacheTarget, baselineSnapshots, baselineCanvases);
      const geometry = RESIZE_SEQUENCE[nextBoundary % RESIZE_SEQUENCE.length]!;
      const resize = await transitionGeometry(page, workbench, active.pane, server, active.terminalId, nextBoundary, geometry);
      resizeMetrics.push(resize);
      boundaryMetrics.push({
        index: nextBoundary,
        scheduledAt: boundary.scheduledAt,
        startedAt: boundaryStartedAt,
        cacheTerminalId: cacheTarget.terminalId,
        geometry,
      });
      nextBoundary += 1;
      phaseMetrics.push(await repaintPhase(page, active.pane, server, active.terminalId, phase, prefix));
      phase += 1;
    }
  } finally {
    for (const boundary of boundarySignals) clearTimeout(boundary.timer);
  }

  expect(nextBoundary).toBe(boundarySignals.length);
  expect(Date.now()).toBeGreaterThanOrEqual(deadline);
  expect(phaseMetrics.length).toBeGreaterThan(boundarySignals.length);
  expect(new Set(phaseMetrics.map((metric) => metric.repaintId)).size).toBe(phaseMetrics.length);
  expect(inputMetrics).toHaveLength(boundarySignals.length);
  expect(resizeMetrics).toHaveLength(boundarySignals.length);

  const preFinalExit = await terminalSnapshot(page, active.terminalId);
  if (!preFinalExit) throw new Error("active terminal diagnostics disappeared at the S-04 deadline");
  const exitId = `${prefix}-ALT-EXIT`;
  await active.pane.sendInput(`ALT_EXIT ${exitId}`, true);
  await server.waitForTranscript(active.terminalId, (entry) => entry.event === "alt_exit" && entry.id === exitId, { timeoutMs: WAIT_TIMEOUT_MS });
  const normal = await page.evaluate(async (id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.activeBuffer === "normal" && snapshot.pendingParserWrites === 0, { timeout: 30_000 });
  }, active.terminalId);
  expect(normal.activeBuffer).toBe("normal");

  const finalAltFloor = await transcriptFloor(server, active.terminalId);
  const finalAltBefore = await terminalSnapshot(page, active.terminalId);
  if (!finalAltBefore || finalAltBefore.receivedSequence === undefined) throw new Error("final alternate-buffer baseline omitted output sequence");
  const finalAltEnterId = `${prefix}-FINAL-ALT-ENTER`;
  const finalSyncId = `${prefix}-FINAL-SYNC`;
  const finalRepaintId = `${prefix}-FINAL-REPAINT`;
  const finalFrameId = `${prefix}-FINAL-FRAME`;
  const finalFrameText = `${prefix}-FINAL-FRAME-TEXT`;
  await active.pane.sendInput(`ALT_ENTER ${finalAltEnterId}`, true);
  await server.waitForTranscript(active.terminalId, (entry) => entry.event === "alt_enter" && entry.id === finalAltEnterId, { timeoutMs: WAIT_TIMEOUT_MS });
  await active.pane.sendInput(`SYNC_BEGIN ${finalSyncId}`, true);
  await server.waitForTranscript(active.terminalId, (entry) => entry.event === "sync_begin" && entry.id === finalSyncId, { timeoutMs: WAIT_TIMEOUT_MS });
  await active.pane.sendInput(`REPAINT ${finalRepaintId} ${REPAINT_BYTES}`, true);
  await server.waitForTranscript(active.terminalId, (entry) => entry.event === "repaint" && entry.id === finalRepaintId && numberField(entry, "bytes") === REPAINT_BYTES, { timeoutMs: WAIT_TIMEOUT_MS });
  await active.pane.sendInput(`SYNC_END ${finalSyncId}`, true);
  await server.waitForTranscript(active.terminalId, (entry) => entry.event === "sync_end" && entry.id === finalSyncId, { timeoutMs: WAIT_TIMEOUT_MS });
  await active.pane.sendInput(`PRINT ${finalFrameId} ${finalFrameText}`, true);
  await server.waitForTranscript(active.terminalId, (entry) => entry.event === "print" && entry.id === finalFrameId && entry.text === finalFrameText, { timeoutMs: WAIT_TIMEOUT_MS });
  const finalAltEntries = await server.readTranscript(active.terminalId);
  const finalAltWrites = writesAfter(finalAltEntries, finalAltFloor);
  const finalAltBytes = finalAltWrites.reduce((total, write) => total + write.byteLength, 0);
  const finalAltExpected = finalAltBefore.receivedSequence + finalAltBytes;
  const finalAlternate = await waitForMountedTerminal(page, active.terminalId, true, true, finalAltExpected, finalAltBefore.renderCount + 1);
  expect(finalAlternate.activeBuffer).toBe("alternate");
  expect(finalAlternate.committedSequence).toBeGreaterThanOrEqual(finalAltExpected);
  expect(finalAlternate.xterm.text).toContain(`[E2E:REPAINT:${finalRepaintId}:FRAME]`);
  expect(finalAlternate.xterm.text).toContain(finalFrameText);
  expect(countOccurrences(finalAlternate.xterm.text, "footer")).toBe(1);

  const model = new HeadlessTerminal({
    cols: finalAlternate.cols,
    rows: finalAlternate.rows,
    scrollback: 200_000,
    allowProposedApi: true,
    ...tuiCompatibilityOptions(),
  });
  for (const write of finalAltWrites) await writeHeadless(model, write.bytes);
  expect(finalAlternate.xterm.activeBuffer).toBe(model.buffer.active.type === "alternate" ? "alternate" : "normal");
  expect(finalAlternate.xterm.text).toBe(headlessText(model));
  expect(finalAlternate.xterm.cursorX).toBe(model.buffer.active.cursorX);
  expect(finalAlternate.xterm.cursorY).toBe(model.buffer.active.cursorY);
  model.dispose();

  const beforeFinalPixels = await screenshotRegion(page, active.pane.xtermHost);
  await active.pane.sendInput(`ALT_EXIT ${prefix}-FINAL-ALT-EXIT`, true);
  await server.waitForTranscript(active.terminalId, (entry) => entry.event === "alt_exit" && entry.id === `${prefix}-FINAL-ALT-EXIT`, { timeoutMs: WAIT_TIMEOUT_MS });
  const afterExit = await page.evaluate(async (id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.activeBuffer === "normal" && snapshot.pendingParserWrites === 0, { timeout: 30_000 });
  }, active.terminalId);
  expect(afterExit.activeBuffer).toBe("normal");
  const finalMarkerId = `${prefix}-FINAL-MARKER`;
  const finalMarkerText = `${prefix}-FINAL-VISIBLE`;
  const beforeFinalMarker = await terminalSnapshot(page, active.terminalId);
  if (!beforeFinalMarker) throw new Error("active terminal diagnostics disappeared before the final marker");
  await active.pane.sendInput(`PRINT ${finalMarkerId} ${finalMarkerText}`, true);
  await server.waitForTranscript(active.terminalId, (entry) => entry.event === "print" && entry.id === finalMarkerId && entry.text === finalMarkerText, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, active.terminalId, { contains: finalMarkerText, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await waitForMountedTerminal(page, active.terminalId, true, true, undefined, beforeFinalMarker.renderCount + 1);
  const afterFinalPixels = await screenshotRegion(page, active.pane.xtermHost);
  await expectTerminalPixelsChanged(beforeFinalPixels, afterFinalPixels, {
    minimumChangedRatio: 0.001,
    testInfo,
    artifactName: "s04-final-marker",
  });
  await expectTerminalNonBlank(page, active.pane.xtermHost, {
    minimumNonBackgroundRatio: 0.001,
    testInfo,
    artifactName: "s04-final-terminal",
  });

  const finalSnapshots = new Map<string, E2ETerminalSnapshot>();
  const finalEvents = new Map<string, readonly E2ETerminalEvent[]>();
  for (const identity of identities) {
    const isActive = identity.terminalId === active.terminalId;
    const snapshot = await waitForMountedTerminal(page, identity.terminalId, isActive, isActive);
    finalSnapshots.set(identity.terminalId, snapshot);
    const events = await terminalEvents(page, identity.terminalId);
    finalEvents.set(identity.terminalId, events);
    await assertMonotonicSequences(events);
    expect(events.filter((event) => event.type === "error" || event.type === "socket-stale" || event.type === "socket-close")).toHaveLength(0);
    expect(snapshot.socketState).toBe("connected");
    expect(snapshot.activeSocketCount).toBe(1);
    expect(snapshot.socket.activeCount).toBe(1);
    expect(snapshot.pendingParserWrites).toBe(0);
    expect(snapshot.pendingParserBytes).toBe(0);
    expect(snapshot.renderBacklogBytes).toBe(0);
    expect(snapshot.renderBacklogFrames).toBe(0);
    expect(snapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(snapshot.syncMode).toBeUndefined();
    expect(snapshot.syncTarget).toBeUndefined();
    expect(snapshot.lifecycle.mounted).toBe(true);
    expect(snapshot.lifecycle.visible).toBe(isActive);
    expect(snapshot.lifecycle.cached).toBe(!isActive);
    expect(snapshot.lifecycle.active).toBe(isActive);
    expect(snapshot.webglLoadCount).toBe(baselineSnapshots.get(identity.terminalId)?.webglLoadCount);
    expect(snapshot.contextLossCount).toBe(baselineSnapshots.get(identity.terminalId)?.contextLossCount);
    expect(snapshot.fallbackCount).toBe(baselineSnapshots.get(identity.terminalId)?.fallbackCount);
    if (isActive) {
      expect(snapshot.acceptingInput).toBe(true);
      expect(snapshot.activeBuffer).toBe("normal");
      expect(snapshot.xterm.text).toContain(finalMarkerText);
      expect(countOccurrences(snapshot.xterm.text, finalMarkerText)).toBe(1);
    } else {
      expect(snapshot.acceptingInput).toBe(false);
    }
    await expectTerminalInvariants(page, identity.terminalId, { timeout: WAIT_TIMEOUT_MS });
  }
  await expectConnectedTerminalInvariants(page, active.terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, active.terminalId, { contains: finalMarkerText, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  compareCanvasResources(baselineCanvases, await canvasResources(page));

  const workloadFaultEvents = faultController.events.slice(baselineFaultEventCount);
  expect(workloadFaultEvents.some(noFaultEvent)).toBe(false);
  await assertNoFaults(workloadFaultEvents);
  for (const identity of identities) {
    const events = finalEvents.get(identity.terminalId) ?? [];
    expect(events.some((event) => event.id <= (baselineSocketEvents.get(identity.terminalId) ?? 0) && event.type === "socket-close")).toBe(false);
  }
  for (const identity of identities) {
    const transcript = await server.readTranscript(identity.terminalId);
    expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(transcript.filter((entry) => entry.event === "exit_requested")).toHaveLength(0);
  }
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);

  const performance = await readPerformanceMetrics(page);
  expect(performance.longTasks.every((entry) => Number.isFinite(entry.startTime) && Number.isFinite(entry.duration) && entry.duration >= 0)).toBe(true);
  const endCanvases = await canvasResources(page);
  const compactSnapshots = [...finalSnapshots.values()].map(compactSnapshot);
  const compactEvents = [...finalEvents.entries()].flatMap(([terminalId, events]) => events.map((event) => ({ terminalId, ...compactEvent(event) })));
  const metricRecord = {
    scenario: "S-04 Continuous TUI",
    tier: "scheduled-soak",
    seed: `0x${SEED.toString(16)}`,
    durationMs: Date.now() - measurementStartedAt,
    requiredDurationMs: SOAK_DURATION_MS,
    repaintBytes: REPAINT_BYTES,
    repaintPhases: phaseMetrics.length,
    boundaryCount: boundaryMetrics.length,
    resizeConvergenceMs: summarize(resizeMetrics.map((metric) => metric.convergenceMs)),
    inputRoundTripMs: summarize(inputMetrics.map((metric) => metric.roundTripMs)),
    reconnectToInteractiveMs: { status: "na", reason: "S-04 uses a fault-free scheduled workload" },
    longTasks: {
      status: performance.supported ? "ok" : "na",
      reason: performance.supported ? undefined : "PerformanceObserver longtask is unavailable in this browser",
      count: performance.longTasks.length,
      maxDurationMs: performance.longTasks.reduce((max, entry) => Math.max(max, entry.duration), 0),
    },
    checkpointSerializationMs: { status: "na", reason: "S-04 does not enable debug recording" },
    snapshotParseMs: { status: "na", reason: "S-04 has no reconnect or snapshot recovery" },
    parserBacklog: {
      maxPendingBytes: Math.max(...phaseMetrics.map((metric) => metric.maxPendingParserBytes), 0),
      maxRenderBacklogBytes: Math.max(...phaseMetrics.map((metric) => metric.maxRenderBacklogBytes), 0),
      maxRenderBacklogFrames: Math.max(...phaseMetrics.map((metric) => metric.maxRenderBacklogFrames), 0),
      maxRenderBacklogAgeMs: Math.max(...phaseMetrics.map((metric) => metric.maxRenderBacklogAgeMs), 0),
    },
    reconnectsPerHour: 0,
    snapshotsPerHour: 0,
    browserHeapBytes: performance.heapUsedBytes === undefined
      ? { status: "na", reason: "performance.memory is unavailable in this browser" }
      : { status: "ok", value: performance.heapUsedBytes },
    rendererResources: {
      baselineCanvasCount: baselineCanvases.length,
      endCanvasCount: endCanvases.length,
      baseline: [...baselineSnapshots.values()].map((snapshot) => ({ terminalId: snapshot.terminalId, renderer: snapshot.renderer, webglLoadCount: snapshot.webglLoadCount, contextLossCount: snapshot.contextLossCount, fallbackCount: snapshot.fallbackCount, renderCount: snapshot.renderCount })),
      end: compactSnapshots.map((snapshot) => ({ terminalId: snapshot.terminalId, renderer: snapshot.renderer, webglLoadCount: snapshot.webglLoadCount, contextLossCount: snapshot.contextLossCount, fallbackCount: snapshot.fallbackCount, renderCount: snapshot.renderCount })),
    },
    socketsAndTimers: {
      baselineMounted: TERMINAL_COUNT,
      endMounted: compactSnapshots.filter((snapshot) => (snapshot.lifecycle as { mounted?: boolean }).mounted).length,
      activeSockets: compactSnapshots.map((snapshot) => ({ terminalId: snapshot.terminalId, activeSocketCount: snapshot.activeSocketCount, socketGeneration: snapshot.socketGeneration })),
      timers: { status: "na", reason: "terminal diagnostics expose socket generations but not a timer count" },
    },
    serverReplaySnapshotBytes: { status: "na", reason: "S-04 has no fault or snapshot recovery" },
    processResources: { status: "na", reason: "the shared E2E harness does not expose worker process sampling" },
    schedule: boundaryMetrics,
    phases: phaseMetrics,
    snapshots: compactSnapshots,
    events: compactEvents,
    faultEvents: workloadFaultEvents,
  };
  await testInfo.attach("s04-metrics", { body: JSON.stringify(metricRecord), contentType: "application/json" });

  for (const identity of [...identities].reverse()) await cleanupTerminal(page, workbench, server, identity);
  await expect(workbench.editorGrid.locator("[data-terminal-id]")).toHaveCount(0);
  expect(await canvasResources(page)).toEqual([]);
  const remainingDiagnostics = await page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminals();
  });
  expect(remainingDiagnostics.filter((snapshot) => knownIds.includes(snapshot.terminalId))).toHaveLength(0);
});
