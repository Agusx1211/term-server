import { Buffer } from "node:buffer";
import { Terminal } from "../fixtures/headless-terminal.js"
import type { Page } from "@playwright/test";
import { expect, test, type TranscriptEntry } from "../fixtures/test.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalConnected,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
  waitForTerminalBuffer,
} from "../assertions/terminal-state.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { expectConnectedTerminalInvariants, expectTerminalInvariants } from "../assertions/invariants.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type RecordingEvent = {
  readonly terminal: string;
  readonly type: string;
  readonly sequence?: number;
  readonly data?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly pixelWidth?: number;
  readonly pixelHeight?: number;
};

type RecordingExport = {
  readonly truncated: boolean;
  readonly events: readonly RecordingEvent[];
};

type OutputFrame = NetworkFaultEvent & {
  readonly type: "frame";
  readonly direction: "server-to-browser";
  readonly frame: NonNullable<NetworkFaultEvent["frame"]> & {
    readonly binaryKind: number;
    readonly sequence: number;
    readonly bytes: number;
    readonly fin: boolean;
  };
};

const WAIT_TIMEOUT_MS = 60_000;
const BROWSER_VIEWPORT = { width: 1_400, height: 900 } as const;
const GEOMETRY_A = { cols: 80, rows: 24 } as const;
const GEOMETRY_B = { cols: 100, rows: 30 } as const;
const BURST_BYTES = 200_000;
const BURST_LINE_WIDTH = 80;
const MOUSE_CAPTURE_BYTES = 36;

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function marker(operation: string, ...fields: readonly string[]): Buffer {
  return Buffer.from(`[E2E:${operation}${fields.map((field) => `:${field}`).join("")}]\n`, "utf8");
}

function transcriptNumber(entry: TranscriptEntry, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function transcriptString(entry: TranscriptEntry, key: string): string | undefined {
  const value = entry[key];
  return typeof value === "string" ? value : undefined;
}

function transcriptSequence(entry: TranscriptEntry): number {
  return transcriptNumber(entry, "sequence") ?? 0;
}

function entriesAfter(entries: readonly TranscriptEntry[], sequence: number): TranscriptEntry[] {
  return entries.filter((entry) => transcriptSequence(entry) > sequence);
}

function writeEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((entry) => entry.event === "write");
}

function writeBytes(entry: TranscriptEntry): Buffer {
  const encoded = transcriptString(entry, "data_base64");
  if (!encoded) throw new Error("fixture write omitted data_base64");
  return Buffer.from(encoded, "base64");
}

function burstBytes(bytes: number, lineWidth: number): Buffer {
  const output: number[] = [];
  let column = 0;
  let visible = 0;
  while (output.length < bytes) {
    output.push("A".charCodeAt(0) + (visible % 26));
    visible += 1;
    column += 1;
    if (column === lineWidth && output.length < bytes - 1) {
      output.push(0x0a);
      column = 0;
    }
  }
  return Buffer.from(output);
}

function mouseSetup(mode: "drag" | "sgr"): Buffer {
  return Buffer.from(mode === "drag" ? "\x1b[?1002h" : "\x1b[?1006h", "ascii");
}

function mouseReport(button: number, col: number, row: number, release: boolean): Buffer {
  return Buffer.from(`\x1b[<${button};${col};${row}${release ? "m" : "M"}`, "ascii");
}

function activeText(terminal: Terminal): string {
  const active = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < active.length; index += 1) {
    lines.push(active.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

async function writeModel(terminal: Terminal, bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve) => {
    terminal.write(new Uint8Array(bytes), resolve);
  });
}

async function recordingControl(page: Page, action: "start" | "stop"): Promise<void> {
  await page.evaluate(async (requestedAction) => {
    const response = await fetch("/api/debug/recording", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: requestedAction }),
    });
    if (!response.ok) throw new Error(`debug recording ${requestedAction} failed with HTTP ${response.status}`);
  }, action);
}

async function recordingExport(page: Page): Promise<RecordingExport> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export");
    if (!response.ok) throw new Error(`debug recording export failed with HTTP ${response.status}`);
    return await response.json() as RecordingExport;
  });
}

async function waitForTerminalSettled(
  page: Page,
  terminalId: string,
  expected: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected: target, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.cols === target.cols
      && snapshot.rows === target.rows
      && snapshot.serverViewport?.cols === target.cols
      && snapshot.serverViewport?.rows === target.rows
      && snapshot.desiredViewport?.cols === target.cols
      && snapshot.desiredViewport?.rows === target.rows
      && snapshot.sentViewport?.cols === target.cols
      && snapshot.sentViewport?.rows === target.rows
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
    ), { timeout });
  }, { id: terminalId, expected, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForSentGeometry(
  page: Page,
  terminalId: string,
  expected: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected: target, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.cols === target.cols
      && snapshot.rows === target.rows
      && snapshot.desiredViewport?.cols === target.cols
      && snapshot.desiredViewport?.rows === target.rows
      && snapshot.sentViewport?.cols === target.cols
      && snapshot.sentViewport?.rows === target.rows
    ), { timeout });
  }, { id: terminalId, expected, timeout: WAIT_TIMEOUT_MS });
}

async function resizePaneTo(
  page: Page,
  terminalId: string,
  current: E2ETerminalSnapshot,
  expected: { readonly cols: number; readonly rows: number },
): Promise<void> {
  await page.evaluate(({ id, current: before, expected: target }) => {
    const pane = [...document.querySelectorAll<HTMLElement>(".pane-slot")]
      .find((candidate) => candidate.dataset.terminalId === id);
    if (!pane) throw new Error(`terminal ${id} has no production pane slot`);
    const screen = pane.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error(`terminal ${id} has no compositor screen`);
    const paneRect = pane.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    if (before.cols <= 0 || before.rows <= 0 || screenRect.width <= 0 || screenRect.height <= 0) {
      throw new Error("terminal geometry is unavailable for deterministic resize");
    }
    const cellWidth = screenRect.width / before.cols;
    const cellHeight = screenRect.height / before.rows;
    pane.style.left = "0px";
    pane.style.top = "0px";
    pane.style.width = `${paneRect.width + (target.cols - before.cols) * cellWidth}px`;
    pane.style.height = `${paneRect.height + (target.rows - before.rows) * cellHeight}px`;
  }, { id: terminalId, current, expected });
}

async function pointerClickCell(
  pane: TerminalPanePage,
  snapshot: E2ETerminalSnapshot,
  col: number,
  row: number,
): Promise<void> {
  const screen = pane.xtermHost.locator(".xterm-screen");
  const box = await screen.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error("terminal compositor screen has no measurable bounds");
  if (col < 1 || col > snapshot.cols || row < 1 || row > snapshot.rows) {
    throw new Error(`mouse cell ${col},${row} is outside ${snapshot.cols}x${snapshot.rows}`);
  }
  const cellWidth = box.width / snapshot.cols;
  const cellHeight = box.height / snapshot.rows;
  const x = box.x + (col - 0.5) * cellWidth;
  const y = box.y + (row - 0.5) * cellHeight;
  await pane.page.mouse.move(x, y);
  await pane.page.mouse.down();
  await pane.page.mouse.up();
}

function outputFrames(events: readonly NetworkFaultEvent[], terminalId: string): OutputFrame[] {
  return events.filter((event): event is OutputFrame => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "server-to-browser"
    && event.frame?.binaryKind === 1
    && event.frame.sequence !== undefined
    && event.frame.bytes !== undefined
    && event.frame.fin === true
  ));
}

function terminalFramePayloadBytes(frameBytes: number): number {
  const webSocketHeaderBytes = frameBytes < 126 ? 2 : frameBytes < 65_536 ? 4 : 10;
  return frameBytes - webSocketHeaderBytes - 9;
}


async function modelFromRecording(
  events: readonly RecordingEvent[],
  baseline: { readonly cols: number; readonly rows: number },
): Promise<Terminal> {
  const model = new Terminal({
    cols: baseline.cols,
    rows: baseline.rows,
    scrollback: 200_000,
    ...tuiCompatibilityOptions(),
  });
  for (const event of events) {
    if (event.type === "output") {
      if (typeof event.data !== "string") throw new Error("recorded output omitted bytes");
      await writeModel(model, Buffer.from(event.data, "base64"));
    } else if (event.type === "resize") {
      if (event.cols === undefined || event.rows === undefined) throw new Error("recorded resize omitted cell dimensions");
      model.resize(event.cols, event.rows);
    }
  }
  return model;
}

function diagnosticEventId(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.id), -1);
}


async function waitForOutputCommit(
  page: Page,
  terminalId: string,
  floor: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.id > after && event.type === "parser-commit", { timeout, afterId: after });
  }, { id: terminalId, after: floor, timeout: WAIT_TIMEOUT_MS });
}

test("@nightly @O-14 @mouse @input @resize O-14 Mouse-report traffic", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  await page.setViewportSize(BROWSER_VIEWPORT);
  const browserErrors = installBrowserErrorCollectors(page);
  const token = `O14-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}`;
  const readyId = `${token}-READY`;
  const dragId = `${token}-DRAG`;
  const sgrId = `${token}-SGR`;
  const burstId = `${token}-BURST`;
  const captureId = `${token}-CAPTURE`;
  const finalId = `${token}-FINAL`;
  const echoId = `${token}-ECHO`;
  const echoPayload = `${token}-CONTINUED`;
  const mouseReports = [
    mouseReport(0, 3, 2, false),
    mouseReport(0, 3, 2, true),
    mouseReport(0, 5, 4, false),
    mouseReport(0, 5, 4, true),
  ];
  const expectedMouseInput = Buffer.concat(mouseReports);
  const expectedFinalText = `FINAL-${token}`;
  let networkFloor = 0;
  let recordingStarted = false;
  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const mountPromise = page.evaluate(async ({ timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount", { timeout });
    }, { timeout: WAIT_TIMEOUT_MS });
    await workbench.createTerminal();
    const mounted = await mountPromise;
    const terminalId = mounted.terminalId;
    const pane = new TerminalPanePage(page, terminalId);
    await pane.expectVisible();
    await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await pane.focus();

    const beforeGeometry = await terminalSnapshot(page, terminalId);
    if (!beforeGeometry) throw new Error("terminal diagnostics snapshot disappeared after synchronization");
    await resizePaneTo(page, terminalId, beforeGeometry, GEOMETRY_A);
    const baseline = await waitForTerminalSettled(page, terminalId, GEOMETRY_A);
    expect(baseline.serverViewport?.cols).toBe(GEOMETRY_A.cols);
    expect(baseline.serverViewport?.rows).toBe(GEOMETRY_A.rows);
    expect(baseline.pixelWidth).toBeGreaterThan(0);
    expect(baseline.pixelHeight).toBeGreaterThan(0);

    const screen = pane.xtermHost.locator(".xterm-screen");
    const transcriptBefore = await server.readTranscript(terminalId);
    const transcriptFloor = transcriptBefore.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
    const diagnosticFloor = diagnosticEventId(await terminalEvents(page, terminalId));
    networkFloor = faultController.events.length;
    await recordingControl(page, "start");
    recordingStarted = true;

    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
    await waitForTerminalBuffer(page, terminalId, { contains: `[E2E:READY:${readyId}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const dragCommitFloor = diagnosticEventId(await terminalEvents(page, terminalId));
    const dragCommit = waitForOutputCommit(page, terminalId, dragCommitFloor);
    const dragTranscript = server.waitForTranscript(terminalId, (entry) => entry.event === "mouse" && entry.id === dragId && entry.action === "enable" && entry.mode === "drag", { timeoutMs: WAIT_TIMEOUT_MS });
    const dragBuffer = waitForTerminalBuffer(page, terminalId, { contains: `[E2E:MOUSE:${dragId}:ENABLE]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await pane.sendInput(`MOUSE ${dragId} enable drag`, true);
    await Promise.all([dragTranscript, dragCommit, dragBuffer]);

    const sgrCommitFloor = diagnosticEventId(await terminalEvents(page, terminalId));
    const sgrCommit = waitForOutputCommit(page, terminalId, sgrCommitFloor);
    const sgrTranscript = server.waitForTranscript(terminalId, (entry) => entry.event === "mouse" && entry.id === sgrId && entry.action === "enable" && entry.mode === "sgr", { timeoutMs: WAIT_TIMEOUT_MS });
    const sgrBuffer = waitForTerminalBuffer(page, terminalId, { contains: `[E2E:MOUSE:${sgrId}:ENABLE]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await pane.sendInput(`MOUSE ${sgrId} enable sgr`, true);
    await Promise.all([sgrTranscript, sgrCommit, sgrBuffer]);

    const pause = faultController.pause("server-to-browser", { terminalId });
    await faultController.waitFor((event) => event.type === "paused" && event.terminalId === terminalId && event.direction === "server-to-browser", { timeoutMs: WAIT_TIMEOUT_MS });
    if (baseline.receivedSequence === undefined) throw new Error("baseline output sequence is unavailable");
    const setupOutputBytes = Buffer.concat([
      marker("READY", readyId),
      mouseSetup("drag"),
      marker("MOUSE", dragId, "ENABLE"),
      mouseSetup("sgr"),
      marker("MOUSE", sgrId, "ENABLE"),
    ]).length;
    const expectedBurstSequence = baseline.receivedSequence + setupOutputBytes;
    const burstFramePromise = faultController.waitFor((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.direction === "server-to-browser"
      && event.frame?.binaryKind === 1
      && event.frame.sequence === expectedBurstSequence
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES, { timeoutMs: WAIT_TIMEOUT_MS });
    await burstFramePromise;

    await pane.sendInput(`CAPTURE_INPUT ${captureId} ${MOUSE_CAPTURE_BYTES}`, true);
    const captureArmed = await server.waitForTranscript(terminalId, (entry) => entry.event === "capture_input" && entry.id === captureId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    const pointerNetworkFloor = faultController.events.length;
    const pointerDiagnosticFloor = diagnosticEventId(await terminalEvents(page, terminalId));
    await pointerClickCell(pane, baseline, 3, 2);

    const resizeTranscriptFloor = transcriptSequence(captureArmed);
    const resizedSnapshotBefore = await terminalSnapshot(page, terminalId);
    if (!resizedSnapshotBefore) throw new Error("terminal diagnostics snapshot disappeared before resize");
    await resizePaneTo(page, terminalId, resizedSnapshotBefore, GEOMETRY_B);
    const sentBPromise = waitForSentGeometry(page, terminalId, GEOMETRY_B);
    const winchBPromise = server.waitForTranscript(terminalId, (entry) => (
      transcriptSequence(entry) > resizeTranscriptFloor
      && entry.event === "sigwinch"
      && entry.source === "signal"
      && entry.cols === GEOMETRY_B.cols
      && entry.rows === GEOMETRY_B.rows
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const sentB = await sentBPromise;
    expect(sentB.desiredViewport?.cols).toBe(GEOMETRY_B.cols);
    expect(sentB.desiredViewport?.rows).toBe(GEOMETRY_B.rows);
    expect(sentB.sentViewport?.cols).toBe(GEOMETRY_B.cols);
    expect(sentB.sentViewport?.rows).toBe(GEOMETRY_B.rows);
    await winchBPromise;
    const beforeFinalPixels = await screenshotRegion(page, screen);

    await pointerClickCell(pane, sentB, 5, 4);
    const captureComplete = await server.waitForTranscript(terminalId, (entry) => entry.event === "capture_input" && entry.id === captureId && entry.phase === "complete", { timeoutMs: WAIT_TIMEOUT_MS });
    expect(transcriptString(captureComplete, "payload_base64")).toBe(base64(expectedMouseInput));
    expect(transcriptNumber(captureComplete, "bytes")).toBe(expectedMouseInput.length);
    expect(faultController.events.slice(pointerNetworkFloor).filter((event) => event.type === "frame" && event.direction === "browser-to-server" && event.frame?.opcode === 2)).toHaveLength(4);
    const pointerDiagnosticEvents = (await terminalEvents(page, terminalId)).filter((event) => event.id > pointerDiagnosticFloor);
    expect(pointerDiagnosticEvents.filter((event) => event.type === "error")).toEqual([]);

    pause.dispose();
    await faultController.waitFor((event) => event.type === "resumed" && event.terminalId === terminalId && event.direction === "server-to-browser", { timeoutMs: WAIT_TIMEOUT_MS });
    await waitForTerminalSettled(page, terminalId, GEOMETRY_B);

    await pane.sendInput(`PRINT ${finalId} ${expectedFinalText}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === finalId && entry.text === expectedFinalText, { timeoutMs: WAIT_TIMEOUT_MS });
    await waitForTerminalBuffer(page, terminalId, { contains: `[E2E:PRINT:${finalId}:${expectedFinalText}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await pane.sendInput(`ECHO_INPUT ${echoId} ${echoPayload}`, true);
    const echoEntry = await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
    expect(echoEntry.payload_base64).toBe(base64(echoPayload));
    await waitForTerminalBuffer(page, terminalId, { contains: `[E2E:ECHO_INPUT:${echoId}:${echoPayload}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const connectedFinal = await waitForTerminalSettled(page, terminalId, GEOMETRY_B);
    expect(connectedFinal.focused).toBe(true);
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const connectedInvariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(connectedInvariantReport.violations).toEqual([]);
    const responderSizes = (await terminalEvents(page, terminalId)).filter((event) => event.type === "size" && event.data.responder === true);
    expect(responderSizes.length).toBeGreaterThan(0);

    await pane.sendInput("EXIT 0", true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "exit_requested" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    const exited = await page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, (snapshot) => (
        snapshot.exitCode === 0
        && snapshot.socketState === "exited"
        && snapshot.activeSocketCount === 0
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
      ), { timeout });
    }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
    expect(exited.exitCode).toBe(0);

    await recordingControl(page, "stop");
    recordingStarted = false;
    const recording = await recordingExport(page);
    expect(recording.truncated).toBe(false);
    const scenarioEntries = recording.events.filter((event) => event.terminal === terminalId);
    const outputEvents = scenarioEntries.filter((event) => event.type === "output" && typeof event.sequence === "number" && typeof event.data === "string");
    expect(outputEvents.length).toBeGreaterThan(0);
    const outputBytes = outputEvents.map((event) => Buffer.from(event.data!, "base64"));
    const recordedOutput = Buffer.concat(outputBytes);
    const outputStart = outputEvents[0]?.sequence;
    if (outputStart === undefined) throw new Error("recorded output omitted its starting sequence");
    let outputSequence = outputStart;
    for (const event of outputEvents) {
      expect(event.sequence).toBe(outputSequence);
      outputSequence += Buffer.from(event.data!, "base64").length;
    }
    expect(outputSequence).toBe(outputStart + recordedOutput.length);

    const resizeEvents = scenarioEntries.filter((event) => event.type === "resize");
    expect(resizeEvents).toHaveLength(1);
    expect(resizeEvents[0]?.cols).toBe(GEOMETRY_B.cols);
    expect(resizeEvents[0]?.rows).toBe(GEOMETRY_B.rows);
    const inputEvents = scenarioEntries.filter((event) => event.type === "input" && typeof event.data === "string");
    const inputBytes = inputEvents.map((event) => Buffer.from(event.data!, "base64"));
    const reportedMouseInputs = inputBytes.filter((bytes) => bytes.subarray(0, 3).equals(Buffer.from("\x1b[<", "ascii")));
    expect(reportedMouseInputs).toEqual(mouseReports);
    const expectedWrites = [
      marker("READY", readyId),
      mouseSetup("drag"),
      marker("MOUSE", dragId, "ENABLE"),
      mouseSetup("sgr"),
      marker("MOUSE", sgrId, "ENABLE"),
      burstBytes(BURST_BYTES, BURST_LINE_WIDTH),
      marker("CAPTURE_INPUT", captureId, "ARMED"),
      marker("CAPTURE_INPUT", captureId, "COMPLETE"),
      marker("PRINT", finalId, expectedFinalText),
      marker("ECHO_INPUT", echoId, echoPayload),
    ];
    const transcript = await server.readTranscript(terminalId);
    const writes = writeEntries(entriesAfter(transcript, transcriptFloor));
    expect(writes.map(writeBytes)).toEqual(expectedWrites);
    const captureEntries = entriesAfter(transcript, transcriptFloor).filter((entry) => entry.event === "capture_input" && entry.id === captureId && entry.phase === "complete");
    expect(captureEntries).toHaveLength(1);
    expect(entriesAfter(transcript, transcriptFloor).filter((entry) => entry.event === "error")).toEqual([]);

    const outputFrameEvents = outputFrames(faultController.events.slice(networkFloor), terminalId);
    expect(outputFrameEvents.length).toBeGreaterThan(0);
    let frameSequence = outputStart;
    let frameBytes = 0;
    for (const event of outputFrameEvents) {
      expect(event.frame.sequence).toBe(frameSequence);
      const payloadBytes = terminalFramePayloadBytes(event.frame.bytes);
      expect(payloadBytes).toBeGreaterThan(0);
      frameSequence += payloadBytes;
      frameBytes += payloadBytes;
    }
    expect(frameSequence).toBe(outputStart + recordedOutput.length);
    expect(frameBytes).toBe(recordedOutput.length);

    const model = await modelFromRecording(scenarioEntries, GEOMETRY_A);
    const finalSnapshot = await terminalSnapshot(page, terminalId);
    if (!finalSnapshot) throw new Error("terminal diagnostics snapshot disappeared after exit");
    expect(finalSnapshot.xterm.text).toBe(activeText(model));
    expect(finalSnapshot.xterm.activeBuffer).toBe(model.buffer.active.type);
    expect(finalSnapshot.xterm.cursorX).toBe(model.buffer.active.cursorX);
    expect(finalSnapshot.xterm.cursorY).toBe(model.buffer.active.cursorY);
    expect(finalSnapshot.xterm.viewportY).toBe(model.buffer.active.viewportY);
    expect(finalSnapshot.cols).toBe(GEOMETRY_B.cols);
    expect(finalSnapshot.rows).toBe(GEOMETRY_B.rows);
    expect(finalSnapshot.serverViewport?.cols).toBe(GEOMETRY_B.cols);
    expect(finalSnapshot.serverViewport?.rows).toBe(GEOMETRY_B.rows);
    expect(finalSnapshot.activeSocketCount).toBe(0);
    expect(finalSnapshot.socket.activeCount).toBe(0);
    expect(finalSnapshot.pendingParserWrites).toBe(0);
    expect(finalSnapshot.pendingParserBytes).toBe(0);
    expect(finalSnapshot.renderBacklogBytes).toBe(0);
    expect(finalSnapshot.renderBacklogFrames).toBe(0);
    expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(finalSnapshot.acceptingInput).toBe(false);
    const finalEvents = await terminalEvents(page, terminalId);
    expect(finalEvents.filter((event) => event.id > diagnosticFloor && event.type === "error")).toEqual([]);
    await assertMonotonicSequences(finalEvents);
    const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);

    const { after: finalPixels } = await expectKnownMarkerChanged(page, screen, beforeFinalPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-14-mouse-output-crop",
    });
    expect(finalPixels.width).toBe(beforeFinalPixels.width);
    expect(finalPixels.height).toBe(beforeFinalPixels.height);
    await expectTerminalNonBlank(page, screen, {
      testInfo,
      artifactName: "o-14-mouse-nonblank-crop",
    });

    const proxyEvents = faultController.events.slice(networkFloor);
    expect(proxyEvents.filter((event) => event.type === "paused")).toHaveLength(1);
    expect(proxyEvents.filter((event) => event.type === "resumed")).toHaveLength(1);
    expect(proxyEvents.filter((event) => ["malformed-frame", "injected", "throttled", "dropped"].includes(event.type))).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "socket-close" || event.type === "socket-stale")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "state" && ["recovering", "disconnected"].includes(String(event.data.state)))).toEqual([]);
    expect(finalSnapshot.lifecycle.acceptingInput).toBe(false);
    expect(exited.socketState).toBe("exited");

    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || (entry.kind === "console" && /^error:/i.test(entry.message))
      || (entry.kind === "websocket" && /error|failed/i.test(entry.message))
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  } finally {
    if (recordingStarted) await recordingControl(page, "stop");
    browserErrors.dispose();
  }
});
