import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultController, NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 45_000;
const REPAINT_BYTES = 1_500_000;
const LONG_UPGRADE_DELAY_MS = 1_500;
const EVENT_LOOP_BUDGET_MS = 1_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type FlapKind = "short-abrupt" | "short-before-timer" | "long-drop" | "open-before-synced";

type ReconnectInterval = {
  readonly label: string;
  readonly close: E2ETerminalEvent;
  readonly created: E2ETerminalEvent;
  readonly attempt: number;
};

type FlapResult = {
  readonly finalSnapshot: E2ETerminalSnapshot;
  readonly finalSynced: E2ETerminalEvent;
  readonly intervals: readonly ReconnectInterval[];
  readonly closedGenerations: readonly number[];
};

function eventGeneration(event: E2ETerminalEvent): number | undefined {
  const generation = event.data.generation;
  return typeof generation === "number" ? generation : event.snapshot.socketGeneration;
}

function outputByteCount(entries: readonly Record<string, unknown>[]): number {
  return entries.reduce((total, entry) => {
    if (entry.event !== "write") return total;
    const bytes = entry.bytes;
    return total + (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0);
  }, 0);
}

function countEntries(
  entries: readonly Record<string, unknown>[],
  predicate: (entry: Record<string, unknown>) => boolean,
): number {
  return entries.reduce((count, entry) => count + (predicate(entry) ? 1 : 0), 0);
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEventType,
  options: {
    readonly generation?: number;
    readonly state?: string;
  } = {},
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, type, generation, state, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.id <= after || event.type !== type) return false;
      if (generation !== undefined) {
        const eventGeneration = typeof event.data.generation === "number"
          ? event.data.generation
          : event.snapshot.socketGeneration;
        if (eventGeneration !== generation) return false;
      }
      return state === undefined || event.data.state === state;
    }, { timeout });
  }, {
    id: terminalId,
    after: afterEventId,
    type,
    ...options,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForProxyEvent(
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
  type: NetworkFaultEvent["type"],
  direction?: NetworkFaultEvent["direction"],
): Promise<NetworkFaultEvent> {
  return faultController.waitFor((event) => (
    event.type === type
    && event.terminalId === terminalId
    && event.generation === generation
    && (direction === undefined || event.direction === direction)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

async function snapshotOrThrow(page: Page, terminalId: string, label: string): Promise<E2ETerminalSnapshot> {
  const snapshot = await terminalSnapshot(page, terminalId);
  if (!snapshot) throw new Error(`missing diagnostics snapshot for ${label} (${terminalId})`);
  return snapshot;
}

function assertSocketBoundary(snapshot: E2ETerminalSnapshot, label: string): void {
  expect(snapshot.activeSocketCount, `${label}: more than one active pane socket`).toBeLessThanOrEqual(1);
  expect(snapshot.socket.activeCount, `${label}: more than one diagnostic socket`).toBeLessThanOrEqual(1);
  expect(snapshot.pendingParserWrites, `${label}: negative parser-write count`).toBeGreaterThanOrEqual(0);
  expect(snapshot.pendingParserBytes, `${label}: negative parser-byte count`).toBeGreaterThanOrEqual(0);
}

function assertReconnectInterval(interval: ReconnectInterval): void {
  const elapsed = Math.max(0, interval.created.timestamp - interval.close.timestamp);
  const boundedDelay = Math.min(5_000, 250 * 2 ** interval.attempt);
  // The browser timer is checked from lifecycle events; allow event-loop dispatch
  // time without weakening the source backoff bound or adding a test sleep.
  expect(
    elapsed,
    `${interval.label}: reconnect timer exceeded min(5000, 250*2**attempts)`,
  ).toBeLessThanOrEqual(boundedDelay + EVENT_LOOP_BUDGET_MS);
}

async function assertStaleGenerationIgnored(
  page: Page,
  terminalId: string,
  currentGeneration: number,
  staleGeneration: number,
  afterEventId: number,
  expected: E2ETerminalSnapshot,
): Promise<E2ETerminalEvent> {
  await page.evaluate(({ id, generation, staleGeneration, expectedEpoch, expectedCols, expectedRows }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.deliverStaleEvent(id, {
      generation: staleGeneration,
      type: "message",
      data: JSON.stringify({
        type: "size",
        epoch: expectedEpoch ?? 0,
        cols: expectedCols,
        rows: expectedRows,
        focused: false,
        controller: true,
        responder: true,
      }),
    });
    api.controls.socket.deliverStaleEvent(id, {
      generation: staleGeneration,
      type: "close",
      code: 1006,
      reason: `C-07 stale generation ${generation}`,
    });
  }, {
    id: terminalId,
    generation: currentGeneration,
    staleGeneration,
    expectedEpoch: expected.gridEpoch,
    expectedCols: expected.cols,
    expectedRows: expected.rows,
  });
  const stale = await waitForDiagnosticEventAfter(
    page,
    terminalId,
    afterEventId,
    "socket-stale",
    { generation: staleGeneration },
  );
  const stable = await page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration === generation
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
    ), { timeout });
  }, { id: terminalId, generation: currentGeneration, timeout: WAIT_TIMEOUT_MS });
  expect(stable.cols, "stale socket changed the current columns").toBe(expected.cols);
  expect(stable.rows, "stale socket changed the current rows").toBe(expected.rows);
  expect(stable.serverViewport?.cols, "stale socket changed server columns").toBe(expected.serverViewport?.cols);
  expect(stable.serverViewport?.rows, "stale socket changed server rows").toBe(expected.serverViewport?.rows);
  return stale;
}

async function runSimpleFlap(
  page: Page,
  pane: TerminalPanePage,
  terminalId: string,
  faultController: NetworkFaultController,
  kind: Exclude<FlapKind, "open-before-synced">,
  label: string,
  afterEventId: number,
  current: E2ETerminalSnapshot,
): Promise<FlapResult> {
  const previousGeneration = current.socketGeneration;
  const nextGeneration = previousGeneration + 1;
  const closeEvent = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "socket-close", { generation: previousGeneration });
  const createdEvent = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "socket-created", { generation: nextGeneration });
  const syncedEvent = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "synced", { generation: nextGeneration });
  const disconnected = kind === "long-drop"
    ? waitForDiagnosticEventAfter(page, terminalId, afterEventId, "state", { generation: previousGeneration, state: "disconnected" })
    : undefined;
  const proxyEnd = faultController.waitFor((event) => (
    (event.type === "connection-terminated" || event.type === "connection-closed")
    && event.terminalId === terminalId
    && event.generation === previousGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  let dropFault: (() => void) | undefined;
  let delayFault: (() => void) | undefined;
  let delayedUpgrade: Promise<NetworkFaultEvent> | undefined;
  if (kind === "short-before-timer") {
    const droppedBrowser = waitForProxyEvent(faultController, terminalId, previousGeneration, "dropped", "browser-to-server");
    const droppedServer = waitForProxyEvent(faultController, terminalId, previousGeneration, "dropped", "server-to-browser");
    dropFault = faultController.drop({ terminalId, generation: previousGeneration });
    await Promise.all([droppedBrowser, droppedServer]);
    const restoredBrowser = waitForProxyEvent(faultController, terminalId, previousGeneration, "restored", "browser-to-server");
    const restoredServer = waitForProxyEvent(faultController, terminalId, previousGeneration, "restored", "server-to-browser");
    faultController.restore({ terminalId, generation: previousGeneration });
    await Promise.all([restoredBrowser, restoredServer]);
    dropFault?.();
  } else if (kind === "long-drop") {
    const droppedBrowser = waitForProxyEvent(faultController, terminalId, previousGeneration, "dropped", "browser-to-server");
    const droppedServer = waitForProxyEvent(faultController, terminalId, previousGeneration, "dropped", "server-to-browser");
    dropFault = faultController.drop({ terminalId, generation: previousGeneration });
    await Promise.all([droppedBrowser, droppedServer]);
    delayedUpgrade = waitForProxyEvent(faultController, terminalId, nextGeneration, "upgrade-delay");
    delayFault = faultController.delayUpgrade({ terminalId, generation: nextGeneration }, LONG_UPGRADE_DELAY_MS);
  }

  const fault = kind === "short-before-timer"
    ? faultController.close({ matcher: { terminalId, generation: previousGeneration }, code: 1001, reason: "C-07 short restore" })
    : faultController.terminate({ terminalId, generation: previousGeneration });
  const [closed, created] = await Promise.all([closeEvent, createdEvent, proxyEnd]);
  if (disconnected) await disconnected;
  fault.dispose();
  dropFault?.();
  const delayed = delayedUpgrade ? await delayedUpgrade : undefined;
  if (delayed !== undefined) expect(delayed.bytes).toBe(LONG_UPGRADE_DELAY_MS);
  delayFault?.();
  const synced = await syncedEvent;
  const finalSnapshot = await snapshotOrThrow(page, terminalId, `${label} recovery`);
  await pane.waitForConnected({ timeout: WAIT_TIMEOUT_MS });
  const intervals: ReconnectInterval[] = [{ label, close: closed, created, attempt: 1 }];
  const firstInterval = intervals[0];
  if (!firstInterval) throw new Error(`${label}: reconnect interval was not recorded`);
  assertReconnectInterval(firstInterval);
  return {
    finalSnapshot,
    finalSynced: synced,
    intervals,
    closedGenerations: [previousGeneration],
  };
}

async function runOpenBeforeSyncedFlap(
  page: Page,
  pane: TerminalPanePage,
  terminalId: string,
  faultController: NetworkFaultController,
  label: string,
  afterEventId: number,
  current: E2ETerminalSnapshot,
): Promise<FlapResult> {
  const previousGeneration = current.socketGeneration;
  const interruptedGeneration = previousGeneration + 1;
  const finalGeneration = previousGeneration + 2;
  const pause = faultController.pause("server-to-browser", { terminalId, generation: interruptedGeneration });
  const paused = waitForProxyEvent(faultController, terminalId, interruptedGeneration, "paused", "server-to-browser");
  const previousClose = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "socket-close", { generation: previousGeneration });
  const previousCreated = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "socket-created", { generation: interruptedGeneration });
  const previousOpen = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "socket-open", { generation: interruptedGeneration });
  const previousProxyEnd = faultController.waitFor((event) => (
    event.type === "connection-terminated"
    && event.terminalId === terminalId
    && event.generation === previousGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const firstFault = faultController.terminate({ terminalId, generation: previousGeneration });
  const [closed, created] = await Promise.all([
    previousClose,
    previousCreated,
    previousOpen,
    previousProxyEnd,
  ]);
  const openedEvents = await terminalEvents(page, terminalId);
  expect(openedEvents.some((event) => event.type === "synced" && event.snapshot.socketGeneration === interruptedGeneration)).toBe(false);

  const interruptedClose = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "socket-close", { generation: interruptedGeneration });
  const interruptedProxyEnd = faultController.waitFor((event) => (
    event.type === "connection-terminated"
    && event.terminalId === terminalId
    && event.generation === interruptedGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const finalCreated = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "socket-created", { generation: finalGeneration });
  const finalSynced = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "synced", { generation: finalGeneration });
  const secondFault = faultController.terminate({ terminalId, generation: interruptedGeneration });
  const [interruptedClosed, interruptedProxyClosed] = await Promise.all([interruptedClose, interruptedProxyEnd]);
  firstFault.dispose();
  secondFault.dispose();
  pause.dispose();
  const [finalSocketCreated, synced] = await Promise.all([finalCreated, finalSynced]);
  const finalSnapshot = await snapshotOrThrow(page, terminalId, `${label} recovery`);
  await pane.waitForConnected({ timeout: WAIT_TIMEOUT_MS });
  assertSocketBoundary(finalSnapshot, `${label} recovery`);
  const intervals: ReconnectInterval[] = [
    { label: `${label} first reconnect`, close: closed, created, attempt: 1 },
    { label: `${label} second reconnect`, close: interruptedClosed, created: finalSocketCreated, attempt: 2 },
  ];
  for (const interval of intervals) assertReconnectInterval(interval);
  return {
    finalSnapshot,
    finalSynced: synced,
    intervals,
    closedGenerations: [previousGeneration, interruptedGeneration],
  };
}

test("C-07 Repeated network flap @p1 @nightly", async ({ page, server, faultController, baseURL }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `C007-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-ready`;
  const altId = `${runTag}-alt`;
  const repaintId = `${runTag}-repaint`;
  const finalId = `${runTag}-final`;
  const finalText = `${runTag}-final-marker`;
  const sizeId = `${runTag}-size`;
  const inputId = `${runTag}-input`;
  const inputText = `${runTag}-continued-input`;
  const inputBase64 = Buffer.from(inputText, "utf8").toString("base64");
  const flapMarkers = Array.from({ length: 6 }, (_, index) => ({
    id: `${runTag}-flap-${index + 1}`,
    text: `${runTag}-flap-${index + 1}`,
  }));

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const mounted = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount" && event.snapshot.kind === "pane", { timeout });
  }, WAIT_TIMEOUT_MS);
  await workbench.createTerminal();
  const mountedEvent = await mounted;
  const terminalId = mountedEvent.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`ALT_ENTER ${altId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "alt_enter" && entry.id === altId, { timeoutMs: WAIT_TIMEOUT_MS });

  const initial = await snapshotOrThrow(page, terminalId, "initial synchronization");
  const initialViewport = initial.serverViewport;
  if (!initialViewport) throw new Error("initial terminal did not expose a server viewport");
  expect(initial.socketState).toBe("connected");
  expect(initial.acceptingInput).toBe(true);
  expect(initial.gridEpoch).toEqual(expect.any(Number));
  assertSocketBoundary(initial, "initial synchronization");
  const initialEvents = await terminalEvents(page, terminalId);
  const initialEventId = initialEvents.at(-1)?.id ?? mountedEvent.id;
  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c-07-before-flap",
  });

  const repaintWritten = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === REPAINT_BYTES,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`REPAINT ${repaintId} ${REPAINT_BYTES}`, true);
  const firstPause = faultController.pause("server-to-browser", {
    terminalId,
    generation: initial.socketGeneration,
  });
  await faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalId
    && event.generation === initial.socketGeneration
    && event.direction === "server-to-browser"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const firstMarker = flapMarkers[0];
  if (!firstMarker) throw new Error("C-07 marker schedule is empty");
  await pane.sendInput(`PRINT ${firstMarker.id} ${firstMarker.text}`, true);
  await repaintWritten;
  firstPause.dispose();

  let current = initial;
  let afterEventId = initialEventId;
  const intervals: ReconnectInterval[] = [];
  const closedGenerations: number[] = [];
  const staleGenerations: number[] = [];
  const cycleKinds: readonly FlapKind[] = [
    "short-abrupt",
    "short-before-timer",
    "long-drop",
    "open-before-synced",
    "short-abrupt",
    "long-drop",
  ];

  for (let index = 0; index < cycleKinds.length; index += 1) {
    const kind = cycleKinds[index];
    if (!kind) throw new Error(`missing C-07 cycle ${index + 1}`);
    const label = `C-07 flap ${index + 1} (${kind})`;
    const marker = flapMarkers[index];
    if (!marker) throw new Error(`missing C-07 marker ${index + 1}`);
    if (index > 0) {
      await pane.sendInput(`PRINT ${marker.id} ${marker.text}`, true);
      await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === marker.id && entry.text === marker.text, { timeoutMs: WAIT_TIMEOUT_MS });
      await expectTerminalBuffer(page, terminalId, {
        contains: `[E2E:PRINT:${marker.id}:${marker.text}]`,
        occurrences: 1,
      }, { timeout: WAIT_TIMEOUT_MS });
    }

    const result = kind === "open-before-synced"
      ? await runOpenBeforeSyncedFlap(page, pane, terminalId, faultController, label, afterEventId, current)
      : await runSimpleFlap(page, pane, terminalId, faultController, kind, label, afterEventId, current);
    intervals.push(...result.intervals);
    closedGenerations.push(...result.closedGenerations);
    current = result.finalSnapshot;
    afterEventId = result.finalSynced.id;
    assertSocketBoundary(current, `${label} settled`);
    expect(current.socketGeneration).toBeGreaterThan(result.closedGenerations.at(-1) ?? 0);
    const staleGeneration = result.closedGenerations.at(-1);
    if (staleGeneration === undefined) throw new Error(`${label} did not close a generation`);
    staleGenerations.push(staleGeneration);
    const beforeStale = await terminalEvents(page, terminalId);
    const staleAfter = beforeStale.at(-1)?.id ?? afterEventId;
    await assertStaleGenerationIgnored(page, terminalId, current.socketGeneration, staleGeneration, staleAfter, current);
    await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  }

  for (const marker of flapMarkers) {
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:PRINT:${marker.id}:${marker.text}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
  }

  const beforeFinal = await screenshotRegion(page, pane.xtermHost);
  await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${finalId}:${finalText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const settledSnapshot = await page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration === generation
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, generation: current.socketGeneration, timeout: WAIT_TIMEOUT_MS });
  const afterFinal = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeFinal, afterFinal, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "c-07-final-marker",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c-07-final-terminal",
  });

  await pane.sendInput(`SIZE ${sizeId}`, true);
  const ptySize = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(ptySize.cols).toBe(settledSnapshot.cols);
  expect(ptySize.rows).toBe(settledSnapshot.rows);
  expect(ptySize.pixel_width).toBe(settledSnapshot.pixelWidth);
  expect(ptySize.pixel_height).toBe(settledSnapshot.pixelHeight);
  await expectTerminalConverged(page, terminalId, {
    cols: settledSnapshot.cols,
    rows: settledSnapshot.rows,
    pixelWidth: settledSnapshot.pixelWidth,
    pixelHeight: settledSnapshot.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`ECHO_INPUT ${inputId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(inputText, true);
  const echoed = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === inputId
      && entry.phase === "payload"
      && entry.payload_base64 === inputBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoed.payload_base64).toBe(inputBase64);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${inputId}:${inputBase64}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const finalSnapshot = await snapshotOrThrow(page, terminalId, "final terminal");

  const transcript = await server.readTranscript(terminalId);
  const orderedPrintIds = transcript
    .filter((entry) => entry.event === "print" && typeof entry.id === "string")
    .map((entry) => entry.id as string);
  expect(orderedPrintIds.filter((id) => id === finalId)).toHaveLength(1);
  for (const marker of flapMarkers) {
    expect(countEntries(transcript, (entry) => entry.event === "print" && entry.id === marker.id && entry.text === marker.text)).toBe(1);
  }
  const expectedPrintOrder = [firstMarker.id, ...flapMarkers.slice(1).map((marker) => marker.id), finalId];
  const observedPrintOrder = orderedPrintIds.filter((id) => expectedPrintOrder.includes(id));
  expect(observedPrintOrder).toEqual(expectedPrintOrder);
  expect(countEntries(transcript, (entry) => entry.event === "repaint" && entry.id === repaintId)).toBe(1);
  expect(countEntries(transcript, (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload")).toBe(1);
  expect(countEntries(transcript, (entry) => entry.event === "error")).toBe(0);

  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.socketGeneration).toBe(current.socketGeneration);
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.gridEpoch).toEqual(expect.any(Number));
  expect(finalSnapshot.receivedSequence).toBe(outputByteCount(transcript));
  expect(finalSnapshot.committedSequence).toBe(outputByteCount(transcript));
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.xterm.activeBuffer).toBe("alternate");
  assertSocketBoundary(finalSnapshot, "final terminal");

  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  assertNoUnexpectedSocketMultiplication([initial, ...intervals.map((interval) => interval.created.snapshot), finalSnapshot]);
  assertNoPendingSynchronization(finalSnapshot);
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale").length).toBeGreaterThanOrEqual(staleGenerations.length);

  const createdEvents = finalEvents.filter((event) => event.type === "socket-created");
  const closeEvents = finalEvents.filter((event) => event.type === "socket-close");
  const syncedEvents = finalEvents.filter((event) => event.type === "synced");
  const expectedCreatedGenerations = [1, 2, 3, 4, 5, 6, 7, 8];
  expect(createdEvents.map(eventGeneration)).toEqual(expectedCreatedGenerations);
  expect(closeEvents.map(eventGeneration)).toEqual(closedGenerations);
  expect(createdEvents).toHaveLength(8);
  expect(closeEvents).toHaveLength(7);
  expect(syncedEvents).toHaveLength(7);
  for (const event of finalEvents) assertSocketBoundary(event.snapshot, `event ${event.id}`);
  for (const interval of intervals) assertReconnectInterval(interval);

  const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
  const connectionOpens = networkEvents.filter((event) => event.type === "connection-open");
  const syncFrames = networkEvents.filter((event) => (
    event.type === "frame"
    && event.direction === "server-to-browser"
    && event.frame?.jsonType === "sync"
  ));
  const snapshotFrames = networkEvents.filter((event) => (
    event.type === "frame"
    && event.direction === "server-to-browser"
    && event.frame?.binaryKind === 0
  ));
  expect(connectionOpens).toHaveLength(createdEvents.length);
  expect(syncFrames.length).toBeLessThanOrEqual(createdEvents.length);
  expect(snapshotFrames.length).toBeLessThanOrEqual(syncFrames.length);
  const snapshotCountByGeneration = new Map<number, number>();
  for (const frame of snapshotFrames) {
    if (frame.generation === undefined) throw new Error("snapshot frame has no proxy generation");
    snapshotCountByGeneration.set(frame.generation, (snapshotCountByGeneration.get(frame.generation) ?? 0) + 1);
  }
  for (const [generation, count] of snapshotCountByGeneration) {
    expect(count, `generation ${generation} requested repeated snapshots`).toBeLessThanOrEqual(1);
  }
  const reconnectStates = finalEvents.filter((event) => event.type === "state" && event.data.state === "disconnected");
  expect(reconnectStates.length).toBeLessThanOrEqual(closeEvents.length);

  const lastMarker = flapMarkers.at(-1);
  if (!lastMarker) throw new Error("C-07 marker schedule is empty at final assertion");
  expect(finalSnapshot.xterm.text).toContain(`[E2E:PRINT:${finalId}:${finalText}]`);
  expect(finalSnapshot.xterm.text).toContain(`[E2E:ECHO_INPUT:${inputId}:${inputBase64}]`);
  expect(lastMarker.id).toContain(runTag);
  expect(browserErrors()).toEqual([]);
  browserErrors.dispose();
});
