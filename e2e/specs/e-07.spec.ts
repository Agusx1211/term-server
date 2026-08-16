import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultDisposer, NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 600_000;
const FIXED_VIEWPORT = { width: 1_280, height: 800 } as const;
const TERMINAL_INPUT_BYTES = 64 * 1024;
const TERMINAL_FRAME_HEADER_BYTES = 9;
const TERMINAL_FRAME_PAYLOAD_BYTES = 60 * 1024;
const TERMINAL_CHECKPOINT_CHUNK_BYTES = 32 * 1024;
const MIN_CHECKPOINT_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_DEBUG_RECORDING_BYTES = 64 * 1024 * 1024;
const MAX_FRONTEND_RECORDING_EVENTS = 50_000;
const BURST_LINE_WIDTH = 256;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type JsonObject = Record<string, unknown>;

type CreatedTerminal = {
  readonly id: string;
  readonly name: string;
};

type RecordingEvent = {
  readonly terminal?: string;
  readonly type?: string;
  readonly data?: string;
  readonly message?: unknown;
};

type RecordingStatus = {
  readonly active: boolean;
  readonly events: number;
  readonly bytes: number;
  readonly truncated: boolean;
};

type RecordingExport = {
  readonly truncated: boolean;
  readonly events: readonly RecordingEvent[];
};

type RawInputMode = "accepted" | "oversized";

type RawInputOutcome = {
  readonly mode: RawInputMode;
  readonly sentBytes: number;
  readonly pongs: number;
  readonly errors: readonly string[];
  readonly closeCode: number;
  readonly closeReason: string;
};

type RawSnapshotFrame = {
  readonly kind: number;
  readonly sequence: number;
  readonly bytes: number;
  readonly payloadBytes: number;
};

type RawSnapshotOutcome = {
  readonly readyCheckpointBytes: number;
  readonly syncMode?: string;
  readonly syncSequence?: number;
  readonly syncedSequence?: number;
  readonly frames: readonly RawSnapshotFrame[];
  readonly closeCode: number;
  readonly closeReason: string;
};

type RawCheckpointError = {
  readonly phase: "exact" | "oversized";
  readonly message: string;
};

type RawCheckpointOutcome = {
  readonly readyCheckpointBytes: number;
  readonly exactChunks: number;
  readonly oversizedChunks: number;
  readonly exactPongs: number;
  readonly oversizedPongs: number;
  readonly errors: readonly RawCheckpointError[];
  readonly closeCode: number;
  readonly closeReason: string;
};

function marker(operation: string, ...fields: readonly string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function countOccurrences(text: string, needle: string): number {
  const comparable = text.replaceAll("\n", "");
  let count = 0;
  let offset = 0;
  while ((offset = comparable.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += Math.max(needle.length, 1);
  }
  return count;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function transcriptSequence(entry: TranscriptEntry): number {
  return typeof entry.sequence === "number" && Number.isSafeInteger(entry.sequence) ? entry.sequence : 0;
}

function unexpectedBrowserErrors(entries: readonly { kind: string; message: string }[]): readonly unknown[] {
  return entries.filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
}

function recordingMessage(event: RecordingEvent): JsonObject | undefined {
  if (event.type !== "control" || typeof event.message !== "object" || event.message === null || Array.isArray(event.message)) return undefined;
  return event.message as JsonObject;
}

function recordedBytes(event: RecordingEvent): number | undefined {
  if (typeof event.data !== "string") return undefined;
  return Buffer.from(event.data, "base64").length;
}

async function createFixtureTerminal(
  page: Page,
  terminalPath: string,
  shell: string,
): Promise<CreatedTerminal> {
  return page.evaluate(async ({ path, fixtureShell }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, cwd: "/tmp", shell: fixtureShell }),
    });
    if (!response.ok) throw new Error(`terminal creation failed with HTTP ${response.status}`);
    const value = await response.json() as { id?: unknown; name?: unknown };
    if (typeof value.id !== "string" || typeof value.name !== "string") throw new Error("terminal creation response omitted terminal identity");
    return { id: value.id, name: value.name };
  }, { path: terminalPath, fixtureShell: shell });
}

async function recordingControl(page: Page, action: "clear" | "start" | "stop"): Promise<RecordingStatus> {
  return page.evaluate(async (requestedAction) => {
    const response = await fetch("/api/debug/recording", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: requestedAction }),
    });
    if (!response.ok) throw new Error(`debug recording ${requestedAction} failed with HTTP ${response.status}`);
    return await response.json() as RecordingStatus;
  }, action);
}

async function recordingStatus(page: Page): Promise<RecordingStatus> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`debug recording status failed with HTTP ${response.status}`);
    return await response.json() as RecordingStatus;
  });
}

async function recordingExport(page: Page): Promise<RecordingExport> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`debug recording export failed with HTTP ${response.status}`);
    const value = await response.json() as { truncated?: unknown; events?: unknown };
    if (typeof value.truncated !== "boolean" || !Array.isArray(value.events)) throw new Error("debug recording export omitted status or events");
    return { truncated: value.truncated, events: value.events as RecordingEvent[] };
  });
}

async function browserHeap(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const performanceWithMemory = performance as Performance & {
      memory?: { readonly usedJSHeapSize?: unknown };
    };
    const used = performanceWithMemory.memory?.usedJSHeapSize;
    return typeof used === "number" && Number.isFinite(used) ? used : undefined;
  });
}

async function waitForTranscriptEntry(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: TranscriptEntry) => boolean,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(
    terminalId,
    (entry) => predicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

async function waitForTranscriptAfter(
  server: IsolatedServer,
  terminalId: string,
  sequenceFloor: number,
  predicate: (entry: TranscriptEntry) => boolean,
): Promise<TranscriptEntry> {
  return waitForTranscriptEntry(server, terminalId, (entry) => transcriptSequence(entry) > sequenceFloor && predicate(entry));
}

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  minimumSequence: number,
  expectedText: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimum, expected, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence !== undefined
      && snapshot.receivedSequence >= minimum
      && snapshot.committedSequence === snapshot.receivedSequence
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && (snapshot.syncTarget === undefined || snapshot.committedSequence >= snapshot.syncTarget)
      && snapshot.xterm.text.replaceAll("\n", "").includes(expected)
    ), { timeout });
  }, { id: terminalId, minimum: minimumSequence, expected: expectedText, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function rawInput(
  page: Page,
  terminalId: string,
  size: number,
  mode: RawInputMode,
): Promise<RawInputOutcome> {
  return page.evaluate(async ({ id, size, mode, timeout }) => {
    const url = new URL(`/api/terminals/${id}/socket`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("stream", "3");
    const socket = new WebSocket(url.toString());
    const errors: string[] = [];
    let settled = false;
    let closeRequested = false;
    let sent = false;
    let pongs = 0;
    let timer = 0;

    return await new Promise<RawInputOutcome>((resolve, reject) => {
      const finish = (event: CloseEvent): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (mode === "accepted" && pongs === 0) {
          reject(new Error(`exact input socket closed before pong: ${event.code} ${event.reason}`));
          return;
        }
        resolve({
          mode,
          sentBytes: sent ? size : 0,
          pongs,
          errors,
          closeCode: event.code,
          closeReason: event.reason,
        });
      };
      timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error(`timed out waiting for ${mode} input boundary`));
      }, timeout);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("close", finish);
      socket.addEventListener("error", () => {
        if (settled || closeRequested) return;
        errors.push("WebSocket transport error");
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let value: { type?: unknown; message?: unknown };
        try {
          value = JSON.parse(event.data) as typeof value;
        } catch {
          return;
        }
        if (value.type === "error" && typeof value.message === "string") {
          errors.push(value.message);
          if (mode === "oversized" && !closeRequested) {
            closeRequested = true;
            socket.close(1000, "E07 oversized input rejected");
          }
          return;
        }
        if (value.type !== "synced" || sent) {
          if (value.type === "pong") pongs += 1;
          if (mode === "accepted" && value.type === "pong" && pongs === 1) {
            closeRequested = true;
            socket.close(1000, "E07 exact input boundary complete");
          }
          return;
        }
        sent = true;
        const payload = new Uint8Array(size);
        payload.fill(0x41);
        socket.send(payload);
        if (mode === "accepted") {
          socket.send(new Uint8Array([0x0a]));
          socket.send(JSON.stringify({ type: "ping" }));
        }
      });
    });
  }, { id: terminalId, size, mode, timeout: WAIT_TIMEOUT_MS });
}

async function probeSnapshot(
  page: Page,
  terminalId: string,
  sequence: number,
  epoch: number,
): Promise<RawSnapshotOutcome> {
  return page.evaluate(async ({ id, sequence, epoch, timeout, frameHeaderBytes }) => {
    const url = new URL(`/api/terminals/${id}/socket`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("stream", "3");
    url.searchParams.set("sequence", String(sequence));
    url.searchParams.set("epoch", String(epoch));
    url.searchParams.set("observer", "true");
    const socket = new WebSocket(url.toString());
    socket.binaryType = "arraybuffer";
    const frames: RawSnapshotFrame[] = [];
    let readyCheckpointBytes = 0;
    let syncMode: string | undefined;
    let syncSequence: number | undefined;
    let syncedSequence: number | undefined;
    let synced = false;
    let settled = false;
    let timer = 0;

    return await new Promise<RawSnapshotOutcome>((resolve, reject) => {
      const finish = (event: CloseEvent): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (!synced) {
          reject(new Error(`snapshot probe closed before synced: ${event.code} ${event.reason}`));
          return;
        }
        resolve({ readyCheckpointBytes, syncMode, syncSequence, syncedSequence, frames, closeCode: event.code, closeReason: event.reason });
      };
      timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error("timed out waiting for raw snapshot probe"));
      }, timeout);
      socket.addEventListener("close", finish);
      socket.addEventListener("error", () => {
        if (!settled) reject(new Error("raw snapshot probe transport error"));
      });
      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          if (bytes.length < 9) throw new Error("snapshot probe received a short terminal frame");
          const frameSequence = Number(new DataView(bytes.buffer, bytes.byteOffset + 1, 8).getBigUint64(0));
          frames.push({
            kind: bytes[0] ?? 255,
            sequence: frameSequence,
            bytes: bytes.length,
            payloadBytes: bytes.length - frameHeaderBytes,
          });
          return;
        }
        if (typeof event.data !== "string") return;
        let value: { type?: unknown; checkpointBytes?: unknown; mode?: unknown; sequence?: unknown };
        try {
          value = JSON.parse(event.data) as typeof value;
        } catch {
          return;
        }
        if (value.type === "ready" && typeof value.checkpointBytes === "number") readyCheckpointBytes = value.checkpointBytes;
        if (value.type === "sync") {
          if (typeof value.mode === "string") syncMode = value.mode;
          if (typeof value.sequence === "number") syncSequence = value.sequence;
        }
        if (value.type === "synced") {
          synced = true;
          if (typeof value.sequence === "number") syncedSequence = value.sequence;
          socket.close(1000, "E07 snapshot probe complete");
        }
      });
    });
  }, { id: terminalId, sequence, epoch, timeout: WAIT_TIMEOUT_MS, frameHeaderBytes: TERMINAL_FRAME_HEADER_BYTES });
}

async function runRawCheckpoint(
  page: Page,
  terminalId: string,
  sequence: number,
  epoch: number,
): Promise<RawCheckpointOutcome> {
  return page.evaluate(async ({ id, sequence, epoch, timeout }) => {
    const url = new URL(`/api/terminals/${id}/socket`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("stream", "3");
    url.searchParams.set("sequence", String(sequence));
    url.searchParams.set("epoch", String(epoch));
    const socket = new WebSocket(url.toString());
    socket.binaryType = "arraybuffer";
    let readyCheckpointBytes = 0;
    let settled = false;
    let synced = false;
    let phase: "exact" | "oversized" = "exact";
    let exactChunks = 0;
    let oversizedChunks = 0;
    let oversizedPongs = 0;
    let exactPongs = 0;
    let timer = 0;
    const errors: RawCheckpointError[] = [];

    const toBase64 = (bytes: Uint8Array): string => {
      let text = "";
      for (const byte of bytes) text += String.fromCharCode(byte);
      return btoa(text);
    };
    const sendChunks = (total: number): number => {
      let offset = 0;
      let chunks = 0;
      while (offset < total) {
        const length = Math.min(32 * 1024, total - offset);
        const data = new Uint8Array(length);
        data.fill(0x41);
        socket.send(JSON.stringify({
          type: "checkpoint",
          sequence,
          epoch,
          offset,
          data: toBase64(data),
          final: offset + length === total,
        }));
        offset += length;
        chunks += 1;
      }
      return chunks;
    };

    return await new Promise<RawCheckpointOutcome>((resolve, reject) => {
      const finish = (event: CloseEvent): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (!synced || exactPongs < 1 || oversizedPongs < 1) {
          reject(new Error(`checkpoint boundary socket closed before both barriers: ${event.code} ${event.reason}`));
          return;
        }
        resolve({ readyCheckpointBytes, exactChunks, oversizedChunks, exactPongs, oversizedPongs, errors, closeCode: event.code, closeReason: event.reason });
      };
      timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error("timed out waiting for raw checkpoint boundaries"));
      }, timeout);
      socket.addEventListener("close", finish);
      socket.addEventListener("error", () => {
        if (!settled) reject(new Error("raw checkpoint boundary transport error"));
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let value: { type?: unknown; checkpointBytes?: unknown; message?: unknown };
        try {
          value = JSON.parse(event.data) as typeof value;
        } catch {
          return;
        }
        if (value.type === "ready" && typeof value.checkpointBytes === "number") {
          readyCheckpointBytes = value.checkpointBytes;
          return;
        }
        if (value.type === "error" && typeof value.message === "string") {
          errors.push({ phase, message: value.message });
          return;
        }
        if (value.type === "synced") {
          if (synced) return;
          synced = true;
          if (readyCheckpointBytes <= 0) {
            settled = true;
            window.clearTimeout(timer);
            socket.close();
            reject(new Error("checkpoint boundary socket omitted checkpoint limit"));
            return;
          }
          exactChunks = sendChunks(readyCheckpointBytes);
          socket.send(JSON.stringify({ type: "ping" }));
          return;
        }
        if (value.type !== "pong") return;
        if (phase === "exact") {
          exactPongs += 1;
          phase = "oversized";
          oversizedChunks = sendChunks(readyCheckpointBytes + 1);
          socket.send(JSON.stringify({ type: "ping" }));
        } else {
          oversizedPongs += 1;
          socket.close(1000, "E07 checkpoint boundary complete");
        }
      });
    });
  }, { id: terminalId, sequence, epoch, timeout: WAIT_TIMEOUT_MS });
}

/**
 * Matches the legacy JSON `{type:"checkpoint"}` frames that runRawCheckpoint
 * deliberately sends over its own raw websocket (the server still accepts the
 * old format). The live browser pane now uploads checkpoints as a
 * `checkpointBinary` announcement plus binary frames, so it can never
 * contribute matches here.
 */
function legacyCheckpointFramesSince(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  floor: number,
): readonly NetworkFaultEvent[] {
  return events.slice(floor).filter((event) => (
    event.terminalId === terminalId
    && event.type === "frame"
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpoint"
  ));
}

test.setTimeout(TEST_TIMEOUT_MS);

test("E-07 Oversized messages and resource bounds @nightly @resource-bounds @e", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let recordingActive = false;
  let outputThrottle: NetworkFaultDisposer | undefined;
  const runTag = `E07-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const terminalPath = `e07-${runTag}`;
  const readyId = `${runTag}-READY`;
  const oversizedInputId = `${runTag}-OVERSIZED-INPUT`;
  const echoId = `${runTag}-CONTINUED-ECHO`;
  const echoText = `${runTag}-CONTINUED-INPUT`;
  const holdToken = `${runTag}-HOLD`;
  const burstId = `${runTag}-BURST`;
  const printId = `${runTag}-SNAPSHOT-MARKER`;
  const printText = `${runTag}-SNAPSHOT-MARKER`;
  const finalEchoId = `${runTag}-FINAL-ECHO`;
  const finalEchoText = `${runTag}-FINAL-CONTINUED-INPUT`;
  const readyMarker = marker("READY", readyId);
  const echoMarker = marker("ECHO_INPUT", echoId, Buffer.from(echoText, "utf8").toString("base64"));
  const finalEchoMarker = marker("ECHO_INPUT", finalEchoId, Buffer.from(finalEchoText, "utf8").toString("base64"));
  const printMarker = marker("PRINT", printId, printText);
  try {
    await page.setViewportSize(FIXED_VIEWPORT);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    await recordingControl(page, "clear");

    const created = await createFixtureTerminal(page, terminalPath, server.fixturePath);
    await page.reload();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const pane = await workbench.openTerminal({ id: created.id, name: created.name });
    await pane.expectVisible();
    const initial = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    expect(initial.activeSocketCount).toBe(1);
    expect(initial.acceptingInput).toBe(true);
    await expectTerminalConverged(page, created.id, {
      cols: initial.cols,
      rows: initial.rows,
      pixelWidth: initial.pixelWidth,
      pixelHeight: initial.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });

    await pane.sendInput(`READY ${readyId}`, true);
    await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "ready" && entry.id === readyId);
    await expectTerminalBuffer(page, created.id, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const readySnapshot = await waitForSettledTerminal(
      page,
      created.id,
      (initial.committedSequence ?? 0) + Buffer.byteLength(`${readyMarker}\n`, "utf8"),
      readyMarker,
    );
    const readyEpoch = requiredNumber(readySnapshot.gridEpoch, "initial grid epoch");
    const readyLimitProbe = await probeSnapshot(page, created.id, readySnapshot.committedSequence ?? 0, readyEpoch);
    const checkpointLimit = requiredNumber(readyLimitProbe.readyCheckpointBytes, "ready checkpointBytes");
    expect(checkpointLimit).toBeGreaterThanOrEqual(MIN_CHECKPOINT_BYTES);
    expect(checkpointLimit).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);

    await recordingControl(page, "clear");
    const exactRecordingStart = await recordingControl(page, "start");
    expect(exactRecordingStart.active).toBe(true);
    recordingActive = true;
    const exactFloor = (await server.readTranscript(created.id)).reduce((maximum, entry) => Math.max(maximum, transcriptSequence(entry)), 0);
    const exactInput = await rawInput(page, created.id, TERMINAL_INPUT_BYTES, "accepted");
    expect(exactInput.sentBytes).toBe(TERMINAL_INPUT_BYTES);
    expect(exactInput.pongs).toBeGreaterThanOrEqual(1);
    expect(exactInput.errors).toEqual([]);
    await waitForTranscriptAfter(server, created.id, exactFloor, (entry) => entry.event === "error");
    const exactRecordingStatus = await recordingControl(page, "stop");
    recordingActive = false;
    expect(exactRecordingStatus.truncated).toBe(false);
    expect(exactRecordingStatus.bytes).toBeLessThanOrEqual(MAX_DEBUG_RECORDING_BYTES);
    const exactRecording = await recordingExport(page);
    const exactInputEvents = exactRecording.events.filter((event) => event.terminal === created.id && event.type === "input");
    expect(exactInputEvents.map(recordedBytes)).toContain(TERMINAL_INPUT_BYTES);
    expect(exactInputEvents.some((event) => (recordedBytes(event) ?? 0) > TERMINAL_INPUT_BYTES)).toBe(false);

    await recordingControl(page, "clear");
    const oversizedRecordingStart = await recordingControl(page, "start");
    expect(oversizedRecordingStart.active).toBe(true);
    recordingActive = true;
    const oversizedInput = await rawInput(page, created.id, TERMINAL_INPUT_BYTES + 1, "oversized");
    const explicitOversizedInputError = oversizedInput.errors.some((message) => /64\s*KiB|message limit|too large/i.test(message));
    expect(oversizedInput.closeCode !== 1000 || explicitOversizedInputError).toBe(true);
    const oversizedRecordingStatus = await recordingControl(page, "stop");
    recordingActive = false;
    expect(oversizedRecordingStatus.bytes).toBeLessThanOrEqual(MAX_DEBUG_RECORDING_BYTES);
    const oversizedRecording = await recordingExport(page);
    const oversizedInputEvents = oversizedRecording.events.filter((event) => event.terminal === created.id && event.type === "input");
    expect(oversizedInputEvents.some((event) => (recordedBytes(event) ?? 0) > TERMINAL_INPUT_BYTES)).toBe(false);
    const afterOversizedTranscript = await server.readTranscript(created.id);
    expect(afterOversizedTranscript.some((entry) => entry.event === "echo_input" && entry.id === oversizedInputId)).toBe(false);

    const beforeEchoPixels = await screenshotRegion(page, pane.xtermHost);
    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed");
    await pane.sendInput(echoText, true);
    await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload");
    await expectTerminalBuffer(page, created.id, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectKnownMarkerChanged(page, pane.xtermHost, beforeEchoPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: `${runTag}-continued-input-pixels`,
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: `${runTag}-continued-input-nonblank`,
    });
    const afterEcho = await waitForSettledTerminal(page, created.id, readySnapshot.committedSequence ?? 0, echoMarker);
    expect(afterEcho.activeSocketCount).toBe(1);

    await recordingControl(page, "clear");
    const debugSettings = await workbench.openSettings();
    await debugSettings.startRecording();
    await workbench.showTerminals();
    const debugRecordingStart = await recordingStatus(page);
    expect(debugRecordingStart.active).toBe(true);
    recordingActive = true;
    const beforeBurst = await terminalSnapshot(page, created.id);
    if (!beforeBurst) throw new Error("diagnostics snapshot missing before oversized output");
    const beforeHeap = await browserHeap(page);
    const snapshotBurstBytes = checkpointLimit * 16 + 256 * 1024;
    const burstBytes = Math.max(snapshotBurstBytes, MAX_DEBUG_RECORDING_BYTES + 256 * 1024);
    const beforeBurstPixels = await screenshotRegion(page, pane.xtermHost);
    outputThrottle = faultController.throttle("server-to-browser", 8 * 1024 * 1024, { terminalId: created.id });
    const burstFloor = (await server.readTranscript(created.id)).reduce((maximum, entry) => Math.max(maximum, transcriptSequence(entry)), 0);
    await pane.sendInput(`HOLD ${holdToken}`, true);
    await waitForTranscriptAfter(server, created.id, burstFloor, (entry) => entry.event === "hold" && entry.token === holdToken);
    const burstCommandFloor = (await server.readTranscript(created.id)).reduce((maximum, entry) => Math.max(maximum, transcriptSequence(entry)), 0);
    await pane.sendInput(`BURST ${burstId} ${burstBytes} ${BURST_LINE_WIDTH}`, true);
    await waitForTranscriptAfter(server, created.id, burstCommandFloor, (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === burstBytes);
    await pane.sendInput(`RELEASE ${holdToken}`, true);
    await workbench.openSettings();
    await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "release" && entry.token === holdToken);
    await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "write" && entry.bytes === burstBytes);
    const printFloor = (await server.readTranscript(created.id)).reduce((maximum, entry) => Math.max(maximum, transcriptSequence(entry)), 0);
    await pane.sendInput(`PRINT ${printId} ${printText}`, true);
    await waitForTranscriptAfter(server, created.id, printFloor, (entry) => entry.event === "print" && entry.id === printId);
    await waitForTranscriptAfter(server, created.id, printFloor, (entry) => entry.event === "write" && entry.bytes === Buffer.byteLength(`${printMarker}\n`, "utf8"));
    outputThrottle.dispose();
    outputThrottle = undefined;
    await workbench.showTerminals();
    await pane.expectVisible();
    const expectedOutputSequence = (beforeBurst.receivedSequence ?? beforeBurst.committedSequence ?? 0)
      + burstBytes
    const settledBurst = await waitForSettledTerminal(page, created.id, expectedOutputSequence, printMarker);
    const settledBurstText = settledBurst.xterm.text.replaceAll("\n", "");
    expect(settledBurstText).toContain(printMarker);
    expect(countOccurrences(settledBurstText, printMarker)).toBe(1);
    await expectKnownMarkerChanged(page, pane.xtermHost, beforeBurstPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: `${runTag}-oversized-output-pixels`,
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: `${runTag}-oversized-output-nonblank`,
    });

    const staleSnapshot = await probeSnapshot(page, created.id, 0, 0);
    expect(staleSnapshot.syncMode).toBe("snapshot");
    expect(staleSnapshot.frames.length).toBeGreaterThan(0);
    expect(staleSnapshot.frames.every((frame) => frame.kind === 0)).toBe(true);
    expect(staleSnapshot.frames.every((frame) => frame.bytes <= TERMINAL_FRAME_HEADER_BYTES + TERMINAL_FRAME_PAYLOAD_BYTES)).toBe(true);
    const snapshotBytes = staleSnapshot.frames.reduce((total, frame) => total + frame.payloadBytes, 0);
    expect(snapshotBytes).toBeGreaterThan(0);
    const replayBound = checkpointLimit < MAX_CHECKPOINT_BYTES ? checkpointLimit * 16 : MAX_CHECKPOINT_BYTES * 16;
    expect(snapshotBytes).toBeLessThanOrEqual(replayBound);
    const recordingSettings = await workbench.openSettings();
    await recordingSettings.stopRecording();
    await expect(recordingSettings.root.getByText("Not recording", { exact: true })).toBeVisible();
    const debugRecordingStatus = await recordingStatus(page);
    recordingActive = false;
    expect(debugRecordingStatus.truncated).toBe(true);
    expect(debugRecordingStatus.bytes).toBe(MAX_DEBUG_RECORDING_BYTES);
    expect(debugRecordingStatus.events).toBeGreaterThan(0);
    const debugRecording = await recordingExport(page);
    expect(debugRecording.truncated).toBe(true);
    const truncationMessage = debugRecording.events
      .map(recordingMessage)
      .find((message) => message?.type === "recording" && message.event === "truncated");
    expect(truncationMessage?.max_bytes).toBe(MAX_DEBUG_RECORDING_BYTES);
    for (const event of debugRecording.events) {
      const bytes = recordedBytes(event);
      if (bytes !== undefined) expect(bytes).toBeLessThanOrEqual(MAX_DEBUG_RECORDING_BYTES);
    }
    const browserEventCount = /Browser:\s*(\d+) events/.exec(await recordingSettings.root.innerText())?.[1];
    if (browserEventCount === undefined) throw new Error("debug recording settings omitted browser event count");
    expect(Number(browserEventCount)).toBeLessThanOrEqual(MAX_FRONTEND_RECORDING_EVENTS);
    await workbench.showTerminals();

    const current = await terminalSnapshot(page, created.id);
    if (!current) throw new Error("diagnostics snapshot missing before checkpoint boundary");
    const checkpointSequence = requiredNumber(current.committedSequence, "checkpoint sequence");
    const checkpointEpoch = requiredNumber(current.gridEpoch, "checkpoint epoch");
    await recordingControl(page, "clear");
    const checkpointRecordingStart = await recordingControl(page, "start");
    expect(checkpointRecordingStart.active).toBe(true);
    recordingActive = true;
    const checkpointFrameFloor = faultController.events.length;
    const checkpointOutcome = await runRawCheckpoint(page, created.id, checkpointSequence, checkpointEpoch);
    expect(checkpointOutcome.readyCheckpointBytes).toBe(checkpointLimit);
    expect(checkpointOutcome.readyCheckpointBytes).toBeGreaterThanOrEqual(MIN_CHECKPOINT_BYTES);
    expect(checkpointOutcome.readyCheckpointBytes).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
    expect(checkpointOutcome.exactChunks).toBe(Math.ceil(checkpointLimit / TERMINAL_CHECKPOINT_CHUNK_BYTES));
    expect(checkpointOutcome.oversizedChunks).toBe(Math.ceil((checkpointLimit + 1) / TERMINAL_CHECKPOINT_CHUNK_BYTES));
    expect(checkpointOutcome.exactPongs).toBeGreaterThanOrEqual(1);
    expect(checkpointOutcome.oversizedPongs).toBeGreaterThanOrEqual(1);
    expect(checkpointOutcome.errors.filter((error) => error.phase === "exact")).toEqual([]);
    expect(checkpointOutcome.errors.some((error) => error.phase === "oversized" && /replay limit|message limit/i.test(error.message))).toBe(true);
    const checkpointFrames = legacyCheckpointFramesSince(faultController.events, created.id, checkpointFrameFloor);
    expect(checkpointFrames.length).toBe(checkpointOutcome.exactChunks + checkpointOutcome.oversizedChunks);
    expect(checkpointFrames.every((event) => (event.bytes ?? 0) <= 64 * 1024)).toBe(true);
    const checkpointRecordingStatus = await recordingControl(page, "stop");
    recordingActive = false;
    expect(checkpointRecordingStatus.truncated).toBe(false);
    expect(checkpointRecordingStatus.bytes).toBeLessThanOrEqual(MAX_DEBUG_RECORDING_BYTES);
    const checkpointRecording = await recordingExport(page);
    const storedCheckpointNotes = checkpointRecording.events
      .map(recordingMessage)
      .filter((message) => message?.type === "recording" && message.event === "xterm checkpoint stored");
    expect(storedCheckpointNotes).toHaveLength(1);
    const checkpointErrors = checkpointRecording.events
      .map(recordingMessage)
      .filter((message): message is JsonObject => (
        message?.type === "error" && typeof message.message === "string"
      ))
      .map((message) => String(message.message));
    expect(checkpointErrors.some((message) => /replay limit|message limit/i.test(message))).toBe(true);

    const beforeFinalPixels = await screenshotRegion(page, pane.xtermHost);
    await pane.sendInput(`ECHO_INPUT ${finalEchoId}`, true);
    await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "echo_input" && entry.id === finalEchoId && entry.phase === "armed");
    await pane.sendInput(finalEchoText, true);
    await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "echo_input" && entry.id === finalEchoId && entry.phase === "payload");
    const final = await waitForSettledTerminal(page, created.id, requiredNumber((await terminalSnapshot(page, created.id))?.committedSequence, "final sequence"), finalEchoMarker);
    expect(final.socketState).toBe("connected");
    expect(final.activeSocketCount).toBe(1);
    expect(final.acceptingInput).toBe(true);
    expect(final.pendingParserBytes).toBe(0);
    expect(final.renderBacklogBytes).toBe(0);
    expect(final.renderBacklogFrames).toBe(0);
    expect(final.checkpointSize).toBeLessThanOrEqual(checkpointLimit);
    expect(final.checkpointSize).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
    await expectTerminalBuffer(page, created.id, { contains: finalEchoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectKnownMarkerChanged(page, pane.xtermHost, beforeFinalPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: `${runTag}-final-input-pixels`,
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: `${runTag}-final-nonblank`,
    });
    const finalHeap = await browserHeap(page);
    if (beforeHeap !== undefined && finalHeap !== undefined) {
      expect(finalHeap).toBeGreaterThan(0);
      expect(finalHeap).toBeLessThan(512 * 1024 * 1024);
    }
    const finalEvents = await terminalEvents(page, created.id);
    await assertMonotonicSequences(finalEvents);
    expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
    await expectNoPendingRecovery(page, created.id, { timeout: WAIT_TIMEOUT_MS });
    assertNoPendingSynchronization(final);
    await expectConnectedTerminalInvariants(page, created.id, { timeout: WAIT_TIMEOUT_MS });
    const finalTranscript = await server.readTranscript(created.id);
    const finalPayloads = finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === finalEchoId && entry.phase === "payload");
    expect(finalPayloads).toHaveLength(1);
    expect((finalPayloads[0]?.payload_base64 as string | undefined)).toBe(Buffer.from(finalEchoText, "utf8").toString("base64"));
    expect(unexpectedBrowserErrors(browserErrors())).toEqual([]);
  } finally {
    outputThrottle?.dispose();
    if (recordingActive) {
      try {
        await recordingControl(page, "stop");
      } catch {
        // Preserve the scenario's original failure while releasing recording state.
      }
    }
    browserErrors.dispose();
  }
});
