import { Buffer } from "node:buffer";
import { expect, test } from "../fixtures/test.js";
import type { BrowserContext, Page } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { IsolatedServer, TranscriptEntry } from "../fixtures/test.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const OSC10_QUERY_HEX = "1b5d31303b3f07";
const OSC10_QUERY_BASE64 = Buffer.from(OSC10_QUERY_HEX, "hex").toString("base64");
const OSC10_REPLY_BYTES = 25;
const SIZE_EVENT_TIMEOUT = 15_000;

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

interface SizeExpectation {
  readonly responder?: boolean;
  readonly controller?: boolean;
  readonly focused?: boolean;
}

type DiagnosticEvent = E2ETerminalEvent<Record<string, unknown>>;

async function waitForSizeAfter(
  page: Page,
  terminalId: string,
  afterId: number,
  expected: SizeExpectation,
): Promise<DiagnosticEvent> {
  return page.evaluate(async ({ terminalId: id, afterId: cursor, expected: wanted, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => {
        if (event.id <= cursor || event.type !== "size") return false;
        return Object.entries(wanted).every(([key, value]) => event.data[key] === value);
      },
      { timeout },
    );
  }, { terminalId, afterId, expected, timeout: SIZE_EVENT_TIMEOUT });
}

async function sendFixtureLine(pane: TerminalPanePage, line: string): Promise<void> {
  await pane.sendInput(line, true);
}

async function waitForTranscriptEvent(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: TranscriptEntry) => boolean,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(terminalId, (entry) => predicate(entry));
}

async function waitForEcho(
  server: IsolatedServer,
  terminalId: string,
  marker: string,
  payload: string,
): Promise<TranscriptEntry> {
  return waitForTranscriptEvent(
    server,
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === marker
      && entry.phase === "payload"
      && entry.text === payload,
  );
}

function capturedOsc10Bytes(entry: TranscriptEntry): Uint8Array {
  expect(entry.event).toBe("capture_input");
  expect(entry.phase).toBe("complete");
  expect(entry.bytes).toBe(OSC10_REPLY_BYTES);
  expect(typeof entry.payload_base64).toBe("string");
  const bytes = Buffer.from(String(entry.payload_base64), "base64");
  expect(bytes.byteLength).toBe(OSC10_REPLY_BYTES);
  const reply = bytes.toString("ascii");
  expect(reply.startsWith("\x1b]10;rgb:")).toBe(true);
  expect(reply.endsWith("\x1b\\")).toBe(true);
  const channels = reply.slice("\x1b]10;rgb:".length, -2).split("/");
  expect(channels).toHaveLength(3);
  for (const channel of channels) expect(channel).toMatch(/^[0-9a-fA-F]{4}$/);
  return bytes;
}

async function armAndEmitOsc10(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  captureId: string,
): Promise<TranscriptEntry> {
  const command = `QUERY_BYTES ${captureId} ${OSC10_REPLY_BYTES} ${OSC10_QUERY_HEX}`;
  await sendFixtureLine(pane, command);
  await waitForTranscriptEvent(
    server,
    terminalId,
    (entry) => entry.event === "capture_input"
      && entry.id === captureId
      && entry.phase === "armed"
      && entry.bytes === OSC10_REPLY_BYTES,
  );
  const bytesEvent = await waitForTranscriptEvent(
    server,
    terminalId,
    (entry) => entry.event === "bytes"
      && entry.id === captureId
      && entry.bytes === Buffer.from(OSC10_QUERY_HEX, "hex").byteLength
      && entry.payload_base64 === OSC10_QUERY_BASE64,
  );
  expect(bytesEvent.payload_base64).toBe(OSC10_QUERY_BASE64);
  const complete = await waitForTranscriptEvent(
    server,
    terminalId,
    (entry) => entry.event === "capture_input"
      && entry.id === captureId
      && entry.phase === "complete",
  );
  await assertCommandOnce(server, terminalId, "QUERY_BYTES", command);
  return complete;
}

async function assertCommandOnce(
  server: IsolatedServer,
  terminalId: string,
  operation: string,
  line: string,
): Promise<void> {
  const entries = await server.readTranscript(terminalId);
  const matches = entries.filter((entry) => (
    entry.event === "command"
      && entry.operation === operation
      && entry.command_base64 === Buffer.from(line, "utf8").toString("base64")
  ));
  expect(matches, `fixture command ${line}`).toHaveLength(1);
}

async function assertQueryCompleteOnce(
  server: IsolatedServer,
  terminalId: string,
  queryId: string,
): Promise<void> {
  const entries = await server.readTranscript(terminalId);
  const replies = entries.filter((entry) => entry.event === "query_reply" && entry.id === queryId);
  expect(replies).toHaveLength(6);
  expect(new Set(replies.map((entry) => entry.name))).toEqual(new Set([
    "cursor",
    "mode",
    "identity",
    "window_size",
    "window_pixels",
    "cell_pixels",
  ]));
  expect(replies.every((entry) => typeof entry.raw_base64 === "string" && Number(entry.bytes) > 0)).toBe(true);
  expect(entries.filter((entry) => entry.event === "query_complete" && entry.id === queryId)).toHaveLength(1);
}

function markerOccurrences(text: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(marker, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + marker.length;
  }
}

async function waitForTerminalQuiescence(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
        && snapshot.syncMode === undefined
        && snapshot.syncTarget === undefined
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
        && snapshot.lifecycle.acceptingInput
    ), { timeout });
  }, { id: terminalId, timeout: SIZE_EVENT_TIMEOUT, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

test("@nightly @input @responder @multiclient I-10 Responder election with multiple clients", async ({
  page,
  baseURL,
  server,
}, testInfo) => {
  const browser = page.context().browser();
  if (!browser) throw new Error("I-10 requires a browser capable of creating a second context");

  const browserErrorsA: string[] = [];
  const browserErrorsB: string[] = [];
  page.on("pageerror", (error) => browserErrorsA.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrorsA.push(message.text());
  });

  await page.setViewportSize({ width: 1260, height: 760 });
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbenchA = new WorkbenchPage(page);
  await workbenchA.expectVisible();
  await workbenchA.createTerminal();

  const terminalRegionA = page.locator("section[role=\"region\"][data-terminal-id]").first();
  await expect(terminalRegionA).toBeVisible();
  const terminalId = await terminalRegionA.getAttribute("data-terminal-id");
  const terminalLabel = await terminalRegionA.getAttribute("aria-label");
  if (!terminalId || !terminalLabel) throw new Error("new terminal did not expose a stable identity");
  const terminalName = terminalLabel.replace(/^Terminal\s+/, "");
  const paneA = new TerminalPanePage(page, { terminalId, name: terminalName });
  await paneA.expectVisible();
  await paneA.waitForConnected();
  await paneA.waitForSynchronized();

  const readyId = "I10_READY";
  await sendFixtureLine(paneA, `READY ${readyId}`);
  await waitForTranscriptEvent(server, terminalId, (entry) => entry.event === "ready" && entry.id === readyId);

  let contextB: BrowserContext | undefined;
  try {
    contextB = await browser.newContext({
      baseURL,
      viewport: { width: 940, height: 620 },
    });
    const pageB = await contextB.newPage();
    pageB.on("pageerror", (error) => browserErrorsB.push(error.message));
    pageB.on("console", (message) => {
      if (message.type() === "error") browserErrorsB.push(message.text());
    });
    await pageB.goto(baseURL);
    await new LoginPage(pageB).login();
    const workbenchB = new WorkbenchPage(pageB);
    await workbenchB.expectVisible();
    const paneB = await workbenchB.openTerminal(terminalName);
    await paneB.expectVisible();
    await paneB.waitForConnected();
    await paneB.waitForSynchronized();

    const eventsAInitial = await paneA.events() as readonly DiagnosticEvent[];
    const eventsBInitial = await paneB.events() as readonly DiagnosticEvent[];
    const initialSizeA = [...eventsAInitial].reverse().find((event) => event.type === "size");
    const initialSizeB = [...eventsBInitial].reverse().find((event) => event.type === "size");
    expect(initialSizeA?.data.responder).toBe(true);
    expect(initialSizeB?.data.responder).toBe(false);
    expect(initialSizeA?.data.controller).toBe(false);
    expect(initialSizeB?.data.controller).toBe(false);
    expect(initialSizeA?.data.focused).toBe(false);
    expect(initialSizeB?.data.focused).toBe(false);

    const beforeA = await screenshotRegion(page, paneA.xtermHost);
    const beforeB = await screenshotRegion(pageB, paneB.xtermHost);

    const queryA = "I10_QUERY_A";
    await sendFixtureLine(paneA, `QUERY ${queryA}`);
    await waitForTranscriptEvent(server, terminalId, (entry) => entry.event === "query_complete" && entry.id === queryA);
    await assertQueryCompleteOnce(server, terminalId, queryA);
    const captureA = "I10_OSC10_A";
    const captureEntryA = await armAndEmitOsc10(paneA, server, terminalId, captureA);
    capturedOsc10Bytes(captureEntryA);

    const eventsABefore = await paneA.events() as readonly DiagnosticEvent[];
    const eventsBBefore = await paneB.events() as readonly DiagnosticEvent[];
    const beforeBElectionA = eventsABefore.reduce((maximum, event) => Math.max(maximum, event.id), 0);
    const beforeBElectionB = eventsBBefore.reduce((maximum, event) => Math.max(maximum, event.id), 0);
    const aResponderLost = waitForSizeAfter(page, terminalId, beforeBElectionA, { responder: false });
    const bResponderWon = waitForSizeAfter(pageB, terminalId, beforeBElectionB, { responder: true });
    const bMarker = "I10_B";
    const bPayload = "I10_B_PAYLOAD";
    await sendFixtureLine(paneB, `ECHO_INPUT ${bMarker} ${bPayload}`);
    const [aLostEvent, bWonEvent] = await Promise.all([aResponderLost, bResponderWon]);
    expect(aLostEvent.data.responder).toBe(false);
    expect(bWonEvent.data.responder).toBe(true);
    expect(bWonEvent.data.controller).toBe(false);
    expect(bWonEvent.data.focused).toBe(false);
    await waitForEcho(server, terminalId, bMarker, bPayload);

    const queryB = "I10_QUERY_B";
    await sendFixtureLine(paneB, `QUERY ${queryB}`);
    await waitForTranscriptEvent(server, terminalId, (entry) => entry.event === "query_complete" && entry.id === queryB);
    await assertQueryCompleteOnce(server, terminalId, queryB);
    const captureB = "I10_OSC10_B";
    const captureEntryB = await armAndEmitOsc10(paneB, server, terminalId, captureB);
    capturedOsc10Bytes(captureEntryB);

    const eventsAAfter = await paneA.events() as readonly DiagnosticEvent[];
    const eventsBAfter = await paneB.events() as readonly DiagnosticEvent[];
    const beforeAElectionA = eventsAAfter.reduce((maximum, event) => Math.max(maximum, event.id), 0);
    const beforeAElectionB = eventsBAfter.reduce((maximum, event) => Math.max(maximum, event.id), 0);
    const aResponderWon = waitForSizeAfter(page, terminalId, beforeAElectionA, { responder: true });
    const bResponderLost = waitForSizeAfter(pageB, terminalId, beforeAElectionB, { responder: false });
    const aMarker = "I10_A";
    const aPayload = "I10_A_PAYLOAD";
    await sendFixtureLine(paneA, `ECHO_INPUT ${aMarker} ${aPayload}`);
    const [aWonEvent, bLostEvent] = await Promise.all([aResponderWon, bResponderLost]);
    expect(aWonEvent.data.responder).toBe(true);
    expect(bLostEvent.data.responder).toBe(false);
    expect(aWonEvent.data.controller).toBe(false);
    expect(aWonEvent.data.focused).toBe(false);
    await waitForEcho(server, terminalId, aMarker, aPayload);

    const captureA2 = "I10_OSC10_A_FOLLOWUP";
    const captureEntryA2 = await armAndEmitOsc10(paneA, server, terminalId, captureA2);
    capturedOsc10Bytes(captureEntryA2);

    const sizeId = "I10_SIZE";
    await sendFixtureLine(paneA, `SIZE ${sizeId}`);
    const sizeEntry = await waitForTranscriptEvent(server, terminalId, (entry) => entry.event === "size" && entry.id === sizeId);
    expect(Number(sizeEntry.rows)).toBeGreaterThan(0);
    expect(Number(sizeEntry.cols)).toBeGreaterThan(0);
    await expectTerminalBuffer(page, terminalId, { contains: `[E2E:ECHO_INPUT:${bMarker}:${bPayload}]`, occurrences: 1 });
    await expectTerminalBuffer(page, terminalId, { contains: `[E2E:ECHO_INPUT:${aMarker}:${aPayload}]`, occurrences: 1 });
    await expectTerminalBuffer(pageB, terminalId, { contains: `[E2E:ECHO_INPUT:${bMarker}:${bPayload}]`, occurrences: 1 });
    await expectTerminalBuffer(pageB, terminalId, { contains: `[E2E:ECHO_INPUT:${aMarker}:${aPayload}]`, occurrences: 1 });

    const [finalA, finalB] = await Promise.all([
      waitForTerminalQuiescence(page, terminalId),
      waitForTerminalQuiescence(pageB, terminalId),
    ]);
    expect(finalA.serverViewport?.cols).toBe(Number(sizeEntry.cols));
    expect(finalA.serverViewport?.rows).toBe(Number(sizeEntry.rows));
    expect(finalB.serverViewport?.cols).toBe(Number(sizeEntry.cols));
    expect(finalB.serverViewport?.rows).toBe(Number(sizeEntry.rows));
    expect(finalA.gridEpoch).toBe(finalB.gridEpoch);
    expect(finalA.activeSocketCount).toBe(1);
    expect(finalB.activeSocketCount).toBe(1);
    expect(finalA.socketGeneration).toBeGreaterThanOrEqual(1);
    expect(finalB.socketGeneration).toBeGreaterThanOrEqual(1);

    const afterA = await screenshotRegion(page, paneA.xtermHost);
    const afterB = await screenshotRegion(pageB, paneB.xtermHost);
    await expectTerminalPixelsChanged(beforeA, afterA, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "i10-a-after.png",
    });
    await expectTerminalPixelsChanged(beforeB, afterB, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "i10-b-after.png",
    });
    await expectTerminalNonBlank(page, paneA.xtermHost, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "i10-a-final.png",
    });
    await expectTerminalNonBlank(pageB, paneB.xtermHost, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "i10-b-final.png",
    });

    const snapshotA = await paneA.snapshot();
    const snapshotB = await paneB.snapshot();
    if (!snapshotA || !snapshotB) throw new Error("missing final I-10 diagnostics snapshots");
    const compactTextA = snapshotA.xterm.text.replaceAll("\n", "");
    const compactTextB = snapshotB.xterm.text.replaceAll("\n", "");
    expect(compactTextA).toContain(`[E2E:ECHO_INPUT:${aMarker}:${aPayload}]`);
    expect(compactTextB).toContain(`[E2E:ECHO_INPUT:${bMarker}:${bPayload}]`);
    expect(markerOccurrences(compactTextA, `[E2E:ECHO_INPUT:${aMarker}:${aPayload}]`)).toBe(1);
    expect(markerOccurrences(compactTextB, `[E2E:ECHO_INPUT:${bMarker}:${bPayload}]`)).toBe(1);

    const [eventsA, eventsB] = await Promise.all([
      terminalEvents(page, terminalId),
      terminalEvents(pageB, terminalId),
    ]);
    await assertMonotonicSequences(eventsA);
    await assertMonotonicSequences(eventsB);
    expect(eventsA.filter((event) => event.type === "error")).toEqual([]);
    expect(eventsB.filter((event) => event.type === "error")).toEqual([]);
    await expectConnectedTerminalInvariants(page, terminalId);
    await expectConnectedTerminalInvariants(pageB, terminalId);

    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
    for (const captureId of [captureA, captureB, captureA2]) {
      expect(transcript.filter((entry) => entry.event === "capture_input" && entry.phase === "complete" && entry.id === captureId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "bytes" && entry.id === captureId && entry.payload_base64 === OSC10_QUERY_BASE64)).toHaveLength(1);
    }
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.phase === "payload" && entry.id === bMarker)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.phase === "payload" && entry.id === aMarker)).toHaveLength(1);
    expect(transcript.some((entry) => entry.event === "query_incomplete")).toBe(false);

    for (const [operation, line] of [
      ["READY", `READY ${readyId}`],
      ["QUERY", `QUERY ${queryA}`],
      ["QUERY_BYTES", `QUERY_BYTES ${captureA} ${OSC10_REPLY_BYTES} ${OSC10_QUERY_HEX}`],
      ["ECHO_INPUT", `ECHO_INPUT ${bMarker} ${bPayload}`],
      ["QUERY", `QUERY ${queryB}`],
      ["QUERY_BYTES", `QUERY_BYTES ${captureB} ${OSC10_REPLY_BYTES} ${OSC10_QUERY_HEX}`],
      ["ECHO_INPUT", `ECHO_INPUT ${aMarker} ${aPayload}`],
      ["QUERY_BYTES", `QUERY_BYTES ${captureA2} ${OSC10_REPLY_BYTES} ${OSC10_QUERY_HEX}`],
      ["SIZE", `SIZE ${sizeId}`],
    ] as const) {
      await assertCommandOnce(server, terminalId, operation, line);
    }
    const desiredA = finalA.desiredViewport;
    const desiredB = finalB.desiredViewport;
    if (!desiredA || !desiredB) throw new Error("missing desired viewport diagnostics");
    expect(desiredA.cols).not.toBe(desiredB.cols);
    expect(desiredA.rows).not.toBe(desiredB.rows);
    expect(finalA.serverViewport?.cols).toBe(Math.min(desiredA.cols, desiredB.cols));
    expect(finalA.serverViewport?.rows).toBe(Math.min(desiredA.rows, desiredB.rows));
    expect(finalA.serverViewport?.cols).toBe(finalB.serverViewport?.cols);
    expect(finalA.serverViewport?.rows).toBe(finalB.serverViewport?.rows);
    expect(browserErrorsA).toEqual([]);
    expect(browserErrorsB).toEqual([]);
  } finally {
    await contextB?.close();
  }
});
