import { Buffer } from "node:buffer";
import { Terminal as HeadlessTerminal } from "../fixtures/headless-terminal.js"
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalInteractive,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants, expectTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";

const EVENT_TIMEOUT_MS = 30_000;
const ROWS = 4;
const COLS_A = 10;
const COLS_B = 20;
const BROWSER_VIEWPORT_A = { width: 96, height: 205 } as const;
const BROWSER_VIEWPORT_B = { width: 176, height: 205 } as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type NumericEvent = E2ETerminalEvent<Record<string, unknown>>;
type ModelSnapshot = Pick<E2ETerminalSnapshot["xterm"], "activeBuffer" | "cursorX" | "cursorY" | "viewportY" | "text">;

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]\n`;
}

function compact(text: string): string {
  return text.replaceAll("\n", "");
}

function numberField(event: NumericEvent, field: string): number | undefined {
  const value = event.data[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function eventId(events: readonly NumericEvent[]): number {
  return events.reduce((latest, event) => Math.max(latest, event.id), -1);
}

interface SnapshotExpectation {
  readonly cols?: number;
  readonly rows?: number;
  readonly desired?: { readonly cols: number; readonly rows: number };
  readonly server?: { readonly cols: number; readonly rows: number };
  readonly socketState?: E2ETerminalSnapshot["socketState"];
  readonly activeSocketCount?: number;
  readonly activeBuffer?: E2ETerminalSnapshot["xterm"]["activeBuffer"];
  readonly settled?: boolean;
}

async function waitForSnapshot(
  page: Page,
  terminalId: string,
  expected: SnapshotExpectation,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected: wanted, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      if (wanted.cols !== undefined && snapshot.cols !== wanted.cols) return false;
      if (wanted.rows !== undefined && snapshot.rows !== wanted.rows) return false;
      if (wanted.socketState !== undefined && snapshot.socketState !== wanted.socketState) return false;
      if (wanted.activeSocketCount !== undefined && snapshot.activeSocketCount !== wanted.activeSocketCount) return false;
      if (wanted.activeBuffer !== undefined && snapshot.xterm.activeBuffer !== wanted.activeBuffer) return false;
      if (wanted.desired !== undefined) {
        const desired = snapshot.desiredViewport;
        if (!desired || desired.cols !== wanted.desired.cols || desired.rows !== wanted.desired.rows) return false;
      }
      if (wanted.server !== undefined) {
        const server = snapshot.serverViewport;
        if (!server || server.cols !== wanted.server.cols || server.rows !== wanted.server.rows) return false;
      }
      if (wanted.settled === true && (
        snapshot.pendingParserWrites !== 0
        || snapshot.pendingParserBytes !== 0
        || snapshot.renderBacklogBytes !== 0
        || snapshot.renderBacklogFrames !== 0
        || snapshot.syncMode !== undefined
        || snapshot.syncTarget !== undefined
      )) return false;
      return true;
    }, { timeout });
  }, { id: terminalId, expected, timeout: EVENT_TIMEOUT_MS });
}

async function waitForEvent(
  page: Page,
  terminalId: string,
  afterId: number,
  type: E2ETerminalEvent["type"],
  fields: Record<string, unknown> = {},
): Promise<NumericEvent> {
  return page.evaluate(async ({ id, after, type: expectedType, fields: expectedFields, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.id <= after || event.type !== expectedType) return false;
      return Object.entries(expectedFields).every(([key, value]) => event.data[key] === value);
    }, { timeout });
  }, { id: terminalId, after: afterId, type, fields, timeout: EVENT_TIMEOUT_MS }).then((event) => event as NumericEvent);
}

async function waitForCompactMarker(page: Page, terminalId: string, expected: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, markerText, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.xterm.text.replaceAll("\n", "").includes(markerText), { timeout });
  }, { id: terminalId, markerText: expected, timeout: EVENT_TIMEOUT_MS });
}

async function waitForStableMarker(page: Page, terminalId: string, expected: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, markerText, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.xterm.text.replaceAll("\n", "").includes(markerText)
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.syncMode === undefined
      && snapshot.syncTarget === undefined
    ), { timeout });
  }, { id: terminalId, markerText: expected, timeout: EVENT_TIMEOUT_MS });
}

async function writeBytes(model: HeadlessTerminal, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve) => model.write(bytes, resolve));
}

function modelSnapshot(model: HeadlessTerminal): ModelSnapshot {
  const active = model.buffer.active;
  let text = "";
  const length = Math.min(active.length, 20_000);
  for (let index = 0; index < length && text.length < 256_000; index += 1) {
    const line = active.getLine(index);
    if (!line) continue;
    text += line.translateToString(true);
    if (index + 1 < length) text += "\n";
  }
  return {
    activeBuffer: active.type,
    cursorX: active.cursorX,
    cursorY: active.cursorY,
    viewportY: active.viewportY,
    text,
  };
}

function expectModelEqual(snapshot: E2ETerminalSnapshot, model: HeadlessTerminal): void {
  const expected = modelSnapshot(model);
  expect(snapshot.xterm.activeBuffer).toBe(expected.activeBuffer);
  expect(snapshot.xterm.cursorX).toBe(expected.cursorX);
  expect(snapshot.xterm.cursorY).toBe(expected.cursorY);
  expect(snapshot.xterm.viewportY).toBe(expected.viewportY);
  expect(snapshot.xterm.text).toBe(expected.text);
}

async function replayWritesThrough(
  server: IsolatedServer,
  terminalId: string,
  model: HeadlessTerminal,
  lastWriteSequence: number,
  throughSequence?: number,
): Promise<number> {
  const entries = await server.readTranscript(terminalId);
  const writes = entries
    .filter((entry) => entry.event === "write" && typeof entry.write_sequence === "number" && typeof entry.data_base64 === "string")
    .sort((left, right) => Number(left.write_sequence) - Number(right.write_sequence));
  let latest = lastWriteSequence;
  for (const entry of writes) {
    const sequence = Number(entry.write_sequence);
    if (!Number.isSafeInteger(sequence) || sequence <= latest) continue;
    if (throughSequence !== undefined && sequence > throughSequence) break;
    const encoded = String(entry.data_base64);
    await writeBytes(model, Buffer.from(encoded, "base64"));
    latest = sequence;
  }
  return latest;
}

function commandBase64(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function writeBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function outputFramesAfter(events: readonly NetworkFaultEvent[], terminalId: string, generation: number): readonly NetworkFaultEvent[] {
  return events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "server-to-browser"
    && event.frame?.binaryKind === 1
  ));
}

function assertOutputSequences(events: readonly NumericEvent[], afterId: number): void {
  const outputs = events
    .filter((event) => event.id > afterId && event.type === "output-received")
    .map((event) => ({ sequence: numberField(event, "sequence"), bytes: numberField(event, "bytes") }))
    .filter((event): event is { sequence: number; bytes: number } => event.sequence !== undefined && event.bytes !== undefined);
  expect(outputs.length).toBeGreaterThan(0);
  for (let index = 1; index < outputs.length; index += 1) {
    const previous = outputs[index - 1]!;
    const current = outputs[index]!;
    expect(current.sequence).toBe(previous.sequence + previous.bytes);
  }
}

async function waitForTranscriptWrite(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: TranscriptEntry) => boolean,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(terminalId, predicate, { timeoutMs: EVENT_TIMEOUT_MS });
}

test("@nightly @O-04 @ordering @resize O-04 Output immediately before resize", async ({ page, server, faultController }, testInfo) => {
  await page.setViewportSize({ width: 1_024, height: 768 });
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  await page.setViewportSize(BROWSER_VIEWPORT_A);
  const mountPromise = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, EVENT_TIMEOUT_MS);
  await workbench.createTerminal();
  const mounted = await mountPromise;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  const browserErrors = installBrowserErrorCollectors(page);
  await pane.waitForEvent("font-load", { timeout: EVENT_TIMEOUT_MS });

  const initial = await waitForSnapshot(page, terminalId, {
    cols: COLS_A,
    rows: ROWS,
    socketState: "connected",
    server: { cols: COLS_A, rows: ROWS },
    activeBuffer: "normal",
    settled: true,
  });
  expect(initial.cols).toBe(COLS_A);
  expect(initial.rows).toBe(ROWS);
  expect(initial.serverViewport).toMatchObject({ cols: COLS_A, rows: ROWS });
  expect(initial.gridEpoch).toEqual(expect.any(Number));

  const runId = `w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.repeatEachIndex}`;
  const readyId = `O04-${runId}-READY`;
  const holdId = `O04-${runId}-HOLD`;
  const preId = `O04-${runId}-PRE`;
  const sizeId = `O04-${runId}-SIZE-B`;
  const postId = `O04-${runId}-POST`;
  const echoId = `O04-${runId}-ECHO`;
  const inputPayload = `O04-${runId}-CONTINUED-INPUT`;
  const readyMarker = marker("READY", readyId);
  const preMarker = marker("PRINT", preId, "PRE-OLD-0123456789ABC");
  const postMarker = marker("PRINT", postId, "POST-NEW-GRID");
  const echoReadyMarker = marker("ECHO_INPUT", echoId, "READY");
  const echoMarker = marker("ECHO_INPUT", echoId, writeBase64(inputPayload));
  const sizeMarker = marker("SIZE", sizeId, String(ROWS), String(COLS_B));

  await pane.sendInput(`READY ${readyId}`, true);
  await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "ready" && entry.id === readyId);
  await waitForCompactMarker(page, terminalId, compact(readyMarker));

  const model = new HeadlessTerminal({ cols: COLS_A, rows: ROWS, ...tuiCompatibilityOptions() });
  let modelWriteSequence = 0;
  modelWriteSequence = await replayWritesThrough(server, terminalId, model, modelWriteSequence);
  const baselineEvents = await terminalEvents(page, terminalId) as readonly NumericEvent[];
  const baselineEventId = eventId(baselineEvents);
  const generation = initial.socketGeneration;
  const baselineResizeOccurrence = faultController.events
    .filter((event) => event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "resize")
    .reduce((latest, event) => Math.max(latest, event.frame?.occurrence ?? 0), 0);

  await pane.sendInput(`HOLD ${holdId}`, true);
  await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "hold" && entry.token === holdId);
  await pane.sendInput(`PRINT ${preId} PRE-OLD-0123456789ABC`, true);
  await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "command" && entry.operation === "PRINT" && entry.command_base64 === commandBase64(`PRINT ${preId} PRE-OLD-0123456789ABC`));

  const pauseOutput = faultController.pause("server-to-browser", {
    terminalId,
    generation,
    binaryKind: 1,
  });
  try {
    const pauseActivated = faultController.waitFor((event) => event.type === "paused" && event.ruleId === pauseOutput.id, { timeoutMs: EVENT_TIMEOUT_MS });
    const preWritePromise = waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "write" && entry.data_base64 === writeBase64(preMarker));
    await pane.sendInput(`RELEASE ${holdId}`, true);
    await Promise.all([
      pauseActivated,
      preWritePromise,
      waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "release" && entry.token === holdId),
    ]);
    const preWrite = await preWritePromise;
    const preWriteSequence = Number(preWrite.write_sequence);
    expect(Number.isSafeInteger(preWriteSequence)).toBe(true);

    const outputReceivedPromise = waitForEvent(page, terminalId, baselineEventId, "output-received");
    const parserCommitPromise = waitForEvent(page, terminalId, baselineEventId, "parser-commit");
    const sizeEventPromise = waitForEvent(page, terminalId, baselineEventId, "size", { cols: COLS_B, rows: ROWS });
    const resizeFramePromise = faultController.waitFor((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "resize"
      && (event.frame.occurrence ?? 0) > baselineResizeOccurrence
    ), { timeoutMs: EVENT_TIMEOUT_MS });

    await page.setViewportSize(BROWSER_VIEWPORT_B);
    const desiredB = await waitForSnapshot(page, terminalId, {
      desired: { cols: COLS_B, rows: ROWS },
      socketState: "connected",
    });
    const resizeFrame = await resizeFramePromise;
    expect(resizeFrame.frame?.jsonType).toBe("resize");
    expect(desiredB.desiredViewport).toMatchObject({ cols: COLS_B, rows: ROWS });

    const winchPromise = server.waitForTranscript(terminalId, (entry) => (
      entry.event === "sigwinch" && entry.rows === ROWS && entry.cols === COLS_B
    ), { timeoutMs: EVENT_TIMEOUT_MS });
    const resumeEventFloor = faultController.events.length;
    const winch = await winchPromise;
    expect(winch.rows).toBe(ROWS);
    expect(winch.cols).toBe(COLS_B);
    const winchWrite = await waitForTranscriptWrite(server, terminalId, (entry) => {
      if (entry.event !== "write" || typeof entry.data_base64 !== "string") return false;
      const bytes = Buffer.from(String(entry.data_base64), "base64").toString("utf8");
      return bytes.startsWith("[E2E:WINCH:") && bytes.endsWith(`:${ROWS}:${COLS_B}]\n`);
    });
    const winchWriteSequence = Number(winchWrite.write_sequence);
    expect(Number.isSafeInteger(winchWriteSequence)).toBe(true);

    faultController.resume("server-to-browser", { terminalId, generation, binaryKind: 1 });
    pauseOutput.dispose();
    const [outputReceived, parserCommit, sizeEvent] = await Promise.all([
      outputReceivedPromise,
      parserCommitPromise,
      sizeEventPromise,
    ]);
    expect(outputReceived.type).toBe("output-received");
    expect(parserCommit.type).toBe("parser-commit");
    expect(outputReceived.snapshot.cols).toBe(COLS_A);
    expect(outputReceived.snapshot.rows).toBe(ROWS);
    expect(parserCommit.snapshot.cols).toBe(COLS_A);
    expect(parserCommit.snapshot.rows).toBe(ROWS);
    expect(outputReceived.snapshot.gridEpoch).toBe(parserCommit.snapshot.gridEpoch);
    expect(parserCommit.snapshot.gridEpoch).toBe(initial.gridEpoch);
    expect(sizeEvent.snapshot.gridEpoch).toBeGreaterThan(parserCommit.snapshot.gridEpoch ?? -1);
    expect(sizeEvent.snapshot.gridEpoch).toBeGreaterThan(initial.gridEpoch ?? -1);
    expect(sizeEvent.snapshot.cols).toBe(COLS_B);
    expect(sizeEvent.snapshot.rows).toBe(ROWS);
    expect(sizeEvent.snapshot.serverViewport).toMatchObject({ cols: COLS_B, rows: ROWS });
    expect(sizeEvent.snapshot.pendingParserWrites).toBe(0);
    expect(sizeEvent.snapshot.pendingParserBytes).toBe(0);

    modelWriteSequence = await replayWritesThrough(server, terminalId, model, modelWriteSequence, preWriteSequence);
    expect(modelWriteSequence).toBe(preWriteSequence);
    expect(numberField(outputReceived, "bytes")).toBe(Buffer.byteLength(preMarker));
    expect(numberField(outputReceived, "sequence")).toBeDefined();
    expect(numberField(parserCommit, "sequence")).toBe(numberField(outputReceived, "sequence")! + Buffer.byteLength(preMarker));
    expect(compact(parserCommit.snapshot.xterm.text)).toContain(compact(preMarker));
    expectModelEqual(parserCommit.snapshot, model);

    model.resize(COLS_B, ROWS);
    expectModelEqual(sizeEvent.snapshot, model);
    expect(compact(sizeEvent.snapshot.xterm.text)).toContain(compact(preMarker));
    modelWriteSequence = await replayWritesThrough(
      server,
      terminalId,
      model,
      modelWriteSequence,
      winchWriteSequence,
    );

    const postReady = await waitForCompactMarker(page, terminalId, compact(preMarker));
    expect(postReady.cols).toBe(COLS_B);
    const prePixels = await screenshotRegion(page, pane.xtermHost);
    await expectTerminalNonBlank(page, pane.xtermHost, { testInfo, artifactName: "o-04-pre-resize-crop" });
    const sizeCommand = `SIZE ${sizeId}`;
    await pane.sendInput(sizeCommand, true);
    const sizeEntry = await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "size" && entry.id === sizeId);
    expect(sizeEntry.rows).toBe(ROWS);
    expect(sizeEntry.cols).toBe(COLS_B);
    await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "write" && entry.data_base64 === writeBase64(sizeMarker));
    await waitForCompactMarker(page, terminalId, compact(sizeMarker));
    modelWriteSequence = await replayWritesThrough(server, terminalId, model, modelWriteSequence);

    const postCommand = `PRINT ${postId} POST-NEW-GRID`;
    await pane.sendInput(postCommand, true);
    await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "print" && entry.id === postId);
    const postWrite = await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "write" && entry.data_base64 === writeBase64(postMarker));
    const postWriteSequence = Number(postWrite.write_sequence);
    expect(Number.isSafeInteger(postWriteSequence)).toBe(true);
    await waitForStableMarker(page, terminalId, compact(postMarker));
    modelWriteSequence = await replayWritesThrough(server, terminalId, model, modelWriteSequence, postWriteSequence);

    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed");
    const echoReadyWrite = await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "write" && entry.data_base64 === writeBase64(echoReadyMarker));
    const echoReadyWriteSequence = Number(echoReadyWrite.write_sequence);
    expect(Number.isSafeInteger(echoReadyWriteSequence)).toBe(true);
    await waitForCompactMarker(page, terminalId, compact(echoReadyMarker));
    modelWriteSequence = await replayWritesThrough(server, terminalId, model, modelWriteSequence, echoReadyWriteSequence);

    await pane.sendInput(inputPayload, true);
    const echoPayloadEntry = await waitForTranscriptWrite(server, terminalId, (entry) => (
      entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(inputPayload, "utf8").toString("base64")
    ));
    expect(echoPayloadEntry.payload_base64).toBe(Buffer.from(inputPayload, "utf8").toString("base64"));
    const echoWrite = await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "write" && entry.data_base64 === writeBase64(echoMarker));
    const echoWriteSequence = Number(echoWrite.write_sequence);
    expect(Number.isSafeInteger(echoWriteSequence)).toBe(true);
    const final = await waitForStableMarker(page, terminalId, compact(echoMarker));
    modelWriteSequence = await replayWritesThrough(server, terminalId, model, modelWriteSequence, echoWriteSequence);
    expect(modelWriteSequence).toBe(echoWriteSequence);
    expectModelEqual(final, model);
    expect(compact(final.xterm.text)).toContain(compact(preMarker));
    expect(compact(final.xterm.text)).toContain(compact(postMarker));
    expect(compact(final.xterm.text)).toContain(compact(sizeMarker));
    expect(compact(final.xterm.text)).toContain(compact(echoMarker));

    const finalPixels = await expectKnownMarkerChanged(page, pane.xtermHost, prePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-04-post-resize-marker-crop",
    });
    expect(finalPixels.after.width).toBe(prePixels.width);
    expect(finalPixels.after.height).toBe(prePixels.height);
    await expectTerminalNonBlank(page, pane.xtermHost, { testInfo, artifactName: "o-04-final-crop" });

    const ptySizeEntries = (await server.readTranscript(terminalId)).filter((entry) => entry.event === "size" && entry.id === sizeId);
    const ptyWinchEntries = (await server.readTranscript(terminalId)).filter((entry) => entry.event === "sigwinch" && entry.rows === ROWS && entry.cols === COLS_B);
    expect(ptySizeEntries).toHaveLength(1);
    expect(ptyWinchEntries).toHaveLength(1);
    expect(ptySizeEntries[0]?.rows).toBe(ROWS);
    expect(ptySizeEntries[0]?.cols).toBe(COLS_B);
    expect(ptyWinchEntries[0]?.rows).toBe(ROWS);
    expect(ptyWinchEntries[0]?.cols).toBe(COLS_B);

    const allEvents = await terminalEvents(page, terminalId) as readonly NumericEvent[];
    const outputEventIndex = allEvents.findIndex((event) => event.id === outputReceived.id);
    const parserCommitIndex = allEvents.findIndex((event) => event.id === parserCommit.id);
    const sizeEventIndex = allEvents.findIndex((event) => event.id === sizeEvent.id);
    expect(outputEventIndex).toBeGreaterThanOrEqual(0);
    expect(parserCommitIndex).toBeGreaterThan(outputEventIndex);
    expect(sizeEventIndex).toBeGreaterThan(parserCommitIndex);
    expect(allEvents.slice(outputEventIndex + 1, sizeEventIndex).filter((event) => event.type === "size")).toHaveLength(0);
    expect(allEvents.filter((event) => event.type === "size" && event.data.cols === COLS_B && event.data.rows === ROWS)).toHaveLength(1);
    expect(allEvents.filter((event) => event.type === "viewport" && event.data.source === "sent" && event.data.cols === COLS_B && event.data.rows === ROWS)).toHaveLength(1);

    const outputEvents = allEvents.filter((event) => event.type === "output-received" && event.id > baselineEventId);
    expect(outputEvents.length).toBeGreaterThanOrEqual(2);
    assertOutputSequences(allEvents, baselineEventId);
    const receivedSequence = final.receivedSequence;
    const committedSequence = final.committedSequence;
    expect(receivedSequence).toBeDefined();
    expect(committedSequence).toBe(receivedSequence);
    expect(final.cols).toBe(COLS_B);
    expect(final.rows).toBe(ROWS);
    expect(final.serverViewport?.cols).toBe(COLS_B);
    expect(final.serverViewport?.rows).toBe(ROWS);
    expect(final.pendingParserWrites).toBe(0);
    expect(final.pendingParserBytes).toBe(0);
    expect(final.renderBacklogBytes).toBe(0);
    expect(final.renderBacklogFrames).toBe(0);
    expect(final.syncMode).toBeUndefined();
    expect(final.syncTarget).toBeUndefined();

    const networkOutput = outputFramesAfter(faultController.events, terminalId, generation);
    expect(networkOutput.length).toBeGreaterThanOrEqual(outputEvents.length);
    for (let index = 1; index < networkOutput.length; index += 1) {
      const previous = networkOutput[index - 1]!;
      const current = networkOutput[index]!;
      expect(current.frame?.sequence).toBeGreaterThanOrEqual(previous.frame?.sequence ?? 0);
    }
    expect(faultController.events.some((event) => event.type === "paused" && event.ruleId === pauseOutput.id)).toBe(true);
    const eventsAfterResume = faultController.events.slice(resumeEventFloor);
    expect(eventsAfterResume.some((event) => event.type === "resumed" && event.direction === "server-to-browser")).toBe(true);

    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "command" && entry.operation === "PRINT" && entry.command_base64 === commandBase64(postCommand))).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "command" && entry.operation === "PRINT" && entry.command_base64 === commandBase64(`PRINT ${preId} PRE-OLD-0123456789ABC`))).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "write" && entry.data_base64 === writeBase64(preMarker))).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "write" && entry.data_base64 === writeBase64(postMarker))).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);

    await expectTerminalInteractive(page, terminalId, { timeout: EVENT_TIMEOUT_MS });
    await expectSingleTerminalSocket(page, terminalId, { timeout: EVENT_TIMEOUT_MS });

    await pane.sendInput("EXIT 0", true);
    await waitForTranscriptWrite(server, terminalId, (entry) => entry.event === "exit_requested" && entry.code === 0);
    const exited = await waitForEvent(page, terminalId, eventId(allEvents), "exit", { exitCode: 0 });
    expect(exited.data.exitCode).toBe(0);
    const exitedSnapshot = exited.snapshot;
    expect(exitedSnapshot.exitCode).toBe(0);
    expect(exitedSnapshot.socketState).toBe("exited");
    expect(exitedSnapshot.acceptingInput).toBe(false);
    await waitForSnapshot(page, terminalId, { socketState: "exited", activeSocketCount: 0 });
    const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: EVENT_TIMEOUT_MS });
    expect(invariantReport.snapshot.socketState).toBe("exited");
    expect(invariantReport.snapshot.activeSocketCount).toBe(0);
    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || (entry.kind === "console" && /^error:/i.test(entry.message))
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
    expect(allEvents.filter((event) => event.type === "error")).toHaveLength(0);
    const finalEvents = await terminalEvents(page, terminalId) as readonly NumericEvent[];
    await assertMonotonicSequences(finalEvents);
    expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
    expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
    expect(allEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  } finally {
    faultController.resume("server-to-browser", { terminalId, generation, binaryKind: 1 });
    pauseOutput.dispose();
    browserErrors.dispose();
  }
});
