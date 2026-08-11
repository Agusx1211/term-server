import { Buffer } from "node:buffer";
import { Terminal } from "../fixtures/headless-terminal.js"
import type { Page } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
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

const WAIT_TIMEOUT_MS = 60_000;
const BROWSER_VIEWPORT = { width: 1_280, height: 720 } as const;
const PRINT_COUNT = 128;
const HOLD_TOKEN = "O01";
const INITIAL_COMMANDS = 2;
const PREFIX_COMMANDS = INITIAL_COMMANDS + PRINT_COUNT + 1;

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function marker(operation: string, ...fields: readonly string[]): Buffer {
  return Buffer.from(`[E2E:${operation}${fields.map((field) => `:${field}`).join("")}]\n`, "utf8");
}

function printIds(): string[] {
  return Array.from({ length: PRINT_COUNT }, (_, index) => `O01-${String(index).padStart(4, "0")}`);
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

function outputBytes(event: OutputEvent): Buffer {
  return Buffer.from(event.data, "base64");
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

function assertNumberedLines(text: string, ids: readonly string[]): void {
  let previous = -1;
  for (const id of ids) {
    const line = `[E2E:PRINT:${id}:${id}]`;
    expect(countOccurrences(text, line), `line ${id} must occur exactly once`).toBe(1);
    const position = text.indexOf(line);
    expect(position, `line ${id} is missing`).toBeGreaterThan(previous);
    previous = position;
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

async function waitForOutputEnd(
  page: Page,
  terminalId: string,
  expectedEnd: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, end, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.receivedSequence !== undefined
      && snapshot.receivedSequence >= end
    ), { timeout });
  }, { id: terminalId, end: expectedEnd, timeout: WAIT_TIMEOUT_MS });
}

async function waitForWriteCount(
  server: IsolatedServer,
  terminalId: string,
  transcriptFloor: number,
  count: number,
): Promise<void> {
  await server.waitForTranscript(
    terminalId,
    (entry, entries) => writeEntries(entriesAfter(entries, transcriptFloor)).length >= count,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
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

async function waitForSettledConnected(
  page: Page,
  terminalId: string,
  baseline: E2ETerminalSnapshot,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && snapshot.serverViewport?.cols === expected.cols
      && snapshot.serverViewport?.rows === expected.rows
      && snapshot.serverViewport?.pixelWidth === expected.pixelWidth
      && snapshot.serverViewport?.pixelHeight === expected.pixelHeight
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
    ), { timeout });
  }, {
    id: terminalId,
    expected: {
      cols: baseline.cols,
      rows: baseline.rows,
      pixelWidth: baseline.pixelWidth,
      pixelHeight: baseline.pixelHeight,
    },
    timeout: WAIT_TIMEOUT_MS,
    acknowledgementLimit: TERMINAL_ACK_BYTES,
  });
}


test("@nightly @O-01 @output @transcript O-01 Exact ordinary transcript", async ({ page, baseURL, server, faultController }, testInfo) => {
  await page.setViewportSize(BROWSER_VIEWPORT);
  const browserErrors = installBrowserErrorCollectors(page);
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
    await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

    const baseline = await page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, (snapshot) => (
        snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && snapshot.serverViewport !== undefined
        && snapshot.serverViewport.pixelWidth > 0
        && snapshot.serverViewport.pixelHeight > 0
      ), { timeout });
    }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
    if (!baseline.serverViewport) throw new Error("initial terminal server viewport was not reported");
    expect(baseline.serverViewport).toMatchObject({
      cols: baseline.cols,
      rows: baseline.rows,
      pixelWidth: baseline.pixelWidth,
      pixelHeight: baseline.pixelHeight,
    });
    expect(baseline.viewport).toEqual(baseline.serverViewport);

    const beforePixels = await screenshotRegion(page, pane.xtermHost.locator(".xterm-screen"));
    const transcriptBefore = await server.readTranscript(terminalId);
    const transcriptFloor = transcriptBefore.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
    const diagnosticBefore = await terminalEvents(page, terminalId);
    const diagnosticFloor = diagnosticBefore.reduce((floor, event) => Math.max(floor, event.id), 0);
    const networkFloor = faultController.events.length;
    const baselineReceived = baseline.receivedSequence ?? 0;
    const ids = printIds();

    await recordingControl(page, "start");
    await pane.focus();
    await pane.sendInput("READY O01", true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === "O01", { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`HOLD ${HOLD_TOKEN}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === HOLD_TOKEN, { timeoutMs: WAIT_TIMEOUT_MS });

    for (const id of ids) await pane.sendInput(`PRINT ${id} ${id}`, true);

    await pane.sendInput(`RELEASE ${HOLD_TOKEN}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === HOLD_TOKEN, { timeoutMs: WAIT_TIMEOUT_MS });
    await waitForWriteCount(server, terminalId, transcriptFloor, PREFIX_COMMANDS);
    const prefixTranscript = await server.readTranscript(terminalId);
    const prefixWrites = writeEntries(entriesAfter(prefixTranscript, transcriptFloor));
    const prefixBytes = Buffer.concat(prefixWrites.map(writeBytes));
    await waitForOutputEnd(page, terminalId, baselineReceived + prefixBytes.length);

    await pane.sendInput("SIZE O01", true);
    const sizeEntry = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === "O01", { timeoutMs: WAIT_TIMEOUT_MS });
    expect(sizeEntry.rows).toBe(baseline.rows);
    expect(sizeEntry.cols).toBe(baseline.cols);
    expect(sizeEntry.pixel_width).toBe(baseline.pixelWidth);
    expect(sizeEntry.pixel_height).toBe(baseline.pixelHeight);

    const inputMarker = `O01-IN-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
    await pane.sendInput("ECHO_INPUT O01", true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === "O01" && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(inputMarker, true);
    const inputPayload = await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "echo_input" && entry.id === "O01" && entry.phase === "payload"
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    expect(inputPayload.payload_base64).toBe(base64(inputMarker));

    await waitForWriteCount(server, terminalId, transcriptFloor, PREFIX_COMMANDS + 3);
    const transcript = await server.readTranscript(terminalId);
    const scenarioEntries = entriesAfter(transcript, transcriptFloor);
    const writes = writeEntries(scenarioEntries);
    expect(writes).toHaveLength(PREFIX_COMMANDS + 3);
    expect(writes.every((entry) => transcriptNumber(entry, "write_sequence") !== undefined)).toBe(true);
    expect(writes.map((entry) => transcriptNumber(entry, "write_sequence"))).toEqual(
      writes.map((_, index) => index + 1),
    );

    const printWrites = writes.filter((entry) => {
      const text = transcriptString(entry, "text");
      return text?.startsWith("[E2E:PRINT:") === true;
    });
    expect(printWrites).toHaveLength(PRINT_COUNT);
    expect(printWrites.map(writeBytes)).toEqual(ids.map((id) => marker("PRINT", id, id)));
    expect(Buffer.concat(printWrites.map(writeBytes))).toEqual(
      Buffer.concat(ids.map((id) => marker("PRINT", id, id))),
    );

    const expectedNonPrintWrites = [
      marker("READY", "O01"),
      marker("HOLD", HOLD_TOKEN),
      marker("RELEASE", HOLD_TOKEN),
      marker("SIZE", "O01", String(sizeEntry.rows), String(sizeEntry.cols)),
      marker("ECHO_INPUT", "O01", "READY"),
      marker("ECHO_INPUT", "O01", base64(inputMarker)),
    ];
    const nonPrintWrites = writes.filter((entry) => !transcriptString(entry, "text")?.startsWith("[E2E:PRINT:"));
    expect(nonPrintWrites).toHaveLength(expectedNonPrintWrites.length);
    const unmatched = [...nonPrintWrites.map(writeBytes)];
    for (const expected of expectedNonPrintWrites) {
      const index = unmatched.findIndex((actual) => actual.equals(expected));
      expect(index, `missing fixture write ${expected.toString("utf8")}`).toBeGreaterThanOrEqual(0);
      unmatched.splice(index, 1);
    }
    expect(unmatched).toEqual([]);

    const finalWriteBytes = Buffer.concat(writes.map(writeBytes));
    await waitForOutputEnd(page, terminalId, baselineReceived + finalWriteBytes.length);

    const finalEvents = await terminalEvents(page, terminalId);
    const outputReceived = finalEvents.filter((event) => event.id > diagnosticFloor && event.type === "output-received");
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
    expect(receivedBytes).toBe(finalWriteBytes.length);
    expect(receivedEnd).toBe(baselineReceived + finalWriteBytes.length);

    const recording = await (async () => {
      await recordingControl(page, "stop");
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
      const bytes = outputBytes(record);
      recordedChunks.push(bytes);
      recordedSequence += bytes.length;
    }
    expect(recordedSequence).toBe(baselineReceived + finalWriteBytes.length);
    expect(Buffer.concat(recordedChunks)).toEqual(finalWriteBytes);

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
    expect(frameBytes).toBe(finalWriteBytes.length);
    expect(frameSequence).toBe(baselineReceived + finalWriteBytes.length);

    const model = new Terminal({
      cols: baseline.cols,
      rows: baseline.rows,
      scrollback: 200_000,
      ...tuiCompatibilityOptions(),
    });
    for (const chunk of recordedChunks) await writeModel(model, chunk);
    const modelText = activeText(model);
    const settled = await waitForSettledConnected(page, terminalId, baseline);
    expect(settled.xterm.text).toBe(modelText);
    expect(settled.xterm.activeBuffer).toBe(model.buffer.active.type);
    expect(settled.xterm.cursorX).toBe(model.buffer.active.cursorX);
    expect(settled.xterm.cursorY).toBe(model.buffer.active.cursorY);
    expect(settled.xterm.viewportY).toBe(model.buffer.active.viewportY);
    assertNumberedLines(settled.xterm.text, ids);
    assertNumberedLines(modelText, ids);

    expect(settled.cols).toBe(baseline.cols);
    expect(settled.rows).toBe(baseline.rows);
    expect(settled.pixelWidth).toBe(baseline.pixelWidth);
    expect(settled.pixelHeight).toBe(baseline.pixelHeight);
    expect(settled.serverViewport).toEqual(baseline.serverViewport);
    expect(settled.gridEpoch).toBe(baseline.gridEpoch);
    expect(settled.activeSocketCount).toBe(1);
    expect(settled.socket.activeCount).toBe(1);
    expect(settled.socketGeneration).toBe(baseline.socketGeneration);
    expect(settled.acceptingInput).toBe(true);
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

    const printEvents = scenarioEntries.filter((entry) => entry.event === "print");
    expect(printEvents).toHaveLength(PRINT_COUNT);
    expect(printEvents.map((entry) => entry.id)).toEqual(ids);
    expect(printEvents.map((entry) => entry.text)).toEqual(ids);
    const printCommands = scenarioEntries.filter((entry) => entry.event === "command" && entry.operation === "PRINT");
    expect(printCommands).toHaveLength(PRINT_COUNT);
    expect(printCommands.map((entry) => entry.command_base64)).toEqual(
      ids.map((id) => base64(`PRINT ${id} ${id}`)),
    );

    const sigwinches = scenarioEntries.filter((entry) => entry.event === "sigwinch");
    expect(sigwinches.length).toBeGreaterThan(0);
    const lastWinch = sigwinches.at(-1);
    expect(lastWinch?.rows).toBe(baseline.rows);
    expect(lastWinch?.cols).toBe(baseline.cols);
    expect(scenarioEntries.filter((entry) => entry.event === "error")).toEqual([]);
    expect(scenarioEntries.filter((entry) => entry.event === "echo_input" && entry.phase === "payload")).toHaveLength(1);

    const { after: afterPixels } = await expectKnownMarkerChanged(page, pane.xtermHost.locator(".xterm-screen"), beforePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-01-output-marker-crop",
    });
    expect(afterPixels.width).toBe(beforePixels.width);
    expect(afterPixels.height).toBe(beforePixels.height);
    await expectTerminalNonBlank(page, pane.xtermHost.locator(".xterm-screen"), {
      testInfo,
      artifactName: "o-01-nonblank-crop",
    });

    await assertMonotonicSequences(finalEvents);
    expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "socket-close" || event.type === "socket-stale")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "state" && ["recovering", "disconnected"].includes(String(event.data.state)))).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "sync")).toHaveLength(1);
    const proxyEvents = faultController.events.slice(networkFloor);
    expect(proxyEvents.filter((event) => ["malformed-frame", "injected", "paused", "throttled", "dropped"].includes(event.type))).toEqual([]);

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
    browserErrors.dispose();
  }
});
