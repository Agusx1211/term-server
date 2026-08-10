import type { Page, TestInfo } from "@playwright/test";
import { Buffer } from "node:buffer";
import { Terminal } from "../fixtures/headless-terminal.js"
import { expect, test } from "../fixtures/test.js";
import type { NetworkFaultController, NetworkFaultEvent } from "../fixtures/network-faults.js";
import type { TranscriptEntry } from "../fixtures/test.js";
import {
  installBrowserErrorCollectors,
  type BrowserErrorCollector,
} from "../fixtures/artifacts.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type { SidebarPage } from "../pages/sidebar-page.js";
import type { TerminalPanePage } from "../pages/terminal-pane.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 45_000;
const PREVIEW_PANE_PREFIX = "preview-";
const BURST_BYTES = 65_536;
const BURST_LINE_WIDTH = 96;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly clients: number;
};


type PreviewRoundBaseline = {
  readonly snapshot: E2ETerminalSnapshot;
  readonly eventFloor: number;
  readonly transcriptFloor: number;
  readonly pixels: TerminalPixelImage;
  readonly canvasCount: number;
  readonly renderer: E2ETerminalSnapshot["rendererState"];
};

function previewPaneId(terminalId: string): string {
  return `${PREVIEW_PANE_PREFIX}${terminalId}`;
}

function marker(operation: string, ...fields: readonly string[]): string {
  return `[E2E:${operation}${fields.map((field) => `:${field}`).join("")}]\n`;
}

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function transcriptSequence(entry: TranscriptEntry): number {
  return typeof entry.sequence === "number" && Number.isFinite(entry.sequence) ? entry.sequence : 0;
}

function writeBytes(entry: TranscriptEntry): Buffer {
  if (typeof entry.data_base64 !== "string") throw new Error("fixture write omitted data_base64");
  return Buffer.from(entry.data_base64, "base64");
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
  await new Promise<void>((resolve) => terminal.write(new Uint8Array(bytes), resolve));
}

async function replayFixtureWrites(
  snapshot: E2ETerminalSnapshot,
  entries: readonly TranscriptEntry[],
): Promise<Terminal> {
  const model = new Terminal({
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: 200_000,
    ...tuiCompatibilityOptions(),
  });
  for (const entry of entries) {
    if (entry.event === "write") await writeModel(model, writeBytes(entry));
  }
  return model;
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} was not listed`);
    return terminal;
  }, terminalId);
}

async function waitForPreviewEvent(
  page: Page,
  terminalId: string,
  type: E2ETerminalEventType,
): Promise<E2ETerminalEvent> {
  const paneId = previewPaneId(terminalId);
  return page.evaluate(async ({ id, pane, expectedType, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.terminalId === id && event.paneId === pane && event.type === expectedType,
      { timeout },
    );
  }, { id: terminalId, pane: paneId, expectedType: type, timeout: WAIT_TIMEOUT_MS });
}

async function waitForPreviewText(
  page: Page,
  terminalId: string,
  text: string,
): Promise<E2ETerminalSnapshot> {
  const paneId = previewPaneId(terminalId);
  return page.evaluate(async ({ id, pane, expectedText, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const event = await api.waitForEvent(
      (candidate) => (
        candidate.terminalId === id
        && candidate.paneId === pane
        && candidate.snapshot.xterm.text.includes(expectedText)
        && candidate.snapshot.pendingParserWrites === 0
        && candidate.snapshot.renderBacklogBytes === 0
      ),
      { timeout },
    );
    return event.snapshot;
  }, { id: terminalId, pane: paneId, expectedText: text, timeout: WAIT_TIMEOUT_MS });
}

async function waitForPreviewUnavailability(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  const paneId = previewPaneId(terminalId);
  return page.evaluate(async ({ id, pane, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const event = await api.waitForEvent(
      (candidate) => (
        candidate.terminalId === id
        && candidate.paneId === pane
        && candidate.type === "socket-close"
      ),
      { timeout },
    );
    return event.snapshot;
  }, { id: terminalId, pane: paneId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSourceInteractive(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.kind === "pane"
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.lifecycle.active
      && snapshot.lifecycle.visible
      && snapshot.focused
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.serverViewport !== undefined
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSourceOutput(
  page: Page,
  terminalId: string,
  expectedEnd: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, end, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.receivedSequence === end
      && snapshot.committedSequence === end
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
    ), { timeout });
  }, { id: terminalId, end: expectedEnd, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function closePreview(
  page: Page,
  sidebar: SidebarPage,
  terminalId: string,
  terminalName: string,
): Promise<void> {
  const unmount = waitForPreviewEvent(page, terminalId, "unmount");
  await sidebar.root.locator(".sidebar-header").hover();
  await unmount;
  await expect(page.getByRole("tooltip", { name: `Live preview of ${terminalName}`, exact: true })).toHaveCount(0);
  expect(await terminalSnapshot(page, terminalId, previewPaneId(terminalId))).toBeUndefined();
}

async function prepareRound(
  page: Page,
  pane: TerminalPanePage,
  server: { readTranscript<T extends TranscriptEntry = TranscriptEntry>(terminalId: string): Promise<T[]>; waitForTranscript<T extends TranscriptEntry = TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean, options?: { timeoutMs?: number }): Promise<T> },
  terminalId: string,
  token: string,
): Promise<PreviewRoundBaseline> {
  await pane.expectVisible();
  await pane.focus();
  const interactive = await waitForSourceInteractive(page, terminalId);
  if (!interactive.serverViewport) throw new Error("source terminal did not report a server viewport");
  const sizeId = `${token}-SIZE`;
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(sizeEntry.rows).toBe(interactive.rows);
  expect(sizeEntry.cols).toBe(interactive.cols);
  expect(sizeEntry.pixel_width).toBe(interactive.serverViewport.pixelWidth);
  expect(sizeEntry.pixel_height).toBe(interactive.serverViewport.pixelHeight);
  const winchId = `${token}-WINCH`;
  await pane.sendInput(`WINCH ${winchId} 1 ${interactive.rows} ${interactive.cols}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sigwinch" && entry.id === winchId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const beforeErase = await server.readTranscript(terminalId);
  const eraseId = `${token}-ERASE`;
  await pane.sendInput(`ERASE ${eraseId} scrollback`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "erase" && entry.id === eraseId, { timeoutMs: WAIT_TIMEOUT_MS });
  const eraseMarker = marker("ERASE", eraseId, "scrollback");
  await page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => snapshot.xterm.text.includes(expected), { timeout });
  }, { id: terminalId, expected: eraseMarker, timeout: WAIT_TIMEOUT_MS });
  const snapshot = await terminalSnapshot(page, terminalId);
  if (!snapshot) throw new Error(`missing source diagnostics for ${terminalId}`);
  const sourceViewport = pane.xtermHost.locator(".xterm-screen");
  const pixels = await screenshotRegion(page, sourceViewport);
  await expectTerminalNonBlank(page, sourceViewport, {
    minimumNonBackgroundRatio: 0.001,
  });
  const events = await terminalEvents(page, terminalId);
  const transcript = await server.readTranscript(terminalId);
  const transcriptFloor = transcript.reduce((largest, entry) => Math.max(largest, transcriptSequence(entry)), 0);
  expect(transcriptFloor).toBeGreaterThan(beforeErase.reduce((largest, entry) => Math.max(largest, transcriptSequence(entry)), 0));
  expect(snapshot.serverViewport).toEqual(interactive.serverViewport);
  expect(snapshot.cols).toBe(interactive.cols);
  expect(snapshot.rows).toBe(interactive.rows);
  expect(snapshot.focused).toBe(true);
  expect(snapshot.acceptingInput).toBe(true);
  return {
    snapshot,
    eventFloor: events.reduce((largest, event) => Math.max(largest, event.id), 0),
    transcriptFloor,
    pixels,
    canvasCount: await pane.xtermHost.locator("canvas").count(),
    renderer: snapshot.rendererState,
  };
}

async function exercisePreviewRound({
  page,
  pane,
  sidebar,
  server,
  faultController,
  terminalId,
  terminalName,
  baseline,
  token,
  testInfo,
}: {
  readonly page: Page;
  readonly pane: TerminalPanePage;
  readonly sidebar: SidebarPage;
  readonly server: { readTranscript<T extends TranscriptEntry = TranscriptEntry>(terminalId: string): Promise<T[]>; waitForTranscript<T extends TranscriptEntry = TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean, options?: { timeoutMs?: number }): Promise<T> };
  readonly faultController: NetworkFaultController;
  readonly terminalId: string;
  readonly terminalName: string;
  readonly baseline: PreviewRoundBaseline;
  readonly token: string;
  readonly testInfo: TestInfo;
}): Promise<void> {
  const sourceViewport = pane.xtermHost.locator(".xterm-screen");
  const previewId = previewPaneId(terminalId);
  const previewSocketOpen = waitForPreviewEvent(page, terminalId, "socket-open");
  const previewSynced = waitForPreviewEvent(page, terminalId, "synced");
  const preview = await sidebar.openPreview({ id: terminalId, name: terminalName });
  await Promise.all([previewSocketOpen, previewSynced]);
  await expect(preview.locator(".terminal-preview-status.connected")).toBeVisible();

  const openedPreview = await terminalSnapshot(page, terminalId, previewId);
  if (!openedPreview) throw new Error(`missing preview diagnostics for ${terminalId}`);
  expect(openedPreview.kind).toBe("preview");
  expect(openedPreview.paneId).toBe(previewId);
  expect(openedPreview.socketState).toBe("connected");
  expect(openedPreview.socket.activeCount).toBe(1);
  expect(openedPreview.activeSocketCount).toBe(1);
  expect(openedPreview.socketUrl).toContain("observer=true");
  expect(openedPreview.urlViewport).toBeUndefined();
  expect(openedPreview.sentViewport).toBeUndefined();
  expect(openedPreview.focused).toBe(false);
  expect(openedPreview.acceptingInput).toBe(false);
  expect(openedPreview.activeBuffer).toBe("normal");
  expect(openedPreview.serverViewport?.cols).toBe(baseline.snapshot.serverViewport?.cols);
  expect(openedPreview.serverViewport?.rows).toBe(baseline.snapshot.serverViewport?.rows);
  expect(openedPreview.serverViewport?.pixelWidth).toBeGreaterThan(0);
  expect(openedPreview.serverViewport?.pixelHeight).toBeGreaterThan(0);

  const sourceAfterOpen = await terminalSnapshot(page, terminalId);
  if (!sourceAfterOpen) throw new Error(`source diagnostics disappeared for ${terminalId}`);
  expect(sourceAfterOpen.kind).toBe("pane");
  expect(sourceAfterOpen.socketGeneration).toBe(baseline.snapshot.socketGeneration);
  expect(sourceAfterOpen.socketState).toBe("connected");
  expect(sourceAfterOpen.activeSocketCount).toBe(1);
  expect(sourceAfterOpen.focused).toBe(true);
  expect(sourceAfterOpen.acceptingInput).toBe(true);
  expect(sourceAfterOpen.cols).toBe(baseline.snapshot.cols);
  expect(sourceAfterOpen.rows).toBe(baseline.snapshot.rows);
  expect(sourceAfterOpen.viewport).toEqual(baseline.snapshot.viewport);
  expect(sourceAfterOpen.proposedViewport).toEqual(baseline.snapshot.proposedViewport);
  expect(sourceAfterOpen.desiredViewport).toEqual(baseline.snapshot.desiredViewport);
  expect(sourceAfterOpen.sentViewport).toEqual(baseline.snapshot.sentViewport);
  expect(sourceAfterOpen.serverViewport).toEqual(baseline.snapshot.serverViewport);
  expect(sourceAfterOpen.gridEpoch).toBe(baseline.snapshot.gridEpoch);
  expect(sourceAfterOpen.rendererState.webglLoadCount).toBe(baseline.renderer.webglLoadCount);
  expect(sourceAfterOpen.rendererState.contextLossCount).toBe(baseline.renderer.contextLossCount);
  expect(sourceAfterOpen.rendererState.fallbackCount).toBe(baseline.renderer.fallbackCount);
  expect(await readTerminal(page, terminalId)).toMatchObject({ clients: 1 });

  const sourceEventsAfterOpen = (await terminalEvents(page, terminalId)).filter((event) => event.id > baseline.eventFloor);
  expect(sourceEventsAfterOpen.filter((event) => event.type === "viewport" || event.type === "size")).toHaveLength(0);
  expect(sourceEventsAfterOpen.filter((event) => event.type === "error")).toHaveLength(0);

  const previewPixelsBefore = await screenshotRegion(page, preview.locator(".terminal-preview-xterm"));
  const sourcePixelsBefore = await screenshotRegion(page, sourceViewport);
  expect(sourcePixelsBefore.width).toBe(baseline.pixels.width);
  expect(sourcePixelsBefore.height).toBe(baseline.pixels.height);
  await expectTerminalNonBlank(page, preview.locator(".terminal-preview-xterm"), {
    minimumNonBackgroundRatio: 0.001,
    testInfo,
    artifactName: `w09-${token}-preview-before-crop`,
  });

  await page.keyboard.press("Shift");
  const afterPreviewKey = await terminalSnapshot(page, terminalId);
  if (!afterPreviewKey) throw new Error(`source diagnostics disappeared after preview key for ${terminalId}`);
  expect(afterPreviewKey.focused).toBe(true);
  expect(afterPreviewKey.acceptingInput).toBe(true);
  expect(afterPreviewKey.cols).toBe(baseline.snapshot.cols);
  expect(afterPreviewKey.rows).toBe(baseline.snapshot.rows);

  const printId = `${token}-PRINT`;
  const printText = `preview-isolated-${token}`;
  const printMarker = marker("PRINT", printId, printText);
  await pane.sendInput(`PRINT ${printId} ${printText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === printId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: printMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const sourceAfterPrint = await page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.xterm.text.includes(expected)
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, expected: printMarker, timeout: WAIT_TIMEOUT_MS });
  const previewAfterPrint = await waitForPreviewText(page, terminalId, printMarker);
  expect(sourceAfterPrint.xterm.text).toContain(printMarker);
  expect(previewAfterPrint.xterm.text).toContain(printMarker);
  expect(previewAfterPrint.focused).toBe(false);
  expect(previewAfterPrint.acceptingInput).toBe(false);
  expect(previewAfterPrint.serverViewport?.cols).toBe(baseline.snapshot.cols);
  expect(previewAfterPrint.serverViewport?.rows).toBe(baseline.snapshot.rows);

  const sourcePixelsAfter = await expectKnownMarkerChanged(page, sourceViewport, sourcePixelsBefore, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `w09-${token}-source-marker-crop`,
  });
  const previewPixelsAfter = await expectKnownMarkerChanged(page, preview.locator(".terminal-preview-xterm"), previewPixelsBefore, {
    minimumChangedRatio: 0.001,
    testInfo,
    artifactName: `w09-${token}-preview-marker-crop`,
  });
  expect(sourcePixelsAfter.after.width).toBe(sourcePixelsBefore.width);
  expect(sourcePixelsAfter.after.height).toBe(sourcePixelsBefore.height);
  expect(previewPixelsAfter.after.width).toBe(previewPixelsBefore.width);
  expect(previewPixelsAfter.after.height).toBe(previewPixelsBefore.height);
  await expectTerminalNonBlank(page, sourceViewport, {
    testInfo,
    artifactName: `w09-${token}-source-after-crop`,
  });
  await expectTerminalNonBlank(page, preview.locator(".terminal-preview-xterm"), {
    minimumNonBackgroundRatio: 0.001,
    testInfo,
    artifactName: `w09-${token}-preview-after-crop`,
  });

  const writesAtPrint = await server.readTranscript(terminalId);
  const sourceModel = await replayFixtureWrites(sourceAfterPrint, writesAtPrint);
  const previewModel = await replayFixtureWrites(previewAfterPrint, writesAtPrint);
  expect(sourceAfterPrint.xterm.text).toBe(activeText(sourceModel));
  expect(previewAfterPrint.xterm.text).toBe(activeText(previewModel));
  expect(sourceAfterPrint.xterm.activeBuffer).toBe(sourceModel.buffer.active.type);
  expect(previewAfterPrint.xterm.activeBuffer).toBe(previewModel.buffer.active.type);
  sourceModel.dispose();
  previewModel.dispose();

  const faultEventFloor = faultController.events.length;
  const maxConnectionBeforePause = faultController.events.reduce(
    (largest, event) => Math.max(largest, event.connectionId ?? -1),
    -1,
  );
  const pauseRule = faultController.pause("server-to-browser", {
    terminalId,
    url: "*observer=true*",
  });
  let pauseEvent: NetworkFaultEvent | undefined;
  try {
    pauseEvent = await faultController.waitFor(
      (event) => event.type === "paused"
        && event.terminalId === terminalId
        && event.direction === "server-to-browser"
        && event.connectionId !== undefined
        && event.connectionId > maxConnectionBeforePause,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const pauseConnectionId = pauseEvent.connectionId;
    if (pauseConnectionId === undefined) throw new Error("preview pause event omitted connection ID");
    const pauseEventIndex = faultController.events.indexOf(pauseEvent);
    expect(pauseEventIndex).toBeGreaterThanOrEqual(faultEventFloor);

    const holdToken = `${token}-HOLD`;
    await pane.sendInput(`HOLD ${holdToken}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`RELEASE ${holdToken}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });

    const burstId = `${token}-BURST`;
    const burstPromise = server.waitForTranscript(terminalId, (entry) => entry.event === "burst" && entry.id === burstId, { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    await burstPromise;
    const postBurstSizeId = `${token}-POST-SIZE`;
    await pane.sendInput(`SIZE ${postBurstSizeId}`, true);
    const postBurstSize = await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "size" && entry.id === postBurstSizeId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(postBurstSize.rows).toBe(baseline.snapshot.rows);
    expect(postBurstSize.cols).toBe(baseline.snapshot.cols);
    expect(postBurstSize.pixel_width).toBe(baseline.snapshot.serverViewport?.pixelWidth);
    expect(postBurstSize.pixel_height).toBe(baseline.snapshot.serverViewport?.pixelHeight);

    const echoId = `${token}-ECHO`;
    const inputMarker = `${token}-continued-input`;
    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(inputMarker, true);
    const echoPayload = await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
    expect(echoPayload.payload_base64).toBe(base64(inputMarker));

    const queryId = `${token}-QUERY`;
    const queryComplete = server.waitForTranscript(terminalId, (entry) => entry.event === "query_complete" && entry.id === queryId, { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`QUERY ${queryId}`, true);
    await queryComplete;
    const queryEntries = (await server.readTranscript(terminalId)).filter((entry) => entry.event === "query_reply" && entry.id === queryId);
    expect(queryEntries).toHaveLength(6);

    const transcriptAfterInput = await server.readTranscript(terminalId);
    const scenarioWrites = transcriptAfterInput
      .filter((entry) => transcriptSequence(entry) > baseline.transcriptFloor && entry.event === "write")
      .map(writeBytes);
    const expectedEnd = baseline.snapshot.receivedSequence! + scenarioWrites.reduce((total, bytes) => total + bytes.length, 0);
    const settled = await waitForSourceOutput(page, terminalId, expectedEnd);
    expect(settled.focused).toBe(true);
    expect(settled.acceptingInput).toBe(true);
    expect(settled.cols).toBe(baseline.snapshot.cols);
    expect(settled.rows).toBe(baseline.snapshot.rows);
    expect(settled.serverViewport).toEqual(baseline.snapshot.serverViewport);
    expect(settled.gridEpoch).toBe(baseline.snapshot.gridEpoch);
    expect(settled.rendererState.renderCount).toBeGreaterThan(baseline.snapshot.rendererState.renderCount);
    expect(settled.flowAcknowledgedBytes).toBeGreaterThanOrEqual(expectedEnd);
    expect(settled.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);

    const preResumeEvents = faultController.events.slice(pauseEventIndex);
    expect(preResumeEvents.filter((event) => (
      event.type === "frame"
      && event.connectionId === pauseConnectionId
      && event.direction === "server-to-browser"
    ))).toHaveLength(0);
    expect(preResumeEvents.filter((event) => (
      event.type === "frame"
      && event.connectionId !== pauseConnectionId
      && event.direction === "server-to-browser"
      && event.frame?.binaryKind === 1
    )).length).toBeGreaterThan(0);
    expect(preResumeEvents.filter((event) => event.type === "paused" && event.connectionId !== pauseConnectionId)).toHaveLength(0);
    expect(preResumeEvents.filter((event) => (
      event.connectionId === pauseConnectionId
      && event.direction === "browser-to-server"
      && ["input", "resize", "focus"].includes(event.frame?.jsonType ?? "")
    ))).toHaveLength(0);

    const resumeWait = faultController.waitFor(
      (event) => event.type === "resumed"
        && event.terminalId === terminalId
        && event.direction === "server-to-browser"
        && event.connectionId === pauseConnectionId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    faultController.resume("server-to-browser", { terminalId, url: "*observer=true*" });
    await resumeWait;
    pauseRule.dispose();

    const previewSocketClose = waitForPreviewUnavailability(page, terminalId);
    const previewTerminated = faultController.waitFor(
      (event) => event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.connectionId === pauseConnectionId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const terminateRule = faultController.terminate({ terminalId, url: "*observer=true*" });
    await previewTerminated;
    await previewSocketClose;
    terminateRule.dispose();

    const terminatedPreview = await terminalSnapshot(page, terminalId, previewId);
    if (!terminatedPreview) throw new Error("terminated preview diagnostics disappeared before unmount");
    expect(terminatedPreview.kind).toBe("preview");
    expect(terminatedPreview.socketState).toBe("closed");
    expect(terminatedPreview.activeSocketCount).toBe(0);
    expect(terminatedPreview.socket.activeCount).toBe(0);
    expect(terminatedPreview.focused).toBe(false);
    expect(terminatedPreview.acceptingInput).toBe(false);
    const previewEvents = await terminalEvents(page, terminalId, previewId);
    await assertMonotonicSequences(previewEvents);
    expect(previewEvents.filter((event) => event.type === "error")).toHaveLength(0);
    expect(previewEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(previewEvents.filter((event) => event.type === "socket-close")).toHaveLength(1);
  } finally {
    if (pauseEvent) faultController.resume("server-to-browser", { terminalId, url: "*observer=true*" });
    pauseRule.dispose();
  }

  await closePreview(page, sidebar, terminalId, terminalName);
  expect(await page.locator(".terminal-preview-xterm canvas").count()).toBe(0);
  const finalSource = await terminalSnapshot(page, terminalId);
  if (!finalSource) throw new Error(`source diagnostics disappeared after preview close for ${terminalId}`);
  expect(finalSource.kind).toBe("pane");
  expect(finalSource.socketState).toBe("connected");
  expect(finalSource.activeSocketCount).toBe(1);
  expect(finalSource.socket.activeCount).toBe(1);
  expect(finalSource.socketGeneration).toBe(baseline.snapshot.socketGeneration);
  expect(finalSource.focused).toBe(true);
  expect(finalSource.acceptingInput).toBe(true);
  expect(finalSource.cols).toBe(baseline.snapshot.cols);
  expect(finalSource.rows).toBe(baseline.snapshot.rows);
  expect(finalSource.viewport).toEqual(baseline.snapshot.viewport);
  expect(finalSource.proposedViewport).toEqual(baseline.snapshot.proposedViewport);
  expect(finalSource.desiredViewport).toEqual(baseline.snapshot.desiredViewport);
  expect(finalSource.sentViewport).toEqual(baseline.snapshot.sentViewport);
  expect(finalSource.serverViewport).toEqual(baseline.snapshot.serverViewport);
  expect(finalSource.gridEpoch).toBe(baseline.snapshot.gridEpoch);
  expect(finalSource.rendererState.webglLoadCount).toBe(baseline.renderer.webglLoadCount);
  expect(finalSource.rendererState.contextLossCount).toBe(baseline.renderer.contextLossCount);
  expect(finalSource.rendererState.fallbackCount).toBe(baseline.renderer.fallbackCount);
  expect(await pane.xtermHost.locator("canvas").count()).toBe(baseline.canvasCount);
  expect(await readTerminal(page, terminalId)).toMatchObject({ clients: 1 });

  const finalTranscript = await server.readTranscript(terminalId);
  expect(finalTranscript.filter((entry) => transcriptSequence(entry) > baseline.transcriptFloor && entry.event === "sigwinch")).toHaveLength(0);
  expect(finalTranscript.filter((entry) => transcriptSequence(entry) > baseline.transcriptFloor && entry.event === "error")).toHaveLength(0);
  const sourceEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(sourceEvents);
  expect(sourceEvents.filter((event) => event.type === "error")).toHaveLength(0);
}

test("@p1 @nightly @workspace @preview W-09 Preview isolation", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors: BrowserErrorCollector = installBrowserErrorCollectors(page);
  try {
    await page.setViewportSize({ width: 1_280, height: 800 });
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const settings = await workbench.openSettings();
    await settings.setToggle("Live terminal hover previews", true);
    await settings.setHoverDelay(0);
    await settings.setPreviewAnimationDuration(0);
    await settings.choosePreviewMode("compact");
    await workbench.showTerminals();

    const mountPromise = page.evaluate(async ({ timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount" && event.paneId.startsWith("pane-"), { timeout });
    }, { timeout: WAIT_TIMEOUT_MS });
    await workbench.createTerminal();
    const mounted = await mountPromise;
    const terminalId = mounted.terminalId;
    const pane = workbench.terminal(terminalId);
    await pane.expectVisible();
    const paneLabel = await pane.root.getAttribute("aria-label");
    const terminalName = paneLabel?.replace(/^Terminal(?: pane)?\s+/i, "");
    if (!terminalName) throw new Error("source terminal did not expose an accessible name");

    const compactToken = `W09-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}-COMPACT`
      .replace(/[^A-Za-z0-9_-]+/g, "-");
    const compactBaseline = await prepareRound(page, pane, server, terminalId, compactToken);
    await exercisePreviewRound({
      page,
      pane,
      sidebar: workbench.sidebar,
      server,
      faultController,
      terminalId,
      terminalName,
      baseline: compactBaseline,
      token: compactToken,
      testInfo,
    });

    const largeSettings = await workbench.openSettings();
    await largeSettings.choosePreviewMode("large");
    await workbench.showTerminals();
    await pane.expectVisible();
    await pane.focus();
    await waitForSourceInteractive(page, terminalId);

    const largeToken = `W09-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}-LARGE`
      .replace(/[^A-Za-z0-9_-]+/g, "-");
    const largeBaseline = await prepareRound(page, pane, server, terminalId, largeToken);
    await exercisePreviewRound({
      page,
      pane,
      sidebar: workbench.sidebar,
      server,
      faultController,
      terminalId,
      terminalName,
      baseline: largeBaseline,
      token: largeToken,
      testInfo,
    });

    const finalBeforeExit = await waitForSourceInteractive(page, terminalId);
    expect(finalBeforeExit.acceptingInput).toBe(true);
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
        && !snapshot.acceptingInput
      ), { timeout });
    }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
    expect(exited.exitCode).toBe(0);
    expect(exited.socket.activeCount).toBe(0);

    const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);

    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || (entry.kind === "console" && /^error:/i.test(entry.message))
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
  } finally {
    browserErrors.dispose();
  }
});
