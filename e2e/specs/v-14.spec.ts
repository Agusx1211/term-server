import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import type { Page, TestInfo } from "@playwright/test";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import TerminalPanePage from "../pages/terminal-pane.js";
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
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;
const INITIAL_VIEWPORT = { width: 1_280, height: 800 } as const;
const MINIMUM_PANE = { width: 30, height: 60 } as const;
const MAXIMUM_PANE = { width: 10_000, height: 6_000 } as const;
const MAX_COLUMNS = 500;
const MAX_ROWS = 300;
const MAX_PIXEL_DIMENSION = 0xffff;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type BoundGeometry = {
  readonly sentCols: number;
  readonly sentRows: number;
  readonly serverCols: number;
  readonly serverRows: number;
};

type PaneStyle = string | null;

function eventBoundary(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.id), -1);
}

function numericField(entry: TranscriptEntry, field: string): number | undefined {
  const value = entry[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEventType,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.id > after && event.type === eventType, { timeout });
  }, { id: terminalId, after: afterEventId, eventType: type, timeout: WAIT_TIMEOUT_MS });
}

async function waitForViewportAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "viewport"
      && event.data.source === "proposed"
    ), { timeout });
  }, { id: terminalId, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function setPaneGeometry(page: Page, terminalId: string, width: number, height: number): Promise<void> {
  await page.evaluate(({ id, width: nextWidth, height: nextHeight }) => {
    const pane = [...document.querySelectorAll<HTMLElement>(".pane-slot")]
      .find((candidate) => candidate.dataset.terminalId === id);
    if (!pane) throw new Error(`terminal ${id} has no production pane slot`);
    if (!pane.closest(".editor-grid")) throw new Error(`terminal ${id} is outside the production editor grid`);
    if (!pane.querySelector<HTMLElement>(".xterm-host")) throw new Error(`terminal ${id} has no xterm host`);
    pane.style.left = "0px";
    pane.style.top = "0px";
    pane.style.width = `${nextWidth}px`;
    pane.style.height = `${nextHeight}px`;
  }, { id: terminalId, width, height });
}

async function paneStyle(page: Page, terminalId: string): Promise<PaneStyle> {
  return page.evaluate((id) => {
    const pane = [...document.querySelectorAll<HTMLElement>(".pane-slot")]
      .find((candidate) => candidate.dataset.terminalId === id);
    if (!pane) throw new Error(`terminal ${id} has no production pane slot`);
    return pane.getAttribute("style");
  }, terminalId);
}

async function restorePaneStyle(page: Page, terminalId: string, style: PaneStyle): Promise<void> {
  await page.evaluate(({ id, style: originalStyle }) => {
    const pane = [...document.querySelectorAll<HTMLElement>(".pane-slot")]
      .find((candidate) => candidate.dataset.terminalId === id);
    if (!pane) throw new Error(`terminal ${id} has no production pane slot`);
    if (originalStyle === null) pane.removeAttribute("style");
    else pane.setAttribute("style", originalStyle);
  }, { id: terminalId, style });
}

async function waitForBoundGeometry(
  page: Page,
  terminalId: string,
  expected: BoundGeometry,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected: target, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      const sent = snapshot.sentViewport;
      const server = snapshot.serverViewport;
      return snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && desired?.cols === target.sentCols
        && desired.rows === target.sentRows
        && sent?.cols === target.sentCols
        && sent.rows === target.sentRows
        && server?.cols === target.serverCols
        && server.rows === target.serverRows
        && snapshot.cols === target.serverCols
        && snapshot.rows === target.serverRows
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0;
    }, { timeout });
  }, { id: terminalId, expected, timeout: WAIT_TIMEOUT_MS });
}

async function waitForWrappedMarker(page: Page, terminalId: string, marker: string): Promise<E2ETerminalSnapshot> {
  const snapshot = await page.evaluate(async ({ id, marker: expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (candidate) => candidate.xterm.text.replace(/\s+/g, "").includes(expected), { timeout });
  }, { id: terminalId, marker, timeout: WAIT_TIMEOUT_MS });
  const normalized = snapshot.xterm.text.replace(/\s+/g, "");
  expect(normalized.split(marker).length - 1).toBe(1);
  return snapshot;
}

function assertSafeViewports(snapshot: E2ETerminalSnapshot, label: string): void {
  expect(snapshot.cols, `${label}: browser columns must be positive`).toBeGreaterThan(0);
  expect(snapshot.rows, `${label}: browser rows must be positive`).toBeGreaterThan(0);
  expect(snapshot.pixelWidth, `${label}: browser pixel width must be positive`).toBeGreaterThan(0);
  expect(snapshot.pixelHeight, `${label}: browser pixel height must be positive`).toBeGreaterThan(0);
  for (const [name, viewport] of [
    ["proposed", snapshot.proposedViewport],
    ["desired", snapshot.desiredViewport],
    ["url", snapshot.urlViewport],
    ["sent", snapshot.sentViewport],
    ["server", snapshot.serverViewport],
  ] as const) {
    if (!viewport) continue;
    expect(Number.isFinite(viewport.cols), `${label}: ${name} columns must be finite`).toBe(true);
    expect(Number.isFinite(viewport.rows), `${label}: ${name} rows must be finite`).toBe(true);
    expect(Number.isFinite(viewport.pixelWidth), `${label}: ${name} pixel width must be finite`).toBe(true);
    expect(Number.isFinite(viewport.pixelHeight), `${label}: ${name} pixel height must be finite`).toBe(true);
    expect(viewport.cols, `${label}: ${name} columns must be positive`).toBeGreaterThan(0);
    expect(viewport.rows, `${label}: ${name} rows must be positive`).toBeGreaterThan(0);
    expect(viewport.pixelWidth, `${label}: ${name} pixel width must be positive`).toBeGreaterThan(0);
    expect(viewport.pixelHeight, `${label}: ${name} pixel height must be positive`).toBeGreaterThan(0);
    expect(viewport.cols, `${label}: ${name} columns exceed the configured cap`).toBeLessThanOrEqual(MAX_COLUMNS);
    expect(viewport.rows, `${label}: ${name} rows exceed the configured cap`).toBeLessThanOrEqual(MAX_ROWS);
    expect(viewport.pixelWidth, `${label}: ${name} pixel width exceeds the u16 cap`).toBeLessThanOrEqual(MAX_PIXEL_DIMENSION);
    expect(viewport.pixelHeight, `${label}: ${name} pixel height exceeds the u16 cap`).toBeLessThanOrEqual(MAX_PIXEL_DIMENSION);
  }
}

async function assertFixtureGeometry(
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  snapshot: E2ETerminalSnapshot,
  token: string,
  label: string,
  sequence: number,
): Promise<void> {
  const sent = snapshot.sentViewport;
  if (!sent) throw new Error(`${label}: no sent viewport in diagnostics`);

  const sizeId = `${token}-${label}-SIZE`;
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(numericField(size, "rows")).toBe(snapshot.rows);
  expect(numericField(size, "cols")).toBe(snapshot.cols);
  expect(numericField(size, "pixel_width")).toBe(sent.pixelWidth);
  expect(numericField(size, "pixel_height")).toBe(sent.pixelHeight);

  const winchId = `${token}-${label}-WINCH`;
  await pane.sendInput(`WINCH ${winchId} ${sequence} ${snapshot.rows} ${snapshot.cols}`, true);
  const winch = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sigwinch" && entry.id === winchId && entry.source === "command",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(numericField(winch, "signal_sequence")).toBe(sequence);
  expect(numericField(winch, "rows")).toBe(snapshot.rows);
  expect(numericField(winch, "cols")).toBe(snapshot.cols);
  expect(numericField(winch, "actual_rows")).toBe(snapshot.rows);
  expect(numericField(winch, "actual_cols")).toBe(snapshot.cols);

  const queryId = `${token}-${label}-QUERY`;
  await pane.sendInput(`QUERY ${queryId}`, true);
  const queryComplete = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "query_complete" && entry.id === queryId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const replies = numericField(queryComplete, "replies");
  expect(replies).toBeGreaterThan(0);
  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "query_reply" && entry.id === queryId)).toHaveLength(replies!);
}

test("V-14 Minimum and maximum dimensions @p1 @resize @bounds @nightly", async ({ page, server }, testInfo: TestInfo) => {
  await page.setViewportSize(INITIAL_VIEWPORT);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountEvent = page.evaluate(async ({ timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, { timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const baseline = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const originalPaneStyle = await paneStyle(page, terminalId);
  const token = `V014-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-${Date.now()}`;

  const minEventFloor = eventBoundary(await pane.events());
  await setPaneGeometry(page, terminalId, MINIMUM_PANE.width, MINIMUM_PANE.height);
  await waitForViewportAfter(page, terminalId, minEventFloor);
  const minState = await waitForBoundGeometry(page, terminalId, {
    sentCols: 1,
    sentRows: 1,
    serverCols: 2,
    serverRows: 1,
  });
  const minConverged = await expectTerminalConverged(page, terminalId, { cols: 2, rows: 1 }, { timeout: WAIT_TIMEOUT_MS });
  expect(minConverged.sentViewport?.cols).toBe(1);
  expect(minConverged.sentViewport?.rows).toBe(1);
  expect(minConverged.serverViewport?.cols).toBe(2);
  expect(minConverged.serverViewport?.rows).toBe(1);
  expect(minConverged.viewport.cols).toBe(2);
  expect(minConverged.viewport.rows).toBe(1);
  assertSafeViewports(minConverged, "minimum");
  const minBeforePixels = await screenshotRegion(page, pane.xtermHost);
  const minPrintId = `${token}-MIN-PRINT`;
  const minPrintText = `${token}-MINIMUM-CLAMP`;
  const minPrintEventFloor = eventBoundary(await pane.events());
  await pane.sendInput(`PRINT ${minPrintId} ${minPrintText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === minPrintId, { timeoutMs: WAIT_TIMEOUT_MS });
  await waitForWrappedMarker(page, terminalId, `[E2E:PRINT:${minPrintId}:${minPrintText}]`);
  await waitForEventAfter(page, terminalId, minPrintEventFloor, "render");
  await expectKnownMarkerChanged(page, pane.xtermHost, minBeforePixels, {
    minimumChangedRatio: 0.0001,
    testInfo,
    artifactName: "v14-minimum-marker-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.0001,
    testInfo,
    artifactName: "v14-minimum-terminal-crop",
  });
  await assertFixtureGeometry(server, pane, terminalId, minConverged, token, "MIN", 1);

  const maxEventFloor = eventBoundary(await pane.events());
  await setPaneGeometry(page, terminalId, MAXIMUM_PANE.width, MAXIMUM_PANE.height);
  await waitForViewportAfter(page, terminalId, maxEventFloor);
  const maxState = await waitForBoundGeometry(page, terminalId, {
    sentCols: MAX_COLUMNS,
    sentRows: MAX_ROWS,
    serverCols: MAX_COLUMNS,
    serverRows: MAX_ROWS,
  });
  const maxConverged = await expectTerminalConverged(page, terminalId, {
    cols: MAX_COLUMNS,
    rows: MAX_ROWS,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(maxConverged.sentViewport?.cols).toBe(MAX_COLUMNS);
  expect(maxConverged.sentViewport?.rows).toBe(MAX_ROWS);
  expect(maxConverged.serverViewport?.cols).toBe(MAX_COLUMNS);
  expect(maxConverged.serverViewport?.rows).toBe(MAX_ROWS);
  expect(maxConverged.sentViewport?.pixelWidth).toBe(MAX_PIXEL_DIMENSION);
  expect(maxConverged.sentViewport?.pixelHeight).toBe(MAX_PIXEL_DIMENSION);
  expect(maxConverged.serverViewport?.pixelWidth).toBe(MAX_PIXEL_DIMENSION);
  expect(maxConverged.serverViewport?.pixelHeight).toBe(MAX_PIXEL_DIMENSION);
  expect(maxConverged.viewport.cols).toBe(MAX_COLUMNS);
  expect(maxConverged.viewport.rows).toBe(MAX_ROWS);
  assertSafeViewports(maxConverged, "maximum");
  const maxBeforePixels = await screenshotRegion(page, workbench.editorGrid);
  const maxPrintId = `${token}-MAX-PRINT`;
  const maxPrintText = `${token}-MAXIMUM-CLAMP`;
  const maxPrintEventFloor = eventBoundary(await pane.events());
  await pane.sendInput(`PRINT ${maxPrintId} ${maxPrintText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === maxPrintId, { timeoutMs: WAIT_TIMEOUT_MS });
  await waitForWrappedMarker(page, terminalId, `[E2E:PRINT:${maxPrintId}:${maxPrintText}]`);
  await waitForEventAfter(page, terminalId, maxPrintEventFloor, "render");
  await expectKnownMarkerChanged(page, workbench.editorGrid, maxBeforePixels, {
    minimumChangedRatio: 0.0001,
    testInfo,
    artifactName: "v14-maximum-marker-crop",
  });
  await expectTerminalNonBlank(page, workbench.editorGrid, {
    minimumNonBackgroundRatio: 0.0001,
    testInfo,
    artifactName: "v14-maximum-terminal-crop",
  });
  await assertFixtureGeometry(server, pane, terminalId, maxConverged, token, "MAX", 2);

  const restoreEventFloor = eventBoundary(await pane.events());
  await restorePaneStyle(page, terminalId, originalPaneStyle);
  await waitForViewportAfter(page, terminalId, restoreEventFloor);
  const restored = await expectTerminalConverged(page, terminalId, {
    cols: baseline.cols,
    rows: baseline.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(restored.serverViewport?.cols).toBe(baseline.cols);
  expect(restored.serverViewport?.rows).toBe(baseline.rows);
  assertSafeViewports(restored, "restored");

  const echoId = `${token}-ECHO`;
  const echoPayload = `${token}-CONTINUED-INPUT`;
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(echoPayload, true);
  const echoEntry = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const payloadBase64 = Buffer.from(echoPayload, "utf8").toString("base64");
  expect(echoEntry.payload_base64).toBe(payloadBase64);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${echoId}:${payloadBase64}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const final = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);
  assertNoUnexpectedSocketMultiplication([baseline, minState, minConverged, maxState, maxConverged, restored, final]);
  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(browserErrors).toEqual([]);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "v14-final-terminal-crop",
  });
});
