import type { Page } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultController, NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
} from "../../src/client/lib/terminal-checkpoint.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 60_000;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const PRIVATE_MODE_STATUS_BYTES = 8;
const MOUSE_CAPTURE_CELL = { col: 3, row: 2 } as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type QueryEntry = TranscriptEntry & {
  readonly id: string;
  readonly name: string;
  readonly raw_base64?: string;
};

interface CreatedTerminal {
  readonly id: string;
  readonly name: string;
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function commandBase64(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function hex(value: string | Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, needle.length);
  }
  return count;
}

function lastEventId(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.id), -1);
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}
async function createFixtureTerminal(page: Page, path: string, shell: string): Promise<CreatedTerminal> {
  return page.evaluate(async ({ terminalPath, fixtureShell }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: terminalPath, cwd: "/tmp", shell: fixtureShell }),
    });
    if (!response.ok) throw new Error(`terminal creation failed with HTTP ${response.status}`);
    const payload = await response.json() as { id?: unknown; name?: unknown };
    if (typeof payload.id !== "string" || typeof payload.name !== "string") {
      throw new Error("terminal creation response is missing id or name");
    }
    return { id: payload.id, name: payload.name };
  }, { terminalPath: path, fixtureShell: shell });
}

async function waitForMountedPane(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.snapshot.kind === "pane" && event.terminalId === id,
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
      && snapshot.acceptingInput
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}


async function waitForParserMarker(
  page: Page,
  terminalId: string,
  afterEventId: number,
  expected: string,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, markerText, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "parser-commit"
        && event.snapshot.xterm.text.includes(markerText),
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, markerText: expected, timeout: WAIT_TIMEOUT_MS });
}

async function sendFixtureCommand(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  command: string,
  operation: string,
): Promise<TranscriptEntry> {
  await pane.sendInput(command, true);
  return server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === operation
    && entry.command_base64 === commandBase64(command)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

async function sendVisibleFixtureCommand(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  command: string,
  operation: string,
  expectedMarker: string,
): Promise<E2ETerminalEvent> {
  const floor = lastEventId(await pane.events());
  await sendFixtureCommand(pane, server, terminalId, command, operation);
  return waitForParserMarker(page, terminalId, floor, expectedMarker);
}

async function waitForCheckpointSent(
  page: Page,
  terminalId: string,
  afterEventId: number,
  minimumSequence: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "checkpoint"
      && event.data.result === "sent"
      && typeof event.data.sequence === "number"
      && event.data.sequence >= minimum
    ), { timeout });
  }, { id: terminalId, after: afterEventId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
}

function checkpointFrames(
  controller: NetworkFaultController,
  terminalId: string,
  generation: number,
  afterOccurrence: number,
): readonly NetworkFaultEvent[] {
  return controller.events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpoint"
    && (event.frame.occurrence ?? 0) > afterOccurrence
  ));
}

async function waitForCheckpointFrames(
  controller: NetworkFaultController,
  terminalId: string,
  generation: number,
  minimumOccurrence: number,
): Promise<void> {
  await controller.waitFor((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpoint"
    && (event.frame.occurrence ?? 0) >= minimumOccurrence
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

async function captureInput(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  captureId: string,
  expected: Uint8Array,
  action: () => Promise<void>,
): Promise<TranscriptEntry> {
  await sendFixtureCommand(
    pane,
    server,
    terminalId,
    `CAPTURE_INPUT ${captureId} ${expected.byteLength}`,
    "CAPTURE_INPUT",
  );
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "capture_input"
    && entry.id === captureId
    && entry.phase === "armed"
    && entry.bytes === expected.byteLength
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await action();
  const complete = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "capture_input"
    && entry.id === captureId
    && entry.phase === "complete"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(complete.bytes).toBe(expected.byteLength);
  expect(complete.payload_base64).toBe(base64(expected));
  return complete;
}

async function moveCell(
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
  await pane.page.mouse.move(box.x + (col - 0.5) * cellWidth, box.y + (row - 0.5) * cellHeight);
}

async function capturePaste(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  captureId: string,
  text: string,
): Promise<void> {
  const expected = Buffer.concat([
    Buffer.from("\x1b[200~", "binary"),
    Buffer.from(text, "utf8"),
    Buffer.from("\x1b[201~", "binary"),
  ]);
  await captureInput(pane, server, terminalId, captureId, expected, async () => {
    await page.evaluate(async (value) => {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard write API is unavailable");
      await navigator.clipboard.writeText(value);
    }, text);
    await pane.openActions();
    await pane.root.getByRole("menuitem", { name: "Paste", exact: true }).click();
  });
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("CAPTURE_INPUT", captureId, "COMPLETE"),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
}

async function kittyQuery(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
  expectedFlags: number,
): Promise<string> {
  const command = `KITTY ${id} QUERY`;
  const commandEntry = await sendFixtureCommand(pane, server, terminalId, command, "KITTY");
  const reply = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "kitty_reply"
    && entry.id === id
    && entry.payload_base64 === base64(`\x1b[?${expectedFlags}u`)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(reply.payload_base64).toBe(base64(`\x1b[?${expectedFlags}u`));
  const replies = (await server.readTranscript(terminalId)).filter((entry) => (
    entry.event === "kitty_reply" && entry.id === id
  ));
  expect(replies).toHaveLength(1);
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("KITTY", id, "COMPLETE"),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(commandEntry.operation).toBe("KITTY");
  return String(reply.payload_base64);
}

async function privateModeQuery(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
  mode: number,
  status: number,
): Promise<string> {
  const request = Buffer.from(`\x1b[?${mode}$p`, "binary");
  const response = Buffer.from(`\x1b[?${mode};${status}$y`, "binary");
  expect(response.byteLength).toBe(PRIVATE_MODE_STATUS_BYTES + (mode >= 1000 ? String(mode).length - 1 : 0));
  const command = `QUERY_BYTES ${id} ${response.byteLength} ${hex(request)}`;
  await sendFixtureCommand(pane, server, terminalId, command, "QUERY_BYTES");
  const complete = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "capture_input"
    && entry.id === id
    && entry.phase === "complete"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(complete.bytes).toBe(response.byteLength);
  expect(complete.payload_base64).toBe(base64(response));
  const completes = (await server.readTranscript(terminalId)).filter((entry) => (
    entry.event === "capture_input" && entry.id === id && entry.phase === "complete"
  ));
  expect(completes).toHaveLength(1);
  return String(complete.payload_base64);
}

async function standardQuery(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
): Promise<Record<string, string>> {
  await sendFixtureCommand(pane, server, terminalId, `QUERY ${id}`, "QUERY");
  const complete = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "query_complete" && entry.id === id && entry.replies === 6
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(complete.replies).toBe(6);
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("QUERY", id, "COMPLETE", "6"),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const entries = await server.readTranscript(terminalId);
  const replies = entries.filter((entry): entry is QueryEntry => entry.event === "query_reply" && entry.id === id);
  expect(replies).toHaveLength(6);
  expect(replies.map((entry) => entry.name)).toEqual([
    "cursor",
    "mode",
    "identity",
    "window_size",
    "window_pixels",
    "cell_pixels",
  ]);
  expect(replies.every((entry) => typeof entry.raw_base64 === "string")).toBe(true);
  expect(entries.filter((entry) => entry.event === "query_incomplete" && entry.id === id)).toHaveLength(0);
  return Object.fromEntries(replies.map((entry) => [entry.name, String(entry.raw_base64)]));
}

function cursorCellDifference(
  before: TerminalPixelImage,
  after: TerminalPixelImage,
  snapshot: E2ETerminalSnapshot,
): number {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error("cursor screenshots have different dimensions");
  }
  const cellWidth = before.width / snapshot.cols;
  const cellHeight = before.height / snapshot.rows;
  const left = Math.max(0, Math.floor(snapshot.xterm.cursorX * cellWidth));
  const top = Math.max(0, Math.floor(snapshot.xterm.cursorY * cellHeight));
  const right = Math.min(before.width, Math.ceil((snapshot.xterm.cursorX + 1) * cellWidth));
  const bottom = Math.min(before.height, Math.ceil((snapshot.xterm.cursorY + 1) * cellHeight));
  let changed = 0;
  let total = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * before.width + x) * 4;
      total += 1;
      const distance = Math.max(
        Math.abs(before.data[offset]! - after.data[offset]!),
        Math.abs(before.data[offset + 1]! - after.data[offset + 1]!),
        Math.abs(before.data[offset + 2]! - after.data[offset + 2]!),
        Math.abs(before.data[offset + 3]! - after.data[offset + 3]!),
      );
      if (distance > 24) changed += 1;
    }
  }
  return total === 0 ? 1 : changed / total;
}

function checkpointFrameOccurrence(
  controller: NetworkFaultController,
  terminalId: string,
  generation: number,
): number {
  return controller.events.reduce((maximum, event) => {
    if (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "checkpoint"
    ) {
      return Math.max(maximum, event.frame.occurrence ?? 0);
    }
    return maximum;
  }, 0);
}

async function waitForSocketEvent(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: "socket-close" | "sync" | "synced",
  generation?: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, socketGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === eventType
      && (socketGeneration === undefined || event.snapshot.socketGeneration === socketGeneration)
    ), { timeout });
  }, { id: terminalId, after: afterEventId, eventType: type, socketGeneration: generation, timeout: WAIT_TIMEOUT_MS });
}

function writeByteCount(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((total, entry) => (
    entry.event === "write" && typeof entry.bytes === "number" ? total + entry.bytes : total
  ), 0);
}

test("K-10 Modes and private state checkpoint @nightly @p1 @checkpoint @modes @queries", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `K10-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}-${Date.now()}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const terminalPath = `k10-${runTag}`;
  const readyId = `${runTag}-READY`;
  const cursorId = `${runTag}-CURSOR`;
  const colorsId = `${runTag}-COLORS`;
  const marginsId = `${runTag}-MARGINS`;
  const originId = `${runTag}-ORIGIN`;
  const wrapId = `${runTag}-WRAP`;
  const mouseAnyId = `${runTag}-MOUSE-ANY`;
  const mouseSgrId = `${runTag}-MOUSE-SGR`;
  const bracketId = `${runTag}-BRACKET`;
  const kittyNormalId = `${runTag}-KITTY-NORMAL`;
  const kittyAltId = `${runTag}-KITTY-ALT`;
  const savedSetupId = `${runTag}-SAVED-SETUP`;
  const cursorStyleId = `${runTag}-CURSOR-STYLE`;
  const syncId = `${runTag}-SYNC`;
  const syncPrintId = `${runTag}-SYNC-PRINT`;
  const preMouseCaptureId = `${runTag}-MOUSE-PRE`;
  const postMouseCaptureId = `${runTag}-MOUSE-POST`;
  const prePasteCaptureId = `${runTag}-PASTE-PRE`;
  const postPasteCaptureId = `${runTag}-PASTE-POST`;
  const preQueryId = `${runTag}-QUERY-A`;
  const postQueryId = `${runTag}-QUERY-B`;
  const preResetId = `${runTag}-RESET-A`;
  const postResetId = `${runTag}-RESET-B`;
  const preModePrefix = `${runTag}-MODE-PRE`;
  const postModePrefix = `${runTag}-MODE-POST`;
  const finalPrintId = `${runTag}-FINAL`;
  const finalPrintText = `${runTag}-POST-SYNC-VISIBLE`;
  const echoId = `${runTag}-ECHO`;
  const echoText = `${runTag}-CONTINUED-INPUT`;
  const sizeId = `${runTag}-SIZE`;
  const savedMoved = `K10-SAVED-MOVED-${runTag}`;
  const savedInitial = `K10-SAVED-INITIAL-${runTag}`;
  const savedPreProbe = `K10-SAVED-ONE-${runTag}`;
  const savedRecovered = `K10-SAVED-TWO-${runTag}`;
  const syncText = `K10-SYNC-FRAME-${runTag}`;
  const readyMarker = marker("READY", readyId);
  const syncMarker = marker("PRINT", syncPrintId, syncText);
  const finalMarker = marker("PRINT", finalPrintId, finalPrintText);
  const mouseBefore = Buffer.concat([
    Buffer.from(`\x1b[<0;${MOUSE_CAPTURE_CELL.col};${MOUSE_CAPTURE_CELL.row}M`, "binary"),
    Buffer.from(`\x1b[<0;${MOUSE_CAPTURE_CELL.col};${MOUSE_CAPTURE_CELL.row}m`, "binary"),
  ]);
  const pasteText = `${runTag}-PASTE-A\n${runTag}-PASTE-B`;
  let terminalId = "";
  let terminalName = "";

  try {
    await page.setViewportSize({ width: 1_280, height: 800 });
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    const origin = new URL(baseURL).origin;
    const clipboardAvailable = await page.evaluate(() => (
      typeof navigator.clipboard?.readText === "function"
      && typeof navigator.clipboard?.writeText === "function"
    ));
    if (!clipboardAvailable) throw new Error("K-10 requires the browser clipboard API");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await workbench.expectVisible();

    const created = await createFixtureTerminal(page, terminalPath, server.fixturePath);
    terminalId = created.id;
    terminalName = created.name;
    await page.reload({ waitUntil: "load" });
    await workbench.expectVisible();
    const mountedPromise = waitForMountedPane(page, terminalId);
    const pane = await workbench.openTerminal({ id: terminalId, name: terminalName });
    const mounted = await mountedPromise;
    expect(mounted.terminalId).toBe(terminalId);
    await pane.expectVisible();
    await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await pane.focus();

    const initial = await waitForSettledTerminal(page, terminalId);
    expect(initial.cols).toBeGreaterThan(0);
    expect(initial.rows).toBeGreaterThan(0);
    expect(initial.serverViewport).toBeDefined();
    expect(initial.serverViewport?.cols).toBe(initial.cols);
    expect(initial.serverViewport?.rows).toBe(initial.rows);
    expect(initial.serverViewport?.pixelWidth).toBe(initial.pixelWidth);
    expect(initial.serverViewport?.pixelHeight).toBe(initial.pixelHeight);
    expect(initial.gridEpoch).toEqual(expect.any(Number));
    const initialPixels = await screenshotRegion(page, pane.xtermHost);
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: "k-10-initial-terminal",
    });

    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `READY ${readyId}`,
      "READY",
      readyMarker,
    );

    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `CURSOR ${cursorId} 3 7`,
      "CURSOR",
      marker("CURSOR", cursorId, "3", "7"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `COLORS ${colorsId}`,
      "COLORS",
      marker("COLORS", colorsId, "INDEXED"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `MARGINS ${marginsId} 2 5`,
      "MARGINS",
      marker("MARGINS", marginsId, "2", "5"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `ORIGIN ${originId} on`,
      "ORIGIN",
      marker("ORIGIN", originId, "on"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `WRAP ${wrapId} off`,
      "WRAP",
      marker("WRAP", wrapId, "off"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `MOUSE ${mouseAnyId} enable drag`,
      "MOUSE",
      marker("MOUSE", mouseAnyId, "ENABLE"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `MOUSE ${mouseSgrId} enable sgr`,
      "MOUSE",
      marker("MOUSE", mouseSgrId, "ENABLE"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `BYTES ${bracketId} ${hex("\x1b[?2004h")}`,
      "BYTES",
      marker("BYTES", bracketId, "EMIT"),
    );

    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `KITTY ${kittyNormalId} SET 1`,
      "KITTY",
      marker("KITTY", kittyNormalId, "SET"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `KITTY ${kittyNormalId} PUSH 3`,
      "KITTY",
      marker("KITTY", kittyNormalId, "PUSH"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `KITTY ${kittyNormalId} PUSH 7`,
      "KITTY",
      marker("KITTY", kittyNormalId, "PUSH"),
    );
    await kittyQuery(page, pane, server, terminalId, `${kittyNormalId}-INITIAL`, 7);

    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `ALT_ENTER ${kittyAltId}`,
      "ALT_ENTER",
      marker("ALT_ENTER", kittyAltId),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `KITTY ${kittyAltId} SET 2`,
      "KITTY",
      marker("KITTY", kittyAltId, "SET"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `KITTY ${kittyAltId} PUSH 5`,
      "KITTY",
      marker("KITTY", kittyAltId, "PUSH"),
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `KITTY ${kittyAltId} PUSH 9`,
      "KITTY",
      marker("KITTY", kittyAltId, "PUSH"),
    );
    await kittyQuery(page, pane, server, terminalId, `${kittyAltId}-INITIAL`, 9);
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `ALT_EXIT ${kittyAltId}`,
      "ALT_EXIT",
      marker("ALT_EXIT", kittyAltId),
    );

    const savedSetupBytes = Buffer.from(
      `\x1b[?6l\x1b[1;1H\x1b7\x1b[5;1H${savedMoved}\x1b8${savedInitial}\x1b[?6h`,
      "utf8",
    );
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `BYTES ${savedSetupId} ${hex(savedSetupBytes)}`,
      "BYTES",
      marker("BYTES", savedSetupId, "EMIT"),
    );
    await expectTerminalBuffer(page, terminalId, { contains: savedMoved, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: savedInitial, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `BYTES ${cursorStyleId} ${hex("\x1b[6 q")}`,
      "BYTES",
      marker("BYTES", cursorStyleId, "EMIT"),
    );

    await sendFixtureCommand(pane, server, terminalId, `SYNC_BEGIN ${syncId}`, "SYNC_BEGIN");
    await server.waitForTranscript(terminalId, (entry) => entry.event === "sync_begin" && entry.id === syncId, { timeoutMs: WAIT_TIMEOUT_MS });
    await sendFixtureCommand(pane, server, terminalId, `PRINT ${syncPrintId} ${syncText}`, "PRINT");
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === syncPrintId && entry.text === syncText, { timeoutMs: WAIT_TIMEOUT_MS });
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `SYNC_END ${syncId}`,
      "SYNC_END",
      marker("SYNC_END", syncId),
    );
    await expectTerminalBuffer(page, terminalId, { contains: syncMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const beforeModes = await waitForSettledTerminal(page, terminalId);
    await moveCell(pane, beforeModes, MOUSE_CAPTURE_CELL.col, MOUSE_CAPTURE_CELL.row);
    await captureInput(
      pane,
      server,
      terminalId,
      preMouseCaptureId,
      mouseBefore,
      async () => {
        await pane.page.mouse.down();
        await pane.page.mouse.up();
      },
    );
    await capturePaste(page, pane, server, terminalId, prePasteCaptureId, pasteText);

    const preModeResponses: Record<number, string> = {};
    for (const [mode, status] of [[6, 1], [7, 2], [12, 1], [1000, 2], [1002, 1], [1003, 2], [1006, 1], [1016, 2], [2004, 1], [2026, 2]] as const) {
      preModeResponses[mode] = await privateModeQuery(
        pane,
        server,
        terminalId,
        `${preModePrefix}-${mode}`,
        mode,
        status,
      );
    }
    await kittyQuery(page, pane, server, terminalId, `${kittyNormalId}-PRE`, 7);

    const preResetBytes = Buffer.from(`\x1b8\x1b[6 q\x1b[?6h${savedPreProbe}`, "binary");
    await sendVisibleFixtureCommand(
      page,
      pane,
      server,
      terminalId,
      `BYTES ${preResetId} ${hex(preResetBytes)}`,
      "BYTES",
      marker("BYTES", preResetId, "EMIT"),
    );
    await expectTerminalBuffer(page, terminalId, { contains: savedPreProbe, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const preQueries = await standardQuery(page, pane, server, terminalId, preQueryId);
    const preCursorResponse = Buffer.from(preQueries.cursor ?? "", "base64").toString("binary");
    expect(preCursorResponse).toMatch(/^\x1b\[1;[0-9]+R$/);

    const preQuerySnapshot = await waitForSettledTerminal(page, terminalId);
    if (preQuerySnapshot.committedSequence === undefined) throw new Error("pre-checkpoint committed sequence is unavailable");
    if (preQuerySnapshot.gridEpoch === undefined) throw new Error("pre-checkpoint grid epoch is unavailable");
    const preQueryFloor = lastEventId(await terminalEvents(page, terminalId));
    const checkpointFrameFloor = checkpointFrameOccurrence(
      faultController,
      terminalId,
      preQuerySnapshot.socketGeneration,
    );
    const checkpointPromise = waitForCheckpointSent(
      page,
      terminalId,
      preQueryFloor,
      preQuerySnapshot.committedSequence,
    );
    const checkpoint = await checkpointPromise;
    const checkpointSequence = requiredNumber(checkpoint.data.sequence, "K-10 checkpoint sequence");
    const checkpointEpoch = requiredNumber(checkpoint.data.epoch, "K-10 checkpoint epoch");
    const checkpointSize = requiredNumber(checkpoint.data.size, "K-10 checkpoint size");
    const checkpointChunks = requiredNumber(checkpoint.data.chunks, "K-10 checkpoint chunks");
    const serializationDuration = requiredNumber(
      checkpoint.data.serializationDurationMs,
      "K-10 checkpoint serialization duration",
    );
    const uploadDuration = requiredNumber(checkpoint.data.uploadDurationMs, "K-10 checkpoint upload duration");
    expect(checkpoint.data.result).toBe("sent");
    expect(checkpointSequence).toBe(preQuerySnapshot.committedSequence);
    expect(checkpointEpoch).toBe(preQuerySnapshot.gridEpoch);
    expect(checkpointSize).toBeGreaterThan(0);
    expect(checkpointSize).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
    expect(checkpointChunks).toBe(Math.ceil(checkpointSize / TERMINAL_CHECKPOINT_CHUNK_BYTES));
    expect(checkpoint.snapshot.checkpointSequence).toBe(checkpointSequence);
    expect(checkpoint.snapshot.checkpointEpoch).toBe(checkpointEpoch);
    expect(checkpoint.snapshot.pendingParserWrites).toBe(0);
    expect(checkpoint.snapshot.renderBacklogBytes).toBe(0);
    expect(checkpoint.snapshot.checkpointResult).toBe("sent");
    expect(serializationDuration).toBeGreaterThanOrEqual(0);
    expect(uploadDuration).toBeGreaterThanOrEqual(0);

    const checkpointGeneration = checkpoint.snapshot.socketGeneration;
    await waitForCheckpointFrames(
      faultController,
      terminalId,
      checkpointGeneration,
      checkpointFrameFloor + checkpointChunks,
    );
    const uploadedFrames = checkpointFrames(faultController, terminalId, checkpointGeneration, checkpointFrameFloor);
    expect(uploadedFrames).toHaveLength(checkpointChunks);
    expect(uploadedFrames.every((event) => (event.frame?.bytes ?? 0) > 0)).toBe(true);
    expect(uploadedFrames.every((event) => (event.frame?.bytes ?? 0) <= 64 * 1024)).toBe(true);

    await pane.xtermHost.locator(".xterm-helper-textarea").focus();
    const beforeRecovery = await waitForSettledTerminal(page, terminalId);
    const beforeRecoveryPixels = await screenshotRegion(page, pane.xtermHost);
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: "k-10-before-recovery",
    });
    const oldGeneration = beforeRecovery.socketGeneration;
    const faultEventFloor = faultController.events.length;
    const diagnosticFloor = lastEventId(await pane.events());
    const socketClosed = waitForSocketEvent(page, terminalId, diagnosticFloor, "socket-close", oldGeneration);
    const proxyTerminated = faultController.waitFor((event) => (
      event.type === "connection-terminated"
      && event.terminalId === terminalId
      && event.generation === oldGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const terminateRule = faultController.terminate({ terminalId, generation: oldGeneration });
    const [closedEvent, terminatedEvent] = await Promise.all([socketClosed, proxyTerminated]);
    terminateRule.dispose();
    expect(closedEvent.data.generation).toBe(oldGeneration);
    expect(terminatedEvent.type).toBe("connection-terminated");
    expect(faultController.events.length).toBeGreaterThan(faultEventFloor);

    const afterFault = await waitForSettledTerminal(page, terminalId);
    expect(afterFault.socketGeneration).toBeGreaterThan(oldGeneration);
    expect(afterFault.xterm.text).toContain(savedInitial);
    expect(afterFault.xterm.text).toContain(syncMarker);
    const afterFaultEvents = await pane.events();
    const faultSync = afterFaultEvents.filter((event) => (
      event.type === "sync" && event.snapshot.socketGeneration > oldGeneration
    ));
    expect(faultSync).toHaveLength(1);
    expect(["resume", "snapshot"]).toContain(faultSync[0]?.data.mode);

    const recoveredWorkbench = new WorkbenchPage(page);
    await recoveredWorkbench.expectVisible();
    const recoveredMountPromise = waitForMountedPane(page, terminalId);
    const recoveredPane = await recoveredWorkbench.openTerminal({ id: terminalId, name: terminalName });
    const recoveredMount = await recoveredMountPromise;
    expect(recoveredMount.terminalId).toBe(terminalId);
    await recoveredPane.expectVisible();
    const recoveredSync = await recoveredPane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    const recoveredEvents = await recoveredPane.events();
    await recoveredPane.xtermHost.locator(".xterm-helper-textarea").focus();
    const snapshotSyncs = recoveredEvents.filter((event) => event.type === "sync");
    expect(snapshotSyncs).toHaveLength(1);
    expect(snapshotSyncs[0]?.data.mode).toBe("snapshot");
    expect(recoveredSync.syncMode).toBeUndefined();

    const afterReload = await waitForSettledTerminal(page, terminalId);
    expect(afterReload.activeSocketCount).toBe(1);
    expect(afterReload.socketState).toBe("connected");
    expect(afterReload.acceptingInput).toBe(true);
    expect(afterReload.gridEpoch).toBe(checkpointEpoch);
    expect(afterReload.xterm.activeBuffer).toBe("normal");
    expect(afterReload.xterm.cursorX).toBe(beforeRecovery.xterm.cursorX);
    expect(afterReload.xterm.cursorY).toBe(beforeRecovery.xterm.cursorY);
    expect(afterReload.xterm.text).toContain(readyMarker);
    expect(afterReload.xterm.text).toContain(syncMarker);
    expect(countOccurrences(afterReload.xterm.text, savedMoved)).toBe(1);
    expect(countOccurrences(afterReload.xterm.text, savedInitial)).toBe(1);
    expect(countOccurrences(afterReload.xterm.text, savedPreProbe)).toBe(1);
    const afterReloadPixels = await screenshotRegion(page, recoveredPane.xtermHost);
    expect(afterReloadPixels.width).toBe(beforeRecoveryPixels.width);
    expect(afterReloadPixels.height).toBe(beforeRecoveryPixels.height);
    const cursorDiff = cursorCellDifference(beforeRecoveryPixels, afterReloadPixels, beforeRecovery);
    expect(cursorDiff).toBeLessThan(0.35);

    for (const [mode, expected] of Object.entries(preModeResponses)) {
      const numericMode = Number(mode);
      const response = await privateModeQuery(
        recoveredPane,
        server,
        terminalId,
        `${postModePrefix}-${mode}`,
        numericMode,
        [6, 12, 1002, 1006, 2004].includes(numericMode) ? 1 : 2,
      );
      expect(response).toBe(expected);
    }
    await kittyQuery(page, recoveredPane, server, terminalId, `${kittyNormalId}-POST-BASE`, 7);
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `KITTY ${kittyNormalId} POP 1`,
      "KITTY",
      marker("KITTY", kittyNormalId, "POP"),
    );
    await kittyQuery(page, recoveredPane, server, terminalId, `${kittyNormalId}-POST-POP-3`, 3);
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `KITTY ${kittyNormalId} POP 1`,
      "KITTY",
      marker("KITTY", kittyNormalId, "POP"),
    );
    await kittyQuery(page, recoveredPane, server, terminalId, `${kittyNormalId}-POST-POP-1`, 1);
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `KITTY ${kittyNormalId} PUSH 3`,
      "KITTY",
      marker("KITTY", kittyNormalId, "PUSH"),
    );
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `KITTY ${kittyNormalId} PUSH 7`,
      "KITTY",
      marker("KITTY", kittyNormalId, "PUSH"),
    );
    await kittyQuery(page, recoveredPane, server, terminalId, `${kittyNormalId}-POST-RESTORED`, 7);

    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `ALT_ENTER ${kittyAltId}`,
      "ALT_ENTER",
      marker("ALT_ENTER", kittyAltId),
    );
    await kittyQuery(page, recoveredPane, server, terminalId, `${kittyAltId}-POST-BASE`, 9);
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `KITTY ${kittyAltId} POP 1`,
      "KITTY",
      marker("KITTY", kittyAltId, "POP"),
    );
    await kittyQuery(page, recoveredPane, server, terminalId, `${kittyAltId}-POST-POP-5`, 5);
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `KITTY ${kittyAltId} POP 1`,
      "KITTY",
      marker("KITTY", kittyAltId, "POP"),
    );
    await kittyQuery(page, recoveredPane, server, terminalId, `${kittyAltId}-POST-POP-2`, 2);
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `KITTY ${kittyAltId} PUSH 5`,
      "KITTY",
      marker("KITTY", kittyAltId, "PUSH"),
    );
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `KITTY ${kittyAltId} PUSH 9`,
      "KITTY",
      marker("KITTY", kittyAltId, "PUSH"),
    );
    await kittyQuery(page, recoveredPane, server, terminalId, `${kittyAltId}-POST-RESTORED`, 9);
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `ALT_EXIT ${kittyAltId}`,
      "ALT_EXIT",
      marker("ALT_EXIT", kittyAltId),
    );

    const postResetBytes = Buffer.from(`\x1b8\x1b[6 q\x1b[?6h${savedRecovered}`, "binary");
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `BYTES ${postResetId} ${hex(postResetBytes)}`,
      "BYTES",
      marker("BYTES", postResetId, "EMIT"),
    );
    await expectTerminalBuffer(page, terminalId, { contains: savedRecovered, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const postQueries = await standardQuery(page, recoveredPane, server, terminalId, postQueryId);
    expect(postQueries.cursor).toBe(preQueries.cursor);
    expect(Buffer.from(postQueries.cursor ?? "", "base64").toString("binary")).toMatch(/^\x1b\[1;[0-9]+R$/);
    expect(postQueries.mode).toBe(preQueries.mode);
    expect(postQueries.identity).toBe(preQueries.identity);
    expect(postQueries.window_size).toBe(preQueries.window_size);
    expect(postQueries.window_pixels).toBe(preQueries.window_pixels);
    expect(postQueries.cell_pixels).toBe(preQueries.cell_pixels);

    const afterResetSnapshot = await waitForSettledTerminal(page, terminalId);
    await moveCell(recoveredPane, afterResetSnapshot, MOUSE_CAPTURE_CELL.col, MOUSE_CAPTURE_CELL.row);
    await captureInput(
      recoveredPane,
      server,
      terminalId,
      postMouseCaptureId,
      mouseBefore,
      async () => {
        await recoveredPane.page.mouse.down();
        await recoveredPane.page.mouse.up();
      },
    );
    await capturePaste(page, recoveredPane, server, terminalId, postPasteCaptureId, pasteText);

    const beforeFinalPixels = await screenshotRegion(page, recoveredPane.xtermHost);
    await sendVisibleFixtureCommand(
      page,
      recoveredPane,
      server,
      terminalId,
      `PRINT ${finalPrintId} ${finalPrintText}`,
      "PRINT",
      finalMarker,
    );
    await expectKnownMarkerChanged(page, recoveredPane.xtermHost, beforeFinalPixels, {
      minimumChangedRatio: 0.0002,
      testInfo,
      artifactName: "k-10-post-sync-marker",
    });
    await expectTerminalNonBlank(page, recoveredPane.xtermHost, {
      testInfo,
      artifactName: "k-10-final-terminal",
    });

    await sendFixtureCommand(recoveredPane, server, terminalId, `ECHO_INPUT ${echoId}`, "ECHO_INPUT");
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await recoveredPane.sendInput(echoText, true);
    const echo = await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === base64(echoText)
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    expect(echo.payload_base64).toBe(base64(echoText));
    await expectTerminalBuffer(page, terminalId, {
      contains: marker("ECHO_INPUT", echoId, base64(echoText)),
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    await recoveredPane.sendInput(`SIZE ${sizeId}`, true);
    const size = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl", { timeoutMs: WAIT_TIMEOUT_MS });
    const finalSnapshot = await waitForSettledTerminal(page, terminalId);
    expect(size.rows).toBe(finalSnapshot.rows);
    expect(size.cols).toBe(finalSnapshot.cols);
    expect(size.pixel_width).toBe(finalSnapshot.pixelWidth);
    expect(size.pixel_height).toBe(finalSnapshot.pixelHeight);
    await expectTerminalConverged(page, terminalId, {
      cols: finalSnapshot.cols,
      rows: finalSnapshot.rows,
      pixelWidth: finalSnapshot.pixelWidth,
      pixelHeight: finalSnapshot.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

    expect(finalSnapshot.socketState).toBe("connected");
    expect(finalSnapshot.acceptingInput).toBe(true);
    expect(finalSnapshot.pendingParserWrites).toBe(0);
    expect(finalSnapshot.pendingParserBytes).toBe(0);
    expect(finalSnapshot.renderBacklogBytes).toBe(0);
    expect(finalSnapshot.renderBacklogFrames).toBe(0);
    expect(finalSnapshot.syncMode).toBeUndefined();
    expect(finalSnapshot.activeBuffer).toBe("normal");
    expect(finalSnapshot.serverViewport?.cols).toBe(finalSnapshot.cols);
    expect(finalSnapshot.serverViewport?.rows).toBe(finalSnapshot.rows);
    expect(finalSnapshot.xterm.text).toContain(syncMarker);
    expect(finalSnapshot.xterm.text).toContain(finalMarker);
    expect(finalSnapshot.xterm.text).toContain(savedRecovered);
    expect(finalSnapshot.xterm.text).toContain(marker("ECHO_INPUT", echoId, base64(echoText)));
    for (const text of [readyMarker, syncMarker, finalMarker, savedMoved, savedInitial, savedPreProbe, savedRecovered]) {
      expect(countOccurrences(finalSnapshot.xterm.text, text), `terminal model marker missing or duplicated: ${text}`).toBe(1);
    }

    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
    expect(transcript.filter((entry) => entry.event === "query_incomplete")).toHaveLength(0);
    expect(transcript.filter((entry) => entry.event === "query_complete" && [preQueryId, postQueryId].includes(String(entry.id)))).toHaveLength(2);
    expect(transcript.filter((entry) => entry.event === "query_reply" && entry.id === preQueryId)).toHaveLength(6);
    expect(transcript.filter((entry) => entry.event === "query_reply" && entry.id === postQueryId)).toHaveLength(6);
    expect(transcript.filter((entry) => entry.event === "kitty_reply" && (String(entry.id).startsWith(`${kittyNormalId}-`) || String(entry.id).startsWith(`${kittyAltId}-`))).length).toBeGreaterThan(0);
    expect(transcript.filter((entry) => entry.event === "capture_input" && [preMouseCaptureId, postMouseCaptureId, prePasteCaptureId, postPasteCaptureId].includes(String(entry.id)) && entry.phase === "complete")).toHaveLength(4);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === syncPrintId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === finalPrintId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    const mouseConfiguration = transcript.filter((entry) => (
      entry.event === "mouse" && [mouseAnyId, mouseSgrId].includes(String(entry.id))
    ));
    expect(mouseConfiguration).toHaveLength(2);
    expect(mouseConfiguration.find((entry) => entry.id === mouseAnyId)?.mode).toBe("drag");
    expect(mouseConfiguration.find((entry) => entry.id === mouseSgrId)?.mode).toBe("sgr");
    const privateBytes = transcript.filter((entry) => (
      entry.event === "bytes" && [savedSetupId, cursorStyleId, preResetId, postResetId].includes(String(entry.id))
    ));
    expect(privateBytes).toHaveLength(4);
    expect(writeByteCount(transcript)).toBe(finalSnapshot.committedSequence);
    expect(uploadedFrames.every((event) => event.frame?.sequence === checkpointSequence)).toBe(true);

    const finalEvents = await terminalEvents(page, terminalId);
    await assertMonotonicSequences(finalEvents);
    expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
    expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
    const finalStateEvents = finalEvents.filter((event) => event.type === "state");
    expect(finalStateEvents.at(-1)?.data.state).toBe("connected");
    expect(finalEvents.filter((event) => event.type === "sync")).toHaveLength(1);
    expect(finalEvents.find((event) => event.type === "sync")?.data.mode).toBe("snapshot");
    expect(finalEvents.filter((event) => event.type === "synced")).toHaveLength(1);
    await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

    const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
    expect(networkEvents.filter((event) => event.type === "socket-error" || event.type === "malformed-frame")).toHaveLength(0);
    expect(networkEvents.filter((event) => event.type === "connection-terminated" && event.generation === oldGeneration)).toHaveLength(1);
    expect(browserErrors()).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error|internal server error)/i);
    expect(initialPixels.width).toBe(beforeRecoveryPixels.width);
  } finally {
    browserErrors.dispose();
  }
});
