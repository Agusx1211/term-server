import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
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
import type { Page } from "@playwright/test";

const WAIT_TIMEOUT_MS = 30_000;
const BACKOFF_TOLERANCE_MS = 250;
const BACKOFF_DELAYS_MS = [500, 1_000, 2_000] as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly pid: number | null;
  readonly status: string;
};

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function occurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
}

function expectBackoffDelay(actual: number, expected: number, label: string): void {
  expect(Number.isFinite(actual), `${label} backoff timestamp delta is finite`).toBe(true);
  expect(actual, `${label} backoff was not shorter than expected`).toBeGreaterThanOrEqual(expected - BACKOFF_TOLERANCE_MS);
  expect(actual, `${label} backoff exceeded its deterministic budget`).toBeLessThanOrEqual(expected + BACKOFF_TOLERANCE_MS);
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEventType,
  generation?: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, expectedGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => {
        const eventGeneration = typeof event.data.generation === "number"
          ? event.data.generation
          : event.snapshot.socketGeneration;
        return event.id > after
          && event.type === eventType
          && (expectedGeneration === undefined || eventGeneration === expectedGeneration);
      },
      { timeout },
    );
  }, {
    id: terminalId,
    after: afterEventId,
    eventType: type,
    expectedGeneration: generation,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} was not found in the server listing`);
    return terminal;
  }, terminalId);
}

function expectViewport(snapshot: E2ETerminalSnapshot): void {
  const expected = {
    cols: snapshot.cols,
    rows: snapshot.rows,
    pixelWidth: snapshot.pixelWidth,
    pixelHeight: snapshot.pixelHeight,
  };
  for (const [label, viewport] of [
    ["proposed", snapshot.proposedViewport],
    ["desired", snapshot.desiredViewport],
    ["url", snapshot.urlViewport],
    ["sent", snapshot.sentViewport],
    ["server", snapshot.serverViewport],
  ] as const) {
    expect(viewport, `${label} viewport is missing`).toBeDefined();
    if (!viewport) continue;
    expect(viewport.cols, `${label} viewport cols`).toBe(expected.cols);
    expect(viewport.rows, `${label} viewport rows`).toBe(expected.rows);
    expect(viewport.pixelWidth, `${label} viewport pixel width`).toBe(expected.pixelWidth);
    expect(viewport.pixelHeight, `${label} viewport pixel height`).toBe(expected.pixelHeight);
  }
}

interface FailedConnectionResult {
  readonly close: E2ETerminalEvent;
}

interface NextConnectionResult {
  readonly created: E2ETerminalEvent;
  readonly opened?: E2ETerminalEvent;
  readonly failed?: FailedConnectionResult;
}

test("C-12 Backoff reset @nightly @p1 @reconnect", async ({ page, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runId = `W${testInfo.workerIndex}-R${testInfo.retry}-N${testInfo.repeatEachIndex}`;
  const readyId = `C12_READY_${runId}`;
  const beforeId = `C12_BEFORE_${runId}`;
  const beforeText = `before-failures-${runId}`;
  const holdToken = `C12_GATE_${runId}`;
  const releaseId = holdToken;
  const afterId = `C12_AFTER_${runId}`;
  const afterText = `after-sync-${runId}`;
  const echoId = `C12_ECHO_${runId}`;
  const inputText = `input-C12-${runId}`;
  const sizeId = `C12_SIZE_${runId}`;

  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const terminalRegion = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(terminalRegion).toBeVisible();
  const terminalId = await terminalRegion.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal did not expose a stable terminal ID");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await pane.focus();

  const initial = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  expect(initial.socketGeneration).toBe(1);
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.acceptingInput).toBe(true);
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  const initialTerminal = await readTerminal(page, terminalId);
  expect(initialTerminal.id).toBe(terminalId);
  expect(initialTerminal.status).toBe("running");
  if (initialTerminal.pid === null) throw new Error("initial terminal has no process identity");
  const initialPid = initialTerminal.pid;
  const beforePixels = await screenshotRegion(page, pane.xtermHost);

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("PRINT", beforeId, beforeText),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "hold" && entry.token === holdToken,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const waitForConnectionClose = (afterEventId: number, generation: number) => waitForDiagnosticEventAfter(
    page,
    terminalId,
    afterEventId,
    "socket-close",
    generation,
  );
  const waitForConnectionCreated = (afterEventId: number, generation: number) => waitForDiagnosticEventAfter(
    page,
    terminalId,
    afterEventId,
    "socket-created",
    generation,
  );
  const waitForConnectionOpen = (afterEventId: number, generation: number) => waitForDiagnosticEventAfter(
    page,
    terminalId,
    afterEventId,
    "socket-open",
    generation,
  );

  const terminateCurrent = async (generation: number, afterEventId: number): Promise<FailedConnectionResult> => {
    const socketClose = waitForConnectionClose(afterEventId, generation);
    const proxyTermination = faultController.waitFor((event) => (
      event.type === "connection-terminated"
      && event.terminalId === terminalId
      && event.generation === generation
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const fault = faultController.terminate({ terminalId, generation });
    const [close, terminated] = await Promise.all([socketClose, proxyTermination]);
    fault.dispose();
    expect(terminated.type).toBe("connection-terminated");
    expect(terminated.abrupt).toBe(true);
    return { close };
  };

  const advanceToNextConnection = async (
    failedClose: E2ETerminalEvent,
    nextGeneration: number,
    expectedDelay: number,
    failNext: boolean,
  ): Promise<NextConnectionResult> => {
    const nextFault = failNext ? faultController.terminate({ terminalId, generation: nextGeneration }) : undefined;
    const createdPromise = waitForConnectionCreated(failedClose.id, nextGeneration);
    const openedPromise = failNext
      ? undefined
      : waitForConnectionOpen(failedClose.id, nextGeneration);
    const proxyUpgrade = faultController.waitFor((event) => (
      event.type === "upgrade-request"
      && event.terminalId === terminalId
      && event.generation === nextGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const proxyOpen = faultController.waitFor((event) => (
      event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation === nextGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const nextClosePromise = failNext
      ? waitForConnectionClose(failedClose.id, nextGeneration)
      : undefined;
    const nextTerminationPromise = failNext
      ? faultController.waitFor((event) => (
        event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.generation === nextGeneration
      ), { timeoutMs: WAIT_TIMEOUT_MS })
      : undefined;
    const created = await createdPromise;
    expect(created.snapshot.socketGeneration).toBe(nextGeneration);
    expect(created.snapshot.activeSocketCount).toBe(1);
    await proxyUpgrade;
    await proxyOpen;
    expectBackoffDelay(created.timestamp - failedClose.timestamp, expectedDelay, `generation ${nextGeneration}`);

    if (!nextFault || !nextClosePromise || !nextTerminationPromise) {
      if (!openedPromise) throw new Error(`successful generation ${nextGeneration} did not expose a browser open event`);
      const opened = await openedPromise;
      return { created, opened };
    }
    const [nextClose, nextTermination] = await Promise.all([nextClosePromise, nextTerminationPromise]);
    nextFault.dispose();
    expect(nextTermination.type).toBe("connection-terminated");
    expect(nextTermination.abrupt).toBe(true);
    return {
      created,
      failed: { close: nextClose },
    };
  };

  const eventBoundary = (await pane.events()).at(-1)?.id ?? 0;
  const firstFailure = await terminateCurrent(1, eventBoundary);
  let currentClose = firstFailure.close;
  let next = await advanceToNextConnection(currentClose, 2, BACKOFF_DELAYS_MS[0], true);
  if (!next.failed) throw new Error("generation 2 was not faulted as planned");
  currentClose = next.failed.close;

  next = await advanceToNextConnection(currentClose, 3, BACKOFF_DELAYS_MS[1], true);
  if (!next.failed) throw new Error("generation 3 was not faulted as planned");
  currentClose = next.failed.close;

  next = await advanceToNextConnection(currentClose, 4, BACKOFF_DELAYS_MS[2], false);
  const generationFour = next.created;
  const generationFourSynced = await waitForDiagnosticEventAfter(page, terminalId, generationFour.id, "synced", 4);
  const recovered = await pane.snapshot();
  if (!recovered) throw new Error("missing post-failure synchronization diagnostics");
  expect(recovered.socketGeneration).toBe(4);
  expect(recovered.socketState).toBe("connected");
  expect(recovered.activeSocketCount).toBe(1);
  expect(recovered.acceptingInput).toBe(true);
  expect(recovered.syncMode).toBeUndefined();
  expect(recovered.syncTarget).toBeUndefined();
  expect(recovered.pendingParserWrites).toBe(0);
  expect(recovered.pendingParserBytes).toBe(0);
  expect(recovered.renderBacklogBytes).toBe(0);

  await pane.sendInput(`RELEASE ${releaseId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "release" && entry.token === releaseId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`PRINT ${afterId} ${afterText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === afterId && entry.text === afterText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`ECHO_INPUT ${echoId} ${inputText}`, true);
  const echoedInput = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload" && entry.text === inputText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoedInput.text).toBe(inputText);
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", echoId, inputText),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const beforePostSuccessFailureEvents = await pane.events();
  const postSuccessBoundary = beforePostSuccessFailureEvents.at(-1)?.id ?? 0;
  const postSuccessFailure = await terminateCurrent(4, postSuccessBoundary);
  expect(postSuccessFailure.close.timestamp).toBeGreaterThan(generationFourSynced.timestamp);
  const postSuccessNext = await advanceToNextConnection(
    postSuccessFailure.close,
    5,
    BACKOFF_DELAYS_MS[0],
    false,
  );
  const finalSynced = await waitForDiagnosticEventAfter(page, terminalId, postSuccessNext.created.id, "synced", 5);
  expect(finalSynced.timestamp).toBeGreaterThan(postSuccessFailure.close.timestamp);

  const sizeCommand = `SIZE ${sizeId}`;
  await pane.sendInput(sizeCommand, true);
  const size = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const convergenceReference = await pane.snapshot();
  if (!convergenceReference) throw new Error("missing diagnostics snapshot before final convergence");
  await expectTerminalConverged(page, terminalId, {
    cols: convergenceReference.cols,
    rows: convergenceReference.rows,
    pixelWidth: convergenceReference.pixelWidth,
    pixelHeight: convergenceReference.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("SIZE", sizeId, String(convergenceReference.rows), String(convergenceReference.cols)),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const final = await pane.snapshot();
  if (!final) throw new Error("missing final diagnostics snapshot");
  expect(final.socketGeneration).toBe(5);
  expect(final.socketState).toBe("connected");
  expect(final.activeSocketCount).toBe(1);
  expect(final.socket.activeCount).toBe(1);
  expect(final.acceptingInput).toBe(true);
  expect(final.syncMode).toBeUndefined();
  expect(final.syncTarget).toBeUndefined();
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  expect(final.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expectViewport(final);
  expect(size.rows).toBe(final.rows);
  expect(size.cols).toBe(final.cols);
  expect(size.pixel_width).toBe(final.pixelWidth);
  expect(size.pixel_height).toBe(final.pixelHeight);

  const finalText = final.xterm.text;
  const expectedMarkers = [
    marker("READY", readyId),
    marker("PRINT", beforeId, beforeText),
    marker("HOLD", holdToken),
    marker("RELEASE", releaseId),
    marker("PRINT", afterId, afterText),
    marker("ECHO_INPUT", echoId, inputText),
    marker("SIZE", sizeId, String(final.rows), String(final.cols)),
  ];
  for (const expectedMarker of expectedMarkers) {
    expect(finalText, `terminal model is missing ${expectedMarker}`).toContain(expectedMarker);
    expect(occurrences(finalText, expectedMarker), `${expectedMarker} was duplicated in the terminal model`).toBe(1);
  }
  const finalPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforePixels, finalPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "c-12-backoff-reset-marker",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "c-12-backoff-reset-terminal",
  });

  const finalTerminal = await readTerminal(page, terminalId);
  expect(finalTerminal.id).toBe(terminalId);
  expect(finalTerminal.status).toBe("running");
  expect(finalTerminal.pid).toBe(initialPid);

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === beforeId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "hold" && entry.token === holdToken)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "release" && entry.token === releaseId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === afterId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal").length).toBeGreaterThan(0);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(0);

  const events = await terminalEvents(page, terminalId);
  const socketCreated = events.filter((event) => event.type === "socket-created");
  const socketClosed = events.filter((event) => event.type === "socket-close");
  const socketOpened = events.filter((event) => event.type === "socket-open");
  expect(socketCreated).toHaveLength(5);
  expect(socketCreated.map((event) => event.data.generation)).toEqual([1, 2, 3, 4, 5]);
  expect(socketClosed).toHaveLength(4);
  expect(socketClosed.map((event) => event.data.generation)).toEqual([1, 2, 3, 4]);
  expect(socketOpened.some((event) => event.data.generation === 4)).toBe(true);
  expect(socketOpened.some((event) => event.data.generation === 5)).toBe(true);
  expect(events.filter((event) => event.type === "sync")).toHaveLength(3);
  expect(events.filter((event) => event.type === "synced")).toHaveLength(3);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  await assertMonotonicSequences(events);
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
  const upgradeRequests = networkEvents.filter((event) => event.type === "upgrade-request");
  const connectionOpens = networkEvents.filter((event) => event.type === "connection-open");
  const connectionTerminations = networkEvents.filter((event) => event.type === "connection-terminated");
  expect(upgradeRequests).toHaveLength(5);
  expect(upgradeRequests.map((event) => event.generation)).toEqual([1, 2, 3, 4, 5]);
  expect(connectionOpens).toHaveLength(5);
  expect(connectionOpens.map((event) => event.generation)).toEqual([1, 2, 3, 4, 5]);
  expect(connectionTerminations).toHaveLength(4);
  expect(connectionTerminations.map((event) => event.generation)).toEqual([1, 2, 3, 4]);
  expect(connectionTerminations.every((event) => event.abrupt === true)).toBe(true);
  expect(networkEvents.filter((event) => event.type === "socket-error")).toHaveLength(0);
  expect(networkEvents.filter((event) => event.type === "malformed-frame")).toHaveLength(0);
  expect(connectionOpens.length - connectionTerminations.length).toBe(1);

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
});
