import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
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
  assertViewportDimensions,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 45_000;
const KEEPALIVE_TIMEOUT_WAIT_MS = 75_000;
const REPAINT_BYTES = 700_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly pid: number | null;
  readonly status: string;
};

async function waitForMountedPane(page: Page): Promise<E2ETerminalEvent> {
  return page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.snapshot.kind === "pane",
      { timeout },
    );
  }, WAIT_TIMEOUT_MS);
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEvent["type"],
  field?: string,
  expected?: string | number,
  timeout = WAIT_TIMEOUT_MS,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, fieldName, expectedValue, waitTimeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => {
        if (event.id <= after || event.type !== eventType) return false;
        if (fieldName === undefined) return true;
        return event.data[fieldName] === expectedValue;
      },
      { timeout: waitTimeout, afterId: after },
    );
  }, {
    id: terminalId,
    after: afterEventId,
    eventType: type,
    fieldName: field,
    expectedValue: expected,
    waitTimeout: timeout,
  });
}

async function waitForTerminalQuiescent(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit,
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
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

function countTranscriptEntries(
  entries: readonly Record<string, unknown>[],
  predicate: (entry: Record<string, unknown>) => boolean,
): number {
  return entries.reduce((count, entry) => count + (predicate(entry) ? 1 : 0), 0);
}

function outputByteCount(entries: readonly Record<string, unknown>[]): number {
  return entries.reduce((total, entry) => {
    if (entry.event !== "write") return total;
    const bytes = entry.bytes;
    return total + (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0);
  }, 0);
}

test("C-05 Keepalive timeout @nightly", async ({ page, server, faultController, baseURL }, testInfo) => {
  const runTag = `C005-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-ready`;
  const beforeId = `${runTag}-before`;
  const repaintId = `${runTag}-repaint`;
  const afterId = `${runTag}-after`;
  const inputId = `${runTag}-input`;
  const sizeId = `${runTag}-size`;
  const beforeText = `${runTag}-before-keepalive`;
  const afterText = `${runTag}-after-keepalive`;
  const inputText = `${runTag}-continued-input`;
  const beforeMarker = `[E2E:PRINT:${beforeId}:${beforeText}]`;
  const repaintMarker = `[E2E:REPAINT:${repaintId}:FRAME]`;
  const afterMarker = `[E2E:PRINT:${afterId}:${afterText}]`;
  const inputMarker = `[E2E:ECHO_INPUT:${inputId}:${Buffer.from(inputText, "utf8").toString("base64")}]`;

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountedPromise = waitForMountedPane(page);
  await workbench.createTerminal();
  const mounted = await mountedPromise;
  const terminalId = mounted.terminalId;
  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:READY:${readyId}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const beforeSnapshot = await waitForTerminalQuiescent(page, terminalId);
  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c-05-before-timeout",
  });

  expect(beforeSnapshot.socketState).toBe("connected");
  expect(beforeSnapshot.activeSocketCount).toBe(1);
  expect(beforeSnapshot.cols).toBeGreaterThan(0);
  expect(beforeSnapshot.rows).toBeGreaterThan(0);
  if (!beforeSnapshot.serverViewport) throw new Error("keepalive baseline has no server-selected viewport");
  assertViewportDimensions(beforeSnapshot, { cols: beforeSnapshot.cols, rows: beforeSnapshot.rows });

  const initialTerminal = await readTerminal(page, terminalId);
  expect(initialTerminal.status).toBe("running");
  if (initialTerminal.pid === null) throw new Error(`terminal ${terminalId} has no running process identity`);
  const initialPid = initialTerminal.pid;

  const baselineEvents = await terminalEvents(page, terminalId);
  const baselineEventId = baselineEvents.at(-1)?.id ?? mounted.id;
  const initialConnection = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation !== undefined,
  );
  if (initialConnection?.generation === undefined) throw new Error(`terminal ${terminalId} has no proxy connection generation`);
  const initialNetworkGeneration = initialConnection.generation;
  const pauseMatcher = { terminalId, generation: initialNetworkGeneration };
  const pauseRule = faultController.pause("server-to-browser", pauseMatcher);

  try {
    await faultController.waitFor(
      (event) => event.type === "paused"
        && event.terminalId === terminalId
        && event.generation === initialNetworkGeneration
        && event.direction === "server-to-browser",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );

    const timeoutConnectionPromise = faultController.waitFor(
      (event) => event.type === "connection-closed"
        && event.terminalId === terminalId
        && event.generation === initialNetworkGeneration
        && event.code === 4001,
      { timeoutMs: KEEPALIVE_TIMEOUT_WAIT_MS },
    );

    await pane.sendInput(`REPAINT ${repaintId} ${REPAINT_BYTES}`, true);
    const repaint = await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === REPAINT_BYTES,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(repaint.bytes).toBe(REPAINT_BYTES);

    const timeoutConnection = await timeoutConnectionPromise;
    expect(timeoutConnection.type).toBe("connection-closed");
    expect(timeoutConnection.code).toBe(4001);
    expect(timeoutConnection.abrupt).toBe(false);
    expect(timeoutConnection.generation).toBe(initialNetworkGeneration);

    faultController.resume("server-to-browser", pauseMatcher);
  } finally {
    pauseRule.dispose();
  }

  const socketClosed = await waitForDiagnosticEventAfter(
    page,
    terminalId,
    baselineEventId,
    "socket-close",
    undefined,
    undefined,
    KEEPALIVE_TIMEOUT_WAIT_MS,
  );
  expect(socketClosed.data.generation).toBe(beforeSnapshot.socketGeneration);

  const disconnected = await waitForDiagnosticEventAfter(
    page,
    terminalId,
    socketClosed.id,
    "state",
    "state",
    "disconnected",
  );
  expect(disconnected.data.state).toBe("disconnected");

  const reconnectSocket = await waitForDiagnosticEventAfter(
    page,
    terminalId,
    socketClosed.id,
    "socket-created",
    undefined,
    undefined,
    WAIT_TIMEOUT_MS,
  );
  const reconnectGeneration = reconnectSocket.data.generation;
  if (typeof reconnectGeneration !== "number") throw new Error("reconnect socket event did not include a generation");
  expect(reconnectGeneration).toBe(beforeSnapshot.socketGeneration + 1);

  const syncEvent = await waitForDiagnosticEventAfter(
    page,
    terminalId,
    reconnectSocket.id,
    "sync",
    undefined,
    undefined,
    WAIT_TIMEOUT_MS,
  );
  expect(["resume", "snapshot"]).toContain(syncEvent.data.mode);
  const syncedEvent = await waitForDiagnosticEventAfter(
    page,
    terminalId,
    syncEvent.id,
    "synced",
    undefined,
    undefined,
    WAIT_TIMEOUT_MS,
  );
  expect(syncedEvent.snapshot.socketState).toBe("connected");
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`PRINT ${afterId} ${afterText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === afterId && entry.text === afterText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`ECHO_INPUT ${inputId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.insertText(inputText);
  await pane.press("Enter");
  const echoed = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === inputId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(inputText, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoed.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, terminalId, { contains: inputMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(size.rows).toBe(beforeSnapshot.rows);
  expect(size.cols).toBe(beforeSnapshot.cols);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:SIZE:${sizeId}:${beforeSnapshot.rows}:${beforeSnapshot.cols}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const finalSnapshot = await waitForTerminalQuiescent(page, terminalId);
  await expectTerminalConverged(page, terminalId, {
    cols: beforeSnapshot.cols,
    rows: beforeSnapshot.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  await expectTerminalBuffer(page, terminalId, { contains: repaintMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: inputMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const afterPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c-05-after-timeout",
  });
  await expectTerminalPixelsChanged(beforePixels, afterPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "c-05-timeout-recovery-pixels",
  });

  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(finalSnapshot.flowControlled).toBe(true);
  assertViewportDimensions(finalSnapshot, { cols: beforeSnapshot.cols, rows: beforeSnapshot.rows });
  assertNoPendingSynchronization(finalSnapshot);
  assertNoUnexpectedSocketMultiplication([beforeSnapshot, finalSnapshot]);

  const finalTerminal = await readTerminal(page, terminalId);
  expect(finalTerminal.status).toBe("running");
  expect(finalTerminal.pid).toBe(initialPid);

  const finalTranscript = await server.readTranscript(terminalId);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "ready" && entry.id === readyId)).toBe(1);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "print" && entry.id === beforeId)).toBe(1);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "repaint" && entry.id === repaintId)).toBe(1);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "print" && entry.id === afterId)).toBe(1);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload")).toBe(1);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "size" && entry.id === sizeId)).toBe(1);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "error")).toBe(0);
  expect(finalSnapshot.receivedSequence).toBe(outputByteCount(finalTranscript));
  expect(finalSnapshot.committedSequence).toBe(outputByteCount(finalTranscript));

  const finalEvents = await terminalEvents(page, terminalId);
  const reconnectSockets = finalEvents.filter((event) => event.type === "socket-created" && event.id > baselineEventId);
  expect(reconnectSockets).toHaveLength(1);
  expect(reconnectSockets[0]?.data.generation).toBe(beforeSnapshot.socketGeneration + 1);
  const recoverySyncs = finalEvents.filter((event) => event.type === "sync" && event.id > baselineEventId);
  expect(recoverySyncs).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  const terminalNetworkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
  const networkConnections = terminalNetworkEvents.filter((event) => event.type === "connection-open");
  expect(networkConnections).toHaveLength(2);
  expect(networkConnections[0]?.generation).toBe(initialNetworkGeneration);
  expect(networkConnections[1]?.generation).toBeGreaterThan(initialNetworkGeneration);
  expect(terminalNetworkEvents.filter((event) => event.type === "socket-error")).toHaveLength(0);
  await assertMonotonicSequences(finalEvents);
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
});
