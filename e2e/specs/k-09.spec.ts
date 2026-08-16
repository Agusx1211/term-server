import { Buffer } from "node:buffer";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultDisposer, NetworkFaultEvent } from "../fixtures/network-faults.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_CHECKPOINT_CHUNK_BYTES } from "../../src/client/lib/terminal-checkpoint.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
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
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 45_000;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};
interface CheckpointEventData {
  readonly sequence?: number;
  readonly epoch?: number;
  readonly size?: number;
  readonly chunks?: number;
  readonly serializationDurationMs?: number;
  readonly uploadDurationMs?: number;
  readonly result?: string;
}
interface CreatedTerminal {
  readonly id: string;
  readonly name: string;
}

async function createFixtureTerminal(
  page: Page,
  terminalPath: string,
  shell: string,
): Promise<CreatedTerminal> {
  return page.evaluate(async ({ path, shellPath }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, cwd: "/tmp", shell: shellPath }),
    });
    if (!response.ok) throw new Error(`terminal creation failed (${response.status})`);
    const terminal = await response.json() as Partial<CreatedTerminal>;
    if (typeof terminal.id !== "string" || typeof terminal.name !== "string") {
      throw new Error("terminal creation response is missing identity");
    }
    return { id: terminal.id, name: terminal.name };
  }, { path: terminalPath, shellPath: shell });
}

interface RecordedEvent {
  readonly type?: unknown;
  readonly terminal?: unknown;
  readonly sequence?: unknown;
  readonly data?: unknown;
  readonly message?: unknown;
}

interface RecordingExport {
  readonly truncated?: unknown;
  readonly events?: readonly RecordedEvent[];
}

async function recordingControl(
  page: Page,
  action: "clear" | "start" | "stop",
): Promise<Record<string, unknown>> {
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
function countOccurrences(text: string, expected: string): number {
  const comparable = text.replace(/\s+/g, "");
  const marker = expected.replace(/\s+/g, "");
  let count = 0;
  let offset = 0;
  while ((offset = comparable.indexOf(marker, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, marker.length);
  }
  return count;
}


async function waitForRendered(
  page: Page,
  terminalId: string,
  minimumRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimumRenderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > minimumRenderCount
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, minimumRenderCount, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCheckpoint(
  page: Page,
  terminalId: string,
  afterEventId: number,
  sequence: number,
  epoch: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, afterEventId, expectedSequence, expectedEpoch, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > afterEventId
      && event.type === "checkpoint"
      && event.snapshot.activeBuffer === "alternate"
      && event.data.result === "sent"
      && event.data.sequence === expectedSequence
      && event.data.epoch === expectedEpoch
    ), { timeout, afterId: afterEventId });
  }, {
    id: terminalId,
    afterEventId,
    expectedSequence: sequence,
    expectedEpoch: epoch,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForSnapshotSync(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === "sync" && event.data.mode === "snapshot"
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

// Binary checkpoint chunk frames carry kind byte 2 and the upload sequence in
// their nine-byte header; the proxy decodes them as binaryKind and sequence.
// The JSON `checkpointBinary` announcement that precedes them is not a chunk
// and is deliberately excluded, so this count stays comparable to the
// diagnostics chunk count.
function checkpointFrameCount(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
): number {
  return events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.binaryKind === 2
  )).length;
}

test("K-09 Normal and alternate buffer checkpoint @p1 @nightly @checkpoint @alternate-buffer", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo: TestInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);

  const runTag = `K09-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const normalId = `${runTag}-normal`;
  const normalText = `${runTag}-normal-history`;
  const altEnterId = `${runTag}-alt-enter`;
  const repaintId = `${runTag}-repaint`;
  const altExitId = `${runTag}-alt-exit`;
  const echoId = `${runTag}-echo`;
  const inputText = `${runTag}-continued-input`;
  const sizeId = `${runTag}-size`;
  const normalMarker = `[E2E:PRINT:${normalId}:${normalText}]`;
  const altEnterMarker = `[E2E:ALT_ENTER:${altEnterId}]`;
  const repaintMarker = `[E2E:REPAINT:${repaintId}:FRAME]`;
  const altExitMarker = `[E2E:ALT_EXIT:${altExitId}]`;
  const echoReadyMarker = `[E2E:ECHO_INPUT:${echoId}:READY]`;
  const echoPayloadMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(inputText, "utf8").toString("base64")}]`;
  const repaintFrame = `\u001b[2J\u001b[H[E2E:REPAINT:${repaintId}:FRAME]\u001b[1;1Hagent-00\u001b[2;1Hagent-01\u001b[3;1Hagent-02\u001b[4;1H\u001b[2Kfooter\n`;
  const repaintBytes = Buffer.byteLength(repaintFrame, "utf8") * 8;

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const clearRecording = await recordingControl(page, "clear");
  expect(clearRecording.active).toBe(false);
  const startRecording = await recordingControl(page, "start");
  expect(startRecording.active).toBe(true);
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const created = await createFixtureTerminal(page, `k09-${runTag}`, server.fixturePath);
  await page.reload({ waitUntil: "load" });
  await workbench.expectVisible();
  const mountPromise = page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.snapshot.kind === "pane" && event.terminalId === id,
      { timeout },
    );
  }, { id: created.id, timeout: WAIT_TIMEOUT_MS });
  const pane = await workbench.openTerminal({ id: created.id, name: created.name });
  const mounted = await mountPromise;
  expect(mounted.terminalId).toBe(created.id);
  const terminalId = created.id;
  await pane.expectVisible();

  const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.activeBuffer).toBe("normal");
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.acceptingInput).toBe(true);
  expect(initial.gridEpoch).toEqual(expect.any(Number));
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  const initialDimensions = {
    cols: initial.cols,
    rows: initial.rows,
    pixelWidth: initial.pixelWidth,
    pixelHeight: initial.pixelHeight,
  } as const;
  await expectTerminalConverged(page, terminalId, initialDimensions, { timeout: WAIT_TIMEOUT_MS });

  const beforeNormal = await screenshotRegion(page, pane.xtermHost);
  const beforeNormalRenderCount = initial.renderCount;
  await pane.sendInput(`PRINT ${normalId} ${normalText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === normalId && entry.text === normalText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: normalMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const normalSettled = await waitForRendered(page, terminalId, beforeNormalRenderCount);
  expect(normalSettled.activeBuffer).toBe("normal");
  expect(countOccurrences(normalSettled.xterm.text, normalMarker)).toBe(1);
  await expectKnownMarkerChanged(page, pane.xtermHost, beforeNormal, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "k-09-normal-marker",
  });

  const beforeAlternate = await terminalSnapshot(page, terminalId);
  if (!beforeAlternate) throw new Error(`missing normal-buffer diagnostics for terminal ${terminalId}`);
  const beforeAlternatePixels = await screenshotRegion(page, pane.xtermHost);
  await pane.sendInput(`ALT_ENTER ${altEnterId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "alt_enter" && entry.id === altEnterId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: altEnterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const enteredAlternate = await waitForTerminalState(page, terminalId, {
    activeBuffer: "alternate",
    pendingParserWrites: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(countOccurrences(enteredAlternate.xterm.text, normalMarker)).toBe(0);
  expect(enteredAlternate.activeBuffer).toBe("alternate");

  const eventsBeforeCheckpoint = await terminalEvents(page, terminalId);
  const checkpointEventFloor = eventsBeforeCheckpoint.at(-1)?.id ?? 0;
  const initialProxyConnection = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
  );
  if (!initialProxyConnection || initialProxyConnection.generation === undefined) {
    throw new Error(`missing reverse-proxy connection generation for terminal ${terminalId}`);
  }
  const initialProxyGeneration = initialProxyConnection.generation;
  expect(initialProxyGeneration).toBe(enteredAlternate.socketGeneration);
  const checkpointFramesBefore = checkpointFrameCount(
    faultController.events,
    terminalId,
    initialProxyGeneration,
  );

  await pane.sendInput(`REPAINT ${repaintId} ${repaintBytes}`, true);
  const repaint = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "repaint" && entry.id === repaintId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(repaint.bytes).toBe(repaintBytes);
  await expectTerminalBuffer(page, terminalId, { contains: repaintMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const alternateSettled = await waitForTerminalState(page, terminalId, {
    activeBuffer: "alternate",
    pendingParserWrites: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(countOccurrences(alternateSettled.xterm.text, repaintMarker)).toBe(1);
  expect(alternateSettled.xterm.text).toContain("footer");
  expect(countOccurrences(alternateSettled.xterm.text, normalMarker)).toBe(0);
  if (alternateSettled.committedSequence === undefined || alternateSettled.gridEpoch === undefined) {
    throw new Error("alternate-buffer diagnostics did not expose a committed sequence and grid epoch");
  }
  const checkpointPromise = waitForCheckpoint(
    page,
    terminalId,
    checkpointEventFloor,
    alternateSettled.committedSequence,
    alternateSettled.gridEpoch,
  );

  const checkpoint = await checkpointPromise;
  const checkpointData = checkpoint.data as CheckpointEventData;
  if (
    typeof checkpointData.sequence !== "number"
    || typeof checkpointData.epoch !== "number"
    || typeof checkpointData.size !== "number"
    || typeof checkpointData.chunks !== "number"
    || typeof checkpointData.serializationDurationMs !== "number"
    || typeof checkpointData.uploadDurationMs !== "number"
  ) {
    throw new Error("alternate-buffer checkpoint event omitted sequence, epoch, size, chunks, or timings");
  }
  expect(checkpoint.snapshot.activeBuffer).toBe("alternate");
  expect(checkpoint.snapshot.checkpointResult).toBe("sent");
  expect(checkpoint.snapshot.checkpointSequence).toBe(checkpointData.sequence);
  expect(checkpoint.snapshot.checkpointEpoch).toBe(checkpointData.epoch);
  expect(checkpoint.snapshot.checkpointSize).toBe(checkpointData.size);
  expect(checkpoint.snapshot.checkpointChunks).toBe(checkpointData.chunks);
  expect(checkpointData.sequence).toBe(alternateSettled.committedSequence);
  expect(checkpointData.epoch).toBe(alternateSettled.gridEpoch);
  expect(checkpointData.size).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
  expect(checkpointData.serializationDurationMs).toBeGreaterThanOrEqual(0);
  expect(checkpointData.uploadDurationMs).toBeGreaterThanOrEqual(0);
  expect(checkpointData.size).toBeGreaterThan(0);
  expect(checkpointData.chunks).toBe(Math.ceil(checkpointData.size / TERMINAL_CHECKPOINT_CHUNK_BYTES));
  const checkpointFrames = await faultController.waitFor((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === initialProxyGeneration
    && event.direction === "browser-to-server"
    && event.frame?.binaryKind === 2
    && checkpointFrameCount(faultController.events, terminalId, initialProxyGeneration)
      >= checkpointFramesBefore + checkpointData.chunks!
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(checkpointFrames.type).toBe("frame");
  expect(checkpointFrameCount(faultController.events, terminalId, initialProxyGeneration) - checkpointFramesBefore)
    .toBe(checkpointData.chunks);

  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k-09-alternate-before-fault",
  });
  await expectTerminalPixelsChanged(beforeAlternatePixels, await screenshotRegion(page, pane.xtermHost), {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "k-09-alternate-marker",
  });

  const beforeFault = await terminalSnapshot(page, terminalId);
  if (!beforeFault) throw new Error(`missing alternate-buffer diagnostics before fault for terminal ${terminalId}`);
  expect(beforeFault.activeBuffer).toBe("alternate");
  expect(beforeFault.socketGeneration).toBe(initialProxyGeneration);
  const pausedRule = faultController.pause("server-to-browser", {
    terminalId,
    generation: initialProxyGeneration,
  });
  let terminateRule: NetworkFaultDisposer | undefined;
  try {
    await faultController.waitFor(
      (event) => event.type === "paused"
        && event.terminalId === terminalId
        && event.generation === initialProxyGeneration
        && event.direction === "server-to-browser"
        && event.ruleId === pausedRule.id,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const socketClosed = page.evaluate(async ({ id, generation, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent(id, (event) => (
        event.type === "socket-close" && event.data.generation === generation
      ), { timeout });
    }, { id: terminalId, generation: beforeFault.socketGeneration, timeout: WAIT_TIMEOUT_MS });
    const proxyTerminated = faultController.waitFor(
      (event) => event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.generation === initialProxyGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    terminateRule = faultController.terminate({ terminalId, generation: initialProxyGeneration });
    const [closedEvent, terminatedEvent] = await Promise.all([socketClosed, proxyTerminated]);
    expect(closedEvent.data.generation).toBe(beforeFault.socketGeneration);
    expect(terminatedEvent.type).toBe("connection-terminated");
    expect(terminatedEvent.abrupt).toBe(true);
  } finally {
    terminateRule?.dispose();
    pausedRule.dispose();
    faultController.resume("server-to-browser", {
      terminalId,
      generation: initialProxyGeneration,
    });
  }

  await page.reload({ waitUntil: "load" });
  await expect(page.locator(".workbench")).toBeVisible();
  const recoveredPane = new TerminalPanePage(page, terminalId);
  await recoveredPane.expectVisible();
  const recoveredSync = await waitForSnapshotSync(page, terminalId);
  expect(recoveredSync.data.mode).toBe("snapshot");
  const recoveredProxy = await faultController.waitFor(
    (event) => event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation !== undefined
      && event.generation > initialProxyGeneration,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(recoveredProxy.generation).toBeGreaterThan(initialProxyGeneration);
  const recovered = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    activeBuffer: "alternate",
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(recovered.socketGeneration).toBe(1);
  expect(recovered.activeSocketCount).toBe(1);
  expect(recovered.gridEpoch).toBe(checkpointData.epoch);
  expect(recovered.xterm.activeBuffer).toBe("alternate");
  expect(countOccurrences(recovered.xterm.text, repaintMarker)).toBe(1);
  expect(countOccurrences(recovered.xterm.text, normalMarker)).toBe(0);
  expect(recovered.xterm.text).toContain("footer");
  expect(countOccurrences(recovered.xterm.text, altExitMarker)).toBe(0);
  expect(recovered.syncTarget === undefined || recovered.committedSequence === undefined || recovered.committedSequence >= recovered.syncTarget).toBe(true);
  const stoppedRecording = await recordingControl(page, "stop");
  expect(stoppedRecording.active).toBe(false);
  const recording = await exportRecording(page);
  expect(recording.truncated).toBe(false);
  if (!recording.events) throw new Error("server debug recording did not include an event list");
  const recordingEvents = recording.events.filter((event) => event.terminal === terminalId);
  const checkpointNotes = recordingEvents.filter((event) => {
    const message = recordingMessage(event);
    return message?.type === "note" && message.event === "xterm checkpoint stored";
  });
  expect(checkpointNotes).toHaveLength(1);
  const recoveryTarget = recoveredSync.data.sequence;
  if (typeof recoveryTarget !== "number") throw new Error("snapshot sync did not expose a numeric target sequence");
  expect(recoveryTarget).toBe(checkpointData.sequence);
  const snapshotEvents = recordingEvents.filter((event) => (
    event.type === "snapshot" && event.sequence === recoveryTarget
  ));
  expect(snapshotEvents.length).toBeGreaterThan(0);
  const snapshotPayloads = snapshotEvents
    .map(recordingBytes)
    .filter((payload): payload is Buffer => payload !== undefined);
  expect(snapshotPayloads.some((payload) => payload.toString("utf8").includes(repaintMarker))).toBe(true);
  await expectTerminalConverged(page, terminalId, {
    cols: recovered.cols,
    rows: recovered.rows,
    pixelWidth: recovered.pixelWidth,
    pixelHeight: recovered.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, recoveredPane.xtermHost, {
    testInfo,
    artifactName: "k-09-recovered-alternate",
  });

  const beforeExit = await terminalSnapshot(page, terminalId);
  if (!beforeExit) throw new Error(`missing recovered alternate diagnostics for terminal ${terminalId}`);
  const beforeExitPixels = await screenshotRegion(page, recoveredPane.xtermHost);
  await recoveredPane.sendInput(`ALT_EXIT ${altExitId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "alt_exit" && entry.id === altExitId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: normalMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const exited = await waitForRendered(page, terminalId, beforeExit.renderCount);
  expect(countOccurrences(exited.xterm.text, normalMarker)).toBe(1);
  expect(countOccurrences(exited.xterm.text, altExitMarker)).toBe(1);
  expect(exited.activeBuffer).toBe("normal");
  expect(countOccurrences(exited.xterm.text, repaintMarker)).toBe(0);
  expect(exited.xterm.text).not.toContain("footer");
  await expectTerminalPixelsChanged(beforeExitPixels, await screenshotRegion(page, recoveredPane.xtermHost), {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "k-09-normal-restored",
  });
  await expectTerminalNonBlank(page, recoveredPane.xtermHost, {
    testInfo,
    artifactName: "k-09-normal-restored-terminal",
  });

  await recoveredPane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: echoReadyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await recoveredPane.sendInput(inputText, true);
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

  await recoveredPane.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(size.cols).toBe(exited.cols);
  expect(size.rows).toBe(exited.rows);
  expect(size.pixel_width).toBe(exited.pixelWidth);
  expect(size.pixel_height).toBe(exited.pixelHeight);
  const sizeMarker = `[E2E:SIZE:${sizeId}:${size.rows}:${size.cols}]`;
  await expectTerminalBuffer(page, terminalId, { contains: sizeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const finalSnapshot = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    activeBuffer: "normal",
    activeSocketCount: 1,
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(countOccurrences(finalSnapshot.xterm.text, normalMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, echoPayloadMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, altExitMarker)).toBe(1);
  expect(finalSnapshot.lifecycle.mounted).toBe(true);
  expect(finalSnapshot.lifecycle.visible).toBe(true);
  expect(finalSnapshot.lifecycle.active).toBe(true);
  expect(finalSnapshot.lifecycle.acceptingInput).toBe(true);
  expect(finalSnapshot.serverViewport?.cols).toBe(finalSnapshot.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(finalSnapshot.rows);
  expect(finalSnapshot.gridEpoch).toBe(checkpointData.epoch);
  expect(finalSnapshot.xterm.activeBuffer).toBe("normal");
  expect(countOccurrences(finalSnapshot.xterm.text, normalMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, echoPayloadMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, sizeMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, repaintMarker)).toBe(0);
  expect(countOccurrences(finalSnapshot.xterm.text, altEnterMarker)).toBe(0);
  expect(countOccurrences(finalSnapshot.xterm.text, altExitMarker)).toBe(1);
  expect(finalSnapshot.checkpointResult).not.toBe("failed");
  expect(finalSnapshot.renderCount).toBeGreaterThan(0);
  expect(finalSnapshot.rendererState.renderCount).toBe(finalSnapshot.renderCount);
  expect(finalSnapshot.activeSocketCount).toBe(finalSnapshot.socket.activeCount);
  await expectTerminalConverged(page, terminalId, {
    cols: finalSnapshot.cols,
    rows: finalSnapshot.rows,
    pixelWidth: finalSnapshot.pixelWidth,
    pixelHeight: finalSnapshot.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, recoveredPane.xtermHost, {
    testInfo,
    artifactName: "k-09-final-terminal",
  });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  assertNoPendingSynchronization(finalSnapshot);
  assertNoUnexpectedSocketMultiplication([beforeAlternate, alternateSettled, beforeFault, recovered, finalSnapshot]);

  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toEqual([]);
  const finalStateEvents = finalEvents.filter((event) => event.type === "state");
  const lastState = finalStateEvents.at(-1);
  if (lastState) expect(lastState.data.state).toBe("connected");
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });


  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === normalId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "alt_enter" && entry.id === altEnterId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === repaintBytes)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "alt_exit" && entry.id === altExitId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  const winches = transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal");
  expect(winches.length).toBeGreaterThan(0);
  let previousWinchSequence = 0;
  for (const winch of winches) {
    const sequence = Number(winch.signal_sequence);
    expect(Number.isInteger(sequence)).toBe(true);
    expect(sequence).toBeGreaterThan(previousWinchSequence);
    previousWinchSequence = sequence;
  }
  const latestWinch = winches.at(-1);
  if (!latestWinch) throw new Error("SIGWINCH transcript entry disappeared");
  expect(latestWinch.rows).toBe(finalSnapshot.rows);
  expect(latestWinch.cols).toBe(finalSnapshot.cols);
  expect(latestWinch.pixel_width).toBe(finalSnapshot.pixelWidth);
  expect(latestWinch.pixel_height).toBe(finalSnapshot.pixelHeight);
  expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
  expect(server.stderr).not.toMatch(/\bpanic\b|\binternal server error\b/i);
  const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
  expect(networkEvents.filter((event) => event.type === "socket-error")).toHaveLength(0);
  expect(networkEvents.filter((event) => event.type === "malformed-frame")).toHaveLength(0);
  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
  browserErrors.dispose();
});
