import { Buffer } from "node:buffer";
import { Terminal } from "../fixtures/headless-terminal.js"
import type { Page } from "@playwright/test";
import { expect, test, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalConverged,
  expectTerminalInteractive,
  expectTerminalSynchronized,
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
  readonly message?: Record<string, unknown>;
};

type RecordingExport = {
  readonly truncated: boolean;
  readonly events: readonly RecordingEvent[];
};

const WAIT_TIMEOUT_MS = 60_000;
const BROWSER_VIEWPORT = { width: 1_280, height: 720 } as const;
const GRID_A = { cols: 5, rows: 3 } as const;
const GRID_B = { cols: 7, rows: 3 } as const;
const MOBILE_TOOLBAR_HEIGHT = 44;
const MOBILE_PANE_HEADER_HEIGHT = 44;
const MOBILE_KEYBAR_HEIGHT = 45;
const MOBILE_XTERM_PADDING_X = 12;
const MOBILE_XTERM_PADDING_Y = 10;

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function transcriptSequence(entry: TranscriptEntry): number {
  const value = entry.sequence;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function entriesAfter(entries: readonly TranscriptEntry[], sequence: number): TranscriptEntry[] {
  return entries.filter((entry) => transcriptSequence(entry) > sequence);
}


function writeEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((entry) => entry.event === "write");
}

function writeBytes(entry: TranscriptEntry): Buffer {
  const encoded = entry.data_base64;
  if (typeof encoded !== "string" || encoded.length === 0) throw new Error("fixture write omitted data_base64");
  return Buffer.from(encoded, "base64");
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
  await new Promise<void>((resolve) => terminal.write(new Uint8Array(bytes), resolve));
}

function countWrappedOccurrences(value: string, needle: string): number {
  let count = 0;
  for (let start = 0; start < value.length; start += 1) {
    let offset = 0;
    for (let index = start; index < value.length && offset < needle.length; index += 1) {
      const character = value[index];
      if (character === "\n" || character === "\r") continue;
      if (character !== needle[offset]) break;
      offset += 1;
    }
    if (offset === needle.length) count += 1;
  }
  return count;
}

function targetBrowserViewport(cellWidth: number, cellHeight: number, grid: { cols: number; rows: number }): { width: number; height: number } {
  return {
    // The extra pixel keeps xterm's floor-based fit calculation on the desired
    // side of a fractional cell metric at DPR 1.
    width: Math.ceil(MOBILE_XTERM_PADDING_X + grid.cols * cellWidth + 1),
    height: Math.ceil(
      MOBILE_TOOLBAR_HEIGHT
      + MOBILE_PANE_HEADER_HEIGHT
      + MOBILE_KEYBAR_HEIGHT
      + MOBILE_XTERM_PADDING_Y
      + grid.rows * cellHeight
      + 1,
    ),
  };
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

async function waitForMarginCursor(page: Page, terminalId: string, expected: { cols: number; rows: number }): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, cols, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.cols === cols
      && snapshot.rows === rows
      && snapshot.socketState === "connected"
      && snapshot.xterm.cursorX === cols
      && snapshot.xterm.cursorY === 0
      && snapshot.xterm.text.includes("ABCDE")
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
    ), { timeout });
  }, { id: terminalId, ...expected, timeout: WAIT_TIMEOUT_MS });
}

async function waitForConnectingUrl(
  page: Page,
  terminalId: string,
  generation: number,
  expected: { cols: number; rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation: previousGeneration, cols, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration > previousGeneration
      && snapshot.urlViewport?.cols === cols
      && snapshot.urlViewport.rows === rows
      && snapshot.socketReadyState === WebSocket.CONNECTING
    ), { timeout });
  }, { id: terminalId, generation, ...expected, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRecovered(
  page: Page,
  terminalId: string,
  generation: number,
  expected: { cols: number; rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation: previousGeneration, cols, rows, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration > previousGeneration
      && snapshot.socketState === "connected"
      && snapshot.socketReadyState === WebSocket.OPEN
      && snapshot.serverViewport?.cols === cols
      && snapshot.serverViewport.rows === rows
      && snapshot.cols === cols
      && snapshot.rows === rows
      && snapshot.syncMode === undefined
      && snapshot.syncTarget === undefined
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
    ), { timeout });
  }, { id: terminalId, generation, ...expected, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForWrappedMarker(page: Page, terminalId: string, marker: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, marker: expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.xterm.text.replaceAll("\n", "").replaceAll("\r", "").includes(expected), { timeout });
  }, { id: terminalId, marker, timeout: WAIT_TIMEOUT_MS });
}

async function waitForExit(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
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
}

test("@nightly @O-11 @wrap @resize @recovery O-11 Delayed autowrap", async ({ page, baseURL, server, faultController }, testInfo) => {
  const runId = `w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-${Date.now()}`;
  const readyId = `O11-READY-${runId}`;
  const wrapId = `O11-WRAP-${runId}`;
  const sizeId = `O11-SIZE-${runId}`;
  const queryId = `O11-QUERY-${runId}`;
  const splitId = `O11-SPLIT-${runId}`;
  const printId = `O11-PRINT-${runId}`;
  const echoId = `O11-ECHO-${runId}`;
  const echoPayload = `input-O11-${runId}`;
  const rawBytes = Buffer.from("ABCDE", "ascii");
  const browserErrors = installBrowserErrorCollectors(page);
  let recordingActive = false;

  await page.setViewportSize(BROWSER_VIEWPORT);
  try {
    await page.goto(baseURL);
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
    await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const initial = await page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, (snapshot) => (
        snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.cols > 0
        && snapshot.rows > 0
        && snapshot.pixelWidth > 0
        && snapshot.pixelHeight > 0
        && snapshot.serverViewport !== undefined
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
      ), { timeout });
    }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
    const cellWidth = initial.pixelWidth / initial.cols;
    const cellHeight = initial.pixelHeight / initial.rows;
    expect(cellWidth).toBeGreaterThan(0);
    expect(cellHeight).toBeGreaterThan(0);

    const browserA = targetBrowserViewport(cellWidth, cellHeight, GRID_A);
    await page.setViewportSize(browserA);
    await pane.expectVisible();
    const atA = await expectTerminalConverged(page, terminalId, GRID_A, { timeout: WAIT_TIMEOUT_MS });
    expect(atA.serverViewport).toMatchObject({ cols: GRID_A.cols, rows: GRID_A.rows });
    expect(atA.desiredViewport).toMatchObject({ cols: GRID_A.cols, rows: GRID_A.rows });
    expect(atA.sentViewport).toMatchObject({ cols: GRID_A.cols, rows: GRID_A.rows });
    expect(atA.gridEpoch).toEqual(expect.any(Number));
    await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

    const transcriptBefore = await server.readTranscript(terminalId);
    const transcriptFloor = transcriptBefore.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
    const diagnosticFloor = (await terminalEvents(page, terminalId)).reduce((floor, event) => Math.max(floor, event.id), 0);
    const networkFloor = faultController.events.length;
    await recordingControl(page, "start");
    recordingActive = true;

    await pane.focus();
    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });

    await pane.sendInput(`WRAP ${wrapId} on`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "wrap" && entry.id === wrapId && entry.enabled === true, { timeoutMs: WAIT_TIMEOUT_MS });

    await pane.sendInput(`SIZE ${sizeId}`, true);
    const sizeEntry = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
    expect(sizeEntry.rows).toBe(GRID_A.rows);
    expect(sizeEntry.cols).toBe(GRID_A.cols);
    expect(sizeEntry.pixel_width).toBe(atA.pixelWidth);
    expect(sizeEntry.pixel_height).toBe(atA.pixelHeight);

    await pane.sendInput(`QUERY ${queryId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "query_complete" && entry.id === queryId && entry.replies === 6, { timeoutMs: WAIT_TIMEOUT_MS });

    const splitCommand = `UTF8_SPLIT ${splitId} ABCDE 1`;
    await pane.sendInput(splitCommand, true);
    const splitCommandEntry = await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "command"
      && entry.operation === "UTF8_SPLIT"
      && entry.command_base64 === base64(splitCommand)
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const firstRawWrite = await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "write"
      && transcriptSequence(entry) > transcriptSequence(splitCommandEntry)
      && entry.data_base64 === base64("A")
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const secondRawWrite = await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "write"
      && transcriptSequence(entry) > transcriptSequence(firstRawWrite)
      && entry.data_base64 === base64("BCDE")
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    expect(writeBytes(firstRawWrite)).toEqual(Buffer.from("A", "ascii"));
    expect(writeBytes(secondRawWrite)).toEqual(Buffer.from("BCDE", "ascii"));

    const beforeClose = await waitForMarginCursor(page, terminalId, GRID_A);
    expect(beforeClose.xterm.cursorX).toBe(GRID_A.cols);
    expect(beforeClose.xterm.cursorY).toBe(0);
    expect(beforeClose.xterm.text.includes("ABCDE")).toBe(true);

    const preCloseTranscript = await server.readTranscript(terminalId);
    const preCloseWrites = writeEntries(entriesAfter(preCloseTranscript, transcriptFloor));
    const preCloseRawCommand = preCloseTranscript.find((entry) => (
      entry.event === "command"
      && entry.operation === "UTF8_SPLIT"
      && transcriptSequence(entry) > transcriptFloor
    ));
    if (!preCloseRawCommand) throw new Error("UTF8_SPLIT command disappeared from the fixture transcript");
    const rawWrites = writeEntries(entriesAfter(preCloseTranscript, transcriptSequence(preCloseRawCommand)));
    expect(rawWrites).toHaveLength(2);
    expect(rawWrites.map(writeBytes)).toEqual([Buffer.from("A", "ascii"), Buffer.from("BCDE", "ascii")]);
    expect(Buffer.concat(rawWrites.map(writeBytes))).toEqual(rawBytes);

    const model = new Terminal({
      cols: GRID_A.cols,
      rows: GRID_A.rows,
      scrollback: 200_000,
      ...tuiCompatibilityOptions(),
    });
    for (const entry of preCloseWrites) await writeModel(model, writeBytes(entry));
    expect(activeText(model)).toBe(beforeClose.xterm.text);
    expect(model.buffer.active.cursorX).toBe(beforeClose.xterm.cursorX);
    expect(model.buffer.active.cursorY).toBe(beforeClose.xterm.cursorY);

    const delayedReconnect = faultController.delayUpgrade({ terminalId }, 5_000);
    const socketClosed = pane.waitForEvent("socket-close", { timeout: WAIT_TIMEOUT_MS });
    const terminated = faultController.waitFor(
      (event) => event.type === "terminated" && event.terminalId === terminalId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const terminateFault = faultController.terminate({ terminalId });
    await Promise.all([socketClosed, terminated]);
    terminateFault.dispose();

    const browserB = targetBrowserViewport(cellWidth, cellHeight, GRID_B);
    const reconnecting = waitForConnectingUrl(page, terminalId, atA.socketGeneration, GRID_B);
    const winchBPromise = server.waitForTranscript(terminalId, (entry) => (
      entry.event === "sigwinch"
      && entry.rows === GRID_B.rows
      && entry.cols === GRID_B.cols
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await page.setViewportSize(browserB);
    const connectingB = await reconnecting;
    expect(connectingB.urlViewport).toMatchObject({ cols: GRID_B.cols, rows: GRID_B.rows, source: "url" });
    const upgradeOpen = faultController.waitFor(
      (event) => event.type === "upgrade-open" && event.terminalId === terminalId && (event.generation ?? 0) > atA.socketGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    delayedReconnect.dispose();
    await upgradeOpen;

    const recovered = await waitForRecovered(page, terminalId, atA.socketGeneration, GRID_B);
    const winchB = await winchBPromise;
    expect(winchB.rows).toBe(GRID_B.rows);
    expect(winchB.cols).toBe(GRID_B.cols);
    expect(recovered.urlViewport).toMatchObject({ cols: GRID_B.cols, rows: GRID_B.rows, source: "url" });
    expect(recovered.serverViewport).toMatchObject({ cols: GRID_B.cols, rows: GRID_B.rows, source: "server" });
    expect(recovered.sentViewport).toMatchObject({ cols: GRID_B.cols, rows: GRID_B.rows, source: "sent" });
    expect(recovered.gridEpoch).toBeGreaterThan(atA.gridEpoch ?? -1);
    expect(recovered.activeSocketCount).toBe(1);
    expect(recovered.socket.activeCount).toBe(1);
    expect(recovered.syncMode).toBeUndefined();
    expect(recovered.syncTarget).toBeUndefined();
    expect(recovered.acceptingInput).toBe(true);

    model.resize(GRID_B.cols, GRID_B.rows);
    expect(recovered.xterm.text).toBe(activeText(model));
    expect(recovered.xterm.activeBuffer).toBe(model.buffer.active.type);
    expect(recovered.xterm.cursorX).toBe(model.buffer.active.cursorX);
    expect(recovered.xterm.cursorY).toBe(model.buffer.active.cursorY);
    expect(recovered.xterm.viewportY).toBe(model.buffer.active.viewportY);
    expect(recovered.xterm.selectionText).toBe("");
    const beforeContinuationPixels = await screenshotRegion(page, pane.xtermHost.locator(".xterm-screen"));
    await expectTerminalNonBlank(page, pane.xtermHost.locator(".xterm-screen"), {
      testInfo,
      artifactName: "o-11-before-continuation-crop",
    });

    const printMarker = `[E2E:PRINT:${printId}:X]`;
    const printFloorEntries = await server.readTranscript(terminalId);
    const printFloor = printFloorEntries.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
    await pane.sendInput(`PRINT ${printId} X`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === printId && entry.text === "X", { timeoutMs: WAIT_TIMEOUT_MS });
    const printSnapshot = await waitForWrappedMarker(page, terminalId, printMarker);
    expect(countWrappedOccurrences(printSnapshot.xterm.text, printMarker)).toBe(1);
    const printTranscript = await server.readTranscript(terminalId);
    const printWrites = writeEntries(entriesAfter(printTranscript, printFloor));
    expect(printWrites).toHaveLength(1);
    expect(writeBytes(printWrites[0]!)).toEqual(Buffer.from(`${printMarker}\n`, "utf8"));
    for (const entry of printWrites) await writeModel(model, writeBytes(entry));
    const firstLineWithContinuation = activeText(model).split("\n").find((line) => line.startsWith("ABCDEX"));
    expect(firstLineWithContinuation).toBeDefined();
    expect(firstLineWithContinuation?.slice(0, 6)).toBe("ABCDEX");
    const echoStartFloor = printTranscript.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    const echoReadyMarker = `[E2E:ECHO_INPUT:${echoId}:READY]`;
    await waitForWrappedMarker(page, terminalId, echoReadyMarker);
    await pane.sendInput(echoPayload, true);
    const echoEntry = await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
    expect(echoEntry.payload_base64).toBe(base64(echoPayload));
    const echoPayloadMarker = `[E2E:ECHO_INPUT:${echoId}:${base64(echoPayload)}]`;
    const finalBeforeExit = await waitForWrappedMarker(page, terminalId, echoPayloadMarker);
    expect(countWrappedOccurrences(finalBeforeExit.xterm.text, echoPayloadMarker)).toBe(1);
    const finalTranscript = await server.readTranscript(terminalId);
    const echoWrites = writeEntries(entriesAfter(finalTranscript, echoStartFloor));
    expect(echoWrites).toHaveLength(2);
    expect(writeBytes(echoWrites[0]!)).toEqual(Buffer.from(`${echoReadyMarker}\n`, "utf8"));
    expect(writeBytes(echoWrites[1]!)).toEqual(Buffer.from(`${echoPayloadMarker}\n`, "utf8"));
    for (const entry of echoWrites) await writeModel(model, writeBytes(entry));

    const final = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(final.xterm.text).toBe(activeText(model));
    expect(final.xterm.activeBuffer).toBe(model.buffer.active.type);
    expect(final.xterm.cursorX).toBe(model.buffer.active.cursorX);
    expect(final.xterm.cursorY).toBe(model.buffer.active.cursorY);
    expect(final.xterm.viewportY).toBe(model.buffer.active.viewportY);
    expect(final.xterm.selectionText).toBe("");
    expect(countWrappedOccurrences(final.xterm.text, rawBytes.toString("ascii"))).toBe(1);
    expect(countWrappedOccurrences(final.xterm.text, printMarker)).toBe(1);
    expect(countWrappedOccurrences(final.xterm.text, echoReadyMarker)).toBe(1);
    expect(countWrappedOccurrences(final.xterm.text, echoPayloadMarker)).toBe(1);
    expect(final.xterm.text.split("\n").some((line) => line.startsWith("ABCDEX") && line.slice(0, 6) === "ABCDEX")).toBe(true);
    expect(final.cols).toBe(GRID_B.cols);
    expect(final.rows).toBe(GRID_B.rows);
    expect(final.serverViewport).toMatchObject({ cols: GRID_B.cols, rows: GRID_B.rows });
    expect(final.socketGeneration).toBeGreaterThan(atA.socketGeneration);
    expect(final.activeSocketCount).toBe(1);
    expect(final.socket.activeCount).toBe(1);
    expect(final.acceptingInput).toBe(true);
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

    const { after: afterPixels } = await expectKnownMarkerChanged(page, pane.xtermHost.locator(".xterm-screen"), beforeContinuationPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-11-continuation-crop",
    });
    expect(afterPixels.width).toBe(beforeContinuationPixels.width);
    expect(afterPixels.height).toBe(beforeContinuationPixels.height);
    await expectTerminalNonBlank(page, pane.xtermHost.locator(".xterm-screen"), {
      testInfo,
      artifactName: "o-11-final-crop",
    });

    const scenarioEntries = entriesAfter(finalTranscript, transcriptFloor);
    expect(scenarioEntries.filter((entry) => entry.event === "error")).toEqual([]);
    expect(scenarioEntries.filter((entry) => entry.event === "query_reply" && entry.id === queryId)).toHaveLength(6);
    expect(scenarioEntries.filter((entry) => entry.event === "query_complete" && entry.id === queryId)).toHaveLength(1);
    const commandOperations = scenarioEntries
      .filter((entry) => entry.event === "command")
      .map((entry) => typeof entry.operation === "string" ? entry.operation : undefined);
    expect(commandOperations).toEqual(["READY", "WRAP", "SIZE", "QUERY", "UTF8_SPLIT", "PRINT", "ECHO_INPUT", "ECHO_INPUT"]);
    const sigwinches = scenarioEntries.filter((entry) => entry.event === "sigwinch" && entry.cols === GRID_B.cols && entry.rows === GRID_B.rows);
    expect(sigwinches.length).toBeGreaterThan(0);

    const expectedFixtureBytes = Buffer.concat(writeEntries(scenarioEntries).map(writeBytes));
    await recordingControl(page, "stop");
    recordingActive = false;
    const recording = await recordingExport(page);
    expect(recording.truncated).toBe(false);
    const outputRecords = recording.events.filter((event): event is RecordingEvent & { readonly sequence: number; readonly data: string } => (
      event.terminal === terminalId
      && event.type === "output"
      && typeof event.sequence === "number"
      && typeof event.data === "string"
    ));
    expect(outputRecords.length).toBeGreaterThan(0);
    let outputSequence = atA.receivedSequence ?? 0;
    const recordedChunks: Buffer[] = [];
    for (const record of outputRecords) {
      expect(record.sequence).toBe(outputSequence);
      const bytes = Buffer.from(record.data, "base64");
      recordedChunks.push(bytes);
      outputSequence += bytes.length;
    }
    expect(outputSequence).toBe(final.receivedSequence);
    expect(Buffer.concat(recordedChunks)).toEqual(expectedFixtureBytes);
    const snapshots = recording.events.filter((event) => event.terminal === terminalId && event.type === "snapshot" && typeof event.sequence === "number" && typeof event.data === "string");
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.some((event) => event.sequence === beforeClose.receivedSequence)).toBe(true);
    expect(snapshots.some((event) => Buffer.from(event.data!, "base64").includes(rawBytes))).toBe(true);
    const resizeEvents = recording.events.filter((event) => event.terminal === terminalId && event.type === "resize" && event.cols === GRID_B.cols && event.rows === GRID_B.rows);
    expect(resizeEvents.length).toBeGreaterThan(0);
    const syncSnapshotControls = recording.events.filter((event) => (
      event.terminal === terminalId
      && event.type === "control"
      && event.message?.type === "sync"
      && event.message.mode === "snapshot"
    ));
    expect(syncSnapshotControls.length).toBeGreaterThan(0);

    const finalEvents = await terminalEvents(page, terminalId);
    await assertMonotonicSequences(finalEvents);
    expect(finalEvents.slice(diagnosticFloor).filter((event) => event.type === "error")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "socket-stale")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "state" && ["recovering", "disconnected"].includes(String(event.data.state))).length).toBeGreaterThan(0);
    expect(finalEvents.filter((event) => event.type === "socket-open").length).toBeGreaterThanOrEqual(2);
    expect(finalEvents.filter((event) => event.type === "synced").length).toBeGreaterThanOrEqual(2);
    const proxyEvents = faultController.events.slice(networkFloor);
    expect(proxyEvents.filter((event) => event.type === "terminated")).toHaveLength(1);
    expect(proxyEvents.filter((event) => ["malformed-frame", "injected", "paused", "throttled", "dropped"].includes(event.type))).toEqual([]);

    await pane.sendInput("EXIT 0", true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "exit_requested" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    const exited = await waitForExit(page, terminalId);
    expect(exited.exitCode).toBe(0);
    expect(exited.activeSocketCount).toBe(0);
    expect(exited.socket.activeCount).toBe(0);
    expect(exited.acceptingInput).toBe(false);
    const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
    expect(invariantReport.snapshot.socketState).toBe("exited");
    expect(invariantReport.snapshot.activeSocketCount).toBe(0);
    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || (entry.kind === "console" && /^error:/i.test(entry.message))
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  } finally {
    if (recordingActive) await recordingControl(page, "stop");
    browserErrors.dispose();
  }
});
