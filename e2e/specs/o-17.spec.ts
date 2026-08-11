import { Buffer } from "node:buffer";
import { Terminal } from "../fixtures/headless-terminal.js"
import type { Page, TestInfo } from "@playwright/test";
import { expect, test, type TranscriptEntry } from "../fixtures/test.js";
import type {
  NetworkFaultController,
  NetworkFaultEvent,
} from "../fixtures/network-faults.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConnected,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  changedPixelRatio,
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
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

type ProtocolFaultCase = {
  readonly id: "gap" | "unknown-kind" | "truncated-header" | "unsafe-sequence";
  readonly expectedError: string;
  readonly payloadText?: string;
  readonly buildFrame: (previousEnd: number) => Uint8Array;
};

const WAIT_TIMEOUT_MS = 45_000;
const BROWSER_VIEWPORT = { width: 1_280, height: 720 } as const;
const MALFORMED_PIXEL_CHANGE_LIMIT = 0.02;
const SAFE_SEQUENCE_LIMIT = BigInt(Number.MAX_SAFE_INTEGER);

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function marker(operation: string, ...fields: readonly string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}


function terminalFrame(kind: number, sequence: bigint, payload: string): Uint8Array {
  const payloadBytes = Buffer.from(payload, "utf8");
  const frame = new Uint8Array(9 + payloadBytes.byteLength);
  frame[0] = kind;
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setBigUint64(1, sequence, false);
  frame.set(payloadBytes, 9);
  return frame;
}

function truncatedHeader(): Uint8Array {
  const frame = new Uint8Array(8);
  frame[0] = 1;
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(1, 0, false);
  return frame;
}

const protocolFaultCases: readonly ProtocolFaultCase[] = [
  {
    id: "gap",
    expectedError: "terminal output sequence gap",
    payloadText: "O17-GAP-INJECTED-PAYLOAD",
    buildFrame: (previousEnd) => terminalFrame(1, BigInt(previousEnd) + 1n, "O17-GAP-INJECTED-PAYLOAD"),
  },
  {
    id: "unknown-kind",
    expectedError: "unknown terminal frame kind",
    payloadText: "O17-UNKNOWN-INJECTED-PAYLOAD",
    buildFrame: (previousEnd) => terminalFrame(0x7f, BigInt(previousEnd), "O17-UNKNOWN-INJECTED-PAYLOAD"),
  },
  {
    id: "truncated-header",
    expectedError: "terminal frame is missing its header",
    buildFrame: () => truncatedHeader(),
  },
  {
    id: "unsafe-sequence",
    expectedError: "terminal sequence exceeds JavaScript's safe integer range",
    payloadText: "O17-UNSAFE-INJECTED-PAYLOAD",
    buildFrame: () => terminalFrame(1, SAFE_SEQUENCE_LIMIT + 1n, "O17-UNSAFE-INJECTED-PAYLOAD"),
  },
];


function transcriptString(entry: TranscriptEntry, key: string): string | undefined {
  const value = entry[key];
  return typeof value === "string" ? value : undefined;
}

function transcriptBytes(entry: TranscriptEntry): Buffer {
  const data = transcriptString(entry, "data_base64");
  if (!data) throw new Error("fixture transcript write omitted data_base64");
  return Buffer.from(data, "base64");
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
}

function activeText(terminal: Terminal): string {
  const active = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < active.length; index += 1) {
    lines.push(active.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

async function writeModel(terminal: Terminal, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(bytes, resolve));
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

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  expectedText: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, text, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const compactExpectedText = text.replace(/\r?\n/g, "");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.syncTarget === undefined
      && snapshot.xterm.text.replace(/\r?\n/g, "").includes(compactExpectedText)
    ), { timeout });
  }, { id: terminalId, text: expectedText, timeout: WAIT_TIMEOUT_MS });
}

async function waitForGenerationEvent(
  page: Page,
  terminalId: string,
  type: "socket-created" | "synced",
  previousGeneration: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, eventType, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === eventType && event.snapshot.socketGeneration > generation
    ), { timeout });
  }, { id: terminalId, eventType: type, generation: previousGeneration, timeout: WAIT_TIMEOUT_MS });
}

async function waitForProtocolClose(
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
): Promise<NetworkFaultEvent> {
  return faultController.waitFor((event) => (
    (event.type === "connection-closed" || event.type === "connection-terminated")
    && event.terminalId === terminalId
    && event.generation === generation
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

function recordingMessage(event: RecordingEvent): Record<string, unknown> | undefined {
  if (!event.message || typeof event.message !== "object" || Array.isArray(event.message)) return undefined;
  return event.message as Record<string, unknown>;
}

function recordingBytes(event: RecordingEvent): Buffer {
  if (typeof event.data !== "string") throw new Error(`recording ${event.type} event omitted data`);
  return Buffer.from(event.data, "base64");
}

async function modelFromRecording(
  recording: RecordingExport,
  terminalId: string,
  baseline: E2ETerminalSnapshot,
): Promise<{ readonly model: Terminal; readonly outputBytes: Buffer }> {
  const model = new Terminal({
    cols: baseline.cols,
    rows: baseline.rows,
    scrollback: 200_000,
    ...tuiCompatibilityOptions(),
  });
  let outputEnd: number | undefined;
  const outputChunks: Buffer[] = [];
  let outputCount = 0;
  for (const event of recording.events) {
    if (event.terminal !== terminalId) continue;
    const message = event.type === "control" ? recordingMessage(event) : undefined;
    if (message?.type === "sync" && message.mode === "snapshot") model.reset();
    if (message?.type === "size") {
      const cols = message.cols;
      const rows = message.rows;
      if (typeof cols !== "number" || typeof rows !== "number") throw new Error("recorded size omitted dimensions");
      model.resize(cols, rows);
    }
    if (event.type !== "output" && event.type !== "snapshot") continue;
    const bytes = recordingBytes(event);
    await writeModel(model, bytes);
    if (event.type === "output") {
      if (typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence)) throw new Error("recorded output omitted a safe sequence");
      if (outputEnd !== undefined) expect(event.sequence).toBe(outputEnd);
      outputEnd = event.sequence + bytes.byteLength;
      // A frame starts at the stream's committed offset. Include the frame
      // whose start equals the baseline boundary; filtering strictly above it
      // drops the first post-baseline command output.
      if (baseline.committedSequence === undefined || event.sequence >= baseline.committedSequence) {
        outputChunks.push(bytes);
      }
      outputCount += 1;
    }
  }
  expect(outputCount).toBeGreaterThan(0);
  return { model, outputBytes: Buffer.concat(outputChunks) };
}

async function waitForTerminalId(page: Page, workbench: WorkbenchPage): Promise<string> {
  const mounted = page.evaluate(async ({ timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, { timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  return (await mounted).terminalId;
}

for (const faultCase of protocolFaultCases) {
  test(`@nightly @O-17 @protocol-error @malformed O-17 Sequence gap and malformed frame — ${faultCase.id}`, async ({
    page,
    baseURL,
    server,
    faultController,
  }, testInfo: TestInfo) => {
    await page.setViewportSize(BROWSER_VIEWPORT);
    const browserErrors = installBrowserErrorCollectors(page);
    try {
      await page.goto(baseURL);
      await new LoginPage(page).login();
      const workbench = new WorkbenchPage(page);
      await workbench.expectVisible();
      await recordingControl(page, "start");
      const terminalId = await waitForTerminalId(page, workbench);
      const pane = new TerminalPanePage(page, terminalId);
      await pane.expectVisible();
      const initial = await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
      await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
      const baseline = await waitForSettledTerminal(page, terminalId, "");
      expect(baseline.serverViewport).toBeDefined();
      expect(baseline.serverViewport).toMatchObject({
        cols: baseline.cols,
        rows: baseline.rows,
        pixelWidth: baseline.pixelWidth,
        pixelHeight: baseline.pixelHeight,
      });
      expect(initial.socketGeneration).toBe(baseline.socketGeneration);
      if (baseline.committedSequence === undefined) throw new Error("baseline omitted a committed sequence");
      const transcriptAtBaseline = await server.readTranscript(terminalId);
      const transcriptFloor = transcriptAtBaseline.reduce((maximum, entry) => {
        const sequence = entry.sequence;
        return typeof sequence === "number" && Number.isSafeInteger(sequence)
          ? Math.max(maximum, sequence)
          : maximum;
      }, 0);

      await pane.focus();
      const suffix = `${testInfo.workerIndex}-${testInfo.parallelIndex}-${faultCase.id}`;
      const readyId = `O17_READY_${suffix}`;
      const beforeId = `O17_BEFORE_${suffix}`;
      const finalId = `O17_FINAL_${suffix}`;
      const echoId = `O17_ECHO_${suffix}`;
      const sizeId = `O17_SIZE_${suffix}`;
      const beforeText = `O17_BEFORE_${suffix}`;
      const finalText = `O17_AFTER_${suffix}`;
      const echoPayload = `O17_INPUT_CONTINUES_${suffix}`;
      const readyMarker = marker("READY", readyId);
      const beforeMarker = marker("PRINT", beforeId, beforeText);
      const finalMarker = marker("PRINT", finalId, finalText);
      const echoReadyMarker = marker("ECHO_INPUT", echoId, "READY");
      const echoMarker = marker("ECHO_INPUT", echoId, base64(echoPayload));

      await pane.sendInput(`READY ${readyId}`, true);
      await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
      await waitForSettledTerminal(page, terminalId, readyMarker);
      await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
      await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText, { timeoutMs: WAIT_TIMEOUT_MS });
      const before = await waitForSettledTerminal(page, terminalId, beforeMarker);
      const beforePixels = await screenshotRegion(page, pane.xtermHost.locator(".xterm-screen"));
      await expectTerminalNonBlank(page, pane.xtermHost.locator(".xterm-screen"), {
        testInfo,
        artifactName: `o-17-${faultCase.id}-before-nonblank`,
      });
      const previousEnd = before.committedSequence ?? before.receivedSequence;
      if (previousEnd === undefined || !Number.isSafeInteger(previousEnd)) throw new Error("before marker did not establish a safe stream sequence");
      const malformedPayload = faultCase.payloadText;
      const malformedFrame = faultCase.buildFrame(previousEnd);
      const previousGeneration = before.socketGeneration;
      const diagnosticsFloor = (await terminalEvents(page, terminalId)).reduce((floor, event) => Math.max(floor, event.id), 0);
      const networkFloor = faultController.events.length;
      const notice = page.locator('.toast[role="status"]').filter({ hasText: faultCase.expectedError }).first();
      const noticePromise = expect(notice).toBeVisible({ timeout: WAIT_TIMEOUT_MS });
      const closePromise = waitForProtocolClose(faultController, terminalId, previousGeneration);
      const reconnectPromise = waitForGenerationEvent(page, terminalId, "socket-created", previousGeneration);
      const syncedPromise = waitForGenerationEvent(page, terminalId, "synced", previousGeneration);
      const injection = faultController.inject({
        direction: "server-to-browser",
        data: malformedFrame,
        binary: true,
        matcher: {
          terminalId,
          generation: previousGeneration,
          direction: "server-to-browser",
        },
        when: "after",
      });
      const injected = await faultController.waitFor((event) => (
        event.type === "injected"
        && event.terminalId === terminalId
        && event.generation === previousGeneration
        && event.ruleId === injection.id
      ), { timeoutMs: WAIT_TIMEOUT_MS });
      expect(injected.bytes).toBe(malformedFrame.byteLength + 2);
      injection.dispose();
      const [closed, reconnected, synced] = await Promise.all([
        closePromise,
        reconnectPromise,
        syncedPromise,
        noticePromise,
      ]);
      expect(closed.code).toBe(4002);
      expect(reconnected.snapshot.socketGeneration).toBe(synced.snapshot.socketGeneration);
      expect(synced.snapshot.socketGeneration).toBeGreaterThan(previousGeneration);
      expect(synced.snapshot.socketState).toBe("connected");
      expect(synced.snapshot.acceptingInput).toBe(true);

      const recovered = await waitForSettledTerminal(page, terminalId, beforeMarker);
      expect(recovered.xterm.text.replace(/\r?\n/g, "")).not.toContain((malformedPayload ?? "O17-NONEXISTENT-INJECTED-PAYLOAD").replace(/\r?\n/g, ""));
      const recoveredPixels = await screenshotRegion(page, pane.xtermHost.locator(".xterm-screen"));
      expect(changedPixelRatio(beforePixels, recoveredPixels)).toBeLessThan(MALFORMED_PIXEL_CHANGE_LIMIT);

      await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
      await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText, { timeoutMs: WAIT_TIMEOUT_MS });
      await waitForSettledTerminal(page, terminalId, finalMarker);
      await expectKnownMarkerChanged(page, pane.xtermHost.locator(".xterm-screen"), recoveredPixels, {
        minimumChangedRatio: 0.002,
        testInfo,
        artifactName: `o-17-${faultCase.id}-final-marker`,
      });

      await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
      await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
      await pane.sendInput(echoPayload, true);
      const echoed = await server.waitForTranscript(terminalId, (entry) => (
        entry.event === "echo_input"
        && entry.id === echoId
        && entry.phase === "payload"
      ), { timeoutMs: WAIT_TIMEOUT_MS });
      expect(echoed.payload_base64).toBe(base64(echoPayload));
      await waitForSettledTerminal(page, terminalId, echoMarker);

      await pane.sendInput(`SIZE ${sizeId}`, true);
      const size = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl", { timeoutMs: WAIT_TIMEOUT_MS });
      expect(size.cols).toBe(baseline.cols);
      expect(size.rows).toBe(baseline.rows);
      expect(size.pixel_width).toBe(baseline.pixelWidth);
      expect(size.pixel_height).toBe(baseline.pixelHeight);
      const finalSnapshot = await waitForSettledTerminal(page, terminalId, marker("SIZE", sizeId, String(size.rows), String(size.cols)));

      await recordingControl(page, "stop");
      const recording = await recordingExport(page);
      expect(recording.truncated).toBe(false);
      const modelResult = await modelFromRecording(recording, terminalId, baseline);
      const finalTextFromModel = activeText(modelResult.model);
      expect(finalSnapshot.xterm.text).toBe(finalTextFromModel);
      expect(finalSnapshot.xterm.activeBuffer).toBe(modelResult.model.buffer.active.type);
      expect(finalSnapshot.xterm.cursorX).toBe(modelResult.model.buffer.active.cursorX);
      expect(finalSnapshot.xterm.cursorY).toBe(modelResult.model.buffer.active.cursorY);
      expect(finalSnapshot.xterm.viewportY).toBe(modelResult.model.buffer.active.viewportY);
      expect(finalSnapshot.activeBuffer).toBe(modelResult.model.buffer.active.type);
      expect(finalSnapshot.text).toBe(finalSnapshot.xterm.text);
      expect(finalSnapshot.selectionText).toBe("");

      const transcript = await server.readTranscript(terminalId);
      const prints = transcript.filter((entry) => entry.event === "print");
      expect(prints.filter((entry) => entry.id === beforeId)).toHaveLength(1);
      expect(prints.filter((entry) => entry.id === finalId)).toHaveLength(1);
      const writeEntries = transcript.filter((entry) => (
        entry.event === "write"
        && typeof entry.sequence === "number"
        && entry.sequence > transcriptFloor
      ));
      const fixtureBytes = Buffer.concat(writeEntries.map(transcriptBytes));
      const fixtureText = fixtureBytes.toString("utf8");
      expect(countOccurrences(fixtureText, beforeMarker)).toBe(1);
      expect(countOccurrences(fixtureText, finalMarker)).toBe(1);
      expect(countOccurrences(fixtureText, readyMarker)).toBe(1);
      expect(countOccurrences(fixtureText, echoReadyMarker)).toBe(1);
      expect(countOccurrences(fixtureText, echoMarker)).toBe(1);
      expect(faultCase.payloadText ? fixtureText.includes(faultCase.payloadText) : false).toBe(false);
      expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
      expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);

      expect(modelResult.outputBytes).toEqual(fixtureBytes);
      const recordedMalformedPayload = recording.events.some((event) => (
        event.terminal === terminalId
        && event.type === "output"
        && malformedPayload !== undefined
        && event.data === base64(malformedPayload)
      ));
      expect(recordedMalformedPayload).toBe(false);
      const outputEvents = recording.events.filter((event) => event.terminal === terminalId && event.type === "output");
      expect(outputEvents.length).toBeGreaterThan(0);
      for (const event of outputEvents) {
        expect(event.sequence).toEqual(expect.any(Number));
      }

      const finalEvents = await terminalEvents(page, terminalId);
      await assertMonotonicSequences(finalEvents);
      const postFaultOutput = finalEvents.filter((event) => event.id > diagnosticsFloor && event.type === "output-received");
      if (malformedPayload !== undefined) {
        expect(postFaultOutput.some((event) => event.data.sequence === previousEnd + Buffer.byteLength(malformedPayload))).toBe(false);
      }
      expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
      expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(2);
      expect(finalEvents.filter((event) => event.type === "socket-close").length).toBeGreaterThanOrEqual(1);
      expect(finalSnapshot.socketState).toBe("connected");
      expect(finalSnapshot.activeSocketCount).toBe(1);
      expect(finalSnapshot.socket.activeCount).toBe(1);
      expect(finalSnapshot.acceptingInput).toBe(true);
      expect(finalSnapshot.syncMode).toBeUndefined();
      expect(finalSnapshot.serverViewport).toMatchObject({
        cols: baseline.cols,
        rows: baseline.rows,
        pixelWidth: baseline.pixelWidth,
        pixelHeight: baseline.pixelHeight,
      });
      await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
      await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
      await expectTerminalBuffer(page, terminalId, {
        contains: beforeMarker,
        occurrences: 1,
      }, { timeout: WAIT_TIMEOUT_MS });
      await expectTerminalBuffer(page, terminalId, {
        contains: finalMarker,
        occurrences: 1,
      }, { timeout: WAIT_TIMEOUT_MS });
      await expectTerminalNonBlank(page, pane.xtermHost.locator(".xterm-screen"), {
        testInfo,
        artifactName: `o-17-${faultCase.id}-final-nonblank`,
      });

      const proxyEvents = faultController.events.slice(networkFloor);
      expect(proxyEvents.filter((event) => event.type === "injected")).toHaveLength(1);
      expect(proxyEvents.filter((event) => event.type === "malformed-frame")).toEqual([]);
      const protocolClose = proxyEvents.find((event) => (
        (event.type === "connection-closed" || event.type === "connection-terminated")
        && event.generation === previousGeneration
      ));
      expect(protocolClose?.code).toBe(4002);
      expect(recording.events.some((event) => (
        event.terminal === terminalId
        && event.type === "control"
        && recordingMessage(event)?.type === "sync"
      ))).toBe(true);

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
      expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
    } finally {
      browserErrors.dispose();
    }
  });
}
