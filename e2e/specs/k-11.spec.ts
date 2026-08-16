import { Buffer } from "node:buffer";
import { Terminal as HeadlessTerminal } from "../fixtures/headless-terminal.js"
import { test, expect, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type { TerminalPanePage } from "../pages/terminal-pane.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";

const WAIT_TIMEOUT_MS = 45_000;
const CHECKPOINT_CHUNK_BYTES = 32 * 1024;
const BROWSER_VIEWPORT = { width: 1_280, height: 760 } as const;
const SCROLLBACK_LINES = 10_000;

const UNICODE_TEXT = "e\u0301 | 猫 | 😀 | ✈️";
const SPLIT_CASES = [
  { id: "combining", text: "e\u0301", splitByte: 2 },
  { id: "wide", text: "猫", splitByte: 1 },
  { id: "emoji", text: "😀", splitByte: 2 },
  { id: "variation", text: "✈️", splitByte: 4 },
] as const;
const ESCAPE_SEQUENCE = Buffer.from("\u001b[2;7H", "binary");
const ESCAPE_TOKEN = "\\e[2;7H";

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly pid: number | null;
  readonly clients: number;
}

interface DebugRecordingEvent {
  readonly terminal: string;
  readonly type: string;
  readonly sequence?: number;
  readonly data?: string;
  readonly message?: unknown;
}

interface DebugRecordingExport {
  readonly truncated: boolean;
  readonly events: readonly DebugRecordingEvent[];
}

interface CheckpointMessage {
  readonly sequence: number;
  readonly epoch: number;
  readonly offset: number;
  readonly data: string;
  readonly final: boolean;
}

interface ReadableBuffer {
  readonly type: "normal" | "alternate";
  readonly cursorX: number;
  readonly cursorY: number;
  readonly viewportY: number;
  readonly length: number;
  getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
}

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function markerBytes(operation: string, ...fields: string[]): Buffer {
  return Buffer.from(`${marker(operation, ...fields)}\n`, "utf8");
}

function countOccurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
}

function numberField(entry: TranscriptEntry, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function outputBytes(entries: readonly TranscriptEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.event !== "write") continue;
    if (typeof entry.data_base64 !== "string") throw new Error("fixture write transcript entry is missing data_base64");
    chunks.push(Buffer.from(entry.data_base64, "base64"));
  }
  return Buffer.concat(chunks);
}

function lastWriteSequence(entries: readonly TranscriptEntry[]): number {
  let sequence = 0;
  for (const entry of entries) {
    if (entry.event !== "write") continue;
    const value = numberField(entry, "write_sequence");
    if (value !== undefined) sequence = Math.max(sequence, value);
  }
  return sequence;
}

function checkpointFromRecording(event: DebugRecordingEvent): CheckpointMessage | undefined {
  if (event.type !== "control") return undefined;
  const outer = event.message;
  if (typeof outer !== "object" || outer === null || Array.isArray(outer)) return undefined;
  const outerMessage = outer as { readonly type?: unknown; readonly message?: unknown };
  if (outerMessage.type !== "client") return undefined;
  const nested = outerMessage.message;
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return undefined;
  const message = nested as {
    readonly type?: unknown;
    readonly sequence?: unknown;
    readonly epoch?: unknown;
    readonly offset?: unknown;
    readonly data?: unknown;
    readonly final?: unknown;
  };
  // The proxy records legacy JSON chunks verbatim as "checkpoint" and
  // reconstructs binary chunk frames as "checkpointBinaryChunk"; both carry
  // the same fields.
  if (
    (message.type !== "checkpoint" && message.type !== "checkpointBinaryChunk")
    || typeof message.sequence !== "number"
    || typeof message.epoch !== "number"
    || typeof message.offset !== "number"
    || typeof message.data !== "string"
    || typeof message.final !== "boolean"
  ) return undefined;
  return {
    sequence: message.sequence,
    epoch: message.epoch,
    offset: message.offset,
    data: message.data,
    final: message.final,
  };
}


function eventNumber(event: E2ETerminalEvent, key: string): number {
  const value = event.data[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`terminal event omitted finite numeric ${key}`);
  return value;
}

async function recordingControl(page: Parameters<typeof installBrowserErrorCollectors>[0], action: "clear" | "start" | "stop"): Promise<void> {
  await page.evaluate(async (nextAction) => {
    const response = await fetch("/api/debug/recording", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: nextAction }),
    });
    if (!response.ok) throw new Error(`debug recording ${nextAction} failed with HTTP ${response.status}`);
  }, action);
}

async function exportRecording(page: Parameters<typeof installBrowserErrorCollectors>[0]): Promise<DebugRecordingExport> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export", { cache: "no-store" });
    if (!response.ok) throw new Error(`debug recording export failed with HTTP ${response.status}`);
    return await response.json() as DebugRecordingExport;
  });
}

async function createFixtureTerminal(page: Parameters<typeof installBrowserErrorCollectors>[0], server: IsolatedServer, path: string): Promise<TerminalApiInfo> {
  return page.evaluate(async ({ path: terminalPath, shell }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: terminalPath, cwd: "/tmp", shell }),
    });
    if (!response.ok) throw new Error(`fixture terminal creation failed with HTTP ${response.status}`);
    const terminal = await response.json() as Partial<TerminalApiInfo>;
    if (typeof terminal.id !== "string" || typeof terminal.name !== "string") {
      throw new Error("fixture terminal creation response omitted terminal identity");
    }
    return {
      id: terminal.id,
      name: terminal.name,
      status: terminal.status ?? "",
      pid: terminal.pid ?? null,
      clients: terminal.clients ?? 0,
    };
  }, { path, shell: server.fixturePath });
}

async function waitForCommittedSequence(page: Parameters<typeof installBrowserErrorCollectors>[0], terminalId: string, minimumSequence: number): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.committedSequence !== undefined
      && snapshot.committedSequence >= minimum
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCheckpoint(page: Parameters<typeof installBrowserErrorCollectors>[0], terminalId: string, minimumSequence: number): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.type !== "checkpoint" || event.data.result !== "sent") return false;
      return typeof event.data.sequence === "number" && event.data.sequence >= minimum;
    }, { timeout });
  }, { id: terminalId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRecoveryEvent(
  page: Parameters<typeof installBrowserErrorCollectors>[0],
  terminalId: string,
  generation: number,
  type: "sync" | "synced",
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, generation: previousGeneration, eventType, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === eventType
      && event.snapshot.socketGeneration > previousGeneration
    ), { timeout });
  }, { id: terminalId, generation, eventType: type, timeout: WAIT_TIMEOUT_MS });
}

async function waitForTranscriptWrite(
  server: IsolatedServer,
  terminalId: string,
  writeSequence: number,
  bytes: Uint8Array,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(terminalId, (entry) => (
    entry.event === "write"
    && numberField(entry, "write_sequence") === writeSequence
    && entry.data_base64 === base64(bytes)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

async function waitForCommand(server: IsolatedServer, terminalId: string, command: string, operation: string): Promise<TranscriptEntry> {
  return server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === operation
    && entry.command_base64 === base64(command)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

async function sendUtf8Split(
  page: Parameters<typeof installBrowserErrorCollectors>[0],
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
  text: string,
  splitByte: number,
): Promise<{ readonly beforeBytes: number; readonly after: E2ETerminalSnapshot; readonly command: string }> {
  const bytes = Buffer.from(text, "utf8");
  if (splitByte <= 0 || splitByte >= bytes.length) throw new Error(`invalid UTF-8 split for ${id}`);
  const entries = await server.readTranscript(terminalId);
  const beforeSequence = lastWriteSequence(entries);
  const beforeBytes = outputBytes(entries).length;
  const command = `UTF8_SPLIT ${id} ${text} ${splitByte}`;
  const commandSeen = waitForCommand(server, terminalId, command, "UTF8_SPLIT");
  const splitSeen = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "utf8_split"
    && entry.id === id
    && entry.text === text
    && entry.split === splitByte
    && entry.bytes === bytes.length
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const firstWrite = waitForTranscriptWrite(server, terminalId, beforeSequence + 1, bytes.subarray(0, splitByte));
  const secondWrite = waitForTranscriptWrite(server, terminalId, beforeSequence + 2, bytes.subarray(splitByte));
  const committed = waitForCommittedSequence(page, terminalId, beforeBytes + bytes.length);
  await pane.sendInput(command, true);
  await Promise.all([commandSeen, splitSeen, firstWrite, secondWrite]);
  const after = await committed;
  return { beforeBytes, after, command };
}

async function sendEscapeSplit(
  page: Parameters<typeof installBrowserErrorCollectors>[0],
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
): Promise<{ readonly after: E2ETerminalSnapshot; readonly command: string }> {
  const entries = await server.readTranscript(terminalId);
  const beforeSequence = lastWriteSequence(entries);
  const beforeBytes = outputBytes(entries).length;
  const first = ESCAPE_SEQUENCE.subarray(0, 2);
  const second = ESCAPE_SEQUENCE.subarray(2);
  const command = `ESCAPE_SPLIT ${id} ${ESCAPE_TOKEN} 2`;
  const commandSeen = waitForCommand(server, terminalId, command, "ESCAPE_SPLIT");
  const splitSeen = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "escape_split"
    && entry.id === id
    && entry.split === 2
    && entry.bytes === ESCAPE_SEQUENCE.length
    && entry.sequence_base64 === base64(ESCAPE_SEQUENCE)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const firstWrite = waitForTranscriptWrite(server, terminalId, beforeSequence + 1, first);
  const secondWrite = waitForTranscriptWrite(server, terminalId, beforeSequence + 2, second);
  const escapeMarkerWrite = waitForTranscriptWrite(server, terminalId, beforeSequence + 3, markerBytes("ESCAPE_SPLIT", id));
  const committed = waitForCommittedSequence(page, terminalId, beforeBytes + ESCAPE_SEQUENCE.length + markerBytes("ESCAPE_SPLIT", id).length);
  await pane.sendInput(command, true);
  await Promise.all([commandSeen, splitSeen, firstWrite, secondWrite, escapeMarkerWrite]);
  return { after: await committed, command };
}

function bufferText(buffer: ReadableBuffer): string {
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function makeHeadless(snapshot: E2ETerminalSnapshot): HeadlessTerminal {
  return new HeadlessTerminal({
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
    ...tuiCompatibilityOptions(),
  });
}


async function modelFromFixture(snapshot: E2ETerminalSnapshot, entries: readonly TranscriptEntry[]): Promise<HeadlessTerminal> {
  const terminal = makeHeadless(snapshot);
  for (const entry of entries) {
    if (entry.event !== "write") continue;
    if (typeof entry.data_base64 !== "string") throw new Error("fixture write transcript entry is missing data_base64");
    const bytes: Uint8Array = Buffer.from(entry.data_base64, "base64");
    await new Promise<void>((resolve) => terminal.write(bytes, () => resolve()));
  }
  return terminal;
}

async function modelFromServerRecording(
  snapshot: E2ETerminalSnapshot,
  recording: DebugRecordingExport,
  terminalId: string,
): Promise<HeadlessTerminal> {
  const events = recording.events.filter((event) => event.terminal === terminalId);
  const snapshotIndex = events.findLastIndex((event) => event.type === "snapshot");
  if (snapshotIndex < 0) throw new Error("server recording did not contain a snapshot frame");
  const snapshotEvent = events[snapshotIndex];
  if (!snapshotEvent || typeof snapshotEvent.data !== "string") throw new Error("server snapshot frame is missing data");
  const terminal = makeHeadless(snapshot);
  const snapshotBytes: Uint8Array = Buffer.from(snapshotEvent.data, "base64");
  await new Promise<void>((resolve) => terminal.write(snapshotBytes, () => resolve()));
  for (const event of events.slice(snapshotIndex + 1)) {
    if (event.type !== "output") continue;
    if (typeof event.data !== "string") throw new Error("server output frame is missing data");
    const outputBytes: Uint8Array = Buffer.from(event.data, "base64");
    await new Promise<void>((resolve) => terminal.write(outputBytes, () => resolve()));
  }
  return terminal;
}

function assertModelParity(snapshot: E2ETerminalSnapshot, terminal: HeadlessTerminal, label: string): void {
  const active = terminal.buffer.active as unknown as ReadableBuffer;
  expect(active.type, `${label}: active buffer`).toBe(snapshot.xterm.activeBuffer);
  expect(active.cursorX, `${label}: cursor x`).toBe(snapshot.xterm.cursorX);
  expect(active.cursorY, `${label}: cursor y`).toBe(snapshot.xterm.cursorY);
  expect(active.viewportY, `${label}: viewport`).toBe(snapshot.xterm.viewportY);
  expect(bufferText(active), `${label}: text`).toBe(snapshot.xterm.text);
}

function assertCheckpointRecording(
  recording: DebugRecordingExport,
  terminalId: string,
  checkpoint: E2ETerminalEvent,
  unicodeText: string,
): void {
  expect(recording.truncated, "server debug recording must remain bounded").toBe(false);
  const sequence = checkpoint.data.sequence;
  const epoch = checkpoint.data.epoch;
  const size = checkpoint.data.size;
  const chunks = checkpoint.data.chunks;
  if (
    typeof sequence !== "number"
    || typeof epoch !== "number"
    || typeof size !== "number"
    || typeof chunks !== "number"
  ) throw new Error("checkpoint diagnostic omitted sequence, epoch, size, or chunks");
  const terminalEvents = recording.events.filter((event) => event.terminal === terminalId);
  const messages = terminalEvents
    .map(checkpointFromRecording)
    .filter((message): message is CheckpointMessage => message !== undefined)
    .filter((message) => message.sequence === sequence && message.epoch === epoch);
  expect(messages, "server recording must contain every checkpoint chunk").toHaveLength(chunks);
  const ordered = [...messages].sort((left, right) => left.offset - right.offset);
  let offset = 0;
  const payload: Buffer[] = [];
  for (const [index, message] of ordered.entries()) {
    expect(message.offset).toBe(offset);
    const bytes = Buffer.from(message.data, "base64");
    expect(bytes.length).toBeLessThanOrEqual(CHECKPOINT_CHUNK_BYTES);
    expect(message.final).toBe(index === ordered.length - 1);
    payload.push(bytes);
    offset += bytes.length;
  }
  const serialized = Buffer.concat(payload);
  expect(serialized.length).toBe(size);
  expect(chunks).toBe(Math.ceil(size / CHECKPOINT_CHUNK_BYTES));
  expect(serialized.includes(Buffer.from(unicodeText, "utf8")), "checkpoint lost raw UTF-8 Unicode").toBe(true);
  expect(serialized.includes(Buffer.from("\uFFFD", "utf8")), "checkpoint contains a replacement character").toBe(false);

  const accepted = terminalEvents.filter((event) => {
    if (event.type !== "control") return false;
    const value = event.message;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const message = value as { readonly type?: unknown; readonly event?: unknown };
    return message.type === "recording" && message.event === "xterm checkpoint stored";
  });
  expect(accepted, "server did not record checkpoint acceptance").not.toHaveLength(0);

  const ready = terminalEvents.find((event) => {
    if (event.type !== "control") return false;
    const value = event.message;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const message = value as { readonly type?: unknown; readonly checkpointBytes?: unknown };
    return message.type === "ready" && typeof message.checkpointBytes === "number";
  });
  if (!ready) throw new Error("server recording omitted checkpointBytes negotiation");
  const readyValue = ready.message as { readonly checkpointBytes?: unknown };
  if (typeof readyValue.checkpointBytes !== "number") throw new Error("server ready message omitted checkpointBytes");
  expect(size).toBeLessThanOrEqual(readyValue.checkpointBytes);
}

async function waitForTerminalText(
  page: Parameters<typeof installBrowserErrorCollectors>[0],
  terminalId: string,
  text: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.xterm.text.includes(expected)
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, expected: text, timeout: WAIT_TIMEOUT_MS });
}

test("K-11 Unicode checkpoint @p1 @nightly @checkpoint @unicode", async ({ page, baseURL, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let recordingStarted = false;
  let recordingStopped = false;
  try {
    const runTag = `w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`;
    const terminalPath = `k-11-${runTag}`;
    const readyId = `K11-READY-${runTag}`;
    const printId = `K11-UNICODE-${runTag}`;
    const escapeId = `K11-CSI-${runTag}`;
    const firstSplitId = `K11-SPLIT-COMBINING-${runTag}`;
    const orderId = `K11-CHECKPOINT-ORDER-${runTag}`;
    const finalId = `K11-FINAL-${runTag}`;
    const echoId = `K11-ECHO-${runTag}`;
    const sizeId = `K11-SIZE-${runTag}`;
    const finalText = `after-recovery-${UNICODE_TEXT}`;
    const echoText = `continued-input-${UNICODE_TEXT}`;
    const printMarker = marker("PRINT", printId, UNICODE_TEXT);
    const escapeMarker = marker("ESCAPE_SPLIT", escapeId);
    const finalMarker = marker("PRINT", finalId, finalText);
    const echoMarker = marker("ECHO_INPUT", echoId, base64(echoText));

    await page.setViewportSize(BROWSER_VIEWPORT);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    await recordingControl(page, "clear");
    await recordingControl(page, "start");
    recordingStarted = true;

    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const created = await createFixtureTerminal(page, server, terminalPath);
    expect(created.status).toBe("running");
    expect(created.pid).not.toBeNull();
    const pane = await workbench.openTerminal({ id: created.id, name: created.name });
    await pane.expectVisible();
    const initial = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    expect(initial.socketState).toBe("connected");
    expect(initial.acceptingInput).toBe(true);
    expect(initial.activeSocketCount).toBe(1);
    const dimensions = {
      cols: initial.cols,
      rows: initial.rows,
      pixelWidth: initial.pixelWidth,
      pixelHeight: initial.pixelHeight,
    } as const;
    await expectTerminalConverged(page, created.id, dimensions, { timeout: WAIT_TIMEOUT_MS });

    await pane.sendInput(`READY ${readyId}`, true);
    await waitForCommand(server, created.id, `READY ${readyId}`, "READY");
    await server.waitForTranscript(created.id, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, created.id, { contains: marker("READY", readyId), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const beforePrint = await screenshotRegion(page, pane.xtermHost);
    const printCommand = `PRINT ${printId} ${UNICODE_TEXT}`;
    const printEntries = await server.readTranscript(created.id);
    const printWriteSequence = lastWriteSequence(printEntries) + 1;
    const printWrite = waitForTranscriptWrite(server, created.id, printWriteSequence, markerBytes("PRINT", printId, UNICODE_TEXT));
    await pane.sendInput(printCommand, true);
    await Promise.all([
      waitForCommand(server, created.id, printCommand, "PRINT"),
      server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === printId && entry.text === UNICODE_TEXT, { timeoutMs: WAIT_TIMEOUT_MS }),
      printWrite,
    ]);
    const printed = await waitForTerminalText(page, created.id, printMarker);
    expect(printed.xterm.text).toContain(UNICODE_TEXT);
    expect(printed.xterm.text).not.toContain("\uFFFD");
    expect(Array.from(UNICODE_TEXT)).toEqual(["e", "\u0301", " ", "|", " ", "猫", " ", "|", " ", "😀", " ", "|", " ", "✈", "️"]);
    await expectKnownMarkerChanged(page, pane.xtermHost, beforePrint, {
      minimumChangedRatio: 0.0002,
      testInfo,
      artifactName: "k-11-unicode-marker",
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      minimumNonBackgroundRatio: 0.001,
      testInfo,
      artifactName: "k-11-unicode-terminal",
    });
    const escape = await sendEscapeSplit(page, pane, server, created.id, escapeId);
    expect(escape.after.xterm.text).toContain(escapeMarker);

    const firstSplitEntries = await server.readTranscript(created.id);
    const firstSplitBytes = Buffer.from(SPLIT_CASES[0]!.text, "utf8");
    const firstSplitBeforeBytes = outputBytes(firstSplitEntries).length;
    const firstSplitExpectedSequence = firstSplitBeforeBytes + firstSplitBytes.length;
    const firstCheckpoint = waitForCheckpoint(page, created.id, firstSplitExpectedSequence);
    const firstSplit = await sendUtf8Split(
      page,
      pane,
      server,
      created.id,
      firstSplitId,
      SPLIT_CASES[0]!.text,
      SPLIT_CASES[0]!.splitByte,
    );
    const checkpoint = await firstCheckpoint;
    const checkpointSequence = eventNumber(checkpoint, "sequence");
    const checkpointEpoch = eventNumber(checkpoint, "epoch");
    const checkpointSize = eventNumber(checkpoint, "size");
    const checkpointChunks = eventNumber(checkpoint, "chunks");
    expect(checkpointSequence).toBeGreaterThanOrEqual(firstSplitExpectedSequence);
    expect(checkpointSequence).toBe(checkpoint.snapshot.committedSequence);
    expect(checkpointEpoch).toBe(checkpoint.snapshot.gridEpoch);
    expect(checkpointSize).toBeGreaterThan(0);
    expect(checkpointChunks).toBe(Math.ceil(checkpointSize / CHECKPOINT_CHUNK_BYTES));
    expect(eventNumber(checkpoint, "serializationDurationMs")).toBeGreaterThanOrEqual(0);
    expect(eventNumber(checkpoint, "uploadDurationMs")).toBeGreaterThanOrEqual(0);
    expect(firstSplit.after.xterm.text).toContain(SPLIT_CASES[0]!.text);
    expect(firstSplit.after.xterm.text).not.toContain("\uFFFD");

    await pane.sendInput(`READY ${orderId}`, true);
    await waitForCommand(server, created.id, `READY ${orderId}`, "READY");
    await server.waitForTranscript(created.id, (entry) => entry.event === "ready" && entry.id === orderId, { timeoutMs: WAIT_TIMEOUT_MS });

    const settledSplits: E2ETerminalSnapshot[] = [firstSplit.after];
    for (const splitCase of SPLIT_CASES.slice(1)) {
      const split = await sendUtf8Split(
        page,
        pane,
        server,
        created.id,
        `K11-SPLIT-${splitCase.id.toUpperCase()}-${runTag}`,
        splitCase.text,
        splitCase.splitByte,
      );
      settledSplits.push(split.after);
      expect(split.after.xterm.text).toContain(splitCase.text);
      expect(split.after.xterm.text).not.toContain("\uFFFD");
    }
    expect(settledSplits[1]!.xterm.cursorX).toBe(settledSplits[0]!.xterm.cursorX + 2);
    expect(settledSplits[2]!.xterm.cursorX).toBe(settledSplits[1]!.xterm.cursorX + 2);
    expect(settledSplits[3]!.xterm.cursorX).toBe(settledSplits[2]!.xterm.cursorX + 1);
    const beforeDisconnectUnicode = await waitForTerminalText(page, created.id, UNICODE_TEXT);
    expect(beforeDisconnectUnicode.xterm.text).not.toContain("\uFFFD");

    const beforeDisconnect = await pane.snapshot();
    if (!beforeDisconnect) throw new Error("terminal diagnostics snapshot disappeared before Unicode recovery");
    expect(beforeDisconnect.committedSequence).toBe(outputBytes(await server.readTranscript(created.id)).length);
    const previousGeneration = beforeDisconnect.socketGeneration;
    const socketClose = page.evaluate(async ({ id, generation, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent(id, (event) => event.type === "socket-close" && event.data.generation === generation, { timeout });
    }, { id: created.id, generation: previousGeneration, timeout: WAIT_TIMEOUT_MS });
    const proxyTermination = faultController.waitFor((event) => (
      event.type === "connection-terminated"
      && event.terminalId === created.id
      && event.generation === previousGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const terminate = faultController.terminate({ terminalId: created.id, generation: previousGeneration });
    const terminated = await proxyTermination;
    expect(terminated.type).toBe("connection-terminated");
    await socketClose;
    terminate.dispose();

    const recoverySync = await waitForRecoveryEvent(page, created.id, previousGeneration, "sync");
    expect(["snapshot", "resume"]).toContain(recoverySync.data.mode);
    const recoverySynced = await waitForRecoveryEvent(page, created.id, previousGeneration, "synced");
    expect(recoverySynced.snapshot.socketGeneration).toBeGreaterThan(previousGeneration);
    const recovered = await pane.waitForConnected({ timeout: WAIT_TIMEOUT_MS });
    expect(recovered.socketGeneration).toBeGreaterThan(previousGeneration);
    expect(recovered.activeSocketCount).toBe(1);
    expect(recovered.acceptingInput).toBe(true);
    await expectTerminalBuffer(page, created.id, { contains: printMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, created.id, { contains: escapeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    expect(recovered.xterm.text).not.toContain("\uFFFD");

    const beforeFinal = await screenshotRegion(page, pane.xtermHost);
    const finalCommand = `PRINT ${finalId} ${finalText}`;
    const finalEntries = await server.readTranscript(created.id);
    const finalWrite = waitForTranscriptWrite(server, created.id, lastWriteSequence(finalEntries) + 1, markerBytes("PRINT", finalId, finalText));
    await pane.sendInput(finalCommand, true);
    await Promise.all([
      waitForCommand(server, created.id, finalCommand, "PRINT"),
      server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText, { timeoutMs: WAIT_TIMEOUT_MS }),
      finalWrite,
    ]);
    await expectTerminalBuffer(page, created.id, { contains: finalMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectKnownMarkerChanged(page, pane.xtermHost, beforeFinal, {
      minimumChangedRatio: 0.0002,
      testInfo,
      artifactName: "k-11-recovered-unicode-marker",
    });

    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await waitForCommand(server, created.id, `ECHO_INPUT ${echoId}`, "ECHO_INPUT");
    await server.waitForTranscript(created.id, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(echoText, true);
    const echoed = await server.waitForTranscript(created.id, (entry) => (
      entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === base64(echoText)
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    expect(echoed.payload_base64).toBe(base64(echoText));
    await expectTerminalBuffer(page, created.id, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    await pane.sendInput(`SIZE ${sizeId}`, true);
    await waitForCommand(server, created.id, `SIZE ${sizeId}`, "SIZE");
    const size = await server.waitForTranscript(created.id, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
    expect(size.cols).toBe(recovered.cols);
    expect(size.rows).toBe(recovered.rows);
    expect(size.pixel_width).toBe(recovered.pixelWidth);
    expect(size.pixel_height).toBe(recovered.pixelHeight);

    const finalSnapshot = await waitForCommittedSequence(page, created.id, outputBytes(await server.readTranscript(created.id)).length);
    await expectTerminalConverged(page, created.id, dimensions, { timeout: WAIT_TIMEOUT_MS });
    expect(finalSnapshot.socketState).toBe("connected");
    expect(finalSnapshot.acceptingInput).toBe(true);
    expect(finalSnapshot.activeSocketCount).toBe(1);
    expect(finalSnapshot.socket.activeCount).toBe(1);
    expect(finalSnapshot.pendingParserWrites).toBe(0);
    expect(finalSnapshot.pendingParserBytes).toBe(0);
    expect(finalSnapshot.renderBacklogBytes).toBe(0);
    expect(finalSnapshot.renderBacklogFrames).toBe(0);
    expect(finalSnapshot.syncTarget === undefined || finalSnapshot.committedSequence === undefined || finalSnapshot.committedSequence >= finalSnapshot.syncTarget).toBe(true);
    expect(finalSnapshot.xterm.text).not.toContain("\uFFFD");
    expect(countOccurrences(finalSnapshot.xterm.text, printMarker)).toBe(1);
    expect(countOccurrences(finalSnapshot.xterm.text, escapeMarker)).toBe(1);
    expect(countOccurrences(finalSnapshot.xterm.text, finalMarker)).toBe(1);
    expect(countOccurrences(finalSnapshot.xterm.text, echoMarker)).toBe(1);

    const entries = await server.readTranscript(created.id);
    expect(entries.filter((entry) => entry.event === "error")).toEqual([]);
    const expectedCommands = [
      `READY ${readyId}`,
      printCommand,
      escape.command,
      `UTF8_SPLIT ${firstSplitId} ${SPLIT_CASES[0]!.text} ${SPLIT_CASES[0]!.splitByte}`,
      `READY ${orderId}`,
      ...SPLIT_CASES.slice(1).map((splitCase) => `UTF8_SPLIT K11-SPLIT-${splitCase.id.toUpperCase()}-${runTag} ${splitCase.text} ${splitCase.splitByte}`),
      finalCommand,
      `ECHO_INPUT ${echoId}`,
      echoText,
      `SIZE ${sizeId}`,
    ];
    for (const command of expectedCommands) {
      expect(entries.filter((entry) => entry.event === "command" && entry.command_base64 === base64(command)), `fixture command duplicated or omitted: ${command}`).toHaveLength(1);
    }
    expect(entries.filter((entry) => entry.event === "utf8_split")).toHaveLength(SPLIT_CASES.length);
    expect(entries.filter((entry) => entry.event === "escape_split" && entry.id === escapeId)).toHaveLength(1);

    const fixtureModel = await modelFromFixture(finalSnapshot, entries);
    await recordingControl(page, "stop");
    recordingStopped = true;
    const recording = await exportRecording(page);
    assertCheckpointRecording(recording, created.id, checkpoint, UNICODE_TEXT);
    const serverModel = await modelFromServerRecording(finalSnapshot, recording, created.id);
    assertModelParity(finalSnapshot, fixtureModel, "fixture transcript model");
    assertModelParity(finalSnapshot, serverModel, "server snapshot model");

    const events = await terminalEvents(page, created.id);
    await assertMonotonicSequences(events);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.filter((event) => event.type === "socket-stale")).toEqual([]);
    expect(events.filter((event) => event.type === "socket-created")).toHaveLength(2);
    expect(events.filter((event) => event.type === "socket-close" && event.data.generation === previousGeneration)).toHaveLength(1);
    const networkEvents: readonly NetworkFaultEvent[] = faultController.events.filter((event) => event.terminalId === created.id);
    expect(networkEvents.filter((event) => event.type === "connection-open")).toHaveLength(2);
    expect(networkEvents.filter((event) => event.type === "connection-terminated" && event.generation === previousGeneration)).toHaveLength(1);
    // Binary checkpoint chunk frames carry kind byte 2 and the upload
    // sequence in their nine-byte header; the proxy decodes them as
    // binaryKind and sequence. The JSON `checkpointBinary` announcement is
    // not a chunk and is deliberately excluded from this count.
    const checkpointFrames = networkEvents.filter((event) => (
      event.type === "frame"
      && event.direction === "browser-to-server"
      && event.frame?.binaryKind === 2
      && event.frame.sequence === checkpointSequence
    ));
    expect(checkpointFrames.length).toBeGreaterThanOrEqual(checkpointChunks);

    const invariantReport = await expectTerminalInvariants(page, created.id, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
    await expectNoPendingRecovery(page, created.id, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      minimumNonBackgroundRatio: 0.001,
      testInfo,
      artifactName: "k-11-final-terminal",
    });
    expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);
    const browserFailures = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "console" && /^error:/i.test(entry.message)
    ));
    expect(browserFailures).toEqual([]);
  } finally {
    if (recordingStarted && !recordingStopped) await recordingControl(page, "stop");
    browserErrors.dispose();
  }
});
