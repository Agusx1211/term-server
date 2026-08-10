import { test, expect } from "../fixtures/test.js";
import type { Page, TestInfo } from "@playwright/test";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
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
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_VIEWPORT_SETTLE_MS } from "../../src/client/lib/terminal-viewport.js";
import type { IsolatedServer, TranscriptEntry } from "../fixtures/test.js";

const WAIT_TIMEOUT_MS = 30_000;
const FIXED_WIDTH = 1_280;
const INITIAL_HEIGHT = 720;
const BURST_BYTES = 65_536;
const BURST_LINE_WIDTH = 80;
const ROW_TARGETS = [24, 18, 30, 12, 36] as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type ResizeResult = {
  readonly snapshot: E2ETerminalSnapshot;
  readonly ptySignal: TranscriptEntry;
};

function numericField(entry: TranscriptEntry, field: string): number | undefined {
  const value = entry[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function transcriptBoundary(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((maximum, entry) => Math.max(maximum, numericField(entry, "sequence") ?? 0), 0);
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

function marker(operation: string, id: string, text?: string): string {
  return text === undefined ? `[E2E:${operation}:${id}]` : `[E2E:${operation}:${id}:${text}]`;
}

function markerLineIndex(snapshot: E2ETerminalSnapshot, value: string): number {
  const index = snapshot.xterm.text.split("\n").findIndex((line) => line.includes(value));
  if (index < 0) throw new Error(`terminal model does not contain marker ${value}`);
  return index;
}

function expectMarkerVisible(snapshot: E2ETerminalSnapshot, value: string): void {
  const lineIndex = markerLineIndex(snapshot, value);
  expect(lineIndex).toBeGreaterThanOrEqual(snapshot.xterm.viewportY);
  expect(lineIndex).toBeLessThan(snapshot.xterm.viewportY + snapshot.rows);
}

async function waitForCommittedAfter(
  page: Page,
  terminalId: string,
  previousSequence: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previous, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.committedSequence !== undefined
      && snapshot.committedSequence > previous
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, previous: previousSequence, timeout: WAIT_TIMEOUT_MS });
}

async function waitForMarker(
  page: Page,
  terminalId: string,
  value: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, value: expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.xterm.text.includes(expected)
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, value, timeout: WAIT_TIMEOUT_MS });
}

async function sendFixtureCommand(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  command: string,
  operation: string,
  eventName: string,
  predicate: (entry: TranscriptEntry) => boolean = () => true,
): Promise<TranscriptEntry> {
  const [beforeEntries, beforeSnapshot] = await Promise.all([
    server.readTranscript(terminalId),
    pane.snapshot(),
  ]);
  const boundary = transcriptBoundary(beforeEntries);
  const previousSequence = beforeSnapshot?.committedSequence ?? -1;
  const commandEvent = server.waitForTranscript(
    terminalId,
    (entry) => (
      (numericField(entry, "sequence") ?? 0) > boundary
      && entry.event === "command"
      && entry.operation === operation
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(command, true);
  await commandEvent;
  const result = await server.waitForTranscript(
    terminalId,
    (entry) => (
      (numericField(entry, "sequence") ?? 0) > boundary
      && entry.event === eventName
      && predicate(entry)
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  if (beforeSnapshot) await waitForCommittedAfter(page, terminalId, previousSequence);
  return result;
}

async function waitForResizeSnapshot(
  page: Page,
  terminalId: string,
  targetRows: number,
  targetCols: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, rows, cols, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      const sent = snapshot.sentViewport;
      const server = snapshot.serverViewport;
      return desired !== undefined
        && sent !== undefined
        && server !== undefined
        && snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.cols === cols
        && snapshot.rows === rows
        && desired.cols === cols
        && desired.rows === rows
        && sent.cols === cols
        && sent.rows === rows
        && server.cols === cols
        && server.rows === rows
        && desired.pixelWidth === sent.pixelWidth
        && desired.pixelHeight === sent.pixelHeight
        && sent.pixelWidth === server.pixelWidth
        && sent.pixelHeight === server.pixelHeight
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0;
    }, { timeout });
  }, {
    id: terminalId,
    rows: targetRows,
    cols: targetCols,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function targetHeightForRows(
  page: Page,
  pane: TerminalPanePage,
  current: E2ETerminalSnapshot,
  targetRows: number,
): Promise<number> {
  const screen = await pane.xtermHost.locator(".xterm-screen").boundingBox();
  if (!screen || current.rows <= 0) throw new Error("terminal screen geometry is unavailable");
  const outerHeight = await page.evaluate(() => window.innerHeight);
  const cellHeight = screen.height / current.rows;
  const targetHeight = Math.round(outerHeight + (targetRows - current.rows) * cellHeight);
  return Math.max(240, targetHeight);
}

async function resizeHeightOnly(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  previous: E2ETerminalSnapshot,
  targetRows: number,
  height: number,
): Promise<ResizeResult> {
  expect(targetRows).not.toBe(previous.rows);
  const entries = await server.readTranscript(terminalId);
  const boundary = transcriptBoundary(entries);
  const viewportEvent = page.evaluate(async ({ id, rows, cols, boundary: eventBoundary, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > eventBoundary
      && event.type === "viewport"
      && event.data.source === "proposed"
      && event.data.cols === cols
      && event.data.rows === rows
    ), { timeout });
  }, {
    id: terminalId,
    rows: targetRows,
    cols: previous.cols,
    boundary: (await pane.events()).reduce((maximum, event) => Math.max(maximum, event.id), -1),
    timeout: WAIT_TIMEOUT_MS,
  });
  const ptySignal = server.waitForTranscript(
    terminalId,
    (entry) => (
      (numericField(entry, "sequence") ?? 0) > boundary
      && entry.event === "sigwinch"
      && entry.source === "signal"
      && numericField(entry, "rows") === targetRows
      && numericField(entry, "cols") === previous.cols
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const settled = waitForResizeSnapshot(page, terminalId, targetRows, previous.cols);
  await page.setViewportSize({ width: FIXED_WIDTH, height });
  await page.clock.runFor(TERMINAL_VIEWPORT_SETTLE_MS);
  await viewportEvent;
  const [snapshot, signal] = await Promise.all([settled, ptySignal]);
  return { snapshot, ptySignal: signal };
}

async function assertCompositorGeometry(
  page: Page,
  pane: TerminalPanePage,
  snapshot: E2ETerminalSnapshot,
): Promise<void> {
  const screen = pane.xtermHost.locator(".xterm-screen");
  const box = await screen.boundingBox();
  if (!box) throw new Error("terminal compositor screen has no bounding box");
  expect(Math.abs(snapshot.pixelWidth - box.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(snapshot.pixelHeight - box.height)).toBeLessThanOrEqual(1);
  const backing = await pane.canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return {
      width: canvas.width,
      height: canvas.height,
      dpr: window.devicePixelRatio,
    };
  });
  expect(Math.abs(backing.width - Math.round(box.width * backing.dpr))).toBeLessThanOrEqual(2);
  expect(Math.abs(backing.height - Math.round(box.height * backing.dpr))).toBeLessThanOrEqual(2);
  expect(snapshot.pixelWidth).toBeGreaterThan(0);
  expect(snapshot.pixelHeight).toBeGreaterThan(0);
  expect(snapshot.cols).toBeGreaterThan(0);
  expect(snapshot.rows).toBeGreaterThan(0);
}

async function scrollViewport(
  page: Page,
  pane: TerminalPanePage,
  terminalId: string,
  position: "top" | "bottom",
): Promise<E2ETerminalSnapshot> {
  const viewport = pane.xtermHost.locator(".xterm-viewport");
  const prior = await pane.snapshot();
  if (!prior) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  const settled = page.evaluate(async ({ id, position: expectedPosition, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      if (expectedPosition === "top") return snapshot.xterm.viewportY === 0;
      const lineCount = snapshot.xterm.text.split("\n").length;
      return snapshot.xterm.viewportY + snapshot.rows >= Math.max(0, lineCount - 1);
    }, { timeout });
  }, { id: terminalId, position, timeout: WAIT_TIMEOUT_MS });
  await viewport.evaluate((element, expectedPosition) => {
    element.scrollTop = expectedPosition === "top" ? 0 : element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, position);
  const result = await settled;
  expect(result.updatedAt).toBeGreaterThanOrEqual(prior.updatedAt);
  return result;
}

async function printVisibleMarker(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  id: string,
  text: string,
  testInfo: TestInfo,
): Promise<E2ETerminalSnapshot> {
  const screen = pane.xtermHost.locator(".xterm-screen");
  const before = await screenshotRegion(page, screen);
  const value = marker("PRINT", id, text);
  await sendFixtureCommand(
    page,
    server,
    pane,
    terminalId,
    `PRINT ${id} ${text}`,
    "PRINT",
    "print",
    (entry) => entry.id === id && entry.text === text,
  );
  const snapshot = await waitForMarker(page, terminalId, value);
  await expectTerminalBuffer(page, terminalId, { contains: value, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, screen, before, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `v06-${id}-marker-crop`,
  });
  await expectTerminalNonBlank(page, screen, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: `v06-${id}-terminal-crop`,
  });
  return snapshot;
}

test("V-06 Height-only resize @nightly", async ({ page, server }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.setViewportSize({ width: FIXED_WIDTH, height: INITIAL_HEIGHT });
  await page.goto("/");
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const mount = page.evaluate(async ({ timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, { timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const mounted = await mount;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  const screen = pane.xtermHost.locator(".xterm-screen");
  await expect(screen).toBeVisible();

  const token = `V06-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}`;
  const readyId = `${token}-READY`;
  const headId = `${token}-HEAD`;
  const burstId = `${token}-BURST`;
  const tailId = `${token}-TAIL`;
  const echoId = `${token}-ECHO`;
  const inputText = `${token}-CONTINUED-INPUT`;
  const initial = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  expect(initial.socketState).toBe("connected");
  expect(initial.acceptingInput).toBe(true);
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  await assertCompositorGeometry(page, pane, initial);

  await sendFixtureCommand(page, server, pane, terminalId, `READY ${readyId}`, "READY", "ready", (entry) => entry.id === readyId);
  await expectTerminalBuffer(page, terminalId, { contains: marker("READY", readyId), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const headText = `${token}-HISTORY-HEAD`;
  await printVisibleMarker(page, server, pane, terminalId, headId, headText, testInfo);
  const beforeBurst = await pane.snapshot();
  if (!beforeBurst) throw new Error(`No diagnostics snapshot before burst for terminal ${terminalId}`);
  const burst = await sendFixtureCommand(
    page,
    server,
    pane,
    terminalId,
    `BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`,
    "BURST",
    "burst",
    (entry) => entry.id === burstId && numericField(entry, "bytes") === BURST_BYTES && numericField(entry, "line_width") === BURST_LINE_WIDTH,
  );
  expect(numericField(burst, "bytes")).toBe(BURST_BYTES);
  expect(numericField(burst, "line_width")).toBe(BURST_LINE_WIDTH);
  const afterBurst = await waitForCommittedAfter(page, terminalId, beforeBurst.committedSequence ?? -1);
  expect(afterBurst.xterm.text).toContain(marker("PRINT", headId, headText));
  expect(countOccurrences(afterBurst.xterm.text, marker("PRINT", headId, headText))).toBe(1);
  const tailText = `${token}-HISTORY-TAIL`;
  const tailSnapshot = await printVisibleMarker(page, server, pane, terminalId, tailId, tailText, testInfo);
  expectMarkerVisible(tailSnapshot, marker("PRINT", tailId, tailText));
  expect(tailSnapshot.xterm.viewportY).toBeGreaterThan(0);
  const resizeTranscriptBoundary = transcriptBoundary(await server.readTranscript(terminalId));
  await page.clock.install();

  const states: E2ETerminalSnapshot[] = [];
  let current = tailSnapshot;
  let topState: E2ETerminalSnapshot | undefined;
  for (const [index, targetRows] of ROW_TARGETS.entries()) {
    if (index === 1) {
      const top = await scrollViewport(page, pane, terminalId, "top");
      expect(top.xterm.viewportY).toBe(0);
      expectMarkerVisible(top, marker("PRINT", headId, headText));
      topState = top;
    }
    const targetHeight = await targetHeightForRows(page, pane, current, targetRows);
    const resized = await resizeHeightOnly(page, server, pane, terminalId, current, targetRows, targetHeight);
    current = resized.snapshot;
    states.push(current);
    expect(resized.ptySignal.source).toBe("signal");
    expect(await page.evaluate(() => window.innerWidth)).toBe(FIXED_WIDTH);
    expect(numericField(resized.ptySignal, "rows")).toBe(targetRows);
    expect(numericField(resized.ptySignal, "cols")).toBe(initial.cols);
    expect(current.cols).toBe(initial.cols);
    expect(current.rows).toBe(targetRows);
    expect(current.pixelWidth).toBe(initial.pixelWidth);
    expect(current.pixelHeight).not.toBe(initial.pixelHeight);
    expect(current.desiredViewport?.cols).toBe(initial.cols);
    expect(current.desiredViewport?.rows).toBe(targetRows);
    expect(current.sentViewport?.cols).toBe(initial.cols);
    expect(current.sentViewport?.rows).toBe(targetRows);
    expect(current.serverViewport?.cols).toBe(initial.cols);
    expect(current.serverViewport?.rows).toBe(targetRows);
    expect(current.cols).toBe(initial.cols);
    expect(current.rows).toBe(targetRows);
    expect(current.xterm.text).toContain(marker("PRINT", headId, headText));
    expect(current.xterm.text).toContain(marker("PRINT", tailId, tailText));
    expect(countOccurrences(current.xterm.text, marker("PRINT", headId, headText))).toBe(1);
    expect(countOccurrences(current.xterm.text, marker("PRINT", tailId, tailText))).toBe(1);
    await assertCompositorGeometry(page, pane, current);

    if (index === 1) {
      expect(current.xterm.viewportY).toBe(0);
      expectMarkerVisible(current, marker("PRINT", headId, headText));
      expectMarkerVisible(current, marker("READY", readyId));
      const restored = await scrollViewport(page, pane, terminalId, "bottom");
      expect(restored.xterm.viewportY).toBeGreaterThan(0);
      expectMarkerVisible(restored, marker("PRINT", tailId, tailText));
      current = restored;
      const sizeId = `${token}-SIZE-${targetRows}`;
      const size = await sendFixtureCommand(
        page,
        server,
        pane,
        terminalId,
        `SIZE ${sizeId}`,
        "SIZE",
        "size",
        (entry) => entry.id === sizeId,
      );
      expect(numericField(size, "rows")).toBe(targetRows);
      expect(numericField(size, "cols")).toBe(initial.cols);
      const winchId = `${token}-WINCH-${targetRows}`;
      const winch = await sendFixtureCommand(
        page,
        server,
        pane,
        terminalId,
        `WINCH ${winchId} ${index + 1} ${targetRows} ${initial.cols}`,
        "WINCH",
        "sigwinch",
        (entry) => entry.id === winchId && entry.source === "command",
      );
      expect(numericField(winch, "rows")).toBe(targetRows);
      expect(numericField(winch, "cols")).toBe(initial.cols);
      expect(numericField(winch, "actual_rows")).toBe(targetRows);
      expect(numericField(winch, "actual_cols")).toBe(initial.cols);
      const stateText = `${token}-HEIGHT-${targetRows}`;
      current = await printVisibleMarker(page, server, pane, terminalId, `${token}-HEIGHT-${targetRows}`, stateText, testInfo);
      expect(current.rows).toBe(targetRows);
    } else {
      const sizeId = `${token}-SIZE-${targetRows}`;
      const size = await sendFixtureCommand(
        page,
        server,
        pane,
        terminalId,
        `SIZE ${sizeId}`,
        "SIZE",
        "size",
        (entry) => entry.id === sizeId,
      );
      expect(numericField(size, "rows")).toBe(targetRows);
      expect(numericField(size, "cols")).toBe(initial.cols);
      const winchId = `${token}-WINCH-${targetRows}`;
      const winch = await sendFixtureCommand(
        page,
        server,
        pane,
        terminalId,
        `WINCH ${winchId} ${index + 1} ${targetRows} ${initial.cols}`,
        "WINCH",
        "sigwinch",
        (entry) => entry.id === winchId && entry.source === "command",
      );
      expect(numericField(winch, "rows")).toBe(targetRows);
      expect(numericField(winch, "cols")).toBe(initial.cols);
      expect(numericField(winch, "actual_rows")).toBe(targetRows);
      expect(numericField(winch, "actual_cols")).toBe(initial.cols);
      const stateText = `${token}-HEIGHT-${targetRows}`;
      current = await printVisibleMarker(page, server, pane, terminalId, `${token}-HEIGHT-${targetRows}`, stateText, testInfo);
      expect(current.rows).toBe(targetRows);
    }
  }

  if (!topState) throw new Error("height-only scenario did not exercise a scrolled terminal");
  expect(topState.xterm.viewportY).toBe(0);
  const final = await terminalSnapshot(page, terminalId);
  if (!final) throw new Error(`No final diagnostics snapshot for terminal ${terminalId}`);
  expect(final.rows).toBe(ROW_TARGETS[ROW_TARGETS.length - 1]);
  expect(final.cols).toBe(initial.cols);
  expect(final.serverViewport?.rows).toBe(final.rows);
  expect(final.serverViewport?.cols).toBe(final.cols);
  expect(final.xterm.viewportY).toBeGreaterThan(0);
  expectMarkerVisible(final, marker("PRINT", tailId, tailText));
  for (const snapshot of states) {
    expect(snapshot.cols).toBe(initial.cols);
    expect(snapshot.desiredViewport?.cols).toBe(initial.cols);
    expect(snapshot.sentViewport?.cols).toBe(initial.cols);
    expect(snapshot.serverViewport?.cols).toBe(initial.cols);
    expect(snapshot.pendingParserWrites).toBe(0);
    expect(snapshot.pendingParserBytes).toBe(0);
    expect(snapshot.renderBacklogBytes).toBe(0);
    expect(snapshot.renderBacklogFrames).toBe(0);
    expect(snapshot.activeSocketCount).toBe(1);
  }

  const echoBefore = await pane.snapshot();
  if (!echoBefore) throw new Error(`No diagnostics snapshot before continued input for terminal ${terminalId}`);
  const armed = await sendFixtureCommand(
    page,
    server,
    pane,
    terminalId,
    `ECHO_INPUT ${echoId}`,
    "ECHO_INPUT",
    "echo_input",
    (entry) => entry.id === echoId && entry.phase === "armed",
  );
  expect(armed.phase).toBe("armed");
  const payloadBase64 = Buffer.from(inputText, "utf8").toString("base64");
  const payloadWait = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(inputText, true);
  const payload = await payloadWait;
  expect(payload.payload_base64).toBe(payloadBase64);
  await waitForCommittedAfter(page, terminalId, echoBefore.committedSequence ?? -1);
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", echoId, payloadBase64),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === headId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === tailId)).toHaveLength(1);
  expect(transcript.filter((entry) => (
    entry.event === "sigwinch"
    && entry.source === "signal"
    && (numericField(entry, "sequence") ?? 0) > resizeTranscriptBoundary
  ))).toHaveLength(ROW_TARGETS.length);
  expect(transcript.filter((entry) => entry.event === "write" && entry.bytes === BURST_BYTES)).toHaveLength(1);

  const events = await terminalEvents(page, terminalId);
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  await assertMonotonicSequences(events);
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  const browserFailures = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
  const finalAfterInput = await terminalSnapshot(page, terminalId);
  if (!finalAfterInput) throw new Error(`No diagnostics snapshot after continued input for terminal ${terminalId}`);
  expect(finalAfterInput.rows).toBe(ROW_TARGETS[ROW_TARGETS.length - 1]);
  expect(finalAfterInput.cols).toBe(initial.cols);
  expect(finalAfterInput.socketState).toBe("connected");
  expect(finalAfterInput.activeSocketCount).toBe(1);
  expect(finalAfterInput.acceptingInput).toBe(true);
  expect(finalAfterInput.pendingParserWrites).toBe(0);
  expect(finalAfterInput.pendingParserBytes).toBe(0);
  expect(finalAfterInput.renderBacklogBytes).toBe(0);
  expect(finalAfterInput.renderBacklogFrames).toBe(0);
  expect(finalAfterInput.xterm.text).toContain(marker("ECHO_INPUT", echoId, payloadBase64));
  expect(browserFailures).toEqual([]);
});
