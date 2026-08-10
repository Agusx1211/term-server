import { Buffer } from "node:buffer";
import { Terminal } from "../fixtures/headless-terminal.js"
import type { Locator, Page } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import { expectKnownMarkerChanged, expectTerminalNonBlank, screenshotRegion } from "../assertions/terminal-pixels.js";
import { terminalInvariantViolations } from "../assertions/invariants.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 60_000;
const BROWSER_VIEWPORT = { width: 915, height: 421 } as const;
const PERF_KEY = "__TERM_SERVER_O12_PERF__";

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

type DiagnosticEvent = E2ETerminalEvent<Record<string, unknown>>;

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

type PaneIdentity = {
  readonly terminalId: string;
  readonly paneId: string;
  readonly region: Locator;
};

type QueryVector = {
  readonly name: string;
  readonly hex: string;
  readonly response: (snapshot: E2ETerminalSnapshot, brokerVersion: string) => string;
};

const encoder = new TextEncoder();

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function hexBytes(hex: string): Buffer {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error(`invalid query vector hex: ${hex}`);
  return Buffer.from(hex, "hex");
}

function textFromBase64(value: unknown): string {
  if (typeof value !== "string") throw new Error("transcript reply omitted base64 payload");
  return Buffer.from(value, "base64").toString("utf8");
}

function transcriptNumber(entry: TranscriptEntry, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function transcriptSequence(entry: TranscriptEntry): number {
  return transcriptNumber(entry, "sequence") ?? 0;
}

function transcriptString(entry: TranscriptEntry, key: string): string | undefined {
  const value = entry[key];
  return typeof value === "string" ? value : undefined;
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

async function browserVersion(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`config request failed with HTTP ${response.status}`);
    const config = await response.json() as { broker?: { version?: unknown } | null };
    const version = config.broker?.version;
    if (typeof version !== "string" || version.length === 0) throw new Error("broker version was not exposed");
    return version;
  });
}

async function installPerformanceObserver(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const supported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const longTasks: { readonly startTime: number; readonly duration: number }[] = [];
    target[key] = { supported, longTasks };
    if (!supported) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    observer.observe({ type: "longtask", buffered: true });
    target[`${key}:observer`] = observer;
  }, PERF_KEY);
}

async function readPerformanceMetrics(page: Page): Promise<{ readonly supported: boolean; readonly longTasks: readonly { readonly startTime: number; readonly duration: number }[] }> {
  return page.evaluate((key) => {
    const target = window as unknown as Record<string, unknown>;
    const metrics = target[key] as { supported?: unknown; longTasks?: unknown } | undefined;
    if (!metrics || typeof metrics.supported !== "boolean" || !Array.isArray(metrics.longTasks)) {
      throw new Error("O-12 performance metrics are unavailable");
    }
    (target[`${key}:observer`] as PerformanceObserver | undefined)?.disconnect();
    return {
      supported: metrics.supported,
      longTasks: metrics.longTasks as { readonly startTime: number; readonly duration: number }[],
    };
  }, PERF_KEY);
}

async function paneSnapshot(page: Page, terminalId: string, paneId: string): Promise<E2ETerminalSnapshot> {
  const snapshot = await terminalSnapshot(page, terminalId, paneId);
  if (!snapshot) throw new Error(`missing diagnostics snapshot for ${terminalId}/${paneId}`);
  return snapshot;
}

async function paneEventFloor(page: Page, terminalId: string, paneId: string): Promise<number> {
  const events = await terminalEvents(page, terminalId, paneId);
  return events.reduce((floor, event) => Math.max(floor, event.id), 0);
}

async function waitForPaneEvent(
  page: Page,
  terminalId: string,
  paneId: string,
  afterId: number,
  type: DiagnosticEvent["type"],
  options: { readonly responder?: boolean; readonly settled?: boolean } = {},
): Promise<DiagnosticEvent> {
  return page.evaluate(async ({ id, pane, after, expectedType, responder, settled, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => (
        event.paneId === pane
          && event.id > after
          && event.type === expectedType
          && (responder === undefined || event.data.responder === responder)
          && (!settled || event.snapshot.pendingParserWrites === 0 && event.snapshot.pendingParserBytes === 0)
      ),
      { timeout },
    );
  }, {
    id: terminalId,
    pane: paneId,
    after: afterId,
    expectedType: type,
    responder: options.responder,
    settled: options.settled,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForPaneSynchronized(page: Page, identity: PaneIdentity, afterId: number): Promise<E2ETerminalSnapshot> {
  const event = await waitForPaneEvent(page, identity.terminalId, identity.paneId, afterId, "synced");
  expect(event.snapshot.socketState).toBe("connected");
  expect(event.snapshot.acceptingInput).toBe(true);
  return paneSnapshot(page, identity.terminalId, identity.paneId);
}


async function waitForPaneOutput(page: Page, identity: PaneIdentity, sequence: number): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, pane, target, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.paneId === pane
        && snapshot.socketState === "connected"
        && snapshot.receivedSequence !== undefined
        && snapshot.receivedSequence >= target
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: identity.terminalId, pane: identity.paneId, target: sequence, timeout: WAIT_TIMEOUT_MS });
}

async function sendPaneLine(page: Page, region: Locator, line: string): Promise<void> {
  const host = region.locator(".xterm-host");
  await expect(host).toBeVisible();
  await host.click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function waitForCommand(
  server: IsolatedServer,
  terminalId: string,
  floor: number,
  operation: string,
  line: string,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(
    terminalId,
    (entry) => transcriptSequence(entry) > floor
      && entry.event === "command"
      && entry.operation === operation
      && entry.command_base64 === base64(line),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

function viewportOf(snapshot: E2ETerminalSnapshot): NonNullable<E2ETerminalSnapshot["serverViewport"]> {
  const viewport = snapshot.serverViewport ?? snapshot.viewport;
  if (!viewport || viewport.cols <= 0 || viewport.rows <= 0 || viewport.pixelWidth <= 0 || viewport.pixelHeight <= 0) {
    throw new Error("query snapshot omitted a positive terminal viewport");
  }
  return viewport;
}

function cursorReply(snapshot: E2ETerminalSnapshot, privateMode: boolean): string {
  return `\x1b[${privateMode ? "?" : ""}${snapshot.cursorY + 1};${snapshot.cursorX + 1}R`;
}

function windowReply(snapshot: E2ETerminalSnapshot, kind: "cell" | "pixel" | "text"): string {
  const viewport = viewportOf(snapshot);
  if (kind === "pixel") return `\x1b[4;${viewport.pixelHeight};${viewport.pixelWidth}t`;
  if (kind === "cell") return `\x1b[6;${Math.floor(viewport.pixelHeight / viewport.rows)};${Math.floor(viewport.pixelWidth / viewport.cols)}t`;
  return `\x1b[8;${viewport.rows};${viewport.cols}t`;
}

function standardQueryExpectations(snapshot: E2ETerminalSnapshot): readonly { readonly name: string; readonly request: string; readonly response: string }[] {
  return [
    { name: "cursor", request: "\x1b[6n", response: cursorReply(snapshot, false) },
    { name: "mode", request: "\x1b[?25$p", response: "\x1b[?25;1$y" },
    { name: "identity", request: "\x1b[c", response: "\x1b[?1;2c" },
    { name: "window_size", request: "\x1b[18t", response: windowReply(snapshot, "text") },
    { name: "window_pixels", request: "\x1b[14t", response: windowReply(snapshot, "pixel") },
    { name: "cell_pixels", request: "\x1b[16t", response: windowReply(snapshot, "cell") },
  ];
}

function customQueryVectors(): readonly QueryVector[] {
  return [
    { name: "da1_esc", hex: "1b5a", response: () => "\x1b[?1;2c" },
    { name: "da2", hex: "1b5b3e63", response: () => "\x1b[>0;276;0c" },
    { name: "status", hex: "1b5b356e", response: () => "\x1b[0n" },
    { name: "cursor_private", hex: "1b5b3f366e", response: (snapshot) => cursorReply(snapshot, true) },
    { name: "mode_wrap", hex: "1b5b3f372470", response: () => "\x1b[?7;1$y" },
    { name: "mode_sync", hex: "1b5b3f323032362470", response: () => "\x1b[?2026;2$y" },
    { name: "kitty", hex: "1b5b3f75", response: () => "\x1b[?0u" },
    { name: "xtversion", hex: "1b5b3e71", response: (_snapshot, version) => `\x1bP>|term-server(${version})\x1b\\` },
  ];
}

async function issueStandardQuery(
  page: Page,
  server: IsolatedServer,
  identity: PaneIdentity,
  queryId: string,
): Promise<void> {
  const entriesBefore = await server.readTranscript(identity.terminalId);
  const floor = entriesBefore.reduce((latest, entry) => Math.max(latest, transcriptSequence(entry)), 0);
  const before = await paneSnapshot(page, identity.terminalId, identity.paneId);
  const line = `QUERY ${queryId}`;
  await sendPaneLine(page, identity.region, line);
  const command = await waitForCommand(server, identity.terminalId, floor, "QUERY", line);
  const complete = await server.waitForTranscript(
    identity.terminalId,
    (entry) => transcriptSequence(entry) > transcriptSequence(command)
      && entry.event === "query_complete"
      && entry.id === queryId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(complete.replies).toBe(6);
  const entries = await server.readTranscript(identity.terminalId);
  const replies = entries.filter((entry) => (
    transcriptSequence(entry) > transcriptSequence(command)
      && entry.event === "query_reply"
      && entry.id === queryId
  ));
  const expected = standardQueryExpectations(before);
  expect(replies).toHaveLength(expected.length);
  expect(replies.map((entry) => entry.name)).toEqual(expected.map((item) => item.name));
  expect(replies.map((entry) => textFromBase64(entry.raw_base64))).toEqual(expected.map((item) => item.response));
  expect(replies.map((entry) => entry.request_base64)).toEqual(expected.map((item) => base64(item.request)));
  const bytes = Buffer.concat(writeEntries(entriesAfter(entries, floor)).map(writeBytes));
  if (before.receivedSequence === undefined) throw new Error("query baseline omitted received output sequence");
  await waitForPaneOutput(page, identity, before.receivedSequence + bytes.length);
}

async function issueCustomQuery(
  page: Page,
  server: IsolatedServer,
  identity: PaneIdentity,
  queryId: string,
  vector: QueryVector,
  brokerVersion: string,
): Promise<void> {
  const entriesBefore = await server.readTranscript(identity.terminalId);
  const floor = entriesBefore.reduce((latest, entry) => Math.max(latest, transcriptSequence(entry)), 0);
  const before = await paneSnapshot(page, identity.terminalId, identity.paneId);
  const response = vector.response(before, brokerVersion);
  const commandLine = `QUERY_BYTES ${queryId} ${encoder.encode(response).byteLength} ${vector.hex}`;
  await sendPaneLine(page, identity.region, commandLine);
  const command = await waitForCommand(server, identity.terminalId, floor, "QUERY_BYTES", commandLine);
  const requestBytes = await server.waitForTranscript(
    identity.terminalId,
    (entry) => transcriptSequence(entry) > transcriptSequence(command)
      && entry.event === "bytes"
      && entry.id === queryId
      && entry.payload_base64 === base64(hexBytes(vector.hex)),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(requestBytes.bytes).toBe(hexBytes(vector.hex).byteLength);
  await server.waitForTranscript(
    identity.terminalId,
    (entry) => transcriptSequence(entry) > transcriptSequence(command)
      && entry.event === "capture_input"
      && entry.id === queryId
      && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const complete = await server.waitForTranscript(
    identity.terminalId,
    (entry) => transcriptSequence(entry) > transcriptSequence(command)
      && entry.event === "capture_input"
      && entry.id === queryId
      && entry.phase === "complete",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(complete.bytes).toBe(encoder.encode(response).byteLength);
  expect(complete.payload_base64).toBe(base64(response));
  const entries = await server.readTranscript(identity.terminalId);
  expect(entries.filter((entry) => transcriptSequence(entry) > transcriptSequence(command) && entry.event === "capture_input" && entry.id === queryId && entry.phase === "complete")).toHaveLength(1);
  const bytes = Buffer.concat(writeEntries(entriesAfter(entries, floor)).map(writeBytes));
  if (before.receivedSequence === undefined) throw new Error("query baseline omitted received output sequence");
  await waitForPaneOutput(page, identity, before.receivedSequence + bytes.length);
}

async function issueKittyQuery(
  page: Page,
  server: IsolatedServer,
  identity: PaneIdentity,
  queryId: string,
): Promise<void> {
  const entriesBefore = await server.readTranscript(identity.terminalId);
  const floor = entriesBefore.reduce((latest, entry) => Math.max(latest, transcriptSequence(entry)), 0);
  const before = await paneSnapshot(page, identity.terminalId, identity.paneId);
  const commandLine = `KITTY ${queryId} QUERY`;
  await sendPaneLine(page, identity.region, commandLine);
  const command = await waitForCommand(server, identity.terminalId, floor, "KITTY", commandLine);
  const kitty = await server.waitForTranscript(
    identity.terminalId,
    (entry) => transcriptSequence(entry) > transcriptSequence(command)
      && entry.event === "kitty"
      && entry.id === queryId
      && entry.action === "query",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(kitty.sequence_base64).toBe(base64("\x1b[?u"));
  const reply = await server.waitForTranscript(
    identity.terminalId,
    (entry) => transcriptSequence(entry) > transcriptSequence(command)
      && entry.event === "kitty_reply"
      && entry.id === queryId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const entries = await server.readTranscript(identity.terminalId);
  const bytes = Buffer.concat(writeEntries(entriesAfter(entries, floor)).map(writeBytes));
  if (before.receivedSequence === undefined) throw new Error("Kitty query baseline omitted received output sequence");
  await waitForPaneOutput(page, identity, before.receivedSequence + bytes.length);
}

async function activateResponder(
  page: Page,
  server: IsolatedServer,
  identities: readonly [PaneIdentity, PaneIdentity],
  active: PaneIdentity,
  token: string,
): Promise<void> {
  const floors = await Promise.all(identities.map((identity) => paneEventFloor(page, identity.terminalId, identity.paneId)));
  const desired = new Map(identities.map((identity) => [identity.paneId, identity.paneId === active.paneId]));
  const responderEvents = identities.map((identity, index) => (
    waitForPaneEvent(page, identity.terminalId, identity.paneId, floors[index]!, "size", { responder: desired.get(identity.paneId) })
  ));
  const entriesBefore = await server.readTranscript(active.terminalId);
  const floor = entriesBefore.reduce((latest, entry) => Math.max(latest, transcriptSequence(entry)), 0);
  const before = await paneSnapshot(page, active.terminalId, active.paneId);
  const line = `SIZE ${token}`;
  await sendPaneLine(page, active.region, line);
  const sizeEntry = await server.waitForTranscript(
    active.terminalId,
    (entry) => transcriptSequence(entry) > floor && entry.event === "size" && entry.id === token,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(sizeEntry.rows).toBeGreaterThan(0);
  await Promise.all(responderEvents);
  const latestSizes = await Promise.all(identities.map(async (identity) => {
    const events = await terminalEvents(page, identity.terminalId, identity.paneId);
    return [...events].reverse().find((event) => event.type === "size");
  }));
  expect(latestSizes.filter((event) => event?.data.responder === true)).toHaveLength(1);
  const entries = await server.readTranscript(active.terminalId);
  const bytes = Buffer.concat(writeEntries(entriesAfter(entries, floor)).map(writeBytes));
  if (before.receivedSequence === undefined) throw new Error("responder baseline omitted received output sequence");
  await Promise.all(identities.map((identity) => waitForPaneOutput(page, identity, before.receivedSequence! + bytes.length)));
}

function outputRecords(recording: RecordingExport, terminalId: string): OutputEvent[] {
  return recording.events.filter((event): event is OutputEvent => (
    event.terminal === terminalId
      && event.type === "output"
      && typeof event.sequence === "number"
      && typeof event.data === "string"
  ));
}

function payloadBytesForTerminalFrame(frameBytes: number): number {
  const websocketHeaderBytes = frameBytes < 126 ? 2 : frameBytes < 65_536 ? 4 : 10;
  return frameBytes - websocketHeaderBytes - 9;
}

function assertNetworkOutputFrames(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  baselineSequence: number,
  expectedBytes: number,
): void {
  const byConnection = new Map<number, NetworkFaultEvent[]>();
  for (const event of events) {
    if (event.type !== "frame" || event.terminalId !== terminalId || event.direction !== "server-to-browser") continue;
    if (event.frame?.binaryKind !== 1 || event.frame.sequence === undefined || event.frame.bytes === undefined || event.frame.fin !== true) continue;
    if (event.connectionId === undefined) throw new Error("output frame omitted proxy connection identity");
    const current = byConnection.get(event.connectionId) ?? [];
    current.push(event);
    byConnection.set(event.connectionId, current);
  }
  expect(byConnection.size).toBe(2);
  for (const frames of byConnection.values()) {
    let sequence = baselineSequence;
    let bytes = 0;
    for (const event of frames) {
      expect(event.frame?.sequence).toBe(sequence);
      const payload = payloadBytesForTerminalFrame(event.frame?.bytes ?? 0);
      expect(payload).toBeGreaterThan(0);
      bytes += payload;
      sequence += payload;
    }
    expect(bytes).toBe(expectedBytes);
    expect(sequence).toBe(baselineSequence + expectedBytes);
  }
}

async function paneIdentities(page: Page, terminalId: string): Promise<PaneIdentity[]> {
  const id = terminalId.replace(/["\\]/g, "\\$&");
  const regions = page.locator(`section[role="region"][data-terminal-id="${id}"]`);
  const values = await regions.evaluateAll((elements) => elements.map((element) => ({
    terminalId: element.getAttribute("data-terminal-id"),
    paneId: element.getAttribute("data-pane-id"),
  })));
  const identities: PaneIdentity[] = [];
  for (const [index, value] of values.entries()) {
    if (value.terminalId !== terminalId || !value.paneId) throw new Error("split terminal did not expose stable pane identities");
    identities.push({ terminalId, paneId: value.paneId, region: regions.nth(index) });
  }
  if (identities.length !== 2) throw new Error(`expected two split panes, found ${identities.length}`);
  return identities;
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

test("@nightly @O-12 @queries @responder O-12 Terminal queries", async ({ page, baseURL, server, faultController }, testInfo) => {
  await page.setViewportSize(BROWSER_VIEWPORT);
  const browserErrors = installBrowserErrorCollectors(page);
  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    await installPerformanceObserver(page);

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
    const firstRegion = page.locator(`section[role="region"][data-terminal-id="${terminalId.replace(/["\\]/g, "\\$&")}"]`).first();
    await expect(firstRegion).toBeVisible();
    const label = await firstRegion.getAttribute("aria-label");
    if (!label) throw new Error("created terminal omitted its accessible name");
    const terminalName = label.replace(/^Terminal(?: pane)?\s+/, "");
    const firstPaneId = mounted.paneId;
    const firstIdentity: PaneIdentity = { terminalId, paneId: firstPaneId, region: firstRegion };
    await waitForPaneSynchronized(page, firstIdentity, mounted.id);

    const token = `O12-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now().toString(36)}`;
    const beforeSplit = await paneSnapshot(page, terminalId, firstPaneId);
    expect(beforeSplit.cols).toBeGreaterThan(0);
    expect(beforeSplit.rows).toBeGreaterThan(0);
    expect(beforeSplit.serverViewport).toMatchObject({
      cols: beforeSplit.cols,
      rows: beforeSplit.rows,
      pixelWidth: beforeSplit.pixelWidth,
      pixelHeight: beforeSplit.pixelHeight,
    });

    const secondMountPromise = page.evaluate(async ({ id, pane, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent(id, (event) => event.type === "mount" && event.paneId !== pane, { timeout });
    }, { id: terminalId, pane: firstPaneId, timeout: WAIT_TIMEOUT_MS });
    await workbench.splitTerminal({ id: terminalId, name: terminalName });
    const secondMounted = await secondMountPromise;
    await expect(page.locator(`section[role="region"][data-terminal-id="${terminalId.replace(/["\\]/g, "\\$&")}"]`)).toHaveCount(2);
    const identities = await paneIdentities(page, terminalId);
    const secondIdentity = identities.find((identity) => identity.paneId === secondMounted.paneId);
    if (!secondIdentity) throw new Error("second split pane was not registered in diagnostics");
    const first = identities.find((identity) => identity.paneId === firstPaneId);
    if (!first) throw new Error("first split pane disappeared");
    const second = secondIdentity;
    const secondSyncFloor = secondMounted.id;
    await waitForPaneSynchronized(page, secondIdentity, secondSyncFloor);

    const paneSnapshots = await Promise.all(identities.map((identity) => paneSnapshot(page, terminalId, identity.paneId)));
    expect(new Set(paneSnapshots.map((snapshot) => snapshot.paneId)).size).toBe(2);
    for (const snapshot of paneSnapshots) {
      expect(snapshot.activeSocketCount).toBe(1);
      expect(snapshot.socket.activeCount).toBe(1);
      expect(snapshot.socketGeneration).toBeGreaterThanOrEqual(1);
      expect(snapshot.socketState).toBe("connected");
      expect(snapshot.acceptingInput).toBe(true);
      expect(snapshot.serverViewport).toBeDefined();
    }

    const brokerVersion = await browserVersion(page);
    const baselineReceived = paneSnapshots[0]?.receivedSequence;
    if (baselineReceived === undefined) throw new Error("terminal baseline omitted received output sequence");
    const transcriptBefore = await server.readTranscript(terminalId);
    const transcriptFloor = transcriptBefore.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
    const networkFloor = faultController.events.length;
    const beforePixels = await Promise.all(identities.map((identity) => screenshotRegion(page, identity.region.locator(".xterm-screen"))));

    await recordingControl(page, "start");
    await activateResponder(page, server, identities as [PaneIdentity, PaneIdentity], first, `${token}-A-SIZE`);
    await issueStandardQuery(page, server, first, `${token}-A-QUERY`);
    for (const vector of customQueryVectors()) {
      await issueCustomQuery(page, server, first, `${token}-A-${vector.name}`, vector, brokerVersion);
    }
    await issueKittyQuery(page, server, first, `${token}-A-KITTY`);

    await activateResponder(page, server, identities as [PaneIdentity, PaneIdentity], second, `${token}-B-SIZE`);
    await issueStandardQuery(page, server, second, `${token}-B-QUERY`);
    for (const vector of customQueryVectors()) {
      await issueCustomQuery(page, server, second, `${token}-B-${vector.name}`, vector, brokerVersion);
    }
    await issueKittyQuery(page, server, second, `${token}-B-KITTY`);

    // Leave the second pane visible but unfocused while the elected first pane
    // drives one more complete query set. Server-owned replies must not be
    // forwarded by either xterm instance, including the observer pane.
    await activateResponder(page, server, identities as [PaneIdentity, PaneIdentity], first, `${token}-OBSERVER-SIZE`);
    await issueStandardQuery(page, server, first, `${token}-OBSERVER-QUERY`);
    for (const vector of customQueryVectors()) {
      await issueCustomQuery(page, server, first, `${token}-OBSERVER-${vector.name}`, vector, brokerVersion);
    }
    await issueKittyQuery(page, server, first, `${token}-OBSERVER-KITTY`);

    const printId = `${token}-P`;
    const echoId = `${token}-E`;
    const inputMarker = `${token}-I`;
    const finalSizeId = `${token}-S`;
    await sendPaneLine(page, first.region, `PRINT ${printId} M`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === printId, { timeoutMs: WAIT_TIMEOUT_MS });
    await sendPaneLine(page, first.region, `ECHO_INPUT ${echoId}`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await sendPaneLine(page, first.region, inputMarker);
    const echoPayload = await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
    expect(echoPayload.payload_base64).toBe(base64(inputMarker));
    await sendPaneLine(page, first.region, `SIZE ${finalSizeId}`);
    const finalSize = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === finalSizeId, { timeoutMs: WAIT_TIMEOUT_MS });
    expect(finalSize.rows).toBeGreaterThan(0);
    expect(finalSize.cols).toBeGreaterThan(0);
    const finalSizeWrite = `[E2E:SIZE:${finalSizeId}:${finalSize.rows}:${finalSize.cols}]\n`;
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "write" && entry.text === finalSizeWrite,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const transcript = await server.readTranscript(terminalId);
    const scenarioEntries = entriesAfter(transcript, transcriptFloor);
    const fixtureBytes = Buffer.concat(writeEntries(scenarioEntries).map(writeBytes));
    await Promise.all(identities.map((identity) => {
      if (baselineReceived === undefined) throw new Error("terminal baseline omitted received output sequence");
      return waitForPaneOutput(page, identity, baselineReceived + fixtureBytes.length);
    }));
    expect(scenarioEntries.filter((entry) => entry.event === "error")).toEqual([]);
    expect(scenarioEntries.filter((entry) => entry.event === "query_incomplete")).toEqual([]);
    expect(scenarioEntries.filter((entry) => entry.event === "query_complete")).toHaveLength(6);
    expect(scenarioEntries.filter((entry) => entry.event === "kitty_reply")).toHaveLength(3);
    expect(scenarioEntries.filter((entry) => entry.event === "echo_input" && entry.phase === "payload" && entry.id === echoId)).toHaveLength(1);
    expect(scenarioEntries.filter((entry) => entry.event === "print" && entry.id === printId)).toHaveLength(1);
    expect(scenarioEntries.filter((entry) => entry.event === "size" && entry.id === finalSizeId)).toHaveLength(1);

    const recording = await (async () => {
      await recordingControl(page, "stop");
      return recordingExport(page);
    })();
    expect(recording.truncated).toBe(false);
    const output = outputRecords(recording, terminalId);
    expect(output.length).toBeGreaterThan(0);
    let recordedSequence = baselineReceived;
    const recordedChunks: Buffer[] = [];
    for (const event of output) {
      expect(event.sequence).toBe(recordedSequence);
      const bytes = Buffer.from(event.data, "base64");
      recordedChunks.push(bytes);
      recordedSequence += bytes.length;
    }
    expect(recordedSequence).toBe(baselineReceived + fixtureBytes.length);
    expect(Buffer.concat(recordedChunks)).toEqual(fixtureBytes);

    const finalSnapshots = await Promise.all(identities.map((identity) => paneSnapshot(page, terminalId, identity.paneId)));
    const expectedRows = Number(finalSize.rows);
    const expectedCols = Number(finalSize.cols);
    for (const snapshot of finalSnapshots) {
      expect(snapshot.cols).toBe(expectedCols);
      expect(snapshot.rows).toBe(expectedRows);
      expect(snapshot.pixelWidth).toBe(Number(finalSize.pixel_width));
      expect(snapshot.pixelHeight).toBe(Number(finalSize.pixel_height));
      expect(snapshot.serverViewport).toMatchObject({
        cols: expectedCols,
        rows: expectedRows,
        pixelWidth: Number(finalSize.pixel_width),
        pixelHeight: Number(finalSize.pixel_height),
      });
      expect(snapshot.activeSocketCount).toBe(1);
      expect(snapshot.socket.activeCount).toBe(1);
      expect(snapshot.socketState).toBe("connected");
      expect(snapshot.acceptingInput).toBe(true);
      expect(snapshot.syncMode).toBeUndefined();
      expect(snapshot.pendingParserWrites).toBe(0);
      expect(snapshot.pendingParserBytes).toBe(0);
      expect(snapshot.renderBacklogBytes).toBe(0);
      expect(snapshot.renderBacklogFrames).toBe(0);
      expect(snapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    }

    for (const identity of identities) {
      const snapshot = await paneSnapshot(page, terminalId, identity.paneId);
      const model = new Terminal({
        cols: snapshot.cols,
        rows: snapshot.rows,
        scrollback: 200_000,
        ...tuiCompatibilityOptions(),
      });
      for (const chunk of recordedChunks) await writeModel(model, chunk);
      expect(snapshot.xterm.text).toBe(activeText(model));
      expect(snapshot.xterm.activeBuffer).toBe(model.buffer.active.type);
      expect(snapshot.xterm.cursorX).toBe(model.buffer.active.cursorX);
      expect(snapshot.xterm.cursorY).toBe(model.buffer.active.cursorY);
      expect(snapshot.xterm.viewportY).toBe(model.buffer.active.viewportY);
      const compactText = snapshot.xterm.text.replace(/\r?\n/g, "");
      expect(countOccurrences(compactText, `[E2E:PRINT:${printId}:M]`)).toBe(1);
      expect(countOccurrences(compactText, `[E2E:ECHO_INPUT:${echoId}:${base64(inputMarker)}]`)).toBe(1);
      model.dispose();
    }

    const networkEvents = faultController.events.slice(networkFloor);
    assertNetworkOutputFrames(networkEvents, terminalId, baselineReceived, fixtureBytes.length);
    expect(networkEvents.filter((event) => ["malformed-frame", "injected", "paused", "throttled", "dropped"].includes(event.type))).toEqual([]);

    const responderStates = await Promise.all(identities.map(async (identity) => {
      const events = await terminalEvents(page, terminalId, identity.paneId);
      await assertMonotonicSequences(events);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "socket-close" || event.type === "socket-stale")).toEqual([]);
      const latestSizeEvent = [...events].reverse().find((event) => event.type === "size");
      return latestSizeEvent?.data.responder;
    }));
    expect(responderStates.filter((value) => value === true)).toHaveLength(1);
    expect(responderStates.filter((value) => value === false)).toHaveLength(1);

    for (const identity of identities) {
      const snapshot = await paneSnapshot(page, terminalId, identity.paneId);
      const events = await terminalEvents(page, terminalId, identity.paneId);
      expect(terminalInvariantViolations(snapshot, events)).toEqual([]);
    }

    const afterPixels = await Promise.all(identities.map((identity) => screenshotRegion(page, identity.region.locator(".xterm-screen"))));
    for (const [index, identity] of identities.entries()) {
      await expectKnownMarkerChanged(page, identity.region.locator(".xterm-screen"), beforePixels[index]!, {
        minimumChangedRatio: 0.002,
        testInfo,
        artifactName: `o-12-${index}-marker-crop`,
      });
      await expectTerminalNonBlank(page, identity.region.locator(".xterm-screen"), {
        minimumNonBackgroundRatio: 0.002,
        testInfo,
        artifactName: `o-12-${index}-terminal-crop`,
      });
      expect(afterPixels[index]!.width).toBe(beforePixels[index]!.width);
      expect(afterPixels[index]!.height).toBe(beforePixels[index]!.height);
    }

    const performance = await readPerformanceMetrics(page);
    expect(performance.longTasks.every((entry) => Number.isFinite(entry.startTime) && Number.isFinite(entry.duration) && entry.duration >= 0)).toBe(true);
    expect(performance.longTasks.length).toBeLessThan(10_000);

    const exitFloors = await Promise.all(identities.map((identity) => paneEventFloor(page, terminalId, identity.paneId)));
    const exitEvents = identities.map((identity, index) => waitForPaneEvent(page, terminalId, identity.paneId, exitFloors[index]!, "exit"));
    await sendPaneLine(page, first.region, "EXIT 0");
    await server.waitForTranscript(terminalId, (entry) => entry.event === "exit_requested" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    await Promise.all(identities.map(async (identity, index) => {
      await exitEvents[index]!;
      const snapshot = await paneSnapshot(page, terminalId, identity.paneId);
      expect(snapshot.exitCode).toBe(0);
      expect(snapshot.socketState).toBe("exited");
      expect(snapshot.activeSocketCount).toBe(0);
      expect(snapshot.socket.activeCount).toBe(0);
      expect(snapshot.pendingParserWrites).toBe(0);
      expect(snapshot.pendingParserBytes).toBe(0);
      expect(snapshot.renderBacklogBytes).toBe(0);
      expect(snapshot.renderBacklogFrames).toBe(0);
      expect(snapshot.acceptingInput).toBe(false);
    }));

    const browserErrorsAfter = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
        || entry.kind === "requestfailed"
        || (entry.kind === "console" && /^error:/i.test(entry.message))
    ));
    expect(browserErrorsAfter).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  } finally {
    browserErrors.dispose();
  }
});
