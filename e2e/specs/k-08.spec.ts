import { Buffer } from "node:buffer";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
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
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import { TERMINAL_CHECKPOINT_CHUNK_BYTES } from "../../src/client/lib/terminal-checkpoint.js";

const WAIT_TIMEOUT_MS = 45_000;
const BROWSER_WIDTH = 1_280;
const BROWSER_HEIGHT = 720;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TranscriptEntry = Record<string, unknown>;

type RecordedEvent = {
  readonly type?: unknown;
  readonly terminal?: unknown;
  readonly ts?: unknown;
  readonly sequence?: unknown;
  readonly data?: unknown;
  readonly message?: unknown;
};

type RecordingExport = {
  readonly truncated?: unknown;
  readonly events?: readonly RecordedEvent[];
};

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

interface CreatedTerminal {
  readonly id: string;
  readonly name: string;
}

async function createFixtureTerminal(
  page: Page,
  terminalPath: string,
  shellPath: string,
): Promise<CreatedTerminal> {
  return page.evaluate(async ({ path, shell }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, cwd: "/tmp", shell }),
    });
    if (!response.ok) throw new Error(`terminal creation failed with HTTP ${response.status}`);
    const terminal = await response.json() as { id?: unknown; name?: unknown };
    if (typeof terminal.id !== "string" || typeof terminal.name !== "string") {
      throw new Error("terminal creation response is missing id or name");
    }
    return { id: terminal.id, name: terminal.name };
  }, { path: terminalPath, shell: shellPath });
}

async function waitForMountedPane(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.snapshot.kind === "pane" && event.terminalId === id,
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function eventDataNumber(event: E2ETerminalEvent, key: string): number | undefined {
  return numberField(event.data, key);
}

function countOccurrences(text: string, expected: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(expected, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, expected.length);
  }
  return count;
}

function frameMatches(
  event: NetworkFaultEvent,
  terminalId: string,
  generation: number,
  direction: "browser-to-server" | "server-to-browser",
  binaryKind?: number,
  jsonType?: string,
): boolean {
  return event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === direction
    && (binaryKind === undefined || event.frame?.binaryKind === binaryKind)
    && (jsonType === undefined || event.frame?.jsonType === jsonType);
}

function latestOutputOccurrence(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
): number {
  return events.reduce((latest, event) => {
    if (!frameMatches(event, terminalId, generation, "server-to-browser", 1)) return latest;
    return Math.max(latest, event.frame?.occurrence ?? 0);
  }, 0);
}

async function waitForSettledMarker(
  page: Page,
  terminalId: string,
  expected: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, markerText, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.xterm.text.replace(/\s+/g, "").includes(markerText.replace(/\s+/g, ""))
      && snapshot.socketState === "connected"
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && (snapshot.receivedSequence === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence === snapshot.receivedSequence)
    ), { timeout });
  }, { id: terminalId, markerText: expected, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCheckpoint(
  page: Page,
  terminalId: string,
  afterEventId: number,
  sequence: number,
  epoch: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, expectedSequence, expectedEpoch, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "checkpoint"
      && event.data.result === "sent"
      && event.data.sequence === expectedSequence
      && event.data.epoch === expectedEpoch
      && event.snapshot.checkpointSequence === expectedSequence
      && event.snapshot.checkpointEpoch === expectedEpoch
    ), { timeout, afterId: after });
  }, {
    id: terminalId,
    after: afterEventId,
    expectedSequence: sequence,
    expectedEpoch: epoch,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForDisconnected(
  page: Page,
  terminalId: string,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "state"
      && event.data.state === "disconnected"
      && event.snapshot.socketState === "disconnected"
      && event.snapshot.activeSocketCount === 0
      && !event.snapshot.acceptingInput
    ), { timeout, afterId: after });
  }, { id: terminalId, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRecoverySync(
  page: Page,
  terminalId: string,
  generation: number,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, oldGeneration, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "sync"
      && event.snapshot.socketGeneration > oldGeneration
      && (event.data.mode === "snapshot" || event.data.mode === "resume")
    ), { timeout, afterId: after });
  }, { id: terminalId, oldGeneration: generation, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRecoverySynced(
  page: Page,
  terminalId: string,
  generation: number,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, oldGeneration, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "synced"
      && event.snapshot.socketGeneration > oldGeneration
    ), { timeout, afterId: after });
  }, { id: terminalId, oldGeneration: generation, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRecoverySettled(
  page: Page,
  terminalId: string,
  generation: number,
  markers: readonly string[],
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expectedGeneration, expectedMarkers, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration === expectedGeneration
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.syncMode === undefined
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && expectedMarkers.every((markerText) => snapshot.xterm.text.includes(markerText))
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
    ), { timeout });
  }, { id: terminalId, expectedGeneration: generation, expectedMarkers: markers, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSocketCreated(
  page: Page,
  terminalId: string,
  generation: number,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, oldGeneration, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "socket-created"
      && event.snapshot.socketGeneration > oldGeneration
    ), { timeout, afterId: after });
  }, { id: terminalId, oldGeneration: generation, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function recordingControl(page: Page, action: "clear" | "start" | "stop"): Promise<Record<string, unknown>> {
  return page.evaluate(async (nextAction) => {
    const response = await fetch("/api/debug/recording", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: nextAction }),
    });
    if (!response.ok) throw new Error(`debug recording ${nextAction} failed with HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  }, action);
}

async function exportRecording(page: Page): Promise<RecordingExport> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export", { cache: "no-store" });
    if (!response.ok) throw new Error(`debug recording export failed with HTTP ${response.status}`);
    return await response.json() as RecordingExport;
  });
}

function recordingMessage(event: RecordedEvent): Record<string, unknown> | undefined {
  if (event.type !== "control" || typeof event.message !== "object" || event.message === null) return undefined;
  return event.message as Record<string, unknown>;
}

function recordingBytes(event: RecordedEvent): Buffer | undefined {
  return typeof event.data === "string" ? Buffer.from(event.data, "base64") : undefined;
}

function recordingSequence(event: RecordedEvent): number | undefined {
  return numberField(event, "sequence");
}

function exactRecordedOutputRange(
  events: readonly RecordedEvent[],
  start: number,
  end: number,
  expected: Buffer,
): Buffer | undefined {
  const outputs = events
    .filter((event) => event.type === "output")
    .map((event) => ({
      event,
      sequence: recordingSequence(event),
      bytes: recordingBytes(event),
      timestamp: numberField(event, "ts") ?? 0,
    }))
    .filter((entry): entry is { event: RecordedEvent; sequence: number; bytes: Buffer; timestamp: number } => (
      entry.sequence !== undefined
      && entry.bytes !== undefined
      && entry.sequence >= start
      && entry.sequence < end
    ))
    .sort((left, right) => left.timestamp - right.timestamp);

  for (let first = 0; first < outputs.length; first += 1) {
    if (outputs[first]?.sequence !== start) continue;
    let nextSequence = start;
    const pieces: Buffer[] = [];
    for (let index = first; index < outputs.length; index += 1) {
      const output = outputs[index];
      if (!output || output.sequence !== nextSequence) break;
      pieces.push(output.bytes);
      nextSequence += output.bytes.byteLength;
      if (nextSequence === end) {
        const candidate = Buffer.concat(pieces);
        if (candidate.equals(expected)) return candidate;
        break;
      }
    }
  }
  return undefined;
}

function markerWriteCount(entries: readonly TranscriptEntry[], value: string): number {
  const expected = Buffer.from(`${value}\n`, "utf8").toString("base64");
  return entries.filter((entry) => entry.event === "write" && entry.data_base64 === expected).length;
}

async function waitForSocketCloseEvent(
  page: Page,
  terminalId: string,
  generation: number,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, expectedGeneration, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "socket-close"
      && event.snapshot.socketGeneration === expectedGeneration
      && event.data.generation === expectedGeneration
    ), { timeout, afterId: after });
  }, { id: terminalId, expectedGeneration: generation, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

test("K-08 Checkpoint plus retained delta @p1 @nightly @checkpoint @delta @recovery", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo: TestInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);

  const runTag = `K008-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const terminalPath = `k08-${runTag}`;
  const readyId = `${runTag}-READY`;
  const preId = `${runTag}-PRE`;
  const holdToken = `${runTag}-DELTA-HOLD`;
  const deltaId = `${runTag}-DELTA`;
  const sizeId = `${runTag}-SIZE`;
  const echoId = `${runTag}-ECHO`;
  const preText = `${runTag}-checkpoint-state`;
  const deltaText = `${runTag}-retained-delta`;
  const inputText = `${runTag}-continued-input`;
  const readyMarker = marker("READY", readyId);
  const preMarker = marker("PRINT", preId, preText);
  const holdMarker = marker("HOLD", holdToken);
  const releaseMarker = marker("RELEASE", holdToken);
  const deltaMarker = marker("PRINT", deltaId, deltaText);
  const echoReadyMarker = marker("ECHO_INPUT", echoId, "READY");
  const echoPayloadMarker = marker("ECHO_INPUT", echoId, Buffer.from(inputText, "utf8").toString("base64"));
  const expectedRetainedDelta = Buffer.from(`${holdMarker}\n${releaseMarker}\n${deltaMarker}\n`, "utf8");
  await page.setViewportSize({ width: BROWSER_WIDTH, height: BROWSER_HEIGHT });
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const clearStatus = await recordingControl(page, "clear");
  expect(clearStatus.active).toBe(false);
  const startedStatus = await recordingControl(page, "start");
  expect(startedStatus.active).toBe(true);

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const created = await createFixtureTerminal(page, terminalPath, server.fixturePath);
  await page.reload();
  await workbench.expectVisible();

  const mountPromise = waitForMountedPane(page, created.id);
  const pane = await workbench.openTerminal({ id: created.id, name: created.name });
  const mounted = await mountPromise;
  expect(mounted.terminalId).toBe(created.id);
  await pane.expectVisible();
  await pane.expectConnected();
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  const initial = await expectTerminalInteractive(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.serverViewport).toBeDefined();
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  const terminalId = created.id;

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const preEventCursor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? 0;
  await pane.sendInput(`PRINT ${preId} ${preText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === preId && entry.text === preText, { timeoutMs: WAIT_TIMEOUT_MS });
  const preSnapshot = await waitForSettledMarker(page, terminalId, preMarker);
  // The live browser uploads a checkpoint as one `checkpointBinary` JSON
  // announcement followed by binary body frames whose nine-byte header carries
  // kind byte 2 and the announced sequence, which the proxy decodes as
  // `binaryKind` and `sequence`. Track the body-frame occurrence high-water
  // mark so earlier uploads on this socket are not counted below.
  const checkpointFrameBaseline = faultController.events.reduce((maximum, event) => (
    frameMatches(event, terminalId, preSnapshot.socketGeneration, "browser-to-server", 2)
      ? Math.max(maximum, event.frame?.occurrence ?? 0)
      : maximum
  ), 0);
  const checkpointSequence = preSnapshot.committedSequence;
  const checkpointEpoch = preSnapshot.gridEpoch;
  if (checkpointSequence === undefined || checkpointEpoch === undefined) {
    throw new Error("pre-checkpoint diagnostics did not expose a committed sequence and grid epoch");
  }
  expect(preSnapshot.xterm.text).toContain(preMarker);
  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k08-before-delta",
  });

  const checkpointEvent = await waitForCheckpoint(
    page,
    terminalId,
    preEventCursor,
    checkpointSequence,
    checkpointEpoch,
  );
  const checkpointSize = eventDataNumber(checkpointEvent, "size");
  const checkpointChunks = eventDataNumber(checkpointEvent, "chunks");
  expect(checkpointEvent.data.result).toBe("sent");
  expect(checkpointSize).toBeGreaterThan(0);
  expect(checkpointChunks).toBe(Math.ceil((checkpointSize ?? 0) / TERMINAL_CHECKPOINT_CHUNK_BYTES));
  expect(checkpointEvent.snapshot.checkpointSequence).toBe(checkpointSequence);
  expect(checkpointEvent.snapshot.checkpointEpoch).toBe(checkpointEpoch);
  if (checkpointChunks === undefined || checkpointChunks <= 0) throw new Error("checkpoint did not report a positive chunk count");

  await faultController.waitFor((event) => (
    frameMatches(event, terminalId, preSnapshot.socketGeneration, "browser-to-server", undefined, "checkpointBinary")
    && event.frame?.sequence === checkpointSequence
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const checkpointBodyFrames: NetworkFaultEvent[] = [];
  let checkpointFrameOccurrence = checkpointFrameBaseline;
  for (let chunk = 0; chunk < checkpointChunks; chunk += 1) {
    const frame = await faultController.waitFor((event) => (
      frameMatches(event, terminalId, preSnapshot.socketGeneration, "browser-to-server", 2)
      && event.frame?.sequence === checkpointSequence
      && (event.frame?.occurrence ?? 0) > checkpointFrameOccurrence
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    checkpointBodyFrames.push(frame);
    checkpointFrameOccurrence = frame.frame?.occurrence ?? checkpointFrameOccurrence;
  }
  expect(checkpointBodyFrames).toHaveLength(checkpointChunks);
  expect(checkpointBodyFrames.every((event) => event.frame?.binaryKind === 2)).toBe(true);

  const pausedRule = faultController.pause("server-to-browser", {
    terminalId,
    generation: preSnapshot.socketGeneration,
  });
  await faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalId
    && event.generation === preSnapshot.socketGeneration
    && event.direction === "server-to-browser"
    && event.ruleId === pausedRule.id
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  const holdOutputOccurrence = latestOutputOccurrence(faultController.events, terminalId, preSnapshot.socketGeneration);
  const holdOutputFramePromise = faultController.waitFor((event) => (
    frameMatches(event, terminalId, preSnapshot.socketGeneration, "server-to-browser", 1)
    && (event.frame?.occurrence ?? 0) > holdOutputOccurrence
    && event.frame?.sequence === checkpointSequence
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
  const holdOutputFrame = await holdOutputFramePromise;
  expect(holdOutputFrame.frame?.sequence).toBe(checkpointSequence);
  expect(holdOutputFrame.frame?.binaryKind).toBe(1);

  await pane.sendInput(`PRINT ${deltaId} ${deltaText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "command" && entry.operation === "PRINT", { timeoutMs: WAIT_TIMEOUT_MS });
  const releaseOutputOccurrence = holdOutputFrame.frame?.occurrence ?? holdOutputOccurrence;
  const releaseOutputFramePromise = faultController.waitFor((event) => (
    frameMatches(event, terminalId, preSnapshot.socketGeneration, "server-to-browser", 1)
    && (event.frame?.occurrence ?? 0) > releaseOutputOccurrence
    && event.frame?.sequence === checkpointSequence + Buffer.byteLength(`${holdMarker}\n`, "utf8")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.insertText(`RELEASE ${holdToken}`);
  await pane.press("Enter");
  await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
  const releaseOutputFrame = await releaseOutputFramePromise;
  expect(releaseOutputFrame.frame?.sequence).toBe(checkpointSequence + Buffer.byteLength(`${holdMarker}\n`, "utf8"));
  expect(releaseOutputFrame.frame?.binaryKind).toBe(1);
  const deltaOutputOccurrence = releaseOutputFrame.frame?.occurrence ?? releaseOutputOccurrence;
  const deltaOutputFramePromise = faultController.waitFor((event) => (
    frameMatches(event, terminalId, preSnapshot.socketGeneration, "server-to-browser", 1)
    && (event.frame?.occurrence ?? 0) > deltaOutputOccurrence
    && event.frame?.sequence === checkpointSequence + Buffer.byteLength(`${holdMarker}\n${releaseMarker}\n`, "utf8")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === deltaId && entry.text === deltaText, { timeoutMs: WAIT_TIMEOUT_MS });
  const deltaOutputFrame = await deltaOutputFramePromise;
  expect(deltaOutputFrame.frame?.sequence).toBe(checkpointSequence + Buffer.byteLength(`${holdMarker}\n${releaseMarker}\n`, "utf8"));
  expect(deltaOutputFrame.frame?.binaryKind).toBe(1);

  const recoveryEventCursor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? preEventCursor;
  const socketClosePromise = waitForSocketCloseEvent(page, terminalId, preSnapshot.socketGeneration, recoveryEventCursor);
  const disconnectedPromise = waitForDisconnected(page, terminalId, recoveryEventCursor);
  const recoverySyncPromise = waitForRecoverySync(page, terminalId, preSnapshot.socketGeneration, recoveryEventCursor);
  const recoverySyncedPromise = waitForRecoverySynced(page, terminalId, preSnapshot.socketGeneration, recoveryEventCursor);
  const reconnectSocketPromise = waitForSocketCreated(page, terminalId, preSnapshot.socketGeneration, recoveryEventCursor);
  const terminatedPromise = faultController.waitFor((event) => (
    event.type === "connection-terminated"
    && event.terminalId === terminalId
    && event.generation === preSnapshot.socketGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const terminateRule = faultController.terminate({
    terminalId,
    generation: preSnapshot.socketGeneration,
  });
  const [terminated, socketClose, disconnected, recoverySync, recoverySynced, reconnectSocket] = await Promise.all([
    terminatedPromise,
    socketClosePromise,
    disconnectedPromise,
    recoverySyncPromise,
    recoverySyncedPromise,
    reconnectSocketPromise,
  ]);
  terminateRule.dispose();
  pausedRule.dispose();
  expect(terminated.abrupt).toBe(true);
  expect(terminated.code).toBe(1006);
  expect(socketClose.data.generation).toBe(preSnapshot.socketGeneration);
  expect(disconnected.snapshot.socketState).toBe("disconnected");
  expect(disconnected.snapshot.activeSocketCount).toBe(0);
  expect(disconnected.snapshot.acceptingInput).toBe(false);
  expect(reconnectSocket.snapshot.socketGeneration).toBeGreaterThan(preSnapshot.socketGeneration);
  expect(recoverySync.snapshot.socketGeneration).toBe(reconnectSocket.snapshot.socketGeneration);
  expect(recoverySynced.snapshot.socketGeneration).toBe(reconnectSocket.snapshot.socketGeneration);
  expect(recoverySync.data.sequence).toEqual(expect.any(Number));
  expect(["snapshot", "resume"]).toContain(recoverySync.data.mode);

  const recovered = await waitForRecoverySettled(page, terminalId, reconnectSocket.snapshot.socketGeneration, [preMarker, holdMarker, releaseMarker, deltaMarker]);
  expect(recovered.gridEpoch).toBe(checkpointEpoch);
  expect(recovered.receivedSequence).toBe(checkpointSequence + expectedRetainedDelta.byteLength);
  expect(recovered.committedSequence).toBe(checkpointSequence + expectedRetainedDelta.byteLength);
  const recoveredText = recovered.xterm.text;
  expect(recoveredText.indexOf(preMarker)).toBeLessThan(recoveredText.indexOf(holdMarker));
  expect(recoveredText.indexOf(holdMarker)).toBeLessThan(recoveredText.indexOf(releaseMarker));
  expect(recoveredText.indexOf(releaseMarker)).toBeLessThan(recoveredText.indexOf(deltaMarker));
  expect(recovered.xterm.text).toContain(preMarker);
  expect(recovered.xterm.text).toContain(holdMarker);
  expect(recovered.xterm.text).toContain(releaseMarker);
  expect(recovered.xterm.text).toContain(deltaMarker);
  expect(countOccurrences(recovered.xterm.text, preMarker)).toBe(1);
  expect(countOccurrences(recovered.xterm.text, holdMarker)).toBe(1);
  expect(countOccurrences(recovered.xterm.text, releaseMarker)).toBe(1);
  expect(countOccurrences(recovered.xterm.text, deltaMarker)).toBe(1);
  await expectTerminalConverged(page, terminalId, {
    cols: preSnapshot.cols,
    rows: preSnapshot.rows,
    pixelWidth: preSnapshot.pixelWidth,
    pixelHeight: preSnapshot.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k08-after-delta-recovery",
  });
  const afterPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforePixels, afterPixels, {
    minimumChangedRatio: 0.0002,
    testInfo,
    artifactName: "k08-retained-delta-pixels",
  });

  const stoppedStatus = await recordingControl(page, "stop");
  expect(stoppedStatus.active).toBe(false);
  const recording = await exportRecording(page);
  expect(recording.truncated).toBe(false);
  if (!recording.events) throw new Error("server debug recording did not include an event list");
  const recordingEvents = recording.events.filter((event) => event.terminal === terminalId);
  expect(recordingEvents.length).toBeGreaterThan(0);
  const checkpointNotes = recordingEvents.filter((event) => {
    const message = recordingMessage(event);
    return message?.type === "note" && message.event === "xterm checkpoint stored";
  });
  expect(checkpointNotes).toHaveLength(1);
  const recoveredTarget = eventDataNumber(recoverySync, "sequence");
  expect(recoveredTarget).toBe(checkpointSequence + expectedRetainedDelta.byteLength);

  const outputRange = exactRecordedOutputRange(
    recordingEvents,
    checkpointSequence,
    recoveredTarget ?? checkpointSequence,
    expectedRetainedDelta,
  );
  expect(outputRange, "server recording must retain the exact checkpoint delta range").toBeDefined();
  const snapshotEvents = recordingEvents.filter((event) => event.type === "snapshot" && recordingSequence(event) === recoveredTarget);
  if (recoverySync.data.mode === "snapshot") {
    expect(snapshotEvents.length).toBeGreaterThan(0);
    const snapshotPayloads = snapshotEvents.map(recordingBytes).filter((payload): payload is Buffer => payload !== undefined);
    expect(snapshotPayloads.some((payload) => {
      const text = payload.toString("utf8");
      return countOccurrences(text, preMarker) === 1
        && countOccurrences(text, holdMarker) === 1
        && countOccurrences(text, releaseMarker) === 1
        && countOccurrences(text, deltaMarker) === 1
        && text.indexOf(preMarker) < text.indexOf(holdMarker)
        && text.indexOf(holdMarker) < text.indexOf(releaseMarker)
        && text.indexOf(releaseMarker) < text.indexOf(deltaMarker);
    })).toBe(true);
  } else {
    expect(recoverySync.data.mode).toBe("resume");
    expect(outputRange).toBeDefined();
  }

  const sizeIdEntryPromise = server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await sizeIdEntryPromise;
  expect(sizeEntry.rows).toBe(recovered.rows);
  expect(sizeEntry.cols).toBe(recovered.cols);
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:SIZE:${sizeId}:`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.insertText(inputText);
  await pane.press("Enter");
  const echoed = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input"
    && entry.id === echoId
    && entry.phase === "payload"
    && entry.payload_base64 === Buffer.from(inputText, "utf8").toString("base64")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(echoed.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, terminalId, { contains: echoReadyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: echoPayloadMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === preId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === deltaId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "hold" && entry.token === holdToken)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "release" && entry.token === holdToken)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(markerWriteCount(transcript, preMarker)).toBe(1);
  expect(markerWriteCount(transcript, holdMarker)).toBe(1);
  expect(markerWriteCount(transcript, releaseMarker)).toBe(1);
  expect(markerWriteCount(transcript, deltaMarker)).toBe(1);

  const finalSnapshot = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS }).then((report) => report.snapshot);
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.xterm.text).toContain(preMarker);
  expect(finalSnapshot.xterm.text).toContain(holdMarker);
  expect(finalSnapshot.xterm.text).toContain(releaseMarker);
  expect(finalSnapshot.xterm.text).toContain(deltaMarker);
  expect(finalSnapshot.xterm.text).toContain(echoReadyMarker);
  expect(finalSnapshot.xterm.text).toContain(echoPayloadMarker);
  expect(countOccurrences(finalSnapshot.xterm.text, preMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, holdMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, releaseMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, deltaMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, echoPayloadMarker)).toBe(1);
  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  assertNoUnexpectedSocketMultiplication([preSnapshot, disconnected.snapshot, recovered, finalSnapshot]);
  assertNoPendingSynchronization(finalSnapshot);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
    || entry.kind === "websocket" && entry.message === "error"
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  browserErrors.dispose();
});
