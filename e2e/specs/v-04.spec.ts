import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  terminalEvents,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
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

const WAIT_TIMEOUT_MS = 30_000;
const INITIAL_BROWSER_VIEWPORT = { width: 1_200, height: 700 } as const;
const RESUME_BROWSER_VIEWPORT = { width: 860, height: 540 } as const;
const BURST_BYTES = 65_536;
const BURST_LINE_WIDTH = 73;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function commandBytes(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function compactModel(text: string): string {
  return text.replace(/\r?\n/g, "");
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

function frameForTerminal(event: NetworkFaultEvent, terminalId: string): boolean {
  return event.type === "frame"
    && event.terminalId === terminalId
    && event.frame !== undefined;
}

async function waitForDiagnosticEvent(
  page: Page,
  terminalId: string,
  type: E2ETerminalEventType,
  options: {
    readonly minimumGeneration?: number;
    readonly exactGeneration?: number;
    readonly syncMode?: "snapshot" | "resume";
  } = {},
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, type, minimumGeneration, exactGeneration, syncMode, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === type
      && (exactGeneration === undefined || event.snapshot.socketGeneration === exactGeneration)
      && (minimumGeneration === undefined || event.snapshot.socketGeneration >= minimumGeneration)
      && (syncMode === undefined || event.snapshot.syncMode === syncMode)
    ), { timeout });
  }, {
    id: terminalId,
    type,
    ...options,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForDesiredViewportChange(
  page: Page,
  terminalId: string,
  previous: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previous, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.desiredViewport;
      return viewport !== undefined
        && viewport.cols > 0
        && viewport.rows > 0
        && (viewport.cols !== previous.cols || viewport.rows !== previous.rows);
    }, { timeout });
  }, { id: terminalId, previous, timeout: WAIT_TIMEOUT_MS });
}

async function waitForFinalViewport(
  page: Page,
  terminalId: string,
  expected: E2EViewport,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const sameGeometry = (viewport: E2EViewport | undefined): boolean => viewport !== undefined
      && viewport.cols === expected.cols
      && viewport.rows === expected.rows
      && Math.abs(viewport.pixelWidth - expected.pixelWidth) <= 1
      && Math.abs(viewport.pixelHeight - expected.pixelHeight) <= 1;
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.cols === expected.cols
      && snapshot.rows === expected.rows
      && sameGeometry(snapshot.proposedViewport)
      && sameGeometry(snapshot.desiredViewport)
      && sameGeometry(snapshot.sentViewport)
      && snapshot.serverViewport?.cols === expected.cols
      && snapshot.serverViewport?.rows === expected.rows
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout });
  }, { id: terminalId, expected, timeout: WAIT_TIMEOUT_MS });
}

function assertOutputControlOrdering(
  events: readonly E2ETerminalEvent[],
  generation: number,
): void {
  const streamEvents = events.filter((event) => event.snapshot.socketGeneration === generation);
  let latestOutputId = -1;
  let latestCommitId = -1;
  let latestOutputSequence: number | undefined;
  let latestCommitSequence: number | undefined;
  for (const event of streamEvents) {
    if (event.type === "output-received") {
      latestOutputId = event.id;
      const sequence = Number(event.data.sequence);
      if (Number.isSafeInteger(sequence)) latestOutputSequence = sequence;
    }
    if (event.type === "parser-commit") {
      latestCommitId = event.id;
      const sequence = Number(event.data.sequence);
      if (Number.isSafeInteger(sequence)) latestCommitSequence = sequence;
    }
    if (event.type === "size" || event.type === "sync" || event.type === "synced") {
      if (latestOutputId >= 0) {
        expect(latestCommitId, `${event.type} must wait for earlier output parsing`).toBeGreaterThan(latestOutputId);
        if (latestOutputSequence !== undefined && latestCommitSequence !== undefined) {
          expect(latestCommitSequence, `${event.type} must not move behind committed output`).toBeGreaterThanOrEqual(latestOutputSequence);
        }
      }
    }
  }
}

test("V-04 Resize during resume stream @p1 @nightly @resize @recovery", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.setViewportSize(INITIAL_BROWSER_VIEWPORT);
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const paneRegion = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(paneRegion).toBeVisible();
  const terminalId = await paneRegion.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal did not expose a stable terminal ID");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await pane.waitForConnected({ timeout: WAIT_TIMEOUT_MS });
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  await waitForTerminalState(page, terminalId, {
    acceptingInput: true,
    pendingParserWrites: 0,
    renderBacklogBytes: 0,
  }, { timeout: WAIT_TIMEOUT_MS });

  const markerPrefix = `V04-W${testInfo.workerIndex}-R${testInfo.retry}-I${testInfo.repeatEachIndex}`;
  const readyId = `${markerPrefix}-READY`;
  const baselineId = `${markerPrefix}-BASELINE`;
  const baselineText = `${markerPrefix}-BASELINE-TEXT`;
  const burstId = `${markerPrefix}-BURST`;
  const holdToken = `${markerPrefix}-RESUME-HOLD`;
  const winchId = `${markerPrefix}-WINCH`;
  const printId = `${markerPrefix}-RESUME-PRINT`;
  const printText = `${markerPrefix}-RESUME-MARKER`;
  const queryId = `${markerPrefix}-QUERY`;
  const sizeId = `${markerPrefix}-SIZE`;
  const echoId = `${markerPrefix}-ECHO`;
  const echoText = `${markerPrefix}-CONTINUED-INPUT`;
  const echoBase64 = Buffer.from(echoText, "utf8").toString("base64");

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  await pane.sendInput(`PRINT ${baselineId} ${baselineText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === baselineId && entry.text === baselineText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await waitForTerminalState(page, terminalId, {
    acceptingInput: true,
    pendingParserWrites: 0,
    renderBacklogBytes: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("PRINT", baselineId, baselineText),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const baseline = await pane.snapshot();
  if (!baseline) throw new Error(`no baseline diagnostics snapshot for terminal ${terminalId}`);
  const baselineViewport = baseline.desiredViewport ?? baseline.proposedViewport ?? baseline.serverViewport;
  if (!baselineViewport || baselineViewport.cols <= 0 || baselineViewport.rows <= 0) {
    throw new Error("baseline terminal viewport is not measurable");
  }
  const baselineCommitted = baseline.committedSequence;
  const baselineEpoch = baseline.gridEpoch;
  if (baselineCommitted === undefined || baselineEpoch === undefined) {
    throw new Error("baseline resume sequence and epoch are unavailable");
  }
  const firstConnection = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
  );
  if (!firstConnection || firstConnection.generation === undefined) {
    throw new Error("initial terminal connection has no proxy generation");
  }
  const firstGeneration = firstConnection.generation;

  // Keep all resumed output behind a real proxy barrier. The B probe is done
  // before the hold so it can learn the exact xterm geometry without emitting
  // an input frame after the resume socket is established.
  await page.clock.install();
  const pauseOutputEvent = faultController.waitFor((event) => event.type === "paused"
    && event.terminalId === terminalId
    && event.generation === firstGeneration
    && event.direction === "server-to-browser", { timeoutMs: WAIT_TIMEOUT_MS });
  const pauseServerOutput = faultController.pause("server-to-browser", {
    terminalId,
    generation: firstGeneration,
    binaryKind: 1,
  });

  const probeBPromise = waitForDesiredViewportChange(page, terminalId, baselineViewport);
  await workbench.setViewport(RESUME_BROWSER_VIEWPORT.width, RESUME_BROWSER_VIEWPORT.height);
  await page.clock.fastForward(120);
  const probeB = await probeBPromise;
  const geometryB = probeB.desiredViewport;
  if (!geometryB || geometryB.cols <= 0 || geometryB.rows <= 0) {
    throw new Error("resume viewport B is not measurable");
  }
  expect(geometryB.cols === baselineViewport.cols && geometryB.rows === baselineViewport.rows).toBe(false);

  const restoreAPromise = page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.desiredViewport;
      return viewport !== undefined
        && viewport.cols === expected.cols
        && viewport.rows === expected.rows
        && snapshot.serverViewport?.cols === expected.cols
        && snapshot.serverViewport?.rows === expected.rows
        && snapshot.socketState === "connected";
    }, { timeout });
  }, { id: terminalId, expected: baselineViewport, timeout: WAIT_TIMEOUT_MS });
  await workbench.setViewport(INITIAL_BROWSER_VIEWPORT.width, INITIAL_BROWSER_VIEWPORT.height);
  await page.clock.fastForward(120);
  const restoredA = await restoreAPromise;
  const resumeEpoch = restoredA.gridEpoch;
  if (resumeEpoch === undefined) throw new Error("restored A viewport has no grid epoch");

  const holdPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "hold" && entry.token === holdToken,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`HOLD ${holdToken}`, true);
  await holdPromise;
  await pauseOutputEvent;

  const burstPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const winchPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sigwinch"
      && entry.source === "command"
      && entry.id === winchId
      && entry.signal_sequence === 1
      && entry.rows === geometryB.rows
      && entry.cols === geometryB.cols,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const printPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === printId && entry.text === printText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const queryCommandPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === "QUERY"
      && entry.command_base64 === commandBytes(`QUERY ${queryId}`),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const queryCompletePromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "query_complete" && entry.id === queryId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
  await pane.sendInput(`WINCH ${winchId} 1 ${geometryB.rows} ${geometryB.cols}`, true);
  await pane.sendInput(`PRINT ${printId} ${printText}`, true);
  await pane.sendInput(`QUERY ${queryId}`, true);
  await pane.sendInput(`RELEASE ${holdToken}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdToken, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  await Promise.all([burstPromise, winchPromise, printPromise, queryCommandPromise]);

  const firstTermination = faultController.waitFor((event) => event.type === "connection-terminated"
    && event.terminalId === terminalId
    && event.generation === firstGeneration, { timeoutMs: WAIT_TIMEOUT_MS });
  const firstSocketClose = waitForDiagnosticEvent(page, terminalId, "socket-close", {
    exactGeneration: firstGeneration,
  });
  const terminateFirst = faultController.terminate({ terminalId, generation: firstGeneration });
  terminateFirst.dispose();
  await Promise.all([firstTermination, firstSocketClose]);
  pauseServerOutput.dispose();

  // Arm the frame-specific pause before the reconnect timer runs. The first
  // resumed output frame is held, while ready/size/sync controls can reach the
  // browser and establish the resume barrier.
  const pauseResumeOutput = faultController.pause("server-to-browser", {
    terminalId,
    binaryKind: 1,
  });
  const secondConnection = faultController.waitFor((event) => event.type === "connection-open"
    && event.terminalId === terminalId
    && event.generation !== undefined
    && event.generation > firstGeneration, { timeoutMs: WAIT_TIMEOUT_MS });
  await page.clock.fastForward(500);
  const secondOpen = await secondConnection;
  if (secondOpen.generation === undefined) throw new Error("resume connection has no proxy generation");
  const secondGeneration = secondOpen.generation;

  const resumeSync = await waitForDiagnosticEvent(page, terminalId, "sync", {
    exactGeneration: secondGeneration,
    syncMode: "resume",
  });
  expect(resumeSync.snapshot.gridEpoch).toBe(resumeEpoch);
  expect(resumeSync.snapshot.syncMode).toBe("resume");
  expect(resumeSync.snapshot.committedSequence).toBe(baselineCommitted);
  expect(resumeSync.snapshot.receivedSequence).toBeGreaterThanOrEqual(baselineCommitted);
  const resumeUrl = resumeSync.snapshot.socketUrl;
  if (!resumeUrl) throw new Error("resume socket URL is missing from diagnostics");
  const resumeParams = new URL(resumeUrl).searchParams;
  expect(resumeParams.get("sequence")).toBe(String(baselineCommitted));
  expect(resumeParams.get("epoch")).toBe(String(resumeEpoch));

  const firstResumedOutput = await faultController.waitFor((event) => event.type === "paused"
    && event.terminalId === terminalId
    && event.generation === secondGeneration
    && event.direction === "server-to-browser", { timeoutMs: WAIT_TIMEOUT_MS });
  expect(firstResumedOutput.type).toBe("paused");
  const pausedSnapshot = await pane.snapshot();
  if (!pausedSnapshot) throw new Error("resume diagnostics snapshot disappeared while output was paused");
  expect(pausedSnapshot.socketGeneration).toBe(secondGeneration);
  expect(pausedSnapshot.syncMode).toBe("resume");
  expect(pausedSnapshot.acceptingInput).toBe(false);

  const priorResizeOccurrences = faultController.events
    .filter((event) => frameForTerminal(event, terminalId)
      && event.generation === secondGeneration
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "resize")
    .map((event) => event.frame?.occurrence ?? 0);
  const highestPriorResizeOccurrence = Math.max(0, ...priorResizeOccurrences);
  const finalResizePromise = faultController.waitFor((event) => frameForTerminal(event, terminalId)
    && event.generation === secondGeneration
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "resize"
    && (event.frame.occurrence ?? 0) > highestPriorResizeOccurrence, { timeoutMs: WAIT_TIMEOUT_MS });
  const desiredBPromise = waitForDesiredViewportChange(page, terminalId, baselineViewport);
  await workbench.setViewport(RESUME_BROWSER_VIEWPORT.width, RESUME_BROWSER_VIEWPORT.height);
  await page.clock.fastForward(120);
  const desiredB = await desiredBPromise;
  const finalGeometry = desiredB.desiredViewport;
  if (!finalGeometry) throw new Error("final resume viewport disappeared from diagnostics");
  expect(finalGeometry.cols).toBe(geometryB.cols);
  expect(finalGeometry.rows).toBe(geometryB.rows);
  expect(finalGeometry.pixelWidth).toBe(geometryB.pixelWidth);
  expect(finalGeometry.pixelHeight).toBe(geometryB.pixelHeight);
  const sentB = await page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.sentViewport;
      return viewport !== undefined
        && viewport.cols === expected.cols
        && viewport.rows === expected.rows
        && viewport.pixelWidth === expected.pixelWidth
        && viewport.pixelHeight === expected.pixelHeight;
    }, { timeout });
  }, { id: terminalId, expected: geometryB, timeout: WAIT_TIMEOUT_MS });
  expect(sentB.sentViewport).toEqual({ ...geometryB, source: "sent" });
  const resizeBFrame = await finalResizePromise;
  expect(resizeBFrame.frame?.jsonType).toBe("resize");
  expect(resizeBFrame.generation).toBe(secondGeneration);
  const beforeResumeOutput = await screenshotRegion(page, pane.xtermHost);

  // Releasing the proxy now delivers the held output, then the size control
  // caused by B. TerminalPane waits for each output parser commit before it
  // applies that control, which is the ordering this scenario exercises.
  pauseResumeOutput.dispose();
  const finalSynced = await waitForDiagnosticEvent(page, terminalId, "synced", {
    exactGeneration: secondGeneration,
  });
  expect(finalSynced.snapshot.socketState).toBe("connected");
  expect(finalSynced.snapshot.acceptingInput).toBe(true);
  await queryCompletePromise;
  const finalSnapshot = await waitForFinalViewport(page, terminalId, geometryB);
  const afterResumeOutput = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeResumeOutput, afterResumeOutput, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "v-04-resume-reflow",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "v-04-resume-terminal",
  });

  const sizePromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size"
      && entry.id === sizeId
      && entry.source === "ioctl"
      && entry.rows === geometryB.rows
      && entry.cols === geometryB.cols,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await sizePromise;
  expect(size.rows).toBe(geometryB.rows);
  expect(size.cols).toBe(geometryB.cols);
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(echoText, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === echoBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", echoId, echoBase64),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const finalSnapshotAfterInput = await pane.snapshot();
  if (!finalSnapshotAfterInput) throw new Error(`no final diagnostics snapshot for terminal ${terminalId}`);

  const finalModel = compactModel(finalSnapshotAfterInput.xterm.text);
  const resumeMarker = marker("PRINT", printId, printText);
  expect(finalModel).toContain(resumeMarker);
  expect(occurrences(finalModel, resumeMarker)).toBe(1);
  expect(finalModel).toContain(marker("ECHO_INPUT", echoId, echoBase64));
  expect(occurrences(finalModel, marker("ECHO_INPUT", echoId, echoBase64))).toBe(1);
  expect(finalSnapshot.socketGeneration).toBe(secondGeneration);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.syncMode).toBeUndefined();
  expect(finalSnapshot.syncTarget).toBeUndefined();
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.cols).toBe(geometryB.cols);
  expect(finalSnapshot.rows).toBe(geometryB.rows);
  expect(finalSnapshot.proposedViewport?.cols).toBe(geometryB.cols);
  expect(finalSnapshot.proposedViewport?.rows).toBe(geometryB.rows);
  expect(Math.abs((finalSnapshot.proposedViewport?.pixelWidth ?? 0) - geometryB.pixelWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs((finalSnapshot.proposedViewport?.pixelHeight ?? 0) - geometryB.pixelHeight)).toBeLessThanOrEqual(1);
  expect(finalSnapshot.desiredViewport).toEqual({ ...geometryB, source: "desired" });
  expect(finalSnapshot.sentViewport).toEqual({ ...geometryB, source: "sent" });
  expect(finalSnapshot.serverViewport?.cols).toBe(geometryB.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(geometryB.rows);
  expect(finalSnapshot.gridEpoch).toEqual(expect.any(Number));
  expect(finalSnapshot.gridEpoch).toBeGreaterThan(resumeEpoch);
  expect(finalSnapshot.xterm.text).toContain(baselineText);

  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  assertOutputControlOrdering(events, secondGeneration);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(2);
  expect(events.filter((event) => event.type === "socket-close").length).toBeGreaterThanOrEqual(1);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  const secondEvents = events.filter((event) => event.snapshot.socketGeneration === secondGeneration);
  const finalSizeEvent = secondEvents.filter((event) => event.type === "size").at(-1);
  expect(finalSizeEvent?.data.cols).toBe(geometryB.cols);
  expect(finalSizeEvent?.data.rows).toBe(geometryB.rows);
  expect(finalSizeEvent?.data.epoch).toEqual(expect.any(Number));
  expect(Number(finalSizeEvent?.data.epoch)).toBeGreaterThan(resumeEpoch);

  const secondFrames = faultController.events.filter((event) => frameForTerminal(event, terminalId)
    && event.generation === secondGeneration);
  const syncFrameIndex = secondFrames.findIndex((event) => event.direction === "server-to-browser" && event.frame?.jsonType === "sync");
  const firstOutputFrameIndex = secondFrames.findIndex((event) => event.direction === "server-to-browser" && event.frame?.binaryKind === 1);
  const syncedFrameIndex = secondFrames.findIndex((event) => event.direction === "server-to-browser" && event.frame?.jsonType === "synced");
  expect(syncFrameIndex).toBeGreaterThanOrEqual(0);
  expect(firstOutputFrameIndex).toBeGreaterThan(syncFrameIndex);
  expect(syncedFrameIndex).toBeGreaterThan(firstOutputFrameIndex);

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "command" && entry.id === winchId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === printId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "query_complete" && entry.id === queryId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  const submittedCommands = transcript
    .filter((entry) => entry.event === "command")
    .map((entry) => entry.command_base64);
  expect(submittedCommands).toContain(commandBytes(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`));
  expect(submittedCommands).toContain(commandBytes(`WINCH ${winchId} 1 ${geometryB.rows} ${geometryB.cols}`));
  expect(submittedCommands).toContain(commandBytes(`PRINT ${printId} ${printText}`));
  expect(submittedCommands).toContain(commandBytes(`QUERY ${queryId}`));
  expect(browserErrors).toEqual([]);

  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
});
