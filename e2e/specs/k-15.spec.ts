import { createHash } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultController, NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import { TERMINAL_CHECKPOINT_CHUNK_BYTES } from "../../src/client/lib/terminal-checkpoint.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 120_000;
const BROWSER_VIEWPORT = { width: 1_280, height: 800 } as const;
const BURST_LINE_WIDTH = 120;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_LONG_TASK_DURATION_MS = 500;
const MAX_LONG_TASK_COUNT = 20;
const INTERACTION_LATENCY_BUDGET_MS = 250;
const PERFORMANCE_KEY = "__TERM_SERVER_E2E_K15_PERFORMANCE__";

test.setTimeout(10 * 60_000);

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type PerformanceEntry = {
  readonly startTime: number;
  readonly duration: number;
};

type PerformanceMetrics = {
  readonly supported: boolean;
  readonly startTime: number;
  readonly endTime: number;
  readonly longTasks: readonly PerformanceEntry[];
  readonly heapUsedBytes?: number;
};

type Tier = {
  readonly name: "1,000" | "10,000" | "50,000" | "maximum";
  readonly lines: number;
  readonly serializationBudgetMs: number;
};

type TierResult = {
  readonly name: Tier["name"];
  readonly lines: number;
  readonly bytes: number;
  readonly checkpointSize: number;
  readonly checkpointChunks: number;
  readonly checkpointSequence: number;
  readonly checkpointEpoch: number;
  readonly serializationDurationMs: number;
  readonly uploadDurationMs: number;
  readonly interactionLatencyMs: number;
  readonly longTaskCount: number;
  readonly maxLongTaskDurationMs: number;
  readonly heapBeforeBytes?: number;
  readonly heapAfterBytes?: number;
  readonly canvasCount: number;
  readonly renderer: E2ETerminalSnapshot["renderer"];
  readonly rendererLoads: number;
  readonly fixtureBurstSha256: string;
};

interface CreatedTerminal {
  readonly id: string;
  readonly name: string;
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length || 1;
  }
  return count;
}

function transcriptWriteBytes(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.event !== "write" || typeof entry.bytes !== "number" || !Number.isFinite(entry.bytes)) return total;
    return total + entry.bytes;
  }, 0);
}

function percentile(values: readonly number[], rank: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function burstByteCount(lines: number): number {
  return lines * (BURST_LINE_WIDTH + 1);
}

/** Hash the exact deterministic byte stream emitted by the PTY fixture. */
function expectedBurstSha256(bytes: number): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024 + 1, Math.max(1, bytes) + 1));
  let chunkLength = 0;
  let outputLength = 0;
  let column = 0;
  let visible = 0;
  while (outputLength < bytes) {
    chunk[chunkLength] = 65 + (visible % 26);
    chunkLength += 1;
    outputLength += 1;
    visible += 1;
    column += 1;
    if (column === BURST_LINE_WIDTH && outputLength < bytes - 1) {
      chunk[chunkLength] = 10;
      chunkLength += 1;
      outputLength += 1;
      column = 0;
    }
    if (chunkLength === chunk.length) {
      hash.update(chunk);
      chunkLength = 0;
    }
  }
  if (chunkLength > 0) hash.update(chunk.subarray(0, chunkLength));
  return hash.digest("hex");
}

function transcriptWriteSha256(entry: TranscriptEntry, name: string): string {
  if (typeof entry.data_base64 !== "string") throw new Error(`${name} write has no base64 payload`);
  const bytes = Buffer.from(entry.data_base64, "base64");
  if (bytes.length === 0) throw new Error(`${name} write is empty`);
  return createHash("sha256").update(bytes).digest("hex");
}

async function createFixtureTerminal(
  page: Page,
  path: string,
  shell: string,
): Promise<CreatedTerminal> {
  return page.evaluate(async ({ terminalPath, shellPath }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: terminalPath, cwd: "/tmp", shell: shellPath }),
    });
    if (!response.ok) throw new Error(`terminal creation failed (${response.status})`);
    const terminal = await response.json() as Partial<CreatedTerminal>;
    if (typeof terminal.id !== "string" || typeof terminal.name !== "string") {
      throw new Error("terminal creation response is missing identity");
    }
    return { id: terminal.id, name: terminal.name };
  }, { terminalPath: path, shellPath: shell });
}

async function configuredScrollbackLines(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`config request failed (${response.status})`);
    const config = await response.json() as { scrollbackLines?: unknown };
    if (typeof config.scrollbackLines !== "number" || !Number.isSafeInteger(config.scrollbackLines)) {
      throw new Error("config did not expose a safe scrollback line count");
    }
    if (config.scrollbackLines < 50_000) {
      throw new Error(`configured scrollback ${config.scrollbackLines} is below the required maximum tier`);
    }
    return config.scrollbackLines;
  });
}

async function waitForMountedPane(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount"
        && event.snapshot.kind === "pane"
        && event.terminalId === id,
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  minimumSequence: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimum, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
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
  }, { id: terminalId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForParserCommit(
  page: Page,
  terminalId: string,
  afterEventId: number,
  minimumSequence: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "parser-commit"
        && typeof event.data.sequence === "number"
        && event.data.sequence >= minimum,
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
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
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "checkpoint"
        && event.data.result === "sent"
        && typeof event.data.sequence === "number"
        && event.data.sequence >= minimum,
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
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

async function waitForTranscriptEntry(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(terminalId, predicate, { timeoutMs: WAIT_TIMEOUT_MS });
}

async function resetPerformanceMetrics(page: Page): Promise<{ readonly supported: boolean; readonly startTime: number; readonly heapUsedBytes?: number }> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    const supported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const startTime = performance.now();
    const longTasks: PerformanceEntry[] = [];
    const metrics = { supported, longTasks };
    target[key] = metrics;
    if (supported) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      target[`${key}:observer`] = observer;
    }
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize?: unknown };
    }).memory;
    const heapUsedBytes = typeof memory?.usedJSHeapSize === "number"
      && Number.isFinite(memory.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : undefined;
    return { supported, startTime, heapUsedBytes };
  }, PERFORMANCE_KEY);
}

async function readPerformanceMetrics(page: Page): Promise<PerformanceMetrics> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const metrics = target[key] as { supported?: unknown; longTasks?: unknown } | undefined;
    if (!metrics || typeof metrics.supported !== "boolean" || !Array.isArray(metrics.longTasks)) {
      throw new Error("K-15 performance metrics are unavailable");
    }
    const endTime = performance.now();
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize?: unknown };
    }).memory;
    const heapUsedBytes = typeof memory?.usedJSHeapSize === "number"
      && Number.isFinite(memory.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : undefined;
    return {
      supported: metrics.supported,
      startTime: 0,
      endTime,
      longTasks: metrics.longTasks as PerformanceEntry[],
      heapUsedBytes,
    };
  }, PERFORMANCE_KEY);
}

/**
 * The live browser uploads checkpoints as a `checkpointBinary` announcement
 * followed by binary frames whose nine-byte header carries kind byte 2 and
 * the announced sequence, which the proxy already decodes as `binaryKind`
 * and `sequence`. The announcement is not a chunk, so only the binary body
 * frames are counted against the diagnostics chunk count. Occurrence floors
 * are keyed per frame kind by the proxy, so they must also be computed over
 * kind-2 binary frames.
 */
function binaryCheckpointBodyFrames(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
  sequence: number,
  minimumOccurrence: number,
): readonly NetworkFaultEvent[] {
  return events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.binaryKind === 2
    && event.frame.sequence === sequence
    && event.frame.occurrence > minimumOccurrence
  ));
}

async function waitForCheckpointBodyFrame(
  controller: NetworkFaultController,
  terminalId: string,
  generation: number,
  sequence: number,
  minimumOccurrence: number,
): Promise<NetworkFaultEvent> {
  return controller.waitFor((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.binaryKind === 2
    && event.frame.sequence === sequence
    && event.frame.occurrence > minimumOccurrence
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

async function runTier(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  terminal: CreatedTerminal,
  tier: Tier,
  runTag: string,
  testInfo: TestInfo,
): Promise<TierResult> {
  const pane = await workbench.openTerminal({ id: terminal.id, name: terminal.name });
  const mountedPromise = waitForMountedPane(page, terminal.id);
  await pane.expectVisible();
  const mounted = await mountedPromise;
  expect(mounted.terminalId).toBe(terminal.id);
  await pane.expectConnected();
  await pane.focus();
  const initial = await waitForSettledTerminal(page, terminal.id, 0);
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  expect(initial.serverViewport?.pixelWidth).toBe(initial.pixelWidth);
  expect(initial.serverViewport?.pixelHeight).toBe(initial.pixelHeight);
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.socket.activeCount).toBe(1);
  expect(initial.acceptingInput).toBe(true);
  expect(initial.mounted).toBe(true);
  expect(initial.visible).toBe(true);
  expect(initial.cached).toBe(false);
  expect(initial.active).toBe(true);

  const sizeId = `${runTag}-${tier.name}-SIZE`;
  const readyId = `${runTag}-${tier.name}-READY`;
  const burstId = `${runTag}-${tier.name}-BURST`;
  const printId = `${runTag}-${tier.name}-MARKER`;
  const preId = `${runTag}-${tier.name}-SCROLLBACK-ANCHOR`;
  const printText = `${runTag}-${tier.name}-CHECKPOINT-MARKER`;
  const echoText = `${runTag}-${tier.name}-INTERACTION`;
  const readyMarker = marker("READY", readyId);
  const preMarker = marker("PRINT", preId, `${runTag}-${tier.name}-SCROLLBACK-ANCHOR`);
  const printMarker = marker("PRINT", printId, printText);
  const echoId = `${runTag}-${tier.name}-ECHO`;
  const echoMarker = marker("ECHO_INPUT", echoId, Buffer.from(echoText, "utf8").toString("base64"));

  const initialEvents = await terminalEvents(page, terminal.id);
  const initialFloor = initialEvents.at(-1)?.id ?? mounted.id;
  await pane.sendInput(`READY ${readyId}`, true);
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "ready" && entry.id === readyId);
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "write" && entry.text === `${readyMarker}\n`);
  const readyCommit = await waitForParserCommit(page, terminal.id, initialFloor, 1);
  await expectTerminalBuffer(page, terminal.id, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  expect(readyCommit.snapshot.xterm.text).toContain(readyMarker);

  const sizeFloor = readyCommit.id;
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const ptySize = await waitForTranscriptEntry(server, terminal.id, (entry) => (
    entry.event === "size" && entry.id === sizeId && entry.source === "ioctl"
  ));
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "write" && typeof entry.text === "string" && entry.text.startsWith(`[E2E:SIZE:${sizeId}:`));
  const beforeBurstWrites = await server.readTranscript(terminal.id);
  const beforeBurstSequence = transcriptWriteBytes(beforeBurstWrites);
  await waitForParserCommit(page, terminal.id, sizeFloor, beforeBurstSequence);
  expect(ptySize.rows).toBe(initial.rows);
  expect(ptySize.cols).toBe(initial.cols);
  expect(ptySize.pixel_width).toBe(initial.pixelWidth);
  expect(ptySize.pixel_height).toBe(initial.pixelHeight);

  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  const preFloor = (await terminalEvents(page, terminal.id)).at(-1)?.id ?? beforeBurstSequence;
  await pane.sendInput(`PRINT ${preId} ${runTag}-${tier.name}-SCROLLBACK-ANCHOR`, true);
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "print" && entry.id === preId);
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "write" && entry.text === `${preMarker}\n`);
  const afterPreludeWrites = await server.readTranscript(terminal.id);
  const preludeSequence = transcriptWriteBytes(afterPreludeWrites);
  const preludeCommit = await waitForParserCommit(page, terminal.id, preFloor, preludeSequence);
  await expectTerminalBuffer(page, terminal.id, { contains: preMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  expect(preludeCommit.snapshot.xterm.text).toContain(preMarker);
  const canvasCount = await pane.xtermHost.locator("canvas").count();
  expect(canvasCount).toBeLessThanOrEqual(4);
  expect(initial.renderer).toMatch(/^(webgl|canvas|dom)$/);
  expect(initial.webglLoadCount).toBeLessThanOrEqual(1);

  const bytes = burstByteCount(tier.lines);
  const burstCommandFloor = (await terminalEvents(page, terminal.id)).at(-1)?.id ?? beforeBurstSequence;
  const frameFloor = faultController.events
    .filter((event) => (
      event.type === "frame"
      && event.terminalId === terminal.id
      && event.generation === initial.socketGeneration
      && event.direction === "browser-to-server"
      && event.frame?.binaryKind === 2
    ))
    .reduce((maximum, event) => Math.max(maximum, event.frame?.occurrence ?? 0), 0);
  const performanceStart = await resetPerformanceMetrics(page);
  await pane.sendInput(`BURST ${burstId} ${bytes} ${BURST_LINE_WIDTH}`, true);
  const burst = await waitForTranscriptEntry(server, terminal.id, (entry) => (
    entry.event === "burst" && entry.id === burstId && entry.bytes === bytes && entry.line_width === BURST_LINE_WIDTH
  ));
  expect(burst.bytes).toBe(bytes);
  const burstWrite = await waitForTranscriptEntry(server, terminal.id, (entry) => (
    entry.event === "write" && entry.bytes === bytes && typeof entry.data_base64 === "string"
  ));
  const fixtureBurstSha256 = transcriptWriteSha256(burstWrite, `${tier.name} BURST`);
  expect(fixtureBurstSha256).toBe(expectedBurstSha256(bytes));
  const afterBurstWrites = await server.readTranscript(terminal.id);
  const afterBurstSequence = transcriptWriteBytes(afterBurstWrites);
  const burstCommit = await waitForParserCommit(page, terminal.id, burstCommandFloor, afterBurstSequence);
  expect(burstCommit.snapshot.committedSequence).toBeGreaterThanOrEqual(afterBurstSequence);

  await pane.sendInput(`PRINT ${printId} ${printText}`, true);
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "print" && entry.id === printId && entry.text === printText);
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "write" && entry.text === `${printMarker}\n`);
  const afterMarkerWrites = await server.readTranscript(terminal.id);
  const expectedCheckpointSequence = transcriptWriteBytes(afterMarkerWrites);
  const markerCommit = await waitForParserCommit(page, terminal.id, burstCommit.id, expectedCheckpointSequence);
  await waitForTerminalEventAfter(page, terminal.id, markerCommit.id, "render");
  await expectTerminalBuffer(page, terminal.id, { contains: preMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const checkpoint = await waitForCheckpoint(page, terminal.id, markerCommit.id, expectedCheckpointSequence);
  const performance = await readPerformanceMetrics(page);
  const checkpointSequence = requiredNumber(checkpoint.data.sequence, `${tier.name} checkpoint sequence`);
  const checkpointEpoch = requiredNumber(checkpoint.data.epoch, `${tier.name} checkpoint epoch`);
  const checkpointSize = requiredNumber(checkpoint.data.size, `${tier.name} checkpoint size`);
  const checkpointChunks = requiredNumber(checkpoint.data.chunks, `${tier.name} checkpoint chunks`);
  const serializationDurationMs = requiredNumber(
    checkpoint.data.serializationDurationMs,
    `${tier.name} serialization duration`,
  );
  const uploadDurationMs = requiredNumber(checkpoint.data.uploadDurationMs, `${tier.name} upload duration`);
  expect(checkpoint.data.result).toBe("sent");
  expect(checkpointSequence).toBeGreaterThanOrEqual(expectedCheckpointSequence);
  expect(checkpoint.snapshot.committedSequence).toBeGreaterThanOrEqual(checkpointSequence);
  expect(checkpoint.snapshot.gridEpoch).toBe(checkpointEpoch);
  expect(checkpoint.snapshot.checkpointSequence).toBe(checkpointSequence);
  expect(checkpoint.snapshot.checkpointEpoch).toBe(checkpointEpoch);
  expect(checkpoint.snapshot.checkpointResult).toBe("sent");
  expect(checkpointSize).toBeGreaterThan(0);
  expect(checkpointSize).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
  expect(checkpointChunks).toBe(Math.ceil(checkpointSize / TERMINAL_CHECKPOINT_CHUNK_BYTES));
  expect(serializationDurationMs).toBeGreaterThanOrEqual(0);
  expect(uploadDurationMs).toBeGreaterThanOrEqual(0);
  expect(serializationDurationMs).toBeLessThanOrEqual(tier.serializationBudgetMs);
  expect(uploadDurationMs).toBeLessThanOrEqual(INTERACTION_LATENCY_BUDGET_MS);
  // Dispatch the continued-input probe immediately after the checkpoint event
  // so the latency budget covers the interaction boundary, not screenshot work.
  await expectTerminalInteractive(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed");
  const interactionStartedAt = Date.now();
  await pane.insertText(echoText);
  await pane.press("Enter");
  const echoPayload = await waitForTranscriptEntry(server, terminal.id, (entry) => (
    entry.event === "echo_input"
    && entry.id === echoId
    && entry.phase === "payload"
    && entry.payload_base64 === Buffer.from(echoText, "utf8").toString("base64")
  ));
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "write" && entry.text === `${echoMarker}\n`);
  const interactionLatencyMs = Date.now() - interactionStartedAt;
  expect(echoPayload.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
  expect(interactionLatencyMs).toBeLessThanOrEqual(INTERACTION_LATENCY_BUDGET_MS);

  const checkpointFrame = await waitForCheckpointBodyFrame(
    faultController,
    terminal.id,
    checkpoint.snapshot.socketGeneration,
    checkpointSequence,
    frameFloor,
  );
  expect(checkpointFrame.frame?.bytes).toBeGreaterThan(0);
  const uploadedFrames = binaryCheckpointBodyFrames(
    faultController.events,
    terminal.id,
    checkpoint.snapshot.socketGeneration,
    checkpointSequence,
    frameFloor,
  );
  expect(uploadedFrames).toHaveLength(checkpointChunks);
  expect(uploadedFrames.map((event) => event.frame?.sequence)).toEqual(
    Array.from({ length: checkpointChunks }, () => checkpointSequence),
  );
  const proxiedAnnouncements = faultController.events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminal.id
    && event.generation === checkpoint.snapshot.socketGeneration
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpointBinary"
    && event.frame.sequence === checkpointSequence
  ));
  expect(proxiedAnnouncements).toHaveLength(1);

  const longTasks = performance.longTasks.filter((entry) => (
    entry.startTime >= performanceStart.startTime && entry.startTime <= performance.endTime
  ));
  const maxLongTaskDurationMs = longTasks.reduce((maximum, entry) => Math.max(maximum, entry.duration), 0);
  if (performance.supported) {
    expect(longTasks.length).toBeLessThanOrEqual(MAX_LONG_TASK_COUNT);
    expect(longTasks.every((entry) => Number.isFinite(entry.startTime) && Number.isFinite(entry.duration) && entry.duration >= 0)).toBe(true);
    expect(maxLongTaskDurationMs).toBeLessThanOrEqual(MAX_LONG_TASK_DURATION_MS);
  } else {
    testInfo.annotations.push({
      type: "capability",
      description: `${tier.name} tier omitted PerformanceObserver long-task fields because this browser does not expose longtask entries`,
    });
  }
  if (performance.heapUsedBytes === undefined) {
    testInfo.annotations.push({
      type: "capability",
      description: `${tier.name} tier omitted performance.memory because this browser does not expose usedJSHeapSize`,
    });
  } else {
    expect(performance.heapUsedBytes).toBeGreaterThanOrEqual(0);
  }

  await expectKnownMarkerChanged(page, pane.xtermHost, beforePixels, {
    minimumChangedRatio: 0.0002,
    testInfo,
    artifactName: `k-15-${tier.name.replace(/[^A-Za-z0-9]+/g, "-")}-marker`,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.001,
    testInfo,
    artifactName: `k-15-${tier.name.replace(/[^A-Za-z0-9]+/g, "-")}-terminal`,
  });


  const finalTranscript = await server.readTranscript(terminal.id);
  expect(finalTranscript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === bytes)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === printId && entry.text === printText)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === preId && entry.text === `${runTag}-${tier.name}-SCROLLBACK-ANCHOR`)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
  const finalWriteSequence = transcriptWriteBytes(finalTranscript);
  const finalSnapshot = await waitForSettledTerminal(page, terminal.id, finalWriteSequence);
  expect(finalSnapshot.receivedSequence).toBe(finalWriteSequence);
  expect(finalSnapshot.committedSequence).toBe(finalWriteSequence);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(finalSnapshot.syncTarget === undefined || finalSnapshot.committedSequence === undefined || finalSnapshot.committedSequence >= finalSnapshot.syncTarget).toBe(true);
  expect(finalSnapshot.xterm.text).toContain(preMarker);
  expect(countOccurrences(finalSnapshot.xterm.text, preMarker)).toBe(1);
  expect(finalSnapshot.rendererState.renderCount).toBeGreaterThan(0);
  await expectTerminalConverged(page, terminal.id, {
    cols: initial.cols,
    rows: initial.rows,
    pixelWidth: initial.pixelWidth,
    pixelHeight: initial.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  await expectNoPendingRecovery(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });

  const finalEvents = await terminalEvents(page, terminal.id);
  await assertMonotonicSequences(finalEvents);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "checkpoint" && event.data.result === "sent" && event.data.sequence === checkpointSequence)).toHaveLength(1);

  const networkEvents = faultController.events.filter((event) => event.terminalId === terminal.id);
  expect(networkEvents.filter((event) => event.type === "socket-error" || event.type === "malformed-frame")).toHaveLength(0);
  expect(networkEvents.filter((event) => event.type === "connection-open")).toHaveLength(1);
  expect(networkEvents.filter((event) => event.type === "connection-closed")).toHaveLength(0);

  const winches = finalTranscript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal");
  expect(winches.length).toBeGreaterThan(0);
  const latestWinch = winches.at(-1);
  if (!latestWinch) throw new Error(`${tier.name} tier has no final SIGWINCH transcript entry`);
  expect(latestWinch.rows).toBe(finalSnapshot.rows);
  expect(latestWinch.cols).toBe(finalSnapshot.cols);
  expect(latestWinch.pixel_width).toBe(finalSnapshot.pixelWidth);
  expect(latestWinch.pixel_height).toBe(finalSnapshot.pixelHeight);

  const exitFloor = finalEvents.at(-1)?.id ?? checkpoint.id;
  await pane.sendInput("EXIT 0", true);
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "exit_requested" && entry.code === 0);
  await waitForTranscriptEntry(server, terminal.id, (entry) => entry.event === "exit" && entry.code === 0);
  await waitForTerminalEventAfter(page, terminal.id, exitFloor, "exit");
  const unmountFloor = (await terminalEvents(page, terminal.id)).at(-1)?.id ?? exitFloor;
  const unmountPromise = waitForTerminalEventAfter(page, terminal.id, unmountFloor, "unmount");
  await pane.closePane();
  const unmount = await unmountPromise;
  expect(unmount.snapshot.lifecycle.mounted).toBe(false);
  expect(unmount.snapshot.activeSocketCount).toBe(0);
  expect(unmount.snapshot.socket.activeCount).toBe(0);
  expect(unmount.snapshot.lifecycle.acceptingInput).toBe(false);

  return {
    name: tier.name,
    lines: tier.lines,
    bytes,
    checkpointSize,
    checkpointChunks,
    checkpointSequence,
    checkpointEpoch,
    serializationDurationMs,
    uploadDurationMs,
    interactionLatencyMs,
    longTaskCount: longTasks.length,
    maxLongTaskDurationMs,
    heapBeforeBytes: performanceStart.heapUsedBytes,
    heapAfterBytes: performance.heapUsedBytes,
    canvasCount,
    renderer: finalSnapshot.renderer,
    rendererLoads: finalSnapshot.webglLoadCount,
    fixtureBurstSha256,
  };
}

test("K-15 Checkpoint serialization responsiveness @nightly @p1 @checkpoint @performance @scrollback", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `K15-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const tiers: readonly Tier[] = [
    { name: "1,000", lines: 1_000, serializationBudgetMs: 250 },
    { name: "10,000", lines: 10_000, serializationBudgetMs: 1_000 },
    { name: "50,000", lines: 50_000, serializationBudgetMs: 2_500 },
    { name: "maximum", lines: 0, serializationBudgetMs: 5_000 },
  ];
  const workbench = new WorkbenchPage(page);
  const results: TierResult[] = [];

  await page.setViewportSize(BROWSER_VIEWPORT);
  await page.goto(baseURL);
  await new LoginPage(page).login();
  await workbench.expectVisible();
  const maximumConfiguredScrollback = await configuredScrollbackLines(page);
  const terminals: CreatedTerminal[] = [];
  for (const tier of tiers) {
    const lines = tier.name === "maximum" ? maximumConfiguredScrollback : tier.lines;
    terminals.push(await createFixtureTerminal(page, `k15-${runTag}-${lines}`, server.fixturePath));
  }
  await page.reload();
  await workbench.expectVisible();

  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index]!;
    const effectiveTier: Tier = tier.name === "maximum"
      ? { ...tier, lines: maximumConfiguredScrollback }
      : tier;
    const terminal = terminals[index]!;
    results.push(await runTier(
      page,
      workbench,
      server,
      faultController,
      terminal,
      effectiveTier,
      runTag,
      testInfo,
    ));
  }

  expect(results.map((result) => result.lines)).toEqual([
    1_000,
    10_000,
    50_000,
    maximumConfiguredScrollback,
  ]);
  expect(results.map((result) => result.bytes)).toEqual(
    results.map((result) => burstByteCount(result.lines)),
  );
  expect(maximumConfiguredScrollback).toBeGreaterThanOrEqual(50_000);
  expect(results.every((result) => result.checkpointSize > 0 && result.checkpointSize <= MAX_CHECKPOINT_BYTES)).toBe(true);
  expect(results.every((result) => result.checkpointChunks === Math.ceil(result.checkpointSize / TERMINAL_CHECKPOINT_CHUNK_BYTES))).toBe(true);
  expect(results.every((result) => result.serializationDurationMs >= 0 && result.uploadDurationMs >= 0)).toBe(true);
  expect(results.every((result) => result.interactionLatencyMs <= INTERACTION_LATENCY_BUDGET_MS)).toBe(true);
  expect(results.every((result) => result.maxLongTaskDurationMs <= MAX_LONG_TASK_DURATION_MS)).toBe(true);
  expect(new Set(results.map((result) => result.fixtureBurstSha256)).size).toBe(results.length);

  const performanceArtifact = {
    test: "K-15 Checkpoint serialization responsiveness",
    configuredScrollbackLines: maximumConfiguredScrollback,
    budgets: {
      serializationMs: results.map((result) => ({ tier: result.name, budget: tiers.find((candidate) => candidate.name === result.name)?.serializationBudgetMs ?? 0 })),
      uploadMs: INTERACTION_LATENCY_BUDGET_MS,
      interactionMs: INTERACTION_LATENCY_BUDGET_MS,
      longTaskMs: MAX_LONG_TASK_DURATION_MS,
      longTaskCount: MAX_LONG_TASK_COUNT,
    },
    tiers: results,
    aggregate: {
      serializationP50Ms: percentile(results.map((result) => result.serializationDurationMs), 0.5),
      serializationP95Ms: percentile(results.map((result) => result.serializationDurationMs), 0.95),
      serializationMaxMs: Math.max(...results.map((result) => result.serializationDurationMs)),
      interactionP50Ms: percentile(results.map((result) => result.interactionLatencyMs), 0.5),
      interactionP95Ms: percentile(results.map((result) => result.interactionLatencyMs), 0.95),
      interactionMaxMs: Math.max(...results.map((result) => result.interactionLatencyMs)),
      longTaskMaxMs: Math.max(...results.map((result) => result.maxLongTaskDurationMs)),
    },
  };
  await testInfo.attach("k-15-performance.json", {
    body: JSON.stringify(performanceArtifact, null, 2),
    contentType: "application/json",
  });

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  browserErrors.dispose();
});
