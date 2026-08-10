import { expect, test } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import {
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";

const WAIT_TIMEOUT_MS = 45_000;
const CHECKPOINT_CHUNK_BYTES = 32 * 1024;
const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TranscriptEntry = Record<string, unknown>;
type RawCheckpointCase =
  | "incomplete"
  | "invalid-base64"
  | "missing-offset"
  | "duplicate-offset"
  | "out-of-order-offset"
  | "oversized-chunk"
  | "aggregate-oversized"
  | "wrong-epoch"
  | "unbridgeable-sequence";

interface RawCheckpointOutcome {
  readonly url: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly readyCheckpointBytes: number;
  readonly sentSequence: number;
  readonly sentCheckpointCount: number;
  readonly errors: readonly string[];
  readonly pongs: number;
  readonly closeCode: number;
  readonly closeReason: string;
}

interface RawSnapshotOutcome {
  readonly url: string;
  readonly readyCheckpointBytes: number;
  readonly syncMode?: string;
  readonly snapshotText: string;
  readonly snapshotBytes: number;
  readonly errors: readonly string[];
  readonly closeCode: number;
}

interface TerminalApiInfo {
  readonly id: string;
  readonly pid: number | null;
  readonly status: string;
}

interface K14Case {
  readonly kind: RawCheckpointCase;
  readonly errors: readonly string[];
}

function markerOccurrences(text: string, marker: string): number {
  const logicalText = text.replaceAll("\n", "");
  let count = 0;
  let offset = 0;
  while ((offset = logicalText.indexOf(marker, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, marker.length);
  }
  return count;
}

function commandCount(entries: readonly TranscriptEntry[], command: string): number {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return entries.filter((entry) => entry.event === "command" && entry.command_base64 === encoded).length;
}

function outputByteCount(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.event !== "write") return total;
    const bytes = entry.bytes;
    return total + (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0);
  }, 0);
}

function checkpointFrames(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  sequence: number,
  after: number,
): readonly NetworkFaultEvent[] {
  return events.filter((event) => (
    event.at >= after
    && event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpoint"
    && event.frame.sequence === sequence
  ));
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} was not found in the server listing`);
    return terminal;
  }, terminalId);
}

async function latestEventId(page: Page, terminalId: string): Promise<number> {
  const events = await terminalEvents(page, terminalId);
  return events.at(-1)?.id ?? 0;
}

async function waitForSentCheckpoint(
  page: Page,
  terminalId: string,
  afterId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, afterId, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > afterId
        && event.type === "checkpoint"
        && event.data.result === "sent",
      { timeout },
    );
  }, { id: terminalId, afterId, timeout: WAIT_TIMEOUT_MS });
}

async function forceReconnect(
  page: Page,
  terminalId: string,
  before: E2ETerminalSnapshot,
): Promise<E2ETerminalSnapshot> {
  const afterId = await latestEventId(page, terminalId);
  const closePromise = page.evaluate(async ({ id, afterId, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > afterId
        && event.type === "socket-close"
        && event.data.generation === generation,
      { timeout },
    );
  }, { id: terminalId, afterId, generation: before.socketGeneration, timeout: WAIT_TIMEOUT_MS });
  const syncPromise = page.evaluate(async ({ id, afterId, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > afterId
        && event.type === "sync"
        && event.snapshot.socketGeneration > generation
        && (event.data.mode === "resume" || event.data.mode === "snapshot"),
      { timeout },
    );
  }, { id: terminalId, afterId, generation: before.socketGeneration, timeout: WAIT_TIMEOUT_MS });
  const syncedPromise = page.evaluate(async ({ id, afterId, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > afterId
        && event.type === "synced"
        && event.snapshot.socketGeneration > generation,
      { timeout },
    );
  }, { id: terminalId, afterId, generation: before.socketGeneration, timeout: WAIT_TIMEOUT_MS });

  await page.evaluate(({ id, generation }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.close(id, {
      generation,
      code: 1000,
      reason: "K14 malformed checkpoint recovery",
    });
  }, { id: terminalId, generation: before.socketGeneration });

  const [closed, sync, synced] = await Promise.all([closePromise, syncPromise, syncedPromise]);
  expect(closed.data.generation).toBe(before.socketGeneration);
  expect(sync.snapshot.socketGeneration).toBe(before.socketGeneration + 1);
  expect(["resume", "snapshot"]).toContain(sync.data.mode);
  expect(synced.snapshot.socketGeneration).toBe(before.socketGeneration + 1);

  const recovered = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    activeSocketCount: 1,
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(recovered.socketGeneration).toBe(before.socketGeneration + 1);
  expect(recovered.syncMode).toBeUndefined();
  return recovered;
}

async function runRawCheckpointCase(
  page: Page,
  terminalId: string,
  sequence: number,
  epoch: number,
  kind: RawCheckpointCase,
): Promise<RawCheckpointOutcome> {
  return page.evaluate(async ({ id, sequence, epoch, kind, timeout, chunkBytes, maxSafeSequence }) => {
    const url = new URL(`/api/terminals/${id}/socket`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("stream", "3");
    const socket = new WebSocket(url.toString());
    socket.binaryType = "arraybuffer";
    const startedAt = Date.now();

    return new Promise<RawCheckpointOutcome>((resolve, reject) => {
      let settled = false;
      let closeRequested = false;
      let sent = false;
      let pongs = 0;
      let readyCheckpointBytes = 0;
      let sentSequence = sequence;
      let sentCheckpointCount = 0;
      const errors: string[] = [];
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error(`timed out waiting for raw checkpoint case ${kind}`));
      }, timeout);

      const finish = (event: CloseEvent): void => {
        if (settled) return;
        if (!closeRequested) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error(`raw checkpoint socket closed before its ping: ${event.code} ${event.reason}`));
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        resolve({
          url: url.toString(),
          startedAt,
          finishedAt: Date.now(),
          readyCheckpointBytes,
          sentSequence,
          sentCheckpointCount,
          errors,
          pongs,
          closeCode: event.code,
          closeReason: event.reason,
        });
      };

      const chunk = (
        chunkSequence: number,
        chunkEpoch: number,
        offset: number,
        bytes: number,
        finalChunk: boolean,
        data = btoa("A".repeat(bytes)),
      ) => ({
        type: "checkpoint",
        sequence: chunkSequence,
        epoch: chunkEpoch,
        offset,
        data,
        final: finalChunk,
      });

      const buildMessages = (): Array<Record<string, unknown>> => {
        const messages: Array<Record<string, unknown>> = [];
        switch (kind) {
          case "incomplete":
            messages.push(chunk(sequence, epoch, 0, 1, false));
            break;
          case "invalid-base64":
            messages.push(chunk(sequence, epoch, 0, 1, true, "!!!"));
            break;
          case "missing-offset":
            messages.push(chunk(sequence, epoch, 0, 1, false));
            messages.push(chunk(sequence, epoch, 2, 1, true));
            break;
          case "duplicate-offset":
            messages.push(chunk(sequence, epoch, 0, 1, false));
            messages.push(chunk(sequence, epoch, 0, 1, true, btoa("B")));
            break;
          case "out-of-order-offset":
            messages.push(chunk(sequence, epoch, 0, 1, false));
            messages.push(chunk(sequence, epoch, 1, 1, false));
            messages.push(chunk(sequence, epoch, 3, 1, true));
            break;
          case "oversized-chunk":
            messages.push(chunk(sequence, epoch, 0, chunkBytes + 1, true));
            break;
          case "aggregate-oversized": {
            let offset = 0;
            while (offset <= readyCheckpointBytes) {
              const bytes = Math.min(chunkBytes, readyCheckpointBytes - offset + 1);
              messages.push(chunk(sequence, epoch, offset, bytes, false));
              offset += bytes;
            }
            const last = messages.at(-1);
            if (!last) throw new Error("aggregate checkpoint did not create any chunks");
            last.final = true;
            break;
          }
          case "wrong-epoch":
            messages.push(chunk(sequence, epoch + 1, 0, 1, true));
            break;
          case "unbridgeable-sequence":
            sentSequence = maxSafeSequence;
            messages.push(chunk(sentSequence, epoch, 0, 1, true));
            break;
        }
        return messages;
      };

      socket.addEventListener("close", finish);
      socket.addEventListener("error", () => {
        if (settled || closeRequested) return;
        settled = true;
        window.clearTimeout(timer);
        reject(new Error(`raw checkpoint socket failed for ${kind}`));
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let value: { type?: unknown; message?: unknown; checkpointBytes?: unknown };
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
          errors.push(value.message);
          return;
        }
        if (value.type !== "synced" || sent) {
          if (value.type === "pong") pongs += 1;
          if (value.type === "pong" && sent && pongs === 1) {
            closeRequested = true;
            socket.close(1000, "K14 checkpoint case complete");
          }
          return;
        }
        if (readyCheckpointBytes <= 0) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error("raw checkpoint socket did not advertise a positive checkpoint bound"));
          return;
        }
        const messages = buildMessages();
        sent = true;
        sentCheckpointCount = messages.length;
        for (const message of messages) socket.send(JSON.stringify(message));
        socket.send(JSON.stringify({ type: "ping" }));
      });
    });
  }, {
    id: terminalId,
    sequence,
    epoch,
    kind,
    timeout: WAIT_TIMEOUT_MS,
    chunkBytes: CHECKPOINT_CHUNK_BYTES,
    maxSafeSequence: MAX_SAFE_SEQUENCE,
  });
}

async function probeRawSnapshot(page: Page, terminalId: string): Promise<RawSnapshotOutcome> {
  return page.evaluate(async ({ id, timeout }) => {
    const url = new URL(`/api/terminals/${id}/socket`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("stream", "3");
    const socket = new WebSocket(url.toString());
    socket.binaryType = "arraybuffer";

    return new Promise<RawSnapshotOutcome>((resolve, reject) => {
      let settled = false;
      let closeRequested = false;
      let readyCheckpointBytes = 0;
      let syncMode: string | undefined;
      let snapshotBytes = 0;
      let snapshotText = "";
      let decoder = new TextDecoder();
      const errors: string[] = [];
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error("timed out waiting for raw snapshot probe"));
      }, timeout);

      socket.addEventListener("close", (event) => {
        if (settled) return;
        if (!closeRequested) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error(`raw snapshot probe closed before sync: ${event.code} ${event.reason}`));
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        resolve({
          url: url.toString(),
          readyCheckpointBytes,
          syncMode,
          snapshotText,
          snapshotBytes,
          errors,
          closeCode: event.code,
        });
      });
      socket.addEventListener("error", () => {
        if (settled || closeRequested) return;
        settled = true;
        window.clearTimeout(timer);
        reject(new Error("raw snapshot probe websocket failed"));
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          let value: { type?: unknown; mode?: unknown; message?: unknown; checkpointBytes?: unknown };
          try {
            value = JSON.parse(event.data) as typeof value;
          } catch {
            return;
          }
          if (value.type === "ready" && typeof value.checkpointBytes === "number") readyCheckpointBytes = value.checkpointBytes;
          if (value.type === "sync" && typeof value.mode === "string") syncMode = value.mode;
          if (value.type === "error" && typeof value.message === "string") errors.push(value.message);
          if (value.type === "synced") {
            snapshotText += decoder.decode();
            closeRequested = true;
            socket.close(1000, "K14 snapshot probe complete");
          }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        const frame = new Uint8Array(event.data);
        if (frame.length < 9 || frame[0] !== 0) return;
        const payload = frame.subarray(9);
        snapshotBytes += payload.length;
        snapshotText += decoder.decode(payload, { stream: true });
      });
    });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

test("K-14 Corrupt and oversized checkpoint @p1 @checkpoint @protocol-failure @bounds @nightly", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  // Keep an unbounded per-test history; faultController.events is a bounded ring.
  const checkpointFrameHistory: NetworkFaultEvent[] = [];
  const checkpointFrameListener = faultController.onEvent((event) => {
    if (
      event.type === "frame"
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "checkpoint"
    ) checkpointFrameHistory.push(event);
  });
  const checkpointFrameCount = (terminalId: string): number => (
    checkpointFrameHistory.filter((event) => event.terminalId === terminalId).length
  );

  try {

  const runTag = `K14-${testInfo.project.name}-w${testInfo.workerIndex}-r${testInfo.retry}-e${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-ready`;
  const baselineId = `${runTag}-baseline`;
  const liveId = `${runTag}-live`;
  const sizeId = `${runTag}-size`;
  const echoId = `${runTag}-echo`;
  const inputText = `${runTag}-continued-input`;
  const readyMarker = `[E2E:READY:${readyId}]`;
  const baselineMarker = `[E2E:PRINT:${baselineId}:baseline]`;
  const liveMarker = `[E2E:PRINT:${liveId}:live]`;
  const echoReadyMarker = `[E2E:ECHO_INPUT:${echoId}:READY]`;
  const echoPayloadMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(inputText, "utf8").toString("base64")}]`;

  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountPromise = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.snapshot.kind === "pane",
      { timeout },
    );
  }, WAIT_TIMEOUT_MS);
  await workbench.createTerminal();
  const mounted = await mountPromise;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();

  const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.socketState).toBe("connected");
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.acceptingInput).toBe(true);
  const terminalInfo = await readTerminal(page, terminalId);
  expect(terminalInfo.id).toBe(terminalId);
  expect(terminalInfo.status).toBe("running");
  if (terminalInfo.pid === null) throw new Error(`terminal ${terminalId} has no process identity`);
  const initialPid = terminalInfo.pid;

  const readyCommand = `READY ${readyId}`;
  await pane.sendInput(readyCommand, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k14-ready-terminal",
  });
  await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k14-ready-terminal-confirmed",
  });

  const beforeBaselinePixels = await screenshotRegion(page, pane.xtermHost);
  const checkpointFloor = await latestEventId(page, terminalId);
  const baselineCommand = `PRINT ${baselineId} baseline`;
  await pane.sendInput(baselineCommand, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === baselineId && entry.text === "baseline",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const baselineEvent = await waitForSentCheckpoint(page, terminalId, checkpointFloor);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k14-baseline-terminal",
  });
  const afterBaselinePixels = await screenshotRegion(page, pane.xtermHost);
  await expectKnownMarkerChanged(page, pane.xtermHost, beforeBaselinePixels, {
    minimumChangedRatio: 0.001,
    testInfo,
    artifactName: "k14-baseline-marker",
  });
  expect(afterBaselinePixels.width).toBe(beforeBaselinePixels.width);
  expect(afterBaselinePixels.height).toBe(beforeBaselinePixels.height);
  await expectTerminalBuffer(page, terminalId, { contains: baselineMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const baselineSequenceValue = baselineEvent.data.sequence;
  const baselineEpochValue = baselineEvent.data.epoch;
  if (typeof baselineSequenceValue !== "number" || !Number.isSafeInteger(baselineSequenceValue) || baselineSequenceValue < 0) {
    throw new Error("baseline checkpoint did not expose a safe sequence");
  }
  if (typeof baselineEpochValue !== "number" || !Number.isSafeInteger(baselineEpochValue) || baselineEpochValue < 0) {
    throw new Error("baseline checkpoint did not expose a safe epoch");
  }
  const baselineSequence = baselineSequenceValue;
  const baselineEpoch = baselineEpochValue;
  const baseline = await terminalSnapshot(page, terminalId);
  if (!baseline) throw new Error(`missing baseline diagnostics for terminal ${terminalId}`);
  expect(baseline.checkpointSequence).toBe(baselineSequence);
  expect(baseline.checkpointEpoch).toBe(baselineEpoch);
  expect(baseline.checkpointSize).toBeGreaterThan(0);
  expect(baseline.checkpointChunks).toBeGreaterThan(0);
  expect(baseline.committedSequence).toBe(baselineSequence);
  expect(baseline.gridEpoch).toBe(baselineEpoch);

  await faultController.waitFor(
    (event) => event.type === "frame"
      && event.terminalId === terminalId
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "checkpoint"
      && event.frame.sequence === baselineSequence,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const baselineProxyFrames = checkpointFrames(faultController.events, terminalId, baselineSequence, 0);
  expect(baselineProxyFrames.length).toBeGreaterThanOrEqual(baseline.checkpointChunks);
  expect(baselineProxyFrames.every((event) => (event.frame?.bytes ?? 0) < 64 * 1024)).toBe(true);

  const baselineProbe = await probeRawSnapshot(page, terminalId);
  expect(baselineProbe.url).toContain("stream=3");
  expect(baselineProbe.syncMode).toBe("snapshot");
  expect(baselineProbe.readyCheckpointBytes).toBeGreaterThanOrEqual(baseline.checkpointSize);
  expect(baselineProbe.snapshotBytes).toBeGreaterThan(0);
  expect(baselineProbe.snapshotText).toContain(baselineMarker);
  expect(baselineProbe.errors).toEqual([]);
  expect(baselineProbe.closeCode).toBe(1000);

  const baselineCheckpointEvents = (await terminalEvents(page, terminalId)).filter((event) => event.type === "checkpoint");
  const baselineCheckpointCount = baselineCheckpointEvents.length;
  const checkpointCases: readonly K14Case[] = [
    { kind: "incomplete", errors: [] },
    { kind: "invalid-base64", errors: ["terminal checkpoint contains invalid data"] },
    { kind: "missing-offset", errors: ["terminal checkpoint chunks are out of order"] },
    { kind: "duplicate-offset", errors: ["terminal checkpoint chunks are out of order"] },
    { kind: "out-of-order-offset", errors: ["terminal checkpoint chunks are out of order"] },
    { kind: "oversized-chunk", errors: ["terminal checkpoint chunk exceeds the message limit"] },
    { kind: "aggregate-oversized", errors: ["terminal checkpoint exceeds the replay limit"] },
    { kind: "wrong-epoch", errors: [] },
    { kind: "unbridgeable-sequence", errors: [] },
  ];
  const recoveredSnapshots: E2ETerminalSnapshot[] = [initial, baseline];
  const rawCheckpointFrames: NetworkFaultEvent[] = [];

  for (const checkpointCase of checkpointCases) {
    const before = await terminalSnapshot(page, terminalId);
    if (!before) throw new Error(`missing pre-case diagnostics for ${checkpointCase.kind}`);
    expect(before.socketState).toBe("connected");
    expect(before.activeSocketCount).toBe(1);
    expect(markerOccurrences(before.xterm.text, baselineMarker)).toBe(1);
    const framesBefore = checkpointFrameCount(terminalId);

    const raw = await runRawCheckpointCase(page, terminalId, baselineSequence, baselineEpoch, checkpointCase.kind);
    expect(raw.url).toContain("stream=3");
    expect(raw.readyCheckpointBytes).toBe(baselineProbe.readyCheckpointBytes);
    expect(raw.sentCheckpointCount).toBeGreaterThan(0);
    expect(raw.pongs).toBe(1);
    expect(raw.errors).toEqual(checkpointCase.errors);
    expect(raw.closeCode).toBe(1000);
    const proxyClosed = await faultController.waitFor(
      (event) => (
        (event.type === "connection-closed" || event.type === "connection-terminated")
        && event.terminalId === terminalId
        && event.at >= raw.startedAt
      ),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(proxyClosed.type).toBe("connection-closed");
    expect(proxyClosed.abrupt).toBe(false);

    const framesAfter = checkpointFrames(checkpointFrameHistory, terminalId, raw.sentSequence, raw.startedAt);
    expect(framesAfter.length).toBe(raw.sentCheckpointCount);
    expect(framesAfter.every((event) => (event.frame?.bytes ?? 0) < 64 * 1024)).toBe(true);
    rawCheckpointFrames.push(...framesAfter);
    const totalCheckpointFrames = checkpointFrameCount(terminalId);
    expect(totalCheckpointFrames - framesBefore).toBe(raw.sentCheckpointCount);

    const unaffected = await terminalSnapshot(page, terminalId);
    if (!unaffected) throw new Error(`missing unaffected diagnostics after ${checkpointCase.kind}`);
    expect(unaffected.socketState).toBe("connected");
    expect(unaffected.activeSocketCount).toBe(1);
    expect(unaffected.socketGeneration).toBe(before.socketGeneration);
    expect(unaffected.gridEpoch).toBe(baselineEpoch);
    expect(unaffected.checkpointSequence).toBe(baselineSequence);
    expect(unaffected.checkpointEpoch).toBe(baselineEpoch);
    expect(markerOccurrences(unaffected.xterm.text, baselineMarker)).toBe(1);
    const checkpointEventsWhileConnected = (await terminalEvents(page, terminalId)).filter((event) => event.type === "checkpoint");
    expect(checkpointEventsWhileConnected).toHaveLength(baselineCheckpointCount);

    const recoveredProbe = await probeRawSnapshot(page, terminalId);
    expect(recoveredProbe.syncMode).toBe("snapshot");
    expect(recoveredProbe.snapshotBytes).toBeGreaterThan(0);
    expect(recoveredProbe.snapshotText).toContain(baselineMarker);
    expect(recoveredProbe.errors).toEqual([]);
    expect(recoveredProbe.closeCode).toBe(1000);

    const recovered = await forceReconnect(page, terminalId, before);
    recoveredSnapshots.push(recovered);
    expect(recovered.socketState).toBe("connected");
    expect(recovered.activeSocketCount).toBe(1);
    expect(recovered.acceptingInput).toBe(true);
    expect(recovered.gridEpoch).toBe(baselineEpoch);
    expect(recovered.checkpointSequence).toBe(baselineSequence);
    expect(recovered.checkpointEpoch).toBe(baselineEpoch);
    expect(recovered.pendingParserWrites).toBe(0);
    expect(recovered.pendingParserBytes).toBe(0);
    expect(recovered.renderBacklogBytes).toBe(0);
    expect(recovered.renderBacklogFrames).toBe(0);
    expect(markerOccurrences(recovered.xterm.text, baselineMarker)).toBe(1);
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: `k14-${checkpointCase.kind}-recovered-terminal`,
    });
    const checkpointEventsAfterRecovery = (await terminalEvents(page, terminalId)).filter((event) => event.type === "checkpoint");
    expect(checkpointEventsAfterRecovery).toHaveLength(baselineCheckpointCount);
  }

  const beforeLive = await terminalSnapshot(page, terminalId);
  if (!beforeLive) throw new Error("missing pre-live diagnostics");
  const beforeLivePixels = await screenshotRegion(page, pane.xtermHost);
  const liveCommand = `PRINT ${liveId} live`;
  await pane.sendInput(liveCommand, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === liveId && entry.text === "live",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: liveMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, pane.xtermHost, beforeLivePixels, {
    minimumChangedRatio: 0.001,
    testInfo,
    artifactName: "k14-live-marker",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k14-live-terminal",
  });

  const sizeCommand = `SIZE ${sizeId}`;
  await pane.sendInput(sizeCommand, true);
  const sizeEntry = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const ptyRows = Number(sizeEntry.rows);
  const ptyCols = Number(sizeEntry.cols);
  expect(Number.isSafeInteger(ptyRows)).toBe(true);
  expect(Number.isSafeInteger(ptyCols)).toBe(true);

  const echoCommand = `ECHO_INPUT ${echoId}`;
  await pane.sendInput(echoCommand, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: echoReadyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(inputText, true);
  const echoed = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(inputText, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoed.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, terminalId, { contains: echoPayloadMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const finalSnapshot = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    activeSocketCount: 1,
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(finalSnapshot.cols).toBe(ptyCols);
  expect(finalSnapshot.rows).toBe(ptyRows);
  expect(finalSnapshot.serverViewport?.cols).toBe(ptyCols);
  expect(finalSnapshot.serverViewport?.rows).toBe(ptyRows);
  expect(finalSnapshot.gridEpoch).toBe(baselineEpoch);
  expect(markerOccurrences(finalSnapshot.xterm.text, readyMarker)).toBe(1);
  expect(markerOccurrences(finalSnapshot.xterm.text, baselineMarker)).toBe(1);
  expect(markerOccurrences(finalSnapshot.xterm.text, liveMarker)).toBe(1);
  expect(markerOccurrences(finalSnapshot.xterm.text, echoReadyMarker)).toBe(1);
  expect(markerOccurrences(finalSnapshot.xterm.text, echoPayloadMarker)).toBe(1);
  expect(finalSnapshot.receivedSequence).toBe(finalSnapshot.committedSequence);

  await expectTerminalConverged(page, terminalId, {
    cols: finalSnapshot.cols,
    rows: finalSnapshot.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  assertNoUnexpectedSocketMultiplication(recoveredSnapshots);

  const transcript = await server.readTranscript(terminalId);
  for (const command of [readyCommand, baselineCommand, liveCommand, sizeCommand, echoCommand, inputText]) {
    expect(commandCount(transcript, command), `fixture command duplicated or omitted: ${command}`).toBe(1);
  }
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === baselineId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === liveId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(0);
  expect(finalSnapshot.receivedSequence).toBe(outputByteCount(transcript));
  expect(finalSnapshot.committedSequence).toBe(outputByteCount(transcript));

  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(checkpointCases.length + 1);
  expect(events.filter((event) => event.type === "socket-open")).toHaveLength(checkpointCases.length + 1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(checkpointCases.length);
  expect(events.filter((event) => event.type === "sync")).toHaveLength(checkpointCases.length + 1);
  expect(events.filter((event) => event.type === "synced")).toHaveLength(checkpointCases.length + 1);
  expect(events.filter((event) => event.type === "checkpoint").length).toBeGreaterThanOrEqual(baselineCheckpointCount);

  expect(rawCheckpointFrames.length).toBeGreaterThan(checkpointCases.length);
  expect(rawCheckpointFrames.every((event) => (event.frame?.bytes ?? 0) < 64 * 1024)).toBe(true);
  const finalTerminalInfo = await readTerminal(page, terminalId);
  expect(finalTerminalInfo.id).toBe(terminalId);
  expect(finalTerminalInfo.status).toBe("running");
  expect(finalTerminalInfo.pid).toBe(initialPid);
  expect(browserErrors).toEqual([]);
  expect(server.stderr).not.toMatch(/\b(?:panic|out of memory|oom|internal server error)\b/i);
  } finally {
    checkpointFrameListener.dispose();
  }
});
