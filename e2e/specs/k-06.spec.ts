import type { Browser, BrowserContext, Page, TestInfo } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import {
  installBrowserErrorCollectors,
  type BrowserErrorLog,
} from "../fixtures/artifacts.js";
import type { IsolatedServer } from "../fixtures/isolated-server.js";
import type { NetworkFaultController, NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 45_000;
const BURST_BYTES = 120_000;
const BURST_LINE_WIDTH = 80;
const E2E_VIEWPORT = { width: 915, height: 421 } as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface BrowserErrorCollector {
  (): readonly BrowserErrorLog[];
  dispose(): void;
}

type DiagnosticEvent = E2ETerminalEvent<Record<string, unknown>>;

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
}

interface TerminalMount {
  readonly page: Page;
  readonly workbench: WorkbenchPage;
  readonly pane: TerminalPanePage;
  readonly terminalId: string;
  readonly terminalName: string;
}

interface Session extends TerminalMount {
  readonly context: BrowserContext;
  readonly errors: BrowserErrorCollector;
  readonly initial: E2ETerminalSnapshot;
  readonly generation: number;
}

interface RecoverySession extends TerminalMount {
  readonly context: BrowserContext;
  readonly errors: BrowserErrorCollector;
  readonly snapshot: E2ETerminalSnapshot;
  readonly sync: DiagnosticEvent;
}

interface CheckpointRecord {
  readonly event: DiagnosticEvent;
  readonly sequence: number;
  readonly epoch: number;
  readonly size: number;
  readonly chunks: number;
  readonly result: string;
  readonly firstOccurrence: number;
}

interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

interface Calibration {
  readonly baselineChunks: number;
  readonly secondChunks: number;
  readonly dimensions: TerminalDimensions;
}

function numericField(data: Record<string, unknown>, field: string): number {
  const value = data[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`checkpoint diagnostic field ${field} is not a safe non-negative integer`);
  }
  return value;
}

function checkpointRecord(event: DiagnosticEvent, firstOccurrence: number): CheckpointRecord {
  const result = event.data.result;
  if (typeof result !== "string") throw new Error("checkpoint diagnostic event has no result");
  return {
    event,
    sequence: numericField(event.data, "sequence"),
    epoch: numericField(event.data, "epoch"),
    size: numericField(event.data, "size"),
    chunks: numericField(event.data, "chunks"),
    result,
    firstOccurrence,
  };
}

// Binary checkpoint chunk frames carry kind byte 2 in their nine-byte header;
// the proxy decodes it as binaryKind and keeps a per-connection occurrence
// counter for that key, so chunk arithmetic works exactly as it did for the
// legacy JSON chunks. The `checkpointBinary` announcement is not a chunk and
// is deliberately excluded.
function checkpointFrames(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
): NetworkFaultEvent[] {
  return events.filter((event) => (
    event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "browser-to-server"
      && event.frame?.binaryKind === 2
  ));
}

function latestEventId(events: readonly DiagnosticEvent[]): number {
  return events.at(-1)?.id ?? 0;
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEventType,
  options: {
    readonly sequence?: number;
    readonly generation?: number;
  } = {},
): Promise<DiagnosticEvent> {
  return page.evaluate(async ({ id, after, eventType, sequence, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === eventType
        && (sequence === undefined || event.data.sequence === sequence)
        && (generation === undefined || event.data.generation === generation),
      { timeout, afterId: after },
    );
  }, {
    id: terminalId,
    after: afterEventId,
    eventType: type,
    sequence: options.sequence,
    generation: options.generation,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForRenderAfter(page: Page, terminalId: string, renderCount: number): Promise<void> {
  await page.evaluate(async ({ id, minimumRender, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > minimumRender
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, minimumRender: renderCount, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCheckpointFrames(
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
  firstOccurrence: number,
  chunks: number,
): Promise<void> {
  for (let offset = 0; offset < chunks; offset += 1) {
    const occurrence = firstOccurrence + offset;
    await faultController.waitFor(
      (event) => event.type === "frame"
        && event.terminalId === terminalId
        && event.generation === generation
        && event.direction === "browser-to-server"
        && event.frame?.binaryKind === 2
        && event.frame.occurrence === occurrence,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
  }
}

async function waitForTranscript(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return server.waitForTranscript(terminalId, predicate, { timeoutMs: WAIT_TIMEOUT_MS });
}

function browserErrors(errors: BrowserErrorCollector): readonly BrowserErrorLog[] {
  return errors().filter((entry) => (
    entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || (entry.kind === "console" && /^error:/i.test(entry.message))
  ));
}

async function createSession(
  context: BrowserContext,
  baseURL: string,
  faultController: NetworkFaultController,
): Promise<Session> {
  const page = await context.newPage();
  const errors = installBrowserErrorCollectors(page) as BrowserErrorCollector;
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
  const created = await createResponse.json() as TerminalApiInfo;
  expect(created.id).not.toBe("");
  expect(created.name).not.toBe("");
  if (created.pid === null) throw new Error(`terminal ${created.id} did not expose a running fixture PID`);

  const pane = new TerminalPanePage(page, created.id, created.name);
  await pane.expectVisible();
  const initial = await expectTerminalSynchronized(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalConverged(page, created.id, {
    cols: initial.cols,
    rows: initial.rows,
    pixelWidth: initial.pixelWidth,
    pixelHeight: initial.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.acceptingInput).toBe(true);

  const open = [...faultController.events].reverse().find((event) => (
    event.type === "connection-open"
      && event.terminalId === created.id
      && event.generation === initial.socketGeneration
  ));
  if (!open) {
    const awaited = await faultController.waitFor(
      (event) => event.type === "connection-open"
        && event.terminalId === created.id
        && event.generation === initial.socketGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    if (awaited.generation === undefined) throw new Error(`terminal ${created.id} proxy connection has no generation`);
  }

  return {
    context,
    page,
    errors,
    workbench,
    pane,
    terminalId: created.id,
    terminalName: created.name,
    initial,
    generation: initial.socketGeneration,
  };
}

async function openRecoverySession(
  context: BrowserContext,
  baseURL: string,
  terminalId: string,
  terminalName: string,
  dimensions: TerminalDimensions,
): Promise<RecoverySession> {
  const page = await context.newPage();
  const errors = installBrowserErrorCollectors(page) as BrowserErrorCollector;
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const pane = await workbench.openTerminal({ id: terminalId, name: terminalName });
  await pane.expectVisible();
  const snapshot = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const events = await terminalEvents(page, terminalId);
  const sync = [...events].reverse().find((event) => event.type === "sync");
  if (!sync) throw new Error(`recovery for ${terminalId} did not record a sync event`);
  expect(sync.data.mode).toBe("snapshot");
  await expectTerminalConverged(page, terminalId, dimensions, { timeout: WAIT_TIMEOUT_MS });
  expect(snapshot.activeSocketCount).toBe(1);
  expect(snapshot.acceptingInput).toBe(true);
  return {
    context,
    page,
    errors,
    workbench,
    pane,
    terminalId,
    terminalName,
    snapshot,
    sync,
  };
}

async function removeTerminal(session: TerminalMount): Promise<void> {
  const before = await terminalEvents(session.page, session.terminalId);
  const unmount = waitForDiagnosticEventAfter(
    session.page,
    session.terminalId,
    latestEventId(before),
    "unmount",
  );
  const removeResponse = session.page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "DELETE" && url.pathname === `/api/terminals/${session.terminalId}`;
  });
  await session.workbench.sidebar.removeTerminal({ id: session.terminalId, name: session.terminalName });
  const [response, unmounted] = await Promise.all([removeResponse, unmount]);
  expect(response.status()).toBe(204);
  expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
  expect(unmounted.snapshot.activeSocketCount).toBe(0);
  expect(unmounted.snapshot.socket.activeCount).toBe(0);
}

async function baselineCheckpoint(
  session: Session,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  markerId: string,
  markerText: string,
  barrierToken: string,
): Promise<CheckpointRecord> {
  const events = await terminalEvents(session.page, session.terminalId);
  const anchor = latestEventId(events);
  const beforeFrames = checkpointFrames(faultController.events, session.terminalId, session.generation).length;
  const checkpointPromise = waitForDiagnosticEventAfter(
    session.page,
    session.terminalId,
    anchor,
    "checkpoint",
  );
  await session.pane.sendInput(`PRINT ${markerId} ${markerText}`, true);
  await waitForTranscript(server, session.terminalId, (entry) => (
    entry.event === "print" && entry.id === markerId && entry.text === markerText
  ));
  await expectTerminalBuffer(session.page, session.terminalId, {
    contains: `[E2E:PRINT:${markerId}:${markerText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const checkpoint = checkpointRecord(await checkpointPromise, beforeFrames + 1);
  expect(checkpoint.result).toBe("sent");
  expect(checkpoint.size).toBeGreaterThan(0);
  expect(checkpoint.chunks).toBeGreaterThan(0);
  await waitForCheckpointFrames(
    faultController,
    session.terminalId,
    session.generation,
    checkpoint.firstOccurrence,
    checkpoint.chunks,
  );
  const frames = checkpointFrames(faultController.events, session.terminalId, session.generation);
  expect(frames.slice(-checkpoint.chunks).map((frame) => frame.frame?.occurrence)).toEqual(
    Array.from({ length: checkpoint.chunks }, (_, index) => checkpoint.firstOccurrence + index),
  );

  // This FIFO barrier follows the final baseline chunk and proves the server
  // has processed it before the second checkpoint is attempted.
  await session.pane.sendInput(`HOLD ${barrierToken}`, true);
  await waitForTranscript(server, session.terminalId, (entry) => entry.event === "hold" && entry.token === barrierToken);
  await session.pane.sendInput(`RELEASE ${barrierToken}`, true);
  await waitForTranscript(server, session.terminalId, (entry) => entry.event === "release" && entry.token === barrierToken);
  return checkpoint;
}

async function runCalibration(
  browser: Browser,
  baseURL: string,
  faultController: NetworkFaultController,
  server: IsolatedServer,
  runTag: string,
): Promise<Calibration> {
  const context = await browser.newContext({ baseURL, viewport: E2E_VIEWPORT });
  let session: Session | undefined;
  try {
    session = await createSession(context, baseURL, faultController);
    const baseline = await baselineCheckpoint(
      session,
      server,
      faultController,
      `${runTag}-B00-BASE`,
      `${runTag}-B00-BASELINE`,
      `${runTag}-BASE-BARRIER`,
    );
    const beforeFrames = checkpointFrames(faultController.events, session.terminalId, session.generation).length;
    const events = await terminalEvents(session.page, session.terminalId);
    const secondPromise = waitForDiagnosticEventAfter(
      session.page,
      session.terminalId,
      latestEventId(events),
      "checkpoint",
    );
    const burstId = `${runTag}-CAL-BURST`;
    await session.pane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    await waitForTranscript(server, session.terminalId, (entry) => (
      entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES
    ));
    await waitForTranscript(server, session.terminalId, (entry) => entry.event === "write" && entry.bytes === BURST_BYTES);
    const second = checkpointRecord(await secondPromise, beforeFrames + 1);
    expect(second.result).toBe("sent");
    expect(second.chunks).toBeGreaterThanOrEqual(2);
    await waitForCheckpointFrames(
      faultController,
      session.terminalId,
      session.generation,
      second.firstOccurrence,
      second.chunks,
    );
    expect(checkpointFrames(faultController.events, session.terminalId, session.generation)).toHaveLength(
      beforeFrames + second.chunks,
    );
    return {
      baselineChunks: baseline.chunks,
      secondChunks: second.chunks,
      dimensions: {
        cols: session.initial.cols,
        rows: session.initial.rows,
        pixelWidth: session.initial.pixelWidth,
        pixelHeight: session.initial.pixelHeight,
      },
    };
  } finally {
    if (session) {
      try {
        await removeTerminal(session);
      } finally {
        session.errors.dispose();
      }
    }
    await context.close();
  }
}

async function runBoundary(
  browser: Browser,
  baseURL: string,
  faultController: NetworkFaultController,
  server: IsolatedServer,
  testInfo: TestInfo,
  calibration: Calibration,
  boundary: number,
  runTag: string,
): Promise<void> {
  const caseTag = `B${String(boundary).padStart(2, "0")}`;
  const context = await browser.newContext({ baseURL, viewport: E2E_VIEWPORT });
  let session: Session | undefined;
  let recoveryContext: BrowserContext | undefined;
  let recovery: RecoverySession | undefined;
  try {
    session = await createSession(context, baseURL, faultController);
    const terminalId = session.terminalId;
    const terminalName = session.terminalName;
    const baselineId = `${runTag}-${caseTag}-BASE`;
    const baselineText = `${runTag}-${caseTag}-BASELINE`;
    const baseline = await baselineCheckpoint(
      session,
      server,
      faultController,
      baselineId,
      baselineText,
      `${runTag}-BASE-BARRIER`,
    );
    expect(baseline.chunks).toBe(calibration.baselineChunks);

    const beforeSecondFrames = checkpointFrames(faultController.events, terminalId, session.generation).length;
    expect(beforeSecondFrames).toBe(baseline.firstOccurrence + baseline.chunks - 1);
    const targetOccurrence = beforeSecondFrames + boundary;
    const fault = faultController.terminate({
      terminalId,
      generation: session.generation,
      direction: "browser-to-server",
      binaryKind: 2,
      occurrence: targetOccurrence,
    });
    const eventsBeforeBurst = await terminalEvents(session.page, terminalId);
    const secondPromise = waitForDiagnosticEventAfter(
      session.page,
      terminalId,
      latestEventId(eventsBeforeBurst),
      "checkpoint",
    );
    const socketClosePromise = waitForDiagnosticEventAfter(
      session.page,
      terminalId,
      latestEventId(eventsBeforeBurst),
      "socket-close",
      { generation: session.initial.socketGeneration },
    );
    const terminatedPromise = faultController.waitFor(
      (event) => event.type === "terminated"
        && event.ruleId === fault.id
        && event.terminalId === terminalId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const disconnectedPromise = faultController.waitFor(
      (event) => event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.generation === session?.generation,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );

    const burstId = `${runTag}-${caseTag}-BURST`;
    const holdToken = `${runTag}-${caseTag}-HOLD`;
    const heldId = `${runTag}-${caseTag}-HELD`;
    const heldText = `${runTag}-${caseTag}-CONTINUED-OUTPUT`;
    const secondAnchor = latestEventId(eventsBeforeBurst);
    await session.pane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    // Queue HOLD and PRINT behind BURST before the checkpoint timer runs. The
    // fixture records PRINT while waiting at the FIFO hold.
    await session.pane.sendInput(`HOLD ${holdToken}`, true);
    await session.pane.sendInput(`PRINT ${heldId} ${heldText}`, true);
    await Promise.all([
      waitForTranscript(server, terminalId, (entry) => (
        entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES
      )),
      waitForTranscript(server, terminalId, (entry) => entry.event === "write" && entry.bytes === BURST_BYTES),
      waitForTranscript(server, terminalId, (entry) => entry.event === "hold" && entry.token === holdToken),
      waitForTranscript(server, terminalId, (entry) => (
        entry.event === "command"
          && entry.operation === "PRINT"
          && entry.command_base64 === Buffer.from(`PRINT ${heldId} ${heldText}`, "utf8").toString("base64")
      )),
    ]);
    const second = checkpointRecord(await secondPromise, beforeSecondFrames + 1);
    expect(second.result).toBe("sent");
    expect(second.chunks).toBe(calibration.secondChunks);

    const [terminated, disconnected, socketClose] = await Promise.all([
      terminatedPromise,
      disconnectedPromise,
      socketClosePromise,
    ]);
    expect(terminated.ruleId).toBe(fault.id);
    expect(disconnected.abrupt).toBe(true);
    expect(socketClose.data.generation).toBe(session.initial.socketGeneration);

    const eventsBeforeClose = await terminalEvents(session.page, terminalId);
    await assertMonotonicSequences(eventsBeforeClose);
    expect(eventsBeforeClose.filter((event) => event.type === "error")).toHaveLength(0);
    const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
    const terminationIndex = networkEvents.findIndex((event) => event.type === "terminated" && event.ruleId === fault.id);
    if (terminationIndex < 0) throw new Error("checkpoint fault did not expose its termination boundary");
    const framesBeforeTermination = checkpointFrames(
      networkEvents.slice(0, terminationIndex),
      terminalId,
      session.generation,
    );
    expect(framesBeforeTermination.map((frame) => frame.frame?.occurrence)).toEqual(
      Array.from({ length: targetOccurrence }, (_, index) => index + 1),
    );
    expect(framesBeforeTermination).toHaveLength(targetOccurrence);
    expect(framesBeforeTermination.at(-1)?.frame?.occurrence).toBe(targetOccurrence);
    expect(targetOccurrence === beforeSecondFrames + calibration.secondChunks).toBe(
      boundary === calibration.secondChunks,
    );

    const checkpoints = eventsBeforeClose
      .filter((event) => event.type === "checkpoint")
      .map((event) => checkpointRecord(event, 0));
    const recordedBaseline = checkpoints.find((checkpoint) => checkpoint.sequence === baseline.sequence);
    const recordedSecond = checkpoints.find((checkpoint) => checkpoint.sequence === second.sequence);
    if (!recordedBaseline || !recordedSecond) throw new Error("checkpoint diagnostics lost an upload boundary");
    expect(recordedSecond.epoch).toBe(recordedBaseline.epoch);
    const lastCompleted = boundary === calibration.secondChunks ? recordedSecond : recordedBaseline;
    expect(lastCompleted.sequence).toBe(boundary === calibration.secondChunks ? second.sequence : baseline.sequence);
    expect(lastCompleted.epoch).toBe(baseline.epoch);
    expect(lastCompleted.chunks).toBe(
      boundary === calibration.secondChunks ? calibration.secondChunks : calibration.baselineChunks,
    );
    if (boundary < calibration.secondChunks) {
      expect(targetOccurrence).toBeLessThan(beforeSecondFrames + calibration.secondChunks);
      expect(lastCompleted.sequence).toBe(baseline.sequence);
    }

    // Close the old browser before its reconnect timer can create another
    // generation. The fresh browser below has no local sequence state.
    await session.page.context().setOffline(true);
    await session.page.close();
    session.errors.dispose();
    await context.close();
    session = undefined;

    recoveryContext = await browser.newContext({ baseURL, viewport: E2E_VIEWPORT });
    recovery = await openRecoverySession(
      recoveryContext,
      baseURL,
      terminalId,
      terminalName,
      calibration.dimensions,
    );
    const syncSequence = numericField(recovery.sync.data, "sequence");
    const syncEpoch = numericField(recovery.sync.data, "epoch");
    expect(syncSequence).toBeGreaterThanOrEqual(second.sequence);
    expect(syncEpoch).toBe(second.epoch);
    expect(recovery.snapshot.committedSequence).toBeGreaterThanOrEqual(second.sequence);
    expect(recovery.snapshot.receivedSequence).toBeGreaterThanOrEqual(second.sequence);
    expect(recovery.snapshot.gridEpoch).toBe(second.epoch);
    expect(recovery.snapshot.socketState).toBe("connected");
    expect(recovery.snapshot.activeSocketCount).toBe(1);

    const baselineMarker = `[E2E:PRINT:${baselineId}:${baselineText}]`;
    const heldMarker = `[E2E:PRINT:${heldId}:${heldText}]`;
    await expectTerminalBuffer(recovery.page, terminalId, { contains: baselineMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const beforeReleaseSnapshot = await recovery.pane.snapshot();
    if (!beforeReleaseSnapshot) throw new Error(`missing pre-release diagnostics for terminal ${terminalId}`);
    expect(beforeReleaseSnapshot.xterm.text).not.toContain(heldMarker);
    const beforeReleasePixels = await screenshotRegion(recovery.page, recovery.pane.xtermHost);
    await expectTerminalNonBlank(recovery.page, recovery.pane.xtermHost, {
      testInfo,
      artifactName: `k06-${caseTag}-before-release-terminal`,
    });

    await recovery.pane.sendInput(`RELEASE ${holdToken}`, true);
    await waitForTranscript(server, terminalId, (entry) => entry.event === "release" && entry.token === holdToken);
    await waitForTranscript(server, terminalId, (entry) => entry.event === "print" && entry.id === heldId && entry.text === heldText);
    await expectTerminalBuffer(recovery.page, terminalId, { contains: heldMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await waitForRenderAfter(recovery.page, terminalId, beforeReleaseSnapshot.renderCount);
    await expectKnownMarkerChanged(recovery.page, recovery.pane.xtermHost, beforeReleasePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: `k06-${caseTag}-continued-output-marker`,
    });
    await expectTerminalNonBlank(recovery.page, recovery.pane.xtermHost, {
      testInfo,
      artifactName: `k06-${caseTag}-continued-output-terminal`,
    });

    const echoId = `${runTag}-${caseTag}-ECHO`;
    const echoText = `${runTag}-${caseTag}-CONTINUED-INPUT`;
    const echoMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;
    await recovery.pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await waitForTranscript(server, terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed");
    await recovery.pane.sendInput(echoText, true);
    const echoed = await waitForTranscript(server, terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload");
    expect(echoed.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
    await expectTerminalBuffer(recovery.page, terminalId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const sizeId = `${runTag}-${caseTag}-SIZE`;
    await recovery.pane.sendInput(`SIZE ${sizeId}`, true);
    const size = await waitForTranscript(server, terminalId, (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl");
    const ptyRows = Number(size.rows);
    const ptyCols = Number(size.cols);
    expect(ptyRows).toBe(recovery.snapshot.rows);
    expect(ptyCols).toBe(recovery.snapshot.cols);
    await expectTerminalBuffer(recovery.page, terminalId, {
      contains: `[E2E:SIZE:${sizeId}:${ptyRows}:${ptyCols}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const final = await waitForTerminalState(recovery.page, terminalId, {
      socketState: "connected",
      activeSocketCount: 1,
      acceptingInput: true,
      pendingParserWrites: 0,
      pendingParserBytes: 0,
      renderBacklogBytes: 0,
      renderBacklogFrames: 0,
    }, { timeout: WAIT_TIMEOUT_MS });
    expect(final.gridEpoch).toBe(second.epoch);
    expect(final.serverViewport?.cols).toBe(final.cols);
    expect(final.serverViewport?.rows).toBe(final.rows);
    expect(final.xterm.text).toContain(baselineMarker);
    expect(final.xterm.text).toContain(heldMarker);
    expect(final.xterm.text).toContain(echoMarker);
    await expectTerminalNonBlank(recovery.page, recovery.pane.xtermHost, {
      testInfo,
      artifactName: `k06-${caseTag}-final-terminal`,
    });
    await expectNoPendingRecovery(recovery.page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(recovery.page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const invariantReport = await expectConnectedTerminalInvariants(recovery.page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
    await assertMonotonicSequences(invariantReport.events);
    expect(browserErrors(recovery.errors)).toEqual([]);
    expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);

    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
    expect(transcript.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === baselineId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === heldId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);

    await removeTerminal(recovery);
    recovery.errors.dispose();
    recovery = undefined;
  } finally {
    faultController.reset();
    if (recovery) {
      recovery.errors.dispose();
      await recovery.context.close();
    }
    if (session) {
      session.errors.dispose();
      await session.context.close();
    }
    if (recoveryContext) await recoveryContext.close();
  }
}

test("K-06 Disconnect during checkpoint upload @p1 @checkpoint @disconnect @chunks @nightly", async ({
  browser,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  test.setTimeout(360_000);
  const runTag = `K06-${testInfo.project.name}-w${testInfo.workerIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const calibration = await runCalibration(browser, baseURL, faultController, server, runTag);
  for (let boundary = 1; boundary <= calibration.secondChunks; boundary += 1) {
    await runBoundary(
      browser,
      baseURL,
      faultController,
      server,
      testInfo,
      calibration,
      boundary,
      runTag,
    );
  }
});
