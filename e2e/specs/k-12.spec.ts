import { Buffer } from "node:buffer";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test, type BrowserErrorCollector, type TranscriptEntry } from "../fixtures/test.js";
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
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
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
const TEST_TIMEOUT_MS = 240_000;
const FIXED_VIEWPORT = { width: 1_280, height: 800 } as const;
const BURST_LINE_WIDTH = 80;
const MIN_BURST_BYTES = 1_200_000;
const CHECKPOINT_MIN_BYTES = 64 * 1024;
const CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface CreatedTerminal {
  readonly id: string;
  readonly name: string;
}

interface RecordingEvent {
  readonly terminal?: string;
  readonly type?: string;
  readonly message?: unknown;
  readonly sequence?: number;
  readonly data?: string;
}

interface RecordingExport {
  readonly truncated: boolean;
  readonly events: readonly RecordingEvent[];
}

function marker(operation: string, ...fields: readonly string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += Math.max(needle.length, 1);
  }
  return count;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function eventId(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.id), -1);
}

function writeBytes(entry: TranscriptEntry): Buffer {
  if (typeof entry.data_base64 !== "string") throw new Error("fixture write entry omitted data_base64");
  return Buffer.from(entry.data_base64, "base64");
}

function recordingMessage(event: RecordingEvent): Record<string, unknown> | undefined {
  if (event.type !== "control" || typeof event.message !== "object" || event.message === null || Array.isArray(event.message)) {
    return undefined;
  }
  return event.message as Record<string, unknown>;
}

function recordingClientMessage(event: RecordingEvent): Record<string, unknown> | undefined {
  const outer = recordingMessage(event);
  if (outer?.type !== "client" || typeof outer.message !== "object" || outer.message === null || Array.isArray(outer.message)) {
    return undefined;
  }
  return outer.message as Record<string, unknown>;
}

function negotiatedCheckpointBytes(recording: RecordingExport, terminalId: string): number {
  const readyMessages = recording.events
    .filter((event) => event.terminal === terminalId)
    .map(recordingMessage)
    .filter((message): message is Record<string, unknown> => message?.type === "ready");
  const value = readyMessages
    .map((message) => message.checkpointBytes)
    .find((candidate): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate));
  if (value === undefined) throw new Error("server ready control did not negotiate checkpointBytes");
  return value;
}

function recordingControls(recording: RecordingExport, terminalId: string, type: string): Record<string, unknown>[] {
  return recording.events
    .filter((event) => event.terminal === terminalId)
    .map(recordingMessage)
    .filter((message): message is Record<string, unknown> => message?.type === type);
}

async function recordingControl(page: Page, action: "clear" | "start" | "stop"): Promise<void> {
  await page.evaluate(async (requestedAction) => {
    const response = await fetch("/api/debug/recording", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: requestedAction }),
    });
    if (!response.ok) throw new Error(`debug recording ${requestedAction} failed with HTTP ${response.status}`);
  }, action);
}

async function recordingExport(page: Page): Promise<RecordingExport> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`debug recording export failed with HTTP ${response.status}`);
    return await response.json() as RecordingExport;
  });
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
    const terminal = await response.json() as Partial<CreatedTerminal>;
    if (typeof terminal.id !== "string" || typeof terminal.name !== "string") {
      throw new Error("terminal creation response is missing terminal identity");
    }
    return { id: terminal.id, name: terminal.name };
  }, { path: terminalPath, fixtureShell: shell });
}

async function waitForMountedPane(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.type === "mount" && event.snapshot.kind === "pane" && event.terminalId === id,
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  minimumSequence: number,
  expectedText?: string,
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
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
      && (expected === undefined || snapshot.xterm.text.includes(expected))
    ), { timeout });
  }, { id: terminalId, minimum: minimumSequence, expected: expectedText, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForParserMarker(
  page: Page,
  terminalId: string,
  afterEventId: number,
  expectedMarker: string,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "parser-commit"
        && event.snapshot.xterm.text.includes(expected),
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, expected: expectedMarker, timeout: WAIT_TIMEOUT_MS });
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

async function waitForSocketClose(page: Page, terminalId: string, generation: number): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, expectedGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.type === "socket-close" && event.data.generation === expectedGeneration,
      { timeout },
    );
  }, { id: terminalId, expectedGeneration: generation, timeout: WAIT_TIMEOUT_MS });
}

function checkpointFrames(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
  sequence: number,
): readonly NetworkFaultEvent[] {
  return events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpoint"
    && event.frame.sequence === sequence
  ));
}

async function waitForCheckpointFrames(
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
  sequence: number,
  chunks: number,
): Promise<void> {
  await faultController.waitFor((event) => (
    event.terminalId === terminalId
    && checkpointFrames(faultController.events, terminalId, generation, sequence).length >= chunks
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

function unexpectedBrowserErrors(entries: readonly { kind: string; message: string }[]): readonly unknown[] {
  return entries.filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
}

test("K-12 Checkpoint size trimming @nightly @p1 @checkpoint @trim", async ({
  browser,
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const browserErrors = installBrowserErrorCollectors(page);
  let freshContext: BrowserContext | undefined;
  let freshPage: Page | undefined;
  let freshBrowserErrors: BrowserErrorCollector | undefined;
  let recordingPage: Page | undefined = page;
  let recordingActive = false;
  const runTag = `K12-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const terminalPath = `k12-${runTag}`;
  const readyId = `${runTag}-READY`;
  const oldId = `${runTag}-OLD`;
  const oldText = `${runTag}-OLD-SENTINEL`;
  const burstId = `${runTag}-BURST`;
  const liveId = `${runTag}-LIVE`;
  const liveText = `${runTag}-LIVE-SENTINEL`;
  const afterId = `${runTag}-AFTER`;
  const afterText = `${runTag}-AFTER-RECOVERY`;
  const echoId = `${runTag}-ECHO`;
  const echoText = `${runTag}-CONTINUED-INPUT`;
  const readyMarker = marker("READY", readyId);
  const oldMarker = marker("PRINT", oldId, oldText);
  const liveMarker = marker("PRINT", liveId, liveText);
  const afterMarker = marker("PRINT", afterId, afterText);
  const echoReadyMarker = marker("ECHO_INPUT", echoId, "READY");
  const echoMarker = marker("ECHO_INPUT", echoId, Buffer.from(echoText, "utf8").toString("base64"));
  const printBytes = (value: string): number => Buffer.byteLength(`${value}\n`, "utf8");

  try {
    await page.setViewportSize(FIXED_VIEWPORT);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    await recordingControl(page, "clear");
    await recordingControl(page, "start");
    recordingActive = true;

    const created = await createFixtureTerminal(page, terminalPath, server.fixturePath);
    await page.reload();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const mountedPromise = waitForMountedPane(page, created.id);
    const pane = await workbench.openTerminal({ id: created.id, name: created.name });
    await mountedPromise;
    await pane.expectVisible();
    await pane.expectConnected();
    await pane.focus();

    const initial = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    expect(initial.socketState).toBe("connected");
    expect(initial.acceptingInput).toBe(true);
    expect(initial.activeSocketCount).toBe(1);
    expect(initial.gridEpoch).toEqual(expect.any(Number));
    await expectTerminalConverged(page, created.id, {
      cols: initial.cols,
      rows: initial.rows,
      pixelWidth: initial.pixelWidth,
      pixelHeight: initial.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });

    const readyFloor = eventId(await terminalEvents(page, created.id));
    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(created.id, (entry) => (
      entry.event === "command" && entry.operation === "READY" && entry.id === readyId
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(created.id, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
    await waitForParserMarker(page, created.id, readyFloor, readyMarker);
    const readySettled = await waitForSettledTerminal(page, created.id, (initial.committedSequence ?? initial.receivedSequence ?? 0) + printBytes(readyMarker), readyMarker);
    expect(readySettled.xterm.text).toContain(readyMarker);

    const readyRecording = await recordingExport(page);
    const checkpointBytes = negotiatedCheckpointBytes(readyRecording, created.id);
    expect(checkpointBytes).toBeGreaterThanOrEqual(CHECKPOINT_MIN_BYTES);
    expect(checkpointBytes).toBeLessThanOrEqual(CHECKPOINT_MAX_BYTES);
    const burstBytes = Math.max(checkpointBytes + 128 * 1024, MIN_BURST_BYTES);
    expect(burstBytes).toBeGreaterThan(checkpointBytes);

    const baseline = await waitForSettledTerminal(page, created.id, readySettled.committedSequence ?? 0, readyMarker);
    const baselineSequence = requiredNumber(baseline.committedSequence, "baseline committed sequence");
    const baselineEvents = await terminalEvents(page, created.id);
    const scenarioEventFloor = eventId(baselineEvents);
    const baselineTranscript = await server.readTranscript(created.id);
    const baselineWriteSequence = baselineTranscript.reduce((maximum, entry) => (
      entry.event === "write" && typeof entry.write_sequence === "number"
        ? Math.max(maximum, entry.write_sequence)
        : maximum
    ), 0);
    const expectedSequence = baselineSequence + printBytes(oldMarker) + burstBytes + printBytes(liveMarker);
    const checkpointPromise = waitForCheckpoint(page, created.id, scenarioEventFloor, expectedSequence);
    const settledPromise = waitForSettledTerminal(page, created.id, expectedSequence, liveMarker);

    const beforePixels = await screenshotRegion(page, pane.xtermHost);
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: "k-12-before-trim",
    });

    const oldFloor = eventId(await terminalEvents(page, created.id));
    const oldCommitPromise = waitForParserMarker(page, created.id, oldFloor, oldMarker);
    await pane.sendInput(`PRINT ${oldId} ${oldText}`, true);
    await server.waitForTranscript(created.id, (entry) => entry.event === "command" && entry.operation === "PRINT" && entry.id === oldId, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === oldId && entry.text === oldText, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(created.id, (entry) => entry.event === "write" && entry.bytes === printBytes(oldMarker), { timeoutMs: WAIT_TIMEOUT_MS });
    await oldCommitPromise;
    await expectTerminalBuffer(page, created.id, { contains: oldMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    await pane.sendInput(`BURST ${burstId} ${burstBytes} ${BURST_LINE_WIDTH}`, true);
    await server.waitForTranscript(created.id, (entry) => entry.event === "command" && entry.operation === "BURST" && entry.id === burstId, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(created.id, (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === burstBytes, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(created.id, (entry) => entry.event === "write" && entry.bytes === burstBytes, { timeoutMs: WAIT_TIMEOUT_MS });

    const liveFloor = eventId(await terminalEvents(page, created.id));
    const liveCommitPromise = waitForParserMarker(page, created.id, liveFloor, liveMarker);
    await pane.sendInput(`PRINT ${liveId} ${liveText}`, true);
    await server.waitForTranscript(created.id, (entry) => entry.event === "command" && entry.operation === "PRINT" && entry.id === liveId, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === liveId && entry.text === liveText, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(created.id, (entry) => entry.event === "write" && entry.bytes === printBytes(liveMarker), { timeoutMs: WAIT_TIMEOUT_MS });
    await liveCommitPromise;
    const burstSettled = await settledPromise;
    expect(countOccurrences(burstSettled.xterm.text, oldMarker)).toBe(1);
    expect(countOccurrences(burstSettled.xterm.text, liveMarker)).toBe(1);
    const afterBurstPixels = await screenshotRegion(page, pane.xtermHost);
    await expectTerminalPixelsChanged(beforePixels, afterBurstPixels, {
      minimumChangedRatio: 0.0002,
      testInfo,
      artifactName: "k-12-filled-live-screen",
    });

    const checkpoint = await checkpointPromise;
    const checkpointSequence = requiredNumber(checkpoint.data.sequence, "checkpoint sequence");
    const checkpointEpoch = requiredNumber(checkpoint.data.epoch, "checkpoint epoch");
    const checkpointSize = requiredNumber(checkpoint.data.size, "checkpoint size");
    const checkpointChunks = requiredNumber(checkpoint.data.chunks, "checkpoint chunks");
    expect(checkpoint.data.result).toBe("sent");
    expect(checkpointSequence).toBeGreaterThanOrEqual(expectedSequence);
    expect(checkpoint.snapshot.committedSequence).toBeGreaterThanOrEqual(checkpointSequence);
    expect(checkpoint.snapshot.gridEpoch).toBe(checkpointEpoch);
    expect(checkpointSize).toBeGreaterThan(0);
    expect(checkpointSize).toBeLessThanOrEqual(checkpointBytes);
    expect(checkpointChunks).toBe(Math.ceil(checkpointSize / TERMINAL_CHECKPOINT_CHUNK_BYTES));
    expect(checkpoint.snapshot.checkpointSize).toBe(checkpointSize);
    expect(checkpoint.snapshot.checkpointChunks).toBe(checkpointChunks);
    expect(checkpoint.snapshot.checkpointResult).toBe("sent");
    expect(checkpoint.snapshot.pendingParserWrites).toBe(0);
    expect(checkpoint.snapshot.renderBacklogBytes).toBe(0);
    await waitForCheckpointFrames(
      faultController,
      created.id,
      checkpoint.snapshot.socketGeneration,
      checkpointSequence,
      checkpointChunks,
    );
    const uploadedFrames = checkpointFrames(
      faultController.events,
      created.id,
      checkpoint.snapshot.socketGeneration,
      checkpointSequence,
    );
    expect(uploadedFrames).toHaveLength(checkpointChunks);
    expect(uploadedFrames.every((event) => (event.frame?.bytes ?? 0) > 0)).toBe(true);

    const originalEvents = await terminalEvents(page, created.id);
    await assertMonotonicSequences(originalEvents);
    expect(originalEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(originalEvents.filter((event) => event.type === "socket-stale")).toEqual([]);

    const originalGeneration = burstSettled.socketGeneration;
    const viewport = page.viewportSize() ?? FIXED_VIEWPORT;
    const socketClose = waitForSocketClose(page, created.id, originalGeneration);
    const proxyClose = faultController.waitFor((event) => (
      (event.type === "connection-terminated" || event.type === "connection-closed")
      && event.terminalId === created.id
      && event.generation === originalGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const termination = faultController.terminate({ terminalId: created.id, generation: originalGeneration });
    await Promise.all([socketClose, proxyClose]);
    termination.dispose();
    await page.close();
    browserErrors.dispose();

    freshContext = await browser.newContext({ baseURL, viewport });
    freshPage = await freshContext.newPage();
    recordingPage = freshPage;
    freshBrowserErrors = installBrowserErrorCollectors(freshPage);
    await freshPage.goto(baseURL);
    await new LoginPage(freshPage).login();
    const freshWorkbench = new WorkbenchPage(freshPage);
    await freshWorkbench.expectVisible();
    const freshSyncPromise = freshPage.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent(id, (event) => event.type === "sync" && event.data.mode === "snapshot", { timeout });
    }, { id: created.id, timeout: WAIT_TIMEOUT_MS });
    const freshPane = await freshWorkbench.openTerminal({ id: created.id, name: created.name });
    await freshPane.expectVisible();
    const freshSync = await freshSyncPromise;
    expect(freshSync.data.mode).toBe("snapshot");
    const recovered = await freshPane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    expect(recovered.syncMode).toBe("snapshot");
    const recoveredSettled = await waitForSettledTerminal(freshPage, created.id, expectedSequence, liveMarker);
    expect(recoveredSettled.socketState).toBe("connected");
    expect(recoveredSettled.socketGeneration).toBe(1);
    expect(recoveredSettled.activeSocketCount).toBe(1);
    expect(recoveredSettled.activeBuffer).toBe("normal");
    expect(recoveredSettled.acceptingInput).toBe(true);
    expect(recoveredSettled.gridEpoch).toBe(checkpointEpoch);
    expect(recoveredSettled.cols).toBe(burstSettled.cols);
    expect(recoveredSettled.rows).toBe(burstSettled.rows);
    expect(recoveredSettled.serverViewport?.cols).toBe(recoveredSettled.cols);
    expect(recoveredSettled.serverViewport?.rows).toBe(recoveredSettled.rows);
    expect(countOccurrences(recoveredSettled.xterm.text, oldMarker)).toBe(0);
    expect(countOccurrences(recoveredSettled.xterm.text, liveMarker)).toBe(1);
    await expectTerminalBuffer(freshPage, created.id, { contains: liveMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(freshPage, freshPane.xtermHost, {
      testInfo,
      artifactName: "k-12-recovered-live-screen",
    });

    const afterPixels = await screenshotRegion(freshPage, freshPane.xtermHost);
    const afterFloor = eventId(await terminalEvents(freshPage, created.id));
    const afterCommitPromise = waitForParserMarker(freshPage, created.id, afterFloor, afterMarker);
    await freshPane.sendInput(`PRINT ${afterId} ${afterText}`, true);
    await server.waitForTranscript(created.id, (entry) => entry.event === "command" && entry.operation === "PRINT" && entry.id === afterId, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === afterId && entry.text === afterText, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(created.id, (entry) => entry.event === "write" && entry.bytes === printBytes(afterMarker), { timeoutMs: WAIT_TIMEOUT_MS });
    await afterCommitPromise;
    await expectTerminalBuffer(freshPage, created.id, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalPixelsChanged(afterPixels, await screenshotRegion(freshPage, freshPane.xtermHost), {
      minimumChangedRatio: 0.0001,
      testInfo,
      artifactName: "k-12-post-recovery-marker",
    });

    await expectTerminalInteractive(freshPage, created.id, { timeout: WAIT_TIMEOUT_MS });
    await freshPane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(created.id, (entry) => entry.event === "command" && entry.operation === "ECHO_INPUT" && entry.id === echoId, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(created.id, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(freshPage, created.id, { contains: echoReadyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await freshPane.insertText(echoText);
    await freshPane.press("Enter");
    await server.waitForTranscript(created.id, (entry) => (
      entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(echoText, "utf8").toString("base64")
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(freshPage, created.id, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const finalSnapshot = await waitForSettledTerminal(freshPage, created.id, recoveredSettled.committedSequence ?? expectedSequence, echoMarker);
    await expectTerminalConverged(freshPage, created.id, {
      cols: burstSettled.cols,
      rows: burstSettled.rows,
      pixelWidth: burstSettled.pixelWidth,
      pixelHeight: burstSettled.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    await expectNoPendingRecovery(freshPage, created.id, { timeout: WAIT_TIMEOUT_MS });
    const invariantReport = await expectConnectedTerminalInvariants(freshPage, created.id, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
    expect(finalSnapshot.socketState).toBe("connected");
    expect(finalSnapshot.activeSocketCount).toBe(1);
    expect(finalSnapshot.socket.activeCount).toBe(1);
    expect(finalSnapshot.acceptingInput).toBe(true);
    expect(finalSnapshot.pendingParserWrites).toBe(0);
    expect(finalSnapshot.pendingParserBytes).toBe(0);
    expect(finalSnapshot.renderBacklogBytes).toBe(0);
    expect(finalSnapshot.renderBacklogFrames).toBe(0);
    expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(finalSnapshot.serverViewport?.cols).toBe(finalSnapshot.cols);
    expect(finalSnapshot.serverViewport?.rows).toBe(finalSnapshot.rows);
    expect(finalSnapshot.rendererState.renderCount).toBeGreaterThan(0);
    expect(countOccurrences(finalSnapshot.xterm.text, oldMarker)).toBe(0);
    expect(countOccurrences(finalSnapshot.xterm.text, liveMarker)).toBe(1);
    expect(countOccurrences(finalSnapshot.xterm.text, afterMarker)).toBe(1);
    expect(countOccurrences(finalSnapshot.xterm.text, echoMarker)).toBe(1);

    const finalEvents = await terminalEvents(freshPage, created.id);
    await assertMonotonicSequences(finalEvents);
    expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "socket-stale")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);

    await recordingControl(freshPage, "stop");
    recordingActive = false;
    const recording = await recordingExport(freshPage);
    expect(recording.truncated).toBe(false);
    const acceptedCheckpoints = recording.events.filter((event) => {
      const message = recordingMessage(event);
      return event.terminal === created.id
        && message?.type === "recording"
        && message.event === "xterm checkpoint stored";
    });
    expect(acceptedCheckpoints.length).toBeGreaterThan(0);

    const uploadedMessages = recording.events
      .filter((event) => event.terminal === created.id)
      .map(recordingClientMessage)
      .filter((message): message is Record<string, unknown> => (
        message?.type === "checkpoint"
        && message.sequence === checkpointSequence
      ));
    expect(uploadedMessages).toHaveLength(checkpointChunks);
    const uploadedOffsets = uploadedMessages.map((message) => requiredNumber(message.offset, "recorded checkpoint offset"));
    expect(uploadedOffsets).toEqual(
      uploadedOffsets.map((_, index) => index * TERMINAL_CHECKPOINT_CHUNK_BYTES),
    );
    const uploadedBytes = uploadedMessages.map((message) => {
      if (typeof message.data !== "string") throw new Error("recorded checkpoint chunk omitted data");
      return Buffer.from(message.data, "base64");
    });
    expect(Buffer.concat(uploadedBytes).byteLength).toBe(checkpointSize);
    expect(uploadedBytes.every((bytes) => bytes.byteLength > 0 && bytes.byteLength <= TERMINAL_CHECKPOINT_CHUNK_BYTES)).toBe(true);
    expect(uploadedMessages.filter((message) => message.final === true)).toHaveLength(1);
    expect(uploadedMessages.at(-1)?.final).toBe(true);
    const targetClientIndex = recording.events.findIndex((event) => {
      const message = recordingClientMessage(event);
      return event.terminal === created.id
        && message?.type === "checkpoint"
        && message.sequence === checkpointSequence;
    });
    expect(targetClientIndex).toBeGreaterThanOrEqual(0);
    const acceptedCheckpointIndex = recording.events.findIndex((event, index) => {
      if (index <= targetClientIndex) return false;
      const message = recordingMessage(event);
      return event.terminal === created.id
        && message?.type === "recording"
        && message.event === "xterm checkpoint stored";
    });
    expect(acceptedCheckpointIndex).toBeGreaterThan(targetClientIndex);

    const targetSyncIndex = recording.events.findIndex((event, index) => {
      if (index <= acceptedCheckpointIndex) return false;
      const message = recordingMessage(event);
      return event.terminal === created.id
        && message?.type === "sync"
        && message.mode === "snapshot"
        && typeof message.sequence === "number"
        && message.sequence >= expectedSequence;
    });
    expect(targetSyncIndex).toBeGreaterThan(acceptedCheckpointIndex);


    const syncs = recordingControls(recording, created.id, "sync");
    expect(syncs.some((message) => message.mode === "snapshot" && typeof message.sequence === "number" && message.sequence >= expectedSequence)).toBe(true);
    const finalSync = syncs.at(-1);
    if (!finalSync) throw new Error("server recording omitted the recovery sync");
    expect(finalSync.mode).toBe("snapshot");
    expect(requiredNumber(finalSync.sequence, "recovery sync sequence")).toBeGreaterThanOrEqual(expectedSequence);

    const transcript = await server.readTranscript(created.id);
    const scenarioWrites = transcript
      .filter((entry) => entry.event === "write" && typeof entry.write_sequence === "number" && entry.write_sequence > baselineWriteSequence)
      .sort((left, right) => Number(left.write_sequence) - Number(right.write_sequence));
    expect(scenarioWrites.length).toBeGreaterThanOrEqual(5);
    expect(scenarioWrites.some((entry) => entry.event === "write" && entry.bytes === burstBytes)).toBe(true);
    expect(scenarioWrites.filter((entry) => entry.event === "write" && entry.bytes === printBytes(oldMarker))).toHaveLength(1);
    expect(scenarioWrites.filter((entry) => entry.event === "write" && entry.bytes === printBytes(liveMarker))).toHaveLength(1);
    const oldWrite = scenarioWrites.find((entry) => entry.bytes === printBytes(oldMarker));
    const liveWrite = scenarioWrites.find((entry) => entry.bytes === printBytes(liveMarker));
    const burstWrite = scenarioWrites.find((entry) => entry.bytes === burstBytes);
    if (!oldWrite || !liveWrite || !burstWrite) throw new Error("fixture transcript omitted a deterministic scenario write");
    expect(writeBytes(oldWrite)).toEqual(Buffer.from(`${oldMarker}\n`, "utf8"));
    expect(writeBytes(liveWrite)).toEqual(Buffer.from(`${liveMarker}\n`, "utf8"));
    expect(writeBytes(burstWrite)).toHaveLength(burstBytes);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === oldId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === burstBytes)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === liveId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === afterId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(transcript.filter((entry) => entry.event === "exit")).toEqual([]);

    const terminalInfo = await freshPage.evaluate(async (id) => {
      const response = await fetch("/api/terminals", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
      const terminals = await response.json() as Array<{ id?: unknown; clients?: unknown; status?: unknown }>;
      return terminals.find((terminal) => terminal.id === id);
    }, created.id);
    expect(terminalInfo?.status).toBe("running");
    expect(terminalInfo?.clients).toBe(1);

    const networkEvents = faultController.events.filter((event) => event.terminalId === created.id);
    expect(networkEvents.filter((event) => event.type === "socket-error")).toEqual([]);
    expect(networkEvents.filter((event) => event.type === "malformed-frame")).toEqual([]);
    expect(networkEvents.filter((event) => event.type === "connection-terminated").length).toBeGreaterThanOrEqual(1);
    expect(networkEvents.filter((event) => event.type === "connection-open").length).toBeGreaterThanOrEqual(2);

    expect(unexpectedBrowserErrors(browserErrors())).toEqual([]);
    expect(freshBrowserErrors ? unexpectedBrowserErrors(freshBrowserErrors()) : []).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error|out of memory|allocation failure)/i);
  } finally {
    if (recordingActive && recordingPage && !recordingPage.isClosed()) {
      await recordingControl(recordingPage, "stop");
    }
    freshBrowserErrors?.dispose();
    if (!page.isClosed()) browserErrors.dispose();
    await freshContext?.close();
  }
});
