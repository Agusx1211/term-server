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
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 45_000;

// Keep the browser layouts fixed; derive the resulting xterm grid from
// diagnostics after each fit pass instead of assuming chrome dimensions.
const GEOMETRY_A = { width: 96, height: 166 } as const;
const GEOMETRY_B = { width: 174, height: 190 } as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type DiagnosticEvent = E2ETerminalEvent<Record<string, unknown>>;

type RecordingEvent = {
  readonly terminal: string;
  readonly type: string;
  readonly sequence?: number;
  readonly data?: string;
};

type RecordingExport = {
  readonly truncated: boolean;
  readonly events: readonly RecordingEvent[];
};

type OutputEvent = RecordingEvent & {
  readonly type: "output";
  readonly sequence: number;
  readonly data: string;
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

function writeEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((entry) => entry.event === "write");
}

function writeBytes(entry: TranscriptEntry): Buffer {
  const encoded = transcriptString(entry, "data_base64");
  if (!encoded) throw new Error("fixture write omitted data_base64");
  return Buffer.from(encoded, "base64");
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
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

async function waitForTerminalText(
  page: Page,
  terminalId: string,
  text: string,
  options: { readonly settled?: boolean } = {},
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected, settled }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.xterm.text.replaceAll("\n", "").includes(expected)
      && (!settled || (
        snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
      ))
    ), { timeout: 45_000 });
  }, { id: terminalId, expected: text, settled: options.settled });
}

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  expected: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expectedGeometry }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.cols === expectedGeometry.cols
      && snapshot.rows === expectedGeometry.rows
      && snapshot.serverViewport?.cols === expectedGeometry.cols
      && snapshot.serverViewport?.rows === expectedGeometry.rows
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.syncTarget === undefined
    ), { timeout: 45_000 });
  }, { id: terminalId, expectedGeometry: expected });
}

async function waitForOutputEnd(
  page: Page,
  terminalId: string,
  expectedEnd: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, end }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.receivedSequence !== undefined
      && snapshot.receivedSequence >= end
    ), { timeout: 45_000 });
  }, { id: terminalId, end: expectedEnd });
}

async function waitForDesiredViewport(
  page: Page,
  terminalId: string,
  previous: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previousViewport, timeoutMs }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.desiredViewport !== undefined
      && snapshot.desiredViewport.cols > 0
      && snapshot.desiredViewport.rows > 0
      && snapshot.desiredViewport.pixelWidth > 0
      && snapshot.desiredViewport.pixelHeight > 0
      && (
        snapshot.desiredViewport.cols !== previousViewport.cols
        || snapshot.desiredViewport.rows !== previousViewport.rows
      )
    ), { timeout: timeoutMs });
  }, { id: terminalId, previousViewport: previous, timeoutMs: WAIT_TIMEOUT_MS });
}
async function waitForSentViewport(page: Page, terminalId: string, afterEventId: number, expected: { cols: number; rows: number }): Promise<DiagnosticEvent> {
  return page.evaluate(async ({ id, after, expectedViewport }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "viewport"
      && event.data.source === "sent"
      && event.data.cols === expectedViewport.cols
      && event.data.rows === expectedViewport.rows
    ), { timeout: 45_000 });
  }, { id: terminalId, after: afterEventId, expectedViewport: expected });
}

async function waitForSizeEvent(page: Page, terminalId: string, afterEventId: number, expected: { cols: number; rows: number }): Promise<DiagnosticEvent> {
  return page.evaluate(async ({ id, after, expectedViewport }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "size"
      && event.data.cols === expectedViewport.cols
      && event.data.rows === expectedViewport.rows
    ), { timeout: 45_000 });
  }, { id: terminalId, after: afterEventId, expectedViewport: expected });
}

async function waitForExit(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async (id) => {
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
    ), { timeout: 45_000 });
  }, terminalId);
}

function terminalFramePayloadBytes(frameBytes: number): number {
  const webSocketHeaderBytes = frameBytes < 126 ? 2 : frameBytes < 65_536 ? 4 : 10;
  return frameBytes - webSocketHeaderBytes - 9;
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

function frameOccurrence(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
  direction: "browser-to-server" | "server-to-browser",
  jsonType: string,
): number {
  return Math.max(0, ...events
    .filter((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === direction
      && event.frame?.jsonType === jsonType
    ))
    .map((event) => event.frame?.occurrence ?? 0));
}

function frameIs(
  event: NetworkFaultEvent,
  terminalId: string,
  generation: number,
  direction: "browser-to-server" | "server-to-browser",
  jsonType: string,
  afterOccurrence: number,
): boolean {
  return event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === direction
    && event.frame?.jsonType === jsonType
    && (event.frame.occurrence ?? 0) > afterOccurrence;
}

async function waitForFrame(
  controller: { waitFor(predicate: (event: NetworkFaultEvent) => boolean, options?: { timeoutMs?: number }): Promise<NetworkFaultEvent> },
  terminalId: string,
  generation: number,
  direction: "browser-to-server" | "server-to-browser",
  jsonType: string,
  afterOccurrence: number,
): Promise<NetworkFaultEvent> {
  return controller.waitFor(
    (event) => frameIs(event, terminalId, generation, direction, jsonType, afterOccurrence),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}



test("@nightly @O-05 @output @ordering @resize O-05 Output immediately after resize", async ({ page, baseURL, server, faultController }, testInfo) => {
  await page.setViewportSize({ width: 1_280, height: 720 });
  const browserErrors = installBrowserErrorCollectors(page);
  let recordingStarted = false;
  let downstreamPause: (() => void) & { readonly id: string; dispose(): void } | undefined;
  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();

    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    await page.setViewportSize({ width: GEOMETRY_A.width, height: GEOMETRY_A.height });

    const mountPromise = page.evaluate(async (timeoutMs) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount", { timeout: timeoutMs });
    }, WAIT_TIMEOUT_MS);
    await workbench.createTerminal();
    const mounted = await mountPromise;
    const terminalId = mounted.terminalId;
    const pane = new TerminalPanePage(page, terminalId);
    await pane.expectVisible();

    const baseline = await page.evaluate(async ({ id, timeoutMs }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, (snapshot) => (
        snapshot.socketState === "connected"
        && snapshot.syncMode === undefined
        && snapshot.acceptingInput
        && snapshot.cols > 0
        && snapshot.rows > 0
        && snapshot.serverViewport !== undefined
        && snapshot.serverViewport.cols === snapshot.cols
        && snapshot.serverViewport.rows === snapshot.rows
        && snapshot.serverViewport.pixelWidth > 0
        && snapshot.serverViewport.pixelHeight > 0
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
      ), { timeout: timeoutMs });
    }, { id: terminalId, timeoutMs: WAIT_TIMEOUT_MS });
    const geometryA = { cols: baseline.cols, rows: baseline.rows };
    expect(geometryA.cols).toBeGreaterThan(0);
    expect(geometryA.rows).toBeGreaterThan(0);
    expect(baseline.cols).toBe(geometryA.cols);
    expect(baseline.rows).toBe(geometryA.rows);
    expect(baseline.serverViewport).toMatchObject({ cols: geometryA.cols, rows: geometryA.rows });
    expect(baseline.viewport).toEqual(baseline.serverViewport);
    expect(baseline.viewport).toMatchObject({ cols: geometryA.cols, rows: geometryA.rows });
    const diagnosticsFloor = Math.max(0, ...(await terminalEvents(page, terminalId)).map((event) => event.id));
    const transcriptBefore = await server.readTranscript(terminalId);
    const transcriptFloor = Math.max(0, ...transcriptBefore.map(transcriptSequence));
    const networkFloor = faultController.events.length;
    const baselineReceived = baseline.receivedSequence ?? 0;
    const previousSizeOccurrence = frameOccurrence(faultController.events, terminalId, baseline.socketGeneration, "server-to-browser", "size");
    const previousResizeOccurrence = frameOccurrence(faultController.events, terminalId, baseline.socketGeneration, "browser-to-server", "resize");

    const token = `O05-${testInfo.project.name}-w${testInfo.workerIndex}-r${testInfo.retry}-e${testInfo.repeatEachIndex}`.replace(/[^A-Za-z0-9_-]+/g, "-");
    const readyId = `${token}-READY`;
    const sizeAId = `${token}-SIZE-A`;
    const holdToken = `${token}-HOLD`;
    const postId = `${token}-POST-B`;
    const sizeBId = `${token}-SIZE-B`;
    const echoId = `${token}-ECHO`;
    const inputText = `${token}-CONTINUED-INPUT`;
    const postText = `${token}-WIDTH-SENSITIVE-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ`;
    const readyMarker = marker("READY", readyId);
    const sizeAMarker = marker("SIZE", sizeAId, String(geometryA.rows), String(geometryA.cols));
    const holdMarker = marker("HOLD", holdToken);
    const postMarker = marker("PRINT", postId, postText);
    const echoReadyMarker = marker("ECHO_INPUT", echoId, "READY");
    const echoPayloadMarker = marker("ECHO_INPUT", echoId, base64(inputText));

    await recordingControl(page, "start");
    recordingStarted = true;

    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
    await waitForTerminalText(page, terminalId, readyMarker.toString("utf8").trimEnd(), { settled: true });
    await pane.sendInput(`SIZE ${sizeAId}`, true);
    const sizeA = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeAId, { timeoutMs: WAIT_TIMEOUT_MS });
    expect(sizeA.cols).toBe(geometryA.cols);
    expect(sizeA.rows).toBe(geometryA.rows);
    expect(sizeA.pixel_width).toBe(baseline.serverViewport?.pixelWidth);
    expect(sizeA.pixel_height).toBe(baseline.serverViewport?.pixelHeight);
    await waitForTerminalText(page, terminalId, sizeAMarker.toString("utf8").trimEnd(), { settled: true });

    await pane.sendInput(`HOLD ${holdToken}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
    await waitForTerminalText(page, terminalId, holdMarker.toString("utf8").trimEnd(), { settled: true });

    const paused = faultController.pause("server-to-browser", {
      terminalId,
      generation: baseline.socketGeneration,
    });
    downstreamPause = paused;
    await faultController.waitFor((event) => (
      event.type === "paused"
      && event.ruleId === paused.id
      && event.terminalId === terminalId
      && event.generation === baseline.socketGeneration
      && event.direction === "server-to-browser"
    ), { timeoutMs: WAIT_TIMEOUT_MS });

    const diagnosticBeforeResize = await terminalEvents(page, terminalId);
    const diagnosticBeforeResizeId = Math.max(0, ...diagnosticBeforeResize.map((event) => event.id));
    await page.setViewportSize({ width: GEOMETRY_B.width, height: GEOMETRY_B.height });
    const desiredB = await waitForDesiredViewport(page, terminalId, geometryA);
    const desiredBViewport = desiredB.desiredViewport;
    if (!desiredBViewport) throw new Error("desired viewport omitted after resize");
    const geometryB = { cols: desiredBViewport.cols, rows: desiredBViewport.rows };
    expect(geometryB.cols).toBeGreaterThan(geometryA.cols);
    expect(geometryB.rows).toBeGreaterThan(geometryA.rows);
    const sizeBMarker = marker("SIZE", sizeBId, String(geometryB.rows), String(geometryB.cols));
    expect(postMarker.length).toBeGreaterThan(geometryB.cols);

    const sentBPromise = waitForSentViewport(page, terminalId, diagnosticBeforeResizeId, geometryB);
    const resizeFramePromise = waitForFrame(faultController, terminalId, baseline.socketGeneration, "browser-to-server", "resize", previousResizeOccurrence);
    const serverSizeFramePromise = waitForFrame(faultController, terminalId, baseline.socketGeneration, "server-to-browser", "size", previousSizeOccurrence);
    const winchPromise = server.waitForTranscript(terminalId, (entry) => (
      transcriptSequence(entry) > transcriptFloor
      && entry.event === "sigwinch"
      && entry.rows === geometryB.rows
      && entry.cols === geometryB.cols
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const [sentB, resizeFrame, serverSizeFrame, winch] = await Promise.all([
      sentBPromise,
      resizeFramePromise,
      serverSizeFramePromise,
      winchPromise,
    ]);
    expect(desiredB.desiredViewport).toMatchObject(geometryB);
    expect(sentB.data).toMatchObject({ source: "sent", cols: geometryB.cols, rows: geometryB.rows });
    expect(resizeFrame.frame?.jsonType).toBe("resize");
    expect(serverSizeFrame.frame?.jsonType).toBe("size");
    expect(winch.rows).toBe(geometryB.rows);
    expect(winch.cols).toBe(geometryB.cols);

    const pausedSnapshot = await pane.snapshot();
    if (!pausedSnapshot) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
    expect(pausedSnapshot.serverViewport?.cols).toBe(geometryA.cols);
    expect(pausedSnapshot.serverViewport?.rows).toBe(geometryA.rows);
    expect(pausedSnapshot.cols).toBe(geometryA.cols);
    expect(pausedSnapshot.rows).toBe(geometryA.rows);

    const diagnosticBeforeSizeRelease = await terminalEvents(page, terminalId);
    const diagnosticBeforeSizeReleaseId = Math.max(0, ...diagnosticBeforeSizeRelease.map((event) => event.id));
    const sizeEventPromise = waitForSizeEvent(page, terminalId, diagnosticBeforeSizeReleaseId, geometryB);
    downstreamPause.dispose();
    downstreamPause = undefined;
    await faultController.waitFor((event) => (
      event.type === "resumed"
      && event.ruleId === paused.id
      && event.terminalId === terminalId
      && event.generation === baseline.socketGeneration
      && event.direction === "server-to-browser"
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const sizeEvent = await sizeEventPromise;
    expect(sizeEvent.data.cols).toBe(geometryB.cols);
    expect(sizeEvent.data.rows).toBe(geometryB.rows);
    expect(sizeEvent.data.epoch).toEqual(expect.any(Number));
    expect(sizeEvent.data.epoch).toBeGreaterThan(baseline.gridEpoch ?? -1);

    await pane.sendInput(`RELEASE ${holdToken}`, true);
    const release = await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
    expect(release.token).toBe(holdToken);
    await waitForSettledTerminal(page, terminalId, geometryB);

    const beforePostPixels = await screenshotRegion(page, pane.xtermHost.locator(".xterm-screen"));
    const postWritePromise = server.waitForTranscript(terminalId, (entry) => (
      transcriptSequence(entry) > transcriptFloor
      && entry.event === "write"
      && entry.data_base64 === base64(postMarker)
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const postPrintPromise = server.waitForTranscript(terminalId, (entry) => (
      transcriptSequence(entry) > transcriptFloor
      && entry.event === "print"
      && entry.id === postId
      && entry.text === postText
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`PRINT ${postId} ${postText}`, true);
    const [postWrite, postPrint] = await Promise.all([postWritePromise, postPrintPromise]);
    expect(postPrint.text).toBe(postText);
    expect(postWrite.data_base64).toBe(base64(postMarker));
    const postVisible = await waitForTerminalText(page, terminalId, postMarker.toString("utf8").trimEnd(), { settled: true });
    expect(countOccurrences(postVisible.xterm.text.replaceAll("\n", ""), postMarker.toString("utf8").trimEnd())).toBe(1);
    expect(postVisible.xterm.text.split("\n").every((line) => line.length <= geometryB.cols)).toBe(true);
    await expectKnownMarkerChanged(page, pane.xtermHost.locator(".xterm-screen"), beforePostPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-05-post-resize-marker-crop",
    });
    await expectTerminalNonBlank(page, pane.xtermHost.locator(".xterm-screen"), {
      testInfo,
      artifactName: "o-05-post-resize-terminal-crop",
    });

    await pane.sendInput(`SIZE ${sizeBId}`, true);
    const sizeB = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeBId, { timeoutMs: WAIT_TIMEOUT_MS });
    expect(sizeB.rows).toBe(geometryB.rows);
    expect(sizeB.cols).toBe(geometryB.cols);
    expect(sizeB.pixel_width).toBe(sentB.data.pixelWidth);
    expect(sizeB.pixel_height).toBe(sentB.data.pixelHeight);
    await waitForTerminalText(page, terminalId, sizeBMarker.toString("utf8").trimEnd(), { settled: true });

    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(inputText, true);
    const echoPayload = await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === base64(inputText)
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    expect(echoPayload.payload_base64).toBe(base64(inputText));
    await waitForTerminalText(page, terminalId, echoReadyMarker.toString("utf8").trimEnd(), { settled: true });
    const finalMarker = await waitForTerminalText(page, terminalId, echoPayloadMarker.toString("utf8").trimEnd(), { settled: true });

    const scenarioTranscript = (await server.readTranscript(terminalId)).filter((entry) => transcriptSequence(entry) > transcriptFloor);
    const writes = writeEntries(scenarioTranscript);
    const sigwinches = scenarioTranscript.filter((entry) => (
      entry.event === "sigwinch"
      && entry.rows === geometryB.rows
      && entry.cols === geometryB.cols
    ));
    expect(sigwinches).toHaveLength(1);
    expect(transcriptSequence(sigwinches[0]!)).toBeLessThan(transcriptSequence(postPrint));
    const signalSequence = transcriptNumber(sigwinches[0]!, "signal_sequence");
    if (signalSequence === undefined) throw new Error("SIGWINCH transcript omitted signal_sequence");
    const expectedBWinch = marker("WINCH", String(signalSequence), String(geometryB.rows), String(geometryB.cols));
    const expectedWrites: Buffer[] = [];
    for (const entry of scenarioTranscript) {
      if (entry.event === "ready" && typeof entry.id === "string") {
        expectedWrites.push(marker("READY", entry.id));
      } else if (entry.event === "size" && typeof entry.id === "string") {
        const rows = transcriptNumber(entry, "rows");
        const cols = transcriptNumber(entry, "cols");
        if (rows === undefined || cols === undefined) throw new Error("SIZE transcript omitted dimensions");
        expectedWrites.push(marker("SIZE", entry.id, String(rows), String(cols)));
      } else if (entry.event === "hold" && typeof entry.token === "string") {
        expectedWrites.push(marker("HOLD", entry.token));
      } else if (entry.event === "sigwinch") {
        const sequence = transcriptNumber(entry, "signal_sequence");
        const rows = transcriptNumber(entry, "rows");
        const cols = transcriptNumber(entry, "cols");
        if (sequence === undefined || rows === undefined || cols === undefined) throw new Error("SIGWINCH transcript omitted marker fields");
        expectedWrites.push(marker("WINCH", String(sequence), String(rows), String(cols)));
      } else if (entry.event === "release" && typeof entry.token === "string") {
        expectedWrites.push(marker("RELEASE", entry.token));
      } else if (entry.event === "print" && typeof entry.id === "string" && typeof entry.text === "string") {
        expectedWrites.push(marker("PRINT", entry.id, entry.text));
      } else if (entry.event === "echo_input" && typeof entry.id === "string") {
        if (entry.phase === "armed") expectedWrites.push(marker("ECHO_INPUT", entry.id, "READY"));
        else if (entry.phase === "payload" && typeof entry.payload_base64 === "string") expectedWrites.push(marker("ECHO_INPUT", entry.id, entry.payload_base64));
      }
    }
    expect(expectedWrites).toContainEqual(expectedBWinch);
    expect(expectedWrites).toContainEqual(postMarker);
    expect(expectedWrites).toContainEqual(sizeBMarker);
    expect(expectedWrites).toContainEqual(echoPayloadMarker);
    expect(writes).toHaveLength(expectedWrites.length);
    expect(writes.map(writeBytes)).toEqual(expectedWrites);
    const writeSequences = writes.map((entry) => transcriptNumber(entry, "write_sequence"));
    expect(writeSequences.every((sequence) => sequence !== undefined)).toBe(true);
    for (let index = 1; index < writeSequences.length; index += 1) {
      expect(writeSequences[index]).toBe((writeSequences[index - 1] ?? 0) + 1);
    }
    const outputBytes = Buffer.concat(writes.map(writeBytes));
    const outputEnd = baselineReceived + outputBytes.length;
    await waitForOutputEnd(page, terminalId, outputEnd);

    const finalEvents = await terminalEvents(page, terminalId);
    const browserBSizeEvents = finalEvents.filter((event) => (
      event.id > diagnosticsFloor
      && event.type === "size"
      && event.data.cols === geometryB.cols
      && event.data.rows === geometryB.rows
    ));
    expect(browserBSizeEvents).toHaveLength(1);
    const browserBResizeFrames = faultController.events.filter((event) => frameIs(
      event,
      terminalId,
      baseline.socketGeneration,
      "browser-to-server",
      "resize",
      previousResizeOccurrence,
    ));
    expect(browserBResizeFrames).toHaveLength(1);
    const serverBSizeFrames = faultController.events.filter((event) => frameIs(
      event,
      terminalId,
      baseline.socketGeneration,
      "server-to-browser",
      "size",
      previousSizeOccurrence,
    ));
    expect(serverBSizeFrames).toHaveLength(1);
    const outputReceived = finalEvents.filter((event) => event.id > diagnosticsFloor && event.type === "output-received");
    let receivedEnd = baselineReceived;
    let receivedBytes = 0;
    for (const event of outputReceived) {
      const sequence = event.data.sequence;
      const bytes = event.data.bytes;
      if (typeof sequence !== "number" || typeof bytes !== "number") throw new Error("output-received event omitted sequence or bytes");
      expect(sequence).toBe(receivedEnd + bytes);
      receivedEnd = sequence;
      receivedBytes += bytes;
    }
    expect(receivedBytes).toBe(outputBytes.length);
    expect(receivedEnd).toBe(outputEnd);

    const firstWinchWriteIndex = writes.findIndex((entry) => writeBytes(entry).equals(expectedBWinch));
    expect(firstWinchWriteIndex).toBeGreaterThanOrEqual(0);
    const bytesBeforeResize = writes.slice(0, firstWinchWriteIndex).reduce((total, entry) => total + writeBytes(entry).length, 0);
    const firstWinchEnd = baselineReceived + bytesBeforeResize + writeBytes(writes[firstWinchWriteIndex]!).length;
    const sizeEventIndex = finalEvents.findIndex((event) => event.id === sizeEvent.id);
    const firstBOutputEvent = outputReceived.find((event) => (
      typeof event.data.sequence === "number"
      && event.data.sequence > baselineReceived + bytesBeforeResize
    ));
    if (!firstBOutputEvent) throw new Error("no browser output-received event for the post-resize PTY write");
    expect(sizeEventIndex).toBeGreaterThanOrEqual(0);
    expect(sizeEvent.id).toBeLessThan(firstBOutputEvent.id);
    expect(firstBOutputEvent.data.sequence).toBeGreaterThanOrEqual(firstWinchEnd);
    const firstBCommit = finalEvents.find((event) => (
      event.id > firstBOutputEvent.id
      && event.type === "parser-commit"
      && event.data.sequence === firstBOutputEvent.data.sequence
    ));
    expect(firstBCommit).toBeDefined();
    expect(firstBCommit!.id).toBeGreaterThan(sizeEvent.id);

    const recording = await (async () => {
      await recordingControl(page, "stop");
      recordingStarted = false;
      return recordingExport(page);
    })();
    expect(recording.truncated).toBe(false);
    const outputRecords = recording.events.filter((event): event is OutputEvent => (
      event.terminal === terminalId
      && event.type === "output"
      && typeof event.sequence === "number"
      && typeof event.data === "string"
    ));
    expect(outputRecords.length).toBeGreaterThan(0);
    let recordedSequence = baselineReceived;
    const recordedChunks: Buffer[] = [];
    for (const record of outputRecords) {
      expect(record.sequence).toBe(recordedSequence);
      const bytes = Buffer.from(record.data, "base64");
      recordedChunks.push(bytes);
      recordedSequence += bytes.length;
    }
    expect(recordedSequence).toBe(outputEnd);
    expect(Buffer.concat(recordedChunks)).toEqual(outputBytes);

    const frames = outputFrames(faultController.events.slice(networkFloor), terminalId);
    expect(frames.length).toBeGreaterThan(0);
    let frameSequence = baselineReceived;
    let frameBytes = 0;
    for (const event of frames) {
      expect(event.frame.sequence).toBe(frameSequence);
      const payloadBytes = terminalFramePayloadBytes(event.frame.bytes);
      expect(payloadBytes).toBeGreaterThan(0);
      frameBytes += payloadBytes;
      frameSequence += payloadBytes;
    }
    expect(frameBytes).toBe(outputBytes.length);
    expect(frameSequence).toBe(outputEnd);

    const model = new Terminal({
      cols: geometryA.cols,
      rows: geometryA.rows,
      scrollback: 2_000,
      ...tuiCompatibilityOptions(),
    });
    const recordedOutput = Buffer.concat(recordedChunks);
    await writeModel(model, recordedOutput.subarray(0, bytesBeforeResize));
    model.resize(geometryB.cols, geometryB.rows);
    await writeModel(model, recordedOutput.subarray(bytesBeforeResize));
    const modelText = activeText(model);
    const settled = await waitForSettledTerminal(page, terminalId, geometryB);
    expect(settled.xterm.text).toBe(modelText);
    expect(settled.xterm.activeBuffer).toBe(model.buffer.active.type);
    expect(settled.xterm.cursorX).toBe(model.buffer.active.cursorX);
    expect(settled.xterm.cursorY).toBe(model.buffer.active.cursorY);
    expect(settled.xterm.viewportY).toBe(model.buffer.active.viewportY);
    expect(countOccurrences(settled.xterm.text.replaceAll("\n", ""), postMarker.toString("utf8").trimEnd())).toBe(1);
    expect(settled.xterm.text.split("\n").every((line) => line.length <= geometryB.cols)).toBe(true);
    expect(settled.cols).toBe(geometryB.cols);
    expect(settled.rows).toBe(geometryB.rows);
    expect(settled.serverViewport).toMatchObject({ cols: geometryB.cols, rows: geometryB.rows });
    expect(settled.viewport).toMatchObject({ cols: geometryB.cols, rows: geometryB.rows });
    expect(settled.gridEpoch).toBe(sizeEvent.data.epoch);
    expect(settled.receivedSequence).toBe(outputEnd);
    expect(settled.committedSequence).toBe(outputEnd);
    expect(settled.activeSocketCount).toBe(1);
    expect(settled.socket.activeCount).toBe(1);
    expect(settled.acceptingInput).toBe(true);
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

    expect(scenarioTranscript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(scenarioTranscript.filter((entry) => entry.event === "print" && entry.id === postId)).toHaveLength(1);
    expect(scenarioTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "socket-close" || event.type === "socket-stale")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "sync")).toHaveLength(1);
    await assertMonotonicSequences(finalEvents);
    const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);

    await pane.sendInput("EXIT 0", true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "exit_requested" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(terminalId, (entry) => entry.event === "exit" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    const exited = await waitForExit(page, terminalId);
    expect(exited.exitCode).toBe(0);
    expect(exited.activeSocketCount).toBe(0);
    expect(exited.acceptingInput).toBe(false);
    const finalInvariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(finalInvariantReport.violations).toEqual([]);
    expect(finalInvariantReport.snapshot.socketState).toBe("exited");
    expect(finalInvariantReport.snapshot.activeSocketCount).toBe(0);

    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || (entry.kind === "console" && /^error:/i.test(entry.message))
      || (entry.kind === "websocket" && !["opened", "closed"].includes(entry.message))
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
    await expectTerminalNonBlank(page, pane.xtermHost.locator(".xterm-screen"), {
      testInfo,
      artifactName: "o-05-final-terminal-crop",
    });
    expect(finalMarker.xterm.text.replaceAll("\n", "")).toContain(echoPayloadMarker.toString("utf8").trimEnd());
  } finally {
    if (downstreamPause) downstreamPause.dispose();
    if (recordingStarted) await recordingControl(page, "stop");
    browserErrors.dispose();
  }
});
