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
  waitForTerminalEvent,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank as expectPixelsNonBlank,
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

const WAIT_TIMEOUT_MS = 45_000;
const REPAINT_BYTES = 1_300_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TranscriptEntry = Record<string, unknown>;

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
  readonly createdAt: number;
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

function commandCount(entries: readonly TranscriptEntry[], command: string): number {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return entries.filter((entry) => (
    entry.event === "command"
    && entry.command_base64 === encoded
  )).length;
}

function outputByteCount(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.event !== "write") return total;
    const bytes = entry.bytes;
    return total + (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0);
  }, 0);
}

function markerOccurrences(text: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(marker, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, marker.length);
  }
  return count;
}

async function waitForSocketClose(
  page: Page,
  terminalId: string,
  generation: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.type === "socket-close" && event.data.generation === generation,
      { timeout },
    );
  }, { id: terminalId, generation, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRecoverySync(page: Page, terminalId: string, generation: number): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.type === "sync"
        && event.snapshot.socketGeneration > generation
        && (event.data.mode === "resume" || event.data.mode === "snapshot"),
      { timeout },
    );
  }, { id: terminalId, generation, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRecoverySynced(page: Page, terminalId: string, generation: number): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.type === "synced" && event.snapshot.socketGeneration > generation,
      { timeout },
    );
  }, { id: terminalId, generation, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRecoveredTerminal(
  page: Page,
  terminalId: string,
  generation: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration > generation
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
    ), { timeout });
  }, { id: terminalId, generation, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRenderAfter(page: Page, terminalId: string, renderCount: number): Promise<void> {
  await page.evaluate(async ({ id, renderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > renderCount && snapshot.pendingParserWrites === 0
    ), { timeout });
  }, { id: terminalId, renderCount, timeout: WAIT_TIMEOUT_MS });
}

async function waitForPostFontViewport(
  page: Page,
  terminalId: string,
  fontLoaded: E2ETerminalEvent,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, fontEventId, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const aligned = (snapshot: E2ETerminalSnapshot): boolean => {
      const matchesCurrent = (viewport: E2ETerminalSnapshot["serverViewport"]): boolean => (
        viewport !== undefined
        && viewport.cols === snapshot.cols
        && viewport.rows === snapshot.rows
        && viewport.pixelWidth === snapshot.pixelWidth
        && viewport.pixelHeight === snapshot.pixelHeight
      );
      return matchesCurrent(snapshot.desiredViewport)
        && matchesCurrent(snapshot.sentViewport)
        && matchesCurrent(snapshot.serverViewport);
    };
    await api.waitForEvent(
      id,
      (event) => event.id > fontEventId && event.type === "viewport" && event.data.source === "proposed",
      { timeout },
    );
    return api.waitForTerminal(id, aligned, { timeout });
  }, { id: terminalId, fontEventId: fontLoaded.id, timeout: WAIT_TIMEOUT_MS });
}

test("C-03 Offline and online transition @p1 @recovery @offline @online @nightly", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const runTag = `C03-${testInfo.project.name}-w${testInfo.workerIndex}-r${testInfo.retry}-e${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-ready`;
  const beforeId = `${runTag}-before-offline`;
  const repaintId = `${runTag}-repaint`;
  const sizeId = `${runTag}-size`;
  const echoId = `${runTag}-echo`;
  const inputText = `${runTag}-continued-input`;
  const afterId = `${runTag}-after-online`;
  const beforeMarker = `[E2E:PRINT:${beforeId}:before-offline]`;
  const repaintMarker = `[E2E:REPAINT:${repaintId}:FRAME]`;
  const readyMarker = `[E2E:READY:${readyId}]`;
  const echoReadyMarker = `[E2E:ECHO_INPUT:${echoId}:READY]`;
  const echoPayloadMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(inputText, "utf8").toString("base64")}]`;
  const afterMarker = `[E2E:PRINT:${afterId}:after-online]`;

  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountEvent = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.snapshot.kind === "pane",
      { timeout },
    );
  }, WAIT_TIMEOUT_MS);
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  const synchronized = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const fontLoaded = await waitForTerminalEvent(page, terminalId, "font-load", { timeout: WAIT_TIMEOUT_MS });
  expect(fontLoaded.data.result).toBe("settled");
  const initial = await waitForPostFontViewport(page, terminalId, fontLoaded);
  expect(synchronized.socketGeneration).toBe(1);
  expect(initial.socketState).toBe("connected");
  expect(initial.acceptingInput).toBe(true);
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);
  expect(initial.serverViewport).toBeDefined();
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  if (initial.gridEpoch === undefined) throw new Error("initial terminal diagnostics did not expose a grid epoch");
  const initialTerminal = await readTerminal(page, terminalId);
  expect(initialTerminal.id).toBe(terminalId);
  expect(initialTerminal.status).toBe("running");
  if (initialTerminal.pid === null) throw new Error(`terminal ${terminalId} has no running process identity`);
  const initialPid = initialTerminal.pid;

  const readyCommand = `READY ${readyId}`;
  await pane.sendInput(readyCommand, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const beforeCommand = `PRINT ${beforeId} before-offline`;
  await pane.sendInput(beforeCommand, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === beforeId && entry.text === "before-offline", { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const beforeOfflinePixels = await screenshotRegion(page, pane.xtermHost);
  await expectPixelsNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c03-before-offline-terminal",
  });

  const baseline = await terminalSnapshot(page, terminalId);
  if (!baseline) throw new Error(`missing baseline diagnostics for terminal ${terminalId}`);
  expect(baseline.socketState).toBe("connected");
  expect(baseline.activeSocketCount).toBe(1);
  expect(baseline.gridEpoch).toBe(initial.gridEpoch);
  const initialProxyConnection = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
  );
  if (!initialProxyConnection || initialProxyConnection.generation === undefined) {
    throw new Error("initial proxy connection did not expose a generation");
  }
  expect(initialProxyConnection.generation).toBe(baseline.socketGeneration);
  const initialProxyGeneration = initialProxyConnection.generation;

  const repaintCommand = `REPAINT ${repaintId} ${REPAINT_BYTES}`;
  await pane.sendInput(repaintCommand, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === "REPAINT"
      && entry.command_base64 === Buffer.from(repaintCommand, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const socketClosedPromise = waitForSocketClose(page, terminalId, baseline.socketGeneration);
  const proxyDisconnectedPromise = faultController.waitFor(
    (event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation === initialProxyGeneration
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const repaintWrittenPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "write" && entry.bytes === REPAINT_BYTES,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  let offline = false;
  try {
    // The REPAINT command has already entered the fixture before the browser
    // is taken offline, so the PTY continues producing output independently.
    await page.context().setOffline(true);
    offline = true;
    const [socketClosed, proxyDisconnected, repaintWritten] = await Promise.all([
      socketClosedPromise,
      proxyDisconnectedPromise,
      repaintWrittenPromise,
    ]);
    expect(socketClosed.data.generation).toBe(baseline.socketGeneration);
    expect(proxyDisconnected.generation).toBe(initialProxyGeneration);
    expect(repaintWritten.bytes).toBe(REPAINT_BYTES);

    const reconnectProxyPromise = faultController.waitFor(
      (event) => event.type === "connection-open"
        && event.terminalId === terminalId
        && event.generation !== undefined
        && event.generation > initialProxyGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const recoverySyncPromise = waitForRecoverySync(page, terminalId, baseline.socketGeneration);
    const recoverySyncedPromise = waitForRecoverySynced(page, terminalId, baseline.socketGeneration);

    // Restore only after both transport and diagnostic close boundaries have
    // been observed; the following open/sync/synced events are the recovery.
    await page.context().setOffline(false);
    offline = false;
    const [reconnectProxy, recoverySync, recoverySynced] = await Promise.all([
      reconnectProxyPromise,
      recoverySyncPromise,
      recoverySyncedPromise,
    ]);
    expect(reconnectProxy.generation).toBe(baseline.socketGeneration + 1);
    expect(recoverySync.snapshot.socketGeneration).toBe(baseline.socketGeneration + 1);
    expect(recoverySync.data.mode).toBe("resume");
    expect(recoverySynced.snapshot.socketGeneration).toBe(baseline.socketGeneration + 1);
  } finally {
    if (offline) await page.context().setOffline(false);
  }

  const recovered = await waitForRecoveredTerminal(page, terminalId, baseline.socketGeneration);
  expect(recovered.socketGeneration).toBe(baseline.socketGeneration + 1);
  expect(recovered.socketState).toBe("connected");
  expect(recovered.acceptingInput).toBe(true);
  expect(recovered.gridEpoch).toBe(baseline.gridEpoch);
  expect(recovered.cols).toBe(baseline.cols);
  expect(recovered.rows).toBe(baseline.rows);
  expect(recovered.serverViewport?.cols).toBe(recovered.cols);
  expect(recovered.serverViewport?.rows).toBe(recovered.rows);
  expect(recovered.sentViewport?.cols).toBe(baseline.sentViewport?.cols);
  expect(recovered.sentViewport?.rows).toBe(baseline.sentViewport?.rows);
  expect(recovered.syncMode).toBeUndefined();

  const sizeCommand = `SIZE ${sizeId}`;
  await pane.sendInput(sizeCommand, true);
  const sizeEntry = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const ptyRows = Number(sizeEntry.rows);
  const ptyCols = Number(sizeEntry.cols);
  expect(Number.isInteger(ptyRows)).toBe(true);
  expect(Number.isInteger(ptyCols)).toBe(true);
  expect(ptyRows).toBe(recovered.rows);
  expect(ptyCols).toBe(recovered.cols);
  const sizeMarker = `[E2E:SIZE:${sizeId}:${ptyRows}:${ptyCols}]`;
  await expectTerminalBuffer(page, terminalId, { contains: sizeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

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

  const beforeFinal = await terminalSnapshot(page, terminalId);
  if (!beforeFinal) throw new Error(`missing pre-final diagnostics for terminal ${terminalId}`);
  const beforeFinalPixels = await screenshotRegion(page, pane.xtermHost);
  const afterCommand = `PRINT ${afterId} after-online`;
  await pane.sendInput(afterCommand, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === afterId && entry.text === "after-online", { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await waitForRenderAfter(page, terminalId, beforeFinal.renderCount);
  await expectKnownMarkerChanged(page, pane.xtermHost, beforeFinalPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "c03-after-online-marker",
  });
  await expectPixelsNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c03-after-online-terminal",
  });

  const finalSnapshot = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    activeSocketCount: 1,
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(finalSnapshot.socketGeneration).toBe(baseline.socketGeneration + 1);
  expect(finalSnapshot.gridEpoch).toBe(baseline.gridEpoch);
  expect(finalSnapshot.cols).toBe(recovered.cols);
  expect(finalSnapshot.rows).toBe(recovered.rows);
  expect(finalSnapshot.serverViewport?.cols).toBe(finalSnapshot.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(finalSnapshot.rows);
  expect(finalSnapshot.xterm.text).toContain(readyMarker);
  expect(finalSnapshot.xterm.text).toContain(beforeMarker);
  expect(finalSnapshot.xterm.text).toContain(repaintMarker);
  expect(finalSnapshot.xterm.text).toContain(sizeMarker);
  expect(finalSnapshot.xterm.text).toContain(echoReadyMarker);
  expect(finalSnapshot.xterm.text).toContain(echoPayloadMarker);
  expect(finalSnapshot.xterm.text).toContain(afterMarker);
  expect(markerOccurrences(finalSnapshot.xterm.text, beforeMarker)).toBe(1);
  expect(markerOccurrences(finalSnapshot.xterm.text, afterMarker)).toBe(1);
  expect(markerOccurrences(finalSnapshot.xterm.text, echoPayloadMarker)).toBe(1);

  await expectTerminalConverged(page, terminalId, {
    cols: finalSnapshot.cols,
    rows: finalSnapshot.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectPixelsNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c03-final-terminal",
  });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  assertNoPendingSynchronization(finalSnapshot);
  assertNoUnexpectedSocketMultiplication([initial, baseline, recovered, finalSnapshot]);

  const finalTerminal = await readTerminal(page, terminalId);
  expect(finalTerminal.id).toBe(terminalId);
  expect(finalTerminal.status).toBe("running");
  expect(finalTerminal.pid).toBe(initialPid);

  const transcript = await server.readTranscript(terminalId);
  for (const command of [readyCommand, beforeCommand, repaintCommand, sizeCommand, echoCommand, inputText, afterCommand]) {
    expect(commandCount(transcript, command), `fixture command duplicated or omitted: ${command}`).toBe(1);
  }
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === beforeId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === REPAINT_BYTES)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "write" && entry.bytes === REPAINT_BYTES)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === afterId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(0);
  expect(finalSnapshot.receivedSequence).toBe(outputByteCount(transcript));
  expect(finalSnapshot.committedSequence).toBe(outputByteCount(transcript));

  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  const socketCreated = events.filter((event) => event.type === "socket-created");
  const socketOpened = events.filter((event) => event.type === "socket-open");
  const socketClosed = events.filter((event) => event.type === "socket-close");
  const syncEvents = events.filter((event) => event.type === "sync");
  const syncedEvents = events.filter((event) => event.type === "synced");
  expect(socketCreated).toHaveLength(2);
  expect(socketOpened).toHaveLength(2);
  expect(socketClosed).toHaveLength(1);
  expect(syncEvents).toHaveLength(2);
  expect(syncEvents[1]?.data.mode).toBe("resume");
  expect(syncedEvents).toHaveLength(2);
  expect(events.some((event) => event.type === "state" && event.data.state === "disconnected")).toBe(true);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);

  const proxyConnections = faultController.events.filter((event) => event.type === "connection-open" && event.terminalId === terminalId);
  expect(proxyConnections).toHaveLength(2);
  const proxyDisconnects = faultController.events.filter((event) => (
    (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation === initialProxyGeneration
  ));
  expect(proxyDisconnects).toHaveLength(1);

  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
  expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);
  expect(beforeOfflinePixels.width).toBe(beforeFinalPixels.width);
  expect(beforeOfflinePixels.height).toBe(beforeFinalPixels.height);
});
