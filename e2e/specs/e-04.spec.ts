import { test, expect } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { Page } from "@playwright/test";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConverged,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 20_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TranscriptEntry = Record<string, unknown>;

async function waitForRendererReady(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.webglLoadCount > 0 || snapshot.fallbackCount > 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForReadyState(
  page: Page,
  terminalId: string,
  minimumSocketGeneration?: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimumGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.syncMode === undefined
      && snapshot.syncTarget === undefined
      && (minimumGeneration === undefined || snapshot.socketGeneration > minimumGeneration)
    ), { timeout });
  }, { id: terminalId, minimumGeneration: minimumSocketGeneration, timeout: WAIT_TIMEOUT_MS });
}

async function waitForInputDisabled(
  page: Page,
  terminalId: string,
  socketGeneration: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration === generation
      && !snapshot.acceptingInput
      && snapshot.activeSocketCount === 0
    ), { timeout });
  }, { id: terminalId, generation: socketGeneration, timeout: WAIT_TIMEOUT_MS });
}

async function waitForEvent(
  page: Page,
  terminalId: string,
  type: E2ETerminalEventType,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, eventType, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, eventType, { timeout });
  }, { id: terminalId, eventType: type, timeout: WAIT_TIMEOUT_MS });
}

function marker(kind: string, ...fields: string[]): string {
  return `[E2E:${kind}:${fields.join(":")}]`;
}

function countOccurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
}

function echoMarker(id: string, input: string): string {
  return marker("ECHO_INPUT", id, Buffer.from(input, "utf8").toString("base64"));
}

function commandCount(entries: readonly TranscriptEntry[], command: string): number {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return entries.filter((entry) => entry.event === "command" && entry.command_base64 === encoded).length;
}

test("E-04 Browser exception containment @e @nightly @browser-errors", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `E04-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const initialId = `${runTag}-INITIAL`;
  const initialText = `${runTag}-MODEL`;
  const fallbackId = `${runTag}-FALLBACK`;
  const fallbackText = `${runTag}-RENDERED`;
  const preFaultEchoId = `${runTag}-ECHO-PRE`;
  const preFaultInput = `${runTag}-input-before-parser-fault`;
  const postFaultId = `${runTag}-RECOVERED`;
  const postFaultText = `${runTag}-RECOVERED-MARKER`;
  const postFaultEchoId = `${runTag}-ECHO-POST`;
  const postFaultInput = `${runTag}-continued-input-after-parser-fault`;
  const initialMarker = marker("PRINT", initialId, initialText);
  const fallbackMarker = marker("PRINT", fallbackId, fallbackText);
  const postFaultMarker = marker("PRINT", postFaultId, postFaultText);
  const preFaultEchoMarker = echoMarker(preFaultEchoId, preFaultInput);
  const postFaultEchoMarker = echoMarker(postFaultEchoId, postFaultInput);

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  // The renderer fault must be installed between real unmount and mount so the
  // production addon import and xterm fallback path are exercised.
  const settings = await workbench.openSettings();
  await settings.setCachedTerminalLimit(0);
  await workbench.closeSettings();

  const mountPromise = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.snapshot.kind === "pane",
      { timeout },
    );
  }, WAIT_TIMEOUT_MS);
  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const [mounted, createResponse] = await Promise.all([mountPromise, createResponsePromise]);
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as { readonly id?: unknown; readonly name?: unknown };
  if (typeof created.id !== "string" || typeof created.name !== "string") {
    throw new Error("terminal creation response omitted id or name");
  }
  const terminalId = created.id;
  const terminalName = created.name;
  expect(mounted.terminalId).toBe(terminalId);

  const firstPane = new TerminalPanePage(page, terminalId, terminalName);
  await firstPane.expectVisible();
  const firstScreen = firstPane.xtermHost.locator(".xterm-screen");
  await expect(firstScreen).toBeVisible();
  const initialRenderer = await waitForRendererReady(page, terminalId);
  const initialReady = await waitForReadyState(page, terminalId);
  expect(initialRenderer.rendererState.kind).toBe(initialRenderer.renderer);
  expect(initialReady.activeSocketCount).toBe(1);
  expect(initialReady.serverViewport).toBeDefined();
  expect(initialReady.serverViewport?.cols).toBe(initialReady.cols);
  expect(initialReady.serverViewport?.rows).toBe(initialReady.rows);

  const beforeInitial = await screenshotRegion(page, firstScreen);
  const initialPrint = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === initialId && entry.text === initialText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await firstPane.sendInput(`PRINT ${initialId} ${initialText}`, true);
  await initialPrint;
  await expectTerminalBuffer(page, terminalId, { contains: initialMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, firstScreen, beforeInitial, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "e04-initial-marker",
  });
  await expectTerminalNonBlank(page, firstScreen, {
    testInfo,
    artifactName: "e04-initial-terminal",
  });

  const unmountPromise = waitForEvent(page, terminalId, "unmount");
  await firstPane.closePane();
  const unmount = await unmountPromise;
  expect(unmount.snapshot.lifecycle.mounted).toBe(false);
  expect(unmount.snapshot.lifecycle.acceptingInput).toBe(false);
  expect(unmount.snapshot.activeSocketCount).toBe(0);
  expect(unmount.snapshot.socket.activeCount).toBe(0);
  await expect(firstPane.root).toHaveCount(0);
  const afterUnmountTranscript = await server.readTranscript(terminalId);
  expect(afterUnmountTranscript.filter((entry) => entry.event === "exit")).toHaveLength(0);

  await page.evaluate(({ id, message }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.renderer.failWebGL(id, { message });
  }, { id: terminalId, message: `${runTag} forced WebGL addon failure` });

  const reopenedPane = new TerminalPanePage(page, terminalId, terminalName);
  const fallbackEventPromise = waitForEvent(page, terminalId, "renderer-fallback");
  const reopenedReadyPromise = waitForReadyState(page, terminalId);
  await workbench.openTerminal({ id: terminalId, name: terminalName });
  await reopenedPane.expectVisible();
  const fallbackScreen = reopenedPane.xtermHost.locator(".xterm-screen");
  await expect(fallbackScreen).toBeVisible();
  const [fallbackEvent, reopenedReady] = await Promise.all([fallbackEventPromise, reopenedReadyPromise]);
  expect(fallbackEvent.data.reason).toBe("load-failed");
  expect(fallbackEvent.snapshot.renderer).toBe("canvas");
  expect(fallbackEvent.snapshot.webglLoadCount).toBe(1);
  expect(fallbackEvent.snapshot.fallbackCount).toBe(1);
  expect(reopenedReady.renderer).toBe("canvas");
  expect(reopenedReady.rendererState.kind).toBe("canvas");
  expect(reopenedReady.webglLoadCount).toBe(1);
  expect(reopenedReady.fallbackCount).toBe(1);
  expect(reopenedReady.activeSocketCount).toBe(1);
  await expectTerminalConverged(page, terminalId, {
    cols: reopenedReady.cols,
    rows: reopenedReady.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: initialMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const beforeFallback = await screenshotRegion(page, fallbackScreen);
  const fallbackPrint = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === fallbackId && entry.text === fallbackText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await reopenedPane.sendInput(`PRINT ${fallbackId} ${fallbackText}`, true);
  await fallbackPrint;
  await expectTerminalBuffer(page, terminalId, { contains: fallbackMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, fallbackScreen, beforeFallback, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "e04-fallback-marker",
  });
  await expectTerminalNonBlank(page, fallbackScreen, {
    testInfo,
    artifactName: "e04-fallback-terminal",
  });

  const preFaultArmed = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === preFaultEchoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await reopenedPane.sendInput(`ECHO_INPUT ${preFaultEchoId}`, true);
  await preFaultArmed;
  const preFaultEcho = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === preFaultEchoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(preFaultInput, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await reopenedPane.sendInput(preFaultInput, true);
  await preFaultEcho;
  await expectTerminalBuffer(page, terminalId, { contains: preFaultEchoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const beforeParser = await waitForReadyState(page, terminalId);
  const proxyConnection = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation === beforeParser.socketGeneration,
  );
  if (!proxyConnection || proxyConnection.generation === undefined) {
    throw new Error("parser-fault connection did not expose a proxy generation");
  }
  const proxyGeneration = beforeParser.socketGeneration;
  const parserNotice = page.getByRole("status").filter({ hasText: "terminal frame is missing its header" });
  const noticePromise = expect(parserNotice).toBeVisible({ timeout: WAIT_TIMEOUT_MS });
  const disabledPromise = waitForInputDisabled(page, terminalId, beforeParser.socketGeneration);
  const injectedPromise = faultController.waitFor(
    (event) => event.type === "injected"
      && event.terminalId === terminalId
      && event.generation === proxyGeneration
      && event.direction === "server-to-browser",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const closePromise = faultController.waitFor(
    (event) => (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation === proxyGeneration,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const recoveryOpenPromise = faultController.waitFor(
    (event) => event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation === proxyGeneration + 1,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const malformedTerminalFrame = faultController.inject({
    direction: "server-to-browser",
    data: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
    binary: true,
    matcher: { terminalId, generation: proxyGeneration },
  });
  const [injected, closeEvent, disabled, recoveryOpen] = await Promise.all([
    injectedPromise,
    closePromise,
    disabledPromise,
    recoveryOpenPromise,
    noticePromise,
  ]);
  malformedTerminalFrame.dispose();
  expect(injected.direction).toBe("server-to-browser");
  expect(injected.bytes).toBeGreaterThan(8);
  expect(closeEvent.code).toBe(4002);
  expect(disabled.acceptingInput).toBe(false);
  expect(disabled.activeSocketCount).toBe(0);
  expect(["closed", "disconnected", "recovering"]).toContain(disabled.socketState);
  expect(recoveryOpen.generation).toBe(proxyGeneration + 1);

  const recovered = await waitForReadyState(page, terminalId, beforeParser.socketGeneration);
  expect(recovered.socketGeneration).toBe(beforeParser.socketGeneration + 1);
  expect(recovered.socketState).toBe("connected");
  expect(recovered.activeSocketCount).toBe(1);
  expect(recovered.acceptingInput).toBe(true);
  expect(recovered.pendingParserWrites).toBe(0);
  expect(recovered.pendingParserBytes).toBe(0);
  expect(recovered.renderBacklogBytes).toBe(0);
  expect(recovered.renderBacklogFrames).toBe(0);
  expect(recovered.syncMode).toBeUndefined();
  expect(recovered.syncTarget).toBeUndefined();
  expect(recovered.committedSequence).toBe(recovered.receivedSequence);
  expect(recovered.serverViewport?.cols).toBe(recovered.cols);
  expect(recovered.serverViewport?.rows).toBe(recovered.rows);
  expect(recovered.xterm.text).toContain(initialMarker);
  expect(recovered.xterm.text).toContain(fallbackMarker);
  expect(recovered.xterm.text).toContain(preFaultEchoMarker);

  const beforeRecovered = await screenshotRegion(page, fallbackScreen);
  const recoveredPrint = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === postFaultId && entry.text === postFaultText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await reopenedPane.sendInput(`PRINT ${postFaultId} ${postFaultText}`, true);
  await recoveredPrint;
  await expectTerminalBuffer(page, terminalId, { contains: postFaultMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, fallbackScreen, beforeRecovered, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "e04-recovered-marker",
  });

  const postFaultArmed = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === postFaultEchoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await reopenedPane.sendInput(`ECHO_INPUT ${postFaultEchoId}`, true);
  await postFaultArmed;
  const postFaultEcho = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === postFaultEchoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(postFaultInput, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await reopenedPane.sendInput(postFaultInput, true);
  await postFaultEcho;
  await expectTerminalBuffer(page, terminalId, { contains: postFaultEchoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const final = await waitForReadyState(page, terminalId);
  expect(final.renderer).toBe("canvas");
  expect(final.fallbackCount).toBe(1);
  expect(final.activeSocketCount).toBe(1);
  expect(final.socket.activeCount).toBe(1);
  expect(final.committedSequence).toBe(final.receivedSequence);
  expect(countOccurrences(final.xterm.text, initialMarker)).toBe(1);
  expect(countOccurrences(final.xterm.text, fallbackMarker)).toBe(1);
  expect(countOccurrences(final.xterm.text, preFaultEchoMarker)).toBe(1);
  expect(countOccurrences(final.xterm.text, postFaultMarker)).toBe(1);
  expect(countOccurrences(final.xterm.text, postFaultEchoMarker)).toBe(1);
  await expectTerminalNonBlank(page, fallbackScreen, {
    testInfo,
    artifactName: "e04-recovered-terminal",
  });
  await expectTerminalConverged(page, terminalId, {
    cols: final.cols,
    rows: final.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  assertNoUnexpectedSocketMultiplication([beforeParser, disabled, recovered, final]);

  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(2);
  expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === initialId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === fallbackId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === postFaultId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === preFaultEchoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === postFaultEchoId && entry.phase === "payload")).toHaveLength(1);
  expect(commandCount(transcript, `PRINT ${initialId} ${initialText}`)).toBe(1);
  expect(commandCount(transcript, `PRINT ${fallbackId} ${fallbackText}`)).toBe(1);
  expect(commandCount(transcript, `PRINT ${postFaultId} ${postFaultText}`)).toBe(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(0);

  const parserFaultEvents = faultController.events.filter((event) => (
    event.terminalId === terminalId
    && event.generation === proxyGeneration
    && (event.type === "injected" || event.type === "connection-closed" || event.type === "connection-terminated")
  ));
  expect(parserFaultEvents.filter((event) => event.type === "injected")).toHaveLength(1);
  expect(parserFaultEvents.filter((event) => (
    (event.type === "connection-closed" || event.type === "connection-terminated") && event.code === 4002
  ))).toHaveLength(1);
  expect(faultController.events.filter((event) => (
    event.type === "connection-open" && event.terminalId === terminalId && event.generation === proxyGeneration + 1
  ))).toHaveLength(1);

  const finalUnmountPromise = waitForEvent(page, terminalId, "unmount");
  await reopenedPane.closePane();
  const finalUnmount = await finalUnmountPromise;
  expect(finalUnmount.snapshot.lifecycle.mounted).toBe(false);
  expect(finalUnmount.snapshot.lifecycle.acceptingInput).toBe(false);
  expect(finalUnmount.snapshot.activeSocketCount).toBe(0);
  expect(finalUnmount.snapshot.socket.activeCount).toBe(0);
  await expect(reopenedPane.root).toHaveCount(0);

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
    || /unhandled(?:promise)?|uncaught/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors, "browser addon/parser containment produced an uncaught error").toEqual([]);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
});
