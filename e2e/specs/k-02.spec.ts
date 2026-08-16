import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import { test, expect, type IsolatedServer } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const EVENT_TIMEOUT_MS = 60_000;
const CHECKPOINT_MAX_INTERVAL_MS = 5_000;
const CHECKPOINT_INTERVAL_TOLERANCE_MS = 1_000;
const CHECKPOINT_CHUNK_BYTES = 32 * 1024;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const BURST_BYTES = 4 * 1024 * 1024;
const BURST_LINE_WIDTH = 256;
const SERVER_TO_BROWSER_BYTES_PER_SECOND = 256 * 1024;

type WaitEventKind = "output-received" | "parser-commit" | "render" | "checkpoint";

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

interface CreatedTerminal {
  readonly id: string;
  readonly name: string;
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]\n`;
}

function eventNumber(event: E2ETerminalEvent, key: string): number | undefined {
  const value = event.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lastEventId(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.id), -1);
}

async function createFixtureTerminal(page: Page, path: string, shell: string): Promise<CreatedTerminal> {
  return page.evaluate(async ({ path: terminalPath, shell: fixtureShell }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: terminalPath, cwd: "/tmp", shell: fixtureShell }),
    });
    if (!response.ok) throw new Error(`terminal creation failed with HTTP ${response.status}`);
    const payload = await response.json() as { id?: unknown; name?: unknown };
    if (typeof payload.id !== "string" || typeof payload.name !== "string") {
      throw new Error("terminal creation response is missing id or name");
    }
    return { id: payload.id, name: payload.name };
  }, { path, shell });
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  kind: WaitEventKind,
  minimumSequence?: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventKind, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.id <= after || event.type !== eventKind) return false;
      if (eventKind === "checkpoint") {
        if (event.data.result !== "sent") return false;
      }
      if (minimum === undefined) return true;
      const sequence = event.data.sequence;
      return typeof sequence === "number" && sequence >= minimum;
    }, { timeout, afterId: after });
  }, {
    id: terminalId,
    after: afterEventId,
    eventKind: kind,
    minimum: minimumSequence,
    timeout: EVENT_TIMEOUT_MS,
  });
}

async function waitForSettledSequence(
  page: Page,
  terminalId: string,
  minimumSequence: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimum, timeout }) => {
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
      && snapshot.committedSequence !== undefined
      && snapshot.receivedSequence >= minimum
      && snapshot.committedSequence === snapshot.receivedSequence
    ), { timeout });
  }, { id: terminalId, minimum: minimumSequence, timeout: EVENT_TIMEOUT_MS });
}

function transcriptWriteBytes(entries: readonly Record<string, unknown>[]): number {
  return entries.reduce((total, entry) => {
    if (entry.event !== "write" || typeof entry.bytes !== "number" || !Number.isFinite(entry.bytes)) return total;
    return total + entry.bytes;
  }, 0);
}

function assertCheckpointTelemetry(event: E2ETerminalEvent, expectedEpoch: number): void {
  expect(event.type).toBe("checkpoint");
  expect(event.data.result).toBe("sent");
  const sequence = eventNumber(event, "sequence");
  const epoch = eventNumber(event, "epoch");
  const size = eventNumber(event, "size");
  const chunks = eventNumber(event, "chunks");
  const serializationDuration = eventNumber(event, "serializationDurationMs");
  const uploadDuration = eventNumber(event, "uploadDurationMs");
  expect(sequence).toBeDefined();
  expect(epoch).toBe(expectedEpoch);
  expect(size).toBeGreaterThan(0);
  expect(size).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
  expect(chunks).toBe(Math.ceil((size ?? 0) / CHECKPOINT_CHUNK_BYTES));
  expect(serializationDuration).toBeGreaterThanOrEqual(0);
  expect(uploadDuration).toBeGreaterThanOrEqual(0);
  expect(event.snapshot.checkpointSequence).toBe(sequence);
  expect(event.snapshot.checkpointEpoch).toBe(expectedEpoch);
  expect(event.snapshot.committedSequence).toBeGreaterThanOrEqual(sequence ?? 0);
}

function assertNoOverlappingSerialization(events: readonly E2ETerminalEvent[]): void {
  const sent = events
    .filter((event) => event.type === "checkpoint" && event.data.result === "sent")
    .sort((left, right) => left.id - right.id);
  for (let index = 1; index < sent.length; index += 1) {
    const previous = sent[index - 1]!;
    const current = sent[index]!;
    const previousSerialization = eventNumber(previous, "serializationDurationMs") ?? 0;
    const previousUpload = eventNumber(previous, "uploadDurationMs") ?? 0;
    const currentSerialization = eventNumber(current, "serializationDurationMs") ?? 0;
    const currentUpload = eventNumber(current, "uploadDurationMs") ?? 0;
    const previousEnd = previous.timestamp;
    const currentStart = current.timestamp - currentSerialization - currentUpload;
    expect(Number.isFinite(currentStart)).toBe(true);
    expect(currentStart).toBeGreaterThanOrEqual(previousEnd - 5);
    expect(currentSerialization + currentUpload).toBeGreaterThanOrEqual(0);
    expect(previousSerialization + previousUpload).toBeGreaterThanOrEqual(0);
  }
}

async function waitForTranscriptEntry(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: Record<string, unknown>, entries: readonly Record<string, unknown>[]) => boolean,
): Promise<Record<string, unknown>> {
  return server.waitForTranscript(terminalId, predicate, { timeoutMs: EVENT_TIMEOUT_MS });
}

test("@p1 @checkpoint @checkpoint-max @streaming @nightly K-02 Continuous-output maximum interval", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const token = `${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}-${Date.now()}`;
  const terminalPath = `k-02-${token}`;
  const readyId = `K02-READY-${token}`;
  const sizeId = `K02-SIZE-${token}`;
  const preId = `K02-PRE-${token}`;
  const burstId = `K02-BURST-${token}`;
  const holdToken = `K02-HOLD-${token}`;
  const finalId = `K02-FINAL-${token}`;
  const finalText = `K02-FINAL-TEXT-${token}`;
  const echoId = `K02-ECHO-${token}`;
  const echoPayload = `K02-CONTINUED-INPUT-${token}`;

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const created = await createFixtureTerminal(page, terminalPath, server.fixturePath);
  await page.reload();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const pane = await workbench.openTerminal({ id: created.id, name: created.name });
  await pane.expectVisible();
  await pane.expectConnected();
  await pane.waitForSynchronized({ timeout: EVENT_TIMEOUT_MS });

  const initial = await pane.snapshot();
  if (!initial) throw new Error(`no diagnostics snapshot for terminal ${created.id}`);
  expect(initial.flowControlled).toBe(true);
  expect(initial.socketState).toBe("connected");
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.acceptingInput).toBe(true);
  expect(initial.gridEpoch).toBeDefined();
  const initialEpoch = initial.gridEpoch!;
  const initialGeneration = initial.socketGeneration;

  await pane.sendInput(`READY ${readyId}`, true);
  await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "ready" && entry.id === readyId);
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const ptySize = await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "size" && entry.id === sizeId);
  expect(ptySize.rows).toBe(initial.rows);
  expect(ptySize.cols).toBe(initial.cols);

  const terminalViewport = pane.xtermHost.locator(".xterm-screen");
  await expect(terminalViewport).toBeVisible();
  const beforePrePixels = await screenshotRegion(page, terminalViewport);
  const beforePreEvents = await terminalEvents(page, created.id);
  const beforePreEventId = lastEventId(beforePreEvents);
  const preCommitPromise = waitForEventAfter(page, created.id, beforePreEventId, "parser-commit");
  const preRenderPromise = waitForEventAfter(page, created.id, beforePreEventId, "render");
  const preCheckpointPromise = waitForEventAfter(page, created.id, beforePreEventId, "checkpoint");
  await pane.sendInput(`PRINT ${preId} ${preId}`, true);
  await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "print" && entry.id === preId);
  await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "write" && entry.text === marker("PRINT", preId, preId));
  const preCommit = await preCommitPromise;
  await preRenderPromise;
  await expectTerminalBuffer(page, created.id, { contains: marker("PRINT", preId, preId).trimEnd(), occurrences: 1 }, { timeout: EVENT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, terminalViewport, beforePrePixels, {
    minimumChangedRatio: 0.0002,
    testInfo,
    artifactName: "k-02-pre-marker",
  });
  const baselineCheckpoint = await preCheckpointPromise;
  assertCheckpointTelemetry(baselineCheckpoint, initialEpoch);
  const baselineSequence = eventNumber(baselineCheckpoint, "sequence");
  if (baselineSequence === undefined) throw new Error("baseline checkpoint did not report a sequence");
  const preCommitSequence = eventNumber(preCommit, "sequence");
  if (preCommitSequence === undefined) throw new Error("parser commit did not report a sequence");
  expect(baselineSequence).toBeLessThanOrEqual(preCommitSequence);

  const baselineSnapshot = await pane.snapshot();
  if (!baselineSnapshot) throw new Error(`diagnostics snapshot disappeared for terminal ${created.id}`);
  expect(baselineSnapshot.gridEpoch).toBe(initialEpoch);
  expect(baselineSnapshot.committedSequence).toBeGreaterThanOrEqual(baselineSequence);
  const baselineTranscript = await server.readTranscript(created.id);
  expect(baselineSnapshot.committedSequence).toBe(transcriptWriteBytes(baselineTranscript));

  const throttle = faultController.throttle(
    "server-to-browser",
    SERVER_TO_BROWSER_BYTES_PER_SECOND,
    { terminalId: created.id, generation: initialGeneration },
  );
  const beforeBurstEvents = await terminalEvents(page, created.id);
  const beforeBurstEventId = lastEventId(beforeBurstEvents);
  const firstReceivedPromise = waitForEventAfter(page, created.id, beforeBurstEventId, "output-received", baselineSequence + 1);
  const firstCommitPromise = waitForEventAfter(page, created.id, beforeBurstEventId, "parser-commit", baselineSequence + 1);
  const burstCommand = `BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`;
  await pane.sendInput(burstCommand, true);
  await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES);
  await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "write" && entry.bytes === BURST_BYTES);
  await pane.sendInput(`HOLD ${holdToken}`, true);
  await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "hold" && entry.token === holdToken);

  const firstReceived = await firstReceivedPromise;
  const firstCommit = await firstCommitPromise;
  const firstCommitSequence = eventNumber(firstCommit, "sequence");
  expect(firstCommitSequence).toBeGreaterThanOrEqual(baselineSequence + 1);
  expect(firstCommit.timestamp).toBeGreaterThanOrEqual(firstReceived.timestamp);

  const firstMax = await waitForEventAfter(page, created.id, baselineCheckpoint.id, "checkpoint", baselineSequence + 1);
  assertCheckpointTelemetry(firstMax, initialEpoch);
  const firstMaxSequence = eventNumber(firstMax, "sequence");
  if (firstMaxSequence === undefined) throw new Error("maximum checkpoint did not report a sequence");
  const firstInterval = firstMax.timestamp - firstCommit.timestamp;
  expect(firstInterval).toBeGreaterThanOrEqual(CHECKPOINT_MAX_INTERVAL_MS - CHECKPOINT_INTERVAL_TOLERANCE_MS);
  expect(firstInterval).toBeLessThanOrEqual(CHECKPOINT_MAX_INTERVAL_MS + CHECKPOINT_INTERVAL_TOLERANCE_MS);

  const checkpointAnnouncementPromise = faultController.waitFor((event) => (
    event.type === "frame"
    && event.terminalId === created.id
    && event.generation === initialGeneration
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpointBinary"
    && event.at >= firstCommit.timestamp
  ), { timeoutMs: EVENT_TIMEOUT_MS });
  const secondMax = await waitForEventAfter(page, created.id, firstMax.id, "checkpoint", firstMaxSequence + 1);
  assertCheckpointTelemetry(secondMax, initialEpoch);
  const secondMaxSequence = eventNumber(secondMax, "sequence");
  if (secondMaxSequence === undefined) throw new Error("second maximum checkpoint did not report a sequence");
  const secondInterval = secondMax.timestamp - firstMax.timestamp;
  expect(secondInterval).toBeGreaterThanOrEqual(CHECKPOINT_MAX_INTERVAL_MS - CHECKPOINT_INTERVAL_TOLERANCE_MS);
  expect(secondInterval).toBeLessThanOrEqual(CHECKPOINT_MAX_INTERVAL_MS + CHECKPOINT_INTERVAL_TOLERANCE_MS);
  const firstCheckpointAnnouncement = await checkpointAnnouncementPromise;
  expect(firstCheckpointAnnouncement.frame?.jsonType).toBe("checkpointBinary");

  const checkpointEvents = (await terminalEvents(page, created.id)).filter((event) => event.type === "checkpoint");
  expect(checkpointEvents.filter((event) => event.data.result === "sent").length).toBeGreaterThanOrEqual(3);
  assertNoOverlappingSerialization(checkpointEvents);
  expect(secondMaxSequence).toBeGreaterThan(firstMaxSequence);
  expect(firstMax.snapshot.committedSequence).toBeGreaterThanOrEqual(firstMaxSequence);
  expect(secondMax.snapshot.committedSequence).toBeGreaterThanOrEqual(secondMaxSequence);

  await pane.sendInput(`RELEASE ${holdToken}`, true);
  await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "release" && entry.token === holdToken);
  const afterBurst = await waitForSettledSequence(page, created.id, baselineSequence + BURST_BYTES);
  throttle.dispose();

  const afterBurstTranscript = await server.readTranscript(created.id);
  const emittedAfterBurst = transcriptWriteBytes(afterBurstTranscript);
  expect(afterBurst.committedSequence).toBe(emittedAfterBurst);
  expect(afterBurst.receivedSequence).toBe(emittedAfterBurst);
  expect(afterBurst.gridEpoch).toBe(initialEpoch);
  expect(afterBurst.serverViewport?.cols).toBe(initial.cols);
  expect(afterBurst.serverViewport?.rows).toBe(initial.rows);
  expect(afterBurst.cols).toBe(initial.cols);
  expect(afterBurst.rows).toBe(initial.rows);

  const beforeFinalPixels = await screenshotRegion(page, terminalViewport);
  const beforeFinalEvents = await terminalEvents(page, created.id);
  const beforeFinalEventId = lastEventId(beforeFinalEvents);
  const finalRenderPromise = waitForEventAfter(page, created.id, beforeFinalEventId, "render");
  await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
  await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText);
  await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "write" && entry.text === marker("PRINT", finalId, finalText));
  await expectTerminalBuffer(page, created.id, { contains: marker("PRINT", finalId, finalText).trimEnd(), occurrences: 1 }, { timeout: EVENT_TIMEOUT_MS });
  await finalRenderPromise;
  await expectKnownMarkerChanged(page, terminalViewport, beforeFinalPixels, {
    minimumChangedRatio: 0.0002,
    testInfo,
    artifactName: "k-02-final-marker",
  });
  await expectTerminalNonBlank(page, terminalViewport, {
    minimumNonBackgroundRatio: 0.001,
    testInfo,
    artifactName: "k-02-final-terminal",
  });

  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await waitForTranscriptEntry(server, created.id, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed");
  await pane.sendInput(echoPayload, true);
  const echo = await waitForTranscriptEntry(server, created.id, (entry) => (
    entry.event === "echo_input"
    && entry.id === echoId
    && entry.phase === "payload"
    && entry.payload_base64 === Buffer.from(echoPayload, "utf8").toString("base64")
  ));
  expect(echo.payload_base64).toBe(Buffer.from(echoPayload, "utf8").toString("base64"));
  await expectTerminalBuffer(page, created.id, {
    contains: marker("ECHO_INPUT", echoId, Buffer.from(echoPayload, "utf8").toString("base64")).trimEnd(),
    occurrences: 1,
  }, { timeout: EVENT_TIMEOUT_MS });

  const finalTranscript = await server.readTranscript(created.id);
  const finalSnapshot = await waitForSettledSequence(page, created.id, transcriptWriteBytes(finalTranscript));
  expect(finalSnapshot.committedSequence).toBe(transcriptWriteBytes(finalTranscript));
  expect(finalSnapshot.receivedSequence).toBe(finalSnapshot.committedSequence);
  expect(finalSnapshot.socketGeneration).toBe(initialGeneration);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(finalSnapshot.syncTarget === undefined || finalSnapshot.committedSequence === undefined || finalSnapshot.committedSequence >= finalSnapshot.syncTarget).toBe(true);
  expect(finalSnapshot.gridEpoch).toBe(initialEpoch);

  const transcript = finalTranscript;
  expect(transcript.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === preId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === finalId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);

  // Checkpoint uploads are one `checkpointBinary` announcement followed by
  // binary body frames (kind byte 2); only the body frames are chunks.
  const checkpointBodyFrames = faultController.events.filter((event) => (
    event.type === "frame"
    && event.terminalId === created.id
    && event.generation === initialGeneration
    && event.direction === "browser-to-server"
    && event.frame?.binaryKind === 2
  ));
  const firstChunks = eventNumber(firstMax, "chunks") ?? 0;
  const secondChunks = eventNumber(secondMax, "chunks") ?? 0;
  expect(checkpointBodyFrames.length).toBeGreaterThanOrEqual(firstChunks + secondChunks);
  expect(faultController.events.filter((event) => event.type === "malformed-frame" || event.type === "socket-error")).toHaveLength(0);

  const events = await terminalEvents(page, created.id);
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "state" && ["disconnected", "recovering"].includes(String(event.data.state)))).toHaveLength(0);
  await expectNoPendingRecovery(page, created.id, { timeout: EVENT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, created.id, { timeout: EVENT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
});
