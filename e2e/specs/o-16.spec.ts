import { Buffer } from "node:buffer";
import { Terminal } from "../fixtures/headless-terminal.js"
import type { Page } from "@playwright/test";
import { expect, test, type TranscriptEntry } from "../fixtures/test.js";
import type {
  NetworkFaultController,
  NetworkFaultEvent,
} from "../fixtures/network-faults.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { SidebarPage } from "../pages/sidebar-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
async function waitForPrimaryViewport(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const fontLoad = await api.waitForEvent(
      id,
      (event) => event.type === "font-load",
      { timeout, afterId: 0 },
    );
    await api.waitForEvent(
      id,
      (event) => event.id > fontLoad.id
        && event.type === "viewport"
        && event.data.source === "proposed",
      { timeout, afterId: fontLoad.id },
    );
    return api.waitForTerminal(id, (snapshot) => {
      const sameViewport = (
        left: E2EViewport | undefined,
        right: E2EViewport | undefined,
      ): boolean => left !== undefined
        && right !== undefined
        && left.cols === right.cols
        && left.rows === right.rows
        && left.pixelWidth === right.pixelWidth
        && left.pixelHeight === right.pixelHeight;
      return (
        snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && snapshot.serverViewport !== undefined
        && snapshot.serverViewport.pixelWidth > 0
        && snapshot.serverViewport.pixelHeight > 0
        && snapshot.sentViewport !== undefined
        && snapshot.proposedViewport !== undefined
        && sameViewport(snapshot.proposedViewport, snapshot.sentViewport)
        && sameViewport(snapshot.sentViewport, snapshot.serverViewport)
      );
    }, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}


type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly clients: number;
};

type RecordingEvent = {
  readonly terminal: string;
  readonly type: string;
  readonly sequence?: number;
  readonly data?: string;
  readonly message?: unknown;
};

type RecordingExport = {
  readonly truncated: boolean;
  readonly events: readonly RecordingEvent[];
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

const WAIT_TIMEOUT_MS = 60_000;
const BURST_BYTES = 6_000_000;
const BURST_LINE_WIDTH = 80;
const FLOW_HIGH_WATERMARK_BYTES = 100_000;
const PREVIEW_PANE_PREFIX = "preview-";
const OBSERVER_ERROR = "observer connections are read-only";

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function marker(operation: string, ...fields: readonly string[]): Buffer {
  return Buffer.from(`[E2E:${operation}${fields.map((field) => `:${field}`).join("")}]\n`, "utf8");
}

function burstBytes(bytes: number, lineWidth: number): Buffer {
  const output = Buffer.allocUnsafe(bytes);
  let offset = 0;
  let column = 0;
  let visible = 0;
  while (offset < bytes) {
    output[offset] = 65 + (visible % 26);
    offset += 1;
    visible += 1;
    column += 1;
    if (column === lineWidth && offset < bytes - 1) {
      output[offset] = 10;
      offset += 1;
      column = 0;
    }
  }
  return output;
}

function transcriptSequence(entry: TranscriptEntry): number {
  return typeof entry.sequence === "number" && Number.isFinite(entry.sequence) ? entry.sequence : 0;
}

function entriesAfter(entries: readonly TranscriptEntry[], sequence: number): TranscriptEntry[] {
  return entries.filter((entry) => transcriptSequence(entry) > sequence);
}

function writeEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((entry) => entry.event === "write");
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

async function terminalSnapshot(
  page: Page,
  terminalId: string,
  paneId?: string,
): Promise<E2ETerminalSnapshot | undefined> {
  return page.evaluate(({ id, requestedPaneId }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminal(id, requestedPaneId);
  }, { id: terminalId, requestedPaneId: paneId });
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
  type: E2ETerminalEventType | readonly E2ETerminalEventType[],
): Promise<E2ETerminalEvent> {
  const types = Array.isArray(type) ? type : [type];
  return page.evaluate(async ({ id, paneId, types: requestedTypes, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.terminalId === id && event.paneId === paneId && requestedTypes.includes(event.type),
      { timeout },
    );
  }, { id: terminalId, paneId: `${PREVIEW_PANE_PREFIX}${terminalId}`, types, timeout: WAIT_TIMEOUT_MS });
}

async function waitForPreviewUnmount(page: Page, terminalId: string): Promise<void> {
  await waitForPreviewEvent(page, terminalId, "unmount");
}

async function waitForPaneSettled(
  page: Page,
  terminalId: string,
  expectedEnd: number,
  markerText: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expectedEnd: end, markerText: expectedMarker, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
      && snapshot.receivedSequence >= end
      && snapshot.xterm.text.includes(expectedMarker)
    ), { timeout });
  }, { id: terminalId, expectedEnd, markerText, timeout: WAIT_TIMEOUT_MS });
}

async function waitForPreviewSettled(
  page: Page,
  terminalId: string,
  expectedEnd: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, paneId, expectedEnd: end, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const deadline = Date.now() + timeout;
    while (Date.now() <= deadline) {
      const snapshot = api.terminal(id, paneId);
      if (snapshot?.socketState === "closed" || snapshot?.socketState === "exited") return snapshot;
      if (
        snapshot?.socketState === "connected"
        && snapshot.committedSequence !== undefined
        && snapshot.committedSequence >= end
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
      ) {
        return snapshot;
      }
      const remaining = Math.max(1, deadline - Date.now());
      await api.waitForEvent(
        (event) => event.terminalId === id
          && event.paneId === paneId
          && ["output-received", "render", "socket-close", "state", "synced"].includes(event.type),
        { timeout: remaining },
      );
    }
    throw new Error("timed out waiting for preview stream to settle");
  }, { id: terminalId, paneId: `${PREVIEW_PANE_PREFIX}${terminalId}`, expectedEnd, timeout: WAIT_TIMEOUT_MS });
}

function framePayloadBytes(frameBytes: number): number {
  const webSocketHeaderBytes = frameBytes < 126 ? 2 : frameBytes < 65_536 ? 4 : 10;
  return frameBytes - webSocketHeaderBytes - 9;
}

function outputFrames(events: readonly NetworkFaultEvent[], terminalId: string): OutputFrame[] {
  return events.filter((event): event is OutputFrame => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "server-to-browser"
    && event.frame?.binaryKind !== undefined
    && event.frame.sequence !== undefined
    && event.frame.bytes !== undefined
    && event.frame.fin === true
    && (event.frame.binaryKind === 0 || event.frame.binaryKind === 1)
  ));
}

function assertFrameSequences(events: readonly NetworkFaultEvent[], terminalId: string): void {
  const expectedByConnection = new Map<number, number>();
  for (const event of outputFrames(events, terminalId)) {
    if (event.connectionId === undefined) continue;
    const sequence = event.frame.sequence;
    const previous = expectedByConnection.get(event.connectionId);
    if (event.frame.binaryKind === 0) {
      expectedByConnection.set(event.connectionId, sequence);
      continue;
    }
    if (previous !== undefined) expect(sequence).toBe(previous);
    const payloadBytes = framePayloadBytes(event.frame.bytes);
    expect(payloadBytes).toBeGreaterThan(0);
    expectedByConnection.set(event.connectionId, sequence + payloadBytes);
  }
}

function uniqueRecordedOutput(
  events: readonly RecordingEvent[],
  terminalId: string,
  baselineSequence: number,
): Buffer {
  const bySequence = new Map<number, Buffer>();
  for (const event of events) {
    if (event.terminal !== terminalId || event.type !== "output" || event.sequence === undefined || event.data === undefined) continue;
    if (event.sequence < baselineSequence) continue;
    const bytes = Buffer.from(event.data, "base64");
    const previous = bySequence.get(event.sequence);
    if (previous) expect(previous.equals(bytes)).toBe(true);
    else bySequence.set(event.sequence, bytes);
  }
  const ordered = [...bySequence.entries()].sort(([left], [right]) => left - right);
  let sequence = baselineSequence;
  const chunks: Buffer[] = [];
  for (const [start, bytes] of ordered) {
    expect(start).toBe(sequence);
    chunks.push(bytes);
    sequence += bytes.length;
  }
  return Buffer.concat(chunks);
}

async function rejectObserverControl(
  page: Page,
  sidebar: SidebarPage,
  terminalName: string,
  terminalId: string,
  faultController: NetworkFaultController,
  data: string | Uint8Array,
  binary: boolean,
): Promise<void> {
  const socketOpen = waitForPreviewEvent(page, terminalId, "socket-open");
  const synced = waitForPreviewEvent(page, terminalId, "synced");
  const preview = await sidebar.openPreview(terminalName);
  await socketOpen;
  await synced;
  await expect(preview.locator(".terminal-preview-status.connected")).toBeVisible();

  const injection = faultController.inject({
    direction: "browser-to-server",
    data,
    binary,
    matcher: { terminalId, url: "*observer=true*" },
  });
  try {
    await faultController.waitFor(
      (event) => event.type === "injected" && event.terminalId === terminalId && event.ruleId === injection.id,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expect(preview.locator(".terminal-preview-error")).toHaveText(OBSERVER_ERROR, { timeout: WAIT_TIMEOUT_MS });
  } finally {
    injection.dispose();
  }

  const unmounted = waitForPreviewUnmount(page, terminalId);
  await sidebar.closePreview();
  await unmounted;
}

test("@nightly @O-16 @observer @preview @flow O-16 Observer preview under load", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let recordingStarted = false;
  try {
    await page.setViewportSize({ width: 1_280, height: 720 });
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const mountPromise = page.evaluate(async ({ timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount", { timeout });
    }, { timeout: WAIT_TIMEOUT_MS });
    await workbench.createTerminal();
    const mounted = await mountPromise;
    const terminalId = mounted.terminalId;
    const pane = new TerminalPanePage(page, terminalId);
    const sidebar = workbench.sidebar;
    await pane.expectVisible();

    const baseline = await waitForPrimaryViewport(page, terminalId);
    if (!baseline.serverViewport) throw new Error("initial terminal server viewport was not reported");
    expect(baseline.serverViewport).toMatchObject({
      cols: baseline.cols,
      rows: baseline.rows,
      pixelWidth: baseline.pixelWidth,
      pixelHeight: baseline.pixelHeight,
    });
    expect(baseline.viewport).toEqual(baseline.serverViewport);

    const token = `${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.retry}`;
    const readyId = `O16-${token}-READY`;
    const doneId = `O16-${token}-DONE`;
    const sizeId = `O16-${token}-SIZE`;
    const echoId = `O16-${token}-ECHO`;
    const inputMarker = `O16-${token}-CONTINUED-INPUT`;
    const doneMarker = `[E2E:PRINT:${doneId}:DONE]`;
    const paneHost = pane.xtermHost.locator(".xterm-screen");
    const beforePanePixels = await screenshotRegion(page, paneHost);
    const transcriptBefore = await server.readTranscript(terminalId);
    const transcriptFloor = transcriptBefore.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
    const paneEventsBefore = await terminalEvents(page, terminalId);
    const paneEventFloor = paneEventsBefore.reduce((floor, event) => Math.max(floor, event.id), 0);
    const baselineReceived = baseline.receivedSequence ?? 0;

    await recordingControl(page, "start");
    recordingStarted = true;

    const initialPreviewSocket = waitForPreviewEvent(page, terminalId, "socket-open");
    const initialPreviewSynced = waitForPreviewEvent(page, terminalId, "synced");
    const preview = await sidebar.openPreview({ id: terminalId });
    await initialPreviewSocket;
    await initialPreviewSynced;
    await expect(preview.locator(".terminal-preview-status.connected")).toBeVisible();
    const initialPreview = await terminalSnapshot(page, terminalId, `${PREVIEW_PANE_PREFIX}${terminalId}`);
    if (!initialPreview) throw new Error("preview diagnostics did not mount");
    expect(initialPreview.kind).toBe("preview");
    expect(initialPreview.urlViewport).toBeUndefined();
    expect(initialPreview.sentViewport).toBeUndefined();
    if (!initialPreview.serverViewport) throw new Error("observer did not report the elected server viewport");
    expect(initialPreview.serverViewport).toMatchObject({
      cols: baseline.serverViewport.cols,
      rows: baseline.serverViewport.rows,
      source: "server",
    });
    const previewBounds = await preview.locator(".terminal-preview-xterm").boundingBox();
    if (!previewBounds) throw new Error("observer preview has no measurable terminal region");
    expect(initialPreview.serverViewport.pixelWidth).toBe(Math.round(previewBounds.width));
    expect(initialPreview.serverViewport.pixelHeight).toBe(Math.round(previewBounds.height));
    expect(initialPreview.acceptingInput).toBe(false);
    expect(initialPreview.activeSocketCount).toBe(1);
    const terminalLabel = await pane.root.getAttribute("aria-label");
    const terminalName = terminalLabel?.replace(/^Terminal(?: pane)?\s+/i, "");
    if (!terminalName) throw new Error("terminal did not expose an accessible name for preview");

    const listedWithPreview = await readTerminal(page, terminalId);
    expect(listedWithPreview.clients).toBe(1);

    const observerResize = JSON.stringify({ type: "resize", cols: 40, rows: 12, pixelWidth: 400, pixelHeight: 240 });
    const observerFocus = JSON.stringify({ type: "focus", focused: true });
    const observerInput = JSON.stringify({ type: "input", data: `O16-${token}-OBSERVER-TEXT` });
    const observerAck = JSON.stringify({ type: "ack", bytes: 1_000_000 });
    const observerBinary = Buffer.from(`O16-${token}-OBSERVER-BINARY`, "utf8");

    const initialUnmount = waitForPreviewUnmount(page, terminalId);
    await sidebar.closePreview();
    await initialUnmount;
    await rejectObserverControl(page, sidebar, terminalName, terminalId, faultController, observerResize, false);
    await rejectObserverControl(page, sidebar, terminalName, terminalId, faultController, observerFocus, false);
    await rejectObserverControl(page, sidebar, terminalName, terminalId, faultController, observerInput, false);
    await rejectObserverControl(page, sidebar, terminalName, terminalId, faultController, observerAck, false);
    await rejectObserverControl(page, sidebar, terminalName, terminalId, faultController, observerBinary, true);

    const floodSocketOpen = waitForPreviewEvent(page, terminalId, "socket-open");
    const floodSynced = waitForPreviewEvent(page, terminalId, "synced");
    const floodPreview = await sidebar.openPreview(terminalName);
    await floodSocketOpen;
    await floodSynced;
    await expect(floodPreview.locator(".terminal-preview-status.connected")).toBeVisible();
    const floodPreviewBeforePixels = await screenshotRegion(page, floodPreview.locator(".terminal-preview-xterm"));

    const networkBeforePause = faultController.events.length;
    const pauseRule = faultController.pause("server-to-browser", {
      terminalId,
      url: "*observer=true*",
    });
    const pauseEvent = faultController.events.slice(networkBeforePause).find((event) => (
      event.type === "paused"
      && event.terminalId === terminalId
      && event.direction === "server-to-browser"
    )) ?? await faultController.waitFor(
      (event) => event.type === "paused"
        && event.terminalId === terminalId
        && event.direction === "server-to-browser",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(pauseEvent.connectionId).toBeDefined();
    const pauseEventIndex = faultController.events.indexOf(pauseEvent);
    expect(pauseEventIndex).toBeGreaterThanOrEqual(0);

    const burstBytesValue = burstBytes(BURST_BYTES, BURST_LINE_WIDTH);
    expect(burstBytesValue.length).toBe(BURST_BYTES);
    expect(burstBytesValue.length).toBeGreaterThan(FLOW_HIGH_WATERMARK_BYTES);
    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
    const burstPromise = server.waitForTranscript(terminalId, (entry) => entry.event === "burst" && entry.id === doneId, { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`BURST ${doneId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    await burstPromise;
    const printPromise = server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === doneId, { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`PRINT ${doneId} DONE`, true);
    await printPromise;
    await expectTerminalBuffer(page, terminalId, { contains: doneMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const resumeWait = faultController.waitFor(
      (event) => event.type === "resumed"
        && event.terminalId === terminalId
        && event.direction === "server-to-browser"
        && event.connectionId === pauseEvent.connectionId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    faultController.resume("server-to-browser", { terminalId, url: "*observer=true*" });
    const resumeEvent = await resumeWait;
    pauseRule.dispose();
    const resumeEventIndex = faultController.events.indexOf(resumeEvent);
    const networkDuringPause = faultController.events.slice(
      pauseEventIndex >= 0 ? pauseEventIndex + 1 : pauseEventIndex,
      resumeEventIndex >= 0 ? resumeEventIndex : undefined,
    );
    const pausedPreviewFrames = networkDuringPause.filter((event) => (
      event.connectionId === pauseEvent.connectionId
      && event.type === "frame"
      && event.direction === "server-to-browser"
    ));
    expect(pausedPreviewFrames).toHaveLength(0);
    const paneOutputDuringPause = networkDuringPause.filter((event) => (
      event.type === "frame"
      && event.direction === "server-to-browser"
      && event.frame?.binaryKind === 1
      && event.connectionId !== pauseEvent.connectionId
    ));
    expect(paneOutputDuringPause.length).toBeGreaterThan(0);

    await pane.sendInput(`SIZE ${sizeId}`, true);
    const sizeEntry = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
    expect(sizeEntry.cols).toBe(baseline.serverViewport.cols);
    expect(sizeEntry.rows).toBe(baseline.serverViewport.rows);
    expect(sizeEntry.pixel_width).toBe(baseline.serverViewport.pixelWidth);
    expect(sizeEntry.pixel_height).toBe(baseline.serverViewport.pixelHeight);

    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(inputMarker, true);
    const echoPayload = await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
    expect(echoPayload.payload_base64).toBe(base64(inputMarker));

    const expectedWrites = [
      marker("READY", readyId),
      burstBytesValue,
      marker("PRINT", doneId, "DONE"),
      marker("SIZE", sizeId, String(sizeEntry.rows), String(sizeEntry.cols)),
      marker("ECHO_INPUT", echoId, "READY"),
      marker("ECHO_INPUT", echoId, base64(inputMarker)),
    ];
    const expectedScenarioBytes = Buffer.concat(expectedWrites);
    const expectedEnd = baselineReceived + expectedScenarioBytes.length;
    const paneSettled = await waitForPaneSettled(page, terminalId, expectedEnd, doneMarker);
    expect(paneSettled.receivedSequence).toBe(expectedEnd);
    expect(paneSettled.committedSequence).toBe(expectedEnd);
    expect(paneSettled.serverViewport).toEqual(baseline.serverViewport);
    expect(paneSettled.gridEpoch).toBe(baseline.gridEpoch);
    expect(paneSettled.activeSocketCount).toBe(1);
    expect(paneSettled.socket.activeCount).toBe(1);
    expect(paneSettled.acceptingInput).toBe(true);
    expect(paneSettled.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(paneSettled.flowAcknowledgedBytes + paneSettled.flowPendingAcknowledgementBytes).toBe(expectedEnd);
    expect(paneSettled.flowAcknowledgedBytes).toBeLessThanOrEqual(expectedEnd);
    expect(paneSettled.renderBacklogBytes).toBe(0);
    expect(paneSettled.renderBacklogFrames).toBe(0);
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

    const previewSettled = await waitForPreviewSettled(page, terminalId, expectedEnd);
    const previewEvents = await terminalEvents(page, terminalId, `${PREVIEW_PANE_PREFIX}${terminalId}`);
    const previewSyncEvents = previewEvents.filter((event) => event.type === "sync");
    expect(previewSyncEvents.length).toBeGreaterThanOrEqual(1);
    expect(previewSyncEvents.length).toBeLessThanOrEqual(2);
    if (previewSyncEvents.length === 2) expect(previewSyncEvents[1]?.data.mode).toBe("snapshot");
    await assertMonotonicSequences(previewEvents);
    expect(previewEvents.filter((event) => event.type === "error")).toHaveLength(0);
    expect(previewEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(previewEvents.filter((event) => event.type === "socket-close").length).toBe(previewSettled.socketState === "closed" ? 1 : 0);

    const transcript = await server.readTranscript(terminalId);
    const scenarioEntries = entriesAfter(transcript, transcriptFloor);
    const writes = writeEntries(scenarioEntries);
    expect(writes.map(writeBytes)).toEqual(expectedWrites);
    expect(scenarioEntries.filter((entry) => entry.event === "error")).toEqual([]);
    expect(scenarioEntries.filter((entry) => entry.event === "sigwinch")).toEqual([]);
    expect(scenarioEntries.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(scenarioEntries.filter((entry) => entry.event === "command").map((entry) => entry.operation)).toEqual([
      "READY",
      "BURST",
      "PRINT",
      "SIZE",
      "ECHO_INPUT",
      "ECHO_INPUT",
    ]);

    const listedAfterFlood = await readTerminal(page, terminalId);
    expect(listedAfterFlood.clients).toBe(1);

    const paneEvents = (await terminalEvents(page, terminalId)).filter((event) => event.id > paneEventFloor);
    await assertMonotonicSequences(paneEvents);
    expect(paneEvents.filter((event) => event.type === "error")).toHaveLength(0);
    expect(paneEvents.filter((event) => event.type === "socket-close" || event.type === "socket-stale")).toHaveLength(0);
    expect(paneEvents.filter((event) => event.type === "state" && ["recovering", "disconnected"].includes(String(event.data.state)))).toHaveLength(0);
    const paneOutputEvents = paneEvents.filter((event) => event.type === "output-received");
    let paneSequence = baselineReceived;
    for (const event of paneOutputEvents) {
      const sequence = event.data.sequence;
      const bytes = event.data.bytes;
      if (typeof sequence !== "number" || typeof bytes !== "number") throw new Error("pane output event omitted sequence or bytes");
      expect(sequence).toBe(paneSequence + bytes);
      paneSequence = sequence;
    }
    expect(paneSequence).toBe(expectedEnd);

    await recordingControl(page, "stop");
    recordingStarted = false;
    const recording = await recordingExport(page);
    expect(recording.truncated).toBe(false);
    expect(uniqueRecordedOutput(recording.events, terminalId, baselineReceived)).toEqual(expectedScenarioBytes);
    const sizeControls = recording.events
      .filter((event) => (
        event.terminal === terminalId
        && event.type === "control"
        && typeof event.message === "object"
        && event.message !== null
      ))
      .map((event) => event.message as Record<string, unknown>)
      .filter((message) => message.type === "size");
    expect(sizeControls.length).toBeGreaterThan(0);
    expect(sizeControls.every((message) => message.controller === false && message.responder === false)).toBe(true);
    for (const message of sizeControls) {
      expect(message.cols).toBe(baseline.serverViewport.cols);
      expect(message.rows).toBe(baseline.serverViewport.rows);
      expect(message.controller).toBe(false);
      expect(message.responder).toBe(false);
    }
    const forbiddenObserverInputs = [observerResize, observerFocus, observerInput, observerAck, observerBinary.toString("utf8")];
    for (const event of recording.events) {
      if (event.terminal !== terminalId || event.type !== "input" || event.data === undefined) continue;
      const decoded = Buffer.from(event.data, "base64").toString("utf8");
      for (const forbidden of forbiddenObserverInputs) expect(decoded).not.toContain(forbidden);
    }

    assertFrameSequences(faultController.events, terminalId);
    const networkEvents = faultController.events;
    const injectedControls = networkEvents.filter((event) => event.type === "injected" && event.terminalId === terminalId);
    expect(injectedControls).toHaveLength(5);
    const primaryResizeFrame = networkEvents.find((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "resize"
    ));
    if (primaryResizeFrame?.connectionId === undefined || primaryResizeFrame.generation === undefined) {
      throw new Error("primary terminal resize frame did not identify its connection");
    }
    const injectedConnectionIds = new Set(
      injectedControls
        .map((event) => event.connectionId)
        .filter((connectionId): connectionId is number => connectionId !== undefined),
    );
    const observerConnectionIds = new Set(
      networkEvents
        .filter((event) => (
          event.terminalId === terminalId
          && event.connectionId !== undefined
          && event.generation !== undefined
          && event.generation > primaryResizeFrame.generation!
        ))
        .map((event) => event.connectionId!),
    );
    const observerViewportFrames = networkEvents.filter((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.direction === "browser-to-server"
      && event.connectionId !== undefined
      && observerConnectionIds.has(event.connectionId)
      && !injectedConnectionIds.has(event.connectionId)
      && (event.frame?.jsonType === "resize" || event.frame?.jsonType === "viewport")
    ));
    expect(observerViewportFrames).toHaveLength(0);
    expect(networkEvents.filter((event) => event.type === "malformed-frame")).toHaveLength(0);
    expect(networkEvents.filter((event) => event.type === "dropped")).toHaveLength(0);

    const paneModel = new Terminal({
      cols: baseline.cols,
      rows: baseline.rows,
      scrollback: 200_000,
      ...tuiCompatibilityOptions(),
    });
    const previewModel = new Terminal({
      cols: baseline.cols,
      rows: baseline.rows,
      scrollback: 0,
      ...tuiCompatibilityOptions(),
    });
    await writeModel(paneModel, expectedScenarioBytes);
    await writeModel(previewModel, expectedScenarioBytes);
    expect(paneSettled.xterm.text).toBe(activeText(paneModel));
    expect(paneSettled.xterm.activeBuffer).toBe(paneModel.buffer.active.type);
    expect(paneSettled.xterm.cursorX).toBe(paneModel.buffer.active.cursorX);
    expect(paneSettled.xterm.cursorY).toBe(paneModel.buffer.active.cursorY);
    expect(paneSettled.xterm.viewportY).toBe(paneModel.buffer.active.viewportY);
    expect(paneSettled.xterm.selectionText).toBe("");

    const finalPanePixels = await expectKnownMarkerChanged(page, paneHost, beforePanePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-16-pane-marker-crop",
    });
    expect(finalPanePixels.after.width).toBe(beforePanePixels.width);
    expect(finalPanePixels.after.height).toBe(beforePanePixels.height);
    await expectTerminalNonBlank(page, paneHost, {
      testInfo,
      artifactName: "o-16-pane-nonblank-crop",
    });

    const finalPreviewPixels = await expectKnownMarkerChanged(page, floodPreview.locator(".terminal-preview-xterm"), floodPreviewBeforePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-16-preview-marker-crop",
    });
    expect(finalPreviewPixels.after.width).toBe(floodPreviewBeforePixels.width);
    expect(finalPreviewPixels.after.height).toBe(floodPreviewBeforePixels.height);
    await expectTerminalNonBlank(page, floodPreview.locator(".terminal-preview-xterm"), {
      minimumNonBackgroundRatio: 0.001,
      testInfo,
      artifactName: "o-16-preview-nonblank-crop",
    });

    if (previewSettled.socketState === "connected") {
      expect(previewSettled.acceptingInput).toBe(false);
      if (!previewSettled.serverViewport) throw new Error("settled observer did not report the elected server viewport");
      expect(previewSettled.serverViewport).toMatchObject({
        cols: baseline.serverViewport.cols,
        rows: baseline.serverViewport.rows,
        source: "server",
      });
      const settledPreviewBounds = await floodPreview.locator(".terminal-preview-xterm").boundingBox();
      if (!settledPreviewBounds) throw new Error("settled observer preview has no measurable terminal region");
      expect(previewSettled.serverViewport.pixelWidth).toBe(Math.round(settledPreviewBounds.width));
      expect(previewSettled.serverViewport.pixelHeight).toBe(Math.round(settledPreviewBounds.height));
      expect(previewSettled.urlViewport).toBeUndefined();
      expect(previewSettled.sentViewport).toBeUndefined();
      expect(previewSettled.receivedSequence).toBe(expectedEnd);
      expect(previewSettled.committedSequence).toBe(expectedEnd);
      expect(previewSettled.xterm.text).toBe(activeText(previewModel));
      expect(previewSettled.xterm.activeBuffer).toBe(previewModel.buffer.active.type);
      expect(previewSettled.xterm.cursorX).toBe(previewModel.buffer.active.cursorX);
      expect(previewSettled.xterm.cursorY).toBe(previewModel.buffer.active.cursorY);
      expect(previewSettled.xterm.viewportY).toBe(previewModel.buffer.active.viewportY);
      expect(previewSettled.xterm.selectionText).toBe("");
    } else {
      expect(previewSettled.socketState).toBe("closed");
      await expect(floodPreview.locator(".terminal-preview-error")).toHaveText("Preview renderer fell behind", { timeout: WAIT_TIMEOUT_MS });
      const previewText = previewSettled.xterm.text;
      expect(previewText.includes("[E2E:PRINT:")).toBe(true);
      expect(previewText.split(doneMarker).length - 1).toBeLessThanOrEqual(1);
    }

    const unmounted = waitForPreviewUnmount(page, terminalId);
    await sidebar.closePreview();
    await unmounted;

    await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
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
      ), { timeout });
    }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
    expect(exited.exitCode).toBe(0);
    expect(exited.activeSocketCount).toBe(0);
    expect(exited.socket.activeCount).toBe(0);
    expect(exited.acceptingInput).toBe(false);
    const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);

    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || (entry.kind === "console" && /^error:/i.test(entry.message))
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    const finalTranscript = await server.readTranscript(terminalId);
    expect(finalTranscript.filter((entry) => entry.event === "error")).toEqual([]);
  } finally {
    if (recordingStarted) await recordingControl(page, "stop").catch(() => undefined);
    browserErrors.dispose();
  }
});
