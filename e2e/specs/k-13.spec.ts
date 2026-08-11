import { Buffer } from "node:buffer";
import { Terminal as HeadlessTerminal } from "../fixtures/headless-terminal.js"
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import type { NetworkFaultController, NetworkFaultEvent } from "../fixtures/network-faults.js";
import { test, expect, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
} from "../../src/client/lib/terminal-checkpoint.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 45_000;
const BROWSER_VIEWPORT = { width: 1_280, height: 800 } as const;
const REPAINT_BYTES = 4_096;
const QUERY_REPLY_NAMES = [
  "cursor",
  "mode",
  "identity",
  "window_size",
  "window_pixels",
  "cell_pixels",
] as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type CreatedTerminal = {
  readonly id: string;
  readonly name: string;
};

type DebugEvent = {
  readonly terminal?: string;
  readonly type?: string;
  readonly sequence?: number;
  readonly data?: string;
  readonly message?: Record<string, unknown>;
};

type DebugRecording = {
  readonly truncated: boolean;
  readonly events: readonly DebugEvent[];
};

type ModelState = {
  readonly activeBuffer: "normal" | "alternate";
  readonly cursorX: number;
  readonly cursorY: number;
  readonly viewportY: number;
  readonly text: string;
  readonly synchronizedOutputMode: boolean;
};

type DroppedCheckpoint = {
  readonly event: E2ETerminalEvent;
  readonly frames: readonly NetworkFaultEvent[];
};

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}


function recordingMessage(event: DebugEvent): Record<string, unknown> | undefined {
  if (event.type !== "control" || !event.message || typeof event.message !== "object") return undefined;
  return event.message;
}

function debugBytes(event: DebugEvent, label: string): Buffer {
  if (typeof event.data !== "string") throw new Error(`${label} snapshot omitted base64 data`);
  return Buffer.from(event.data, "base64");
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(1, needle.length);
  }
}

async function createFixtureTerminal(
  page: Page,
  terminalPath: string,
  shell: string,
): Promise<CreatedTerminal> {
  return page.evaluate(async ({ terminalPath: path, shellPath }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, cwd: "/tmp", shell: shellPath }),
    });
    if (!response.ok) throw new Error(`terminal creation failed with HTTP ${response.status}`);
    const value = await response.json() as Partial<CreatedTerminal>;
    if (typeof value.id !== "string" || typeof value.name !== "string") {
      throw new Error("terminal creation response omitted terminal identity");
    }
    return { id: value.id, name: value.name };
  }, { terminalPath, shellPath: shell });
}

async function waitForMountedPane(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.terminalId === id && event.snapshot.kind === "pane",
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledTerminal(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.serverViewport !== undefined
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && snapshot.syncMode === undefined
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
      && (snapshot.receivedSequence === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence === snapshot.receivedSequence)
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForCheckpointAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  generation: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, expectedGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "checkpoint"
      && event.snapshot.socketGeneration === expectedGeneration
      && event.data.result === "sent"
    ), { timeout, afterId: after });
  }, { id: terminalId, after: afterEventId, expectedGeneration: generation, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSnapshotSyncAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "sync"
      && event.data.mode === "snapshot"
    ), { timeout, afterId: after });
  }, { id: terminalId, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

function checkpointFramesSince(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
  occurrenceFloor: number,
): readonly NetworkFaultEvent[] {
  return events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpoint"
    && (event.frame.occurrence ?? 0) > occurrenceFloor
  ));
}

function latestCheckpointOccurrence(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
): number {
  return checkpointFramesSince(events, terminalId, generation, 0)
    .reduce((latest, event) => Math.max(latest, event.frame?.occurrence ?? 0), 0);
}

async function runWithDroppedCheckpoint(
  page: Page,
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
  action: () => Promise<void>,
  output: Promise<TranscriptEntry>,
): Promise<DroppedCheckpoint> {
  const beforeEvents = await terminalEvents(page, terminalId);
  const afterEventId = beforeEvents.at(-1)?.id ?? 0;
  const occurrenceFloor = latestCheckpointOccurrence(faultController.events, terminalId, generation);
  const matcher = {
    terminalId,
    generation,
    direction: "browser-to-server" as const,
    jsonType: "checkpoint",
  };
  const dropRule = faultController.drop(matcher);
  try {
    const checkpointPromise = waitForCheckpointAfter(page, terminalId, afterEventId, generation);
    await action();
    await output;
    const checkpoint = await checkpointPromise;
    const chunks = requiredNumber(checkpoint.data.chunks, "checkpoint chunk count");
    const size = requiredNumber(checkpoint.data.size, "checkpoint size");
    const sequence = requiredNumber(checkpoint.data.sequence, "checkpoint sequence");
    const epoch = requiredNumber(checkpoint.data.epoch, "checkpoint epoch");
    expect(size).toBeGreaterThan(0);
    expect(chunks).toBe(Math.ceil(size / TERMINAL_CHECKPOINT_CHUNK_BYTES));
    expect(checkpoint.snapshot.checkpointResult).toBe("sent");
    expect(checkpoint.snapshot.checkpointSequence).toBe(sequence);
    expect(checkpoint.snapshot.checkpointEpoch).toBe(epoch);
    expect(checkpoint.snapshot.committedSequence).toBe(sequence);
    expect(checkpoint.snapshot.gridEpoch).toBe(epoch);

    await faultController.waitFor((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "checkpoint"
      && checkpointFramesSince(faultController.events, terminalId, generation, occurrenceFloor).length >= chunks
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const uploadedFrames = checkpointFramesSince(
      faultController.events,
      terminalId,
      generation,
      occurrenceFloor,
    );
    expect(uploadedFrames).toHaveLength(chunks);
    expect(uploadedFrames.at(-1)?.frame?.occurrence).toBeGreaterThan(occurrenceFloor);
    const droppedEvents = faultController.events.filter((event) => (
      event.type === "dropped"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "browser-to-server"
    ));
    expect(droppedEvents.length).toBeGreaterThan(0);
    return { event: checkpoint, frames: uploadedFrames };
  } finally {
    faultController.restore(matcher);
    dropRule.dispose();
  }
}

async function runDroppedCommand(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
  command: string,
  outputPredicate: (entry: TranscriptEntry) => boolean,
): Promise<DroppedCheckpoint> {
  const operation = command.split(/\s+/, 1)[0] ?? "";
  const commandBytes = base64(command);
  const commandEntry = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === operation
      && entry.command_base64 === commandBytes,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const output = server.waitForTranscript(terminalId, outputPredicate, { timeoutMs: WAIT_TIMEOUT_MS });
  const result = await runWithDroppedCheckpoint(
    page,
    faultController,
    terminalId,
    generation,
    () => pane.sendInput(command, true),
    output,
  );
  await commandEntry;
  return result;
}

async function runDroppedAction(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
  action: () => Promise<void>,
  outputPredicate: (entry: TranscriptEntry) => boolean,
): Promise<DroppedCheckpoint> {
  const output = server.waitForTranscript(terminalId, outputPredicate, { timeoutMs: WAIT_TIMEOUT_MS });
  return runWithDroppedCheckpoint(
    page,
    faultController,
    terminalId,
    generation,
    action,
    output,
  );
}


async function recordingControl(
  page: Page,
  action: "clear" | "start" | "stop",
): Promise<Record<string, unknown>> {
  return page.evaluate(async (requestedAction) => {
    const response = await fetch("/api/debug/recording", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: requestedAction }),
    });
    if (!response.ok) throw new Error(`debug recording ${requestedAction} failed with HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  }, action);
}

async function exportRecording(page: Page): Promise<DebugRecording> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`debug recording export failed with HTTP ${response.status}`);
    const value = await response.json() as Partial<DebugRecording>;
    if (typeof value.truncated !== "boolean" || !Array.isArray(value.events)) {
      throw new Error("debug recording export omitted its event ledger");
    }
    return { truncated: value.truncated, events: value.events as readonly DebugEvent[] };
  });
}

function activeText(terminal: HeadlessTerminal): string {
  const active = terminal.buffer.active;
  const length = Math.min(active.length, 20_000);
  const lines: string[] = [];
  for (let index = 0; index < length; index += 1) {
    lines.push(active.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function inspectHeadlessTerminal(terminal: HeadlessTerminal): ModelState {
  const active = terminal.buffer.active;
  const modes = (terminal as HeadlessTerminal & {
    readonly modes?: { readonly synchronizedOutputMode?: boolean };
  }).modes;
  return {
    activeBuffer: active.type,
    cursorX: active.cursorX,
    cursorY: active.cursorY,
    viewportY: active.viewportY,
    text: activeText(terminal),
    synchronizedOutputMode: modes?.synchronizedOutputMode === true,
  };
}

async function writeHeadless(terminal: HeadlessTerminal, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      terminal.write(bytes, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

async function modelFromWrites(
  snapshot: E2ETerminalSnapshot,
  entries: readonly TranscriptEntry[],
): Promise<HeadlessTerminal> {
  const terminal = new HeadlessTerminal({
    allowProposedApi: true,
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: 200_000,
    ...tuiCompatibilityOptions(),
  });
  for (const entry of entries) {
    if (entry.event !== "write") continue;
    if (typeof entry.data_base64 !== "string") {
      terminal.dispose();
      throw new Error("fixture write transcript entry omitted data_base64");
    }
    await writeHeadless(terminal, Buffer.from(entry.data_base64, "base64"));
  }
  return terminal;
}
async function modelFromCanonicalSnapshot(
  snapshot: E2ETerminalSnapshot,
  bytes: Buffer,
): Promise<HeadlessTerminal> {
  const terminal = new HeadlessTerminal({
    allowProposedApi: true,
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: 200_000,
    ...tuiCompatibilityOptions(),
  });
  await writeHeadless(terminal, bytes);
  return terminal;
}

function modelDifferences(actual: ModelState, expected: ModelState): string[] {
  const differences: string[] = [];
  if (actual.activeBuffer !== expected.activeBuffer) differences.push("active-buffer");
  if (actual.cursorX !== expected.cursorX) differences.push("cursor-x");
  if (actual.cursorY !== expected.cursorY) differences.push("cursor-y");
  if (actual.viewportY !== expected.viewportY) differences.push("viewport-y");
  if (actual.text !== expected.text) differences.push("screen-text");
  if (actual.synchronizedOutputMode !== expected.synchronizedOutputMode) {
    differences.push("synchronized-output-mode");
  }
  return differences;
}

function controlEvents(recording: DebugRecording, terminalId: string, type: string): readonly DebugEvent[] {
  return recording.events.filter((event) => (
    event.terminal === terminalId
    && recordingMessage(event)?.type === type
  ));
}

function unexpectedBrowserErrors(
  collectors: readonly (() => readonly { kind: string; message: string }[])[],
): readonly { kind: string; message: string }[] {
  return collectors.flatMap((collector) => collector()).filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
}

test("K-13 Canonical fallback without browser checkpoint @nightly @p1 @checkpoint @canonical-fallback", async ({
  browser,
  baseURL,
  faultController,
  page,
  server,
}, testInfo: TestInfo) => {
  const initialErrors = installBrowserErrorCollectors(page);
  let freshContext: BrowserContext | undefined;
  let freshPage: Page | undefined;
  let freshErrors: BrowserErrorCollector | undefined;
  let recordingActive = false;
  const droppedCheckpoints: DroppedCheckpoint[] = [];
  const runTag = `K13-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const terminalPath = `k13-${runTag}`;
  const readyId = `${runTag}-READY`;
  const printId = `${runTag}-PRINT`;
  const printText = `${runTag}-NORMAL-é-猫-😀-✈️`;
  const colorsId = `${runTag}-COLORS`;
  const cursorId = `${runTag}-CURSOR`;
  const marginsId = `${runTag}-MARGINS`;
  const originId = `${runTag}-ORIGIN`;
  const wrapId = `${runTag}-WRAP`;
  const utf8Id = `${runTag}-UTF8`;
  const escapeId = `${runTag}-ESCAPE`;
  const altEnterId = `${runTag}-ALT-ENTER`;
  const repaintId = `${runTag}-REPAINT`;
  const queryId = `${runTag}-QUERY`;
  const syncBeginId = `${runTag}-SYNC-BEGIN`;
  const holdToken = `${runTag}-HOLD`;
  const altExitId = `${runTag}-ALT-EXIT`;
  const syncEndId = `${runTag}-SYNC-END`;
  const finalPrintId = `${runTag}-FINAL-PRINT`;
  const finalPrintText = `${runTag}-FINAL-LIVE`;
  const sizeId = `${runTag}-SIZE`;
  const echoId = `${runTag}-ECHO`;
  const inputText = `${runTag}-CONTINUED-INPUT`;
  const readyMarker = marker("READY", readyId);
  const releaseMarker = marker("RELEASE", holdToken);
  const normalMarker = marker("PRINT", printId, printText);
  const colorsIndexedMarker = marker("COLORS", colorsId, "INDEXED");
  const colorsTruecolorMarker = marker("COLORS", colorsId, "TRUECOLOR");
  const cursorMarker = marker("CURSOR", cursorId, "4", "9");
  const marginsMarker = marker("MARGINS", marginsId, "2", "20");
  const originMarker = marker("ORIGIN", originId, "on");
  const wrapMarker = marker("WRAP", wrapId, "off");
  const escapeMarker = marker("ESCAPE_SPLIT", escapeId);
  const repaintMarker = marker("REPAINT", repaintId, "FRAME");
  const queryMarker = marker("QUERY", queryId, "COMPLETE", "6");
  const syncBeginMarker = marker("SYNC_BEGIN", syncBeginId);
  const holdMarker = marker("HOLD", holdToken);
  const altExitMarker = marker("ALT_EXIT", altExitId);
  const syncEndMarker = marker("SYNC_END", syncEndId);
  const finalPrintMarker = marker("PRINT", finalPrintId, finalPrintText);
  const echoReadyMarker = marker("ECHO_INPUT", echoId, "READY");
  const echoPayloadMarker = marker("ECHO_INPUT", echoId, base64(inputText));

  try {
    await page.setViewportSize(BROWSER_VIEWPORT);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    await recordingControl(page, "clear");
    const recordingStatus = await recordingControl(page, "start");
    expect(recordingStatus.active).toBe(true);
    recordingActive = true;

    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const created = await createFixtureTerminal(page, terminalPath, server.fixturePath);
    await page.reload();
    await workbench.expectVisible();
    const mountedPromise = waitForMountedPane(page, created.id);
    const pane = await workbench.openTerminal({ id: created.id, name: created.name });
    const mounted = await mountedPromise;
    expect(mounted.terminalId).toBe(created.id);
    await pane.expectVisible();
    await expectTerminalSynchronized(page, created.id, { timeout: WAIT_TIMEOUT_MS });
    const settledInitial = await waitForSettledTerminal(page, created.id);
    expect(settledInitial.socketState).toBe("connected");
    expect(settledInitial.activeSocketCount).toBe(1);
    expect(settledInitial.serverViewport).toMatchObject({
      cols: settledInitial.cols,
      rows: settledInitial.rows,
      pixelWidth: settledInitial.pixelWidth,
      pixelHeight: settledInitial.pixelHeight,
    });
    expect(settledInitial.gridEpoch).toEqual(expect.any(Number));
    expect(settledInitial.committedSequence).toBe(settledInitial.receivedSequence);
    const dimensions = {
      cols: settledInitial.cols,
      rows: settledInitial.rows,
      pixelWidth: settledInitial.pixelWidth,
      pixelHeight: settledInitial.pixelHeight,
    } as const;
    await expectTerminalConverged(page, created.id, dimensions, { timeout: WAIT_TIMEOUT_MS });
    const initialWinch = await server.waitForTranscript(
      created.id,
      (entry) => entry.event === "sigwinch"
        && entry.source === "signal"
        && entry.rows === settledInitial.rows
        && entry.cols === settledInitial.cols,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(initialWinch.pixel_width).toBe(settledInitial.pixelWidth);
    expect(initialWinch.pixel_height).toBe(settledInitial.pixelHeight);

    const baselinePixels = await screenshotRegion(page, pane.xtermHost);
    const initialGeneration = settledInitial.socketGeneration;
    const checkpointsBeforeOutput = (await pane.events()).filter((event) => event.type === "checkpoint");
    expect(checkpointsBeforeOutput).toEqual([]);

    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `READY ${readyId}`,
      (entry) => entry.event === "ready" && entry.id === readyId,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `PRINT ${printId} ${printText}`,
      (entry) => entry.event === "print" && entry.id === printId && entry.text === printText,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `COLORS ${colorsId}`,
      (entry) => entry.event === "colors" && entry.id === colorsId,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `CURSOR ${cursorId} 4 9`,
      (entry) => entry.event === "cursor" && entry.id === cursorId && entry.row === 4 && entry.col === 9,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `MARGINS ${marginsId} 2 20`,
      (entry) => entry.event === "margins" && entry.id === marginsId && entry.top === 2 && entry.bottom === 20,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `ORIGIN ${originId} on`,
      (entry) => entry.event === "origin" && entry.id === originId && entry.enabled === true,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `WRAP ${wrapId} off`,
      (entry) => entry.event === "wrap" && entry.id === wrapId && entry.enabled === false,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `UTF8_SPLIT ${utf8Id} e\u0301 1`,
      (entry) => entry.event === "utf8_split" && entry.id === utf8Id && entry.text === "e\u0301" && entry.split === 1,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `ESCAPE_SPLIT ${escapeId} CSI_31M 3`,
      (entry) => entry.event === "escape_split"
        && entry.id === escapeId
        && entry.split === 3
        && entry.sequence_base64 === base64("\u001b[31m"),
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `ALT_ENTER ${altEnterId}`,
      (entry) => entry.event === "alt_enter" && entry.id === altEnterId,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `REPAINT ${repaintId} ${REPAINT_BYTES}`,
      (entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === REPAINT_BYTES,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `QUERY ${queryId}`,
      (entry) => entry.event === "query_complete" && entry.id === queryId && entry.replies === QUERY_REPLY_NAMES.length,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `SYNC_BEGIN ${syncBeginId}`,
      (entry) => entry.event === "sync_begin" && entry.id === syncBeginId,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      page,
      pane,
      server,
      faultController,
      created.id,
      initialGeneration,
      `HOLD ${holdToken}`,
      (entry) => entry.event === "hold" && entry.token === holdToken,
    ));

    const initialHeld = await waitForSettledTerminal(page, created.id);
    expect(initialHeld.activeBuffer).toBe("alternate");
    expect(initialHeld.xterm.text).toContain(repaintMarker);
    expect(initialHeld.xterm.text).toContain(queryMarker);
    expect(initialHeld.xterm.text).toContain(syncBeginMarker);
    expect(initialHeld.xterm.text).toContain(holdMarker);
    expect(initialHeld.xterm.text).not.toContain(normalMarker);
    expect(initialHeld.xterm.text).not.toContain("\uFFFD");
    expect(initialHeld.committedSequence).toBe(initialHeld.receivedSequence);
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: "k-13-initial-canonical-fallback-terminal",
    });
    const initialMarkerPixels = await expectKnownMarkerChanged(page, pane.xtermHost, baselinePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "k-13-initial-canonical-fallback-marker",
    });
    expect(initialMarkerPixels.after.width).toBe(baselinePixels.width);
    expect(initialMarkerPixels.after.height).toBe(baselinePixels.height);

    const preRecoveryTranscript = await server.readTranscript(created.id);
    const firstPageEvents = await terminalEvents(page, created.id);
    expect(firstPageEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(firstPageEvents.filter((event) => event.type === "socket-open")).toHaveLength(1);
    expect(firstPageEvents.filter((event) => event.type === "sync").map((event) => event.data.mode)).toEqual(["snapshot"]);
    expect(firstPageEvents.filter((event) => event.type === "synced")).toHaveLength(1);
    expect(firstPageEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(firstPageEvents.filter((event) => event.type === "socket-stale")).toEqual([]);
    await assertMonotonicSequences(firstPageEvents);

    const firstClose = faultController.waitFor((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === created.id
      && event.generation === initialGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await page.close();
    await firstClose;

    freshContext = await browser.newContext({ baseURL, viewport: BROWSER_VIEWPORT, deviceScaleFactor: 1 });
    freshPage = await freshContext.newPage();
    freshErrors = installBrowserErrorCollectors(freshPage);
    await freshPage.goto(baseURL);
    await new LoginPage(freshPage).login();
    const freshWorkbench = new WorkbenchPage(freshPage);
    await freshWorkbench.expectVisible();
    const freshMountPromise = waitForMountedPane(freshPage, created.id);
    const freshPane = await freshWorkbench.openTerminal({ id: created.id, name: created.name });
    const freshMount = await freshMountPromise;
    expect(freshMount.terminalId).toBe(created.id);
    await freshPane.expectVisible();
    const freshSync = await waitForSnapshotSyncAfter(freshPage, created.id, freshMount.id);
    const freshGeneration = freshSync.snapshot.socketGeneration;
    const freshSequence = requiredNumber(freshSync.data.sequence, "fresh synchronization sequence");
    expect(freshGeneration).toBeGreaterThan(initialGeneration);
    expect(freshSync.data.mode).toBe("snapshot");
    expect(freshSync.data.sequence).toEqual(expect.any(Number));
    const canonicalSnapshot = await waitForSettledTerminal(freshPage, created.id);
    expect(canonicalSnapshot.socketGeneration).toBe(freshGeneration);
    expect(canonicalSnapshot.activeBuffer).toBe("alternate");
    expect(canonicalSnapshot.xterm.text).toContain(repaintMarker);
    expect(canonicalSnapshot.xterm.text).toContain(queryMarker);
    expect(canonicalSnapshot.xterm.text).toContain(syncBeginMarker);
    expect(canonicalSnapshot.xterm.text).toContain(holdMarker);
    expect(canonicalSnapshot.xterm.text).not.toContain(normalMarker);
    expect(canonicalSnapshot.xterm.text).not.toContain("\uFFFD");
    expect(canonicalSnapshot.committedSequence).toBe(freshSequence);
    expect(canonicalSnapshot.receivedSequence).toBe(freshSequence);
    expect(canonicalSnapshot.serverViewport).toMatchObject({
      cols: dimensions.cols,
      rows: dimensions.rows,
      pixelWidth: dimensions.pixelWidth,
      pixelHeight: dimensions.pixelHeight,
    });
    await expectTerminalConverged(freshPage, created.id, dimensions, { timeout: WAIT_TIMEOUT_MS });
    droppedCheckpoints.push(await runDroppedCommand(
      freshPage,
      freshPane,
      server,
      faultController,
      created.id,
      freshGeneration,
      `RELEASE ${holdToken}`,
      (entry) => entry.event === "release" && entry.token === holdToken,
    ));
    const freshRecovered = await waitForSettledTerminal(freshPage, created.id);
    expect(freshRecovered.xterm.text).toContain(releaseMarker);
    expect(freshRecovered.socketGeneration).toBe(freshGeneration);
    expect(freshRecovered.syncMode).toBeUndefined();
    expect(freshRecovered.committedSequence).toBeGreaterThan(freshSequence);
    expect(freshRecovered.receivedSequence).toBe(freshRecovered.committedSequence);
    expect(freshRecovered.activeBuffer).toBe("alternate");
    expect(freshRecovered.serverViewport).toMatchObject({
      cols: dimensions.cols,
      rows: dimensions.rows,
      pixelWidth: dimensions.pixelWidth,
      pixelHeight: dimensions.pixelHeight,
    });
    expect(freshRecovered.xterm.text).toContain(repaintMarker);
    expect(freshRecovered.xterm.text).toContain(queryMarker);
    expect(freshRecovered.xterm.text).toContain(syncBeginMarker);
    expect(freshRecovered.xterm.text).toContain(holdMarker);
    expect(freshRecovered.xterm.text).not.toContain(normalMarker);
    expect(freshRecovered.xterm.text).not.toContain("\uFFFD");
    await expectTerminalNonBlank(freshPage, freshPane.xtermHost, {
      testInfo,
      artifactName: "k-13-canonical-snapshot-terminal",
    });
    const recoveredMarkerPixels = await expectKnownMarkerChanged(
      freshPage,
      freshPane.xtermHost,
      baselinePixels,
      {
        minimumChangedRatio: 0.002,
        testInfo,
        artifactName: "k-13-canonical-snapshot-marker",
      },
    );
    expect(recoveredMarkerPixels.after.width).toBe(baselinePixels.width);
    expect(recoveredMarkerPixels.after.height).toBe(baselinePixels.height);
    await expectTerminalConverged(freshPage, created.id, dimensions, { timeout: WAIT_TIMEOUT_MS });

    droppedCheckpoints.push(await runDroppedCommand(
      freshPage,
      freshPane,
      server,
      faultController,
      created.id,
      freshGeneration,
      `ALT_EXIT ${altExitId}`,
      (entry) => entry.event === "alt_exit" && entry.id === altExitId,
    ));
    const afterAlternateExit = await waitForSettledTerminal(freshPage, created.id);
    expect(afterAlternateExit.activeBuffer).toBe("normal");
    expect(afterAlternateExit.xterm.text).toContain(readyMarker);
    expect(afterAlternateExit.xterm.text).toContain(altExitMarker);
    expect(afterAlternateExit.xterm.text).toContain(colorsIndexedMarker);
    expect(afterAlternateExit.xterm.text).toContain(colorsTruecolorMarker);
    expect(afterAlternateExit.xterm.text).toContain(cursorMarker);
    expect(afterAlternateExit.xterm.text).toContain(marginsMarker);
    expect(afterAlternateExit.xterm.text).toContain(originMarker);
    expect(afterAlternateExit.xterm.text).toContain(wrapMarker);
    expect(afterAlternateExit.xterm.text).toContain(escapeMarker);
    expect(afterAlternateExit.xterm.text).toContain("e\u0301-猫-😀-✈️");
    expect(afterAlternateExit.xterm.text).not.toContain("\uFFFD");

    droppedCheckpoints.push(await runDroppedCommand(
      freshPage,
      freshPane,
      server,
      faultController,
      created.id,
      freshGeneration,
      `SYNC_END ${syncEndId}`,
      (entry) => entry.event === "sync_end" && entry.id === syncEndId,
    ));
    droppedCheckpoints.push(await runDroppedCommand(
      freshPage,
      freshPane,
      server,
      faultController,
      created.id,
      freshGeneration,
      `PRINT ${finalPrintId} ${finalPrintText}`,
      (entry) => entry.event === "print" && entry.id === finalPrintId && entry.text === finalPrintText,
    ));
    const sizeEntryPromise = server.waitForTranscript(
      created.id,
      (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    droppedCheckpoints.push(await runDroppedCommand(
      freshPage,
      freshPane,
      server,
      faultController,
      created.id,
      freshGeneration,
      `SIZE ${sizeId}`,
      (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl",
    ));
    const sizeEntry = await sizeEntryPromise;
    expect(sizeEntry.rows).toBe(dimensions.rows);
    expect(sizeEntry.cols).toBe(dimensions.cols);
    expect(sizeEntry.pixel_width).toBe(dimensions.pixelWidth);
    expect(sizeEntry.pixel_height).toBe(dimensions.pixelHeight);
    expect(sizeEntry.rows).toBe(freshRecovered.rows);
    expect(sizeEntry.cols).toBe(freshRecovered.cols);
    await expectTerminalBuffer(freshPage, created.id, {
      contains: marker("SIZE", sizeId, String(sizeEntry.rows), String(sizeEntry.cols)),
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    droppedCheckpoints.push(await runDroppedCommand(
      freshPage,
      freshPane,
      server,
      faultController,
      created.id,
      freshGeneration,
      `ECHO_INPUT ${echoId}`,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    ));
    droppedCheckpoints.push(await runDroppedAction(
      freshPage,
      freshPane,
      server,
      faultController,
      created.id,
      freshGeneration,
      async () => {
        await freshPane.insertText(inputText);
        await freshPane.press("Enter");
      },
      (entry) => entry.event === "echo_input"
        && entry.id === echoId
        && entry.phase === "payload"
        && entry.payload_base64 === base64(inputText),
    ));
    const finalSnapshot = await waitForSettledTerminal(freshPage, created.id);
    expect(finalSnapshot.socketGeneration).toBe(freshGeneration);
    expect(finalSnapshot.socketState).toBe("connected");
    expect(finalSnapshot.activeSocketCount).toBe(1);
    expect(finalSnapshot.socket.activeCount).toBe(1);
    expect(finalSnapshot.acceptingInput).toBe(true);
    expect(finalSnapshot.serverViewport).toMatchObject({
      cols: finalSnapshot.cols,
      rows: finalSnapshot.rows,
      pixelWidth: finalSnapshot.pixelWidth,
      pixelHeight: finalSnapshot.pixelHeight,
    });
    expect(finalSnapshot.xterm.text).toContain(syncEndMarker);
    expect(finalSnapshot.xterm.text).toContain(finalPrintMarker);
    expect(countOccurrences(finalSnapshot.xterm.text, finalPrintMarker)).toBe(1);
    expect(finalSnapshot.xterm.text).toContain(echoReadyMarker);
    expect(finalSnapshot.xterm.text).toContain(echoPayloadMarker);
    expect(countOccurrences(finalSnapshot.xterm.text, echoPayloadMarker)).toBe(1);
    await expectTerminalNonBlank(freshPage, freshPane.xtermHost, {
      testInfo,
      artifactName: "k-13-final-terminal",
    });
    await assertNoPendingSynchronization(finalSnapshot);
    await expectNoPendingRecovery(freshPage, created.id, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(freshPage, created.id, { timeout: WAIT_TIMEOUT_MS });

    const finalEvents = await terminalEvents(freshPage, created.id);
    expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "socket-open")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "sync").map((event) => event.data.mode)).toEqual(["snapshot"]);
    expect(finalEvents.filter((event) => event.type === "synced")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "socket-stale")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
    await assertMonotonicSequences(finalEvents);
    const invariantReport = await expectConnectedTerminalInvariants(freshPage, created.id, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
    assertNoUnexpectedSocketMultiplication([settledInitial, initialHeld, freshRecovered, afterAlternateExit, finalSnapshot]);

    const finalTranscript = await server.readTranscript(created.id);
    expect(finalTranscript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(finalTranscript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === printId && entry.text === printText)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "colors" && entry.id === colorsId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "cursor" && entry.id === cursorId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "margins" && entry.id === marginsId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "origin" && entry.id === originId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "wrap" && entry.id === wrapId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "utf8_split" && entry.id === utf8Id)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "escape_split" && entry.id === escapeId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "alt_enter" && entry.id === altEnterId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "repaint" && entry.id === repaintId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "query_complete" && entry.id === queryId && entry.replies === QUERY_REPLY_NAMES.length)).toHaveLength(1);
    const queryReplies = finalTranscript.filter((entry) => entry.event === "query_reply" && entry.id === queryId);
    expect(queryReplies).toHaveLength(QUERY_REPLY_NAMES.length);
    expect(queryReplies.map((entry) => entry.name)).toEqual([...QUERY_REPLY_NAMES]);
    expect(finalTranscript.filter((entry) => entry.event === "sync_begin" && entry.id === syncBeginId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "hold" && entry.token === holdToken)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "alt_exit" && entry.id === altExitId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "sync_end" && entry.id === syncEndId)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === finalPrintId && entry.text === finalPrintText)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl")).toHaveLength(1);
    const echoPayloads = finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload");
    expect(echoPayloads).toHaveLength(1);
    expect(echoPayloads[0]?.payload_base64).toBe(base64(inputText));
    const winches = finalTranscript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal");
    expect(winches.length).toBeGreaterThan(0);
    let previousWinchSequence = 0;
    for (const entry of winches) {
      const sequence = requiredNumber(entry.signal_sequence, "SIGWINCH sequence");
      expect(sequence).toBeGreaterThan(previousWinchSequence);
      previousWinchSequence = sequence;
    }
    expect(winches.at(-1)?.rows).toBe(finalSnapshot.rows);
    expect(winches.at(-1)?.cols).toBe(finalSnapshot.cols);

    await recordingControl(freshPage, "stop");
    recordingActive = false;
    const recording = await exportRecording(freshPage);
    expect(recording.truncated).toBe(false);
    const recordingEvents = recording.events.filter((event) => event.terminal === created.id);
    expect(recordingEvents.length).toBeGreaterThan(0);
    const acceptedCheckpointNotes = recordingEvents.filter((event) => {
      const message = recordingMessage(event);
      return message?.type === "recording" && message.event === "xterm checkpoint stored";
    });
    expect(acceptedCheckpointNotes).toEqual([]);

    const syncRecords = controlEvents(recording, created.id, "sync");
    expect(syncRecords).toHaveLength(2);
    expect(syncRecords.map((event) => recordingMessage(event)?.mode)).toEqual(["snapshot", "snapshot"]);
    const freshSyncRecord = syncRecords.at(-1);
    if (!freshSyncRecord) throw new Error("server recording omitted fresh canonical sync");
    expect(recordingMessage(freshSyncRecord)?.sequence).toBe(freshSync.data.sequence);
    const freshSnapshotSequence = requiredNumber(freshSync.data.sequence, "fresh canonical snapshot sequence");
    const canonicalSnapshotRecords = recordingEvents.filter((event) => (
      event.type === "snapshot" && event.sequence === freshSnapshotSequence
    ));
    expect(canonicalSnapshotRecords).toHaveLength(1);
    const canonicalSnapshotBytes = debugBytes(canonicalSnapshotRecords[0]!, "canonical");
    expect(canonicalSnapshotBytes.byteLength).toBeGreaterThan(0);

    const fixtureModel = await modelFromWrites(canonicalSnapshot, preRecoveryTranscript);
    const canonicalModel = await modelFromCanonicalSnapshot(canonicalSnapshot, canonicalSnapshotBytes);
    try {
      const fixtureState = inspectHeadlessTerminal(fixtureModel);
      const canonicalState = inspectHeadlessTerminal(canonicalModel);
      expect(fixtureState.synchronizedOutputMode).toBe(true);
      expect(canonicalState.synchronizedOutputMode).toBe(false);
      const differences = modelDifferences(canonicalState, fixtureState);
      // The canonical snapshot intentionally omits only temporary synchronized
      // output mode. Any newly missing screen, cursor, buffer, or Unicode state
      // is a regression rather than an accepted fallback difference.
      expect(differences).toEqual(["synchronized-output-mode"]);
      expect(canonicalState.activeBuffer).toBe("alternate");
      expect(canonicalState.text).toContain(repaintMarker);
      expect(canonicalState.text).toContain(queryMarker);
      expect(canonicalState.text).toContain(syncBeginMarker);
      expect(canonicalState.text).toContain(holdMarker);
      expect(canonicalState.text).not.toContain(normalMarker);
      expect(canonicalState.text).not.toContain("\uFFFD");
      expect(canonicalSnapshot.activeBuffer).toBe(canonicalState.activeBuffer);
      expect(canonicalSnapshot.xterm.cursorX).toBe(canonicalState.cursorX);
      expect(canonicalSnapshot.xterm.cursorY).toBe(canonicalState.cursorY);
      expect(canonicalSnapshot.xterm.viewportY).toBe(canonicalState.viewportY);
      expect(canonicalSnapshot.xterm.text).toBe(canonicalState.text);
    } finally {
      fixtureModel.dispose();
      canonicalModel.dispose();
    }

    const browserCheckpointEvents = [
      ...firstPageEvents,
      ...finalEvents,
    ].filter((event) => event.type === "checkpoint");
    expect(browserCheckpointEvents.length).toBe(droppedCheckpoints.length);
    expect(browserCheckpointEvents.every((event) => event.data.result === "sent")).toBe(true);
    expect(droppedCheckpoints.length).toBeGreaterThan(0);
    const networkCheckpointFrames = faultController.events.filter((event) => (
      event.type === "frame"
      && event.terminalId === created.id
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "checkpoint"
    ));
    const expectedDroppedFrames = droppedCheckpoints.reduce((total, checkpoint) => total + checkpoint.frames.length, 0);
    expect(networkCheckpointFrames.length).toBe(expectedDroppedFrames);
    const networkDrops = faultController.events.filter((event) => (
      event.type === "dropped"
      && event.terminalId === created.id
      && event.direction === "browser-to-server"
    ));
    expect(networkDrops.length).toBeGreaterThanOrEqual(droppedCheckpoints.length);
    expect(recordingEvents.filter((event) => event.type === "snapshot").length).toBeGreaterThanOrEqual(2);

    const freshClose = faultController.waitFor((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === created.id
      && event.generation === freshGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await freshContext.close();
    freshContext = undefined;
    freshPage = undefined;
    await freshClose;

    expect(unexpectedBrowserErrors([initialErrors, freshErrors!])).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error|internal server error)/i);
  } finally {
    if (recordingActive && freshPage && !freshPage.isClosed()) {
      await recordingControl(freshPage, "stop").catch(() => undefined);
    }
    if (freshContext) await freshContext.close();
    initialErrors.dispose();
    freshErrors?.dispose();
  }
});
