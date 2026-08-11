import { Buffer } from "node:buffer";
import { Terminal } from "../fixtures/headless-terminal.js"
import type { Page } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import type { NetworkFaultEvent, NetworkFaultController } from "../fixtures/network-faults.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConnected,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
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
  readonly frame: NonNullable<NetworkFaultEvent["frame"]> & {
    readonly binaryKind: number;
    readonly sequence: number;
    readonly bytes: number;
    readonly fin: boolean;
  };
};

type EscapeVector = {
  readonly name: string;
  readonly bytes: Buffer;
  readonly expectedBuffer: "normal" | "alternate";
};

const WAIT_TIMEOUT_MS = 30_000;

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function marker(operation: string, ...fields: readonly string[]): Buffer {
  return Buffer.from(`[E2E:${operation}${fields.map((field) => `:${field}`).join("")}]\n`, "utf8");
}

function markerText(operation: string, ...fields: readonly string[]): string {
  return marker(operation, ...fields).toString("utf8").trimEnd();
}

function fixtureEscapeSequence(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) {
    if (byte === 0x1b) encoded += "\\x1b";
    else if (byte === 0x07) encoded += "\\x07";
    else if (byte === 0x08) encoded += "\\x08";
    else if (byte === 0x09) encoded += "\\t";
    else if (byte === 0x0a) encoded += "\\n";
    else if (byte === 0x0d) encoded += "\\r";
    else if (byte === 0x5c) encoded += "\\\\";
    else encoded += String.fromCharCode(byte);
  }
  return encoded;
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

function writeSequence(entry: TranscriptEntry): number {
  return transcriptNumber(entry, "write_sequence") ?? 0;
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

function latestSequence(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((latest, entry) => Math.max(latest, transcriptSequence(entry)), 0);
}

function latestWriteSequence(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((latest, entry) => Math.max(latest, writeSequence(entry)), 0);
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

async function waitForMarkerSettled(
  page: Page,
  terminalId: string,
  text: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, markerText: expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.xterm.text.includes(expected)
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.syncMode === undefined
    ), { timeout });
  }, { id: terminalId, markerText: text, timeout: WAIT_TIMEOUT_MS });
}

async function sendCommand(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  command: string,
  operation: string,
): Promise<TranscriptEntry> {
  const floor = latestSequence(await server.readTranscript(terminalId));
  const wait = server.waitForTranscript(
    terminalId,
    (entry) => (
      transcriptSequence(entry) > floor
      && entry.event === "command"
      && entry.operation === operation
      && transcriptString(entry, "command_base64") === base64(command)
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(command, true);
  return wait;
}

async function sendHold(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  token: string,
): Promise<number> {
  await sendCommand(pane, server, terminalId, `HOLD ${token}`, "HOLD");
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "hold" && entry.token === token,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await waitForMarkerSettled(page, terminalId, markerText("HOLD", token));
  return latestWriteSequence(await server.readTranscript(terminalId));
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

function assertWriteMultiset(actual: readonly Buffer[], expected: readonly Buffer[]): void {
  expect(actual).toHaveLength(expected.length);
  const unmatched = actual.map((bytes) => Buffer.from(bytes));
  for (const expectedBytes of expected) {
    const index = unmatched.findIndex((bytes) => bytes.equals(expectedBytes));
    expect(index, `missing fixture write ${expectedBytes.toString("hex")}`).toBeGreaterThanOrEqual(0);
    unmatched.splice(index, 1);
  }
  expect(unmatched).toEqual([]);
}

async function sendEscapeSplit(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  terminalId: string,
  vector: EscapeVector,
  split: number,
  token: string,
): Promise<E2ETerminalSnapshot> {
  const id = `${vector.name}-${split}`;
  const sequenceText = fixtureEscapeSequence(vector.bytes);
  const command = `ESCAPE_SPLIT ${id} ${sequenceText} ${split}`;
  const escapeMarker = marker("ESCAPE_SPLIT", id);
  const releaseMarker = marker("RELEASE", token);
  const holdWriteSequence = await sendHold(page, pane, server, terminalId, token);

  const pauseRule = faultController.pause("server-to-browser", { terminalId, binaryKind: 1 });
  try {
    const pausePromise = faultController.waitFor(
      (event) => (
        event.type === "paused"
        && event.terminalId === terminalId
        && event.direction === "server-to-browser"
        && event.ruleId === pauseRule.id
      ),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await sendCommand(pane, server, terminalId, command, "ESCAPE_SPLIT");
    const splitEntry = await server.waitForTranscript(
      terminalId,
      (entry) => (
        entry.event === "escape_split"
        && entry.id === id
        && entry.split === split
        && entry.bytes === vector.bytes.length
        && entry.sequence_base64 === base64(vector.bytes)
      ),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(splitEntry.id).toBe(id);

    await sendCommand(pane, server, terminalId, `RELEASE ${token}`, "RELEASE");
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "release" && entry.token === token,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const paused = await pausePromise;
    expect(paused.frame?.binaryKind).toBe(1);
    const pausedSnapshot = await pane.snapshot();
    if (!pausedSnapshot) throw new Error(`No diagnostics snapshot while ${id} was paused`);
    expect(pausedSnapshot.xterm.text).not.toContain(escapeMarker.toString("utf8").trimEnd());

    const resumeFloor = faultController.events.length;
    faultController.resume("server-to-browser", { terminalId, binaryKind: 1 });
    const resumed = faultController.events.slice(resumeFloor).filter((event) => (
      event.type === "resumed"
      && event.terminalId === terminalId
      && event.direction === "server-to-browser"
    ));
    expect(resumed).toHaveLength(1);

    const settled = await waitForMarkerSettled(page, terminalId, escapeMarker.toString("utf8").trimEnd());
    expect(settled.xterm.text).toContain(escapeMarker.toString("utf8").trimEnd());
    expect(countOccurrences(settled.xterm.text, escapeMarker.toString("utf8").trimEnd())).toBe(1);

    const afterEntries = await server.readTranscript(terminalId);
    const operationWrites = writeEntries(afterEntries)
      .filter((entry) => writeSequence(entry) > holdWriteSequence)
      .map(writeBytes);
    assertWriteMultiset(operationWrites, [
      vector.bytes.subarray(0, split),
      vector.bytes.subarray(split),
      escapeMarker,
      releaseMarker,
    ]);
    return settled;
  } finally {
    faultController.resume("server-to-browser", { terminalId, binaryKind: 1 });
    pauseRule.dispose();
  }
}

function eventSequence(event: E2ETerminalEvent): number | undefined {
  const value = event.data.sequence;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function eventBytes(event: E2ETerminalEvent): number | undefined {
  const value = event.data.bytes;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

test("@nightly @O-03 @vt @fragmentation @modes O-03 Fragmented escape sequences", async ({ page, baseURL, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let recordingActive = false;
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
    await pane.focus();

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

    const terminalScreen = pane.xtermHost.locator(".xterm-screen");
    await expect(terminalScreen).toBeVisible();
    const beforePixels = await screenshotRegion(page, terminalScreen);
    const transcriptBefore = await server.readTranscript(terminalId);
    const transcriptFloor = latestSequence(transcriptBefore);
    const initialWriteSequence = latestWriteSequence(transcriptBefore);
    const diagnosticsBefore = await terminalEvents(page, terminalId);
    const diagnosticsFloor = diagnosticsBefore.reduce((floor, event) => Math.max(floor, event.id), 0);
    const networkFloor = faultController.events.length;
    const baselineReceived = baseline.receivedSequence ?? 0;

    const runTag = `O03-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-e${testInfo.repeatEachIndex}-${Date.now()}`
      .replace(/[^A-Za-z0-9_-]+/g, "-");
    const readyId = `${runTag}-READY`;
    const finalId = `${runTag}-FINAL`;
    const finalText = `${runTag}-FINAL-MARKER`;
    const echoId = `${runTag}-ECHO`;
    const echoPayload = `${runTag}-INPUT-PAYLOAD`;

    const vectors: readonly EscapeVector[] = [
      { name: `${runTag}-CSI`, bytes: Buffer.from("\u001b[2;5r"), expectedBuffer: "normal" },
      { name: `${runTag}-OSC-BEL`, bytes: Buffer.from("\u001b]0;O03\u0007"), expectedBuffer: "normal" },
      { name: `${runTag}-OSC-ST`, bytes: Buffer.from("\u001b]0;O03\u001b\\"), expectedBuffer: "normal" },
      { name: `${runTag}-DCS`, bytes: Buffer.from("\u001bP1;2|O03\u001b\\"), expectedBuffer: "normal" },
      { name: `${runTag}-KITTY`, bytes: Buffer.from("\u001b[=1u"), expectedBuffer: "normal" },
      { name: `${runTag}-SYNC-ON`, bytes: Buffer.from("\u001b[?2026h"), expectedBuffer: "normal" },
      { name: `${runTag}-SYNC-OFF`, bytes: Buffer.from("\u001b[?2026l"), expectedBuffer: "normal" },
      { name: `${runTag}-ALT-ENTER`, bytes: Buffer.from("\u001b[?1049h"), expectedBuffer: "alternate" },
      { name: `${runTag}-ALT-EXIT`, bytes: Buffer.from("\u001b[?1049l"), expectedBuffer: "normal" },
    ];

    await recordingControl(page, "start");
    recordingActive = true;
    await sendCommand(pane, server, terminalId, `READY ${readyId}`, "READY");
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "ready" && entry.id === readyId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await waitForMarkerSettled(page, terminalId, markerText("READY", readyId));

    const splitMarkers: string[] = [];
    for (const [vectorIndex, vector] of vectors.entries()) {
      for (let split = 1; split < vector.bytes.length; split += 1) {
        const id = `${vector.name}-${split}`;
        const holdToken = `${runTag}-HOLD-${vectorIndex}-${split}`;
        const snapshot = await sendEscapeSplit(page, pane, server, faultController, terminalId, vector, split, holdToken);
        expect(snapshot.xterm.activeBuffer).toBe(vector.expectedBuffer);
        expect(snapshot.activeBuffer).toBe(vector.expectedBuffer);
        const splitMarker = markerText("ESCAPE_SPLIT", id);
        splitMarkers.push(splitMarker);
        expect(snapshot.xterm.text).toContain(splitMarker);
        expect(countOccurrences(snapshot.xterm.text, splitMarker)).toBe(1);
      }
    }

    const finalMarker = markerText("PRINT", finalId, finalText);
    await sendCommand(pane, server, terminalId, `PRINT ${finalId} ${finalText}`, "PRINT");
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await waitForMarkerSettled(page, terminalId, finalMarker);
    await expectTerminalBuffer(page, terminalId, { contains: finalMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    await sendCommand(pane, server, terminalId, `ECHO_INPUT ${echoId}`, "ECHO_INPUT");
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await waitForMarkerSettled(page, terminalId, markerText("ECHO_INPUT", echoId, "READY"));
    await pane.sendInput(echoPayload, true);
    const echoEntry = await server.waitForTranscript(
      terminalId,
      (entry) => (
        entry.event === "echo_input"
        && entry.id === echoId
        && entry.phase === "payload"
        && entry.payload_base64 === base64(echoPayload)
      ),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(echoEntry.bytes).toBe(Buffer.byteLength(echoPayload, "utf8"));
    const echoMarker = markerText("ECHO_INPUT", echoId, base64(echoPayload));
    await waitForMarkerSettled(page, terminalId, echoMarker);

    await recordingControl(page, "stop");
    recordingActive = false;
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

    const transcript = await server.readTranscript(terminalId);
    const scenarioEntries = entriesAfter(transcript, transcriptFloor);
    const writes = writeEntries(scenarioEntries);
    const expectedOutput = Buffer.concat(writes.map(writeBytes));
    expect(Buffer.concat(recordedChunks)).toEqual(expectedOutput);
    expect(recordedSequence).toBe(baselineReceived + expectedOutput.length);
    expect(writes.map((entry) => writeSequence(entry))).toEqual(
      writes.map((_, index) => initialWriteSequence + index + 1),
    );

    const outputReceived = (await terminalEvents(page, terminalId)).filter((event) => (
      event.id > diagnosticsFloor && event.type === "output-received"
    ));
    let receivedEnd = baselineReceived;
    let receivedBytes = 0;
    for (const event of outputReceived) {
      const sequence = eventSequence(event);
      const bytes = eventBytes(event);
      if (sequence === undefined || bytes === undefined) throw new Error("output-received event omitted sequence or bytes");
      expect(sequence).toBe(receivedEnd + bytes);
      receivedEnd = sequence;
      receivedBytes += bytes;
      const commit = (await terminalEvents(page, terminalId)).find((candidate) => (
        candidate.id > event.id
        && candidate.type === "parser-commit"
        && eventSequence(candidate) === sequence
      ));
      expect(commit, `output sequence ${sequence} was not parser-committed`).toBeDefined();
      const overtakingControls = (await terminalEvents(page, terminalId)).filter((candidate) => (
        candidate.id > event.id
        && candidate.id < (commit?.id ?? Number.MAX_SAFE_INTEGER)
        && ["size", "sync", "synced", "exit"].includes(candidate.type)
      ));
      expect(overtakingControls).toEqual([]);
    }
    expect(receivedBytes).toBe(expectedOutput.length);
    expect(receivedEnd).toBe(baselineReceived + expectedOutput.length);

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
    expect(frameBytes).toBe(expectedOutput.length);
    expect(frameSequence).toBe(baselineReceived + expectedOutput.length);

    const model = new Terminal({
      cols: baseline.cols,
      rows: baseline.rows,
      scrollback: 20_000,
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
    expect(settled.xterm.selectionText).toBe("");
    expect(settled.activeBuffer).toBe("normal");
    for (const splitMarker of splitMarkers) {
      if (settled.xterm.activeBuffer === "normal") {
        expect(settled.xterm.text.includes(splitMarker) || splitMarker.includes(`${runTag}-ALT-ENTER`)).toBe(true);
      }
    }
    expect(settled.xterm.text).toContain(finalMarker);
    expect(countOccurrences(settled.xterm.text, finalMarker)).toBe(1);
    expect(settled.xterm.text).toContain(echoMarker);
    expect(countOccurrences(settled.xterm.text, echoMarker)).toBe(1);
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

    const expectedCommands = [
      `READY ${readyId}`,
      ...vectors.flatMap((vector, vectorIndex) => Array.from({ length: vector.bytes.length - 1 }, (_, splitIndex) => {
        const split = splitIndex + 1;
        const token = `${runTag}-HOLD-${vectorIndex}-${split}`;
        const id = `${vector.name}-${split}`;
        return [
          `HOLD ${token}`,
          `ESCAPE_SPLIT ${id} ${fixtureEscapeSequence(vector.bytes)} ${split}`,
          `RELEASE ${token}`,
        ];
      })).flat(),
      `PRINT ${finalId} ${finalText}`,
      `ECHO_INPUT ${echoId}`,
      echoPayload,
    ];
    const commandEntries = scenarioEntries.filter((entry) => entry.event === "command");
    expect(commandEntries.map((entry) => transcriptString(entry, "command_base64"))).toEqual(
      expectedCommands.map((command) => base64(command)),
    );
    expect(scenarioEntries.filter((entry) => entry.event === "error")).toEqual([]);
    expect(scenarioEntries.filter((entry) => entry.event === "escape_split")).toHaveLength(
      vectors.reduce((total, vector) => total + vector.bytes.length - 1, 0),
    );
    expect(scenarioEntries.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);

    const finalEvents = await terminalEvents(page, terminalId);
    await assertMonotonicSequences(finalEvents);
    expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "socket-close" || event.type === "socket-stale")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "state" && ["recovering", "disconnected"].includes(String(event.data.state)))).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "sync")).toHaveLength(1);

    const proxyEvents = faultController.events.slice(networkFloor);
    expect(proxyEvents.filter((event) => event.type === "paused")).toHaveLength(
      vectors.reduce((total, vector) => total + vector.bytes.length - 1, 0),
    );
    expect(proxyEvents.filter((event) => event.type === "resumed")).toHaveLength(
      vectors.reduce((total, vector) => total + vector.bytes.length - 1, 0),
    );
    expect(proxyEvents.filter((event) => ["malformed-frame", "injected", "dropped", "socket-error"].includes(event.type))).toEqual([]);

    const { after: afterPixels } = await expectKnownMarkerChanged(page, terminalScreen, beforePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-03-final-marker-crop",
    });
    expect(afterPixels.width).toBe(beforePixels.width);
    expect(afterPixels.height).toBe(beforePixels.height);
    await expectTerminalNonBlank(page, terminalScreen, {
      testInfo,
      artifactName: "o-03-final-terminal-crop",
    });

    await pane.sendInput("EXIT 0", true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "exit_requested" && entry.code === 0,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
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
      || entry.kind === "websocket"
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  } finally {
    if (recordingActive) await recordingControl(page, "stop");
    browserErrors.dispose();
  }
});
