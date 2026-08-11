import { test, expect } from "../fixtures/test.js";
import type { BrowserContext, Page } from "@playwright/test";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants, expectTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type ViewportField = "desiredViewport" | "sentViewport" | "serverViewport";

const WAIT_TIMEOUT_MS = 30_000;
const VIEWPORT_SETTLE_MS = 120;
const BURST_BYTES = 131_072;
const BURST_LINE_WIDTH = 96;
const SNAPSHOT_THROTTLE_BYTES_PER_SECOND = 64 * 1024;
const UPGRADE_DELAY_MS = 60_000;
const VIEWPORT_A = { width: 1_280, height: 800 };
const VIEWPORT_B = { width: 900, height: 620 };
const VIEWPORT_C = { width: 1_520, height: 900 };

interface DiagnosticEventWait {
  readonly type: E2ETerminalEventType;
  readonly generation?: number;
  readonly syncMode?: "snapshot" | "resume";
  readonly syncDataMode?: "snapshot" | "resume";
  readonly parserActive?: boolean;
}

async function waitForDiagnosticEvent(
  page: Page,
  terminalId: string,
  options: DiagnosticEventWait,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, type, generation, syncMode, syncDataMode, parserActive, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === type
      && (generation === undefined || event.snapshot.socketGeneration === generation)
      && (syncMode === undefined || event.snapshot.syncMode === syncMode)
      && (syncDataMode === undefined || event.data.mode === syncDataMode)
      && (!parserActive || event.snapshot.pendingParserWrites > 0)
    ), { timeout });
  }, { id: terminalId, ...options, timeout: WAIT_TIMEOUT_MS });
}

async function waitForTerminalPredicate(
  page: Page,
  terminalId: string,
  predicate: (snapshot: E2ETerminalSnapshot) => boolean,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, predicateSource, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const predicate = (0, eval)(`(${predicateSource})`) as (snapshot: E2ETerminalSnapshot) => boolean;
    return api.waitForTerminal(id, predicate, { timeout });
  }, { id: terminalId, predicateSource: predicate.toString(), timeout: WAIT_TIMEOUT_MS });
}

async function waitForViewportChange(
  page: Page,
  terminalId: string,
  previous: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, cols, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      return desired !== undefined
        && desired.cols > 0
        && desired.rows > 0
        && (desired.cols !== cols || desired.rows !== rows);
    }, { timeout });
  }, { id: terminalId, cols: previous.cols, rows: previous.rows, timeout: WAIT_TIMEOUT_MS });
}

async function waitForExactViewport(
  page: Page,
  terminalId: string,
  field: ViewportField,
  expected: E2EViewport,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, field, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot[field];
      return viewport !== undefined
        && viewport.cols === expected.cols
        && viewport.rows === expected.rows
        && viewport.pixelWidth === expected.pixelWidth
        && viewport.pixelHeight === expected.pixelHeight;
    }, { timeout });
  }, { id: terminalId, field, expected, timeout: WAIT_TIMEOUT_MS });
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
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence !== undefined
      && snapshot.receivedSequence >= minimum
      && snapshot.committedSequence === snapshot.receivedSequence
    ), { timeout });
  }, { id: terminalId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
}

async function waitForGenerationSettled(
  page: Page,
  terminalId: string,
  generation: number,
  expected: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration === generation
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.syncMode === undefined
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.cols === expected.cols
      && snapshot.rows === expected.rows
      && snapshot.desiredViewport?.cols === expected.cols
      && snapshot.desiredViewport?.rows === expected.rows
      && snapshot.sentViewport?.cols === expected.cols
      && snapshot.sentViewport?.rows === expected.rows
      && snapshot.serverViewport?.cols === expected.cols
      && snapshot.serverViewport?.rows === expected.rows
    ), { timeout });
  }, { id: terminalId, generation, expected, timeout: WAIT_TIMEOUT_MS });
}

async function waitForGridEpochAfter(
  page: Page,
  terminalId: string,
  minimumEpoch: number,
): Promise<E2ETerminalSnapshot> {
  return waitForTerminalPredicate(page, terminalId, (snapshot) => (
    snapshot.socketState === "connected"
    && snapshot.acceptingInput
    && snapshot.syncMode === undefined
    && snapshot.gridEpoch !== undefined
    && snapshot.gridEpoch > minimumEpoch
  ));
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function occurrenceCount(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
}

function browserErrorMessages(errors: readonly string[]): string[] {
  return errors.filter((message) => message.length > 0);
}

test("V-05 Resize during snapshot stream @p1 @nightly @resize @snapshot", async ({
  browser,
  baseURL,
  page,
  server,
  faultController,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  let secondaryContext: BrowserContext | undefined;
  const runToken = `V05-W${testInfo.workerIndex}-R${testInfo.retry}-I${testInfo.repeatEachIndex}`;
  const readyId = `${runToken}-READY`;
  const baselineId = `${runToken}-BASELINE`;
  const burstId = `${runToken}-BURST`;
  const holdToken = `${runToken}-SNAPSHOT-HOLD`;
  const winchId = `${runToken}-WINCH`;
  const finalId = `${runToken}-FINAL`;
  const finalText = `${runToken}-C-GRID`;
  const queryId = `${runToken}-QUERY`;
  const sizeId = `${runToken}-SIZE`;
  const echoId = `${runToken}-ECHO`;
  const echoText = `${runToken}-CONTINUED-INPUT`;
  const echoBase64 = Buffer.from(echoText, "utf8").toString("base64");

  await page.setViewportSize(VIEWPORT_A);
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountPromise = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, WAIT_TIMEOUT_MS);
  await workbench.createTerminal();
  const mounted = await mountPromise;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();

  const initialOpenPromise = faultController.waitFor(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  const initialOpen = await initialOpenPromise;
  if (initialOpen.generation === undefined) throw new Error("initial terminal connection has no proxy generation");
  const initialGeneration = initialOpen.generation;

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: marker("READY", readyId), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`PRINT ${baselineId} ${runToken}-A-GRID`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === baselineId, { timeoutMs: WAIT_TIMEOUT_MS });
  const baselineMarker = marker("PRINT", baselineId, `${runToken}-A-GRID`);
  await expectTerminalBuffer(page, terminalId, { contains: baselineMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const beforeBurst = await pane.snapshot();
  if (!beforeBurst) throw new Error(`terminal ${terminalId} diagnostics disappeared before BURST`);
  const burstStartSequence = beforeBurst.committedSequence ?? beforeBurst.receivedSequence ?? 0;
  await pane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const afterBurst = await waitForSettledSequence(page, terminalId, burstStartSequence + BURST_BYTES);

  await pane.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
  const baseline = await pane.snapshot();
  if (!baseline) throw new Error(`terminal ${terminalId} diagnostics disappeared before disconnect`);
  if (baseline.gridEpoch === undefined) throw new Error("initial terminal snapshot has no grid epoch");
  const staleSequence = baseline.committedSequence ?? baseline.receivedSequence;
  if (staleSequence === undefined) throw new Error("initial terminal snapshot has no committed sequence");
  expect(staleSequence).toBeGreaterThanOrEqual(afterBurst.committedSequence ?? afterBurst.receivedSequence ?? 0);
  const baselineEpoch = baseline.gridEpoch;
  const baselineGeometry = baseline.serverViewport ?? baseline.viewport;
  expect(baselineGeometry.cols).toBeGreaterThan(0);
  expect(baselineGeometry.rows).toBeGreaterThan(0);

  const delayedReconnect = faultController.delayUpgrade({
    terminalId,
    generation: initialGeneration + 1,
  }, UPGRADE_DELAY_MS);
  try {
    const firstTermination = faultController.waitFor(
      (event) => event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.generation === initialGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const firstSocketClose = waitForDiagnosticEvent(page, terminalId, {
      type: "socket-close",
      generation: initialGeneration,
    });
    const closeInitial = faultController.terminate({ terminalId, generation: initialGeneration });
    await Promise.all([firstTermination, firstSocketClose]);
    closeInitial.dispose();

    const delayedOpen = await faultController.waitFor(
      (event) => event.type === "upgrade-delay"
        && event.terminalId === terminalId
        && event.generation === initialGeneration + 1,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(delayedOpen.bytes).toBe(UPGRADE_DELAY_MS);
    const delayedSocket = await waitForDiagnosticEvent(page, terminalId, {
      type: "socket-created",
      generation: initialGeneration + 1,
    });
    expect(delayedSocket.snapshot.socketUrl).toContain(`sequence=${staleSequence}`);
    expect(delayedSocket.snapshot.socketUrl).toContain(`epoch=${baselineEpoch}`);

    secondaryContext = await browser.newContext({ baseURL, viewport: VIEWPORT_B });
    const pageB = await secondaryContext.newPage();
    const secondaryErrors: string[] = [];
    pageB.on("pageerror", (error) => secondaryErrors.push(error.message));
    pageB.on("console", (message) => {
      if (message.type() === "error") secondaryErrors.push(message.text());
    });
    const secondaryOpenPromise = faultController.waitFor(
      (event) => event.type === "connection-open"
        && event.terminalId === terminalId
        && event.generation !== undefined
        && event.generation > initialGeneration + 1,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pageB.goto("/");
    await new LoginPage(pageB).login();
    const workbenchB = new WorkbenchPage(pageB);
    await workbenchB.expectVisible();
    const paneB = await workbenchB.openTerminal({ id: terminalId });
    await paneB.expectVisible();
    await paneB.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    const secondaryOpen = await secondaryOpenPromise;
    if (secondaryOpen.generation === undefined) throw new Error("secondary terminal connection has no proxy generation");
    const secondaryGeneration = secondaryOpen.generation;
    await paneB.focusSize();
    const secondaryEpochSnapshot = await waitForGridEpochAfter(pageB, terminalId, baselineEpoch);
    const secondaryGeometry = secondaryEpochSnapshot.serverViewport ?? secondaryEpochSnapshot.viewport;
    expect(secondaryGeometry.cols !== baselineGeometry.cols || secondaryGeometry.rows !== baselineGeometry.rows).toBe(true);
    expect(secondaryEpochSnapshot.gridEpoch).toBeGreaterThan(baselineEpoch);
    expect(browserErrorMessages(secondaryErrors)).toEqual([]);

    const secondaryClosed = faultController.waitFor(
      (event) => event.type === "connection-closed"
        && event.terminalId === terminalId
        && event.generation === secondaryGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await secondaryContext.close();
    secondaryContext = undefined;
    await secondaryClosed;

    const delayedTermination = faultController.waitFor(
      (event) => event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.generation === initialGeneration + 1,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const replacementOpenPromise = faultController.waitFor(
      (event) => event.type === "connection-open"
        && event.terminalId === terminalId
        && event.generation !== undefined
        && event.generation > initialGeneration + 1,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const terminateDelayed = faultController.terminate({ terminalId, generation: initialGeneration + 1 });
    await delayedTermination;
    terminateDelayed.dispose();
    delayedReconnect.dispose();

    const replacementOpen = await replacementOpenPromise;
    if (replacementOpen.generation === undefined) throw new Error("replacement terminal connection has no proxy generation");
    const replacementGeneration = replacementOpen.generation;
    expect(replacementGeneration).toBeGreaterThan(secondaryGeneration);
    const replacementSocket = await waitForDiagnosticEvent(page, terminalId, {
      type: "socket-created",
      generation: replacementGeneration,
    });
    expect(replacementSocket.snapshot.socketUrl).toContain(`sequence=${staleSequence}`);
    expect(replacementSocket.snapshot.socketUrl).toContain(`epoch=${baselineEpoch}`);

    const snapshotThrottle = faultController.throttle(
      "server-to-browser",
      SNAPSHOT_THROTTLE_BYTES_PER_SECOND,
      { terminalId },
    );
    try {
      const snapshotSyncPromise = waitForDiagnosticEvent(page, terminalId, {
        type: "sync",
        generation: replacementGeneration,
        syncDataMode: "snapshot",
      });
      const snapshotParserPromise = waitForDiagnosticEvent(page, terminalId, {
        type: "snapshot",
        generation: replacementGeneration,
        syncMode: "snapshot",
        parserActive: true,
      });
      const snapshotSync = await snapshotSyncPromise;
      expect(snapshotSync.snapshot.gridEpoch).toBeGreaterThan(baselineEpoch);
      const parserStarted = await snapshotParserPromise;
      expect(parserStarted.snapshot.pendingParserWrites).toBeGreaterThan(0);
      expect(parserStarted.snapshot.pendingParserBytes).toBeGreaterThan(0);

      const parserBeforeResize = await pane.snapshot();
      if (!parserBeforeResize) throw new Error("replacement terminal diagnostics disappeared during snapshot parse");
      expect(parserBeforeResize.syncMode).toBe("snapshot");
      expect(parserBeforeResize.pendingParserWrites).toBeGreaterThan(0);

      const desiredViewportPromise = waitForViewportChange(page, terminalId, {
        cols: parserBeforeResize.cols,
        rows: parserBeforeResize.rows,
      });
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      await page.setViewportSize(VIEWPORT_C);
      await page.clock.runFor(VIEWPORT_SETTLE_MS + 1);
      const resized = await desiredViewportPromise;
      await page.clock.resume();
      const geometryC = resized.desiredViewport;
      if (!geometryC) throw new Error("replacement terminal did not report desired viewport C");
      expect(geometryC.cols > 0 && geometryC.rows > 0).toBe(true);
      expect(geometryC.cols !== baselineGeometry.cols || geometryC.rows !== baselineGeometry.rows).toBe(true);
      expect(geometryC.cols !== secondaryGeometry.cols || geometryC.rows !== secondaryGeometry.rows).toBe(true);

      const sentC = await waitForExactViewport(page, terminalId, "sentViewport", geometryC);
      expect(sentC.sentViewport?.cols).toBe(geometryC.cols);
      expect(sentC.sentViewport?.rows).toBe(geometryC.rows);
      const resizeFrame = await faultController.waitFor(
        (event) => event.type === "frame"
          && event.terminalId === terminalId
          && event.generation === replacementGeneration
          && event.direction === "browser-to-server"
          && event.frame?.jsonType === "resize",
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      expect(resizeFrame.frame?.jsonType).toBe("resize");

      snapshotThrottle.dispose();
      await pane.sendInput(`RELEASE ${holdToken}`, true);
      await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });

      const signalC = server.waitForTranscript(
        terminalId,
        (entry) => entry.event === "sigwinch"
          && entry.source === "signal"
          && entry.rows === geometryC.rows
          && entry.cols === geometryC.cols,
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      await pane.sendInput(`WINCH ${winchId} 1 ${geometryC.rows} ${geometryC.cols}`, true);
      const commandWinch = await server.waitForTranscript(
        terminalId,
        (entry) => entry.event === "sigwinch"
          && entry.source === "command"
          && entry.id === winchId
          && entry.signal_sequence === 1
          && entry.rows === geometryC.rows
          && entry.cols === geometryC.cols,
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      const signalWinch = await signalC;
      expect(commandWinch.rows).toBe(signalWinch.rows);
      expect(commandWinch.cols).toBe(signalWinch.cols);

      await waitForGenerationSettled(page, terminalId, replacementGeneration, {
        cols: geometryC.cols,
        rows: geometryC.rows,
      });
      const beforeFinalPixels = await screenshotRegion(page, pane.xtermHost);
      await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
      await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText, { timeoutMs: WAIT_TIMEOUT_MS });
      await expectTerminalBuffer(page, terminalId, { contains: marker("PRINT", finalId, finalText), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
      const afterFinalPixels = await screenshotRegion(page, pane.xtermHost);
      await expectTerminalPixelsChanged(beforeFinalPixels, afterFinalPixels, {
        minimumChangedRatio: 0.002,
        testInfo,
        artifactName: "v-05-final-marker",
      });

      await pane.sendInput(`QUERY ${queryId}`, true);
      await server.waitForTranscript(terminalId, (entry) => entry.event === "query_complete" && entry.id === queryId && entry.replies === 4, { timeoutMs: WAIT_TIMEOUT_MS });
      await pane.sendInput(`SIZE ${sizeId}`, true);
      const sizeEntry = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number; pixel_width: number; pixel_height: number }>(
        terminalId,
        (entry) => entry.event === "size" && entry.id === sizeId,
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      expect(sizeEntry.rows).toBe(geometryC.rows);
      expect(sizeEntry.cols).toBe(geometryC.cols);

      await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
      await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
      await pane.sendInput(echoText, true);
      const echoPayload = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
        terminalId,
        (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      expect(echoPayload.payload_base64).toBe(echoBase64);
      await expectTerminalBuffer(page, terminalId, { contains: marker("ECHO_INPUT", echoId, echoBase64), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

      const final = await waitForGenerationSettled(page, terminalId, replacementGeneration, {
        cols: geometryC.cols,
        rows: geometryC.rows,
      });
      expect(final.socketState).toBe("connected");
      expect(final.activeSocketCount).toBe(1);
      expect(final.syncMode).toBeUndefined();
      expect(final.pendingParserWrites).toBe(0);
      expect(final.pendingParserBytes).toBe(0);
      expect(final.renderBacklogBytes).toBe(0);
      expect(final.renderBacklogFrames).toBe(0);
      expect(final.receivedSequence).toBe(final.committedSequence);
      expect(final.gridEpoch).toBeGreaterThan(baselineEpoch);
      expect(final.serverViewport?.cols).toBe(geometryC.cols);
      expect(final.serverViewport?.rows).toBe(geometryC.rows);
      expect(final.desiredViewport?.cols).toBe(geometryC.cols);
      expect(final.desiredViewport?.rows).toBe(geometryC.rows);
      expect(final.sentViewport?.cols).toBe(geometryC.cols);
      expect(final.sentViewport?.rows).toBe(geometryC.rows);
      expect(final.xterm.text).toContain(baselineMarker);
      expect(final.xterm.text).toContain(marker("PRINT", finalId, finalText));
      expect(occurrenceCount(final.xterm.text, baselineMarker)).toBe(1);
      expect(occurrenceCount(final.xterm.text, marker("PRINT", finalId, finalText))).toBe(1);

      const screenBox = await pane.xtermHost.locator(".xterm-screen").boundingBox();
      if (!screenBox) throw new Error("terminal compositor did not expose an xterm screen box");
      expect(Math.abs(screenBox.width - final.pixelWidth)).toBeLessThanOrEqual(1);
      expect(Math.abs(screenBox.height - final.pixelHeight)).toBeLessThanOrEqual(1);
      await expectTerminalNonBlank(page, pane.xtermHost, {
        testInfo,
        artifactName: "v-05-final-terminal",
      });

      const events = await terminalEvents(page, terminalId);
      await assertMonotonicSequences(events);
      const snapshotSyncEvents = events.filter((event) => (
        event.type === "sync"
        && event.snapshot.socketGeneration === replacementGeneration
        && event.data.mode === "snapshot"
      ));
      expect(snapshotSyncEvents).toHaveLength(1);
      expect(events.filter((event) => (
        event.type === "sync"
        && event.snapshot.socketGeneration === replacementGeneration
        && event.data.mode === "resume"
      ))).toEqual([]);
      const parserEvents = events.filter((event) => (
        event.type === "snapshot"
        && event.snapshot.socketGeneration === replacementGeneration
        && event.snapshot.syncMode === "snapshot"
      ));
      expect(parserEvents.length).toBeGreaterThan(0);
      const activeParserEvents = parserEvents.filter((event) => event.snapshot.pendingParserWrites > 0);
      expect(activeParserEvents.length).toBeGreaterThan(0);
      expect(activeParserEvents.some((event) => event.snapshot.pendingParserBytes > 0)).toBe(true);
      const parserStart = activeParserEvents[0];
      if (!parserStart) throw new Error("snapshot parser start diagnostics disappeared");
      const replacementSizes = events.filter((event) => (
        event.type === "size" && event.snapshot.socketGeneration === replacementGeneration
      ));
      expect(replacementSizes.length).toBeGreaterThan(0);
      for (const sizeEvent of replacementSizes) {
        const cols = sizeEvent.data.cols;
        const rows = sizeEvent.data.rows;
        expect(typeof cols).toBe("number");
        expect(typeof rows).toBe("number");
        expect(sizeEvent.snapshot.cols).toBe(cols);
        expect(sizeEvent.snapshot.rows).toBe(rows);
        if (typeof sizeEvent.data.epoch === "number") expect(sizeEvent.snapshot.gridEpoch).toBe(sizeEvent.data.epoch);
      }
      const cSizeEvent = replacementSizes.find((event) => event.data.cols === geometryC.cols && event.data.rows === geometryC.rows);
      expect(cSizeEvent).toBeDefined();
      const syncedEvent = events.find((event) => event.type === "synced" && event.snapshot.socketGeneration === replacementGeneration);
      expect(syncedEvent).toBeDefined();
      if (!cSizeEvent || !syncedEvent) throw new Error("ordered C-grid size or synced event disappeared");
      expect(cSizeEvent.id).toBeGreaterThan(parserStart.id);
      expect(syncedEvent.id).toBeGreaterThan(cSizeEvent.id);
      expect(final.gridEpoch).toBe(cSizeEvent.data.epoch);
      const parserCommits = events.filter((event) => event.type === "parser-commit" && event.snapshot.socketGeneration === replacementGeneration);
      for (let index = 1; index < parserCommits.length; index += 1) {
        const previous = parserCommits[index - 1]?.data.sequence;
        const current = parserCommits[index]?.data.sequence;
        if (typeof previous === "number" && typeof current === "number") expect(current).toBeGreaterThanOrEqual(previous);
      }

      const snapshotFrames = faultController.events.filter((event) => (
        event.type === "frame"
        && event.terminalId === terminalId
        && event.generation === replacementGeneration
        && event.direction === "server-to-browser"
        && event.frame?.binaryKind === 0
      ));
      expect(snapshotFrames.length).toBeGreaterThan(0);
      const snapshotSequences = new Set(snapshotFrames.map((event) => event.frame?.sequence));
      expect(snapshotSequences.size).toBe(1);

      const transcript = await server.readTranscript(terminalId);
      expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
      expect(transcript.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "print" && entry.id === baselineId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "print" && entry.id === finalId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "command" && entry.id === winchId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "query_complete" && entry.id === queryId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);

      await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
      await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
      const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
      expect(invariantReport.violations).toEqual([]);
      expect((await terminalEvents(page, terminalId)).filter((event) => event.type === "error")).toEqual([]);
      expect(browserErrorMessages(browserErrors)).toEqual([]);
    } finally {
      snapshotThrottle.dispose();
    }
  } finally {
    delayedReconnect.dispose();
    if (secondaryContext) await secondaryContext.close();
  }
});
