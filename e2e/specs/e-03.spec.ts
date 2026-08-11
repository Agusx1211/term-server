import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import { expectKnownMarkerChanged, expectTerminalNonBlank, screenshotRegion } from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  expectConnectedTerminalInvariants,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;
const OUTPUT_FRAME_KIND = 1;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};
function nextOutputOccurrence(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
): number {
  let lastOccurrence = 0;
  for (const event of events) {
    if (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.generation === generation
      && event.direction === "server-to-browser"
      && event.frame?.binaryKind === OUTPUT_FRAME_KIND
    ) {
      lastOccurrence = Math.max(lastOccurrence, event.frame.occurrence);
    }
  }
  return lastOccurrence + 1;
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  type: E2ETerminalEventType,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, eventType, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after && event.type === eventType,
      { timeout, afterId: after },
    );
  }, { id: terminalId, eventType: type, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForStateAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  states: readonly string[],
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, expectedStates, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "state"
        && expectedStates.includes(String(event.data.state)),
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, expectedStates: states, timeout: WAIT_TIMEOUT_MS });
}


test("E-03 Server-reported error @e @errors @nightly", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  await page.goto("/");
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const mountEvent = page.evaluate(async ({ timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, { timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const terminal = workbench.terminal(terminalId);
  await terminal.expectVisible();
  const terminalViewport = terminal.xtermHost.locator(".xterm-screen");
  await expect(terminalViewport).toBeVisible();

  const token = `W${testInfo.workerIndex}-P${testInfo.parallelIndex}-I${testInfo.repeatEachIndex}-R${testInfo.retry}-${Date.now()}`;
  const readyId = `E03-READY-${token}`;
  const baselineId = `E03-BASE-${token}`;
  const recoverableBoundaryId = `E03-RECOVERABLE-${token}`;
  const recoverableEchoId = `E03-ECHO-RECOVERABLE-${token}`;
  const recoverableInput = `E03-input-recoverable-${token}`;
  const fatalBoundaryId = `E03-FATAL-${token}`;
  const finalId = `E03-FINAL-${token}`;
  const finalEchoId = `E03-ECHO-FINAL-${token}`;
  const finalInput = `E03-input-final-${token}`;
  const recoverableMessage = `E03 recoverable server notice ${token}`;
  const fatalMessage = `E03 fatal server notice ${token}`;
  const recoverablePayloadBase64 = Buffer.from(recoverableInput, "utf8").toString("base64");
  const finalPayloadBase64 = Buffer.from(finalInput, "utf8").toString("base64");

  await terminal.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(`PRINT ${baselineId} baseline-terminal`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === baselineId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${baselineId}:baseline-terminal]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const beforeRecoverable = await screenshotRegion(page, terminalViewport);
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "e03-before-recoverable-terminal",
  });

  const connectedBeforeRecoverable = await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
  expect(connectedBeforeRecoverable.socketState).toBe("connected");
  expect(connectedBeforeRecoverable.acceptingInput).toBe(true);
  expect(connectedBeforeRecoverable.activeSocketCount).toBe(1);
  const initialGeneration = connectedBeforeRecoverable.socketGeneration;

  const recoverableOccurrence = nextOutputOccurrence(
    faultController.events,
    terminalId,
    initialGeneration,
  );
  const recoverableInjection = faultController.inject({
    direction: "server-to-browser",
    data: JSON.stringify({ type: "error", message: recoverableMessage }),
    binary: false,
    matcher: {
      terminalId,
      generation: initialGeneration,
      direction: "server-to-browser",
      binaryKind: OUTPUT_FRAME_KIND,
      occurrence: recoverableOccurrence,
    },
    when: "after",
  });
  const recoverableInjected = faultController.waitFor(
    (event) => event.type === "injected"
      && event.ruleId === recoverableInjection.id
      && event.terminalId === terminalId
      && event.direction === "server-to-browser",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const recoverableNotice = expect(
    page.getByRole("status", { name: recoverableMessage, exact: true }),
  ).toBeVisible({ timeout: WAIT_TIMEOUT_MS });

  await terminal.sendInput(`PRINT ${recoverableBoundaryId} recoverable-boundary`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === recoverableBoundaryId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await recoverableInjected;
  await recoverableNotice;
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${recoverableBoundaryId}:recoverable-boundary]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const afterRecoverable = await screenshotRegion(page, terminalViewport);
  expect(afterRecoverable.width).toBe(beforeRecoverable.width);
  expect(afterRecoverable.height).toBe(beforeRecoverable.height);
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "e03-recoverable-terminal",
  });
  const recoverableSnapshot = await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
  expect(recoverableSnapshot.socketGeneration).toBe(initialGeneration);
  expect(recoverableSnapshot.activeSocketCount).toBe(1);
  expect(recoverableSnapshot.acceptingInput).toBe(true);
  expect(recoverableSnapshot.xterm.text).toContain(`[E2E:PRINT:${baselineId}:baseline-terminal]`);
  expect(recoverableSnapshot.xterm.text).toContain(`[E2E:PRINT:${recoverableBoundaryId}:recoverable-boundary]`);

  await terminal.sendInput(`ECHO_INPUT ${recoverableEchoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === recoverableEchoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(recoverableInput, true);
  const recoverablePayload = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === recoverableEchoId
      && entry.phase === "payload"
      && entry.payload_base64 === recoverablePayloadBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(recoverablePayload.payload_base64).toBe(recoverablePayloadBase64);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${recoverableEchoId}:${recoverablePayloadBase64}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const beforeFatalEvents = await terminalEvents(page, terminalId);
  const fatalAfterEventId = beforeFatalEvents.at(-1)?.id ?? 0;
  const fatalOccurrence = nextOutputOccurrence(
    faultController.events,
    terminalId,
    initialGeneration,
  );
  const fatalInjection = faultController.inject({
    direction: "server-to-browser",
    data: JSON.stringify({ type: "error", message: fatalMessage }),
    binary: false,
    matcher: {
      terminalId,
      generation: initialGeneration,
      direction: "server-to-browser",
      binaryKind: OUTPUT_FRAME_KIND,
      occurrence: fatalOccurrence,
    },
    when: "after",
  });
  const fatalClose = faultController.close({
    code: 1011,
    reason: "E03 fatal server failure",
    matcher: {
      terminalId,
      generation: initialGeneration,
      direction: "server-to-browser",
      binaryKind: OUTPUT_FRAME_KIND,
      occurrence: fatalOccurrence,
    },
    when: "after",
  });
  const fatalInjected = faultController.waitFor(
    (event) => event.type === "injected"
      && event.ruleId === fatalInjection.id
      && event.terminalId === terminalId
      && event.direction === "server-to-browser",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const fatalCloseSent = faultController.waitFor(
    (event) => event.type === "close-sent"
      && event.ruleId === fatalClose.id
      && event.terminalId === terminalId
      && event.direction === "server-to-browser"
      && event.code === 1011,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const fatalNotice = expect(
    page.getByRole("status", { name: fatalMessage, exact: true }),
  ).toBeVisible({ timeout: WAIT_TIMEOUT_MS });
  const fatalState = waitForStateAfter(page, terminalId, fatalAfterEventId, ["disconnected", "recovering"]);
  const recoveredSync = waitForEventAfter(page, terminalId, "synced", fatalAfterEventId);

  await terminal.sendInput(`PRINT ${fatalBoundaryId} fatal-boundary`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === fatalBoundaryId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await Promise.all([fatalInjected, fatalCloseSent, fatalNotice, fatalState]);
  const fatalStateSnapshot = await terminal.snapshot();
  if (!fatalStateSnapshot) throw new Error(`no fatal-state diagnostics snapshot for terminal ${terminalId}`);
  expect(["disconnected", "recovering", "connecting", "connected"]).toContain(fatalStateSnapshot.socketState);
  expect(fatalStateSnapshot.activeSocketCount).toBeLessThanOrEqual(1);

  await recoveredSync;
  const recovered = await terminal.snapshot();
  if (!recovered) throw new Error(`no recovered diagnostics snapshot for terminal ${terminalId}`);
  expect(recovered.socketState).toBe("connected");
  expect(recovered.acceptingInput).toBe(true);
  expect(recovered.activeSocketCount).toBe(1);
  expect(recovered.socket.activeCount).toBe(1);
  expect(recovered.pendingParserWrites).toBe(0);
  expect(recovered.renderBacklogBytes).toBe(0);
  expect(recovered.xterm.text).toContain(`[E2E:PRINT:${fatalBoundaryId}:fatal-boundary]`);
  await expect(terminal.root.locator(".pane-stream-status")).toBeHidden();
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "e03-recovered-terminal",
  });

  await terminal.sendInput(`ECHO_INPUT ${finalEchoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === finalEchoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await terminal.sendInput(finalInput, true);
  const finalPayload = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === finalEchoId
      && entry.phase === "payload"
      && entry.payload_base64 === finalPayloadBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(finalPayload.payload_base64).toBe(finalPayloadBase64);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${finalEchoId}:${finalPayloadBase64}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const beforeFinalSnapshot = await terminal.snapshot();
  if (!beforeFinalSnapshot) throw new Error(`no pre-final diagnostics snapshot for terminal ${terminalId}`);
  const beforeFinal = await screenshotRegion(page, terminalViewport);
  await terminal.sendInput(`PRINT ${finalId} post-fatal-recovery`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === finalId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${finalId}:post-fatal-recovery]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await page.evaluate(async ({ id, minimumRender, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > minimumRender
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout });
  }, { id: terminalId, minimumRender: beforeFinalSnapshot.renderCount, timeout: WAIT_TIMEOUT_MS });
  const afterFinal = await screenshotRegion(page, terminalViewport);
  await expectKnownMarkerChanged(page, terminalViewport, beforeFinal, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "e03-final-marker",
  });
  expect(afterFinal.width).toBe(beforeFinal.width);
  expect(afterFinal.height).toBe(beforeFinal.height);
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "e03-final-terminal",
  });

  const finalSnapshot = await terminal.snapshot();
  if (!finalSnapshot) throw new Error(`no final diagnostics snapshot for terminal ${terminalId}`);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.renderCount).toBeGreaterThan(0);
  expect(finalSnapshot.xterm.text).toContain(`[E2E:PRINT:${baselineId}:baseline-terminal]`);
  expect(finalSnapshot.xterm.text).toContain(`[E2E:PRINT:${recoverableBoundaryId}:recoverable-boundary]`);
  expect(finalSnapshot.xterm.text).toContain(`[E2E:PRINT:${fatalBoundaryId}:fatal-boundary]`);
  expect(finalSnapshot.xterm.text).toContain(`[E2E:PRINT:${finalId}:post-fatal-recovery]`);

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === baselineId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === recoverableBoundaryId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === fatalBoundaryId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === finalId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === recoverableEchoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === finalEchoId && entry.phase === "payload")).toHaveLength(1);

  const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
  expect(networkEvents.filter((event) => event.type === "injected" && event.ruleId === recoverableInjection.id)).toHaveLength(1);
  expect(networkEvents.filter((event) => event.type === "injected" && event.ruleId === fatalInjection.id)).toHaveLength(1);
  expect(networkEvents.some((event) => event.type === "close-sent" && event.ruleId === fatalClose.id && event.code === 1011)).toBe(true);
  expect(networkEvents.filter((event) => event.type === "connection-open")).toHaveLength(2);
  expect(networkEvents.filter((event) => event.type === "connection-terminated")).toHaveLength(0);
  expect(networkEvents.filter((event) => event.type === "frame" && event.direction === "server-to-browser" && event.frame?.jsonType === "error")).toHaveLength(0);

  const finalEvents = await terminalEvents(page, terminalId);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "state" && String(event.data.state) === "recovering").length).toBeLessThanOrEqual(1);
  expect(finalEvents.filter((event) => event.type === "state" && String(event.data.state) === "disconnected").length).toBeLessThanOrEqual(1);
  expect(Math.max(...finalEvents.map((event) => event.snapshot.activeSocketCount))).toBeLessThanOrEqual(1);
  await assertMonotonicSequences(finalEvents);
  const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
});
