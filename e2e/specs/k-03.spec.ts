import { test, expect } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultController } from "../fixtures/network-faults.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  expectTerminalSynchronized,
  terminalEvents,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
} from "../../src/client/lib/e2e-diagnostics.js";
import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
  TERMINAL_CHECKPOINT_IDLE_MS,
  TERMINAL_CHECKPOINT_MAX_INTERVAL_MS,
} from "../../src/client/lib/terminal-checkpoint.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

const WAIT_TIMEOUT_MS = 30_000;
const NO_EVENT_WINDOW_MS = 2 * TERMINAL_CHECKPOINT_MAX_INTERVAL_MS + TERMINAL_CHECKPOINT_IDLE_MS;

function countOccurrences(text: string, marker: string): number {
  const comparable = text.replace(/\s+/g, "");
  const expected = marker.replace(/\s+/g, "");
  let count = 0;
  let offset = 0;
  while ((offset = comparable.indexOf(expected, offset)) >= 0) {
    count += 1;
    offset += expected.length;
  }
  return count;
}

async function waitForParserCommitContaining(
  page: import("@playwright/test").Page,
  terminalId: string,
  afterEventId: number,
  marker: string,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "parser-commit"
        && event.snapshot.xterm.text.replace(/\s+/g, "").includes(expected.replace(/\s+/g, "")),
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, expected: marker, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCheckpointSent(
  page: import("@playwright/test").Page,
  terminalId: string,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "checkpoint"
        && event.data.result === "sent",
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

/** Wait on the bounded diagnostics event stream and fail if a matching event arrives. */
async function expectNoEvent(
  page: import("@playwright/test").Page,
  terminalId: string,
  afterEventId: number,
  eventType: E2ETerminalEvent["type"],
  durationMs: number,
): Promise<void> {
  const result = await page.evaluate(async ({ id, after, type, duration }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    try {
      const event = await api.waitForEvent(
        id,
        (candidate) => candidate.id > after && candidate.type === type,
        { timeout: duration },
      );
      return { timedOut: false as const, eventId: event.id };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Timed out after ")) {
        return { timedOut: true as const };
      }
      throw error;
    }
  }, { id: terminalId, after: afterEventId, type: eventType, duration: durationMs });
  if (!result.timedOut) {
    throw new Error(`unexpected ${eventType} diagnostics event ${result.eventId} after event ${afterEventId}`);
  }
}

function checkpointFrames(
  controller: NetworkFaultController,
  terminalId: string,
  generation: number,
): readonly NonNullable<NetworkFaultController["events"][number]["frame"]>[] {
  return controller.events
    .filter((event) => event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "checkpoint")
    .map((event) => event.frame)
    .filter((frame): frame is NonNullable<typeof frame> => frame !== undefined);
}

async function waitForCheckpointFrame(
  controller: NetworkFaultController,
  terminalId: string,
  generation: number,
  minimumOccurrence: number,
): Promise<void> {
  await controller.waitFor((event) => event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpoint"
    && (event.generation !== generation || (event.frame.occurrence >= minimumOccurrence)), {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
}

async function expectNoCheckpointFrame(
  controller: NetworkFaultController,
  terminalId: string,
  generation: number,
  afterOccurrence: number,
  durationMs: number,
): Promise<void> {
  try {
    await controller.waitFor((event) => event.type === "frame"
      && event.terminalId === terminalId
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "checkpoint"
      && (event.generation !== generation || (event.frame.occurrence > afterOccurrence)), {
      timeoutMs: durationMs,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("timed out waiting for network event")) return;
    throw error;
  }
  throw new Error("unexpected checkpoint upload frame during the unchanged-sequence observation");
}

test("K-03 No redundant checkpoint @p1 @checkpoint @dedupe @nightly", async ({ page, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `K03-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-READY`;
  const printId = `${runTag}-PRINT`;
  const printText = `${runTag}-IDLE-CHECKPOINT`;
  const echoId = `${runTag}-ECHO`;
  const inputText = `${runTag}-CONTINUED-INPUT`;
  const sizeId = `${runTag}-SIZE`;
  const readyMarker = `[E2E:READY:${readyId}]`;
  const printMarker = `[E2E:PRINT:${printId}:${printText}]`;
  const echoReadyMarker = `[E2E:ECHO_INPUT:${echoId}:READY]`;
  const inputBase64 = Buffer.from(inputText, "utf8").toString("base64");
  const inputMarker = `[E2E:ECHO_INPUT:${echoId}:${inputBase64}]`;

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
  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();
  await expect(pane.xtermHost.locator(".xterm-screen")).toBeVisible();

  const synchronized = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const initial = await expectTerminalConverged(page, terminalId, {
    cols: synchronized.cols,
    rows: synchronized.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.serverViewport).toBeDefined();
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  expect(initial.gridEpoch).toEqual(expect.any(Number));
  expect(initial.committedSequence).toEqual(expect.any(Number));
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await faultController.waitFor(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const beforePrintPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k-03-before-print-crop",
  });
  const beforeOutputEvents = await terminalEvents(page, terminalId);
  const beforeOutputEventId = beforeOutputEvents.at(-1)?.id ?? -1;
  const beforeCheckpointFrames = checkpointFrames(faultController, terminalId, initial.socketGeneration);
  const beforeCheckpointOccurrence = beforeCheckpointFrames.reduce(
    (maximum, frame) => Math.max(maximum, frame.occurrence),
    0,
  );

  const readyTranscript = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const printTranscript = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === printId && entry.text === printText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const printParserCommit = waitForParserCommitContaining(page, terminalId, beforeOutputEventId, printMarker);
  await pane.sendInput(`READY ${readyId}`, true);
  await pane.sendInput(`PRINT ${printId} ${printText}`, true);
  await Promise.all([readyTranscript, printTranscript, printParserCommit]);
  const committedPrint = await printParserCommit;
  await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: printMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  const printedPixels = await expectKnownMarkerChanged(page, pane.xtermHost, beforePrintPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "k-03-print-marker-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k-03-print-crop",
  });

  const checkpointEvent = await waitForCheckpointSent(page, terminalId, committedPrint.id);
  const checkpoint = checkpointEvent.snapshot.checkpoint;
  expect(checkpointEvent.data.result).toBe("sent");
  expect(checkpoint.sequence).toEqual(expect.any(Number));
  expect(checkpoint.epoch).toEqual(expect.any(Number));
  expect(checkpoint.size).toBeGreaterThan(0);
  expect(checkpoint.chunks).toBe(Math.ceil(checkpoint.size / TERMINAL_CHECKPOINT_CHUNK_BYTES));
  expect(checkpoint.serializationDurationMs).toBeGreaterThanOrEqual(0);
  expect(checkpoint.uploadDurationMs).toBeGreaterThanOrEqual(0);
  const checkpointSnapshot = { ...checkpoint };
  const checkpointSequence = checkpoint.sequence;
  const checkpointEpoch = checkpoint.epoch;
  if (checkpointSequence === undefined || checkpointEpoch === undefined) {
    throw new Error("sent checkpoint did not report its sequence and epoch");
  }
  expect(checkpointSequence).toBe(checkpointEvent.snapshot.committedSequence);
  expect(checkpointEpoch).toBe(checkpointEvent.snapshot.gridEpoch);
  expect(checkpointEvent.snapshot.receivedSequence).toBe(checkpointSequence);

  await waitForCheckpointFrame(
    faultController,
    terminalId,
    initial.socketGeneration,
    beforeCheckpointOccurrence + checkpoint.chunks,
  );
  const uploadedCheckpointFrames = checkpointFrames(faultController, terminalId, initial.socketGeneration);
  expect(uploadedCheckpointFrames.length - beforeCheckpointFrames.length).toBe(checkpoint.chunks);
  const stableBeforeObservation = await pane.snapshot();
  if (!stableBeforeObservation) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  expect(stableBeforeObservation.socketGeneration).toBe(initial.socketGeneration);
  expect(stableBeforeObservation.socketState).toBe("connected");
  expect(stableBeforeObservation.activeSocketCount).toBe(1);
  expect(stableBeforeObservation.committedSequence).toBe(checkpointSequence);
  expect(stableBeforeObservation.receivedSequence).toBe(checkpointSequence);
  expect(stableBeforeObservation.gridEpoch).toBe(checkpointEpoch);
  expect(stableBeforeObservation.checkpoint).toEqual(checkpointSnapshot);
  const stableOccurrence = uploadedCheckpointFrames.reduce(
    (maximum, frame) => Math.max(maximum, frame.occurrence),
    beforeCheckpointOccurrence,
  );

  await Promise.all([
    expectNoEvent(page, terminalId, checkpointEvent.id, "checkpoint", NO_EVENT_WINDOW_MS),
    expectNoCheckpointFrame(
      faultController,
      terminalId,
      initial.socketGeneration,
      stableOccurrence,
      NO_EVENT_WINDOW_MS,
    ),
  ]);

  const observationEvents = await terminalEvents(page, terminalId);
  const observationEndEventId = observationEvents.at(-1)?.id ?? checkpointEvent.id;
  expect(observationEvents.filter((event) => event.type === "checkpoint" && event.id > checkpointEvent.id && event.id <= observationEndEventId)).toHaveLength(0);
  const afterObservation = await pane.snapshot();
  if (!afterObservation) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  expect(afterObservation.socketGeneration).toBe(initial.socketGeneration);
  expect(afterObservation.socketState).toBe("connected");
  expect(afterObservation.activeSocketCount).toBe(1);
  expect(afterObservation.acceptingInput).toBe(true);
  expect(afterObservation.pendingParserWrites).toBe(0);
  expect(afterObservation.pendingParserBytes).toBe(0);
  expect(afterObservation.renderBacklogBytes).toBe(0);
  expect(afterObservation.renderBacklogFrames).toBe(0);
  expect(afterObservation.syncMode).toBeUndefined();
  expect(afterObservation.receivedSequence).toBe(stableBeforeObservation.receivedSequence);
  expect(afterObservation.committedSequence).toBe(stableBeforeObservation.committedSequence);
  expect(afterObservation.gridEpoch).toBe(stableBeforeObservation.gridEpoch);
  expect(afterObservation.xterm.text).toBe(stableBeforeObservation.xterm.text);
  expect(afterObservation.checkpoint).toEqual(checkpointSnapshot);
  expect(checkpointFrames(faultController, terminalId, initial.socketGeneration)).toHaveLength(uploadedCheckpointFrames.length);
  expect(afterObservation.checkpointSequence).toBe(checkpointSequence);
  expect(afterObservation.checkpointEpoch).toBe(checkpointEpoch);
  expect(afterObservation.checkpointSize).toBe(checkpoint.size);
  expect(afterObservation.checkpointChunks).toBe(checkpoint.chunks);
  expect(afterObservation.checkpointResult).toBe("sent");
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k-03-idle-observation-crop",
  });

  const beforeInputPixels = await screenshotRegion(page, pane.xtermHost);
  const echoArmed = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await echoArmed;
  await expectTerminalBuffer(page, terminalId, { contains: echoReadyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const echoedPayload = server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(inputText, true);
  const echo = await echoedPayload;
  expect(echo.payload_base64).toBe(inputBase64);
  await expectTerminalBuffer(page, terminalId, { contains: inputMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const inputPixels = await expectKnownMarkerChanged(page, pane.xtermHost, beforeInputPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "k-03-input-marker-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k-03-final-crop",
  });
  expect(inputPixels.after.width).toBe(printedPixels.after.width);
  expect(inputPixels.after.height).toBe(printedPixels.after.height);

  const sizeTranscript = server.waitForTranscript<{ event: string; id: string; rows: number; cols: number }>(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await sizeTranscript;
  const finalSnapshot = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(size.cols).toBe(finalSnapshot.cols);
  expect(size.rows).toBe(finalSnapshot.rows);
  await expectTerminalConverged(page, terminalId, {
    cols: initial.cols,
    rows: initial.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  const finalText = finalSnapshot.xterm.text;
  const sizeMarker = `[E2E:SIZE:${sizeId}:${size.rows}:${size.cols}]`;
  for (const marker of [readyMarker, printMarker, echoReadyMarker, inputMarker, sizeMarker]) {
    expect(countOccurrences(finalText, marker), `terminal model marker duplicated or missing: ${marker}`).toBe(1);
  }
  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === printId && entry.text === printText)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload" && entry.payload_base64 === inputBase64)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "write" && entry.text === `${printMarker}\n`)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "write" && entry.text === `${inputMarker}\n`)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(server.stderr).not.toMatch(/panicked at|internal server error/i);

  const expectedCommands = [
    `READY ${readyId}`,
    `PRINT ${printId} ${printText}`,
    `ECHO_INPUT ${echoId}`,
    inputText,
    `SIZE ${sizeId}`,
  ];
  for (const command of expectedCommands) {
    const encoded = Buffer.from(command, "utf8").toString("base64");
    expect(transcript.filter((entry) => entry.event === "command" && entry.command_base64 === encoded), `fixture command duplicated or omitted: ${command}`).toHaveLength(1);
  }

  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "state" && ["disconnected", "recovering"].includes(String(event.data.state)))).toHaveLength(0);
  expect(faultController.events.filter((event) => event.type === "connection-terminated" && event.terminalId === terminalId)).toHaveLength(0);
  expect(faultController.events.filter((event) => event.type === "connection-closed" && event.terminalId === terminalId)).toHaveLength(0);
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(finalSnapshot.socketGeneration).toBe(initial.socketGeneration);
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.syncTarget === undefined || finalSnapshot.committedSequence === undefined || finalSnapshot.committedSequence >= finalSnapshot.syncTarget).toBe(true);
  expect(browserErrors()).toEqual([]);
  browserErrors.dispose();
});
