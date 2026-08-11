import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { Terminal as HeadlessTerminal } from "../fixtures/headless-terminal.js"
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  terminalEvents,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { expectConnectedTerminalInvariants, expectTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";

const WAIT_TIMEOUT_MS = 45_000;
const EXPECTED_EXIT_CODE = 0;

type TranscriptEntry = Record<string, unknown>;
type E2EWindow = Window & { __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi };

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function commandBase64(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function occurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
}

function numberField(entry: TranscriptEntry, field: string): number {
  const value = entry[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`transcript ${field} is not a finite number`);
  }
  return value;
}

function stringField(entry: TranscriptEntry, field: string): string {
  const value = entry[field];
  if (typeof value !== "string") throw new Error(`transcript ${field} is not a string`);
  return value;
}

function outputBytes(entries: readonly TranscriptEntry[]): Buffer {
  const writes = entries.filter((entry) => entry.event === "write");
  const chunks = writes.map((entry) => {
    const encoded = stringField(entry, "data_base64");
    return Buffer.from(encoded, "base64");
  });
  return Buffer.concat(chunks);
}

function outputByteCount(entries: readonly TranscriptEntry[]): number {
  return entries
    .filter((entry) => entry.event === "write")
    .reduce((total, entry) => total + numberField(entry, "bytes"), 0);
}

function modelText(terminal: HeadlessTerminal): string {
  const active = terminal.buffer.active;
  const length = Math.max(0, Math.min(active.length, 20_000));
  let text = "";
  for (let index = 0; index < length && text.length < 256_000; index += 1) {
    const line = active.getLine(index);
    if (!line) continue;
    text += line.translateToString(true);
    if (index + 1 < length) text += "\n";
  }
  return text;
}


async function waitForDiagnosticEvent(
  page: Page,
  terminalId: string,
  type: E2ETerminalEventType,
  options: {
    readonly afterEventId?: number;
    readonly minimumGeneration?: number;
    readonly exactGeneration?: number;
    readonly mode?: "snapshot" | "resume";
    readonly minimumReceivedSequence?: number;
  } = {},
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, eventType, afterEventId, minimumGeneration, exactGeneration, mode, minimumReceivedSequence, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.type !== eventType) return false;
      if (afterEventId !== undefined && event.id <= afterEventId) return false;
      if (exactGeneration !== undefined && event.snapshot.socketGeneration !== exactGeneration) return false;
      if (minimumGeneration !== undefined && event.snapshot.socketGeneration < minimumGeneration) return false;
      if (mode !== undefined && event.data.mode !== mode) return false;
      if (minimumReceivedSequence !== undefined) {
        const received = event.snapshot.receivedSequence;
        if (received === undefined || received < minimumReceivedSequence) return false;
      }
      return true;
    }, { timeout, afterId: afterEventId });
  }, {
    id: terminalId,
    eventType: type,
    ...options,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForRenderAfter(
  page: Page,
  terminalId: string,
  minimumRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimumRender, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > minimumRender
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout });
  }, { id: terminalId, minimumRender: minimumRenderCount, timeout: WAIT_TIMEOUT_MS });
}

function assertMarkerOnce(text: string, value: string, label: string): void {
  expect(text, `${label} is missing`).toContain(value);
  expect(occurrences(text, value), `${label} must occur exactly once`).toBe(1);
}

function assertCommandSequence(entries: readonly TranscriptEntry[], expected: readonly string[]): void {
  const commands = entries
    .filter((entry) => entry.event === "command")
    .map((entry) => stringField(entry, "command_base64"));
  expect(commands).toEqual(expected.map(commandBase64));
}

async function modelFromTranscript(
  entries: readonly TranscriptEntry[],
  cols: number,
  rows: number,
): Promise<{ readonly terminal: HeadlessTerminal; readonly text: string }> {
  const terminal = new HeadlessTerminal({
    cols,
    rows,
    scrollback: 200_000,
    allowProposedApi: true,
    ...tuiCompatibilityOptions(),
  });
  for (const entry of entries) {
    if (entry.event !== "write") continue;
    await new Promise<void>((resolve) => {
      terminal.write(Buffer.from(stringField(entry, "data_base64"), "base64"), resolve);
    });
  }
  return { terminal, text: modelText(terminal) };
}

test("O-07 Synchronized output interrupted by disconnect @p1 @nightly @O-07 @sync @recovery", async ({
  browser,
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const runTag = `O07-${testInfo.project.name}-w${testInfo.workerIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-READY`;
  const syncId = `${runTag}-SYNC`;
  const partialId = `${runTag}-PARTIAL`;
  const partialText = `${runTag}-PARTIAL-FRAME`;
  const offlineId = `${runTag}-OFFLINE`;
  const offlineText = `${runTag}-OFFLINE-OUTPUT`;
  const endId = `${runTag}-END`;
  const sizeId = `${runTag}-SIZE`;
  const echoId = `${runTag}-ECHO`;
  const inputText = `${runTag}-CONTINUED-INPUT`;
  const finalId = `${runTag}-FINAL`;
  const finalText = `${runTag}-RECOVERED-OUTPUT`;

  const readyMarker = marker("READY", readyId);
  const syncBeginMarker = marker("SYNC_BEGIN", syncId);
  const partialMarker = marker("PRINT", partialId, partialText);
  const offlineMarker = marker("PRINT", offlineId, offlineText);
  const syncEndMarker = marker("SYNC_END", endId);
  const echoReadyMarker = marker("ECHO_INPUT", echoId, "READY");
  const echoPayloadMarker = marker("ECHO_INPUT", echoId, Buffer.from(inputText, "utf8").toString("base64"));
  const finalMarker = marker("PRINT", finalId, finalText);

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as { readonly id: string; readonly name: string };
  expect(created.id).not.toBe("");
  expect(created.name).not.toBe("");
  const terminalId = created.id;
  const pane = new TerminalPanePage(page, terminalId, created.name);
  await pane.expectVisible();
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  const initial = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    acceptingInput: true,
    pendingParserWrites: 0,
    renderBacklogBytes: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.socketGeneration).toBe(1);
  expect(initial.gridEpoch).toEqual(expect.any(Number));

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const beforeDisconnectPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "o-07-before-disconnect",
  });

  const firstProxyOpen = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation === initial.socketGeneration,
  );
  if (!firstProxyOpen || firstProxyOpen.generation === undefined) {
    throw new Error("initial terminal connection has no proxy generation");
  }
  const firstGeneration = firstProxyOpen.generation;
  const syncWrite = Buffer.from(`\x1b[?2026h${syncBeginMarker}\n`, "utf8");
  const partialWrite = Buffer.from(`${partialMarker}\n`, "utf8");
  const transcriptBeforeSync = await server.readTranscript(terminalId);
  const bytesBeforeSync = outputByteCount(transcriptBeforeSync);
  const beforeSyncEvents = await terminalEvents(page, terminalId);
  const beforeSyncEventId = beforeSyncEvents.at(-1)?.id ?? -1;
  const receivedThroughPartial = bytesBeforeSync + syncWrite.byteLength + partialWrite.byteLength;
  const partialReceived = waitForDiagnosticEvent(page, terminalId, "output-received", {
    afterEventId: beforeSyncEventId,
    exactGeneration: initial.socketGeneration,
    minimumReceivedSequence: receivedThroughPartial,
  });
  const syncCommand = `SYNC_BEGIN ${syncId}`;
  await pane.sendInput(syncCommand, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === "SYNC_BEGIN"
      && entry.command_base64 === commandBase64(syncCommand),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sync_begin" && entry.id === syncId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const syncWriteEntry = await server.waitForTranscript<TranscriptEntry>(
    terminalId,
    (entry) => entry.event === "write" && entry.data_base64 === syncWrite.toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(numberField(syncWriteEntry, "bytes")).toBe(syncWrite.byteLength);

  const partialCommand = `PRINT ${partialId} ${partialText}`;
  await pane.sendInput(partialCommand, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === "PRINT"
      && entry.command_base64 === commandBase64(partialCommand),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === partialId && entry.text === partialText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const partialWriteEntry = await server.waitForTranscript<TranscriptEntry>(
    terminalId,
    (entry) => entry.event === "write" && entry.data_base64 === partialWrite.toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(numberField(partialWriteEntry, "bytes")).toBe(partialWrite.byteLength);

  const partialOutput = await partialReceived;
  expect(partialOutput.snapshot.receivedSequence).toBeGreaterThanOrEqual(receivedThroughPartial);
  const socketClosed = waitForDiagnosticEvent(page, terminalId, "socket-close", {
    exactGeneration: initial.socketGeneration,
  });
  const proxyTerminated = faultController.waitFor(
    (event) => event.type === "connection-terminated"
      && event.terminalId === terminalId
      && event.generation === firstGeneration,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const terminateRule = faultController.terminate({ terminalId, generation: firstGeneration });
  try {
    const [terminated, closed] = await Promise.all([proxyTerminated, socketClosed]);
    expect(terminated.abrupt).toBe(true);
    expect(terminated.code).toBe(1006);
    expect(closed.snapshot.socketGeneration).toBe(initial.socketGeneration);
  } finally {
    terminateRule.dispose();
  }

  const transcriptAtDisconnect = await server.readTranscript(terminalId);
  expect(transcriptAtDisconnect.filter((entry) => entry.event === "sync_end" && entry.id === endId)).toEqual([]);
  expect(transcriptAtDisconnect.filter((entry) => entry.event === "sync_begin" && entry.id === syncId)).toHaveLength(1);

  // Keep the interrupted pane offline while a second real browser drives the
  // PTY. This is the production input path, and makes OFFLINE/END occur after
  // the disconnect rather than merely being queued before it.
  await page.context().setOffline(true);
  const peerContext = await browser.newContext({
    baseURL,
    viewport: page.viewportSize() ?? undefined,
  });
  const peerPage = await peerContext.newPage();
  const peerErrors = installBrowserErrorCollectors(peerPage);
  try {
    await peerPage.goto(baseURL);
    await new LoginPage(peerPage).login();
    const peerWorkbench = new WorkbenchPage(peerPage);
    await peerWorkbench.expectVisible();
    const peerPane = await peerWorkbench.openTerminal({ id: terminalId, name: created.name });
    await peerPane.expectVisible();
    await peerPane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });

    const offlineCommand = `PRINT ${offlineId} ${offlineText}`;
    await peerPane.sendInput(offlineCommand, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === offlineId && entry.text === offlineText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const offlineWrite = Buffer.from(`${offlineMarker}\n`, "utf8");
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "write" && entry.data_base64 === offlineWrite.toString("base64"),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );

    const syncEndCommand = `SYNC_END ${endId}`;
    await peerPane.sendInput(syncEndCommand, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "command"
        && entry.operation === "SYNC_END"
        && entry.command_base64 === commandBase64(syncEndCommand),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "sync_end" && entry.id === endId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const syncEndWrite = Buffer.from(`\x1b[?2026l${syncEndMarker}\n`, "utf8");
    const syncEndWriteEntry = await server.waitForTranscript<TranscriptEntry>(
      terminalId,
      (entry) => entry.event === "write" && entry.data_base64 === syncEndWrite.toString("base64"),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(numberField(syncEndWriteEntry, "bytes")).toBe(syncEndWrite.byteLength);
  } finally {
    const peerLogs = peerErrors().filter((entry) => entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message));
    expect(peerLogs).toEqual([]);
    peerErrors.dispose();
    await peerContext.close();
  }

  const beforeRestoreEvents = await terminalEvents(page, terminalId);
  const beforeRestoreEventId = beforeRestoreEvents.at(-1)?.id ?? -1;
  const proxyGenerationsBeforeRestore = faultController.events
    .filter((event) => event.type === "connection-open" && event.terminalId === terminalId)
    .map((event) => event.generation)
    .filter((generation): generation is number => generation !== undefined);
  const highestGenerationBeforeRestore = Math.max(firstGeneration, ...proxyGenerationsBeforeRestore);
  const reconnectOpen = faultController.waitFor(
    (event) => event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation !== undefined
      && event.generation > highestGenerationBeforeRestore,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const recoverySync = waitForDiagnosticEvent(page, terminalId, "sync", {
    afterEventId: beforeRestoreEventId,
    minimumGeneration: initial.socketGeneration + 1,
    mode: "resume",
  });
  const recoverySynced = waitForDiagnosticEvent(page, terminalId, "synced", {
    afterEventId: beforeRestoreEventId,
    minimumGeneration: initial.socketGeneration + 1,
  });
  await page.context().setOffline(false);
  const [reconnected, recoverySyncEvent, recoverySyncedEvent] = await Promise.all([
    reconnectOpen,
    recoverySync,
    recoverySynced,
  ]);
  if (reconnected.generation === undefined) throw new Error("reconnect proxy event has no generation");
  expect(reconnected.generation).toBeGreaterThan(highestGenerationBeforeRestore);
  expect(recoverySyncEvent.data.mode).toBe("resume");
  expect(recoverySyncEvent.snapshot.syncMode).toBe("resume");
  expect(recoverySyncedEvent.snapshot.socketState).toBe("connected");
  expect(recoverySyncedEvent.snapshot.acceptingInput).toBe(true);
  expect(recoverySyncedEvent.snapshot.gridEpoch).toBe(initial.gridEpoch);

  await expectTerminalBuffer(page, terminalId, { contains: syncBeginMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: partialMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: offlineMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: syncEndMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const recovered = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(recovered.syncMode).toBeUndefined();
  expect(recovered.syncTarget).toBeUndefined();
  expect(recovered.activeSocketCount).toBe(1);
  expect(recovered.committedSequence).toBe(recovered.receivedSequence);
  expect(recovered.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  const recoveredPixels = await screenshotRegion(page, pane.xtermHost);
  const beforeFinal = await pane.snapshot();
  if (!beforeFinal) throw new Error("missing recovered diagnostics snapshot");
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await server.waitForTranscript<TranscriptEntry>(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(numberField(sizeEntry, "rows")).toBe(recovered.rows);
  expect(numberField(sizeEntry, "cols")).toBe(recovered.cols);
  const sizeMarker = marker("SIZE", sizeId, String(sizeEntry.rows), String(sizeEntry.cols));
  await expectTerminalBuffer(page, terminalId, { contains: sizeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalConverged(page, terminalId, { rows: recovered.rows, cols: recovered.cols }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: echoReadyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(inputText, true);
  const echoPayload = await server.waitForTranscript<TranscriptEntry>(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(inputText, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(stringField(echoPayload, "payload_base64")).toBe(Buffer.from(inputText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, terminalId, { contains: echoPayloadMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: finalMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await waitForRenderAfter(page, terminalId, beforeFinal.renderCount);
  const afterFinalPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(recoveredPixels, afterFinalPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "o-07-recovered-marker",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "o-07-recovered-terminal",
  });

  const connectedBeforeExit = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(connectedBeforeExit.snapshot.syncMode).toBeUndefined();
  expect(connectedBeforeExit.snapshot.syncTarget).toBeUndefined();
  expect(connectedBeforeExit.snapshot.pendingParserWrites).toBe(0);
  expect(connectedBeforeExit.snapshot.pendingParserBytes).toBe(0);
  expect(connectedBeforeExit.snapshot.renderBacklogBytes).toBe(0);
  expect(connectedBeforeExit.snapshot.renderBacklogFrames).toBe(0);
  expect(connectedBeforeExit.snapshot.serverViewport?.cols).toBe(connectedBeforeExit.snapshot.cols);
  expect(connectedBeforeExit.snapshot.serverViewport?.rows).toBe(connectedBeforeExit.snapshot.rows);

  const exitCommand = `EXIT ${EXPECTED_EXIT_CODE}`;
  await pane.sendInput(exitCommand, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "exit_requested" && entry.code === EXPECTED_EXIT_CODE,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "exit" && entry.code === EXPECTED_EXIT_CODE,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await waitForDiagnosticEvent(page, terminalId, "exit", { minimumGeneration: initial.socketGeneration + 1 });
  const finalSnapshot = await waitForTerminalState(page, terminalId, {
    socketState: "exited",
    acceptingInput: false,
    activeSocketCount: 0,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(finalSnapshot.exitCode).toBe(EXPECTED_EXIT_CODE);
  expect(finalSnapshot.gridEpoch).toBe(initial.gridEpoch);
  expect(finalSnapshot.syncMode).toBeUndefined();
  expect(finalSnapshot.syncTarget).toBeUndefined();

  const finalTranscript = await server.readTranscript(terminalId);
  assertCommandSequence(finalTranscript, [
    `READY ${readyId}`,
    syncCommand,
    partialCommand,
    `PRINT ${offlineId} ${offlineText}`,
    `SYNC_END ${endId}`,
    `SIZE ${sizeId}`,
    `ECHO_INPUT ${echoId}`,
    inputText,
    `PRINT ${finalId} ${finalText}`,
    exitCommand,
  ]);
  expect(finalTranscript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "sync_begin" && entry.id === syncId)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === partialId && entry.text === partialText)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === offlineId && entry.text === offlineText)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "sync_end" && entry.id === endId)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "exit" && entry.code === EXPECTED_EXIT_CODE)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "error")).toEqual([]);
  expect(finalSnapshot.receivedSequence).toBe(outputByteCount(finalTranscript));
  expect(finalSnapshot.committedSequence).toBe(outputByteCount(finalTranscript));

  const finalBytes = outputBytes(finalTranscript);
  const beginBytes = Buffer.from("\x1b[?2026h", "utf8");
  const endBytes = Buffer.from("\x1b[?2026l", "utf8");
  let beginOffset = finalBytes.indexOf(beginBytes);
  let endOffset = finalBytes.indexOf(endBytes);
  expect(beginOffset).toBeGreaterThanOrEqual(0);
  expect(endOffset).toBeGreaterThan(beginOffset);
  expect(finalBytes.indexOf(beginBytes, beginOffset + 1)).toBe(-1);
  expect(finalBytes.indexOf(endBytes, endOffset + 1)).toBe(-1);
  expect(finalBytes.subarray(endOffset + endBytes.byteLength).includes(beginBytes)).toBe(false);

  const modelResult = await modelFromTranscript(finalTranscript, finalSnapshot.cols, finalSnapshot.rows);
  try {
    expect(modelResult.terminal.buffer.active.type).toBe(finalSnapshot.xterm.activeBuffer);
    expect(modelResult.terminal.buffer.active.cursorX).toBe(finalSnapshot.xterm.cursorX);
    expect(modelResult.terminal.buffer.active.cursorY).toBe(finalSnapshot.xterm.cursorY);
    expect(modelResult.terminal.buffer.active.viewportY).toBe(finalSnapshot.xterm.viewportY);
    expect(finalSnapshot.xterm.selectionText).toBe("");
    expect(modelResult.terminal.modes.synchronizedOutputMode).toBe(false);
    expect(modelResult.text).toBe(finalSnapshot.xterm.text);
  } finally {
    modelResult.terminal.dispose();
  }

  assertMarkerOnce(finalSnapshot.xterm.text, readyMarker, "READY marker");
  assertMarkerOnce(finalSnapshot.xterm.text, syncBeginMarker, "SYNC_BEGIN marker");
  assertMarkerOnce(finalSnapshot.xterm.text, partialMarker, "partial marker");
  assertMarkerOnce(finalSnapshot.xterm.text, offlineMarker, "offline marker");
  assertMarkerOnce(finalSnapshot.xterm.text, syncEndMarker, "SYNC_END marker");
  assertMarkerOnce(finalSnapshot.xterm.text, sizeMarker, "SIZE marker");
  assertMarkerOnce(finalSnapshot.xterm.text, echoReadyMarker, "echo ready marker");
  assertMarkerOnce(finalSnapshot.xterm.text, echoPayloadMarker, "echo payload marker");
  assertMarkerOnce(finalSnapshot.xterm.text, finalMarker, "final marker");
  assertMarkerOnce(finalSnapshot.xterm.text, marker("EXIT", String(EXPECTED_EXIT_CODE)), "EXIT marker");

  const primaryEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(primaryEvents);
  const createdSockets = primaryEvents.filter((event) => event.type === "socket-created");
  expect(createdSockets.length).toBeGreaterThanOrEqual(2);
  expect(createdSockets.length).toBeLessThanOrEqual(4);
  expect(primaryEvents.filter((event) => event.type === "socket-open")).toHaveLength(2);
  expect(primaryEvents.filter((event) => event.type === "sync")).toHaveLength(2);
  expect(primaryEvents.filter((event) => event.type === "synced")).toHaveLength(2);
  expect(primaryEvents.filter((event) => event.type === "socket-stale")).toEqual([]);
  expect(primaryEvents.filter((event) => event.type === "error")).toEqual([]);
  const exitEventIndex = primaryEvents.findIndex((event) => event.type === "exit");
  expect(exitEventIndex).toBeGreaterThanOrEqual(0);
  expect(primaryEvents.slice(exitEventIndex + 1).filter((event) => (
    event.type === "socket-created"
      || event.type === "socket-open"
      || event.type === "sync"
      || event.type === "synced"
      || event.type === "state" && ["connecting", "recovering", "disconnected"].includes(String(event.data.state))
  ))).toEqual([]);

  const recoveryFrames = faultController.events.filter((event) => event.terminalId === terminalId && event.generation === reconnected.generation);
  const recoverySyncFrame = recoveryFrames.findIndex((event) => event.type === "frame" && event.direction === "server-to-browser" && event.frame?.jsonType === "sync");
  const recoveryOutputFrame = recoveryFrames.findIndex((event) => event.type === "frame" && event.direction === "server-to-browser" && event.frame?.binaryKind === 1);
  const recoverySyncedFrame = recoveryFrames.findIndex((event) => event.type === "frame" && event.direction === "server-to-browser" && event.frame?.jsonType === "synced");
  expect(recoverySyncFrame).toBeGreaterThanOrEqual(0);
  expect(recoveryOutputFrame).toBeGreaterThan(recoverySyncFrame);
  expect(recoverySyncedFrame).toBeGreaterThan(recoveryOutputFrame);
  expect(recoveryFrames.filter((event) => event.type === "frame" && event.direction === "server-to-browser" && event.frame?.binaryKind === 0)).toEqual([]);

  expect(browserErrors).toEqual([]);
  await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
});
