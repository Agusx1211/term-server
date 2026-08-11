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
  expectTerminalBuffer,
} from "../assertions/terminal-state.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

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
  readonly generation: number;
  readonly frame: NonNullable<NetworkFaultEvent["frame"]> & {
    readonly binaryKind: number;
    readonly sequence: number;
    readonly bytes: number;
    readonly fin: boolean;
  };
};

const WAIT_TIMEOUT_MS = 60_000;
const BROWSER_VIEWPORT = { width: 1_280, height: 720 } as const;
const BURST_BYTES = 400_000;
const BURST_LINE_WIDTH = 80;
const INPUT_CHUNK_BYTES = 16 * 1024;
const PASTE_BYTES = 200 * 1024;
const FLOW_HIGH_WATERMARK_BYTES = 100_000;
const O13_ID = "O13";
const QUEUE_FULL_NOTICE = "terminal input queue is full; wait for the terminal to catch up";
const EXPECTED_WRITE_COUNT = 6;

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}


function fixtureMarker(operation: string, ...fields: readonly string[]): Buffer {
  return Buffer.from(`[E2E:${operation}${fields.map((field) => `:${field}`).join("")}]\n`, "utf8");
}

function burstBytes(bytes: number, lineWidth: number): Buffer {
  const output = Buffer.alloc(bytes);
  let offset = 0;
  let column = 0;
  let visible = 0;
  while (offset < bytes) {
    output[offset] = 0x41 + (visible % 26);
    offset += 1;
    visible += 1;
    column += 1;
    if (column === lineWidth && offset < bytes - 1) {
      output[offset] = 0x0a;
      offset += 1;
      column = 0;
    }
  }
  return output;
}

function pastePayload(): string {
  const prefix = "PASTE-O13-";
  const suffix = "-END";
  const fillBytes = PASTE_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const fill = alphabet.repeat(Math.ceil(fillBytes / alphabet.length)).slice(0, fillBytes);
  const payload = `${prefix}${fill}${suffix}`;
  expect(Buffer.byteLength(payload, "utf8")).toBe(PASTE_BYTES);
  return payload;
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

function writesAfter(entries: readonly TranscriptEntry[], floor: number): TranscriptEntry[] {
  return entries.filter((entry) => transcriptSequence(entry) > floor && entry.event === "write");
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

function compactText(value: string): string {
  return value.replace(/\r?\n/g, "");
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

async function setClipboard(page: Page, value: string): Promise<void> {
  await page.evaluate(async (text) => {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard write API is unavailable");
    await navigator.clipboard.writeText(text);
  }, value);
  const actual = await page.evaluate(async () => {
    if (!navigator.clipboard?.readText) throw new Error("Clipboard read API is unavailable");
    return navigator.clipboard.readText();
  });
  expect(actual).toBe(value);
}

async function waitForOutputPressure(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, threshold, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.flowControlled
      && snapshot.pendingParserWrites > 0
      && snapshot.pendingParserBytes >= threshold
      && snapshot.renderBacklogBytes >= threshold
    ), { timeout });
  }, { id: terminalId, threshold: FLOW_HIGH_WATERMARK_BYTES, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledConnected(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.syncMode === undefined
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

function terminalFramePayloadBytes(frameBytes: number): number {
  const webSocketHeaderBytes = frameBytes < 126 ? 2 : frameBytes < 65_536 ? 4 : 10;
  return frameBytes - webSocketHeaderBytes - 9;
}

function browserFramePayloadBytes(frameBytes: number): number {
  const webSocketHeaderBytes = frameBytes < 126 ? 6 : frameBytes < 65_536 ? 8 : 14;
  return frameBytes - webSocketHeaderBytes;
}

function outputFrames(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
): OutputFrame[] {
  return events.filter((event): event is OutputFrame => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "server-to-browser"
    && event.frame?.binaryKind === 1
    && event.frame.sequence !== undefined
    && event.frame.bytes !== undefined
    && event.frame.fin === true
  ));
}

function inputFrames(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
  floor: number,
): NetworkFaultEvent[] {
  return events.slice(floor).filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.opcode === 2
  ));
}


async function waitForExited(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
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

test("@nightly @O-13 @paste @flow @input O-13 Large paste during output", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  await page.setViewportSize(BROWSER_VIEWPORT);
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `O13-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const finalId = `${runTag}-FINAL`;
  const finalText = `${runTag}-FINAL-MARKER`;
  const continuedId = `${runTag}-CONTINUED`;
  const continuedText = `${runTag}-INPUT`;
  const payload = pastePayload();
  const payloadBase64 = base64(payload);
  const finalMarker = fixtureMarker("PRINT", finalId, finalText);
  const continuedMarker = fixtureMarker("ECHO_INPUT", continuedId, base64(continuedText));
  const beforeCommands = [
    `ECHO_INPUT ${O13_ID}`,
    `BURST ${O13_ID} ${BURST_BYTES} ${BURST_LINE_WIDTH}`,
    `PRINT ${finalId} ${finalText}`,
    `ECHO_INPUT ${continuedId}`,
  ];

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
    const baseline = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    if (!baseline.serverViewport) throw new Error("initial terminal server viewport was not reported");
    expect(baseline.serverViewport).toMatchObject({
      cols: baseline.cols,
      rows: baseline.rows,
      pixelWidth: baseline.pixelWidth,
      pixelHeight: baseline.pixelHeight,
    });
    expect(baseline.flowControlled).toBe(true);
    expect(baseline.activeSocketCount).toBe(1);
    expect(baseline.acceptingInput).toBe(true);

    const beforePixels = await screenshotRegion(page, pane.xtermHost.locator(".xterm-screen"));
    const transcriptBefore = await server.readTranscript(terminalId);
    const transcriptFloor = transcriptBefore.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
    const diagnosticsBefore = await terminalEvents(page, terminalId);
    const diagnosticsFloor = diagnosticsBefore.reduce((floor, event) => Math.max(floor, event.id), 0);
    const networkFloor = faultController.events.length;
    const baselineReceived = baseline.receivedSequence ?? 0;

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(baseURL).origin,
    });
    await recordingControl(page, "start");

    await pane.focus();
    await pane.sendInput(`ECHO_INPUT ${O13_ID}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === O13_ID && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:ECHO_INPUT:${O13_ID}:READY]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    await waitForSettledConnected(page, terminalId);

    await setClipboard(page, payload);
    await pane.focus();

    const connection = [...faultController.events].reverse().find((event) => (
      event.type === "connection-open"
      && event.terminalId === terminalId
      && typeof event.generation === "number"
    ));
    if (!connection || connection.generation === undefined) throw new Error("terminal has no proxy connection generation");
    const generation = connection.generation;
    const priorOutputFrames = faultController.events.filter((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "server-to-browser"
      && event.frame?.binaryKind === 1
    )).length;
    const priorAcknowledgements = faultController.events.filter((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "ack"
    )).length;
    const outputPauseMatcher = {
      terminalId,
      generation,
      binaryKind: 1,
      occurrence: priorOutputFrames + 3,
    } as const;
    const acknowledgementPauseMatcher = {
      terminalId,
      generation,
      jsonType: "ack",
      occurrence: priorAcknowledgements + 1,
    } as const;
    const outputPauseRule = faultController.pause("server-to-browser", outputPauseMatcher);
    const acknowledgementPauseRule = faultController.pause("browser-to-server", acknowledgementPauseMatcher);
    const outputPaused = faultController.waitFor((event) => (
      event.type === "paused"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "server-to-browser"
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const acknowledgementPaused = faultController.waitFor((event) => (
      event.type === "paused"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "browser-to-server"
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const pressurePromise = waitForOutputPressure(page, terminalId);

    try {
      await pane.sendInput(`BURST ${O13_ID} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
      await server.waitForTranscript(
        terminalId,
        (entry) => entry.event === "burst" && entry.id === O13_ID && entry.bytes === BURST_BYTES && entry.line_width === BURST_LINE_WIDTH,
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      await pane.openActions();
      const pasteItem = pane.root.getByRole("menuitem", { name: "Paste", exact: true });
      await expect(pasteItem).toBeVisible();
      const inputFrameFloor = faultController.events.length;
      const expectedPasteFrames = Math.ceil(Buffer.byteLength(payload, "utf8") / INPUT_CHUNK_BYTES);
      const pasteFramesPromise = faultController.waitFor((event) => (
        event.type === "frame"
        && inputFrames(faultController.events, terminalId, generation, inputFrameFloor).length >= expectedPasteFrames
      ), { timeoutMs: WAIT_TIMEOUT_MS });
      const [pressure, outputPauseEvent, acknowledgementPauseEvent] = await Promise.all([
        pressurePromise,
        outputPaused,
        acknowledgementPaused,
      ]);
      expect(pressure.flowControlled).toBe(true);
      expect(pressure.pendingParserWrites).toBeGreaterThan(0);
      expect(pressure.pendingParserBytes).toBeGreaterThanOrEqual(FLOW_HIGH_WATERMARK_BYTES);
      expect(pressure.renderBacklogBytes).toBeGreaterThanOrEqual(FLOW_HIGH_WATERMARK_BYTES);

      await pasteItem.click();
      await pasteFramesPromise;
      const pasteFrames = inputFrames(faultController.events, terminalId, generation, inputFrameFloor);
      expect(pasteFrames).toHaveLength(expectedPasteFrames);
      const pasteChunkSizes = pasteFrames.map((event) => {
        const bytes = event.frame?.bytes;
        expect(bytes).toBeDefined();
        expect(event.frame?.fin).toBe(true);
        expect(event.frame?.opcode).toBe(2);
        const payloadBytes = browserFramePayloadBytes(bytes!);
        expect(payloadBytes).toBeGreaterThan(0);
        expect(payloadBytes).toBeLessThanOrEqual(INPUT_CHUNK_BYTES);
        return payloadBytes;
      });
      const expectedChunkSizes = Array.from({ length: expectedPasteFrames }, (_, index) => (
        index === expectedPasteFrames - 1
          ? Buffer.byteLength(payload, "utf8") - index * INPUT_CHUNK_BYTES
          : INPUT_CHUNK_BYTES
      ));
      expect(pasteChunkSizes).toEqual(expectedChunkSizes);
      const firstPasteFrame = pasteFrames[0];
      expect(firstPasteFrame?.at).toBeGreaterThanOrEqual(acknowledgementPauseEvent.at);
      expect(firstPasteFrame?.at).toBeGreaterThanOrEqual(outputPauseEvent.at);

      const acknowledgementResumed = faultController.waitFor((event) => (
        event.type === "resumed"
        && event.terminalId === terminalId
        && event.generation === generation
        && event.direction === "browser-to-server"
      ), { timeoutMs: WAIT_TIMEOUT_MS });
      faultController.resume("browser-to-server", acknowledgementPauseMatcher);
      await acknowledgementResumed;
      acknowledgementPauseRule.dispose();

      const echoedPayload = await server.waitForTranscript(
        terminalId,
        (entry) => entry.event === "echo_input"
          && entry.id === O13_ID
          && entry.phase === "payload"
          && entry.bytes === PASTE_BYTES
          && entry.payload_base64 === payloadBase64,
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      expect(echoedPayload.payload_base64).toBe(payloadBase64);

      const outputResumed = faultController.waitFor((event) => (
        event.type === "resumed"
        && event.terminalId === terminalId
        && event.generation === generation
        && event.direction === "server-to-browser"
      ), { timeoutMs: WAIT_TIMEOUT_MS });
      faultController.resume("server-to-browser", outputPauseMatcher);
      await outputResumed;
      outputPauseRule.dispose();
    } finally {
      acknowledgementPauseRule.dispose();
      outputPauseRule.dispose();
    }

    const afterBurst = await waitForSettledConnected(page, terminalId);
    expect(afterBurst.flowControlled).toBe(true);
    expect(afterBurst.flowAcknowledgedBytes).toBeGreaterThan(0);
    expect(afterBurst.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);

    await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, terminalId, { contains: finalMarker.toString("utf8").trimEnd(), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    await pane.sendInput(`ECHO_INPUT ${continuedId}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === continuedId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(continuedText, true);
    const continuedPayload = await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input"
        && entry.id === continuedId
        && entry.phase === "payload"
        && entry.text === continuedText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(continuedPayload.text).toBe(continuedText);
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:ECHO_INPUT:${continuedId}:${continuedText}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const finalSettled = await waitForSettledConnected(page, terminalId);
    expect(finalSettled.serverViewport).toEqual(baseline.serverViewport);
    expect(finalSettled.gridEpoch).toBe(baseline.gridEpoch);
    expect(finalSettled.socketGeneration).toBe(baseline.socketGeneration);
    expect(finalSettled.receivedSequence).toBe(finalSettled.committedSequence);
    expect(finalSettled.activeSocketCount).toBe(1);
    expect(finalSettled.acceptingInput).toBe(true);
    expect(finalSettled.pendingParserWrites).toBe(0);
    expect(finalSettled.pendingParserBytes).toBe(0);
    expect(finalSettled.renderBacklogBytes).toBe(0);
    expect(finalSettled.renderBacklogFrames).toBe(0);
    expect(finalSettled.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(await page.getByText(QUEUE_FULL_NOTICE, { exact: true }).count()).toBe(0);

    await server.waitForTranscript(
      terminalId,
      (entry, entries) => writesAfter(entries, transcriptFloor).length >= EXPECTED_WRITE_COUNT
        && entry.event === "write",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const finalTranscript = await server.readTranscript(terminalId);
    const scenarioEntries = finalTranscript.filter((entry) => transcriptSequence(entry) > transcriptFloor);
    const writes = writesAfter(finalTranscript, transcriptFloor);
    expect(writes).toHaveLength(EXPECTED_WRITE_COUNT);
    const expectedWrites = [
      fixtureMarker("ECHO_INPUT", O13_ID, "READY"),
      burstBytes(BURST_BYTES, BURST_LINE_WIDTH),
      fixtureMarker("ECHO_INPUT", O13_ID, payloadBase64),
      finalMarker,
      fixtureMarker("ECHO_INPUT", continuedId, "READY"),
      fixtureMarker("ECHO_INPUT", continuedId, base64(continuedText)),
    ];
    expect(writes).toHaveLength(expectedWrites.length);
    expect(writes.map(writeBytes)).toEqual(expectedWrites);
    const writeSequences = writes.map((entry) => transcriptNumber(entry, "write_sequence"));
    expect(writeSequences.every((sequence) => sequence !== undefined)).toBe(true);
    for (let index = 1; index < writeSequences.length; index += 1) {
      expect(writeSequences[index]).toBe((writeSequences[index - 1] ?? 0) + 1);
    }
    expect(scenarioEntries.filter((entry) => entry.event === "error")).toEqual([]);
    expect(scenarioEntries.filter((entry) => entry.event === "echo_input" && entry.id === O13_ID && entry.phase === "payload")).toHaveLength(1);
    expect(scenarioEntries.filter((entry) => entry.event === "echo_input" && entry.id === continuedId && entry.phase === "payload")).toHaveLength(1);
    const payloadEntry = scenarioEntries.find((entry) => entry.event === "echo_input" && entry.id === O13_ID && entry.phase === "payload");
    expect(payloadEntry?.bytes).toBe(PASTE_BYTES);
    expect(payloadEntry?.payload_base64).toBe(payloadBase64);
    const commandEntries = scenarioEntries.filter((entry) => entry.event === "command");
    for (const command of beforeCommands) {
      expect(commandEntries.filter((entry) => entry.command_base64 === base64(command))).toHaveLength(1);
    }
    expect(commandEntries.filter((entry) => entry.operation === "ECHO_INPUT")).toHaveLength(3);

    await recordingControl(page, "stop");
    const recording = await recordingExport(page);
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
    const expectedOutputBytes = Buffer.concat(writes.map(writeBytes));
    expect(recordedSequence).toBe(baselineReceived + expectedOutputBytes.length);
    expect(Buffer.concat(recordedChunks)).toEqual(expectedOutputBytes);

    const frames = outputFrames(faultController.events.slice(networkFloor), terminalId, generation);
    expect(frames.length).toBeGreaterThan(0);
    let frameSequence = baselineReceived;
    let frameBytes = 0;
    for (const frame of frames) {
      expect(frame.frame.sequence).toBe(frameSequence);
      const payloadBytes = terminalFramePayloadBytes(frame.frame.bytes);
      expect(payloadBytes).toBeGreaterThan(0);
      frameBytes += payloadBytes;
      frameSequence += payloadBytes;
    }
    expect(frameBytes).toBe(expectedOutputBytes.length);
    expect(frameSequence).toBe(baselineReceived + expectedOutputBytes.length);

    const outputReceived = (await terminalEvents(page, terminalId)).filter((event) => (
      event.id > diagnosticsFloor && event.type === "output-received"
    ));
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
    expect(receivedBytes).toBe(expectedOutputBytes.length);
    expect(receivedEnd).toBe(baselineReceived + expectedOutputBytes.length);

    const model = new Terminal({
      cols: baseline.cols,
      rows: baseline.rows,
      scrollback: 200_000,
      ...tuiCompatibilityOptions(),
    });
    for (const chunk of recordedChunks) await writeModel(model, chunk);
    const modelText = activeText(model);
    expect(finalSettled.xterm.text).toBe(modelText);
    expect(finalSettled.xterm.activeBuffer).toBe(model.buffer.active.type);
    expect(finalSettled.xterm.cursorX).toBe(model.buffer.active.cursorX);
    expect(finalSettled.xterm.cursorY).toBe(model.buffer.active.cursorY);
    expect(finalSettled.xterm.viewportY).toBe(model.buffer.active.viewportY);
    const largeEchoMarker = `[E2E:ECHO_INPUT:${O13_ID}:${payloadBase64}]`;
    expect(countOccurrences(compactText(finalSettled.xterm.text), largeEchoMarker)).toBe(1);
    expect(countOccurrences(compactText(modelText), largeEchoMarker)).toBe(1);
    expect(compactText(finalSettled.xterm.text)).toContain(finalMarker.toString("utf8").trim());
    expect(compactText(finalSettled.xterm.text)).toContain(continuedMarker.toString("utf8").trim());

    const { after: afterPixels } = await expectKnownMarkerChanged(
      page,
      pane.xtermHost.locator(".xterm-screen"),
      beforePixels,
      {
        minimumChangedRatio: 0.002,
        testInfo,
        artifactName: "o-13-paste-flow-crop",
      },
    );
    expect(afterPixels.width).toBe(beforePixels.width);
    expect(afterPixels.height).toBe(beforePixels.height);
    await expectTerminalNonBlank(page, pane.xtermHost.locator(".xterm-screen"), {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "o-13-paste-flow-nonblank-crop",
    });

    const finalEvents = await terminalEvents(page, terminalId);
    await assertMonotonicSequences(finalEvents);
    expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "socket-close" || event.type === "socket-stale")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "state" && ["recovering", "disconnected"].includes(String(event.data.state)))).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "sync")).toHaveLength(1);

    const networkEvents = faultController.events.slice(networkFloor);
    expect(networkEvents.filter((event) => event.type === "paused")).toHaveLength(2);
    expect(networkEvents.filter((event) => event.type === "resumed")).toHaveLength(2);
    expect(networkEvents.filter((event) => ["malformed-frame", "injected", "dropped", "throttled"].includes(event.type))).toEqual([]);
    expect(networkEvents.filter((event) => event.type === "connection-open")).toHaveLength(1);

    await pane.sendInput("EXIT 0", true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "exit_requested" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    await server.waitForTranscript(terminalId, (entry) => entry.event === "exit" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    const exited = await waitForExited(page, terminalId);
    expect(exited.exitCode).toBe(0);
    expect(exited.activeSocketCount).toBe(0);
    expect(exited.acceptingInput).toBe(false);
    const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
    expect(invariantReport.snapshot.socketState).toBe("exited");
    expect(invariantReport.snapshot.activeSocketCount).toBe(0);

    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || (entry.kind === "console" && /^error:/i.test(entry.message))
      || entry.kind === "websocket"
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  } finally {
    browserErrors.dispose();
  }
});
