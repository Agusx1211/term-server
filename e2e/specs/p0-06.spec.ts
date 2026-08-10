import { test, expect } from "../fixtures/test.js";
import { expectTerminalNonBlank, expectTerminalPixelsChanged, screenshotRegion } from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConnected,
  terminalEvents,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { E2ETerminalDiagnosticsApi } from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

const WAIT_TIMEOUT_MS = 30_000;
const REPAINT_BYTES = 1_300_000;

test("P0-06 Reload during continuous TUI repaint @p0 @smoke", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  await page.goto("/");
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const existingTerminalIds = await page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminals().map((snapshot) => snapshot.terminalId);
  });
  const mountEvent = page.evaluate(async ({ existingTerminalIds, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && !existingTerminalIds.includes(event.terminalId),
      { timeout },
    );
  }, { existingTerminalIds, timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await waitForTerminalState(page, terminalId, { acceptingInput: true, pendingParserWrites: 0 }, { timeout: WAIT_TIMEOUT_MS });

  const markerPrefix = `P0-06-w${testInfo.workerIndex}-r${testInfo.retry}`;
  const altId = `${markerPrefix}-ALT`;
  const holdToken = `${markerPrefix}-HOLD`;
  const repaintId = `${markerPrefix}-REPAINT`;
  const inputId = `${markerPrefix}-INPUT`;
  const inputText = `${markerPrefix}-POST-RELOAD`;
  const inputBase64 = Buffer.from(inputText, "utf8").toString("base64");
  const finalId = `${markerPrefix}-FINAL`;
  const finalText = `${markerPrefix}-FINAL-TUI`;

  await pane.sendInput(`ALT_ENTER ${altId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "alt_enter" && entry.id === altId, { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });

  await pane.sendInput(`REPAINT ${repaintId} ${REPAINT_BYTES}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command" && entry.operation === "REPAINT",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  await faultController.waitFor(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const initialConnection = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
  );
  const initialGeneration = initialConnection?.generation;
  if (initialGeneration === undefined) {
    throw new Error("initial terminal connection has no proxy generation");
  }

  const pausedServerOutput = faultController.pause("server-to-browser", {
    terminalId,
    generation: initialGeneration,
  });
  try {
    await faultController.waitFor(
      (event) => event.type === "paused"
        && event.terminalId === terminalId
        && event.generation === initialGeneration
        && event.direction === "server-to-browser",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(`RELEASE ${holdToken}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
    const repaint = await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "repaint" && entry.id === repaintId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(repaint.bytes).toBe(REPAINT_BYTES);
    // Arm this before reload: the fixture records the repaint before its
    // full write, but the write cannot pass the paused server-to-browser
    // stream until the fault is disposed.
    const repaintWritten = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "write" && entry.bytes === REPAINT_BYTES,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    // Keep the original connection paused through reload to exercise recovery
    // during the active repaint, then release it at the navigation boundary.
    await page.reload();
    pausedServerOutput.dispose();
    await repaintWritten;
  } finally {
    pausedServerOutput.dispose();
  }

  await expect(page.locator(".workbench")).toBeVisible();
  await pane.expectVisible();
  await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await waitForTerminalState(page, terminalId, { acceptingInput: true, pendingParserWrites: 0 }, { timeout: WAIT_TIMEOUT_MS });
  await pane.expectConnected();

  await faultController.waitFor(
    (event) => event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation !== undefined
      && event.generation > initialGeneration,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const afterReloadEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(afterReloadEvents);
  const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
  const connectionOpens = networkEvents.filter((event) => event.type === "connection-open");
  const snapshotFrames = networkEvents.filter((event) => (
    event.type === "frame"
    && event.direction === "server-to-browser"
    && event.frame?.binaryKind === 0
  ));
  const syncMessages = networkEvents.filter((event) => (
    event.type === "frame"
    && event.direction === "server-to-browser"
    && event.frame?.jsonType === "sync"
  ));
  expect(connectionOpens.length, "reload must not enter a reconnect loop").toBeLessThanOrEqual(2);
  expect(syncMessages.length, "reload must not enter a synchronization loop").toBeLessThanOrEqual(2);
  expect(snapshotFrames.length, "reload must not request repeated snapshots").toBeLessThanOrEqual(2);

  const recovered = await pane.snapshot();
  if (!recovered) throw new Error(`no recovered diagnostics snapshot for terminal ${terminalId}`);
  expect(recovered.xterm.text).not.toContain(`[E2E:ALT_ENTER:${altId}]`);
  expect(recovered.xterm.text).toContain(`[E2E:REPAINT:${repaintId}:FRAME]`);
  expect(recovered.xterm.text).toContain("footer");
  expect(recovered.socketState).toBe("connected");
  expect(recovered.activeBuffer).toBe("alternate");
  expect(recovered.syncTarget === undefined || recovered.committedSequence === undefined || recovered.committedSequence >= recovered.syncTarget).toBe(true);

  await pane.sendInput(`ECHO_INPUT ${inputId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(inputText, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === inputId
      && entry.phase === "payload"
      && entry.payload_base64 === inputBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:ECHO_INPUT:${inputId}:${inputBase64}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const beforeFinalSnapshot = await pane.snapshot();
  if (!beforeFinalSnapshot) throw new Error(`no pre-final diagnostics snapshot for terminal ${terminalId}`);
  const beforeFinal = await screenshotRegion(page, pane.xtermHost);
  await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: finalText, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await page.evaluate(async ({ id, minimumRender, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.renderCount > minimumRender && snapshot.pendingParserWrites === 0,
      { timeout },
    );
  }, { id: terminalId, minimumRender: beforeFinalSnapshot.renderCount, timeout: WAIT_TIMEOUT_MS });
  const afterFinal = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeFinal, afterFinal, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-06-final-marker",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "p0-06-final-terminal",
  });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  const finalSnapshot = await pane.snapshot();
  if (!finalSnapshot) throw new Error(`no final diagnostics snapshot for terminal ${terminalId}`);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.renderCount).toBeGreaterThan(0);
  expect(finalSnapshot.activeBuffer).toBe("alternate");
  let footerCount = 0;
  let footerOffset = 0;
  while ((footerOffset = finalSnapshot.xterm.text.indexOf("footer", footerOffset)) !== -1) {
    footerCount += 1;
    footerOffset += "footer".length;
  }
  expect(footerCount, "the recovered TUI must have one current footer").toBe(1);

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  expect(transcript.filter((entry) => entry.event === "repaint" && entry.id === repaintId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === finalId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload")).toHaveLength(1);
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const finalEvents = await terminalEvents(page, terminalId);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  await assertMonotonicSequences(finalEvents);
});
