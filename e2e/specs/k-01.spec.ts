import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
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
import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
  TERMINAL_CHECKPOINT_IDLE_MS,
  TERMINAL_CHECKPOINT_MAX_INTERVAL_MS,
} from "../../src/client/lib/terminal-checkpoint.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 45_000;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const IDLE_TIMER_TOLERANCE_MS = 100;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
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

async function waitForSettledTerminal(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.serverViewport !== undefined
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForCommittedMarker(
  page: Page,
  terminalId: string,
  afterEventId: number,
  visibleMarker: string,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, markerText, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "parser-commit"
        && event.snapshot.committedSequence !== undefined
        && event.snapshot.xterm.text.includes(markerText),
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, markerText: visibleMarker, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRenderedMarker(
  page: Page,
  terminalId: string,
  afterEventId: number,
  visibleMarker: string,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, markerText, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "render"
        && event.snapshot.xterm.text.includes(markerText),
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, markerText: visibleMarker, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCheckpoint(
  page: Page,
  terminalId: string,
  afterEventId: number,
  sequence: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, sequence: targetSequence, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "checkpoint"
        && event.data.result === "sent"
        && event.data.sequence === targetSequence,
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, sequence, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCheckpointAnnouncement(
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
  sequence: number,
  afterOccurrence: number,
): Promise<NetworkFaultEvent> {
  return faultController.waitFor((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpointBinary"
    && event.frame.sequence === sequence
    && event.frame.occurrence > afterOccurrence
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

/**
 * The live browser uploads checkpoints as a `checkpointBinary` announcement
 * followed by binary body frames whose nine-byte header carries kind byte 2
 * and the announced sequence, which the proxy already decodes as `binaryKind`
 * and `sequence`.
 */
function binaryCheckpointBodyFrames(
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
    && event.frame?.binaryKind === 2
    && event.frame.sequence === sequence
  ));
}

test("K-01 Idle checkpoint @nightly @p1 @checkpoint @checkpoint-idle", async ({
  page,
  server,
  faultController,
  baseURL,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `K01-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const terminalPath = `k01-${runTag}`;
  const readyId = `${runTag}-READY`;
  const printId = `${runTag}-PRINT`;
  const printText = `${runTag}-IDLE-MARKER`;
  const echoId = `${runTag}-ECHO`;
  const echoText = `${runTag}-CONTINUED-INPUT`;
  const sizeId = `${runTag}-SIZE`;
  const readyMarker = marker("READY", readyId);
  const printMarker = marker("PRINT", printId, printText);
  const echoMarker = marker("ECHO_INPUT", echoId, Buffer.from(echoText, "utf8").toString("base64"));

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const created = await createFixtureTerminal(page, terminalPath, server.fixturePath);
  await page.reload();
  await workbench.expectVisible();

  const mountedPromise = waitForMountedPane(page, created.id);
  const pane = await workbench.openTerminal({ id: created.id, name: created.name });
  const mounted = await mountedPromise;
  expect(mounted.terminalId).toBe(created.id);
  await pane.expectVisible();
  await pane.expectConnected();
  await pane.focus();

  const diagnosticsInstalled = await page.evaluate(() => Boolean(
    (window as E2EWindow).__TERM_SERVER_E2E__,
  ));
  expect(diagnosticsInstalled).toBe(true);
  const initial = await waitForSettledTerminal(page, created.id);
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  expect(initial.serverViewport?.pixelWidth).toBe(initial.pixelWidth);
  expect(initial.serverViewport?.pixelHeight).toBe(initial.pixelHeight);

  const initialWinch = await server.waitForTranscript(created.id, (entry) => (
    entry.event === "sigwinch"
    && entry.source === "signal"
    && entry.rows === initial.rows
    && entry.cols === initial.cols
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(initialWinch.pixel_width).toBe(initial.pixelWidth);
  expect(initialWinch.pixel_height).toBe(initial.pixelHeight);

  const readyFloor = (await pane.events()).at(-1)?.id ?? mounted.id;
  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(created.id, (entry) => (
    entry.event === "command" && entry.operation === "READY" && entry.id === readyId
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(created.id, (entry) => (
    entry.event === "ready" && entry.id === readyId
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const readyCommit = await waitForCommittedMarker(page, created.id, readyFloor, readyMarker);
  const readySequence = requiredNumber(readyCommit.data.sequence, "READY parser sequence");
  expect(readyCommit.snapshot.committedSequence).toBe(readySequence);
  await expectTerminalBuffer(page, created.id, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  // Establish an idle boundary after the fixture's readiness marker so the
  // checkpoint under test is measured from the subsequent PRINT commit.
  const readyCheckpoint = await waitForCheckpoint(page, created.id, readyFloor, readySequence);
  const readyGeneration = readyCheckpoint.snapshot.socketGeneration;
  const readyFrame = await waitForCheckpointAnnouncement(
    faultController,
    created.id,
    readyGeneration,
    readySequence,
    0,
  );
  const readyOccurrence = requiredNumber(readyFrame.frame?.occurrence, "READY checkpoint announcement occurrence");
  expect(readyCheckpoint.data.result).toBe("sent");
  expect(readyCheckpoint.data.sequence).toBe(readySequence);

  const beforePrint = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k-01-before-idle-checkpoint",
  });

  const printFloor = readyCheckpoint.id;
  const targetFrameOccurrenceFloor = readyOccurrence;
  await pane.sendInput(`PRINT ${printId} ${printText}`, true);
  await server.waitForTranscript(created.id, (entry) => (
    entry.event === "command" && entry.operation === "PRINT" && entry.id === printId
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(created.id, (entry) => (
    entry.event === "print" && entry.id === printId && entry.text === printText
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const printCommit = await waitForCommittedMarker(page, created.id, printFloor, printMarker);
  const printSequence = requiredNumber(printCommit.data.sequence, "PRINT parser sequence");
  expect(printSequence).toBe(printCommit.snapshot.committedSequence);
  expect(printSequence).toBeGreaterThan(readySequence);
  await waitForRenderedMarker(page, created.id, printCommit.id, printMarker);
  await expectTerminalBuffer(page, created.id, { contains: printMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const { after: afterPrint } = await expectKnownMarkerChanged(page, pane.xtermHost, beforePrint, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "k-01-idle-checkpoint-marker-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k-01-after-idle-checkpoint",
  });
  expect(afterPrint.width).toBe(beforePrint.width);
  expect(afterPrint.height).toBe(beforePrint.height);

  const checkpoint = await waitForCheckpoint(page, created.id, printFloor, printSequence);
  const checkpointSequence = requiredNumber(checkpoint.data.sequence, "checkpoint sequence");
  const checkpointEpoch = requiredNumber(checkpoint.data.epoch, "checkpoint epoch");
  const checkpointSize = requiredNumber(checkpoint.data.size, "checkpoint size");
  const checkpointChunks = requiredNumber(checkpoint.data.chunks, "checkpoint chunks");
  const serializationDuration = requiredNumber(
    checkpoint.data.serializationDurationMs,
    "checkpoint serialization duration",
  );
  const uploadDuration = requiredNumber(checkpoint.data.uploadDurationMs, "checkpoint upload duration");
  expect(checkpoint.data.result).toBe("sent");
  expect(checkpointSequence).toBe(printSequence);
  expect(checkpoint.snapshot.committedSequence).toBe(printSequence);
  expect(checkpoint.snapshot.gridEpoch).toBe(checkpointEpoch);
  expect(checkpoint.snapshot.checkpointSequence).toBe(printSequence);
  expect(checkpoint.snapshot.checkpointEpoch).toBe(checkpointEpoch);
  expect(checkpoint.snapshot.checkpointResult).toBe("sent");
  expect(checkpointSize).toBeGreaterThan(0);
  expect(checkpointSize).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
  expect(checkpointSize).toBeLessThanOrEqual(TERMINAL_CHECKPOINT_CHUNK_BYTES);
  expect(checkpointChunks).toBe(1);
  expect(checkpointChunks).toBe(Math.ceil(checkpointSize / TERMINAL_CHECKPOINT_CHUNK_BYTES));
  expect(serializationDuration).toBeGreaterThanOrEqual(0);
  expect(uploadDuration).toBeGreaterThanOrEqual(0);
  const idleElapsed = checkpoint.timestamp - printCommit.timestamp;
  expect(idleElapsed).toBeGreaterThanOrEqual(TERMINAL_CHECKPOINT_IDLE_MS - IDLE_TIMER_TOLERANCE_MS);
  expect(idleElapsed).toBeLessThan(TERMINAL_CHECKPOINT_MAX_INTERVAL_MS);

  const checkpointEventsForPrint = (await pane.events()).filter((event) => (
    event.id > printFloor
    && event.type === "checkpoint"
    && event.data.result === "sent"
    && event.data.sequence === printSequence
  ));
  expect(checkpointEventsForPrint).toHaveLength(1);
  const uploadedFrame = await waitForCheckpointAnnouncement(
    faultController,
    created.id,
    checkpoint.snapshot.socketGeneration,
    printSequence,
    targetFrameOccurrenceFloor,
  );
  expect(uploadedFrame.frame?.bytes).toBeGreaterThan(0);
  // The PRINT announcement must be the very next checkpoint upload after the
  // READY one — no other checkpoint upload happened in between.
  expect(uploadedFrame.frame?.occurrence).toBe(targetFrameOccurrenceFloor + 1);
  await faultController.waitFor((event) => (
    event.type === "frame"
    && event.terminalId === created.id
    && event.direction === "browser-to-server"
    && event.frame?.binaryKind === 2
    && binaryCheckpointBodyFrames(
      faultController.events,
      created.id,
      checkpoint.snapshot.socketGeneration,
      printSequence,
    ).length >= checkpointChunks
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const uploadedFrames = binaryCheckpointBodyFrames(
    faultController.events,
    created.id,
    checkpoint.snapshot.socketGeneration,
    printSequence,
  );
  expect(uploadedFrames).toHaveLength(checkpointChunks);

  await expectTerminalInteractive(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(created.id, (entry) => (
    entry.event === "command" && entry.operation === "ECHO_INPUT" && entry.id === echoId
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(created.id, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.insertText(echoText);
  await pane.press("Enter");
  const echoPayload = await server.waitForTranscript(created.id, (entry) => (
    entry.event === "echo_input"
    && entry.id === echoId
    && entry.phase === "payload"
    && entry.payload_base64 === Buffer.from(echoText, "utf8").toString("base64")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(echoPayload.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, created.id, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(created.id, (entry) => (
    entry.event === "size" && entry.id === sizeId && entry.source === "ioctl"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const sizeMarker = marker("SIZE", sizeId, String(size.rows), String(size.cols));
  await expectTerminalBuffer(page, created.id, { contains: sizeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const finalSnapshot = await waitForSettledTerminal(page, created.id);
  await expectTerminalConverged(page, created.id, {
    cols: initial.cols,
    rows: initial.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, created.id, { timeout: WAIT_TIMEOUT_MS });

  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.socketGeneration).toBe(1);
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
  expect(finalSnapshot.serverViewport?.pixelWidth).toBe(finalSnapshot.pixelWidth);
  expect(finalSnapshot.serverViewport?.pixelHeight).toBe(finalSnapshot.pixelHeight);
  expect(size.rows).toBe(finalSnapshot.rows);
  expect(size.cols).toBe(finalSnapshot.cols);
  expect(size.pixel_width).toBe(finalSnapshot.pixelWidth);
  expect(size.pixel_height).toBe(finalSnapshot.pixelHeight);
  expect(finalSnapshot.rendererState.renderCount).toBeGreaterThan(0);
  expect(finalSnapshot.xterm.text).toContain(printMarker);
  expect(finalSnapshot.xterm.text.match(new RegExp(`\\[E2E:PRINT:${printId}:`))).toHaveLength(1);
  expect(finalSnapshot.xterm.text).toContain(echoMarker);
  expect(finalSnapshot.xterm.text.match(new RegExp(`\\[E2E:ECHO_INPUT:${echoId}:`))).toHaveLength(2);

  const finalEvents = await terminalEvents(page, created.id);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => (
    event.type === "checkpoint"
    && event.data.result === "sent"
    && event.data.sequence === printSequence
  ))).toHaveLength(1);
  await assertMonotonicSequences(finalEvents);
  const invariantReport = await expectConnectedTerminalInvariants(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);

  const transcript = await server.readTranscript(created.id);
  expect(transcript.filter((entry) => entry.event === "start")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  const expectedReadyWrite = `${readyMarker}\n`;
  expect(transcript.filter((entry) => entry.event === "write" && entry.text === expectedReadyWrite)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === printId)).toHaveLength(1);
  const expectedPrintWrite = `${printMarker}\n`;
  expect(transcript.filter((entry) => entry.event === "write" && entry.text === expectedPrintWrite)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(0);
  const winches = transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal");
  expect(winches.length).toBeGreaterThan(0);
  let previousWinchSequence = 0;
  for (const winch of winches) {
    const sequence = requiredNumber(winch.signal_sequence, "SIGWINCH signal sequence");
    expect(sequence).toBeGreaterThan(previousWinchSequence);
    previousWinchSequence = sequence;
  }
  const latestWinch = winches.at(-1);
  if (!latestWinch) throw new Error("SIGWINCH transcript entry disappeared");
  expect(latestWinch.rows).toBe(finalSnapshot.rows);
  expect(latestWinch.cols).toBe(finalSnapshot.cols);
  expect(latestWinch.pixel_width).toBe(finalSnapshot.pixelWidth);
  expect(latestWinch.pixel_height).toBe(finalSnapshot.pixelHeight);

  const networkEvents = faultController.events.filter((event) => event.terminalId === created.id);
  expect(networkEvents.filter((event) => event.type === "socket-error")).toHaveLength(0);
  expect(networkEvents.filter((event) => event.type === "malformed-frame")).toHaveLength(0);
  expect(networkEvents.filter((event) => event.type === "connection-open")).toHaveLength(1);
  expect(networkEvents.filter((event) => event.type === "connection-closed")).toHaveLength(0);

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  browserErrors.dispose();
});
