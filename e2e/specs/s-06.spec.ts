import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { Terminal } from "../fixtures/headless-terminal.js"
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import type { NetworkFaultDisposer, NetworkFaultEvent } from "../fixtures/network-faults.js";
import LoginPage from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

/** The schedule is the workload; the timer below is a fixed schedule barrier, not a stabilization sleep. */
test.setTimeout(20 * 60_000);

const WAIT_TIMEOUT_MS = 120_000;
const SOAK_DURATION_MS = 15 * 60_000;
const BURST_INTERVAL_MS = 2_000;
const BOUNDARY_INTERVAL_MS = 3 * 60_000;
const BURST_BYTES = 65_536;
const BURST_LINE_WIDTH = 96;
const SLOW_SERVER_TO_BROWSER_BYTES_PER_SECOND = 64 * 1024;
const METRICS_KEY = "__TERM_SERVER_E2E_S06_METRICS__";
const SCROLLBACK_LINES = 200_000;

const INITIAL_VIEWPORTS = {
  A: { width: 1_440, height: 900 },
  B: { width: 1_000, height: 700 },
  C: { width: 390, height: 844 },
} as const;

const BOUNDARY_VIEWPORTS = [
  {
    A: { width: 1_280, height: 800 },
    B: { width: 900, height: 650 },
    C: { width: 412, height: 915 },
  },
  {
    A: { width: 1_440, height: 900 },
    B: { width: 1_000, height: 700 },
    C: { width: 360, height: 780 },
  },
  {
    A: { width: 1_366, height: 768 },
    B: { width: 960, height: 640 },
    C: { width: 390, height: 844 },
  },
  {
    A: { width: 1_440, height: 900 },
    B: { width: 1_000, height: 700 },
    C: { width: 390, height: 844 },
  },
] as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
  __TERM_SERVER_E2E_S06_METRICS__?: S06PerformanceState;
  __TERM_SERVER_E2E_S06_METRICS_OBSERVER__?: PerformanceObserver;
};

type JsonObject = Record<string, unknown>;
type ClientName = "A" | "B" | "C";

type Viewport = {
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
};

type S06PerformanceState = {
  readonly supported: boolean;
  readonly longTasks: Array<{ readonly startTime: number; readonly duration: number }>;
};

type BrowserResourceSample = {
  readonly at: number;
  readonly client: ClientName;
  readonly heapUsedBytes?: number;
  readonly longTaskSupported: boolean;
  readonly longTaskCount: number;
  readonly maxLongTaskDurationMs: number;
  readonly canvasCount: number;
  readonly attachedCanvasCount: number;
  readonly canvasPixels: number;
  readonly webglCanvasCount: number;
  readonly socketGeneration: number;
  readonly socketState: string;
  readonly activeSocketCount: number;
  readonly serverViewport?: Viewport;
  readonly desiredViewport?: Viewport;
  readonly committedSequence?: number;
  readonly receivedSequence?: number;
  readonly pendingParserBytes: number;
  readonly renderBacklogBytes: number;
  readonly renderBacklogOldestAgeMs: number;
  readonly flowControlled: boolean;
  readonly flowPendingAcknowledgementBytes: number;
  readonly syncMode?: "snapshot" | "resume";
};

type ResourceSample = {
  readonly at: number;
  readonly serverRssBytes?: number;
  readonly terminalProcessMemoryBytes?: number;
  readonly browser: readonly BrowserResourceSample[];
};

type WorkloadState = {
  streamEnd: number;
  writeSequence: number;
  burstCount: number;
  boundaryCount: number;
  inputCount: number;
};

type Client = {
  readonly name: ClientName;
  readonly page: Page;
  readonly context: BrowserContext;
  readonly errors: BrowserErrorCollector;
  readonly workbench: WorkbenchPage;
  pane: TerminalPanePage;
  attached: boolean;
};

type ResizeMeasurement = {
  readonly client: ClientName;
  readonly boundary: number;
  readonly latencyMs: number;
};

type SizeTranscriptEntry = TranscriptEntry & {
  readonly event: "size";
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
  readonly pixel_width?: number;
  readonly pixel_height?: number;
};

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as JsonObject;
}


function safeMarker(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function runTag(testInfo: TestInfo): string {
  return safeMarker(
    `S06-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`,
  );
}

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}


function transcriptNumber(entry: TranscriptEntry, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function writeSequence(entry: TranscriptEntry): number {
  return transcriptNumber(entry, "write_sequence") ?? 0;
}

function writeBytes(entry: TranscriptEntry): Buffer {
  const encoded = entry.data_base64;
  if (typeof encoded !== "string") throw new Error("fixture write omitted data_base64");
  return Buffer.from(encoded, "base64");
}

function writeEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((entry) => entry.event === "write");
}

function maxWriteSequence(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, writeSequence(entry)), 0);
}

function freshWrites(entries: readonly TranscriptEntry[], floor: number): TranscriptEntry[] {
  return writeEntries(entries).filter((entry) => writeSequence(entry) > floor);
}

function viewportFromSnapshot(snapshot: E2ETerminalSnapshot | undefined): Viewport | undefined {
  const value = snapshot?.desiredViewport ?? snapshot?.sentViewport ?? snapshot?.viewport;
  if (!value || value.cols <= 0 || value.rows <= 0) return undefined;
  return {
    cols: value.cols,
    rows: value.rows,
    pixelWidth: value.pixelWidth,
    pixelHeight: value.pixelHeight,
  };
}

function minimumViewport(viewports: readonly Viewport[]): Viewport {
  if (viewports.length === 0) throw new Error("cannot negotiate a viewport without attached clients");
  return viewports.reduce((smallest, current) => ({
    cols: Math.min(smallest.cols, current.cols),
    rows: Math.min(smallest.rows, current.rows),
    pixelWidth: Math.min(smallest.pixelWidth, current.pixelWidth),
    pixelHeight: Math.min(smallest.pixelHeight, current.pixelHeight),
  }));
}

function sameViewport(left: Viewport | undefined, right: Viewport): boolean {
  return left?.cols === right.cols
    && left.rows === right.rows
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? null;
}

function durationSummary(values: readonly number[]): { readonly p50: number | null; readonly p95: number | null; readonly max: number | null } {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

async function installPerformanceObserver(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const target = window as E2EWindow;
    const supported = typeof PerformanceObserver !== "undefined"
      && Array.isArray(PerformanceObserver.supportedEntryTypes)
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const longTasks: Array<{ readonly startTime: number; readonly duration: number }> = [];
    target[key as "__TERM_SERVER_E2E_S06_METRICS__"] = { supported, longTasks };
    if (supported) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: "longtask", buffered: true });
      target[`${key}_OBSERVER` as "__TERM_SERVER_E2E_S06_METRICS_OBSERVER__"] = observer;
    }
  }, METRICS_KEY);
}


async function waitForSentViewport(
  page: Page,
  terminalId: string,
  afterId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
        && event.type === "viewport"
        && event.data.source === "sent"
    ), { timeout });
  }, { id: terminalId, after: afterId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForVisibility(
  page: Page,
  terminalId: string,
  afterId: number,
  visible: boolean,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, expectedVisible, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
        && event.type === "visibility"
        && event.data.visible === expectedVisible
    ), { timeout });
  }, { id: terminalId, after: afterId, expectedVisible: visible, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettled(
  page: Page,
  terminalId: string,
  expectedEnd?: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, end, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
        && snapshot.acceptingInput === true
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
        && (end === undefined || (
          snapshot.receivedSequence !== undefined
            && snapshot.committedSequence !== undefined
            && snapshot.receivedSequence >= end
            && snapshot.committedSequence >= end
        ))
    ), { timeout });
  }, { id: terminalId, end: expectedEnd, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForSelectedViewport(
  page: Page,
  terminalId: string,
  expected: Viewport,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expectedViewport, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.serverViewport?.cols === expectedViewport.cols
        && snapshot.serverViewport.rows === expectedViewport.rows
        && snapshot.serverViewport.pixelWidth === expectedViewport.pixelWidth
        && snapshot.serverViewport.pixelHeight === expectedViewport.pixelHeight
        && snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
    ), { timeout });
  }, { id: terminalId, expectedViewport: expected, timeout: WAIT_TIMEOUT_MS });
}

async function waitForTranscriptWrite(
  server: IsolatedServer,
  terminalId: string,
  floor: number,
): Promise<void> {
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "write" && writeSequence(entry) > floor,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

async function sendFixtureCommand(
  client: Client,
  server: IsolatedServer,
  terminalId: string,
  state: WorkloadState,
  command: string,
  event: string,
  eventPredicate: (entry: TranscriptEntry) => boolean,
  clients: readonly Client[],
  expectedBytes?: number,
): Promise<readonly TranscriptEntry[]> {
  const writeFloor = state.writeSequence;
  const eventWait = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === event && eventPredicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await client.pane.sendInput(command, true);
  await eventWait;
  await waitForTranscriptWrite(server, terminalId, writeFloor);
  const entries = await server.readTranscript(terminalId);
  const writes = freshWrites(entries, writeFloor);
  if (writes.length === 0) throw new Error(`fixture command produced no output: ${command}`);
  const bytes = writes.reduce((total, entry) => total + writeBytes(entry).length, 0);
  if (expectedBytes !== undefined) expect(bytes).toBe(expectedBytes);
  state.writeSequence = maxWriteSequence(entries);
  state.streamEnd += bytes;
  await Promise.all(clients.filter((candidate) => candidate.attached).map((candidate) => waitForSettled(candidate.page, terminalId, state.streamEnd)));
  return writes;
}

async function sendEcho(
  client: Client,
  server: IsolatedServer,
  terminalId: string,
  state: WorkloadState,
  inputId: string,
  payload: string,
  clients: readonly Client[],
): Promise<void> {
  const commandFloor = state.writeSequence;
  const armed = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await client.pane.sendInput(`ECHO_INPUT ${inputId}`, true);
  await armed;
  await waitForTranscriptWrite(server, terminalId, commandFloor);
  let entries = await server.readTranscript(terminalId);
  const armedWrites = freshWrites(entries, commandFloor);
  expect(armedWrites.length).toBeGreaterThan(0);
  state.streamEnd += armedWrites.reduce((total, entry) => total + writeBytes(entry).length, 0);
  state.writeSequence = maxWriteSequence(entries);
  await Promise.all(clients.filter((candidate) => candidate.attached).map((candidate) => waitForSettled(candidate.page, terminalId, state.streamEnd)));

  const payloadFloor = state.writeSequence;
  const payloadWait = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === inputId
      && entry.phase === "payload"
      && entry.payload_base64 === base64(payload),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await client.pane.sendInput(payload, true);
  await payloadWait;
  await waitForTranscriptWrite(server, terminalId, payloadFloor);
  entries = await server.readTranscript(terminalId);
  const payloadWrites = freshWrites(entries, payloadFloor);
  expect(payloadWrites.length).toBeGreaterThan(0);
  state.streamEnd += payloadWrites.reduce((total, entry) => total + writeBytes(entry).length, 0);
  state.writeSequence = maxWriteSequence(entries);
  state.inputCount += 1;
  await Promise.all(clients.filter((candidate) => candidate.attached).map((candidate) => waitForSettled(candidate.page, terminalId, state.streamEnd)));
}

async function chooseResponder(clients: readonly Client[], terminalId: string): Promise<Client> {
  for (const client of clients) {
    if (!client.attached) continue;
    const snapshot = await client.pane.snapshot();
    if (!snapshot?.acceptingInput) continue;
    const events = await client.pane.events();
    const size = [...events].reverse().find((event) => event.type === "size");
    if (size?.data.responder === true) return client;
  }
  throw new Error(`no focused responder is accepting input for ${terminalId}`);
}

async function clientSnapshots(clients: readonly Client[], terminalId: string): Promise<Map<ClientName, E2ETerminalSnapshot>> {
  const snapshots = new Map<ClientName, E2ETerminalSnapshot>();
  for (const client of clients) {
    if (!client.attached) continue;
    const snapshot = await client.pane.snapshot();
    if (!snapshot) throw new Error(`diagnostics snapshot missing for client ${client.name}`);
    snapshots.set(client.name, snapshot);
  }
  if (snapshots.size === 0) throw new Error(`no attached diagnostics clients for ${terminalId}`);
  return snapshots;
}

async function negotiatedViewport(clients: readonly Client[], terminalId: string): Promise<Viewport> {
  const snapshots = await clientSnapshots(clients, terminalId);
  const viewports: Viewport[] = [];
  for (const [name, snapshot] of snapshots) {
    const viewport = viewportFromSnapshot(snapshot);
    if (!viewport) throw new Error(`client ${name} has no usable desired viewport`);
    viewports.push(viewport);
  }
  return minimumViewport(viewports);
}

async function assertNegotiatedViewport(
  clients: readonly Client[],
  terminalId: string,
  expected: Viewport,
): Promise<readonly E2ETerminalSnapshot[]> {
  const snapshots = await Promise.all(clients.filter((client) => client.attached).map((client) => waitForSelectedViewport(client.page, terminalId, expected)));
  for (const snapshot of snapshots) expect(snapshot.serverViewport).toEqual(expect.objectContaining(expected));
  return snapshots;
}

async function readProcessMemory(page: Page, terminalId: string): Promise<number | undefined> {
  const result = await page.evaluate(async (id) => {
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}/processes`, { cache: "no-store" });
    if (!response.ok) throw new Error(`process inspection failed with HTTP ${response.status}`);
    return await response.json() as { supported?: unknown; processes?: unknown };
  }, terminalId);
  if (result.supported !== true || !Array.isArray(result.processes)) return undefined;
  return result.processes.reduce((total, value) => {
    const process = asObject(value, "terminal process");
    const memory = process.memoryBytes;
    return total + (typeof memory === "number" && Number.isFinite(memory) ? memory : 0);
  }, 0);
}

async function readProcRssBytes(pid: number | undefined): Promise<number | undefined> {
  if (pid === undefined || process.platform !== "linux") return undefined;
  try {
    const statm = await readFile(`/proc/${pid}/statm`, "utf8");
    const residentPages = Number(statm.trim().split(/\s+/, 2)[1]);
    if (!Number.isFinite(residentPages) || residentPages < 0) return undefined;
    return residentPages * 4096;
  } catch {
    return undefined;
  }
}

async function readBrowserResourceSample(client: Client, terminalId: string): Promise<BrowserResourceSample> {
  return client.page.evaluate(({ id, name, key }) => {
    const target = window as E2EWindow;
    const api = target.__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const snapshot = api.terminal(id);
    if (!snapshot) throw new Error(`diagnostics snapshot missing for ${id}`);
    const metrics = target[key as "__TERM_SERVER_E2E_S06_METRICS__"];
    if (!metrics) throw new Error("S-06 PerformanceObserver state is unavailable");
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: unknown } }).memory;
    const heapUsedBytes = typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : undefined;
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".xterm-host canvas")];
    const serverViewport = snapshot.serverViewport && {
      cols: snapshot.serverViewport.cols,
      rows: snapshot.serverViewport.rows,
      pixelWidth: snapshot.serverViewport.pixelWidth,
      pixelHeight: snapshot.serverViewport.pixelHeight,
    };
    const desiredViewport = snapshot.desiredViewport && {
      cols: snapshot.desiredViewport.cols,
      rows: snapshot.desiredViewport.rows,
      pixelWidth: snapshot.desiredViewport.pixelWidth,
      pixelHeight: snapshot.desiredViewport.pixelHeight,
    };
    return {
      at: Date.now(),
      client: name,
      ...(heapUsedBytes === undefined ? {} : { heapUsedBytes }),
      longTaskSupported: metrics.supported,
      longTaskCount: metrics.longTasks.length,
      maxLongTaskDurationMs: metrics.longTasks.reduce((max, entry) => Math.max(max, entry.duration), 0),
      canvasCount: canvases.length,
      attachedCanvasCount: canvases.filter((canvas) => canvas.isConnected).length,
      canvasPixels: canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0),
      webglCanvasCount: snapshot.renderer === "webgl" ? 1 : 0,
      socketGeneration: snapshot.socketGeneration,
      socketState: snapshot.socketState,
      activeSocketCount: snapshot.activeSocketCount,
      ...(serverViewport ? { serverViewport } : {}),
      ...(desiredViewport ? { desiredViewport } : {}),
      ...(snapshot.committedSequence === undefined ? {} : { committedSequence: snapshot.committedSequence }),
      ...(snapshot.receivedSequence === undefined ? {} : { receivedSequence: snapshot.receivedSequence }),
      pendingParserBytes: snapshot.pendingParserBytes,
      renderBacklogBytes: snapshot.renderBacklogBytes,
      renderBacklogOldestAgeMs: snapshot.renderBacklogOldestAgeMs,
      flowControlled: snapshot.flowControlled,
      flowPendingAcknowledgementBytes: snapshot.flowPendingAcknowledgementBytes,
      ...(snapshot.syncMode === undefined ? {} : { syncMode: snapshot.syncMode }),
    } satisfies BrowserResourceSample;
  }, { id: terminalId, name: client.name, key: METRICS_KEY });
}

async function collectResourceSample(
  clients: readonly Client[],
  server: IsolatedServer,
  terminalId: string,
): Promise<ResourceSample> {
  const attached = clients.filter((client) => client.attached);
  const browser = await Promise.all(attached.map((client) => readBrowserResourceSample(client, terminalId)));
  const [serverRssBytes, terminalProcessMemoryBytes] = await Promise.all([
    readProcRssBytes(server.pid),
    readProcessMemory(attached[0]!.page, terminalId),
  ]);
  return {
    at: Date.now(),
    ...(serverRssBytes === undefined ? {} : { serverRssBytes }),
    ...(terminalProcessMemoryBytes === undefined ? {} : { terminalProcessMemoryBytes }),
    browser,
  };
}

function sumProxyFrameBytes(events: readonly NetworkFaultEvent[], terminalId: string): number {
  return events.reduce((total, event) => {
    if (event.type !== "frame" || event.terminalId !== terminalId) return total;
    const bytes = event.frame?.bytes;
    return total + (typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0);
  }, 0);
}

function recoveryLatencies(events: readonly E2ETerminalEvent[], floor: number): number[] {
  const starts = events.filter((event) => (
    event.id > floor
      && (event.type === "socket-close" || (event.type === "state" && ["recovering", "disconnected"].includes(String(event.data.state))))
  ));
  const latencies: number[] = [];
  for (const start of starts) {
    const synced = events.find((event) => event.id > start.id && event.type === "synced");
    if (synced) latencies.push(Math.max(0, synced.timestamp - start.timestamp));
  }
  return latencies;
}

function boundedActiveText(terminal: Terminal): string {
  const active = terminal.buffer.active;
  const length = Math.max(0, Math.min(active.length, 20_000));
  let text = "";
  for (let index = 0; index < length && text.length < 256_000; index += 1) {
    const line = active.getLine(index);
    if (!line) continue;
    text += line.translateToString(true);
    if (index + 1 < length) text += "\n";
  }
  return text;
}

async function writeModel(terminal: Terminal, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(bytes, resolve));
}

async function replayFixtureTranscript(
  entries: readonly TranscriptEntry[],
  initial: E2ETerminalSnapshot,
): Promise<Terminal> {
  const initialViewport = initial.serverViewport ?? initial.viewport;
  const model = new Terminal({
    allowProposedApi: true,
    cols: initialViewport.cols,
    rows: initialViewport.rows,
    scrollback: SCROLLBACK_LINES,
    ...tuiCompatibilityOptions(),
  });
  for (const entry of entries) {
    if (entry.event === "sigwinch") {
      const rows = transcriptNumber(entry, "rows");
      const cols = transcriptNumber(entry, "cols");
      if (rows !== undefined && cols !== undefined && rows > 0 && cols > 0) model.resize(cols, rows);
    }
    if (entry.event === "write") await writeModel(model, writeBytes(entry));
  }
  return model;
}

async function readTerminalInfo(page: Page, terminalId: string): Promise<{ readonly clients: number; readonly pid: number | null }> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as Array<{ id: string; clients: number; pid: number | null }>;
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} disappeared from the authenticated listing`);
    return { clients: terminal.clients, pid: terminal.pid };
  }, terminalId);
}

async function attachMetrics(testInfo: TestInfo, metrics: unknown): Promise<void> {
  await testInfo.attach("s06-metrics.json", {
    body: Buffer.from(JSON.stringify(metrics, null, 2), "utf8"),
    contentType: "application/json",
  });
}

async function closeContext(client: Client | undefined): Promise<void> {
  if (!client) return;
  client.errors.dispose();
  if (!client.context.pages().every((page) => page.isClosed())) await client.context.close();
}

test("@soak @S-06 S-06 Multi-client load", async ({ page, browser, baseURL, server, faultController }, testInfo) => {
  const tag = runTag(testInfo);
  const browserErrorsA = installBrowserErrorCollectors(page);
  const clients: Client[] = [];
  let contextB: BrowserContext | undefined;
  let contextC: BrowserContext | undefined;
  let slowB: NetworkFaultDisposer | undefined;
  let terminalId: string | undefined;
  let terminalName: string | undefined;
  let initialPixels: Partial<Record<ClientName, TerminalPixelImage>> = {};
  let initialA: E2ETerminalSnapshot | undefined;
  let workload: WorkloadState | undefined;
  let networkFloor = 0;
  let diagnosticFloors = new Map<ClientName, number>();
  const resizeMeasurements: ResizeMeasurement[] = [];
  const resourceSamples: ResourceSample[] = [];
  let metricsAttached = false;
  let exited = false;
  let model: Terminal | undefined;

  const clientA: Client = {
    name: "A",
    page,
    context: page.context(),
    errors: browserErrorsA,
    workbench: new WorkbenchPage(page),
    pane: new TerminalPanePage(page, "pending"),
    attached: true,
  };
  let activeHoldToken: string | undefined;
  clients.push(clientA);

  try {
    await page.setViewportSize(INITIAL_VIEWPORTS.A);
    await page.goto(baseURL);
    await installPerformanceObserver(page);
    await new LoginPage(page).login();
    await clientA.workbench.expectVisible();
    const mountPromise = page.evaluate(async ({ timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount", { timeout });
    }, { timeout: WAIT_TIMEOUT_MS });
    const createResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/terminals"
    ));
    await clientA.workbench.createTerminal();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    const mount = await mountPromise;
    terminalId = mount.terminalId;
    const terminalRegion = page.locator(`section[role="region"][data-terminal-id="${terminalId.replace(/["\\]/g, "\\$&")}"]`);
    await expect(terminalRegion).toBeVisible();
    terminalName = (await terminalRegion.getAttribute("aria-label"))?.replace(/^Terminal\s+/, "");
    if (!terminalName) throw new Error("created terminal did not expose an accessible name");
    clientA.pane = new TerminalPanePage(page, { terminalId, name: terminalName });
    await clientA.pane.expectVisible();
    await clientA.pane.waitForConnected({ timeout: WAIT_TIMEOUT_MS });
    await clientA.pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });

    contextB = await browser.newContext({ baseURL, viewport: INITIAL_VIEWPORTS.B });
    const pageB = await contextB.newPage();
    await installPerformanceObserver(pageB);
    const errorsB = installBrowserErrorCollectors(pageB);
    const clientB: Client = {
      name: "B",
      page: pageB,
      context: contextB,
      errors: errorsB,
      workbench: new WorkbenchPage(pageB),
      pane: new TerminalPanePage(pageB, { terminalId, name: terminalName }),
      attached: true,
    };
    clients.push(clientB);
    await pageB.goto(baseURL);
    await new LoginPage(pageB).login();
    await clientB.workbench.expectVisible();
    clientB.pane = await clientB.workbench.openTerminal({ id: terminalId, name: terminalName });
    await clientB.pane.expectVisible();
    await clientB.pane.waitForConnected({ timeout: WAIT_TIMEOUT_MS });
    await clientB.pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });

    contextC = await browser.newContext({ baseURL, viewport: INITIAL_VIEWPORTS.C });
    const pageC = await contextC.newPage();
    await installPerformanceObserver(pageC);
    const errorsC = installBrowserErrorCollectors(pageC);
    const clientC: Client = {
      name: "C",
      page: pageC,
      context: contextC,
      errors: errorsC,
      workbench: new WorkbenchPage(pageC),
      pane: new TerminalPanePage(pageC, { terminalId, name: terminalName }),
      attached: true,
    };
    clients.push(clientC);
    await pageC.goto(baseURL);
    await new LoginPage(pageC).login();
    await clientC.workbench.expectVisible();
    clientC.pane = await clientC.workbench.openTerminal({ id: terminalId, name: terminalName });
    await clientC.pane.expectVisible();
    await clientC.pane.waitForConnected({ timeout: WAIT_TIMEOUT_MS });
    await clientC.pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });

    networkFloor = faultController.events.length;
    const initialSelection = await negotiatedViewport(clients, terminalId);
    await assertNegotiatedViewport(clients, terminalId, initialSelection);
    const initialInfo = await readTerminalInfo(page, terminalId);
    expect(initialInfo.clients).toBe(3);
    expect(initialInfo.pid).not.toBeNull();
    for (const client of clients) {
      const snapshot = await client.pane.snapshot();
      if (!snapshot) throw new Error(`missing initial snapshot for client ${client.name}`);
      expect(snapshot.activeSocketCount).toBe(1);
      expect(snapshot.socket.activeCount).toBe(1);
      expect(snapshot.serverViewport).toEqual(expect.objectContaining(initialSelection));
    }

    const bInitial = await clientB.pane.snapshot();
    if (!bInitial) throw new Error("missing slow-client snapshot");
    slowB = faultController.throttle("server-to-browser", SLOW_SERVER_TO_BROWSER_BYTES_PER_SECOND, {
      terminalId,
      generation: bInitial.socketGeneration,
    });
    await faultController.waitFor((event) => (
      event.type === "throttled"
        && event.terminalId === terminalId
        && event.generation === bInitial.socketGeneration
        && event.direction === "server-to-browser"
        && event.bytes === SLOW_SERVER_TO_BROWSER_BYTES_PER_SECOND
    ), { timeoutMs: WAIT_TIMEOUT_MS });

    workload = {
      streamEnd: 0,
      writeSequence: 0,
      burstCount: 0,
      boundaryCount: 0,
      inputCount: 0,
    };
    const initialTranscript = await server.readTranscript(terminalId);
    workload.writeSequence = maxWriteSequence(initialTranscript);
    const initialAReceived = (await clientA.pane.snapshot())?.receivedSequence;
    if (initialAReceived === undefined) throw new Error("initial received sequence is unavailable");
    workload.streamEnd = initialAReceived;

    await sendFixtureCommand(
      clientA,
      server,
      terminalId,
      workload,
      `READY ${tag}-READY`,
      "ready",
      (entry) => entry.id === `${tag}-READY`,
      clients,
    );
    const responderAfterReady = await chooseResponder(clients, terminalId);
    await sendFixtureCommand(
      responderAfterReady,
      server,
      terminalId,
      workload,
      `SIZE ${tag}-INITIAL-SIZE`,
      "size",
      (entry) => entry.id === `${tag}-INITIAL-SIZE`,
      clients,
    );
    initialA = await clientA.pane.snapshot();
    if (!initialA) throw new Error("missing S-06 model baseline");
    for (const client of clients) {
      initialPixels[client.name] = await screenshotRegion(client.page, client.pane.xtermHost.locator(".xterm-screen"));
      diagnosticFloors.set(client.name, (await terminalEvents(client.page, terminalId)).at(-1)?.id ?? 0);
    }
    resourceSamples.push(await collectResourceSample(clients, server, terminalId));

    const scheduleStartedAt = Date.now();
    let nextBurstAt = scheduleStartedAt;
    let nextBoundaryAt = scheduleStartedAt + BOUNDARY_INTERVAL_MS;
    const scheduleDeadline = scheduleStartedAt + SOAK_DURATION_MS;
    let boundaryIndex = 0;

    while (nextBurstAt < scheduleDeadline) {
      const nextAt = Math.min(nextBurstAt, nextBoundaryAt);
      const waitMs = nextAt - Date.now();
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      if (nextBoundaryAt <= nextBurstAt && nextBoundaryAt < scheduleDeadline) {
        const boundary = BOUNDARY_VIEWPORTS[boundaryIndex % BOUNDARY_VIEWPORTS.length]!;
        boundaryIndex += 1;
        const holdToken = `${tag}-BOUNDARY-${boundaryIndex}`;
        await sendFixtureCommand(
          clientA,
          server,
          terminalId,
          workload,
          `HOLD ${holdToken}`,
          "hold",
          (entry) => entry.token === holdToken,
          clients,
        );
        activeHoldToken = holdToken;

        if (boundaryIndex === 2) {
          const bFloor = (await terminalEvents(clientB.page, terminalId)).at(-1)?.id ?? 0;
          await clientB.pane.closePane();
          await waitForVisibility(clientB.page, terminalId, bFloor, false);
          clientB.attached = false;
          const releasedSelection = await negotiatedViewport(clients, terminalId);
          await assertNegotiatedViewport(clients, terminalId, releasedSelection);
        }
        if (boundaryIndex === 3) {
          const bFloor = (await terminalEvents(clientB.page, terminalId)).at(-1)?.id ?? 0;
          clientB.pane = await clientB.workbench.openTerminal({ id: terminalId, name: terminalName });
          await clientB.pane.expectVisible();
          await waitForVisibility(clientB.page, terminalId, bFloor, true);
          clientB.attached = true;
          const bSnapshot = await clientB.pane.snapshot();
          if (!bSnapshot) throw new Error("slow client did not re-register diagnostics");
          slowB?.dispose();
          slowB = faultController.throttle("server-to-browser", SLOW_SERVER_TO_BROWSER_BYTES_PER_SECOND, {
            terminalId,
            generation: bSnapshot.socketGeneration,
          });
          await faultController.waitFor((event) => (
            event.type === "throttled"
              && event.terminalId === terminalId
              && event.generation === bSnapshot.socketGeneration
              && event.direction === "server-to-browser"
              && event.bytes === SLOW_SERVER_TO_BROWSER_BYTES_PER_SECOND
          ), { timeoutMs: WAIT_TIMEOUT_MS });
        }
        const previousEntries = await server.readTranscript(terminalId);
        const previousWinch = previousEntries.filter((entry) => entry.event === "sigwinch").length;

        for (const client of clients) {
          if (!client.attached) continue;
          const floor = (await terminalEvents(client.page, terminalId)).at(-1)?.id ?? 0;
          const startedAt = Date.now();
          await client.page.setViewportSize(boundary[client.name]);
          await client.pane.focus();
          const sent = await waitForSentViewport(client.page, terminalId, floor);
          const expected = await negotiatedViewport(clients, terminalId);
          const selected = await assertNegotiatedViewport(clients, terminalId, expected);
          const completedAt = Math.max(...selected.map((snapshot) => snapshot.updatedAt));
          resizeMeasurements.push({
            client: client.name,
            boundary: boundaryIndex,
            latencyMs: Math.max(0, completedAt - Math.min(startedAt, sent.timestamp)),
          });
        }
        const expected = await negotiatedViewport(clients, terminalId);
        if (!sameViewport((await clientA.pane.snapshot())?.serverViewport, expected)) {
          await assertNegotiatedViewport(clients, terminalId, expected);
        }
        await server.waitForTranscript(
          terminalId,
          (entry, entries) => entry.event === "sigwinch"
            && entries.filter((candidate) => candidate.event === "sigwinch").length > previousWinch
            && entry.rows === expected.rows
            && entry.cols === expected.cols,
          { timeoutMs: WAIT_TIMEOUT_MS },
        );
        await sendFixtureCommand(
          clientA,
          server,
          terminalId,
          workload,
          `RELEASE ${holdToken}`,
          "release",
          (entry) => entry.token === holdToken,
          clients,
        );
        activeHoldToken = undefined;
        const boundaryMarker = `${tag}-B${boundaryIndex}-MARKER`;
        await sendFixtureCommand(
          clientA,
          server,
          terminalId,
          workload,
          `PRINT ${tag}-B${boundaryIndex} ${boundaryMarker}`,
          "print",
          (entry) => entry.id === `${tag}-B${boundaryIndex}` && entry.text === boundaryMarker,
          clients,
        );
        const responder = await chooseResponder(clients, terminalId);
        await sendEcho(
          responder,
          server,
          terminalId,
          workload,
          `${tag}-INPUT-${boundaryIndex}`,
          `${tag}-CONTINUED-${boundaryIndex}`,
          clients,
        );
        resourceSamples.push(await collectResourceSample(clients, server, terminalId));
        workload.boundaryCount += 1;
        nextBoundaryAt += BOUNDARY_INTERVAL_MS;
      } else {
        const burstId = `${tag}-BURST-${workload.burstCount}`;
        await sendFixtureCommand(
          clientA,
          server,
          terminalId,
          workload,
          `BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`,
          "burst",
          (entry) => entry.id === burstId && entry.bytes === BURST_BYTES && entry.line_width === BURST_LINE_WIDTH,
          clients,
          BURST_BYTES,
        );
        workload.burstCount += 1;
        nextBurstAt += BURST_INTERVAL_MS;
      }
    }
    const remainingMs = scheduleDeadline - Date.now();
    if (remainingMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));

    const finalMarker = `${tag}-FINAL-MARKER`;
    await sendFixtureCommand(
      clientA,
      server,
      terminalId,
      workload,
      `PRINT ${tag}-FINAL ${finalMarker}`,
      "print",
      (entry) => entry.id === `${tag}-FINAL` && entry.text === finalMarker,
      clients,
    );
    const finalResponder = await chooseResponder(clients, terminalId);
    await sendEcho(
      finalResponder,
      server,
      terminalId,
      workload,
      `${tag}-FINAL-INPUT`,
      `${tag}-FINAL-CONTINUED`,
      clients,
    );
    await sendFixtureCommand(
      finalResponder,
      server,
      terminalId,
      workload,
      `SIZE ${tag}-FINAL-SIZE`,
      "size",
      (entry) => entry.id === `${tag}-FINAL-SIZE`,
      clients,
    );
    const finalTerminalId = terminalId;
    const finalWorkload = workload;
    if (finalTerminalId === undefined || finalWorkload === undefined) {
      throw new Error("S-06 final workload state is unavailable");
    }
    const finalSnapshots = await Promise.all(clients.map((client) => waitForSettled(client.page, finalTerminalId, finalWorkload.streamEnd)));
    const finalSelection = await negotiatedViewport(clients, terminalId);
    for (const snapshot of finalSnapshots) {
      expect(snapshot.serverViewport).toEqual(expect.objectContaining(finalSelection));
      expect(snapshot.receivedSequence).toBe(workload.streamEnd);
      expect(snapshot.committedSequence).toBe(workload.streamEnd);
      expect(snapshot.pendingParserBytes).toBe(0);
      expect(snapshot.renderBacklogBytes).toBe(0);
      expect(snapshot.renderBacklogFrames).toBe(0);
      expect(snapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
      expect(snapshot.activeSocketCount).toBe(1);
      expect(snapshot.acceptingInput).toBe(true);
      expect(snapshot.xterm.text).toContain(finalMarker);
      expect(snapshot.xterm.text.match(new RegExp(finalMarker, "g")) ?? []).toHaveLength(1);
    }
    const finalTranscript = await server.readTranscript(terminalId);
    const expectedBurstCount = Math.ceil(SOAK_DURATION_MS / BURST_INTERVAL_MS);
    expect(workload.burstCount).toBe(expectedBurstCount);
    expect(finalTranscript.filter((entry) => entry.event === "burst")).toHaveLength(expectedBurstCount);
    expect(finalTranscript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.phase === "payload")).toHaveLength(workload.inputCount);
    const finalSize = finalTranscript.filter((entry): entry is SizeTranscriptEntry => entry.event === "size" && entry.id === `${tag}-FINAL-SIZE`).at(-1);
    if (!finalSize) throw new Error("final SIZE transcript entry is missing");
    expect(finalSize.rows).toBe(finalSelection.rows);
    expect(finalSize.cols).toBe(finalSelection.cols);
    if (finalSize.pixel_width !== undefined) expect(finalSize.pixel_width).toBe(finalSelection.pixelWidth);
    if (finalSize.pixel_height !== undefined) expect(finalSize.pixel_height).toBe(finalSelection.pixelHeight);
    const winches = finalTranscript.filter((entry) => entry.event === "sigwinch");
    expect(winches.length).toBeGreaterThan(0);
    const latestWinch = winches.at(-1);
    expect(latestWinch?.rows).toBe(finalSelection.rows);
    expect(latestWinch?.cols).toBe(finalSelection.cols);

    model = await replayFixtureTranscript(finalTranscript, initialA);
    const modelText = boundedActiveText(model);
    for (const [index, client] of clients.entries()) {
      const snapshot = finalSnapshots[index]!;
      expect(snapshot.xterm.text).toBe(modelText);
      expect(snapshot.xterm.activeBuffer).toBe(model.buffer.active.type);
      expect(snapshot.xterm.cursorX).toBe(model.buffer.active.cursorX);
      expect(snapshot.xterm.cursorY).toBe(model.buffer.active.cursorY);
      expect(snapshot.xterm.viewportY).toBe(model.buffer.active.viewportY);
      expect(snapshot.xterm.selectionText).toBe("");
      expect(snapshot.xterm.text).toBe(finalSnapshots[0]!.xterm.text);
    }

    const finalPixels: Partial<Record<ClientName, { readonly image: TerminalPixelImage; readonly changedRatio: number }>> = {};
    for (const client of clients) {
      const before = initialPixels[client.name];
      if (!before) throw new Error(`missing initial pixel crop for client ${client.name}`);
      const result = await expectKnownMarkerChanged(client.page, client.pane.xtermHost.locator(".xterm-screen"), before, {
        minimumChangedRatio: 0.001,
        testInfo,
        artifactName: `s06-${client.name.toLowerCase()}-final-marker-crop`,
      });
      finalPixels[client.name] = { image: result.after, changedRatio: result.changedRatio };
      await expectTerminalNonBlank(client.page, client.pane.xtermHost.locator(".xterm-screen"), {
        minimumNonBackgroundRatio: 0.001,
        testInfo,
        artifactName: `s06-${client.name.toLowerCase()}-final-terminal-crop`,
      });
    }
    expect(finalPixels.A?.image.width).toBe((initialPixels.A as TerminalPixelImage).width);
    expect(finalPixels.B?.image.width).toBe((initialPixels.B as TerminalPixelImage).width);
    expect(finalPixels.C?.image.width).toBe((initialPixels.C as TerminalPixelImage).width);

    for (const client of clients) {
      const events = await terminalEvents(client.page, terminalId);
      await assertMonotonicSequences(events);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "socket-stale")).toEqual([]);
      const floor = diagnosticFloors.get(client.name) ?? 0;
      const syncs = events.filter((event) => event.id > floor && event.type === "sync");
      expect(syncs.length).toBeLessThanOrEqual(1);
      for (const sync of syncs) expect(["snapshot", "resume"]).toContain(sync.data.mode);
      const report = await expectConnectedTerminalInvariants(client.page, terminalId, { timeout: WAIT_TIMEOUT_MS });
      expect(report.violations).toEqual([]);
      await expectNoPendingRecovery(client.page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    }
    for (const client of clients) {
      const unexpected = client.errors().filter((entry) => (
        entry.kind === "pageerror"
          || entry.kind === "requestfailed"
          || (entry.kind === "console" && /^error:/i.test(entry.message))
      ));
      expect(unexpected).toEqual([]);
    }

    const samples = resourceSamples.concat(await collectResourceSample(clients, server, terminalId));
    resourceSamples.splice(0, resourceSamples.length, ...samples);
    for (const sample of samples) {
      for (const browserSample of sample.browser) {
        expect(browserSample.activeSocketCount).toBe(1);
        expect(browserSample.attachedCanvasCount).toBe(browserSample.canvasCount);
        expect(browserSample.pendingParserBytes).toBeGreaterThanOrEqual(0);
        expect(browserSample.renderBacklogBytes).toBeGreaterThanOrEqual(0);
        expect(browserSample.flowPendingAcknowledgementBytes).toBeGreaterThanOrEqual(0);
      }
    }
    const heapSamples = samples.flatMap((sample) => sample.browser.flatMap((browserSample) => browserSample.heapUsedBytes === undefined ? [] : [browserSample.heapUsedBytes]));
    if (heapSamples.length > 1) {
      const heapBaseline = heapSamples[0]!;
      expect(Math.max(...heapSamples)).toBeLessThanOrEqual(heapBaseline + 256 * 1024 * 1024);
    }
    const serverRssSamples = samples.flatMap((sample) => sample.serverRssBytes === undefined ? [] : [sample.serverRssBytes]);
    if (serverRssSamples.length > 1) {
      expect(Math.max(...serverRssSamples)).toBeLessThanOrEqual(serverRssSamples[0]! + 256 * 1024 * 1024);
    }
    const networkEvents = faultController.events.slice(networkFloor);
    expect(networkEvents.filter((event) => event.type === "terminated")).toEqual([]);
    const terminalInfo = await readTerminalInfo(page, terminalId);
    expect(terminalInfo.clients).toBe(3);
    expect(terminalInfo.pid).not.toBeNull();

    const eventSets = await Promise.all(clients.map(async (client) => ({
      client,
      events: await terminalEvents(client.page, terminalId),
    })));
    const recovery = eventSets.flatMap(({ client, events }) => recoveryLatencies(events, diagnosticFloors.get(client.name) ?? 0));
    const snapshotCount = eventSets.reduce((count, { events }) => count + events.filter((event) => event.type === "sync" && event.data.mode === "snapshot").length, 0);
    const metrics = {
      scenario: "S-06",
      seed: "0x5106",
      durationMs: SOAK_DURATION_MS,
      burstIntervalMs: BURST_INTERVAL_MS,
      burstBytes: BURST_BYTES,
      scheduledBurstCount: workload.burstCount,
      boundaryCount: workload.boundaryCount,
      inputCount: workload.inputCount,
      finalStreamSequence: workload.streamEnd,
      resizeConvergenceMs: durationSummary(resizeMeasurements.map((measurement) => measurement.latencyMs)),
      reconnectToInteractiveMs: durationSummary(recovery),
      reconnectCount: recovery.length,
      snapshotCount,
      proxyFrameBytes: sumProxyFrameBytes(networkEvents, terminalId),
      throttledEvents: networkEvents.filter((event) => event.type === "throttled").length,
      resourceSamples,
      pixels: Object.fromEntries(Object.entries(finalPixels).map(([name, value]) => [name, value?.changedRatio ?? null])),
    };
    await attachMetrics(testInfo, metrics);
    metricsAttached = true;

    slowB?.dispose();
    slowB = undefined;
    const exitFloor = workload.writeSequence;
    const exitWait = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "exit_requested" && entry.code === 0,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await finalResponder.pane.sendInput("EXIT 0", true);
    await exitWait;
    await waitForTranscriptWrite(server, terminalId, exitFloor);
    const exitEntries = await server.readTranscript(terminalId);
    const exitWrites = freshWrites(exitEntries, exitFloor);
    expect(exitWrites.length).toBeGreaterThan(0);
    workload.streamEnd += exitWrites.reduce((total, entry) => total + writeBytes(entry).length, 0);
    workload.writeSequence = maxWriteSequence(exitEntries);
    exited = true;
    for (const client of clients) {
      const exitedSnapshot = await client.page.evaluate(async ({ id, timeout }) => {
        const api = (window as E2EWindow).__TERM_SERVER_E2E__;
        if (!api) throw new Error("term-server E2E diagnostics are unavailable");
        return api.waitForTerminal(id, (snapshot) => (
          snapshot.exitCode === 0
            && snapshot.socketState === "exited"
            && snapshot.activeSocketCount === 0
        ), { timeout });
      }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
      expect(exitedSnapshot.activeSocketCount).toBe(0);
    }
    const postExitInfo = await readTerminalInfo(page, terminalId);
    expect(postExitInfo.clients).toBe(0);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  } finally {
    if (model) model.dispose();
    slowB?.dispose();
    if (!metricsAttached && workload && terminalId) {
      try {
        await attachMetrics(testInfo, {
          scenario: "S-06",
          seed: "0x5106",
          durationMs: SOAK_DURATION_MS,
          partial: true,
          workload,
          resourceSamples,
        });
      } catch {
        // Failure artifacts are best effort; the fixture still owns process cleanup.
      }
    }
    if (!exited && terminalId && !page.isClosed()) {
      try {
        const responder = await chooseResponder(clients, terminalId);
        if (activeHoldToken) {
          await responder.pane.sendInput(`RELEASE ${activeHoldToken}`, true);
          await server.waitForTranscript(
            terminalId,
            (entry) => entry.event === "release" && entry.token === activeHoldToken,
            { timeoutMs: WAIT_TIMEOUT_MS },
          );
          activeHoldToken = undefined;
        }
        await responder.pane.sendInput("EXIT 0", true);
        await server.waitForTranscript(terminalId, (entry) => entry.event === "exit_requested" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
      } catch {
        // The isolated server teardown remains authoritative when the browser path failed.
      }
    }
    for (const client of clients.slice(1).reverse()) {
      await closeContext(client);
    }
    browserErrorsA.dispose();
  }
});
