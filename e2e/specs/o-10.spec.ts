import { Buffer } from "node:buffer";
import { Terminal as HeadlessTerminal } from "../fixtures/headless-terminal.js"
import type { Page } from "@playwright/test";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalInteractive,
  waitForTerminalBuffer,
} from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { TranscriptEntry } from "../fixtures/isolated-server.js";

const WAIT_TIMEOUT_MS = 30_000;
const TARGET_GEOMETRY = { cols: 80, rows: 10 } as const;
const SCROLLBACK_LINES = 200_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
}

interface CheckpointData {
  readonly result?: string;
  readonly sequence?: number;
  readonly epoch?: number;
  readonly size?: number;
  readonly chunks?: number;
}

interface DebugRecordEvent {
  readonly terminal: string;
  readonly type: string;
  readonly sequence?: number;
  readonly data?: string;
}

interface DebugRecordingExport {
  readonly truncated: boolean;
  readonly events: readonly DebugRecordEvent[];
}

interface HeadlessSnapshot {
  readonly activeBuffer: "normal" | "alternate";
  readonly cursorX: number;
  readonly cursorY: number;
  readonly viewportY: number;
  readonly text: string;
}

type DiagnosticWaitKind = "checkpoint-sent" | "socket-close" | "socket-open" | "sync" | "synced" | "exit";

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}


function commandBase64(command: string): string {
  return Buffer.from(`${command}\r`, "utf8").toString("base64");
}

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += Math.max(needle.length, 1);
  }
  return count;
}

async function createTerminal(page: Page, workbench: WorkbenchPage): Promise<TerminalApiInfo> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const terminal = await response.json() as TerminalApiInfo;
  expect(terminal.id).not.toBe("");
  expect(terminal.name).not.toBe("");
  return terminal;
}

async function waitForDiagnosticEvent(
  page: Page,
  terminalId: string,
  kind: DiagnosticWaitKind,
  afterEventId: number,
  generationFloor?: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, kind, after, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.id <= after) return false;
      const eventGeneration = event.snapshot.socketGeneration;
      if (generation !== undefined && eventGeneration <= generation) return false;
      if (kind === "checkpoint-sent") {
        return event.type === "checkpoint" && event.data.result === "sent";
      }
      if (kind === "socket-close") return event.type === "socket-close";
      if (kind === "socket-open") return event.type === "socket-open";
      if (kind === "sync") return event.type === "sync";
      if (kind === "synced") return event.type === "synced";
      return event.type === "exit";
    }, { timeout, afterId: after });
  }, {
    id: terminalId,
    kind,
    after: afterEventId,
    generation: generationFloor,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function startOrStopDebugRecording(
  page: Page,
  action: "start" | "stop",
): Promise<{ readonly active: boolean }> {
  return page.evaluate(async (recordingAction) => {
    const response = await fetch("/api/debug/recording", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: recordingAction }),
    });
    if (!response.ok) throw new Error(`debug recording ${recordingAction} failed with HTTP ${response.status}`);
    const value = await response.json() as { active?: unknown };
    if (typeof value.active !== "boolean") throw new Error("debug recording response omitted active state");
    return { active: value.active };
  }, action);
}

async function exportDebugRecording(page: Page): Promise<DebugRecordingExport> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export");
    if (!response.ok) throw new Error(`debug recording export failed with HTTP ${response.status}`);
    return await response.json() as DebugRecordingExport;
  });
}

async function setTargetGeometry(
  page: Page,
  pane: TerminalPanePage,
  expected: typeof TARGET_GEOMETRY,
): Promise<E2ETerminalSnapshot> {
  const current = await pane.snapshot();
  if (!current) throw new Error(`missing diagnostics snapshot for terminal ${pane.terminalId}`);
  if (
    current.cols === expected.cols
    && current.rows === expected.rows
    && current.serverViewport?.cols === expected.cols
    && current.serverViewport?.rows === expected.rows
  ) return current;
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Playwright page has no fixed viewport for geometry calibration");
  const metrics = await pane.xtermHost.evaluate((host) => {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const screenRect = screen?.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      screenWidth: screenRect?.width ?? hostRect.width,
      screenHeight: screenRect?.height ?? hostRect.height,
    };
  });
  if (!metrics.screenWidth || !metrics.screenHeight || current.cols <= 0 || current.rows <= 0) {
    throw new Error("terminal did not expose usable cell metrics for geometry calibration");
  }
  const cellWidth = metrics.screenWidth / current.cols;
  const cellHeight = metrics.screenHeight / current.rows;
  const targetWidth = Math.max(320, Math.round(viewport.width + (expected.cols - current.cols) * cellWidth));
  const targetHeight = Math.max(240, Math.round(viewport.height + (expected.rows - current.rows) * cellHeight));
  const convergence = page.evaluate(async ({ id, cols, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const server = snapshot.serverViewport;
      return snapshot.cols === cols
        && snapshot.rows === rows
        && server?.cols === cols
        && server?.rows === rows;
    }, { timeout });
  }, { id: pane.terminalId, cols: expected.cols, rows: expected.rows, timeout: WAIT_TIMEOUT_MS });
  await page.setViewportSize({ width: targetWidth, height: targetHeight });
  return convergence;
}

async function writeHeadless(terminal: HeadlessTerminal, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      terminal.write(bytes, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

function headlessSnapshot(terminal: HeadlessTerminal): HeadlessSnapshot {
  const active = terminal.buffer.active;
  let text = "";
  for (let index = 0; index < active.length && text.length < 256_000; index += 1) {
    const line = active.getLine(index);
    if (!line) continue;
    text += line.translateToString(true);
    if (index + 1 < active.length) text += "\n";
  }
  const activeBuffer = active.type === "alternate" ? "alternate" : "normal";
  return {
    activeBuffer,
    cursorX: active.cursorX,
    cursorY: active.cursorY,
    viewportY: active.viewportY,
    text,
  };
}

async function replayRecordedTerminal(
  recording: DebugRecordingExport,
  terminalId: string,
  dimensions: typeof TARGET_GEOMETRY,
): Promise<{ readonly model: HeadlessTerminal; readonly snapshot: HeadlessSnapshot }> {
  const events = recording.events.filter((event) => event.terminal === terminalId);
  const snapshotIndex = events.reduce((index, event, candidateIndex) => (
    event.type === "snapshot" ? candidateIndex : index
  ), -1);
  const latestSnapshot = snapshotIndex < 0 ? undefined : events[snapshotIndex];
  if (!latestSnapshot || latestSnapshot.type !== "snapshot" || !latestSnapshot.data) {
    throw new Error("debug recording did not contain a terminal snapshot");
  }
  const model = new HeadlessTerminal({
    cols: dimensions.cols,
    rows: dimensions.rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
    ...tuiCompatibilityOptions(),
  });
  await writeHeadless(model, decodeBase64(latestSnapshot.data));
  for (const event of events.slice(snapshotIndex + 1)) {
    if (event.type !== "output" || !event.data) continue;
    await writeHeadless(model, decodeBase64(event.data));
  }
  return { model, snapshot: headlessSnapshot(model) };
}

function assertRecordedOutputSequences(events: readonly DebugRecordEvent[]): void {
  const outputEvents = events.filter((event) => event.type === "output");
  expect(outputEvents.length).toBeGreaterThan(0);
  let nextSequence: number | undefined;
  for (const event of outputEvents) {
    expect(event.sequence).toEqual(expect.any(Number));
    expect(event.data).toEqual(expect.any(String));
    const sequence = event.sequence as number;
    const bytes = decodeBase64(event.data as string);
    if (nextSequence !== undefined) expect(sequence).toBe(nextSequence);
    nextSequence = sequence + bytes.byteLength;
  }
}

function latestEventId(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((latest, event) => Math.max(latest, event.id), -1);
}

test("O-10 Erase display and erase scrollback @O-10 @p1 @nightly @erase @checkpoint", async ({
  page,
  server,
  faultController,
  baseURL,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `O010-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-ready`;
  const staleId = `${runTag}-stale`;
  const staleText = `${runTag}-STALE`;
  const displayEraseId = `${runTag}-display`;
  const liveId = `${runTag}-live`;
  const liveText = `${runTag}-LIVE`;
  const scrollbackEraseId = `${runTag}-scrollback`;
  const finalId = `${runTag}-final`;
  const finalText = `${runTag}-FINAL`;
  const sizeId = `${runTag}-size`;
  const echoId = `${runTag}-echo`;
  const inputText = `${runTag}-CONTINUED-INPUT`;
  const inputBase64 = Buffer.from(inputText, "utf8").toString("base64");
  const staleMarker = marker("PRINT", staleId, staleText);
  const liveMarker = marker("PRINT", liveId, liveText);
  const finalMarker = marker("PRINT", finalId, finalText);
  const echoMarker = marker("ECHO_INPUT", echoId, inputBase64);
  const displayBytes = Buffer.from(`\x1b[2J\x1b[H${marker("ERASE", displayEraseId, "display")}\n`, "utf8");
  const scrollbackBytes = Buffer.from(`\x1b[3J\x1b[2J\x1b[H${marker("ERASE", scrollbackEraseId, "scrollback")}\n`, "utf8");

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const recordingStatus = await startOrStopDebugRecording(page, "start");
  expect(recordingStatus.active).toBe(true);

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const terminal = await createTerminal(page, workbench);
  const pane = new TerminalPanePage(page, terminal.id, terminal.name);
  await pane.expectVisible();
  await expectTerminalInteractive(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
  await expectConnectedTerminalInvariants(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  const geometry = await setTargetGeometry(page, pane, TARGET_GEOMETRY);
  expect(geometry.cols).toBe(TARGET_GEOMETRY.cols);
  expect(geometry.rows).toBe(TARGET_GEOMETRY.rows);
  expect(geometry.serverViewport?.cols).toBe(TARGET_GEOMETRY.cols);
  expect(geometry.serverViewport?.rows).toBe(TARGET_GEOMETRY.rows);

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "command"
      && entry.operation === "READY"
      && entry.command_base64 === commandBase64(`READY ${readyId}`),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminal.id, {
    contains: marker("READY", readyId),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const firstCheckpointFloor = latestEventId(await pane.events());
  const firstCheckpointPromise = waitForDiagnosticEvent(
    page,
    terminal.id,
    "checkpoint-sent",
    firstCheckpointFloor,
  );
  await pane.sendInput(`PRINT ${staleId} ${staleText}`, true);
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "print" && entry.id === staleId && entry.text === staleText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminal.id, { contains: staleMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const firstCheckpoint = await firstCheckpointPromise;
  const firstCheckpointData = firstCheckpoint.data as CheckpointData;
  expect(firstCheckpointData.result).toBe("sent");
  expect(firstCheckpointData.sequence).toEqual(expect.any(Number));
  expect(firstCheckpointData.epoch).toEqual(expect.any(Number));
  expect(firstCheckpointData.size).toBeGreaterThan(0);
  expect(firstCheckpointData.chunks).toBeGreaterThan(0);

  const beforeDisplayPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "o-10-before-display-erase",
  });

  await pane.sendInput(`ERASE ${displayEraseId} display`, true);
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "command"
      && entry.operation === "ERASE"
      && entry.command_base64 === commandBase64(`ERASE ${displayEraseId} display`),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "erase" && entry.id === displayEraseId && entry.mode === "display",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "write" && entry.data_base64 === bytesBase64(displayBytes),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const secondCheckpointFloor = latestEventId(await pane.events());
  const secondCheckpointPromise = waitForDiagnosticEvent(
    page,
    terminal.id,
    "checkpoint-sent",
    secondCheckpointFloor,
  );
  await pane.sendInput(`PRINT ${liveId} ${liveText}`, true);
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "print" && entry.id === liveId && entry.text === liveText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const afterDisplay = await waitForTerminalBuffer(page, terminal.id, {
    contains: liveMarker,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(afterDisplay.xterm.text).toContain(staleMarker);
  expect(countOccurrences(afterDisplay.xterm.text, staleMarker)).toBe(1);
  const afterDisplayPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "o-10-after-display-erase",
  });
  await expectTerminalPixelsChanged(beforeDisplayPixels, afterDisplayPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "o-10-display-erase-pixels",
  });
  const secondCheckpoint = await secondCheckpointPromise;
  const secondCheckpointData = secondCheckpoint.data as CheckpointData;
  expect(secondCheckpointData.result).toBe("sent");
  expect(secondCheckpointData.sequence).toEqual(expect.any(Number));
  expect(secondCheckpointData.epoch).toBe(firstCheckpointData.epoch);
  expect(secondCheckpointData.sequence).toBeGreaterThan(firstCheckpointData.sequence as number);
  expect(secondCheckpointData.size).toBeGreaterThan(0);
  expect(secondCheckpointData.chunks).toBeGreaterThan(0);

  await pane.sendInput(`ERASE ${scrollbackEraseId} scrollback`, true);
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "command"
      && entry.operation === "ERASE"
      && entry.command_base64 === commandBase64(`ERASE ${scrollbackEraseId} scrollback`),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "erase" && entry.id === scrollbackEraseId && entry.mode === "scrollback",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "write" && entry.data_base64 === bytesBase64(scrollbackBytes),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const afterScrollback = await waitForTerminalBuffer(page, terminal.id, {
    contains: finalMarker,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(afterScrollback.xterm.text).not.toContain(staleMarker);
  expect(countOccurrences(afterScrollback.xterm.text, liveMarker)).toBe(1);
  expect(countOccurrences(afterScrollback.xterm.text, finalMarker)).toBe(1);

  const beforeReconnectEvents = await pane.events();
  const beforeReconnect = await pane.snapshot();
  if (!beforeReconnect) throw new Error(`missing pre-reconnect diagnostics for terminal ${terminal.id}`);
  expect(beforeReconnect.socketState).toBe("connected");
  expect(beforeReconnect.activeSocketCount).toBe(1);
  assertNoPendingSynchronization(beforeReconnect);
  const firstGeneration = beforeReconnect.socketGeneration;
  const closeFloor = latestEventId(beforeReconnectEvents);
  const diagnosticClosePromise = waitForDiagnosticEvent(page, terminal.id, "socket-close", closeFloor);
  const terminatedPromise = faultController.waitFor(
    (event) => event.type === "connection-terminated"
      && event.terminalId === terminal.id
      && event.generation === firstGeneration,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const terminateRule = faultController.terminate({ terminalId: terminal.id, generation: firstGeneration });
  const [diagnosticClose, terminated] = await Promise.all([diagnosticClosePromise, terminatedPromise]);
  terminateRule.dispose();
  expect(diagnosticClose.snapshot.socketGeneration).toBe(firstGeneration);
  expect(terminated.abrupt).toBe(true);
  expect(terminated.code).toBe(1006);

  const reconnectFloor = latestEventId(await pane.events());
  const socketOpenPromise = waitForDiagnosticEvent(page, terminal.id, "socket-open", reconnectFloor, firstGeneration);
  const syncPromise = waitForDiagnosticEvent(page, terminal.id, "sync", reconnectFloor, firstGeneration);
  const syncedPromise = waitForDiagnosticEvent(page, terminal.id, "synced", reconnectFloor, firstGeneration);
  const [socketOpen, syncEvent, synced] = await Promise.all([socketOpenPromise, syncPromise, syncedPromise]);
  expect(socketOpen.snapshot.socketGeneration).toBeGreaterThan(firstGeneration);
  expect(syncEvent.snapshot.socketGeneration).toBe(socketOpen.snapshot.socketGeneration);
  expect(synced.snapshot.socketState).toBe("connected");
  expect(synced.snapshot.activeSocketCount).toBe(1);
  expect(synced.snapshot.acceptingInput).toBe(true);
  expect(synced.snapshot.pendingParserWrites).toBe(0);
  expect(synced.snapshot.renderBacklogBytes).toBe(0);
  expect(synced.snapshot.gridEpoch).toBe(secondCheckpointData.epoch);
  expect(synced.snapshot.checkpointSequence).toBeGreaterThanOrEqual(secondCheckpointData.sequence as number);

  const finalAfterReconnect = await waitForTerminalBuffer(page, terminal.id, {
    contains: finalMarker,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(finalAfterReconnect.xterm.text).not.toContain(staleMarker);
  expect(countOccurrences(finalAfterReconnect.xterm.text, liveMarker)).toBe(1);
  expect(countOccurrences(finalAfterReconnect.xterm.text, finalMarker)).toBe(1);
  expect(finalAfterReconnect.xterm.activeBuffer).toBe("normal");
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "o-10-after-reconnect-terminal",
  });

  await pane.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "size"
      && entry.id === sizeId
      && entry.source === "ioctl",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(sizeEntry.rows).toBe(TARGET_GEOMETRY.rows);
  expect(sizeEntry.cols).toBe(TARGET_GEOMETRY.cols);
  expect(finalAfterReconnect.serverViewport?.rows).toBe(TARGET_GEOMETRY.rows);
  expect(finalAfterReconnect.serverViewport?.cols).toBe(TARGET_GEOMETRY.cols);

  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(inputText, true);
  const echoPayload = await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === inputBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoPayload.payload_base64).toBe(inputBase64);
  await expectTerminalBuffer(page, terminal.id, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const finalInvariantReport = await expectConnectedTerminalInvariants(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
  const finalSnapshot = finalInvariantReport.snapshot;
  expect(finalSnapshot.socketGeneration).toBeGreaterThan(firstGeneration);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.syncMode).toBeUndefined();
  expect(finalSnapshot.syncTarget).toBeUndefined();
  expect(finalSnapshot.serverViewport?.cols).toBe(TARGET_GEOMETRY.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(TARGET_GEOMETRY.rows);
  expect(finalSnapshot.checkpointSequence).toBeGreaterThanOrEqual(secondCheckpointData.sequence as number);
  expect(finalSnapshot.checkpointEpoch).toBe(secondCheckpointData.epoch);
  expect(finalSnapshot.xterm.text).not.toContain(staleMarker);
  expect(countOccurrences(finalSnapshot.xterm.text, liveMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, finalMarker)).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, echoMarker)).toBe(1);

  const stopStatus = await startOrStopDebugRecording(page, "stop");
  expect(stopStatus.active).toBe(false);
  const recording = await exportDebugRecording(page);
  expect(recording.truncated).toBe(false);
  const recordingEvents = recording.events.filter((event) => event.terminal === terminal.id);
  expect(recordingEvents.length).toBeGreaterThan(0);
  assertRecordedOutputSequences(recordingEvents);
  const recordedOutput = Buffer.concat(
    recordingEvents
      .filter((event) => event.type === "output" && event.data)
      .map((event) => Buffer.from(decodeBase64(event.data as string))),
  );
  const displaySequenceOffset = recordedOutput.indexOf(Buffer.from("\x1b[2J", "utf8"));
  const scrollbackSequenceOffset = recordedOutput.indexOf(Buffer.from("\x1b[3J\x1b[2J\x1b[H", "utf8"));
  expect(displaySequenceOffset).toBeGreaterThanOrEqual(0);
  expect(scrollbackSequenceOffset).toBeGreaterThan(displaySequenceOffset);

  const replay = await replayRecordedTerminal(recording, terminal.id, TARGET_GEOMETRY);
  try {
    expect(replay.snapshot.activeBuffer).toBe(finalSnapshot.xterm.activeBuffer);
    expect(replay.snapshot.cursorX).toBe(finalSnapshot.xterm.cursorX);
    expect(replay.snapshot.cursorY).toBe(finalSnapshot.xterm.cursorY);
    expect(replay.snapshot.viewportY).toBe(finalSnapshot.xterm.viewportY);
    expect(replay.snapshot.text).toBe(finalSnapshot.xterm.text);
    expect(replay.snapshot.text).not.toContain(staleMarker);
    expect(countOccurrences(replay.snapshot.text, liveMarker)).toBe(1);
    expect(countOccurrences(replay.snapshot.text, finalMarker)).toBe(1);
    expect(countOccurrences(replay.snapshot.text, echoMarker)).toBe(1);
  } finally {
    replay.model.dispose();
  }

  const exitFloor = latestEventId(await pane.events());
  const exitEventPromise = waitForDiagnosticEvent(page, terminal.id, "exit", exitFloor);
  await pane.sendInput("EXIT 0", true);
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "exit_requested" && entry.code === 0,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const exitEntry = await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "exit" && entry.code === 0,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(exitEntry.reason).toBe("selected");
  const exitEvent = await exitEventPromise;
  expect(exitEvent.snapshot.exitCode).toBe(0);
  expect(exitEvent.snapshot.activeSocketCount).toBe(0);
  expect(exitEvent.snapshot.acceptingInput).toBe(false);

  const transcript = await server.readTranscript<TranscriptEntry>(terminal.id);
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === staleId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === liveId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === finalId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "erase" && entry.id === displayEraseId && entry.mode === "display")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "erase" && entry.id === scrollbackEraseId && entry.mode === "scrollback")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "write" && entry.data_base64 === bytesBase64(displayBytes))).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "write" && entry.data_base64 === bytesBase64(scrollbackBytes))).toHaveLength(1);
  expect(transcript
    .filter((entry) => entry.event === "erase")
    .map((entry) => entry.mode))
    .toEqual(["display", "scrollback"]);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "exit" && entry.code === 0)).toHaveLength(1);

  const events = finalInvariantReport.events;
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(2);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  assertNoUnexpectedSocketMultiplication([beforeReconnect, finalSnapshot, exitEvent.snapshot]);
  expect(browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ))).toEqual([]);
  expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);
  browserErrors.dispose();
});
