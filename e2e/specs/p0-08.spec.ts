import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants, expectTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

const WAIT_TIMEOUT_MS = 30_000;
const HISTORY_BYTES = 300_000;

async function waitForDiagnosticEvent(
  page: Page,
  terminalId: string,
  type: E2ETerminalEventType,
  options: {
    readonly minimumGeneration?: number;
    readonly exactGeneration?: number;
    readonly syncMode?: "snapshot" | "resume";
    readonly parserStarted?: boolean;
    readonly afterId?: number;
  } = {},
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, type, minimumGeneration, exactGeneration, syncMode, parserStarted, afterId, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === type
      && (exactGeneration === undefined || event.snapshot.socketGeneration === exactGeneration)
      && (minimumGeneration === undefined || event.snapshot.socketGeneration >= minimumGeneration)
      && (syncMode === undefined || event.snapshot.syncMode === syncMode)
      && (!parserStarted || event.snapshot.pendingParserWrites > 0)
    ), { timeout, afterId });
  }, {
    id: terminalId,
    type,
    timeout: WAIT_TIMEOUT_MS,
    ...options,
  });
}

async function waitForChangedViewport(
  page: Page,
  terminalId: string,
  original: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, cols, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      return desired !== undefined && (desired.cols !== cols || desired.rows !== rows);
    }, { timeout });
  }, { id: terminalId, cols: original.cols, rows: original.rows, timeout: WAIT_TIMEOUT_MS });
}
async function waitForConnectedAndSettled(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}


test("P0-08 Disconnect during snapshot recovery @p0 @smoke", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  await page.goto("/");
  await new LoginPage(page).login();
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
  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();

  const markerPrefix = `P008-W${testInfo.workerIndex}-R${testInfo.retry}-I${testInfo.repeatEachIndex}`;
  const readyId = `${markerPrefix}-READY`;
  const historyId = `${markerPrefix}-HISTORY`;
  const stableId = `${markerPrefix}-STABLE`;
  const stableText = `${markerPrefix}-STABLE-BUFFER`;
  const finalId = `${markerPrefix}-FINAL`;
  const finalText = `${markerPrefix}-FINAL-BUFFER`;
  const sizeId = `${markerPrefix}-SIZE`;
  const echoId = `${markerPrefix}-ECHO`;
  const echoText = `${markerPrefix}-CONTINUED-INPUT`;
  const echoBase64 = Buffer.from(echoText, "utf8").toString("base64");

  await waitForConnectedAndSettled(page, terminalId);
  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });

  await pane.sendInput(`PRINT ${stableId} ${stableText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === stableId, { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`BURST ${historyId} ${HISTORY_BYTES} 120`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "burst" && entry.id === historyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${stableId}:${stableText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const baseline = await waitForConnectedAndSettled(page, terminalId);
  const baselineProxyOpen = await faultController.waitFor(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  if (baselineProxyOpen.generation === undefined) throw new Error("initial proxy connection has no generation");

  // Hold the resize frame so the reconnect URL carries the new viewport while
  // the broker remains on the old epoch. The following connection must then
  // choose a snapshot rather than a resume.
  const pausedBrowserOutput = faultController.pause("browser-to-server", {
    terminalId,
    generation: baselineProxyOpen.generation,
  });
  const terminateAfterSnapshot = faultController.terminate({
    terminalId,
    generation: baselineProxyOpen.generation + 1,
    direction: "server-to-browser",
    binaryKind: 0,
    occurrence: 1,
  });
  let interruptedProxyGeneration = 0;
  try {
    const viewportChanged = waitForChangedViewport(page, terminalId, baseline);
    const nextWidth = baseline.cols > 60 ? 700 : 1600;
    const nextHeight = baseline.rows > 30 ? 500 : 900;
    await workbench.setViewport(nextWidth, nextHeight);
    const resized = await viewportChanged;
    expect(resized.desiredViewport).toBeDefined();
    expect(resized.desiredViewport?.cols === baseline.cols && resized.desiredViewport?.rows === baseline.rows).toBe(false);
    expect(resized.serverViewport?.cols).toBe(baseline.serverViewport?.cols);
    expect(resized.serverViewport?.rows).toBe(baseline.serverViewport?.rows);

    const firstTermination = faultController.waitFor(
      (event) => event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.generation === baselineProxyOpen.generation,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const socketCloseBoundary = (await terminalEvents(page, terminalId)).at(-1)?.id ?? 0;
    const closeInitialSocket = faultController.terminate({ terminalId });
    closeInitialSocket.dispose();
    await firstTermination;
    await waitForDiagnosticEvent(page, terminalId, "socket-close", {
      exactGeneration: baseline.socketGeneration,
      afterId: socketCloseBoundary,
    });

    const reconnectOpen = faultController.waitFor(
      (event) => event.type === "connection-open"
        && event.terminalId === terminalId
        && event.generation !== undefined
        && event.generation > baselineProxyOpen.generation!,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const secondProxyOpen = await reconnectOpen;
    if (secondProxyOpen.generation === undefined) throw new Error("snapshot recovery proxy connection has no generation");
    interruptedProxyGeneration = secondProxyOpen.generation;

    const nextSocketOpen = waitForDiagnosticEvent(page, terminalId, "socket-open", {
      minimumGeneration: interruptedProxyGeneration + 1,
    });
    const nextSnapshotStart = waitForDiagnosticEvent(page, terminalId, "snapshot", {
      minimumGeneration: interruptedProxyGeneration + 1,
      syncMode: "snapshot",
    });

    // The generation-specific frame rule is armed before reconnect. It forwards
    // the first snapshot frame, then terminates the proxy connection so xterm
    // starts an abandoned parser write without receiving the synced control.
    const interruptedParser = waitForDiagnosticEvent(page, terminalId, "snapshot", {
      exactGeneration: secondProxyOpen.generation,
      syncMode: "snapshot",
      parserStarted: true,
    });
    const interruptedTermination = faultController.waitFor(
      (event) => event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.generation === secondProxyOpen.generation,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await interruptedTermination;
    const parserStart = await interruptedParser;
    terminateAfterSnapshot.dispose();

    expect(parserStart.snapshot.pendingParserWrites).toBeGreaterThan(0);
    expect(parserStart.snapshot.pendingParserBytes).toBeGreaterThan(0);
    expect(parserStart.snapshot.syncMode).toBe("snapshot");

    pausedBrowserOutput.dispose();
    await nextSocketOpen;
    const nextRecoverySnapshot = await nextSnapshotStart;
    expect(nextRecoverySnapshot.snapshot.syncMode).toBe("snapshot");
  } finally {
    pausedBrowserOutput.dispose();
    terminateAfterSnapshot.dispose();
  }

  if (interruptedProxyGeneration === 0) throw new Error("snapshot interruption proxy generation was not recorded");
  const finalSynced = await waitForDiagnosticEvent(page, terminalId, "synced", {
    minimumGeneration: interruptedProxyGeneration + 1,
  });
  expect(finalSynced.snapshot.socketState).toBe("connected");
  expect(finalSynced.snapshot.acceptingInput).toBe(true);
  expect(finalSynced.snapshot.pendingParserWrites).toBe(0);

  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${stableId}:${stableText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number }>(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const finalBeforePrint = await pane.snapshot();
  if (!finalBeforePrint) throw new Error(`no diagnostics snapshot for terminal ${terminalId}`);
  expect(size.rows).toBe(finalBeforePrint.rows);
  expect(size.cols).toBe(finalBeforePrint.cols);
  expect(finalBeforePrint.serverViewport?.cols).toBe(finalBeforePrint.cols);
  expect(finalBeforePrint.serverViewport?.rows).toBe(finalBeforePrint.rows);

  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(echoText, true);
  const echoPayload = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoPayload.payload_base64).toBe(echoBase64);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${echoId}:${echoBase64}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const beforeFinalSnapshot = await pane.snapshot();
  if (!beforeFinalSnapshot) throw new Error(`no pre-final diagnostics snapshot for terminal ${terminalId}`);
  const beforeFinal = await screenshotRegion(page, pane.xtermHost);

  await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${finalId}:${finalText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await page.evaluate(async ({ id, minimumRender, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.renderCount > minimumRender
        && snapshot.pendingParserWrites === 0
        && snapshot.renderBacklogBytes === 0,
      { timeout },
    );
  }, { id: terminalId, minimumRender: beforeFinalSnapshot.renderCount, timeout: WAIT_TIMEOUT_MS });
  const afterFinal = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeFinal, afterFinal, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-08-final-marker",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "p0-08-recovered-terminal",
  });

  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  const snapshotStart = events.find((event) => (
    event.type === "snapshot"
    && event.snapshot.syncMode === "snapshot"
    && event.snapshot.socketGeneration === interruptedProxyGeneration
  ));
  expect(snapshotStart, "snapshot recovery must begin on the interrupted generation").toBeDefined();
  const interruptedClose = events.find((event) => (
    event.type === "socket-close"
    && event.snapshot.socketGeneration === interruptedProxyGeneration
  ));
  expect(interruptedClose, "the snapshot socket must close while its parser is active").toBeDefined();
  expect(interruptedClose?.snapshot.pendingParserWrites).toBeGreaterThan(0);
  expect(interruptedClose?.snapshot.syncMode).toBe("snapshot");
  if (!snapshotStart || !interruptedClose) throw new Error("missing snapshot interruption diagnostics");
  expect(events.filter((event) => (
    event.id > snapshotStart.id
    && event.id < interruptedClose.id
    && event.type === "parser-commit"
  ))).toEqual([]);
  expect(events.filter((event) => (
    event.type === "synced"
    && event.snapshot.socketGeneration === interruptedProxyGeneration
  ))).toEqual([]);

  const nextRecoveryStarts = events.filter((event) => (
    event.type === "snapshot"
    && event.snapshot.syncMode === "snapshot"
    && event.snapshot.socketGeneration > interruptedProxyGeneration
  ));
  expect(nextRecoveryStarts.length, "the reconnect must start a fresh valid snapshot state").toBeGreaterThanOrEqual(1);
  const finalSnapshot = await pane.snapshot();
  if (!finalSnapshot) throw new Error(`no final diagnostics snapshot for terminal ${terminalId}`);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.syncMode).toBeUndefined();
  expect(finalSnapshot.committedSequence).toBe(finalSnapshot.receivedSequence);

  const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
  const connectionOpens = networkEvents.filter((event) => event.type === "connection-open");
  expect(connectionOpens).toHaveLength(3);
  expect(networkEvents.filter((event) => event.type === "connection-terminated")).toHaveLength(2);
  const syncMessages = networkEvents.filter((event) => (
    event.type === "frame"
    && event.direction === "server-to-browser"
    && event.frame?.jsonType === "sync"
  ));
  expect(syncMessages).toHaveLength(3);
  const snapshotFrames = networkEvents.filter((event) => (
    event.type === "frame"
    && event.direction === "server-to-browser"
    && event.frame?.binaryKind === 0
  ));
  const snapshotGenerations = new Set(
    snapshotFrames
      .map((event) => event.generation)
      .filter((generation): generation is number => generation !== undefined),
  );
  expect(snapshotGenerations.has(baselineProxyOpen.generation)).toBe(true);
  expect(snapshotGenerations.has(interruptedProxyGeneration)).toBe(true);
  expect(snapshotGenerations.has(finalSnapshot.socketGeneration)).toBe(true);
  expect(snapshotFrames.filter((event) => event.generation === interruptedProxyGeneration)).toHaveLength(1);
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  expect((await server.readTranscript(terminalId)).filter((entry) => entry.event === "error")).toEqual([]);

  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "p0-08-final-terminal",
  });
});
