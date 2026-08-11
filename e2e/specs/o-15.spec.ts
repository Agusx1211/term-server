import { Buffer } from "node:buffer";
import { Terminal } from "../fixtures/headless-terminal.js"
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import type { NetworkFaultDisposer, NetworkFaultEvent } from "../fixtures/network-faults.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalConnected,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  expectConnectedTerminalInvariants,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 120_000;
const BURST_BYTES = 6_000_000;
const BURST_LINE_WIDTH = 80;
const B_SLOW_BYTES_PER_SECOND = 1_000_000;
const WIDE_GEOMETRY = { cols: 160, rows: 48 } as const;
const NARROW_GEOMETRY = { cols: 80, rows: 24 } as const;

// The pane is rendered beside the 270px sidebar, with the desktop 30px
// header, 22px status bar, and xterm's 9px/7px horizontal padding. The
// 915x421 dimensions are the existing exact 80x24 geometry; scaling the
// measured 13px-cell content width to 160 columns gives 1540x780 for 160x48.
const WIDE_BROWSER_VIEWPORT = { width: 1_540, height: 780 } as const;
const NARROW_BROWSER_VIEWPORT = { width: 915, height: 421 } as const;

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

type OutputRecord = RecordingEvent & {
  readonly type: "output";
  readonly sequence: number;
  readonly data: string;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly clients: number;
  readonly pid: number | null;
};

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function marker(operation: string, ...fields: readonly string[]): Buffer {
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

function entriesAfter(entries: readonly TranscriptEntry[], floor: number): TranscriptEntry[] {
  return entries.filter((entry) => transcriptSequence(entry) > floor);
}

function writeEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((entry) => entry.event === "write");
}

function writeBytes(entry: TranscriptEntry): Buffer {
  const encoded = transcriptString(entry, "data_base64");
  if (!encoded) throw new Error("fixture write omitted data_base64");
  return Buffer.from(encoded, "base64");
}

function outputRecords(recording: RecordingExport, terminalId: string): OutputRecord[] {
  return recording.events.filter((event): event is OutputRecord => (
    event.terminal === terminalId
      && event.type === "output"
      && typeof event.sequence === "number"
      && typeof event.data === "string"
  ));
}

function uniqueRecordedOutput(records: readonly OutputRecord[], expectedStart: number): Buffer[] {
  const bySequence = new Map<number, { bytes: Buffer; count: number }>();
  for (const record of records) {
    const bytes = Buffer.from(record.data, "base64");
    const existing = bySequence.get(record.sequence);
    if (existing) {
      expect(bytes).toEqual(existing.bytes);
      existing.count += 1;
    } else {
      bySequence.set(record.sequence, { bytes, count: 1 });
    }
  }
  const sorted = [...bySequence.entries()].sort(([left], [right]) => left - right);
  let sequence = expectedStart;
  const chunks: Buffer[] = [];
  for (const [recordSequence, record] of sorted) {
    expect(recordSequence).toBe(sequence);
    expect(record.count).toBe(2);
    expect(record.bytes.length).toBeGreaterThan(0);
    chunks.push(record.bytes);
    sequence += record.bytes.length;
  }
  return chunks;
}

function terminalFramePayloadBytes(frameBytes: number): number {
  const websocketHeaderBytes = frameBytes < 126 ? 2 : frameBytes < 65_536 ? 4 : 10;
  return frameBytes - websocketHeaderBytes - 9;
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

function assertContiguousOutputFrames(
  frames: readonly OutputFrame[],
  expectedStart: number,
  expectedBytes: number,
): void {
  expect(frames.length).toBeGreaterThan(0);
  let sequence = expectedStart;
  let bytes = 0;
  for (const frame of frames) {
    expect(frame.frame.sequence).toBe(sequence);
    const payloadBytes = terminalFramePayloadBytes(frame.frame.bytes);
    expect(payloadBytes).toBeGreaterThan(0);
    bytes += payloadBytes;
    sequence += payloadBytes;
  }
  expect(bytes).toBe(expectedBytes);
  expect(sequence).toBe(expectedStart + expectedBytes);
}

function boundedActiveText(terminal: Terminal): string {
  const active = terminal.buffer.active;
  const length = Math.max(0, Math.min(active.length, 20_000));
  let text = "";
  for (let index = 0; index < length && text.length < 256_000; index += 1) {
    const line = active.getLine(index);
    if (!line) continue;
    text += line.translateToString(true);
    if (index + 1 < length) text += "\n";
  }
  return text;
}

async function writeModel(terminal: Terminal, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(bytes, resolve));
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} was not found in the authenticated listing`);
    return terminal;
  }, terminalId);
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

async function waitForWriteCount(
  server: IsolatedServer,
  terminalId: string,
  floor: number,
  count: number,
): Promise<void> {
  await server.waitForTranscript(
    terminalId,
    (entry, entries) => writeEntries(entriesAfter(entries, floor)).length >= count,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

async function waitForTerminalSettled(
  page: Page,
  terminalId: string,
  expectedEnd?: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, end, timeout, acknowledgementLimit }) => {
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
        && (end === undefined || (
          snapshot.receivedSequence !== undefined
            && snapshot.committedSequence !== undefined
            && snapshot.receivedSequence >= end
            && snapshot.committedSequence >= end
        ))
    ), { timeout });
  }, { id: terminalId, end: expectedEnd, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
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

function latestSizeEvent(events: readonly E2ETerminalEvent[]): E2ETerminalEvent | undefined {
  return [...events].reverse().find((event) => event.type === "size");
}

function assertNoScenarioRecovery(events: readonly E2ETerminalEvent[], floor: number): void {
  const scenarioEvents = events.filter((event) => event.id > floor);
  expect(scenarioEvents.filter((event) => event.type === "sync")).toEqual([]);
  expect(scenarioEvents.filter((event) => event.type === "socket-close" || event.type === "socket-stale")).toEqual([]);
  expect(scenarioEvents.filter((event) => event.type === "state" && ["recovering", "disconnected"].includes(String(event.data.state)))).toEqual([]);
}

async function assertCommandOnce(
  server: IsolatedServer,
  terminalId: string,
  line: string,
  operation = line.split(/\s+/, 1)[0]!,
): Promise<void> {
  const entries = await server.readTranscript(terminalId);
  const expected = base64(line);
  const matches = entries.filter((entry) => (
    entry.event === "command"
      && entry.operation === operation
      && entry.command_base64 === expected
  ));
  expect(matches).toHaveLength(1);
}

test("@nightly @O-15 @multiclient @flow @recovery O-15 Multi-client fast and slow consumers", async ({
  page,
  browser,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  await page.setViewportSize(WIDE_BROWSER_VIEWPORT);
  const browserErrorsA = installBrowserErrorCollectors(page);
  let contextB: BrowserContext | undefined;
  let browserErrorsB: ReturnType<typeof installBrowserErrorCollectors> | undefined;
  let slowB: NetworkFaultDisposer | undefined;
  let recordingStarted = false;
  let modelA: Terminal | undefined;
  let modelB: Terminal | undefined;

  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbenchA = new WorkbenchPage(page);
    await workbenchA.expectVisible();
    const mounted = page.evaluate(async (timeout) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount", { timeout });
    }, WAIT_TIMEOUT_MS);
    await workbenchA.createTerminal();
    const mount = await mounted;
    const terminalId = mount.terminalId;
    const terminalRegionA = page.locator(`section[role="region"][data-terminal-id="${terminalId}"]`);
    await expect(terminalRegionA).toBeVisible();
    const terminalLabel = await terminalRegionA.getAttribute("aria-label");
    const terminalName = terminalLabel?.replace(/^Terminal\s+/, "");
    if (!terminalName) throw new Error("created terminal did not expose an accessible name");
    const paneA = new TerminalPanePage(page, { terminalId, name: terminalName });
    await paneA.expectVisible();
    await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const aOnly = await waitForTerminalSettled(page, terminalId);
    expect(aOnly.desiredViewport).toMatchObject(WIDE_GEOMETRY);
    expect(aOnly.serverViewport).toMatchObject(WIDE_GEOMETRY);

    contextB = await browser.newContext({ baseURL, viewport: NARROW_BROWSER_VIEWPORT });
    const pageB = await contextB.newPage();
    browserErrorsB = installBrowserErrorCollectors(pageB);
    await pageB.goto(baseURL);
    await new LoginPage(pageB).login();
    const workbenchB = new WorkbenchPage(pageB);
    await workbenchB.expectVisible();
    const paneB = await workbenchB.openTerminal({ id: terminalId, name: terminalName });
    await paneB.expectVisible();
    await expectTerminalConnected(pageB, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalSynchronized(pageB, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const [baselineA, baselineB] = await Promise.all([
      waitForTerminalSettled(page, terminalId),
      waitForTerminalSettled(pageB, terminalId),
    ]);
    expect(baselineA.desiredViewport).toMatchObject(WIDE_GEOMETRY);
    expect(baselineB.desiredViewport).toMatchObject(NARROW_GEOMETRY);
    expect(baselineA.serverViewport).toMatchObject(NARROW_GEOMETRY);
    expect(baselineB.serverViewport).toMatchObject(NARROW_GEOMETRY);
    expect(baselineA.serverViewport?.pixelWidth).toBeGreaterThan(0);
    expect(baselineA.serverViewport?.pixelHeight).toBeGreaterThan(0);
    expect(baselineB.serverViewport?.pixelWidth).toBeGreaterThan(0);
    expect(baselineB.serverViewport?.pixelHeight).toBeGreaterThan(0);
    expect(baselineA.focused).toBe(false);
    expect(baselineB.focused).toBe(false);
    expect(baselineA.activeSocketCount).toBe(1);
    expect(baselineB.activeSocketCount).toBe(1);

    const terminalA = await readTerminal(page, terminalId);
    const terminalB = await readTerminal(pageB, terminalId);
    expect(terminalA.clients).toBe(2);
    expect(terminalB.clients).toBe(2);
    expect(terminalA.pid).not.toBeNull();
    expect(terminalB.pid).toBe(terminalA.pid);
    const opens = faultController.events.filter((event) => event.type === "connection-open" && event.terminalId === terminalId);
    expect(opens).toHaveLength(2);
    const generationA = baselineA.socketGeneration;
    const generationB = baselineB.socketGeneration;
    expect(generationA).not.toBe(generationB);
    expect(opens.some((event) => event.generation === generationA)).toBe(true);
    expect(opens.some((event) => event.generation === generationB)).toBe(true);
    const sizeA = latestSizeEvent(await paneA.events());
    const sizeB = latestSizeEvent(await paneB.events());
    expect(sizeA?.data.focused).toBe(false);
    expect(sizeA?.data.controller).toBe(false);
    expect(sizeA?.data.responder).toBe(true);
    expect(sizeB?.data.focused).toBe(false);
    expect(sizeB?.data.controller).toBe(false);
    expect(sizeB?.data.responder).toBe(false);

    const transcriptBefore = await server.readTranscript(terminalId);
    const transcriptFloor = transcriptBefore.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
    const diagnosticFloorA = (await terminalEvents(page, terminalId)).at(-1)?.id ?? 0;
    const diagnosticFloorB = (await terminalEvents(pageB, terminalId)).at(-1)?.id ?? 0;
    const networkFloor = faultController.events.length;
    const baselineReceivedA = baselineA.receivedSequence ?? 0;
    const baselineReceivedB = baselineB.receivedSequence ?? 0;
    expect(baselineReceivedB).toBe(baselineReceivedA);
    const beforePixelsA = await screenshotRegion(page, paneA.xtermHost.locator(".xterm-screen"));
    const beforePixelsB = await screenshotRegion(pageB, paneB.xtermHost.locator(".xterm-screen"));

    slowB = faultController.throttle("server-to-browser", B_SLOW_BYTES_PER_SECOND, {
      terminalId,
      generation: generationB,
    });
    await faultController.waitFor((event) => (
      event.type === "throttled"
        && event.terminalId === terminalId
        && event.generation === generationB
        && event.direction === "server-to-browser"
        && event.bytes === B_SLOW_BYTES_PER_SECOND
    ), { timeoutMs: WAIT_TIMEOUT_MS });

    await recordingControl(page, "start");
    recordingStarted = true;
    await paneA.focus();
    await paneA.sendInput("READY O15", true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === "O15" && transcriptSequence(entry) > transcriptFloor, { timeoutMs: WAIT_TIMEOUT_MS });
    await paneA.sendInput(`BURST O15 ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "burst" && entry.id === "O15" && entry.bytes === BURST_BYTES && entry.line_width === BURST_LINE_WIDTH && transcriptSequence(entry) > transcriptFloor, { timeoutMs: WAIT_TIMEOUT_MS });
    await paneA.sendInput("PRINT O15 FAST-DONE", true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === "O15" && entry.text === "FAST-DONE" && transcriptSequence(entry) > transcriptFloor, { timeoutMs: WAIT_TIMEOUT_MS });
    await waitForWriteCount(server, terminalId, transcriptFloor, 3);
    const prefixTranscript = await server.readTranscript(terminalId);
    const prefixWrites = writeEntries(entriesAfter(prefixTranscript, transcriptFloor));
    const prefixBytes = Buffer.concat(prefixWrites.map(writeBytes));
    const prefixEnd = baselineReceivedA + prefixBytes.length;
    const fastDone = await waitForTerminalSettled(page, terminalId, prefixEnd);
    expect(fastDone.receivedSequence).toBe(prefixEnd);
    expect(fastDone.committedSequence).toBe(prefixEnd);
    expect(fastDone.flowControlled).toBe(false);
    expect(fastDone.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(fastDone.syncMode).toBeUndefined();
    expect(fastDone.syncTarget).toBeUndefined();
    expect(fastDone.serverViewport).toMatchObject(NARROW_GEOMETRY);
    assertNoScenarioRecovery(await terminalEvents(page, terminalId), diagnosticFloorA);

    const echoId = `O15-IN-${testInfo.workerIndex}-${testInfo.parallelIndex}`;
    const echoPayload = `O15-CONTINUED-${testInfo.workerIndex}-${testInfo.parallelIndex}`;
    await paneA.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed" && transcriptSequence(entry) > transcriptFloor, { timeoutMs: WAIT_TIMEOUT_MS });
    await paneA.sendInput(echoPayload, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload" && entry.payload_base64 === base64(echoPayload) && transcriptSequence(entry) > transcriptFloor, { timeoutMs: WAIT_TIMEOUT_MS });
    await waitForWriteCount(server, terminalId, transcriptFloor, 5);
    const transcript = await server.readTranscript(terminalId);
    const scenarioEntries = entriesAfter(transcript, transcriptFloor);
    const writes = writeEntries(scenarioEntries);
    expect(writes).toHaveLength(5);
    const expectedWrites = [
      marker("READY", "O15"),
      burstBytes(BURST_BYTES, BURST_LINE_WIDTH),
      marker("PRINT", "O15", "FAST-DONE"),
      marker("ECHO_INPUT", echoId, "READY"),
      marker("ECHO_INPUT", echoId, base64(echoPayload)),
    ];
    expect(writes.map(writeBytes)).toEqual(expectedWrites);
    expect(scenarioEntries.filter((entry) => entry.event === "burst" && entry.id === "O15")).toHaveLength(1);
    expect(scenarioEntries.filter((entry) => entry.event === "print" && entry.id === "O15" && entry.text === "FAST-DONE")).toHaveLength(1);
    expect(writes.filter((entry) => writeBytes(entry).equals(expectedWrites[1]!))).toHaveLength(1);
    expect(writes.filter((entry) => writeBytes(entry).equals(expectedWrites[2]!))).toHaveLength(1);
    expect(scenarioEntries.filter((entry) => entry.event === "error")).toEqual([]);
    const echoPayloadEntries = scenarioEntries.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload");
    expect(echoPayloadEntries).toHaveLength(1);
    expect(echoPayloadEntries[0]?.payload_base64).toBe(base64(echoPayload));

    const scenarioBytes = Buffer.concat(writes.map(writeBytes));
    const scenarioEnd = baselineReceivedA + scenarioBytes.length;
    const [finalA, finalB] = await Promise.all([
      waitForTerminalSettled(page, terminalId, scenarioEnd),
      waitForTerminalSettled(pageB, terminalId, scenarioEnd),
    ]);
    expect(finalA.receivedSequence).toBe(scenarioEnd);
    expect(finalA.committedSequence).toBe(scenarioEnd);
    expect(finalB.receivedSequence).toBe(scenarioEnd);
    expect(finalB.committedSequence).toBe(scenarioEnd);
    expect(finalA.serverViewport).toMatchObject(NARROW_GEOMETRY);
    expect(finalB.serverViewport).toMatchObject(NARROW_GEOMETRY);
    expect(finalA.activeSocketCount).toBe(1);
    expect(finalB.activeSocketCount).toBe(1);
    expect(finalA.flowControlled).toBe(false);
    expect(finalB.flowControlled).toBe(false);
    expect(finalA.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(finalB.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(finalA.acceptingInput).toBe(true);
    expect(finalB.acceptingInput).toBe(true);
    expect(finalB.focused).toBe(false);

    const recordingStop = await (async () => {
      await recordingControl(page, "stop");
      recordingStarted = false;
      return recordingExport(page);
    })();
    expect(recordingStop.truncated).toBe(false);
    const recorded = outputRecords(recordingStop, terminalId);
    expect(recorded.length).toBeGreaterThan(0);
    const recordedChunks = uniqueRecordedOutput(recorded, baselineReceivedA);
    expect(Buffer.concat(recordedChunks)).toEqual(scenarioBytes);

    modelA = new Terminal({
      allowProposedApi: true,
      cols: NARROW_GEOMETRY.cols,
      rows: NARROW_GEOMETRY.rows,
      scrollback: 200_000,
      ...tuiCompatibilityOptions(),
    });
    modelB = new Terminal({
      allowProposedApi: true,
      cols: NARROW_GEOMETRY.cols,
      rows: NARROW_GEOMETRY.rows,
      scrollback: 200_000,
      ...tuiCompatibilityOptions(),
    });
    for (const chunk of recordedChunks) {
      await writeModel(modelA, chunk);
      await writeModel(modelB, chunk);
    }
    const modelTextA = boundedActiveText(modelA);
    const modelTextB = boundedActiveText(modelB);
    expect(finalA.xterm.text).toBe(modelTextA);
    expect(finalB.xterm.text).toBe(modelTextB);
    expect(finalA.xterm.activeBuffer).toBe(modelA.buffer.active.type);
    expect(finalB.xterm.activeBuffer).toBe(modelB.buffer.active.type);
    expect(finalA.xterm.cursorX).toBe(modelA.buffer.active.cursorX);
    expect(finalA.xterm.cursorY).toBe(modelA.buffer.active.cursorY);
    expect(finalB.xterm.cursorX).toBe(modelB.buffer.active.cursorX);

    expect(finalB.xterm.cursorY).toBe(modelB.buffer.active.cursorY);
    expect(finalA.xterm.viewportY).toBe(modelA.buffer.active.viewportY);
    expect(finalB.xterm.viewportY).toBe(modelB.buffer.active.viewportY);
    expect(finalA.xterm.selectionText).toBe("");
    expect(finalB.xterm.selectionText).toBe("");
    expect(finalA.xterm.text).toBe(finalB.xterm.text);
    const finalEventsA = await terminalEvents(page, terminalId);
    const finalEventsB = await terminalEvents(pageB, terminalId);
    await assertMonotonicSequences(finalEventsA);
    await assertMonotonicSequences(finalEventsB);
    expect(finalEventsA.filter((event) => event.type === "error")).toEqual([]);
    expect(finalEventsB.filter((event) => event.type === "error")).toEqual([]);
    assertNoScenarioRecovery(finalEventsA, diagnosticFloorA);
    const recoverySyncsB = finalEventsB.filter((event) => event.id > diagnosticFloorB && event.type === "sync");
    expect(recoverySyncsB.length).toBeLessThanOrEqual(1);
    for (const event of recoverySyncsB) expect(["snapshot", "resume"]).toContain(event.data.mode);
    if (recoverySyncsB.length === 0) {
      const framesA = outputFrames(faultController.events.slice(networkFloor), terminalId, generationA);
      const framesB = outputFrames(faultController.events.slice(networkFloor), terminalId, generationB);
      assertContiguousOutputFrames(framesA, baselineReceivedA, scenarioBytes.length);
      assertContiguousOutputFrames(framesB, baselineReceivedB, scenarioBytes.length);
    } else {
      expect(finalB.gridEpoch).toBe(baselineB.gridEpoch);
      expect(finalB.committedSequence).toBe(finalB.receivedSequence);
    }
    expect(finalA.gridEpoch).toBe(baselineA.gridEpoch);
    expect(finalB.gridEpoch).toBe(baselineB.gridEpoch);

    const finalSizeA = latestSizeEvent(finalEventsA);
    const finalSizeB = latestSizeEvent(finalEventsB);
    expect(finalSizeA?.data.focused).toBe(false);
    expect(finalSizeA?.data.controller).toBe(false);
    expect(finalSizeA?.data.responder).toBe(true);
    expect(finalSizeB?.data.focused).toBe(false);
    expect(finalSizeB?.data.controller).toBe(false);
    expect(finalSizeB?.data.responder).toBe(false);
    const finalTerminalA = await readTerminal(page, terminalId);
    const finalTerminalB = await readTerminal(pageB, terminalId);
    expect(finalTerminalA.clients).toBe(2);
    expect(finalTerminalB.clients).toBe(2);
    expect(faultController.events.filter((event) => event.type === "connection-open" && event.terminalId === terminalId)).toHaveLength(2);
    expect(faultController.events.filter((event) => (event.type === "connection-closed" || event.type === "connection-terminated") && event.terminalId === terminalId)).toEqual([]);

    const allWinches = transcript.filter((entry) => entry.event === "sigwinch");
    const latestWinch = allWinches.at(-1);
    expect(latestWinch?.rows).toBe(NARROW_GEOMETRY.rows);
    expect(latestWinch?.cols).toBe(NARROW_GEOMETRY.cols);
    await assertCommandOnce(server, terminalId, "READY O15");
    await assertCommandOnce(server, terminalId, `BURST O15 ${BURST_BYTES} ${BURST_LINE_WIDTH}`);
    await assertCommandOnce(server, terminalId, "PRINT O15 FAST-DONE");
    await assertCommandOnce(server, terminalId, `ECHO_INPUT ${echoId}`);
    await assertCommandOnce(server, terminalId, echoPayload, "ECHO_INPUT");

    const afterPixelsA = await expectKnownMarkerChanged(page, paneA.xtermHost.locator(".xterm-screen"), beforePixelsA, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-15-a-final-marker-crop",
    });
    const afterPixelsB = await expectKnownMarkerChanged(pageB, paneB.xtermHost.locator(".xterm-screen"), beforePixelsB, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-15-b-final-marker-crop",
    });
    expect(afterPixelsA.after.width).toBe(beforePixelsA.width);
    expect(afterPixelsB.after.width).toBe(beforePixelsB.width);
    await expectTerminalNonBlank(page, paneA.xtermHost.locator(".xterm-screen"), {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "o-15-a-terminal-crop",
    });
    await expectTerminalNonBlank(pageB, paneB.xtermHost.locator(".xterm-screen"), {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "o-15-b-terminal-crop",
    });
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectNoPendingRecovery(pageB, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectConnectedTerminalInvariants(pageB, terminalId, { timeout: WAIT_TIMEOUT_MS });

    slowB.dispose();
    slowB = undefined;
    await paneA.sendInput("EXIT 0", true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "exit_requested" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    const [exitedA, exitedB] = await Promise.all([
      waitForExited(page, terminalId),
      waitForExited(pageB, terminalId),
    ]);
    expect(exitedA.exitCode).toBe(0);
    expect(exitedB.exitCode).toBe(0);
    const finalTranscript = await server.readTranscript(terminalId);
    expect(finalTranscript.filter((entry) => entry.event === "exit" && entry.code === 0)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "error")).toEqual([]);
    const invariantA = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const invariantB = await expectTerminalInvariants(pageB, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantA.violations).toEqual([]);
    expect(invariantB.violations).toEqual([]);
    expect(invariantA.snapshot.activeSocketCount).toBe(0);
    expect(invariantB.snapshot.activeSocketCount).toBe(0);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);

    const unexpectedBrowserErrorsA = browserErrorsA().filter((entry) => (
      entry.kind === "pageerror"
        || entry.kind === "requestfailed"
        || (entry.kind === "console" && /^error:/i.test(entry.message))
    ));
    const unexpectedBrowserErrorsB = browserErrorsB?.().filter((entry) => (
      entry.kind === "pageerror"
        || entry.kind === "requestfailed"
        || (entry.kind === "console" && /^error:/i.test(entry.message))
    )) ?? [];
    expect(unexpectedBrowserErrorsA).toEqual([]);
    expect(unexpectedBrowserErrorsB).toEqual([]);
  } finally {
    if (recordingStarted) await recordingControl(page, "stop");
    slowB?.dispose();
    modelA?.dispose();
    modelB?.dispose();
    browserErrorsB?.dispose();
    await contextB?.close();
    browserErrorsA.dispose();
  }
});
