import { expect, test } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 45_000;
const PROTOCOL_MISMATCH_MESSAGE = "terminal client is out of date; reload the page";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TranscriptEntry = Record<string, unknown>;

interface TerminalApiInfo {
  readonly id: string;
  readonly pid: number | null;
  readonly status: string;
  readonly clients: number;
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

async function waitForProtocolError(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.type === "error" && event.data.kind === "protocol-version",
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForProtocolFailureState(
  page: Page,
  terminalId: string,
  generation: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration >= generation
      && snapshot.socketState === "disconnected"
      && snapshot.activeSocketCount === 0
      && !snapshot.acceptingInput
    ), { timeout });
  }, { id: terminalId, generation, timeout: WAIT_TIMEOUT_MS });
}

function countCommands(entries: readonly TranscriptEntry[], command: string): number {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return entries.filter((entry) => entry.event === "command" && entry.command_base64 === encoded).length;
}

function markerOccurrences(text: string, marker: string): number {
  const comparableText = marker.includes("\n") ? text : text.replaceAll("\n", "");
  let count = 0;
  let offset = 0;
  while ((offset = comparableText.indexOf(marker, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, marker.length);
  }
  return count;
}

test("C-09 Protocol-version mismatch @p1 @nightly @connection @protocol", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const runTag = `C09-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-READY`;
  const beforeId = `${runTag}-BEFORE`;
  const holdToken = `${runTag}-HOLD`;
  const afterId = `${runTag}-AFTER`;
  const sizeId = `${runTag}-SIZE`;
  const echoId = `${runTag}-ECHO`;
  const inputText = `${runTag}-continued-input`;
  const readyMarker = `[E2E:READY:${readyId}]`;
  const beforeMarker = `[E2E:PRINT:${beforeId}:before-mismatch]`;
  const holdMarker = `[E2E:HOLD:${holdToken}]`;
  const afterMarker = `[E2E:PRINT:${afterId}:after-reload]`;
  const echoReadyMarker = `[E2E:ECHO_INPUT:${echoId}:READY]`;
  const echoPayloadMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(inputText, "utf8").toString("base64")}]`;

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

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
  const created = await createResponse.json() as { readonly id: string; readonly name: string };
  expect(mounted.terminalId).toBe(created.id);
  const terminalId = created.id;
  const pane = new TerminalPanePage(page, terminalId, created.name);
  await pane.expectVisible();

  const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.socketGeneration).toBe(1);
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.acceptingInput).toBe(true);
  expect(initial.serverViewport).toBeDefined();
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);
  const initialTerminal = await readTerminal(page, terminalId);
  expect(initialTerminal.id).toBe(terminalId);
  expect(initialTerminal.status).toBe("running");
  expect(initialTerminal.clients).toBe(1);
  if (initialTerminal.pid === null) throw new Error(`terminal ${terminalId} did not expose a fixture PID`);
  const fixturePid = initialTerminal.pid;

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(`PRINT ${beforeId} before-mismatch`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === beforeId && entry.text === "before-mismatch", { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: holdMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c09-before-mismatch-terminal",
  });

  const baseline = await terminalSnapshot(page, terminalId);
  if (!baseline) throw new Error(`missing baseline diagnostics for terminal ${terminalId}`);
  const initialProxy = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
  );
  if (!initialProxy || initialProxy.generation === undefined) throw new Error("initial proxy connection did not expose a generation");
  expect(initialProxy.generation).toBe(baseline.socketGeneration);
  const initialProxyGeneration = initialProxy.generation;

  const initialProxyClosePromise = faultController.waitFor(
    (event) => (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation === initialProxyGeneration,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const finalMismatchUpgradePromise = faultController.waitFor(
    (event) => event.type === "upgrade-request"
      && event.terminalId === terminalId
      && event.generation === initialProxyGeneration + 4,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const protocolErrorPromise = waitForProtocolError(page, terminalId);
  await page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.setProtocolVersion(id, 2);
  }, terminalId);
  await page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.close(id, {
      generation: 1,
      code: 1000,
      reason: "C-09 protocol mismatch boundary",
    });
  }, terminalId);
  const [initialProxyClose, finalMismatchUpgrade, protocolError] = await Promise.all([
    initialProxyClosePromise,
    finalMismatchUpgradePromise,
    protocolErrorPromise,
  ]);
  expect(initialProxyClose.terminalId).toBe(terminalId);
  expect(finalMismatchUpgrade.generation).toBe(initialProxyGeneration + 4);
  expect(protocolError.data.kind).toBe("protocol-version");
  expect(protocolError.data.message).toBe(PROTOCOL_MISMATCH_MESSAGE);

  const failed = await waitForProtocolFailureState(page, terminalId, baseline.socketGeneration + 4);
  expect(failed.socketGeneration).toBeGreaterThanOrEqual(baseline.socketGeneration + 4);
  expect(failed.socketState).toBe("disconnected");
  expect(failed.socketReadyState).toBe(WebSocket.CLOSED);
  expect(failed.activeSocketCount).toBe(0);
  expect(failed.acceptingInput).toBe(false);
  expect(failed.socketUrl).toBeDefined();
  expect(new URL(failed.socketUrl ?? "ws://invalid").searchParams.get("stream")).toBe("2");
  await expectTerminalBuffer(page, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: holdMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c09-protocol-error-terminal",
  });
  const reloadNotice = page.locator(".pane-banner").filter({ hasText: PROTOCOL_MISMATCH_MESSAGE });
  await expect(reloadNotice).toBeVisible({ timeout: WAIT_TIMEOUT_MS });
  await expect(reloadNotice).toHaveText(PROTOCOL_MISMATCH_MESSAGE);

  // A rejected handshake is indistinguishable from a dead server or a dropped
  // network in the browser, so the pane no longer treats it as terminal: it
  // shows the hint and keeps reconnecting at the capped delay. Anything that
  // heals — a restart, a wifi hop, a reload of the far end — therefore brings
  // the pane back on its own.
  const retryUpgrade = await faultController.waitFor(
    (event) => event.type === "upgrade-request"
      && event.terminalId === terminalId
      && event.generation > initialProxyGeneration + 4,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(retryUpgrade.generation).toBeGreaterThan(initialProxyGeneration + 4);
  await expect(reloadNotice).toBeVisible();

  const mismatchEvents = await terminalEvents(page, terminalId);
  const mismatchSockets = mismatchEvents.filter((event) => event.type === "socket-created");
  expect(mismatchSockets.length).toBeGreaterThanOrEqual(6);
  expect(mismatchEvents.filter((event) => event.type === "socket-open")).toHaveLength(1);
  expect(mismatchEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  // The reload hint is raised once, not once per retry.
  expect(mismatchEvents.filter((event) => event.type === "error")).toHaveLength(1);
  for (const event of mismatchSockets.slice(1)) {
    const url = event.data.url;
    expect(typeof url).toBe("string");
    expect(new URL(String(url)).searchParams.get("stream")).toBe("2");
  }
  const proxyUpgradeRequests = faultController.events.filter(
    (event) => event.type === "upgrade-request" && event.terminalId === terminalId,
  );
  expect(proxyUpgradeRequests.length).toBeGreaterThanOrEqual(6);
  expect(proxyUpgradeRequests.slice(1, 5).map((event) => event.generation)).toEqual([
    initialProxyGeneration + 1,
    initialProxyGeneration + 2,
    initialProxyGeneration + 3,
    initialProxyGeneration + 4,
  ]);

  const mismatchTerminal = await readTerminal(page, terminalId);
  expect(mismatchTerminal.id).toBe(terminalId);
  expect(mismatchTerminal.status).toBe("running");
  expect(mismatchTerminal.pid).toBe(fixturePid);
  expect(mismatchTerminal.clients).toBe(0);
  const mismatchTranscript = await server.readTranscript(terminalId);
  expect(mismatchTranscript.filter((entry) => entry.event === "exit")).toHaveLength(0);
  expect(mismatchTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);

  await page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.setProtocolVersion(id);
  }, terminalId);
  await page.reload({ waitUntil: "load" });
  await workbench.expectVisible();
  const recoveredPane = new TerminalPanePage(page, terminalId, created.name);
  await recoveredPane.expectVisible();
  const recovered = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(recovered.socketGeneration).toBe(1);
  expect(recovered.socketState).toBe("connected");
  expect(recovered.activeSocketCount).toBe(1);
  expect(recovered.acceptingInput).toBe(true);
  expect(recovered.serverViewport).toBeDefined();
  expect(recovered.serverViewport?.cols).toBe(recovered.cols);
  expect(recovered.serverViewport?.rows).toBe(recovered.rows);
  await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: holdMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await recoveredPane.sendInput(`RELEASE ${holdToken}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });
  const beforeAfterPixels = await screenshotRegion(page, recoveredPane.xtermHost);
  await recoveredPane.sendInput(`PRINT ${afterId} after-reload`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === afterId && entry.text === "after-reload", { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, recoveredPane.xtermHost, beforeAfterPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "c09-after-reload-marker",
  });

  await recoveredPane.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number }>(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(size.rows).toBe(recovered.rows);
  expect(size.cols).toBe(recovered.cols);
  await recoveredPane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await recoveredPane.sendInput(inputText, true);
  const echoed = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(inputText, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoed.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, terminalId, { contains: echoReadyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: echoPayloadMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await expectTerminalNonBlank(page, recoveredPane.xtermHost, {
    testInfo,
    artifactName: "c09-after-reload-terminal",
  });

  const final = await terminalSnapshot(page, terminalId);
  if (!final) throw new Error(`missing final diagnostics for terminal ${terminalId}`);
  expect(final.socketState).toBe("connected");
  expect(final.activeSocketCount).toBe(1);
  expect(final.acceptingInput).toBe(true);
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  expect(final.serverViewport?.cols).toBe(final.cols);
  expect(final.serverViewport?.rows).toBe(final.rows);
  expect(final.committedSequence).toBe(final.receivedSequence);
  expect(final.committedSequence).toBeGreaterThanOrEqual(initial.committedSequence ?? 0);
  expect(markerOccurrences(final.xterm.text, readyMarker)).toBe(1);
  expect(markerOccurrences(final.xterm.text, beforeMarker)).toBe(1);
  expect(markerOccurrences(final.xterm.text, holdMarker)).toBe(1);
  expect(markerOccurrences(final.xterm.text, afterMarker)).toBe(1);
  expect(markerOccurrences(final.xterm.text, echoPayloadMarker)).toBe(1);

  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  assertNoPendingSynchronization(final);
  assertNoUnexpectedSocketMultiplication([initial, failed, recovered, final]);
  await assertMonotonicSequences(await terminalEvents(page, terminalId));

  const finalTerminal = await readTerminal(page, terminalId);
  expect(finalTerminal.id).toBe(terminalId);
  expect(finalTerminal.status).toBe("running");
  expect(finalTerminal.pid).toBe(fixturePid);
  expect(finalTerminal.clients).toBe(1);
  const finalTranscript = await server.readTranscript(terminalId);
  expect(countCommands(finalTranscript, `READY ${readyId}`)).toBe(1);
  expect(countCommands(finalTranscript, `PRINT ${beforeId} before-mismatch`)).toBe(1);
  expect(countCommands(finalTranscript, `HOLD ${holdToken}`)).toBe(1);
  expect(countCommands(finalTranscript, `RELEASE ${holdToken}`)).toBe(1);
  expect(countCommands(finalTranscript, `PRINT ${afterId} after-reload`)).toBe(1);
  expect(countCommands(finalTranscript, `SIZE ${sizeId}`)).toBe(1);
  expect(countCommands(finalTranscript, `ECHO_INPUT ${echoId}`)).toBe(1);
  expect(countCommands(finalTranscript, inputText)).toBe(1);
  expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(finalTranscript.filter((entry) => entry.event === "exit")).toHaveLength(0);
  const mismatchSocketUrl = failed.socketUrl;
  if (!mismatchSocketUrl) throw new Error(`missing protocol-mismatch socket URL for terminal ${terminalId}`);
  const mismatchUrl = new URL(mismatchSocketUrl);
  expect(mismatchUrl.pathname).toBe(`/api/terminals/${terminalId}/socket`);
  expect(mismatchUrl.searchParams.get("stream")).toBe("2");
  const expectedHandshakeError = `WebSocket connection to '${mismatchSocketUrl}' failed: Error during WebSocket handshake: Unexpected response code: 426`;
  // One per rejected attempt, and the pane keeps attempting until it is told a
  // protocol it can speak, so the count is a floor rather than an exact number.
  expect(browserErrors.filter((message) => message === expectedHandshakeError).length)
    .toBeGreaterThanOrEqual(4);
  expect(browserErrors.filter((message) => message !== expectedHandshakeError)).toEqual([]);
});
