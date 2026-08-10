import { Terminal as HeadlessTerminal } from "../fixtures/headless-terminal.js"
import { test, expect, type TranscriptEntry } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalConnected,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
  waitForTerminalBuffer,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 15_000;
const INITIAL_BROWSER_VIEWPORT = { width: 920, height: 220 } as const;
const GEOMETRY_A = { cols: 80, rows: 10 } as const;
const GEOMETRY_B = { cols: 100, rows: 12 } as const;
const MARGIN_TOP = 2;
const MARGIN_BOTTOM = 5;
const MODE_QUERY_HEX = "1b5b3f362470";
const MODE_QUERY_REPLY = "\u001b[?6;1$y";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type Grid = Readonly<{ cols: number; rows: number }>;
type QueryCursor = Readonly<{ cols: number; rows: number; cursorX: number; cursorY: number }>;

type QueryReplyEntry = TranscriptEntry & {
  event: "query_reply";
  id: string;
  index: number;
  name: string;
  raw_base64: string;
};

type WriteEntry = TranscriptEntry & {
  event: "write";
  data_base64: string;
};

function commandBytes(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function markerBytes(operation: string, ...fields: string[]): Buffer {
  return Buffer.from(`${marker(operation, ...fields)}\n`, "utf8");
}

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function countBytes(haystack: Buffer, needle: Uint8Array): number {
  const target = Buffer.from(needle);
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - target.length) {
    const found = haystack.indexOf(target, offset);
    if (found < 0) break;
    count += 1;
    offset = found + Math.max(1, target.length);
  }
  return count;
}

function textFromModel(terminal: HeadlessTerminal): string {
  const active = terminal.buffer.active;
  const length = Math.min(active.length, 20_000);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    const line = active.getLine(index);
    if (!line) continue;
    text += line.translateToString(true);
    if (index + 1 < length) text += "\n";
  }
  return text;
}

function writeHeadless(terminal: HeadlessTerminal, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => {
    terminal.write(bytes, resolve);
  });
}

function asNumber(entry: TranscriptEntry, key: string): number {
  const value = entry[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`fixture transcript field ${key} is not numeric`);
  }
  return value;
}

function asString(entry: TranscriptEntry, key: string): string {
  const value = entry[key];
  if (typeof value !== "string") throw new Error(`fixture transcript field ${key} is not a string`);
  return value;
}

function isWrite(entry: TranscriptEntry): entry is WriteEntry {
  return entry.event === "write" && typeof entry.data_base64 === "string";
}

function isQueryReply(entry: TranscriptEntry): entry is QueryReplyEntry {
  return entry.event === "query_reply"
    && typeof entry.id === "string"
    && typeof entry.index === "number"
    && typeof entry.name === "string"
    && typeof entry.raw_base64 === "string";
}



async function waitForGrid(page: Page, terminalId: string, expected: Grid): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected: target, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.cols === target.cols
      && snapshot.rows === target.rows
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.desiredViewport?.cols === target.cols
      && snapshot.desiredViewport?.rows === target.rows
      && snapshot.sentViewport?.cols === target.cols
      && snapshot.sentViewport?.rows === target.rows
      && snapshot.serverViewport?.cols === target.cols
      && snapshot.serverViewport?.rows === target.rows
    ), { timeout });
  }, { id: terminalId, expected, timeout: WAIT_TIMEOUT_MS });
}

/** Set an exact grid using the current measured cell size, with one layout transition. */
async function setGrid(
  page: Page,
  pane: TerminalPanePage,
  expected: Grid,
): Promise<E2ETerminalSnapshot> {
  const current = await pane.snapshot();
  if (!current) throw new Error(`missing diagnostics snapshot for ${pane.terminalId}`);
  if (current.cols === expected.cols
    && current.rows === expected.rows
    && current.desiredViewport?.cols === expected.cols
    && current.desiredViewport?.rows === expected.rows
    && current.sentViewport?.cols === expected.cols
    && current.sentViewport?.rows === expected.rows
    && current.serverViewport?.cols === expected.cols
    && current.serverViewport?.rows === expected.rows) {
    return waitForGrid(page, pane.terminalId, expected);
  }
  const browserViewport = page.viewportSize();
  if (!browserViewport) throw new Error("Playwright did not expose a browser viewport");
  const currentViewport = current.proposedViewport ?? current.desiredViewport ?? current.viewport;
  if (current.cols <= 0 || current.rows <= 0 || currentViewport.pixelWidth <= 0 || currentViewport.pixelHeight <= 0) {
    throw new Error("terminal cell geometry is unavailable for deterministic resize");
  }
  const cellWidth = currentViewport.pixelWidth / current.cols;
  const cellHeight = currentViewport.pixelHeight / current.rows;
  await page.setViewportSize({
    width: Math.max(1, Math.round(browserViewport.width + (expected.cols - current.cols) * cellWidth)),
    height: Math.max(1, Math.round(browserViewport.height + (expected.rows - current.rows) * cellHeight)),
  });
  return waitForGrid(page, pane.terminalId, expected);
}

async function waitForGenerationEvent(
  page: Page,
  terminalId: string,
  type: E2ETerminalEvent["type"],
  generation: number,
  exact = false,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, eventType, generation: target, exactGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === eventType
      && (exactGeneration ? event.snapshot.socketGeneration === target : event.snapshot.socketGeneration > target)
    ), { timeout });
  }, { id: terminalId, eventType: type, generation, exactGeneration: exact, timeout: WAIT_TIMEOUT_MS });
}

async function replayFixtureWrites(
  transcript: readonly TranscriptEntry[],
  fallbackGrid: Grid,
): Promise<{ terminal: HeadlessTerminal; queryCursors: ReadonlyMap<string, QueryCursor> }> {
  const initialCols = fallbackGrid.cols;
  const initialRows = fallbackGrid.rows;
  const terminal = new HeadlessTerminal({
    cols: initialCols,
    rows: initialRows,
    scrollback: 200_000,
    allowProposedApi: true,
    ...tuiCompatibilityOptions(),
  });
  const queryCursors = new Map<string, QueryCursor>();
  const pendingQueries: Array<{ id: string; request: Buffer }> = [];

  for (const entry of transcript) {
    if (entry.event === "sigwinch" && entry.source === "signal") {
      const cols = asNumber(entry, "cols");
      const rows = asNumber(entry, "rows");
      if (cols <= 0 || rows <= 0) throw new Error("fixture SIGWINCH did not expose a positive grid");
      terminal.resize(cols, rows);
    }
    if (entry.event === "query") {
      pendingQueries.push({
        id: asString(entry, "id"),
        request: Buffer.from(asString(entry, "request_base64"), "base64"),
      });
    }
    if (!isWrite(entry)) continue;
    const bytes = Buffer.from(entry.data_base64, "base64");
    await writeHeadless(terminal, bytes);
    const pending = pendingQueries[0];
    if (pending && bytes.equals(pending.request)) {
      queryCursors.set(pending.id, {
        cols: terminal.cols,
        rows: terminal.rows,
        cursorX: terminal.buffer.active.cursorX,
        cursorY: terminal.buffer.active.cursorY,
      });
      pendingQueries.shift();
    }
  }
  if (pendingQueries.length > 0) throw new Error("fixture query output was not fully replayed");
  return { terminal, queryCursors };
}

function assertQueryReplies(
  transcript: readonly TranscriptEntry[],
  queryId: string,
  cursor: QueryCursor,
  viewportA: E2EViewport,
  viewportB: E2EViewport,
): void {
  const viewport = cursor.cols === viewportA.cols && cursor.rows === viewportA.rows ? viewportA : viewportB;
  const originRow = viewport === viewportA
    ? Math.max(1, cursor.cursorY - (MARGIN_TOP - 1) + 1)
    : cursor.cursorY + 1;
  const expected = [
    `\u001b[${originRow};${cursor.cursorX + 1}R`,
    "\u001b[?25;1$y",
    "\u001b[?1;2c",
    `\u001b[8;${cursor.rows};${cursor.cols}t`,
    `\u001b[4;${viewport.pixelHeight};${viewport.pixelWidth}t`,
    `\u001b[6;${Math.floor(viewport.pixelHeight / cursor.rows)};${Math.floor(viewport.pixelWidth / cursor.cols)}t`,
  ];
  const replies = transcript.filter((entry): entry is QueryReplyEntry => isQueryReply(entry) && entry.id === queryId);
  expect(replies).toHaveLength(expected.length);
  expect(replies.map((entry) => entry.name)).toEqual([
    "cursor",
    "mode",
    "identity",
    "window_size",
    "window_pixels",
    "cell_pixels",
  ]);
  expect(replies.map((entry) => Buffer.from(entry.raw_base64, "base64").toString("hex")))
    .toEqual(expected.map((value) => Buffer.from(value, "utf8").toString("hex")));
  expect(replies.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5]);
}

function assertModeQueryReply(transcript: readonly TranscriptEntry[], id: string): void {
  const replies = transcript.filter((entry) => (
    entry.event === "capture_input"
    && entry.id === id
    && entry.phase === "complete"
  ));
  expect(replies).toHaveLength(1);
  expect(asString(replies[0]!, "payload_base64")).toBe(base64(MODE_QUERY_REPLY));
  expect(asNumber(replies[0]!, "bytes")).toBe(Buffer.byteLength(MODE_QUERY_REPLY));
}

function browserFrame(
  event: NetworkFaultEvent,
  terminalId: string,
  generation?: number,
): boolean {
  return event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && (generation === undefined || event.generation === generation)
    && event.frame !== undefined;
}

test("O-09 Scroll margins and origin mode @O-09 @p1 @nightly @margins @origin @resize @recovery", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.setViewportSize(INITIAL_BROWSER_VIEWPORT);
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const region = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(region).toBeVisible();
  const terminalId = await region.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal did not expose a terminal ID");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await setGrid(page, pane, GEOMETRY_A);
  const initial = await expectTerminalConverged(page, terminalId, GEOMETRY_A, { timeout: WAIT_TIMEOUT_MS });
  const viewportA = initial.serverViewport ?? initial.desiredViewport;
  if (!viewportA) throw new Error("initial server viewport is unavailable");
  const initialEpoch = initial.gridEpoch;
  if (initialEpoch === undefined) throw new Error("initial grid epoch is unavailable");
  const firstSocketGeneration = initial.socketGeneration;
  const initialConnection = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
  );
  if (!initialConnection || initialConnection.generation === undefined) {
    throw new Error("initial terminal connection has no proxy generation");
  }
  const firstProxyGeneration = initialConnection.generation;

  const token = `O09-W${testInfo.workerIndex}-R${testInfo.retry}-I${testInfo.repeatEachIndex}`;
  const readyId = `${token}-READY`;
  const marginsId = `${token}-MARGINS`;
  const originId = `${token}-ORIGIN`;
  const cursorId = `${token}-CURSOR`;
  const insideId = `${token}-IN-REGION`;
  const queryAId = `${token}-QUERY-A`;
  const modeAId = `${token}-MODE-A`;
  const sizeBId = `${token}-SIZE-B`;
  const afterId = `${token}-AFTER`;
  const queryBId = `${token}-QUERY-B`;
  const modeBId = `${token}-MODE-B`;
  const echoId = `${token}-ECHO`;
  const echoPayload = `${token}-CONTINUED-INPUT`;
  const echoPayloadBase64 = base64(echoPayload);

  await pane.focus();
  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "ready" && entry.id === readyId
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await waitForTerminalBuffer(page, terminalId, { contains: marker("READY", readyId), occurrences: 1 }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  const beforeMargins = await screenshotRegion(page, pane.xtermHost);
  await pane.sendInput(`MARGINS ${marginsId} ${MARGIN_TOP} ${MARGIN_BOTTOM}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "margins" && entry.id === marginsId, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  await pane.sendInput(`ORIGIN ${originId} on`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "origin" && entry.id === originId && entry.enabled === true, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  await pane.sendInput(`CURSOR ${cursorId} 3 4`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "cursor" && entry.id === cursorId && entry.row === 3 && entry.col === 4, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  const insideText = "IN-REGION";
  await pane.sendInput(`PRINT ${insideId} ${insideText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === insideId && entry.text === insideText, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });

  const queryAComplete = server.waitForTranscript(terminalId, (entry) => entry.event === "query_complete" && entry.id === queryAId && entry.replies === 6, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  await pane.sendInput(`QUERY ${queryAId}`, true);
  await queryAComplete;
  await waitForTerminalBuffer(page, terminalId, { contains: marker("QUERY", queryAId, "COMPLETE", "6"), occurrences: 1 }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  const modeAComplete = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "capture_input" && entry.id === modeAId && entry.phase === "complete"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`QUERY_BYTES ${modeAId} ${Buffer.byteLength(MODE_QUERY_REPLY)} ${MODE_QUERY_HEX}`, true);
  await modeAComplete;
  await waitForTerminalBuffer(page, terminalId, { contains: marker("CAPTURE_INPUT", modeAId, "COMPLETE"), occurrences: 1 }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  const afterMargins = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeMargins, afterMargins, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "o-09-margins-origin-setup",
  });

  const resizeFaultFloor = faultController.events.length;
  const resizeFramePromise = faultController.waitFor((event) => (
    faultController.events.indexOf(event) >= resizeFaultFloor
    && browserFrame(event, terminalId, firstProxyGeneration)
    && event.frame?.jsonType === "resize"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const winchBPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "sigwinch"
    && entry.source === "signal"
    && entry.rows === GEOMETRY_B.rows
    && entry.cols === GEOMETRY_B.cols
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await setGrid(page, pane, GEOMETRY_B);
  const resizeFrame = await resizeFramePromise;
  const winchB = await winchBPromise;
  expect(resizeFrame.frame?.jsonType).toBe("resize");
  expect(winchB.rows).toBe(GEOMETRY_B.rows);
  expect(winchB.cols).toBe(GEOMETRY_B.cols);
  const resized = await waitForGrid(page, terminalId, GEOMETRY_B);
  const viewportB = resized.serverViewport ?? resized.desiredViewport;
  if (!viewportB) throw new Error("resized server viewport is unavailable");
  expect(resized.gridEpoch).toBeGreaterThan(initialEpoch);
  const resizeEpoch = resized.gridEpoch;
  if (resizeEpoch === undefined) throw new Error("resized grid epoch is unavailable");

  const sizeBPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "size"
    && entry.id === sizeBId
    && entry.source === "ioctl"
    && entry.rows === GEOMETRY_B.rows
    && entry.cols === GEOMETRY_B.cols
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`SIZE ${sizeBId}`, true);
  const sizeB = await sizeBPromise;
  expect(sizeB.rows).toBe(GEOMETRY_B.rows);
  expect(sizeB.cols).toBe(GEOMETRY_B.cols);
  await waitForTerminalBuffer(page, terminalId, {
    contains: marker("SIZE", sizeBId, String(GEOMETRY_B.rows), String(GEOMETRY_B.cols)),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const beforeReconnect = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(beforeReconnect.gridEpoch).toBe(resizeEpoch);

  const oldClosePromise = waitForGenerationEvent(page, terminalId, "socket-close", firstSocketGeneration, true);
  const terminatePromise = faultController.waitFor((event) => (
    event.type === "connection-terminated"
    && event.terminalId === terminalId
    && event.generation === firstProxyGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const secondOpenPromise = faultController.waitFor((event) => (
    event.type === "connection-open"
    && event.terminalId === terminalId
    && event.generation !== undefined
    && event.generation > firstProxyGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const secondSyncPromise = waitForGenerationEvent(page, terminalId, "synced", firstSocketGeneration);
  const terminated = faultController.terminate({ terminalId, generation: firstProxyGeneration });
  const [oldClose, _terminated, secondOpen, secondSync] = await Promise.all([
    oldClosePromise,
    terminatePromise,
    secondOpenPromise,
    secondSyncPromise,
  ]);
  terminated.dispose();
  expect(oldClose.snapshot.socketGeneration).toBe(firstSocketGeneration);
  if (secondOpen.generation === undefined) throw new Error("reconnect connection has no proxy generation");
  const secondProxyGeneration = secondOpen.generation;
  expect(secondSync.snapshot.socketGeneration).toBeGreaterThan(firstSocketGeneration);
  expect(secondSync.snapshot.gridEpoch).toBe(resizeEpoch);
  expect(secondSync.snapshot.socketState).toBe("connected");
  expect(secondSync.snapshot.acceptingInput).toBe(true);
  expect(secondSync.snapshot.pendingParserWrites).toBe(0);
  expect(secondSync.snapshot.renderBacklogBytes).toBe(0);
  const secondSocketGeneration = secondSync.snapshot.socketGeneration;
  const beforeAfter = await screenshotRegion(page, pane.xtermHost);
  const committedBeforeAfter = beforeReconnect.committedSequence;
  const afterPrintPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "print" && entry.id === afterId && entry.text === "AFTER-REGION"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`PRINT ${afterId} AFTER-REGION`, true);
  await afterPrintPromise;
  await waitForTerminalBuffer(page, terminalId, { contains: marker("PRINT", afterId, "AFTER-REGION"), occurrences: 1 }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  const queryBComplete = server.waitForTranscript(terminalId, (entry) => entry.event === "query_complete" && entry.id === queryBId && entry.replies === 6, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  await pane.sendInput(`QUERY ${queryBId}`, true);
  await queryBComplete;
  await waitForTerminalBuffer(page, terminalId, { contains: marker("QUERY", queryBId, "COMPLETE", "6"), occurrences: 1 }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  const modeBComplete = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "capture_input" && entry.id === modeBId && entry.phase === "complete"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`QUERY_BYTES ${modeBId} ${Buffer.byteLength(MODE_QUERY_REPLY)} ${MODE_QUERY_HEX}`, true);
  await modeBComplete;
  await waitForTerminalBuffer(page, terminalId, { contains: marker("CAPTURE_INPUT", modeBId, "COMPLETE"), occurrences: 1 }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  const echoArmedPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await echoArmedPromise;
  const echoPayloadPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input"
    && entry.id === echoId
    && entry.phase === "payload"
    && entry.payload_base64 === echoPayloadBase64
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(echoPayload, true);
  await echoPayloadPromise;
  await waitForTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", echoId, echoPayloadBase64),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const afterAfter = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeAfter, afterAfter, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "o-09-post-resize-origin",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "o-09-terminal-crop",
  });

  const finalBeforeExit = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(finalBeforeExit.snapshot.socketGeneration).toBe(secondSocketGeneration);
  expect(finalBeforeExit.snapshot.cols).toBe(GEOMETRY_B.cols);
  expect(finalBeforeExit.snapshot.rows).toBe(GEOMETRY_B.rows);
  expect(finalBeforeExit.snapshot.serverViewport?.cols).toBe(GEOMETRY_B.cols);
  expect(finalBeforeExit.snapshot.serverViewport?.rows).toBe(GEOMETRY_B.rows);
  expect(finalBeforeExit.snapshot.gridEpoch).toBe(resizeEpoch);
  expect(finalBeforeExit.snapshot.syncMode).toBeUndefined();
  expect(finalBeforeExit.snapshot.syncTarget).toBeUndefined();
  expect(finalBeforeExit.snapshot.pendingParserWrites).toBe(0);
  expect(finalBeforeExit.snapshot.pendingParserBytes).toBe(0);
  expect(finalBeforeExit.snapshot.renderBacklogBytes).toBe(0);
  expect(finalBeforeExit.snapshot.renderBacklogFrames).toBe(0);
  expect(finalBeforeExit.snapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(finalBeforeExit.snapshot.acceptingInput).toBe(true);
  expect(finalBeforeExit.snapshot.xterm.activeBuffer).toBe("normal");

  const transcript = await server.readTranscript(terminalId);
  const output = Buffer.concat(transcript.filter(isWrite).map((entry) => Buffer.from(entry.data_base64, "base64")));
  expect(countBytes(output, Buffer.from(`\u001b[${MARGIN_TOP};${MARGIN_BOTTOM}r`))).toBe(1);
  expect(countBytes(output, Buffer.from("\u001b[?6h"))).toBe(1);
  expect(countBytes(output, Buffer.from("\u001b[3;4H"))).toBe(1);
  expect(countBytes(output, Buffer.from("\u001b[6n"))).toBe(2);
  expect(countBytes(output, Buffer.from("\u001b[?6$p"))).toBe(2);
  for (const expectedMarker of [
    marker("MARGINS", marginsId, String(MARGIN_TOP), String(MARGIN_BOTTOM)),
    marker("ORIGIN", originId, "on"),
    marker("CURSOR", cursorId, "3", "4"),
    marker("PRINT", insideId, insideText),
    marker("SIZE", sizeBId, String(GEOMETRY_B.rows), String(GEOMETRY_B.cols)),
    marker("PRINT", afterId, "AFTER-REGION"),
    marker("ECHO_INPUT", echoId, echoPayloadBase64),
  ]) {
    expect(countBytes(output, Buffer.from(`${expectedMarker}\n`))).toBe(1);
  }
  expect(countBytes(output, markerBytes("QUERY", queryAId, "COMPLETE", "6"))).toBe(1);
  expect(countBytes(output, markerBytes("QUERY", queryBId, "COMPLETE", "6"))).toBe(1);
  expect(countBytes(output, markerBytes("CAPTURE_INPUT", modeAId, "COMPLETE"))).toBe(1);
  expect(countBytes(output, markerBytes("CAPTURE_INPUT", modeBId, "COMPLETE"))).toBe(1);

  const { terminal: model, queryCursors } = await replayFixtureWrites(transcript, GEOMETRY_A);
  const snapshot = await pane.snapshot();
  if (!snapshot) throw new Error("final E2E diagnostics snapshot disappeared");
  expect(snapshot.xterm.text).toBe(textFromModel(model));
  expect(snapshot.xterm.activeBuffer).toBe(model.buffer.active.type);
  expect(snapshot.xterm.cursorX).toBe(model.buffer.active.cursorX);
  expect(snapshot.xterm.cursorY).toBe(model.buffer.active.cursorY);
  expect(snapshot.xterm.viewportY).toBe(model.buffer.active.viewportY);
  const compactSnapshotText = snapshot.xterm.text.replaceAll("\n", "");
  expect(compactSnapshotText).toContain(marker("PRINT", afterId, "AFTER-REGION"));
  expect(compactSnapshotText).toContain(marker("ECHO_INPUT", echoId, echoPayloadBase64));
  const queryACursor = queryCursors.get(queryAId);
  const queryBCursor = queryCursors.get(queryBId);
  if (!queryACursor || !queryBCursor) throw new Error("fixture query cursor state was not replayed");
  assertQueryReplies(transcript, queryAId, queryACursor, viewportA, viewportB);
  assertQueryReplies(transcript, queryBId, queryBCursor, viewportA, viewportB);
  assertModeQueryReply(transcript, modeAId);
  assertModeQueryReply(transcript, modeBId);

  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(2);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  const secondEvents = events.filter((event) => event.snapshot.socketGeneration === secondSocketGeneration);
  const sizeEventIndex = secondEvents.findIndex((event) => (
    event.type === "size"
    && event.data.cols === GEOMETRY_B.cols
    && event.data.rows === GEOMETRY_B.rows
    && Number(event.data.epoch) === resizeEpoch
  ));
  expect(sizeEventIndex).toBeGreaterThanOrEqual(0);
  const firstPostOutputIndex = secondEvents.findIndex((event) => (
    event.type === "output-received"
    && committedBeforeAfter !== undefined
    && Number(event.data.sequence) > committedBeforeAfter
  ));
  expect(firstPostOutputIndex).toBeGreaterThan(sizeEventIndex);
  const postResizeEpochs = new Set(
    events
      .filter((event) => event.type === "size" && Number(event.data.epoch) > initialEpoch)
      .map((event) => Number(event.data.epoch)),
  );
  expect(postResizeEpochs).toEqual(new Set([resizeEpoch]));
  expect(browserErrors).toEqual([]);
  expect(faultController.events.filter((event) => event.type === "socket-error" || event.type === "malformed-frame")).toEqual([]);
  expect(faultController.events.some((event) => browserFrame(event, terminalId, secondProxyGeneration))).toBe(true);

  const commands = transcript
    .filter((entry) => entry.event === "command")
    .map((entry) => asString(entry, "command_base64"));
  expect(commands).toEqual([
    commandBytes(`READY ${readyId}`),
    commandBytes(`MARGINS ${marginsId} ${MARGIN_TOP} ${MARGIN_BOTTOM}`),
    commandBytes(`ORIGIN ${originId} on`),
    commandBytes(`CURSOR ${cursorId} 3 4`),
    commandBytes(`PRINT ${insideId} ${insideText}`),
    commandBytes(`QUERY ${queryAId}`),
    commandBytes(`QUERY_BYTES ${modeAId} ${Buffer.byteLength(MODE_QUERY_REPLY)} ${MODE_QUERY_HEX}`),
    commandBytes(`SIZE ${sizeBId}`),
    commandBytes(`PRINT ${afterId} AFTER-REGION`),
    commandBytes(`QUERY ${queryBId}`),
    commandBytes(`QUERY_BYTES ${modeBId} ${Buffer.byteLength(MODE_QUERY_REPLY)} ${MODE_QUERY_HEX}`),
    commandBytes(`ECHO_INPUT ${echoId}`),
    commandBytes(echoPayload),
  ]);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "query_complete" && entry.id === queryAId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "query_complete" && entry.id === queryBId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal" && entry.rows === GEOMETRY_B.rows && entry.cols === GEOMETRY_B.cols).length).toBeGreaterThanOrEqual(1);

  const exitCommand = `EXIT 0`;
  const exitCommandPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command" && entry.command_base64 === commandBytes(exitCommand)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const exitPromise = server.waitForTranscript(terminalId, (entry) => entry.event === "exit" && entry.code === 0, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  const exitEventPromise = waitForGenerationEvent(page, terminalId, "exit", secondSocketGeneration, true);
  await pane.sendInput(exitCommand, true);
  await Promise.all([exitCommandPromise, exitPromise, exitEventPromise]);
  model.dispose();
});
