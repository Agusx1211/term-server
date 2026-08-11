import { test, expect, type IsolatedServer } from "../fixtures/test.js";
import type { Page, TestInfo } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { expectTerminalNonBlank, expectTerminalPixelsChanged, screenshotRegion } from "../assertions/terminal-pixels.js";
import {
  expectTerminalBuffer,
  expectNoPendingRecovery,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const EVENT_TIMEOUT_MS = 45_000;
const MAX_SNAPSHOT_PARSE_MS = 10_000;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
// Keep the checkpoint above 2 MiB while respecting xterm's 10,000-row
// scrollback bound: bare LF does not reset the column, so short logical lines
// wrap into extra rows and truncate the serialized checkpoint too aggressively.
const MIN_LARGE_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const LARGE_BURST_BYTES = 2.25 * 1024 * 1024;
const LARGE_BURST_LINE_WIDTH = 3_000;
// Keep the stress resize well below the multi-worker Chromium canvas limit.
const WIDE_BROWSER_WIDTH = 2_400;
const NARROW_BROWSER_WIDTH = 1_200;
const BROWSER_HEIGHT = 900;
const READY_ID = "P017_READY";
const BULK_ID = "P017_BULK";
const FINAL_ID = "P017_FINAL";
const FINAL_TEXT = "SNAPSHOT_RECOVERED";
const ECHO_ID = "P017_ECHO";
const ECHO_PAYLOAD = "P017_INPUT_CONTINUES";

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]\n`;
}

function eventDataNumber(event: E2ETerminalEvent, key: string): number | undefined {
  const value = event.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function waitForSettledSequence(
  page: Page,
  terminalId: string,
  minimumSequence: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence !== undefined
      && snapshot.receivedSequence >= minimum
      && snapshot.committedSequence === snapshot.receivedSequence
    ), { timeout });
  }, { id: terminalId, minimum: minimumSequence, timeout: EVENT_TIMEOUT_MS });
}

async function waitForTerminalText(
  page: Page,
  terminalId: string,
  text: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.xterm.text.includes(expected)
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout });
  }, { id: terminalId, expected: text, timeout: EVENT_TIMEOUT_MS });
}

async function waitForCheckpoint(
  page: Page,
  terminalId: string,
  minimumSequence: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, minimum, minimumSequence, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.type !== "checkpoint" || event.data.result !== "sent") return false;
      const size = event.data.size;
      const sequence = event.data.sequence;
      return typeof size === "number"
        && Number.isFinite(size)
        && size >= minimum
        && typeof sequence === "number"
        && sequence >= minimumSequence;
    }, { timeout });
  }, { id: terminalId, minimum: MIN_LARGE_CHECKPOINT_BYTES, minimumSequence, timeout: EVENT_TIMEOUT_MS });
}

async function waitForSnapshotSync(
  page: Page,
  terminalId: string,
  afterGeneration: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === "sync"
      && event.data.mode === "snapshot"
      && event.snapshot.socketGeneration > generation
    ), { timeout });
  }, { id: terminalId, generation: afterGeneration, timeout: EVENT_TIMEOUT_MS });
}

async function waitForSyncedGenerationAfter(
  page: Page,
  terminalId: string,
  afterGeneration: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, afterGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === "synced" && event.snapshot.socketGeneration > afterGeneration
    ), { timeout });
  }, { id: terminalId, afterGeneration, timeout: EVENT_TIMEOUT_MS });
}

async function waitForSyncState(
  page: Page,
  terminalId: string,
  generation: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration === generation
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
    ), { timeout });
  }, { id: terminalId, generation, timeout: EVENT_TIMEOUT_MS });
}

async function waitForTranscriptWrite(
  server: IsolatedServer,
  terminalId: string,
  bytes: number,
): Promise<void> {
  await server.waitForTranscript(terminalId, (entry) => entry.event === "write" && entry.bytes === bytes, {
    timeoutMs: EVENT_TIMEOUT_MS,
  });
}

async function waitForTranscriptEvent(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return server.waitForTranscript(terminalId, predicate, { timeoutMs: EVENT_TIMEOUT_MS });
}

async function assertSnapshotMetrics(
  page: Page,
  terminalId: string,
  checkpointEvent: E2ETerminalEvent,
  snapshotSync: E2ETerminalEvent,
  syncedEvent: E2ETerminalEvent,
  testInfo: TestInfo,
): Promise<void> {
  const checkpointSize = eventDataNumber(checkpointEvent, "size");
  const checkpointChunks = eventDataNumber(checkpointEvent, "chunks");
  const serializationDuration = eventDataNumber(checkpointEvent, "serializationDurationMs");
  const uploadDuration = eventDataNumber(checkpointEvent, "uploadDurationMs");
  expect(checkpointEvent.data.result).toBe("sent");
  expect(checkpointSize).toBeGreaterThanOrEqual(MIN_LARGE_CHECKPOINT_BYTES);
  expect(checkpointSize).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
  expect(checkpointChunks).toBeGreaterThan(0);
  expect(serializationDuration).toBeGreaterThanOrEqual(0);
  expect(uploadDuration).toBeGreaterThanOrEqual(0);
  expect(snapshotSync.snapshot.syncMode).toBe("snapshot");
  expect(snapshotSync.snapshot.syncTarget).toBe(eventDataNumber(snapshotSync, "sequence"));

  const parseDuration = syncedEvent.timestamp - snapshotSync.timestamp;
  expect(Number.isFinite(parseDuration)).toBe(true);
  expect(parseDuration).toBeGreaterThanOrEqual(0);
  expect(parseDuration).toBeLessThan(MAX_SNAPSHOT_PARSE_MS);

  const events = await terminalEvents(page, terminalId);
  const snapshotGeneration = snapshotSync.snapshot.socketGeneration;
  const snapshotBytes = events
    .filter((event) => event.type === "output-received"
      && event.snapshot.socketGeneration === snapshotGeneration
      && event.timestamp >= snapshotSync.timestamp
      && event.timestamp <= syncedEvent.timestamp)
    .reduce((total, event) => total + (eventDataNumber(event, "bytes") ?? 0), 0);
  expect(snapshotBytes).toBeGreaterThan(0);
  expect(snapshotBytes).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);

  const parserSnapshots = events.filter((event) => (
    event.type === "snapshot"
    && event.snapshot.socketGeneration === snapshotGeneration
    && event.timestamp >= snapshotSync.timestamp
    && event.timestamp <= syncedEvent.timestamp
  ));
  expect(parserSnapshots.length).toBeGreaterThan(0);
  for (const event of parserSnapshots) {
    const pendingWrites = eventDataNumber(event, "pendingParserWrites");
    const pendingBytes = eventDataNumber(event, "pendingParserBytes");
    if (pendingWrites !== undefined) expect(pendingWrites).toBeGreaterThanOrEqual(0);
    if (pendingBytes !== undefined) expect(pendingBytes).toBeGreaterThanOrEqual(0);
  }
  expect(parserSnapshots.some((event) => (
    (eventDataNumber(event, "pendingParserWrites") ?? 0) > 0
    && (eventDataNumber(event, "pendingParserBytes") ?? 0) > 0
  ))).toBe(true);

  const settled = await waitForSyncState(page, terminalId, snapshotGeneration);
  expect(settled.pendingParserWrites).toBe(0);
  expect(settled.pendingParserBytes).toBe(0);
  expect(settled.renderBacklogBytes).toBe(0);
  expect(settled.renderBacklogFrames).toBe(0);
  expect(settled.syncTarget === undefined || settled.committedSequence === undefined || settled.committedSequence >= settled.syncTarget).toBe(true);

  await expectTerminalNonBlank(page, new WorkbenchPage(page).terminal(terminalId).xtermHost, {
    testInfo,
    artifactName: "p0-17-snapshot-recovered",
  });
}

test("@p0 P0-17 Snapshot is bounded by recovery behavior", async ({ page, baseURL, server, faultController }, testInfo) => {
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.setViewport(WIDE_BROWSER_WIDTH, BROWSER_HEIGHT);
  await workbench.createTerminal();

  const paneLocator = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(paneLocator).toBeVisible();
  const terminalId = await paneLocator.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal did not expose a stable terminal ID");
  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();
  await pane.waitForConnected({ timeout: EVENT_TIMEOUT_MS });
  await pane.waitForSynchronized({ timeout: EVENT_TIMEOUT_MS });

  await pane.sendInput(`READY ${READY_ID}`, true);
  await waitForTranscriptEvent(server, terminalId, (entry) => entry.event === "ready" && entry.id === READY_ID);
  await waitForTranscriptWrite(server, terminalId, Buffer.byteLength(marker("READY", READY_ID)));
  const afterReady = await waitForSettledSequence(page, terminalId, 1);
  const beforeBurstSequence = afterReady.committedSequence ?? afterReady.receivedSequence ?? 0;

  await pane.sendInput(`BURST ${BULK_ID} ${LARGE_BURST_BYTES} ${LARGE_BURST_LINE_WIDTH}`, true);
  await waitForTranscriptEvent(server, terminalId, (entry) => entry.event === "burst" && entry.id === BULK_ID && entry.bytes === LARGE_BURST_BYTES);
  await waitForTranscriptWrite(server, terminalId, LARGE_BURST_BYTES);
  const afterBurst = await waitForSettledSequence(page, terminalId, beforeBurstSequence + LARGE_BURST_BYTES);
  const checkpointEvent = await waitForCheckpoint(page, terminalId, afterBurst.committedSequence ?? afterBurst.receivedSequence ?? beforeBurstSequence);
  const checkpointSize = eventDataNumber(checkpointEvent, "size") ?? 0;
  expect(checkpointSize).toBeGreaterThanOrEqual(MIN_LARGE_CHECKPOINT_BYTES);

  const beforeResize = await pane.snapshot();
  if (!beforeResize) throw new Error(`no diagnostics snapshot for terminal ${terminalId}`);
  const oldGeneration = beforeResize.socketGeneration;
  const oldCols = beforeResize.cols;
  const droppedSize = faultController.drop({
    terminalId,
    generation: oldGeneration,
    direction: "server-to-browser",
    jsonType: "size",
  });
  const resizeSeen = waitForTranscriptEvent(server, terminalId, (entry) => (
    entry.event === "sigwinch"
    && entry.source === "signal"
    && typeof entry.cols === "number"
    && entry.cols !== oldCols
  ));
  const sizeDropped = faultController.waitFor((event) => (
    event.type === "dropped"
    && event.terminalId === terminalId
    && event.generation === oldGeneration
    && event.direction === "server-to-browser"
    && event.ruleId === droppedSize.id
  ), { timeoutMs: EVENT_TIMEOUT_MS });
  await workbench.setViewport(NARROW_BROWSER_WIDTH, BROWSER_HEIGHT);
  const [, resized] = await Promise.all([sizeDropped, resizeSeen]);
  expect(typeof resized.cols).toBe("number");
  droppedSize.dispose();

  const snapshotSyncPromise = waitForSnapshotSync(page, terminalId, oldGeneration + 1);
  const syncedPromise = waitForSyncedGenerationAfter(page, terminalId, oldGeneration + 1);
  const malformedFrame = faultController.inject({
    direction: "server-to-browser",
    data: new Uint8Array([0]),
    binary: true,
    matcher: {
      terminalId,
      generation: oldGeneration + 1,
      binaryKind: 0,
      occurrence: 1,
    },
    when: "before",
  });
  faultController.terminate({ terminalId, generation: oldGeneration });
  await faultController.waitFor((event) => (
    event.type === "connection-terminated"
    && event.terminalId === terminalId
    && event.generation === oldGeneration
  ), { timeoutMs: EVENT_TIMEOUT_MS });
  const malformedInjected = await faultController.waitFor((event) => (
    event.type === "injected"
    && event.terminalId === terminalId
    && event.generation === oldGeneration + 1
    && event.ruleId === malformedFrame.id
  ), { timeoutMs: EVENT_TIMEOUT_MS });
  expect(malformedInjected.bytes).toBeGreaterThan(0);
  malformedFrame.dispose();

  const protocolNotice = page.locator('.toast[role="status"]').filter({ hasText: "terminal frame is missing its header" }).first();
  await expect(protocolNotice).toBeVisible({ timeout: EVENT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "p0-17-recoverable-protocol-error",
  });

  const snapshotSync = await snapshotSyncPromise;
  const successfulGeneration = snapshotSync.snapshot.socketGeneration;
  expect(successfulGeneration).toBeGreaterThan(oldGeneration + 1);
  const syncedEvent = await syncedPromise;
  expect(syncedEvent.snapshot.socketGeneration).toBe(successfulGeneration);
  await assertSnapshotMetrics(page, terminalId, checkpointEvent, snapshotSync, syncedEvent, testInfo);

  const beforeFinalPixels = await screenshotRegion(page, pane.xtermHost);
  await pane.sendInput(`PRINT ${FINAL_ID} ${FINAL_TEXT}`, true);
  await waitForTranscriptEvent(server, terminalId, (entry) => (
    entry.event === "print" && entry.id === FINAL_ID && entry.text === FINAL_TEXT
  ));
  await waitForTerminalText(page, terminalId, marker("PRINT", FINAL_ID, FINAL_TEXT));
  const afterFinalPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeFinalPixels, afterFinalPixels, {
    minimumChangedRatio: 0.0002,
    testInfo,
    artifactName: "p0-17-final-marker",
  });
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("PRINT", FINAL_ID, FINAL_TEXT).trimEnd(),
    occurrences: 1,
  }, { timeout: EVENT_TIMEOUT_MS });

  await pane.sendInput(`ECHO_INPUT ${ECHO_ID}`, true);
  await waitForTranscriptEvent(server, terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === ECHO_ID && entry.phase === "armed"
  ));
  await pane.sendInput(ECHO_PAYLOAD, true);
  const payloadEvent = await waitForTranscriptEvent(server, terminalId, (entry) => (
    entry.event === "echo_input"
    && entry.id === ECHO_ID
    && entry.phase === "payload"
    && entry.bytes === Buffer.byteLength(ECHO_PAYLOAD)
  ));
  expect(payloadEvent.id).toBe(ECHO_ID);
  const transcript = await server.readTranscript(terminalId);
  const payloadCount = transcript.filter((entry) => (
    entry.event === "echo_input"
    && entry.id === ECHO_ID
    && entry.phase === "payload"
  )).length;
  expect(payloadCount).toBe(1);
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", ECHO_ID, Buffer.from(ECHO_PAYLOAD).toString("base64")).trimEnd(),
    occurrences: 1,
  }, { timeout: EVENT_TIMEOUT_MS });

  const finalSnapshot = await waitForSyncState(page, terminalId, successfulGeneration);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.syncMode).toBeUndefined();
  expect(finalSnapshot.syncTarget === undefined || finalSnapshot.committedSequence === undefined || finalSnapshot.committedSequence >= finalSnapshot.syncTarget).toBe(true);
  await expectNoPendingRecovery(page, terminalId, { timeout: EVENT_TIMEOUT_MS });
  const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: EVENT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  const finalEvents = await terminalEvents(page, terminalId);
  expect(finalEvents.some((event) => event.type === "sync" && event.data.mode === "snapshot")).toBe(true);
  expect(finalEvents.some((event) => event.type === "error")).toBe(false);
  expect(finalEvents.filter((event) => event.type === "socket-created").length).toBeGreaterThanOrEqual(3);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "p0-17-final-terminal",
  });
});
