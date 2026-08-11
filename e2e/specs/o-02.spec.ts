import { Buffer } from "node:buffer";
import { Terminal as HeadlessTerminal } from "../fixtures/headless-terminal.js"
import { type Page, type TestInfo } from "@playwright/test";
import { test, expect, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import LoginPage from "../pages/login-page.js";
import TerminalPanePage from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConnected,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectConnectedTerminalInvariants,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;
// Keep the desktop layout on a deterministic 80x24 grid. The shell fixture and
// model assertions below intentionally reject a different initial geometry.
const FIXED_BROWSER_VIEWPORT = { width: 910, height: 422 } as const;
const UTF8_VECTORS = [
  { width: 2, text: "؛" },
  { width: 3, text: "\u0810" },
  { width: 4, text: "😀" },
] as const;

type E2EWindow = Window & { __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi };
type FixtureWrite = TranscriptEntry & {
  event: "write";
  write_sequence: number;
  bytes: number;
  data_base64: string;
  text?: string | null;
};

function isFixtureWrite(entry: TranscriptEntry): entry is FixtureWrite {
  return entry.event === "write"
    && typeof entry.write_sequence === "number"
    && typeof entry.bytes === "number"
    && typeof entry.data_base64 === "string";
}
type DebugRecording = {
  truncated: boolean;
  events: Array<Record<string, unknown> & { terminal?: string; type?: string; sequence?: number; data?: string }>;
};

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fixtureMarker(operation: string, fields: readonly string[]): Buffer {
  return Buffer.from(`[E2E:${operation}${fields.map((field) => `:${field}`).join("")}]\n`, "utf8");
}

function field<T>(entry: TranscriptEntry, name: string): T {
  return entry[name] as T;
}

function eventId(events: readonly E2ETerminalEvent[]): number {
  return events.at(-1)?.id ?? 0;
}

async function sendFixtureCommand(pane: TerminalPanePage, command: string): Promise<void> {
  await pane.sendInput(command, true);
}

async function waitForFixtureCommand(
  server: IsolatedServer,
  terminalId: string,
  command: string,
): Promise<TranscriptEntry> {
  const operation = command.split(/\s+/, 1)[0];
  const encoded = base64(Buffer.from(`${command}\n`, "utf8"));
  return server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
      && field<string>(entry, "operation") === operation
      && field<string>(entry, "command_base64") === encoded
  ));
}

async function waitForFixtureEntry(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: TranscriptEntry) => boolean,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(terminalId, (entry) => predicate(entry));
}

async function waitForTerminalSequence(
  page: Page,
  terminalId: string,
  sequence: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, target, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.receivedSequence === target
        && snapshot.committedSequence === target
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, target: sequence, timeout: WAIT_TIMEOUT_MS });
}

async function waitForTerminalEventAfter(
  page: Page,
  terminalId: string,
  afterId: number,
  type: E2ETerminalEventType,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after && event.type === eventType,
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterId, eventType: type, timeout: WAIT_TIMEOUT_MS });
}

async function recordingRequest(
  page: Page,
  method: "GET" | "POST",
  path: string,
  action?: "start" | "stop" | "clear",
): Promise<unknown> {
  return page.evaluate(async ({ method, path, action }) => {
    const response = await fetch(path, {
      method,
      headers: action ? { "content-type": "application/json" } : undefined,
      body: action ? JSON.stringify({ action }) : undefined,
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`debug recording request failed with HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }, { method, path, action });
}

async function writeHeadless(
  terminal: HeadlessTerminal,
  bytes: Uint8Array,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      terminal.write(bytes, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

function headlessText(terminal: HeadlessTerminal): string {
  const active = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < active.length; index += 1) {
    const line = active.getLine(index);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

function countCodePoint(text: string, codePoint: string): number {
  return [...text].filter((character) => character === codePoint).length;
}

function maxWriteSequence(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((maximum, entry) => (
    entry.event === "write" ? Math.max(maximum, field<number>(entry, "write_sequence")) : maximum
  ), 0);
}

async function waitForExitedTerminal(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "exited"
        && snapshot.activeSocketCount === 0
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

test("@nightly @O-02 @utf8 @fragmentation O-02 Fragmented UTF-8", async ({
  page,
  server,
  faultController,
}, testInfo: TestInfo) => {
  const browserErrors: string[] = [];
  const onPageError = (error: Error) => browserErrors.push(`pageerror: ${error.message}`);
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);

  await page.setViewportSize(FIXED_BROWSER_VIEWPORT);
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
  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();
  await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });

  const initial = await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
        && snapshot.cols === 80
        && snapshot.rows === 24
        && snapshot.serverViewport?.cols === 80
        && snapshot.serverViewport?.rows === 24
        && snapshot.activeSocketCount === 1
        && snapshot.acceptingInput
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
  expect(initial.cols).toBe(80);
  expect(initial.rows).toBe(24);
  expect(initial.serverViewport).toMatchObject({ cols: 80, rows: 24 });
  expect(initial.viewport.pixelWidth).toBeGreaterThan(0);
  expect(initial.viewport.pixelHeight).toBeGreaterThan(0);
  const terminalViewport = pane.xtermHost.locator(".xterm-screen");
  await expect(terminalViewport).toBeVisible();

  const token = `w${testInfo.workerIndex}-p${testInfo.parallelIndex}-${Date.now()}`;
  const readyId = `O02-READY-${token}`;
  const sizeId = `O02-SIZE-${token}`;
  const printId = `O02-PRINT-${token}`;
  const echoId = `O02-ECHO-${token}`;
  const inputMarker = `O02-CONTINUED-INPUT-${token}`;
  const unicodeMarker = `O02-UNICODE-${token}-؛-\u0810-😀`;

  const beforeRecordingTranscript = await server.readTranscript(terminalId);
  const baselineWriteSequence = maxWriteSequence(beforeRecordingTranscript);
  await recordingRequest(page, "POST", "/api/debug/recording", "clear");
  await recordingRequest(page, "POST", "/api/debug/recording", "start");
  const diagnosticsStartId = eventId(await terminalEvents(page, terminalId));
  const proxyStartIndex = faultController.events.length;
  const proxyThrottle = faultController.throttle(
    "server-to-browser",
    64 * 1024 * 1024,
    { terminalId, binaryKind: 1 },
  );

  let expectedSequence = initial.receivedSequence ?? 0;
  await sendFixtureCommand(pane, `READY ${readyId}`);
  await waitForFixtureCommand(server, terminalId, `READY ${readyId}`);
  await waitForFixtureEntry(server, terminalId, (entry) => entry.event === "ready" && field<string>(entry, "id") === readyId);
  expectedSequence += fixtureMarker("READY", [readyId]).byteLength;
  await waitForTerminalSequence(page, terminalId, expectedSequence);

  await sendFixtureCommand(pane, `SIZE ${sizeId}`);
  await waitForFixtureCommand(server, terminalId, `SIZE ${sizeId}`);
  const size = await waitForFixtureEntry(server, terminalId, (entry) => entry.event === "size" && field<string>(entry, "id") === sizeId);
  expect(field<number>(size, "rows")).toBe(24);
  expect(field<number>(size, "cols")).toBe(80);
  expectedSequence += fixtureMarker("SIZE", [sizeId, "24", "80"]).byteLength;
  await waitForTerminalSequence(page, terminalId, expectedSequence);

  const cases: Array<{ readonly id: string; readonly text: string; readonly width: number; readonly split: number; readonly bytes: Buffer }> = [];
  for (const vector of UTF8_VECTORS) {
    const bytes = Buffer.from(vector.text, "utf8");
    expect(bytes.byteLength).toBe(vector.width);
    for (let split = 1; split < bytes.byteLength; split += 1) {
      cases.push({
        id: `O02-${vector.width}B-${split}-${token}`,
        text: vector.text,
        width: vector.width,
        split,
        bytes,
      });
    }
  }

  for (const current of cases) {
    const holdToken = `O02-HOLD-${current.id}`;
    const holdCommand = `HOLD ${holdToken}`;
    await sendFixtureCommand(pane, holdCommand);
    await waitForFixtureCommand(server, terminalId, holdCommand);
    await waitForFixtureEntry(server, terminalId, (entry) => entry.event === "hold" && field<string>(entry, "token") === holdToken);
    expectedSequence += fixtureMarker("HOLD", [holdToken]).byteLength;
    await waitForTerminalSequence(page, terminalId, expectedSequence);

    const utf8Command = `UTF8_SPLIT ${current.id} ${current.text} ${current.split}`;
    await sendFixtureCommand(pane, utf8Command);
    await waitForFixtureCommand(server, terminalId, utf8Command);

    const beforeRelease = await pane.snapshot();
    if (!beforeRelease) throw new Error(`missing diagnostics snapshot for terminal ${terminalId}`);
    expect(beforeRelease.receivedSequence).toBe(expectedSequence);
    const releaseStartSequence = expectedSequence;
    const outputFrame = faultController.waitFor((event) => (
      event.type === "frame"
        && event.terminalId === terminalId
        && event.direction === "server-to-browser"
        && event.frame?.binaryKind === 1
        && event.frame.sequence === releaseStartSequence
    ), { timeoutMs: WAIT_TIMEOUT_MS });

    const releaseCommand = `RELEASE ${holdToken}`;
    await sendFixtureCommand(pane, releaseCommand);
    await waitForFixtureCommand(server, terminalId, releaseCommand);
    await waitForFixtureEntry(server, terminalId, (entry) => entry.event === "release" && field<string>(entry, "token") === holdToken);
    expectedSequence += fixtureMarker("RELEASE", [holdToken]).byteLength + current.bytes.byteLength;
    await outputFrame;
    const splitSnapshot = await waitForTerminalSequence(page, terminalId, expectedSequence);
    expect(splitSnapshot.xterm.text).not.toContain("\uFFFD");
    expect(splitSnapshot.xterm.text).not.toMatch(/[\u0080-\u009F]/);
  }

  const splitSnapshot = await pane.snapshot();
  if (!splitSnapshot) throw new Error(`missing split diagnostics snapshot for terminal ${terminalId}`);
  for (const vector of UTF8_VECTORS) {
    expect(countCodePoint(splitSnapshot.xterm.text, vector.text)).toBe(1);
  }

  const beforePrint = await screenshotRegion(page, terminalViewport);
  await sendFixtureCommand(pane, `PRINT ${printId} ${unicodeMarker}`);
  await waitForFixtureCommand(server, terminalId, `PRINT ${printId} ${unicodeMarker}`);
  await waitForFixtureEntry(server, terminalId, (entry) => entry.event === "print" && field<string>(entry, "id") === printId);
  expectedSequence += fixtureMarker("PRINT", [printId, unicodeMarker]).byteLength;
  await waitForTerminalSequence(page, terminalId, expectedSequence);
  await expectTerminalBuffer(page, terminalId, {
    contains: unicodeMarker,
    occurrences: 1,
  });
  const { after: afterPrint } = await expectKnownMarkerChanged(page, terminalViewport, beforePrint, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "o-02-unicode-marker-crop",
  });
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "o-02-unicode-terminal-crop",
  });
  expect(afterPrint.width).toBe(beforePrint.width);
  expect(afterPrint.height).toBe(beforePrint.height);

  const echoCommand = `ECHO_INPUT ${echoId}`;
  await sendFixtureCommand(pane, echoCommand);
  await waitForFixtureCommand(server, terminalId, echoCommand);
  await waitForFixtureEntry(server, terminalId, (entry) => entry.event === "echo_input" && field<string>(entry, "id") === echoId && field<string>(entry, "phase") === "armed");
  await pane.sendInput(inputMarker, true);
  const payload = await waitForFixtureEntry(server, terminalId, (entry) => entry.event === "echo_input" && field<string>(entry, "id") === echoId && field<string>(entry, "phase") === "payload");
  expect(field<string>(payload, "payload_base64")).toBe(base64(Buffer.from(inputMarker, "utf8")));
  expectedSequence += fixtureMarker("ECHO_INPUT", [echoId, "READY"]).byteLength;
  expectedSequence += fixtureMarker("ECHO_INPUT", [echoId, base64(Buffer.from(inputMarker, "utf8"))]).byteLength;
  await waitForTerminalSequence(page, terminalId, expectedSequence);

  const connectedReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  assertNoPendingSynchronization(connectedReport.snapshot);
  expect(connectedReport.snapshot.receivedSequence).toBe(expectedSequence);
  expect(connectedReport.snapshot.committedSequence).toBe(expectedSequence);

  const beforeExitEvents = await terminalEvents(page, terminalId);
  const exitCommand = "EXIT 0";
  await sendFixtureCommand(pane, exitCommand);
  await waitForFixtureCommand(server, terminalId, exitCommand);
  await waitForFixtureEntry(server, terminalId, (entry) => entry.event === "exit_requested" && field<number>(entry, "code") === 0);
  expectedSequence += fixtureMarker("EXIT", ["0"]).byteLength;
  await waitForTerminalSequence(page, terminalId, expectedSequence);
  const exitEvent = await waitForTerminalEventAfter(page, terminalId, eventId(beforeExitEvents), "exit");
  expect(field<number>(exitEvent.data, "exitCode")).toBe(0);
  await waitForTerminalEventAfter(page, terminalId, exitEvent.id, "socket-close");
  const finalSnapshot = await waitForExitedTerminal(page, terminalId);
  expect(finalSnapshot.exitCode).toBe(0);
  expect(finalSnapshot.syncMode).toBeUndefined();
  expect(finalSnapshot.syncTarget).toBeUndefined();
  expect(finalSnapshot.acceptingInput).toBe(false);

  await recordingRequest(page, "POST", "/api/debug/recording", "stop");
  const recording = await recordingRequest(page, "GET", "/api/debug/recording/export") as DebugRecording;
  proxyThrottle.dispose();

  expect(recording.truncated).toBe(false);
  const outputEvents = recording.events.filter((event) => (
    event.terminal === terminalId
      && event.type === "output"
      && typeof event.sequence === "number"
      && typeof event.data === "string"
  ));
  expect(outputEvents.length).toBeGreaterThan(0);
  const outputChunks = outputEvents.map((event) => Buffer.from(event.data!, "base64"));
  expect(outputEvents[0]?.sequence).toBe(initial.receivedSequence ?? 0);
  let serverSequence = initial.receivedSequence ?? 0;
  for (const [index, event] of outputEvents.entries()) {
    expect(event.sequence).toBe(serverSequence);
    serverSequence += outputChunks[index]!.byteLength;
  }
  expect(serverSequence).toBe(expectedSequence);
  expect(finalSnapshot.receivedSequence).toBe(serverSequence);
  expect(finalSnapshot.committedSequence).toBe(serverSequence);

  const transcript = await server.readTranscript(terminalId);
  const fixtureWrites = transcript.filter((entry): entry is FixtureWrite => (
    isFixtureWrite(entry)
    && entry.write_sequence > baselineWriteSequence
  ));
  expect(fixtureWrites.length).toBeGreaterThan(0);
  const fixtureBytes = fixtureWrites.map((entry) => Buffer.from(entry.data_base64, "base64"));
  expect(Buffer.concat(fixtureBytes)).toEqual(Buffer.concat(outputChunks));

  const splitEntries = transcript.filter((entry) => entry.event === "utf8_split");
  expect(splitEntries).toHaveLength(cases.length);
  expect(splitEntries.map((entry) => [field<string>(entry, "id"), field<string>(entry, "text"), field<number>(entry, "split"), field<number>(entry, "bytes")])).toEqual(
    cases.map((current) => [current.id, current.text, current.split, current.bytes.byteLength]),
  );
  const splitCommands = transcript.filter((entry) => entry.event === "command" && field<string>(entry, "operation") === "UTF8_SPLIT");
  expect(splitCommands.map((entry) => field<string>(entry, "command_base64"))).toEqual(
    cases.map((current) => base64(Buffer.from(`UTF8_SPLIT ${current.id} ${current.text} ${current.split}\n`, "utf8"))),
  );
  const expectedSplitChunks = cases.flatMap((current) => [
    base64(current.bytes.subarray(0, current.split)),
    base64(current.bytes.subarray(current.split)),
  ]);
  const expectedSplitSet = new Set(expectedSplitChunks);
  const splitWrites = fixtureWrites.filter((entry) => expectedSplitSet.has(entry.data_base64));
  expect(splitWrites.map((entry) => entry.data_base64)).toEqual(expectedSplitChunks);
  expect(splitWrites.every((entry) => entry.text === null)).toBe(true);

  const proxyOutputFrames = faultController.events.slice(proxyStartIndex).filter((event) => (
    event.type === "frame"
      && event.terminalId === terminalId
      && event.direction === "server-to-browser"
      && event.frame?.binaryKind === 1
  ));
  expect(proxyOutputFrames).toHaveLength(outputEvents.length);
  for (const [index, frameEvent] of proxyOutputFrames.entries()) {
    const frame = frameEvent.frame!;
    expect(frame.opcode).toBe(2);
    expect(frame.fin).toBe(true);
    expect(frame.sequence).toBe(outputEvents[index]!.sequence);
    const terminalFrameBytes = 9 + outputChunks[index]!.byteLength;
    const webSocketHeaderBytes = terminalFrameBytes < 126 ? 2 : terminalFrameBytes < 65_536 ? 4 : 10;
    expect(frame.bytes).toBe(terminalFrameBytes + webSocketHeaderBytes);
  }

  const events = await terminalEvents(page, terminalId);
  const outputReceived = events.filter((event) => (
    event.id > diagnosticsStartId
      && event.type === "output-received"
      && typeof event.data.sequence === "number"
      && typeof event.data.bytes === "number"
  ));
  const parserCommits = events.filter((event) => (
    event.id > diagnosticsStartId
      && event.type === "parser-commit"
      && typeof event.data.sequence === "number"
  ));
  const expectedOutputEnds: number[] = [];
  let outputEnd = initial.receivedSequence ?? 0;
  for (const chunk of outputChunks) {
    outputEnd += chunk.byteLength;
    expectedOutputEnds.push(outputEnd);
  }
  expect(outputReceived.map((event) => field<number>(event.data, "sequence"))).toEqual(expectedOutputEnds);
  expect(outputReceived.map((event) => field<number>(event.data, "bytes"))).toEqual(outputChunks.map((chunk) => chunk.byteLength));
  expect(parserCommits.map((event) => field<number>(event.data, "sequence"))).toEqual(expectedOutputEnds);
  for (const commit of parserCommits) {
    const commitSequence = field<number>(commit.data, "sequence");
    expect(outputReceived.some((received) => (
      received.id < commit.id && field<number>(received.data, "sequence") >= commitSequence
    ))).toBe(true);
  }
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(faultController.events.slice(proxyStartIndex).filter((event) => event.type === "socket-error")).toHaveLength(0);

  const model = new HeadlessTerminal({
    cols: initial.cols,
    rows: initial.rows,
    scrollback: 10_000,
    allowProposedApi: true,
    ...tuiCompatibilityOptions(),
  });
  for (const chunk of outputChunks) await writeHeadless(model, chunk);
  const modelText = headlessText(model);
  expect(finalSnapshot.xterm.activeBuffer).toBe(model.buffer.active.type);
  expect(finalSnapshot.xterm.cursorX).toBe(model.buffer.active.cursorX);
  expect(finalSnapshot.xterm.cursorY).toBe(model.buffer.active.cursorY);
  expect(finalSnapshot.xterm.viewportY).toBe(model.buffer.active.viewportY);
  expect(finalSnapshot.xterm.text).toBe(modelText);
  expect(modelText).not.toContain("\uFFFD");
  expect(modelText).not.toMatch(/[\u0080-\u009F]/);
  for (const vector of UTF8_VECTORS) expect(countCodePoint(modelText, vector.text)).toBe(2);
  model.dispose();

  expect(finalSnapshot.xterm.text).toContain(unicodeMarker);
  expect(finalSnapshot.xterm.text).toContain(inputMarker);
  const finalReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(finalReport.violations).toEqual([]);
  expect(finalSnapshot.activeSocketCount).toBe(0);
  expect(finalSnapshot.socket.activeCount).toBe(0);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(browserErrors).toEqual([]);

  page.off("pageerror", onPageError);
  page.off("console", onConsole);
});
