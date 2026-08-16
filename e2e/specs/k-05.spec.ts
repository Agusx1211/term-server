import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Browser, Page, TestInfo, WebSocket as PlaywrightWebSocket } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors, type BrowserErrorLog } from "../fixtures/artifacts.js";
import {
  assertMonotonicSequences,
  expectTerminalConverged,
  expectTerminalInteractive,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import { expectTerminalNonBlank } from "../assertions/terminal-pixels.js";
import type { E2ETerminalDiagnosticsApi, E2ETerminalEvent, E2ETerminalSnapshot } from "../../src/client/lib/e2e-diagnostics.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 45_000;
const BROWSER_VIEWPORT = { width: 1_280, height: 720 } as const;
const CHECKPOINT_CHUNK_BYTES = 32 * 1024;
const SOCKET_MESSAGE_LIMIT_BYTES = 64 * 1024;
const TARGET_SIZES = [CHECKPOINT_CHUNK_BYTES - 256, CHECKPOINT_CHUNK_BYTES + 256] as const;
const CALIBRATION_SERIALIZED_OVERHEAD_BYTES = 4_096;
const CALIBRATION_PROBE_SPAN_BYTES = 2_048;
const CALIBRATION_MAX_CORRECTIONS = 6;
const CALIBRATION_MAX_BRACKET_STEPS = 8;
const CALIBRATION_DEFAULT_SLOPE = 2;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type CreatedTerminal = {
  readonly id: string;
  readonly name?: string;
};

type JsonObject = { readonly [key: string]: unknown };

type WireFrame = {
  readonly direction: "sent" | "received";
  readonly url: string;
  readonly payload: string | Buffer;
  readonly json?: JsonObject;
};

type WirePredicate = (frame: WireFrame) => boolean;

type WireWaiter = {
  readonly predicate: WirePredicate;
  readonly resolve: (frame: WireFrame) => void;
  readonly reject: (error: Error) => void;
};

class WireCapture {
  readonly frames: WireFrame[] = [];
  private readonly page: Page;
  private readonly waiters = new Set<WireWaiter>();
  private readonly onWebSocket = (socket: PlaywrightWebSocket): void => {
    const url = socket.url();
    socket.on("framesent", ({ payload }) => this.push({ direction: "sent", url, payload: copyPayload(payload) }));
    socket.on("framereceived", ({ payload }) => this.push({ direction: "received", url, payload: copyPayload(payload) }));
  };

  constructor(page: Page) {
    this.page = page;
    page.on("websocket", this.onWebSocket);
  }

  waitFor(predicate: WirePredicate, timeoutMs = WAIT_TIMEOUT_MS): Promise<WireFrame> {
    for (const frame of this.frames) if (predicate(frame)) return Promise.resolve(frame);
    return new Promise<WireFrame>((resolve, reject) => {
      let waiter!: WireWaiter;
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`timed out waiting for a browser websocket frame after ${timeoutMs}ms`));
      }, timeoutMs);
      waiter = {
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          reject(error);
        },
      };
      this.waiters.add(waiter);
    });
  }

  dispose(): void {
    this.page.off("websocket", this.onWebSocket);
    for (const waiter of [...this.waiters]) waiter.reject(new Error("browser websocket capture disposed"));
    this.waiters.clear();
  }

  private push(frame: WireFrame): void {
    const json = parseJson(frame.payload);
    const captured = json === undefined ? frame : { ...frame, json };
    this.frames.push(captured);
    for (const waiter of [...this.waiters]) {
      let matches = false;
      try {
        matches = waiter.predicate(captured);
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (matches) waiter.resolve(captured);
    }
  }
}

function copyPayload(payload: string | Buffer): string | Buffer {
  return typeof payload === "string" ? payload : Buffer.from(payload);
}

function parseJson(payload: string | Buffer): JsonObject | undefined {
  if (typeof payload !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}

function numberField(entry: JsonObject | TranscriptEntry | undefined, key: string): number | undefined {
  const value = entry?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function transcriptSequence(entry: TranscriptEntry): number {
  return numberField(entry, "sequence") ?? 0;
}

async function transcriptFloor(server: IsolatedServer, terminalId: string): Promise<number> {
  const entries = await server.readTranscript(terminalId);
  return entries.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
}

async function sendFixtureOutputCommand(
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
    (entry) => transcriptSequence(entry) > floor && predicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const writeEntry = await server.waitForTranscript(
    terminalId,
    (entry) => transcriptSequence(entry) > transcriptSequence(commandEntry) && entry.event === "write",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  return { command: commandEntry, write: writeEntry };
}

async function sendFixtureEvent(
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  command: string,
  predicate: (entry: TranscriptEntry) => boolean,
): Promise<TranscriptEntry> {
  const floor = await transcriptFloor(server, terminalId);
  await pane.sendInput(command, true);
  return server.waitForTranscript(
    terminalId,
    (entry) => transcriptSequence(entry) > floor && predicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

function writeBytes(entry: TranscriptEntry): number {
  const value = numberField(entry, "bytes");
  if (entry.event !== "write" || value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("fixture write transcript omitted a non-negative byte count");
  }
  return value;
}

async function latestEventId(page: Page, terminalId: string): Promise<number> {
  const events = await terminalEvents(page, terminalId);
  return events.at(-1)?.id ?? 0;
}

async function latestGlobalEventId(page: Page): Promise<number> {
  return page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.events().at(-1)?.id ?? 0;
  });
}
async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  eventType: E2ETerminalEvent["type"],
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, type, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after && event.type === type,
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, type: eventType, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCheckpointAfter(
  page: Page,
  terminalId: string,
  minimumCommitted: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => {
        const sequence = event.data.sequence;
        return event.type === "checkpoint"
          && typeof sequence === "number"
          && Number.isFinite(sequence)
          && sequence >= minimum;
      },
      { timeout },
    );
  }, { id: terminalId, minimum: minimumCommitted, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCommittedBytes(
  page: Page,
  terminalId: string,
  previousCommitted: number,
  expectedBytes: number,
): Promise<E2ETerminalSnapshot> {
  const expected = previousCommitted + expectedBytes;
  return page.evaluate(async ({ id, expectedSequence, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.committedSequence !== undefined
        && snapshot.committedSequence >= expectedSequence
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0,
      { timeout },
    );
  }, { id: terminalId, expectedSequence: expected, timeout: WAIT_TIMEOUT_MS });
}

function socketMatches(frame: WireFrame, terminalId: string): boolean {
  return frame.url.includes(`/api/terminals/${terminalId}/socket`);
}

type CheckpointAnnouncement = {
  readonly sequence: number;
  readonly epoch: number;
  readonly size: number;
};

function checkpointAnnouncement(frame: WireFrame, terminalId: string): CheckpointAnnouncement | undefined {
  if (frame.direction !== "sent" || !socketMatches(frame, terminalId) || frame.json?.type !== "checkpointBinary") return undefined;
  const sequence = numberField(frame.json, "sequence");
  const epoch = numberField(frame.json, "epoch");
  const size = numberField(frame.json, "size");
  if (sequence === undefined || epoch === undefined || size === undefined) return undefined;
  return { sequence, epoch, size };
}

// Binary checkpoint chunks carry a nine-byte header: kind byte 2 and the
// announced sequence as a big-endian u64, mirroring server-to-browser frames.
const CHECKPOINT_FRAME_KIND = 2;
const CHECKPOINT_FRAME_HEADER_BYTES = 9;

function checkpointChunkPayload(frame: WireFrame, terminalId: string, sequence: number): Buffer | undefined {
  if (frame.direction !== "sent" || !socketMatches(frame, terminalId)) return undefined;
  if (typeof frame.payload === "string" || frame.payload.length <= CHECKPOINT_FRAME_HEADER_BYTES) return undefined;
  if (frame.payload[0] !== CHECKPOINT_FRAME_KIND) return undefined;
  if (frame.payload.readBigUInt64BE(1) !== BigInt(sequence)) return undefined;
  return frame.payload.subarray(CHECKPOINT_FRAME_HEADER_BYTES);
}

function checkpointChunksAfter(
  capture: WireCapture,
  terminalId: string,
  sequence: number,
  announcementIndex: number,
  expected: number,
): Buffer[] {
  const chunks: Buffer[] = [];
  for (const frame of capture.frames.slice(announcementIndex + 1)) {
    const payload = checkpointChunkPayload(frame, terminalId, sequence);
    if (!payload) continue;
    chunks.push(payload);
    if (chunks.length === expected) break;
  }
  return chunks;
}

async function waitForCheckpointUpload(
  capture: WireCapture,
  terminalId: string,
  sequence: number,
  epoch: number,
  expected: number,
): Promise<{ readonly announcement: CheckpointAnnouncement; readonly announcementIndex: number; readonly chunks: Buffer[] }> {
  const frame = await capture.waitFor((candidate) => {
    const announcement = checkpointAnnouncement(candidate, terminalId);
    return announcement?.sequence === sequence && announcement.epoch === epoch;
  });
  const announcement = checkpointAnnouncement(frame, terminalId);
  if (!announcement) throw new Error("checkpoint announcement frame lost its payload");
  const announcementIndex = capture.frames.indexOf(frame);
  await capture.waitFor(() => checkpointChunksAfter(capture, terminalId, sequence, announcementIndex, expected).length >= expected);
  const chunks = checkpointChunksAfter(capture, terminalId, sequence, announcementIndex, expected);
  if (chunks.length !== expected) throw new Error(`terminal ${terminalId} sent ${chunks.length} checkpoint chunks for sequence ${sequence}; expected ${expected}`);
  return { announcement, announcementIndex, chunks };
}

function legacyCheckpointFrameCount(capture: WireCapture, terminalId: string): number {
  return capture.frames.filter((frame) => (
    frame.direction === "sent" && socketMatches(frame, terminalId) && frame.json?.type === "checkpoint"
  )).length;
}

function latestCompleteCheckpointBytes(capture: WireCapture, terminalId: string, endExclusive = capture.frames.length): Buffer {
  const frames = capture.frames.slice(0, endExclusive);
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const announcement = checkpointAnnouncement(frames[index]!, terminalId);
    if (!announcement) continue;
    const chunks: Buffer[] = [];
    let received = 0;
    for (const frame of frames.slice(index + 1)) {
      const payload = checkpointChunkPayload(frame, terminalId, announcement.sequence);
      if (!payload) continue;
      chunks.push(payload);
      received += payload.length;
      if (received >= announcement.size) break;
    }
    if (received === announcement.size) return Buffer.concat(chunks);
  }
  throw new Error(`terminal ${terminalId} did not send a complete checkpoint`);
}
async function probeSnapshot(
  page: Page,
  terminalId: string,
  viewport: Pick<E2ETerminalSnapshot, "cols" | "rows" | "pixelWidth" | "pixelHeight">,
): Promise<Buffer> {
  const bytes = await page.evaluate(({ id, size, timeout }) => new Promise<number[]>((resolve, reject) => {
    const url = new URL(`/api/terminals/${id}/socket`, window.location.href);

    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("stream", "3");
    url.searchParams.set("observer", "true");
    url.searchParams.set("cols", String(size.cols));
    url.searchParams.set("rows", String(size.rows));
    url.searchParams.set("pixelWidth", String(size.pixelWidth));
    url.searchParams.set("pixelHeight", String(size.pixelHeight));
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const timer = window.setTimeout(() => {
      socket.close();
      reject(new Error(`timed out waiting for checkpoint snapshot for ${id}`));
    }, timeout);
    socket.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error(`checkpoint snapshot socket failed for ${id}`));
    };
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const frame = new Uint8Array(event.data);
      if (frame.length < 9 || frame[0] !== 0) return;
      window.clearTimeout(timer);
      socket.close();
      resolve(Array.from(frame.subarray(9)));
    };
  }), { id: terminalId, size: viewport, timeout: WAIT_TIMEOUT_MS });
  return Buffer.from(bytes);
}



function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForReady(capture: WireCapture, terminalId: string): Promise<{ readonly checkpointBytes: number }> {
  const frame = await capture.waitFor((candidate) => (
    candidate.direction === "received"
    && socketMatches(candidate, terminalId)
    && candidate.json?.type === "ready"
  ));
  const checkpointBytes = numberField(frame.json, "checkpointBytes");
  if (checkpointBytes === undefined || !Number.isSafeInteger(checkpointBytes) || checkpointBytes <= 0) {
    throw new Error("terminal ready control omitted a positive checkpointBytes limit");
  }
  return { checkpointBytes };
}

async function createTerminal(page: Page, workbench: WorkbenchPage): Promise<{ readonly terminal: CreatedTerminal; readonly pane: TerminalPanePage; readonly mounted: E2ETerminalEvent }> {
  const mountFloor = await latestGlobalEventId(page);
  const mountPromise = page.evaluate(async ({ floor, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.id > floor && event.type === "mount" && event.snapshot.kind === "pane",
      { timeout, afterId: floor },
    );
  }, { floor: mountFloor, timeout: WAIT_TIMEOUT_MS });
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`terminal creation failed with HTTP ${response.status()}`);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || typeof (value as JsonObject).id !== "string") {
    throw new Error("terminal creation response omitted an id");
  }
  const terminal = {
    id: (value as JsonObject).id as string,
    ...(typeof (value as JsonObject).name === "string" ? { name: (value as JsonObject).name as string } : {}),
  } satisfies CreatedTerminal;
  const mounted = await mountPromise;
  if (mounted.terminalId !== terminal.id) throw new Error("terminal mount did not match the created terminal");
  const pane = workbench.terminal(terminal.id, terminal.name);
  await pane.expectVisible();
  await expectTerminalInteractive(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
  return { terminal, pane, mounted };
}

async function runPayloadCandidate(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  readyId: string,
  sizeId: string,
  eraseId: string,
  burstId: string,
  printId: string,
  printText: string,
  burstBytes: number,
  previousCommitted?: number,
): Promise<{ readonly checkpoint: E2ETerminalEvent; readonly outputBytes: number }> {
  let committedBefore = previousCommitted;
  if (committedBefore === undefined) {
    const before = await terminalSnapshot(page, terminalId);
    if (!before) throw new Error(`diagnostics snapshot missing for terminal ${terminalId}`);
    committedBefore = before.committedSequence ?? 0;
  }
  let outputBytes = 0;
  const ready = await sendFixtureOutputCommand(server, pane, terminalId, `READY ${readyId}`, (entry) => entry.event === "ready" && entry.id === readyId);
  outputBytes += writeBytes(ready.write);
  const size = await sendFixtureOutputCommand(server, pane, terminalId, `SIZE ${sizeId}`, (entry) => entry.event === "size" && entry.id === sizeId);
  outputBytes += writeBytes(size.write);
  const erase = await sendFixtureOutputCommand(server, pane, terminalId, `ERASE ${eraseId} scrollback`, (entry) => entry.event === "erase" && entry.id === eraseId);
  outputBytes += writeBytes(erase.write);
  const burst = await sendFixtureOutputCommand(server, pane, terminalId, `BURST ${burstId} ${burstBytes} 80`, (entry) => entry.event === "burst" && entry.id === burstId);
  outputBytes += writeBytes(burst.write);
  const print = await sendFixtureOutputCommand(server, pane, terminalId, `PRINT ${printId} ${printText}`, (entry) => entry.event === "print" && entry.id === printId);
  outputBytes += writeBytes(print.write);
  const committed = await waitForCommittedBytes(page, terminalId, committedBefore, outputBytes);
  const checkpointFloor = committed.committedSequence ?? committedBefore + outputBytes;
  const checkpoint = await waitForCheckpointAfter(page, terminalId, checkpointFloor);
  if (checkpoint.data.result !== "sent") {
    throw new Error(`checkpoint serialization did not send: result=${String(checkpoint.data.result)} size=${String(checkpoint.data.size)}`);
  }
  return { checkpoint, outputBytes };
}

async function calibrateBurstBytes(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  readyId: string,
  sizeId: string,
  eraseId: string,
  burstId: string,
  printId: string,
  printText: string,
  targetSize: number,
): Promise<number> {
  const initial = await terminalSnapshot(page, terminalId);
  if (!initial) throw new Error(`diagnostics snapshot missing for terminal ${terminalId}`);
  let previousCommitted = initial.committedSequence ?? 0;
  const maximumBurstBytes = targetSize + 4_096;
  const center = Math.max(0, targetSize - CALIBRATION_SERIALIZED_OVERHEAD_BYTES);
  const lowerCandidate = Math.max(0, center - CALIBRATION_PROBE_SPAN_BYTES);
  const upperCandidate = Math.min(maximumBurstBytes, center + CALIBRATION_PROBE_SPAN_BYTES);
  const observations = new Map<number, number>();

  const observe = async (candidate: number): Promise<number> => {
    const boundedCandidate = Math.max(0, Math.min(maximumBurstBytes, Math.round(candidate)));
    const previous = observations.get(boundedCandidate);
    if (previous !== undefined) return previous;
    const result = await runPayloadCandidate(
      page,
      server,
      pane,
      terminalId,
      readyId,
      sizeId,
      eraseId,
      burstId,
      printId,
      printText,
      boundedCandidate,
      previousCommitted,
    );
    previousCommitted = result.checkpoint.snapshot.committedSequence
      ?? previousCommitted + result.outputBytes;
    const size = numberField(result.checkpoint.data, "size");
    if (size === undefined) throw new Error("checkpoint event omitted serialized size during calibration");
    observations.set(boundedCandidate, size);
    return size;
  };

  const lowerSize = await observe(lowerCandidate);
  if (lowerSize === targetSize) return lowerCandidate;
  const upperSize = await observe(upperCandidate);
  if (upperSize === targetSize) return upperCandidate;

  let slope = (upperSize - lowerSize) / (upperCandidate - lowerCandidate);
  if (!Number.isFinite(slope) || slope <= 0) slope = CALIBRATION_DEFAULT_SLOPE;
  const interpolated = lowerCandidate + (targetSize - lowerSize) / slope;
  let candidate = Math.max(
    0,
    Math.min(
      maximumBurstBytes,
      Number.isFinite(interpolated) ? Math.round(interpolated) : center,
    ),
  );
  for (let attempt = 0; attempt <= CALIBRATION_MAX_CORRECTIONS; attempt += 1) {
    const size = await observe(candidate);
    if (size === targetSize) return candidate;
    const correction = Math.round((targetSize - size) / slope);
    candidate = Math.max(
      0,
      Math.min(
        maximumBurstBytes,
        candidate + (correction === 0 ? (size < targetSize ? 1 : -1) : correction),
      ),
    );
  }

  let lowerBound: readonly [number, number] | undefined;
  let upperBound: readonly [number, number] | undefined;
  for (const [candidateBytes, size] of observations) {
    if (size < targetSize && (lowerBound === undefined || candidateBytes > lowerBound[0])) {
      lowerBound = [candidateBytes, size];
    }
    if (size > targetSize && (upperBound === undefined || candidateBytes < upperBound[0])) {
      upperBound = [candidateBytes, size];
    }
  }
  for (let attempt = 0; attempt < CALIBRATION_MAX_BRACKET_STEPS; attempt += 1) {
    if (
      lowerBound === undefined
      || upperBound === undefined
      || upperBound[0] - lowerBound[0] <= 1
    ) {
      break;
    }
    const midpoint = Math.floor((lowerBound[0] + upperBound[0]) / 2);
    const size = await observe(midpoint);
    if (size === targetSize) return midpoint;
    if (size < targetSize) lowerBound = [midpoint, size];
    else upperBound = [midpoint, size];
  }

  let nearestBytes: number | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [candidateBytes, size] of observations) {
    const isExpectedSide = targetSize < CHECKPOINT_CHUNK_BYTES
      ? size < CHECKPOINT_CHUNK_BYTES
      : size > CHECKPOINT_CHUNK_BYTES;
    const distance = Math.abs(size - targetSize);
    if (isExpectedSide && distance < nearestDistance) {
      nearestDistance = distance;
      nearestBytes = candidateBytes;
    }
  }
  if (nearestBytes !== undefined) return nearestBytes;
  const observed = [...observations].sort(([left], [right]) => left - right);
  throw new Error(`calibration did not reach the expected side of ${CHECKPOINT_CHUNK_BYTES} bytes for target ${targetSize}; observations=${JSON.stringify(observed)}`);
}

function unexpectedBrowserErrors(errors: readonly BrowserErrorLog[]): BrowserErrorLog[] {
  return errors.filter((entry) => entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message));
}

async function assertAcceptedCheckpoint(
  browser: Browser,
  baseURL: string,
  terminalId: string,
  expectedBytes: Buffer,
  baseline: E2ETerminalSnapshot,
  deviceScaleFactor: number,
): Promise<void> {
  const context = await browser.newContext({
    baseURL,
    viewport: BROWSER_VIEWPORT,
    deviceScaleFactor,
  });
  const page = await context.newPage();
  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    await expect(page.locator(".xterm-host").first()).toBeVisible();
    const snapshotBytes = await probeSnapshot(page, terminalId, baseline);
    expect(snapshotBytes.length).toBeGreaterThanOrEqual(expectedBytes.length);
    const restoredCheckpoint = snapshotBytes.subarray(0, expectedBytes.length);
    expect(restoredCheckpoint.equals(expectedBytes)).toBe(true);
    expect(sha256(restoredCheckpoint)).toBe(sha256(expectedBytes));
  } finally {
    await context.close();
  }
}

test.setTimeout(240_000);

test("K-05 Checkpoint chunk boundaries @nightly @p1 @checkpoint @chunks @protocol", async ({ browser, page, baseURL, server, faultController }, testInfo) => {
  await page.setViewportSize(BROWSER_VIEWPORT);
  const browserErrors = installBrowserErrorCollectors(page);
  const capture = new WireCapture(page);
  const runTag = `K05-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}`.replace(/[^A-Za-z0-9_-]+/g, "-");
  const workbench = new WorkbenchPage(page);
  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    await workbench.expectVisible();
    const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);


    for (const targetSize of TARGET_SIZES) {
      const key = targetSize < CHECKPOINT_CHUNK_BYTES ? "BELOW" : targetSize === CHECKPOINT_CHUNK_BYTES ? "EXACT" : "ABOVE";
      const readyId = `${runTag}-${key}-RUN-READY`;
      const sizeId = `${runTag}-${key}-RUN-SIZE`;
      const eraseId = `${runTag}-${key}-RUN-ERASE`;
      const burstId = `${runTag}-${key}-RUN-BURST`;
      const printId = `${runTag}-${key}-RUN-PRINT`;
      const printText = `${runTag}-${key}-RUN-MARKER`;
      const expectedChunkCount = targetSize <= CHECKPOINT_CHUNK_BYTES ? 1 : 2;
      const created = await createTerminal(page, workbench);
      const terminalId = created.terminal.id;
      const ready = await waitForReady(capture, terminalId);
      expect(ready.checkpointBytes).toBeGreaterThanOrEqual(targetSize);
      const initial = await terminalSnapshot(page, terminalId);
      if (!initial) throw new Error(`diagnostics snapshot missing for terminal ${terminalId}`);
      const baseline = await expectTerminalConverged(page, terminalId, {
        cols: initial.cols,
        rows: initial.rows,
        pixelWidth: initial.pixelWidth,
        pixelHeight: initial.pixelHeight,
      }, { timeout: WAIT_TIMEOUT_MS });
      expect(baseline.cols).toBeGreaterThan(0);
      expect(baseline.rows).toBeGreaterThan(0);
      const calibrationBurstBytes = await calibrateBurstBytes(
        page,
        server,
        created.pane,
        terminalId,
        readyId,
        sizeId,
        eraseId,
        burstId,
        printId,
        printText,
        targetSize,
      );
      {
        const candidate = await runPayloadCandidate(
          page,
          server,
          created.pane,
          terminalId,
          readyId,
          sizeId,
          eraseId,
          burstId,
          printId,
          printText,
          calibrationBurstBytes,
        );
        const checkpointSize = numberField(candidate.checkpoint.data, "size");
        const checkpointSequence = numberField(candidate.checkpoint.data, "sequence");
        const checkpointEpoch = numberField(candidate.checkpoint.data, "epoch");
        const checkpointChunks = numberField(candidate.checkpoint.data, "chunks");
        if (checkpointSize === undefined) throw new Error("checkpoint event omitted serialized size");
        if (checkpointSequence === undefined || checkpointEpoch === undefined) throw new Error("checkpoint event omitted sequence or epoch");
        if (targetSize < CHECKPOINT_CHUNK_BYTES) expect(checkpointSize).toBeLessThan(CHECKPOINT_CHUNK_BYTES);
        else if (targetSize === CHECKPOINT_CHUNK_BYTES) expect(checkpointSize).toBe(CHECKPOINT_CHUNK_BYTES);
        else expect(checkpointSize).toBeGreaterThan(CHECKPOINT_CHUNK_BYTES);
        expect(checkpointSize).toBeLessThanOrEqual(ready.checkpointBytes);
        expect(checkpointSequence).toBe(candidate.checkpoint.snapshot.committedSequence);
        expect(checkpointEpoch).toBe(candidate.checkpoint.snapshot.gridEpoch);
        expect(checkpointChunks).toBe(expectedChunkCount);
        await expectTerminalNonBlank(page, created.pane.xtermHost, {
          testInfo,
          artifactName: `k-05-${key.toLowerCase()}-output-crop`,
        });
        const upload = await waitForCheckpointUpload(capture, terminalId, checkpointSequence, checkpointEpoch, expectedChunkCount);
        expect(upload.announcement.size).toBe(checkpointSize);
        expect(legacyCheckpointFrameCount(capture, terminalId)).toBe(0);
        const proxiedAnnouncements = faultController.events.filter((event) => (
          event.type === "frame"
          && event.terminalId === terminalId
          && event.direction === "browser-to-server"
          && event.frame?.jsonType === "checkpointBinary"
          && event.frame?.sequence === checkpointSequence
        ));
        expect(proxiedAnnouncements).toHaveLength(1);
        for (const [chunkIndex, chunk] of upload.chunks.entries()) {
          expect(chunk.length).toBe(chunkIndex < upload.chunks.length - 1 ? CHECKPOINT_CHUNK_BYTES : checkpointSize - chunkIndex * CHECKPOINT_CHUNK_BYTES);
          expect(chunk.length).toBeLessThan(SOCKET_MESSAGE_LIMIT_BYTES);
        }
        const serializedBytes = Buffer.concat(upload.chunks);
        expect(serializedBytes.length).toBe(checkpointSize);
        const pingFloor = capture.frames.length;
        const pingFrame = await capture.waitFor((frame) => (
          capture.frames.indexOf(frame) >= pingFloor
          && frame.direction === "sent"
          && socketMatches(frame, terminalId)
          && frame.json?.type === "ping"
        ));
        const processedFrameLimit = capture.frames.indexOf(pingFrame);
        const pongFloor = capture.frames.length;
        await capture.waitFor((frame) => (
          capture.frames.indexOf(frame) >= pongFloor
          && frame.direction === "received"
          && socketMatches(frame, terminalId)
          && frame.json?.type === "pong"
        ));
        const closeFloor = await latestEventId(page, terminalId);
        const closePromise = waitForDiagnosticEventAfter(page, terminalId, closeFloor, "socket-close");
        const originalEvents = await terminalEvents(page, terminalId);
        await assertMonotonicSequences(originalEvents);
        expect(originalEvents.filter((event) => event.type === "error")).toEqual([]);
        expect(unexpectedBrowserErrors(browserErrors())).toEqual([]);
        const termination = faultController.terminate({ terminalId });
        await closePromise;
        termination.dispose();
        expect(faultController.events.filter((event) => event.type === "terminated" && event.terminalId === terminalId)).toHaveLength(1);
        const acceptedBytes = latestCompleteCheckpointBytes(capture, terminalId, processedFrameLimit);
        await assertAcceptedCheckpoint(browser, baseURL, terminalId, acceptedBytes, candidate.checkpoint.snapshot, deviceScaleFactor);
      }
    }
  } finally {
    browserErrors.dispose();
    capture.dispose();
  }
});
