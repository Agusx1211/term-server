import { Buffer } from "node:buffer";
import { Terminal as HeadlessTerminal } from "../fixtures/headless-terminal.js"
import type { Page } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
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
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { expectConnectedTerminalInvariants, expectTerminalInvariants } from "../assertions/invariants.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

type E2EWindow = Window & { __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi };

type FixtureWrite = TranscriptEntry & {
  event: "write";
  write_sequence: number;
  bytes: number;
  data_base64: string;
};

type DebugEvent = {
  readonly terminal?: string;
  readonly type?: string;
  readonly sequence?: number;
  readonly data?: string;
  readonly message?: Record<string, unknown>;
};

type DebugRecording = {
  readonly truncated: boolean;
  readonly events: readonly DebugEvent[];
};

type DiagnosticWait = {
  readonly type: E2ETerminalEventType;
  readonly exactGeneration?: number;
  readonly minimumGeneration?: number;
  readonly minimumSequence?: number;
  readonly requirePendingParser?: boolean;
  readonly syncMode?: "snapshot" | "resume";
};

const WAIT_TIMEOUT_MS = 30_000;
const FIXED_BROWSER_VIEWPORT = { width: 910, height: 422 } as const;
const BURST_BYTES = 262_144;
const BURST_LINE_WIDTH = 80;
const MAX_DIAGNOSTIC_TEXT = 256_000;

function field<T>(entry: TranscriptEntry, name: string): T {
  return entry[name] as T;
}

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}


function writeBytes(entry: FixtureWrite): Buffer {
  return Buffer.from(entry.data_base64, "base64");
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
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

async function waitForDiagnosticEvent(
  page: Page,
  terminalId: string,
  options: DiagnosticWait,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, wait, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.type !== wait.type) return false;
      if (wait.exactGeneration !== undefined && event.snapshot.socketGeneration !== wait.exactGeneration) return false;
      if (wait.minimumGeneration !== undefined && event.snapshot.socketGeneration < wait.minimumGeneration) return false;
      if (wait.minimumSequence !== undefined) {
        const sequence = event.data.sequence;
        if (typeof sequence !== "number" || sequence < wait.minimumSequence) return false;
      }
      if (wait.requirePendingParser && (event.snapshot.pendingParserWrites <= 0 || event.snapshot.pendingParserBytes <= 0)) return false;
      if (wait.syncMode !== undefined && event.data.mode !== wait.syncMode) return false;
      return true;
    }, { timeout });
  }, { id: terminalId, wait: options, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  minimumGeneration?: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && (generation === undefined || snapshot.socketGeneration >= generation)
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && snapshot.syncMode === undefined
      && snapshot.syncTarget === undefined
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
    ), { timeout });
  }, { id: terminalId, generation: minimumGeneration, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
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

async function writeHeadless(terminal: HeadlessTerminal, bytes: Uint8Array): Promise<void> {
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
  let text = "";
  const length = Math.min(active.length, 20_000);
  for (let index = 0; index < length && text.length < MAX_DIAGNOSTIC_TEXT; index += 1) {
    const line = active.getLine(index);
    if (!line) continue;
    text += line.translateToString(true);
    if (index + 1 < length) text += "\n";
  }
  return text;
}

function outputRecords(recording: DebugRecording, terminalId: string): DebugEvent[] {
  return recording.events.filter((event) => (
    event.terminal === terminalId
      && event.type === "output"
      && typeof event.sequence === "number"
      && typeof event.data === "string"
  ));
}

function controlRecords(recording: DebugRecording, terminalId: string, type: string): DebugEvent[] {
  return recording.events.filter((event) => (
    event.terminal === terminalId
      && event.type === "control"
      && event.message?.type === type
  ));
}

function outputFrameCount(
  events: readonly { readonly type?: string; readonly terminalId?: string; readonly generation?: number; readonly direction?: string; readonly frame?: { readonly binaryKind?: number } }[],
  terminalId: string,
  generation: number,
): number {
  return events.filter((event) => (
    event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "server-to-browser"
      && event.frame?.binaryKind === 1
  )).length;
}

function eventSequence(event: E2ETerminalEvent): number | undefined {
  const value = event.data.sequence;
  return typeof value === "number" ? value : undefined;
}

function eventIndex(events: readonly E2ETerminalEvent[], predicate: (event: E2ETerminalEvent) => boolean, label: string): number {
  const index = events.findIndex(predicate);
  if (index < 0) throw new Error(`missing ${label} diagnostic event`);
  return index;
}

function assertControlOrdering(events: readonly E2ETerminalEvent[], generation: number): void {
  const generationEvents = events.filter((event) => event.snapshot.socketGeneration === generation);
  const open = eventIndex(generationEvents, (event) => event.type === "socket-open", `socket-open generation ${generation}`);
  const size = eventIndex(generationEvents, (event) => event.type === "size", `size generation ${generation}`);
  const sync = eventIndex(generationEvents, (event) => event.type === "sync", `sync generation ${generation}`);
  const synced = eventIndex(generationEvents, (event) => event.type === "synced", `synced generation ${generation}`);
  expect(open).toBeLessThan(size);
  expect(size).toBeLessThan(sync);
  expect(sync).toBeLessThan(synced);

  for (const event of generationEvents) {
    if (event.type !== "size" && event.type !== "sync" && event.type !== "synced") continue;
    expect(event.snapshot.pendingParserWrites, `${event.type} overtook parser writes`).toBe(0);
    expect(event.snapshot.pendingParserBytes, `${event.type} overtook parser bytes`).toBe(0);
    const target = eventSequence(event);
    if (target === undefined) continue;
    for (const preceding of generationEvents) {
      if (preceding.type !== "output-received" || preceding.id >= event.id || preceding.snapshot.syncMode === "snapshot") continue;
      const received = eventSequence(preceding);
      if (received === undefined || received > target) continue;
      const commit = generationEvents.find((candidate) => (
        candidate.type === "parser-commit"
          && candidate.id > preceding.id
          && candidate.id < event.id
          && eventSequence(candidate) === received
      ));
      expect(commit, `${event.type} overtook output sequence ${received}`).toBeDefined();
    }
  }

  const syncEvent = generationEvents.find((event) => event.type === "sync");
  if (syncEvent) {
    expect(syncEvent.snapshot.syncTarget).toBe(eventSequence(syncEvent));
  }
}


test("@nightly @O-06 @output @sync @ordering O-06 Output around sync and synced controls", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let recordingActive = false;
  try {
    await page.setViewportSize(FIXED_BROWSER_VIEWPORT);
    await page.goto("/");
    await new LoginPage(page).login();
    await recordingRequest(page, "POST", "/api/debug/recording", "clear");
    await recordingRequest(page, "POST", "/api/debug/recording", "start");
    recordingActive = true;

    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const mount = page.evaluate(async (timeout) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount", { timeout });
    }, WAIT_TIMEOUT_MS);
    await workbench.createTerminal();
    const mounted = await mount;
    const terminalId = mounted.terminalId;
    const pane = new TerminalPanePage(page, terminalId);
    await pane.expectVisible();
    await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await waitForDiagnosticEvent(page, terminalId, { type: "synced", minimumGeneration: 1 });
    const initial = await waitForSettledTerminal(page, terminalId, 1);
    expect(initial.cols).toBe(80);
    expect(initial.rows).toBe(24);
    expect(initial.serverViewport).toMatchObject({ cols: 80, rows: 24 });
    expect(initial.serverViewport?.pixelWidth).toBeGreaterThan(0);
    expect(initial.serverViewport?.pixelHeight).toBeGreaterThan(0);
    const terminalViewport = pane.xtermHost.locator(".xterm-screen");
    await expect(terminalViewport).toBeVisible();

    const token = `W${testInfo.workerIndex}-P${testInfo.parallelIndex}-R${testInfo.retry}-I${testInfo.repeatEachIndex}`;
    const readyId = `O06-READY-${token}`;
    const burstId = `O06-BURST-${token}`;
    const burstHold = `O06-BURST-HOLD-${token}`;
    const syncId = `O06-SYNC-${token}`;
    const duringId = `O06-DURING-${token}`;
    const finalId = `O06-FINAL-${token}`;
    const echoId = `O06-ECHO-${token}`;
    const inputMarker = `O06-CONTINUED-INPUT-${token}`;

    const networkFloor = faultController.events.length;
    const initialGeneration = initial.socketGeneration;
    const initialOutputFrameCount = outputFrameCount(faultController.events, terminalId, initialGeneration);

    await sendFixtureCommand(pane, `READY ${readyId}`);
    await waitForFixtureCommand(server, terminalId, `READY ${readyId}`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && field<string>(entry, "id") === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
    await page.evaluate(async ({ id, marker }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      await api.waitForTerminal(id, (snapshot) => snapshot.xterm.text.includes(marker), { timeout: 30_000 });
    }, { id: terminalId, marker: `[E2E:READY:${readyId}]` });
    const beforeHold = await waitForSettledTerminal(page, terminalId, initialGeneration);

    await sendFixtureCommand(pane, `HOLD ${burstHold}`);
    await waitForFixtureCommand(server, terminalId, `HOLD ${burstHold}`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && field<string>(entry, "token") === burstHold, { timeoutMs: WAIT_TIMEOUT_MS });
    await page.evaluate(async ({ id, marker }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      await api.waitForTerminal(id, (snapshot) => snapshot.xterm.text.includes(marker), { timeout: 30_000 });
    }, { id: terminalId, marker: `[E2E:HOLD:${burstHold}]` });
    const held = await waitForSettledTerminal(page, terminalId, initialGeneration);
    expect(held.receivedSequence).toBe(beforeHold.receivedSequence);

    await sendFixtureCommand(pane, `BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`);
    await waitForFixtureCommand(server, terminalId, `BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`);
    await sendFixtureCommand(pane, `SYNC_BEGIN ${syncId}`);
    await sendFixtureCommand(pane, `PRINT ${duringId} DURING-SYNC`);
    await sendFixtureCommand(pane, `SYNC_END ${syncId}`);

    const pendingBurstOutput = waitForDiagnosticEvent(page, terminalId, {
      type: "output-received",
      exactGeneration: initialGeneration,
      minimumSequence: held.receivedSequence ?? 0,
      requirePendingParser: true,
    });
    const burstExecuted = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "burst" && field<string>(entry, "id") === burstId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const syncBeginExecuted = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "sync_begin" && field<string>(entry, "id") === syncId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const duringExecuted = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && field<string>(entry, "id") === duringId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const syncEndExecuted = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "sync_end" && field<string>(entry, "id") === syncId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const releaseCommand = `RELEASE ${burstHold}`;
    await sendFixtureCommand(pane, releaseCommand);
    await waitForFixtureCommand(server, terminalId, releaseCommand);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && field<string>(entry, "token") === burstHold, { timeoutMs: WAIT_TIMEOUT_MS });
    const pendingEvent = await pendingBurstOutput;
    expect(pendingEvent.snapshot.pendingParserWrites).toBeGreaterThan(0);
    expect(pendingEvent.snapshot.pendingParserBytes).toBeGreaterThan(0);
    const pendingSequence = eventSequence(pendingEvent);
    expect(pendingSequence).toBeGreaterThanOrEqual(held.receivedSequence ?? 0);

    const oldSocketClose = faultController.waitFor((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
        && event.terminalId === terminalId
        && event.generation === initialGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const oldBrowserClose = waitForDiagnosticEvent(page, terminalId, {
      type: "socket-close",
      exactGeneration: initialGeneration,
    });
    const terminateRule = faultController.terminate({ terminalId, generation: initialGeneration });
    try {
      await Promise.all([oldSocketClose, oldBrowserClose]);
    } finally {
      terminateRule.dispose();
    }
    await Promise.all([burstExecuted, syncBeginExecuted, duringExecuted, syncEndExecuted]);

    const reconnectOpen = await waitForDiagnosticEvent(page, terminalId, {
      type: "socket-open",
      minimumGeneration: initialGeneration + 1,
    });
    const recoveryGeneration = reconnectOpen.snapshot.socketGeneration;
    expect(recoveryGeneration).toBeGreaterThan(initialGeneration);
    const recoverySync = await waitForDiagnosticEvent(page, terminalId, {
      type: "sync",
      exactGeneration: recoveryGeneration,
    });
    const recoverySynced = await waitForDiagnosticEvent(page, terminalId, {
      type: "synced",
      exactGeneration: recoveryGeneration,
    });
    expect(recoverySync.data.mode === "snapshot" || recoverySync.data.mode === "resume").toBe(true);
    expect(recoverySynced.snapshot.socketState).toBe("connected");
    const recovered = await waitForSettledTerminal(page, terminalId, recoveryGeneration);
    expect(recovered.activeSocketCount).toBe(1);
    expect(recovered.serverViewport).toMatchObject({ cols: 80, rows: 24 });
    expect(recovered.gridEpoch).toBeDefined();
    expect(recovered.syncMode).toBeUndefined();
    expect(recovered.syncTarget).toBeUndefined();
    expect(recovered.committedSequence).toBe(recovered.receivedSequence);

    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:PRINT:${duringId}:DURING-SYNC]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const beforeFinal = await screenshotRegion(page, terminalViewport);

    await sendFixtureCommand(pane, `PRINT ${finalId} FINAL`);
    await waitForFixtureCommand(server, terminalId, `PRINT ${finalId} FINAL`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && field<string>(entry, "id") === finalId, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:PRINT:${finalId}:FINAL]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    await expectKnownMarkerChanged(page, terminalViewport, beforeFinal, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "o-06-final-marker-crop",
    });
    await expectTerminalNonBlank(page, terminalViewport, {
      testInfo,
      artifactName: "o-06-final-terminal-crop",
    });

    await sendFixtureCommand(pane, `ECHO_INPUT ${echoId}`);
    await waitForFixtureCommand(server, terminalId, `ECHO_INPUT ${echoId}`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && field<string>(entry, "id") === echoId && field<string>(entry, "phase") === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(inputMarker, true);
    const echoPayload = await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && field<string>(entry, "id") === echoId && field<string>(entry, "phase") === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
    expect(field<string>(echoPayload, "payload_base64")).toBe(base64(inputMarker));
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:ECHO_INPUT:${echoId}:${base64(inputMarker)}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const connectedReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(connectedReport.violations).toEqual([]);
    const exitPromise = waitForDiagnosticEvent(page, terminalId, { type: "exit" });
    await sendFixtureCommand(pane, "EXIT 0");
    await waitForFixtureCommand(server, terminalId, "EXIT 0");
    await server.waitForTranscript(terminalId, (entry) => entry.event === "exit_requested" && field<number>(entry, "code") === 0, { timeoutMs: WAIT_TIMEOUT_MS });
    const exitEvent = await exitPromise;
    expect(field<number>(exitEvent.data, "exitCode")).toBe(0);
    await waitForDiagnosticEvent(page, terminalId, { type: "socket-close", minimumGeneration: recoveryGeneration });

    const finalSnapshot = await page.evaluate(async ({ id, timeout }) => {
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

    await recordingRequest(page, "POST", "/api/debug/recording", "stop");
    recordingActive = false;
    const recording = await recordingRequest(page, "GET", "/api/debug/recording/export") as DebugRecording;
    expect(recording.truncated).toBe(false);

    const transcript = await server.readTranscript(terminalId);
    const fixtureWrites = transcript.filter((entry): entry is FixtureWrite => (
      entry.event === "write"
      && typeof entry.write_sequence === "number"
      && typeof entry.bytes === "number"
      && typeof entry.data_base64 === "string"
    ));
    expect(fixtureWrites.map((entry) => entry.write_sequence)).toEqual(fixtureWrites.map((_, index) => index + 1));
    expect(fixtureWrites.every((entry) => entry.bytes === writeBytes(entry).byteLength)).toBe(true);
    const fixtureBytes = Buffer.concat(fixtureWrites.map(writeBytes));
    const burstEntries = transcript.filter((entry) => entry.event === "burst" && field<string>(entry, "id") === burstId);
    expect(burstEntries).toHaveLength(1);
    expect(field<number>(burstEntries[0]!, "bytes")).toBe(BURST_BYTES);

    const outputEvents = outputRecords(recording, terminalId);
    expect(outputEvents.length).toBeGreaterThan(0);
    const outputBase = initial.receivedSequence ?? 0;
    for (const output of outputEvents) {
      const sequence = output.sequence!;
      const bytes = Buffer.from(output.data!, "base64");
      const offset = sequence - outputBase;
      expect(Number.isSafeInteger(offset)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset + bytes.byteLength).toBeLessThanOrEqual(fixtureBytes.byteLength);
      expect(fixtureBytes.subarray(offset, offset + bytes.byteLength)).toEqual(bytes);
    }
    const snapshotEvents = recording.events.filter((event) => (
      event.terminal === terminalId
        && event.type === "snapshot"
        && typeof event.sequence === "number"
        && typeof event.data === "string"
    ));
    for (const snapshot of snapshotEvents) {
      expect(snapshot.sequence!).toBeGreaterThanOrEqual(outputBase);
      expect(snapshot.sequence!).toBeLessThanOrEqual(outputBase + fixtureBytes.byteLength);
      expect(Buffer.from(snapshot.data!, "base64").byteLength).toBeGreaterThan(0);
    }

    const serverSyncControls = controlRecords(recording, terminalId, "sync");
    const serverSyncedControls = controlRecords(recording, terminalId, "synced");
    expect(serverSyncControls).toHaveLength(2);
    expect(serverSyncedControls).toHaveLength(2);
    const browserEvents = await terminalEvents(page, terminalId);
    const browserSyncEvents = browserEvents.filter((event) => event.type === "sync");
    const browserSyncedEvents = browserEvents.filter((event) => event.type === "synced");
    expect(browserSyncEvents).toHaveLength(serverSyncControls.length);
    expect(browserSyncedEvents).toHaveLength(serverSyncedControls.length);
    expect(serverSyncControls.map((event) => event.message?.sequence)).toEqual(browserSyncEvents.map((event) => event.data.sequence));
    expect(serverSyncedControls.map((event) => event.message?.sequence)).toEqual(browserSyncedEvents.map((event) => event.data.sequence));
    for (const sync of serverSyncControls) {
      expect(sync.message?.mode === "snapshot" || sync.message?.mode === "resume").toBe(true);
      expect(typeof sync.message?.sequence).toBe("number");
      expect(sync.message!.sequence as number).toBeLessThanOrEqual(outputBase + fixtureBytes.byteLength);
    }
    for (const synced of serverSyncedControls) {
      expect(typeof synced.message?.sequence).toBe("number");
      expect(synced.message!.sequence as number).toBeLessThanOrEqual(outputBase + fixtureBytes.byteLength);
    }

    const generations = browserEvents.filter((event) => event.type === "socket-open").map((event) => event.snapshot.socketGeneration);
    expect(generations).toEqual([initialGeneration, recoveryGeneration]);
    for (const generation of generations) assertControlOrdering(browserEvents, generation);
    await assertMonotonicSequences(browserEvents);
    expect(browserEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(browserEvents.filter((event) => event.type === "socket-stale")).toEqual([]);
    expect(browserEvents.some((event) => event.type === "state" && ["recovering", "disconnected"].includes(String(event.data.state)))).toBe(true);
    expect(browserEvents.filter((event) => event.id > recoverySynced.id && event.type === "state" && ["recovering", "disconnected"].includes(String(event.data.state)))).toEqual([]);

    const oldGenerationClose = browserEvents.find((event) => event.type === "socket-close" && event.snapshot.socketGeneration === initialGeneration);
    expect(oldGenerationClose).toBeDefined();
    expect(oldGenerationClose?.snapshot.pendingParserWrites).toBeGreaterThan(0);
    expect(oldGenerationClose?.snapshot.pendingParserBytes).toBeGreaterThan(0);
    const recoverySnapshotStarts = browserEvents.filter((event) => event.type === "sync" && event.snapshot.socketGeneration === recoveryGeneration && event.data.mode === "snapshot");
    expect(recoverySnapshotStarts.length).toBeLessThanOrEqual(1);
    if (recoverySync.data.mode === "snapshot") expect(recoverySnapshotStarts).toHaveLength(1);

    const proxyEvents = faultController.events.slice(networkFloor).filter((event) => event.terminalId === terminalId);
    expect(proxyEvents.filter((event) => event.type === "connection-open")).toHaveLength(2);
    expect(proxyEvents.filter((event) => event.type === "connection-closed" || event.type === "connection-terminated")).toHaveLength(1);
    expect(proxyEvents.filter((event) => event.type === "socket-error" || event.type === "malformed-frame" || event.type === "injected")).toEqual([]);
    expect(outputFrameCount(faultController.events, terminalId, initialGeneration)).toBeGreaterThan(initialOutputFrameCount);
    expect(outputFrameCount(faultController.events, terminalId, recoveryGeneration)).toBeGreaterThan(0);

    const model = new HeadlessTerminal({
      cols: initial.cols,
      rows: initial.rows,
      scrollback: 200_000,
      allowProposedApi: true,
      ...tuiCompatibilityOptions(),
    });
    for (const entry of fixtureWrites) await writeHeadless(model, writeBytes(entry));
    const modelText = headlessText(model);
    expect(finalSnapshot.xterm.activeBuffer).toBe(model.buffer.active.type);
    expect(finalSnapshot.xterm.cursorX).toBe(model.buffer.active.cursorX);
    expect(finalSnapshot.xterm.cursorY).toBe(model.buffer.active.cursorY);
    expect(finalSnapshot.xterm.viewportY).toBe(model.buffer.active.viewportY);
    expect(finalSnapshot.xterm.text).toBe(modelText);
    expect(finalSnapshot.xterm.selectionText).toBe("");
    expect(countOccurrences(finalSnapshot.xterm.text, `[E2E:PRINT:${duringId}:DURING-SYNC]`)).toBe(1);
    expect(countOccurrences(finalSnapshot.xterm.text, `[E2E:PRINT:${finalId}:FINAL]`)).toBe(1);
    expect(countOccurrences(finalSnapshot.xterm.text, `[E2E:ECHO_INPUT:${echoId}:${base64(inputMarker)}]`)).toBe(1);
    model.dispose();

    expect(transcript.filter((entry) => entry.event === "sync_begin" && field<string>(entry, "id") === syncId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "sync_end" && field<string>(entry, "id") === syncId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && field<string>(entry, "id") === duringId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && field<string>(entry, "id") === finalId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && field<string>(entry, "id") === echoId && field<string>(entry, "phase") === "payload")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);

    const finalReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(finalReport.violations).toEqual([]);
    expect(finalReport.snapshot.socketState).toBe("exited");
    expect(finalReport.snapshot.activeSocketCount).toBe(0);
    expect(finalReport.snapshot.pendingParserWrites).toBe(0);
    expect(finalReport.snapshot.pendingParserBytes).toBe(0);
    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
        || entry.kind === "requestfailed"
        || (entry.kind === "console" && /^error:/i.test(entry.message))
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  } finally {
    if (recordingActive) {
      await recordingRequest(page, "POST", "/api/debug/recording", "stop");
    }
    browserErrors.dispose();
  }
});
