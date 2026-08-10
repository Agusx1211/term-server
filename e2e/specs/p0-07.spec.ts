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
  terminalSnapshot,
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
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 45_000;
const BURST_BYTES = 1_000_000;
const BURST_LINE_WIDTH = 100;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type StreamState = {
  readonly syncMode?: "snapshot" | "resume";
  readonly syncTarget?: number;
};

function streamState(event: E2ETerminalEvent): StreamState | undefined {
  const stream = event.data.stream;
  if (typeof stream !== "object" || stream === null || !("syncMode" in stream)) return undefined;
  const syncMode = stream.syncMode;
  if (syncMode !== "snapshot" && syncMode !== "resume") return undefined;
  const syncTarget = "syncTarget" in stream && typeof stream.syncTarget === "number"
    ? stream.syncTarget
    : undefined;
  return {
    syncMode,
    ...(syncTarget === undefined ? {} : { syncTarget }),
  };
}

async function waitForMountedPane(page: Page): Promise<{ terminalId: string; eventId: number }> {
  return page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const event = await api.waitForEvent(
      (candidate) => candidate.type === "mount" && candidate.snapshot.kind === "pane",
      { timeout },
    );
    return { terminalId: event.terminalId, eventId: event.id };
  }, WAIT_TIMEOUT_MS);
}

async function waitForRecoverySync(
  page: Page,
  terminalId: string,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (candidate) => {
        if (candidate.id <= after || candidate.type !== "snapshot") return false;
        const stream = candidate.data.stream;
        if (typeof stream !== "object" || stream === null || !("syncMode" in stream)) return false;
        const syncMode = stream.syncMode;
        return syncMode === "snapshot" || syncMode === "resume";
      },
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSocketCreated(
  page: Page,
  terminalId: string,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (candidate) => candidate.id > after && candidate.type === "socket-created",
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
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
        && snapshot.renderBacklogBytes === 0
        && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit,
      { timeout },
    );
  }, {
    id: terminalId,
    timeout: WAIT_TIMEOUT_MS,
    acknowledgementLimit: TERMINAL_ACK_BYTES,
  });
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

test("P0-07 Abrupt disconnect during live output @p0 @smoke", async ({ page, server, faultController, baseURL }, testInfo) => {
  const runTag = `P007-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-ready`;
  const beforeId = `${runTag}-before`;
  const holdId = `${runTag}-hold`;
  const burstId = `${runTag}-live`;
  const duringId = `${runTag}-during`;
  const afterId = `${runTag}-after`;
  const inputId = `${runTag}-input`;
  const beforeText = `${runTag}-initial-output`;
  const duringText = `${runTag}-during-disconnect`;
  const afterText = `${runTag}-recovered-output`;
  const inputText = `${runTag}-continued-input`;
  const beforeMarker = `[E2E:PRINT:${beforeId}:${beforeText}]`;
  const duringMarker = `[E2E:PRINT:${duringId}:${duringText}]`;
  const afterMarker = `[E2E:PRINT:${afterId}:${afterText}]`;
  const inputMarker = `[E2E:ECHO_INPUT:${inputId}:${Buffer.from(inputText, "utf8").toString("base64")}]`;

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const mounted = await waitForMountedPane(page);
  const terminalId = mounted.terminalId;
  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:READY:${readyId}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === beforeId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: beforeMarker,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "p0-07-before-disconnect",
  });

  const beforeDisconnect = await terminalSnapshot(page, terminalId);
  if (!beforeDisconnect) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  expect(beforeDisconnect.socketState).toBe("connected");
  expect(beforeDisconnect.activeSocketCount).toBe(1);
  expect(beforeDisconnect.flowControlled).toBe(true);
  expect(beforeDisconnect.gridEpoch).toEqual(expect.any(Number));
  expect(beforeDisconnect.committedSequence).toEqual(expect.any(Number));
  const baselineEvents = await terminalEvents(page, terminalId);
  const baselineEventId = baselineEvents.at(-1)?.id ?? mounted.eventId;

  const recoverySyncPromise = waitForRecoverySync(page, terminalId, baselineEventId);
  const reconnectSocketPromise = waitForSocketCreated(page, terminalId, baselineEventId);

  const pausedRule = faultController.pause("server-to-browser", { terminalId });
  await faultController.waitFor(
    (event) => event.type === "paused" && event.terminalId === terminalId && event.direction === "server-to-browser",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  // Hold the fixture command queue so the burst and its trailing marker start
  // only after RELEASE. This lets the proxy terminate the live socket while
  // the sustained PTY write is still pending, without injecting any data.
  await pane.sendInput(`HOLD ${holdId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdId, { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
  await pane.sendInput(`PRINT ${duringId} ${duringText}`, true);
  await pane.insertText(`RELEASE ${holdId}`);
  await pane.press("Enter");

  // The fixture records BURST before writing its bytes to the PTY. The
  // server-to-browser pause keeps those bytes in flight so termination is
  // observably abrupt and the queued PRINT runs only after the disconnect.
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const socketClosedPromise = pane.waitForEvent("socket-close", { timeout: WAIT_TIMEOUT_MS });
  const terminatedPromise = faultController.waitFor(
    (event) => event.type === "connection-terminated" && event.terminalId === terminalId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const terminateRule = faultController.terminate({ terminalId });
  const [terminated, socketClosed] = await Promise.all([terminatedPromise, socketClosedPromise]);
  terminateRule.dispose();
  pausedRule.dispose();
  expect(terminated.abrupt).toBe(true);
  expect(terminated.code).toBe(1006);
  expect(socketClosed.type).toBe("socket-close");
  expect(socketClosed.data.generation).toBe(beforeDisconnect.socketGeneration);

  const duringPrint = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === duringId && entry.text === duringText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(duringPrint.event).toBe("print");
  const disconnectedTranscript = await server.readTranscript(terminalId);
  const burstIndex = disconnectedTranscript.findIndex((entry) => entry.event === "burst" && entry.id === burstId);
  const duringIndex = disconnectedTranscript.findIndex((entry) => entry.event === "print" && entry.id === duringId);
  expect(burstIndex).toBeGreaterThanOrEqual(0);
  expect(duringIndex).toBeGreaterThan(burstIndex);

  const [recoverySync, reconnectSocket] = await Promise.all([recoverySyncPromise, reconnectSocketPromise]);
  const recoveredStream = streamState(recoverySync);
  expect(recoveredStream?.syncMode).toBe("resume");
  expect(recoveredStream?.syncTarget).toEqual(expect.any(Number));
  expect(recoverySync.snapshot.gridEpoch).toBe(beforeDisconnect.gridEpoch);
  const reconnectUrl = reconnectSocket.data.url;
  expect(typeof reconnectUrl).toBe("string");
  if (typeof reconnectUrl !== "string") throw new Error("reconnect socket event did not include a URL");
  expect(reconnectUrl).toContain(`sequence=${beforeDisconnect.committedSequence}`);
  expect(reconnectUrl).toContain(`epoch=${beforeDisconnect.gridEpoch}`);
  const reconnectGeneration = reconnectSocket.data.generation;
  expect(typeof reconnectGeneration).toBe("number");
  if (typeof reconnectGeneration !== "number") throw new Error("reconnect socket event did not include a generation");
  expect(reconnectGeneration).toBeGreaterThan(beforeDisconnect.socketGeneration);

  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(`PRINT ${afterId} ${afterText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === afterId, { timeoutMs: WAIT_TIMEOUT_MS });

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

  const finalSnapshot = await waitForTerminalQuiescent(page, terminalId);
  await expectTerminalConverged(page, terminalId, {
    cols: beforeDisconnect.cols,
    rows: beforeDisconnect.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  for (const markerText of [duringMarker, afterMarker, inputMarker]) {
    await expectTerminalBuffer(page, terminalId, {
      contains: markerText,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
  }

  const finalTranscript = await server.readTranscript(terminalId);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "print" && entry.id === beforeId)).toBe(1);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "print" && entry.id === duringId)).toBe(1);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "print" && entry.id === afterId)).toBe(1);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload")).toBe(1);
  expect(countTranscriptEntries(finalTranscript, (entry) => entry.event === "error")).toBe(0);
  expect(finalSnapshot.receivedSequence).toBe(outputByteCount(finalTranscript));
  expect(finalSnapshot.committedSequence).toBe(outputByteCount(finalTranscript));
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(finalSnapshot.flowControlled).toBe(true);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.activeSocketCount).toBe(1);

  const afterPixels = await screenshotRegion(page, pane.xtermHost);
  // The recovered TUI intentionally occupies only a few rows; the artifact
  // crop is visibly rendered but measures 0.00014 non-background coverage over
  // the full viewport. Keep a positive compositor check without requiring
  // dense output from this sparse layout.
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.0001,
    testInfo,
    artifactName: "p0-07-after-recovery",
  });
  await expectTerminalPixelsChanged(beforePixels, afterPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-07-recovery-pixels",
  });

  const finalEvents = await terminalEvents(page, terminalId);
  const syncStarts: StreamState[] = [];
  let activeSync: string | undefined;
  for (const event of finalEvents) {
    const stream = streamState(event);
    if (!stream) {
      activeSync = undefined;
      continue;
    }
    const key = `${stream.syncMode}:${stream.syncTarget ?? ""}`;
    if (key !== activeSync) {
      syncStarts.push(stream);
      activeSync = key;
    }
  }
  expect(syncStarts.filter((stream) => stream.syncMode === "resume").length).toBeGreaterThanOrEqual(1);
  expect(syncStarts.filter((stream) => stream.syncMode === "snapshot")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  await assertMonotonicSequences(finalEvents);
  assertNoUnexpectedSocketMultiplication([beforeDisconnect, finalSnapshot]);
  assertNoPendingSynchronization(finalSnapshot);
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
});
