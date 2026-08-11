import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import type { TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  terminalEvents,
  terminalSnapshot,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import LoginPage from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 45_000;
const RECONNECT_HANDSHAKE_DELAY_MS = 5_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type CreatedTerminal = {
  readonly id: string;
  readonly name: string;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
};

type EventGeneration = {
  readonly exact?: number;
  readonly greaterThan?: number;
};

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function occurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = value.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + Math.max(needle.length, 1);
  }
}

function commandCount(entries: readonly TranscriptEntry[], command: string): number {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return entries.filter((entry) => entry.event === "command" && entry.command_base64 === encoded).length;
}

function outputByteCount(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.event !== "write") return total;
    const bytes = entry.bytes;
    return total + (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0);
  }, 0);
}

async function createNamedTerminal(page: Page, workbench: WorkbenchPage, name: string): Promise<CreatedTerminal> {
  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as { readonly id?: unknown; readonly name?: unknown };
  if (typeof created.id !== "string" || typeof created.name !== "string") {
    throw new Error("terminal creation response did not include an id and name");
  }
  await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => snapshot.mounted, { timeout });
  }, { id: created.id, timeout: WAIT_TIMEOUT_MS });
  await workbench.sidebar.renameTerminal({ id: created.id, name: created.name }, name);
  await expect(await workbench.sidebar.terminalRow({ id: created.id, name })).toBeVisible();
  return { id: created.id, name };
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

async function requiredSnapshot(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  const snapshot = await terminalSnapshot(page, terminalId);
  if (!snapshot) throw new Error(`missing diagnostics snapshot for terminal ${terminalId}`);
  return snapshot;
}

async function sendFocusedLine(page: Page, pane: TerminalPanePage, line: string): Promise<void> {
  await expect(pane.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  eventType: E2ETerminalEventType,
  generation?: EventGeneration,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, type, exactGeneration, greaterThan, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === type
      && (exactGeneration === undefined || event.snapshot.socketGeneration === exactGeneration)
      && (greaterThan === undefined || event.snapshot.socketGeneration > greaterThan)
    ), { timeout, afterId: after });
  }, {
    id: terminalId,
    after: afterEventId,
    type: eventType,
    exactGeneration: generation?.exact,
    greaterThan: generation?.greaterThan,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForActivePane(page: Page, pane: TerminalPanePage): Promise<E2ETerminalSnapshot> {
  const snapshot = await waitForTerminalState(page, pane.terminalId, {
    mounted: true,
    visible: true,
    active: true,
    acceptingInput: true,
    socketState: "connected",
    activeSocketCount: 1,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expect(pane.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();
  return snapshot;
}

async function waitForInactivePane(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.mounted
      && snapshot.visible
      && !snapshot.active
      && !snapshot.focused
      && !snapshot.acceptingInput
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function assertFocusedRoot(page: Page, pane: TerminalPanePage): Promise<void> {
  await expect(pane.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();
  const rootContainsFocus = await page.evaluate((id) => {
    const root = document.querySelector(`section[role="region"][data-terminal-id="${id.replace(/["\\]/g, "\\$&")}"]`);
    return root?.contains(document.activeElement) ?? false;
  }, pane.terminalId);
  expect(rootContainsFocus).toBe(true);
}

function latestSizeEvent(events: readonly E2ETerminalEvent[]): E2ETerminalEvent | undefined {
  return [...events].reverse().find((event) => event.type === "size");
}

function latestProxyGeneration(
  events: readonly { readonly type: string; readonly terminalId?: string; readonly generation?: number }[],
  terminalId: string,
): number {
  const generation = [...events].reverse().find((event) => (
    event.type === "connection-open"
    && event.terminalId === terminalId
    && event.generation !== undefined
  ))?.generation;
  if (generation === undefined) throw new Error(`missing proxy generation for terminal ${terminalId}`);
  return generation;
}

test("@p1 @chromium-pr @focus-reconnect @nightly W-04 Background pane does not steal focus", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `W04-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}-${Date.now()}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const aName = "W04-A";
  const bName = "W04-B";
  const bReadyId = `${runTag}-B-READY`;
  const bSizeId = `${runTag}-B-SIZE`;
  const bHoldToken = `${runTag}-B-HOLD`;
  const bPrintId = `${runTag}-W04-B`;
  const bPrintText = "W04-B-during-reconnect";
  const bQueryId = `${runTag}-W04-B-QUERY`;
  const aEchoId = `${runTag}-W04-A-ECHO`;
  const aInputText = "active-input";
  const aReadyMarker = marker("ECHO_INPUT", aEchoId, "READY");
  const aPayloadMarker = marker("ECHO_INPUT", aEchoId, Buffer.from(aInputText, "utf8").toString("base64"));
  const bPrintMarker = marker("PRINT", bPrintId, bPrintText);
  const bQueryCompleteMarker = marker("QUERY", bQueryId, "COMPLETE", "6");
  const readyBCommand = `READY ${bReadyId}`;
  const sizeBCommand = `SIZE ${bSizeId}`;
  const holdCommand = `HOLD ${bHoldToken}`;
  const printBCommand = `PRINT ${bPrintId} ${bPrintText}`;
  const queryBCommand = `QUERY ${bQueryId}`;
  const releaseCommand = `RELEASE ${bHoldToken}`;
  const echoStartCommand = `ECHO_INPUT ${aEchoId}`;
  let pauseRule: { dispose: () => void } | undefined;
  let delayRule: { dispose: () => void } | undefined;

  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const terminalA = await createNamedTerminal(page, workbench, aName);
  const terminalB = await createNamedTerminal(page, workbench, bName);
  const paneA = workbench.terminal(terminalA.id, terminalA.name);
  const paneB = workbench.terminal(terminalB.id, terminalB.name);
  await workbench.openTerminal(terminalA);
  await paneA.expectVisible();
  await workbench.sidebar.splitTerminal(terminalB);
  await paneB.expectVisible();
  await expect.poll(() => workbench.visiblePaneCount()).toBe(2);

  await waitForTerminalState(page, terminalA.id, { socketState: "connected", activeSocketCount: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await waitForTerminalState(page, terminalB.id, { socketState: "connected", activeSocketCount: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await paneA.focus();
  await waitForActivePane(page, paneA);
  await waitForInactivePane(page, terminalB.id);
  const initialA = await requiredSnapshot(page, terminalA.id);
  const beforeB = await requiredSnapshot(page, terminalB.id);
  const initialBEvents = await terminalEvents(page, terminalB.id);
  const initialBEventFloor = initialBEvents.at(-1)?.id ?? -1;
  const initialBWinchCount = (await server.readTranscript(terminalB.id)).filter((entry) => entry.event === "sigwinch").length;
  const initialAProxyGeneration = latestProxyGeneration(faultController.events, terminalA.id);
  const initialBProxyGeneration = latestProxyGeneration(faultController.events, terminalB.id);
  expect(initialAProxyGeneration).toBe(initialA.socketGeneration);
  expect(initialBProxyGeneration).toBe(beforeB.socketGeneration);
  await assertFocusedRoot(page, paneA);

  await paneB.focus();
  await waitForTerminalState(page, terminalB.id, { active: true, socketState: "connected", acceptingInput: true }, { timeout: WAIT_TIMEOUT_MS });
  const beforeBOutputPixels = await screenshotRegion(page, paneB.xtermHost);
  await sendFocusedLine(page, paneB, readyBCommand);
  await server.waitForTranscript(terminalB.id, (entry) => entry.event === "ready" && entry.id === bReadyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await sendFocusedLine(page, paneB, sizeBCommand);
  const initialAInfo = await readTerminal(page, terminalA.id);
  const initialBInfo = await readTerminal(page, terminalB.id);
  const bSize = await server.waitForTranscript<{ readonly event: "size"; readonly id: string; readonly rows: number; readonly cols: number }>(
    terminalB.id,
    (entry) => entry.event === "size" && entry.id === bSizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const baselineB = await waitForTerminalState(page, terminalB.id, {
    visible: true,
    active: true,
    socketState: "connected",
    activeSocketCount: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(bSize.rows).toBe(baselineB.rows);
  expect(bSize.cols).toBe(baselineB.cols);
  await expectTerminalConverged(page, terminalB.id, { rows: bSize.rows, cols: bSize.cols }, { timeout: WAIT_TIMEOUT_MS });

  await sendFocusedLine(page, paneB, holdCommand);
  await server.waitForTranscript(terminalB.id, (entry) => entry.event === "hold" && entry.token === bHoldToken, { timeoutMs: WAIT_TIMEOUT_MS });
  await sendFocusedLine(page, paneB, printBCommand);
  await server.waitForTranscript(terminalB.id, (entry) => (
    entry.event === "command"
    && entry.operation === "PRINT"
    && entry.command_base64 === Buffer.from(printBCommand, "utf8").toString("base64")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  // The QUERY is queued behind the held PRINT. It is fixture output from B;
  // after A takes focus, B must not answer its own parser queries.
  await sendFocusedLine(page, paneB, queryBCommand);

  pauseRule = faultController.pause("server-to-browser", {
    terminalId: terminalB.id,
    generation: initialBProxyGeneration,
  });
  await faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalB.id
    && event.generation === initialBProxyGeneration
    && event.direction === "server-to-browser"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await sendFocusedLine(page, paneB, releaseCommand);
  await server.waitForTranscript(terminalB.id, (entry) => entry.event === "release" && entry.token === bHoldToken, { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(terminalB.id, (entry) => entry.event === "print" && entry.id === bPrintId && entry.text === bPrintText, { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(terminalB.id, (entry) => entry.event === "write" && entry.text === `${bPrintMarker}\n`, { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(terminalB.id, (entry) => entry.event === "command" && entry.operation === "QUERY" && entry.command_base64 === Buffer.from(queryBCommand, "utf8").toString("base64"), { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(terminalB.id, (entry) => entry.event === "query" && entry.id === bQueryId && entry.name === "cell_pixels", { timeoutMs: WAIT_TIMEOUT_MS });

  await paneA.focus();
  await waitForActivePane(page, paneA);
  await waitForInactivePane(page, terminalB.id);
  await assertFocusedRoot(page, paneA);
  const inactiveNetworkEventFloor = faultController.events.length;
  const beforeAInputPixels = await screenshotRegion(page, paneA.xtermHost);
  const inactiveB = await requiredSnapshot(page, terminalB.id);
  expect(inactiveB.active).toBe(false);
  expect(inactiveB.focused).toBe(false);
  expect(inactiveB.socketGeneration).toBe(baselineB.socketGeneration);

  delayRule = faultController.delayUpgrade({ terminalId: terminalB.id }, RECONNECT_HANDSHAKE_DELAY_MS);
  try {
    const bEventsBeforeClose = await terminalEvents(page, terminalB.id);
    const bEventCursor = bEventsBeforeClose.at(-1)?.id ?? initialBEventFloor;
    const proxyEventFloor = faultController.events.length;
    const proxyClosePromise = faultController.waitFor((event) => (
      faultController.events.indexOf(event) >= proxyEventFloor
      && (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalB.id
      && event.generation === initialBProxyGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const proxyOpenPromise = faultController.waitFor((event) => (
      faultController.events.indexOf(event) >= proxyEventFloor
      && event.type === "connection-open"
      && event.terminalId === terminalB.id
      && event.generation !== undefined
      && event.generation > initialBProxyGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const delayedUpgradePromise = faultController.waitFor((event) => (
      faultController.events.indexOf(event) >= proxyEventFloor
      && event.type === "upgrade-delay"
      && event.terminalId === terminalB.id
      && event.generation !== undefined
      && event.generation > initialBProxyGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const diagnosticClosePromise = waitForDiagnosticEventAfter(page, terminalB.id, bEventCursor, "socket-close", { exact: baselineB.socketGeneration });
    const diagnosticOpenPromise = waitForDiagnosticEventAfter(page, terminalB.id, bEventCursor, "socket-open", { greaterThan: baselineB.socketGeneration });
    const diagnosticSyncedPromise = waitForDiagnosticEventAfter(page, terminalB.id, bEventCursor, "synced", { greaterThan: baselineB.socketGeneration });

    await page.evaluate(({ id, generation }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      api.controls.socket.close(id, { generation, abrupt: true, reason: "W04 background reconnect" });
    }, { id: terminalB.id, generation: baselineB.socketGeneration });
    const [diagnosticClose, proxyClose] = await Promise.all([diagnosticClosePromise, proxyClosePromise]);
    expect(diagnosticClose.snapshot.activeSocketCount).toBe(0);
    expect(diagnosticClose.snapshot.active).toBe(false);
    expect(diagnosticClose.snapshot.focused).toBe(false);
    expect(proxyClose.generation).toBe(initialBProxyGeneration);
    pauseRule?.dispose();
    pauseRule = undefined;

    const delayedUpgrade = await delayedUpgradePromise;
    expect(delayedUpgrade.generation).toBeGreaterThan(initialBProxyGeneration);
    const reconnectingA = await waitForActivePane(page, paneA);
    expect(reconnectingA.socketGeneration).toBe(initialA.socketGeneration);
    const reconnectingB = await requiredSnapshot(page, terminalB.id);
    expect(reconnectingB.active).toBe(false);
    expect(reconnectingB.focused).toBe(false);
    expect(reconnectingB.socketState).not.toBe("connected");
    await assertFocusedRoot(page, paneA);

    const echoArmedPromise = server.waitForTranscript(terminalA.id, (entry) => entry.event === "echo_input" && entry.id === aEchoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await sendFocusedLine(page, paneA, echoStartCommand);
    await echoArmedPromise;
    await expectTerminalBuffer(page, terminalA.id, { contains: aReadyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await assertFocusedRoot(page, paneA);

    const [diagnosticOpen, diagnosticSynced, proxyOpen] = await Promise.all([
      diagnosticOpenPromise,
      diagnosticSyncedPromise,
      proxyOpenPromise,
    ]);
    expect(diagnosticOpen.snapshot.socketGeneration).toBeGreaterThan(baselineB.socketGeneration);
    expect(diagnosticSynced.snapshot.socketGeneration).toBe(diagnosticOpen.snapshot.socketGeneration);
    expect(proxyOpen.generation).toBe(diagnosticOpen.snapshot.socketGeneration);

    const recoveredB = await waitForInactivePane(page, terminalB.id);
    expect(recoveredB.socketGeneration).toBe(diagnosticOpen.snapshot.socketGeneration);
    expect(recoveredB.socketState).toBe("connected");
    expect(recoveredB.activeSocketCount).toBe(1);
    expect(recoveredB.socket.activeCount).toBe(1);
    expect(recoveredB.renderBacklogBytes).toBe(0);
    expect(recoveredB.renderBacklogFrames).toBe(0);
    await expectTerminalBuffer(page, terminalB.id, { contains: bPrintMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    expect(occurrences(recoveredB.xterm.text, bPrintMarker)).toBe(1);
    expect(recoveredB.xterm.text).not.toContain(aPayloadMarker);
    await expectTerminalNonBlank(page, paneB.xtermHost, {
      testInfo,
      artifactName: "w-04-background-b-recovered",
    });
    await expectKnownMarkerChanged(page, paneB.xtermHost, beforeBOutputPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "w-04-background-b-marker",
    });

    const echoPayloadPromise = server.waitForTranscript(terminalA.id, (entry) => (
      entry.event === "echo_input"
      && entry.id === aEchoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(aInputText, "utf8").toString("base64")
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await sendFocusedLine(page, paneA, aInputText);
    await echoPayloadPromise;
    await expectTerminalBuffer(page, terminalA.id, { contains: aPayloadMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await assertFocusedRoot(page, paneA);
    await expectKnownMarkerChanged(page, paneA.xtermHost, beforeAInputPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "w-04-active-a-input",
    });
    await expectTerminalNonBlank(page, paneA.xtermHost, {
      testInfo,
      artifactName: "w-04-active-a-final",
    });

    const finalA = await waitForActivePane(page, paneA);
    const finalB = await requiredSnapshot(page, terminalB.id);
    expect(finalA.socketGeneration).toBe(initialA.socketGeneration);
    expect(finalA.active).toBe(true);
    expect(finalA.acceptingInput).toBe(true);
    expect(finalB.active).toBe(false);
    expect(finalB.focused).toBe(false);
    expect(finalB.socketGeneration).toBe(diagnosticOpen.snapshot.socketGeneration);
    expect(finalB.socketGeneration).toBeGreaterThan(baselineB.socketGeneration);
    expect(finalB.activeSocketCount).toBe(1);
    expect(finalB.socket.activeCount).toBe(1);
    expect(finalB.flowControlled).toBe(false);
    expect(finalB.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(finalB.syncMode).toBeUndefined();
    expect(finalB.syncTarget).toBeUndefined();
    expect(finalA.flowControlled).toBe(false);
    expect(finalA.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    assertNoPendingSynchronization(finalA);
    assertNoPendingSynchronization(finalB);
    await expectNoPendingRecovery(page, terminalA.id, { timeout: WAIT_TIMEOUT_MS });
    await expectNoPendingRecovery(page, terminalB.id, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalConverged(page, terminalA.id, { cols: initialA.cols, rows: initialA.rows }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalConverged(page, terminalB.id, { cols: baselineB.cols, rows: baselineB.rows }, { timeout: WAIT_TIMEOUT_MS });

    const finalATranscript = await server.readTranscript(terminalA.id);
    const finalBTranscript = await server.readTranscript(terminalB.id);
    expect(commandCount(finalATranscript, echoStartCommand)).toBe(1);
    expect(commandCount(finalATranscript, aInputText)).toBe(1);
    expect(commandCount(finalBTranscript, readyBCommand)).toBe(1);
    expect(commandCount(finalBTranscript, sizeBCommand)).toBe(1);
    expect(commandCount(finalBTranscript, holdCommand)).toBe(1);
    expect(commandCount(finalBTranscript, printBCommand)).toBe(1);
    expect(commandCount(finalBTranscript, queryBCommand)).toBe(1);
    expect(commandCount(finalBTranscript, releaseCommand)).toBe(1);
    expect(finalATranscript.filter((entry) => entry.event === "echo_input" && entry.id === aEchoId && entry.phase === "payload")).toHaveLength(1);
    expect(finalBTranscript.filter((entry) => entry.event === "print" && entry.id === bPrintId && entry.text === bPrintText)).toHaveLength(1);
    expect(finalBTranscript.filter((entry) => entry.event === "write" && entry.text === `${bPrintMarker}\n`)).toHaveLength(1);
    expect(finalBTranscript.filter((entry) => entry.event === "query" && entry.id === bQueryId)).toHaveLength(6);
    expect(finalBTranscript.filter((entry) => entry.event === "query_complete" && entry.id === bQueryId)).toHaveLength(0);
    expect(finalBTranscript.filter((entry) => entry.event === "write" && entry.text === `${bQueryCompleteMarker}\n`)).toHaveLength(0);
    expect(finalBTranscript.filter((entry) => entry.event === "echo_input" && entry.id === aEchoId)).toHaveLength(0);
    expect(finalATranscript.filter((entry) => entry.event === "query_complete" && entry.id === bQueryId)).toHaveLength(0);
    expect(finalBTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
    expect(finalATranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
    expect(finalBTranscript.filter((entry) => entry.event === "exit")).toHaveLength(0);
    expect(finalATranscript.filter((entry) => entry.event === "exit")).toHaveLength(0);
    expect(finalBTranscript.filter((entry) => entry.event === "sigwinch")).toHaveLength(initialBWinchCount);
    expect(finalA.receivedSequence).toBe(outputByteCount(finalATranscript));
    expect(finalA.committedSequence).toBe(outputByteCount(finalATranscript));
    expect(finalB.receivedSequence).toBe(outputByteCount(finalBTranscript));
    expect(finalB.committedSequence).toBe(outputByteCount(finalBTranscript));

    const inactiveBInputFrames = faultController.events.slice(inactiveNetworkEventFloor).filter((event) => (
      event.type === "frame"
      && event.terminalId === terminalB.id
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "input"
    ));
    expect(inactiveBInputFrames, "inactive B emitted browser input/query replies").toEqual([]);
    const aEvents = await terminalEvents(page, terminalA.id);
    const bEvents = await terminalEvents(page, terminalB.id);
    await assertMonotonicSequences(aEvents);
    await assertMonotonicSequences(bEvents);
    expect(aEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
    expect(bEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
    expect(aEvents.filter((event) => event.type === "error")).toHaveLength(0);
    expect(bEvents.filter((event) => event.type === "error")).toHaveLength(0);
    expect(bEvents.filter((event) => event.type === "socket-created")).toHaveLength(2);
    expect(bEvents.filter((event) => event.type === "socket-open")).toHaveLength(2);
    expect(bEvents.filter((event) => event.type === "socket-close")).toHaveLength(1);
    expect(bEvents.filter((event) => event.type === "sync")).toHaveLength(2);
    expect(bEvents.filter((event) => event.type === "synced")).toHaveLength(2);
    expect(bEvents.filter((event) => event.type === "socket-close")[0]?.snapshot.activeSocketCount).toBe(0);
    expect(bEvents.filter((event) => event.type === "socket-close")[0]?.data.generation).toBe(baselineB.socketGeneration);
    expect(bEvents.filter((event) => event.type === "focus" && event.snapshot.focused)).toHaveLength(0);
    const latestA = latestSizeEvent(aEvents);
    const latestB = latestSizeEvent(bEvents);
    expect(latestA?.data.responder).toBe(true);
    expect(latestB?.data.responder).toBe(false);
    expect(latestB?.data.focused).toBe(false);
    expect(finalB.renderer).toBe(baselineB.renderer);
    expect(finalB.webglLoadCount).toBe(baselineB.webglLoadCount);
    expect(finalB.contextLossCount).toBe(baselineB.contextLossCount);
    expect(finalB.fallbackCount).toBe(baselineB.fallbackCount);
    expect(finalB.renderCount).toBeGreaterThan(baselineB.renderCount);
    expect(finalA.renderer).toBe(initialA.renderer);
    expect(finalA.webglLoadCount).toBe(initialA.webglLoadCount);
    expect(finalA.contextLossCount).toBe(initialA.contextLossCount);
    expect(finalA.fallbackCount).toBe(initialA.fallbackCount);
    expect(finalA.renderCount).toBeGreaterThan(initialA.renderCount);
    const canvasCounts = await Promise.all([paneA, paneB].map((pane) => pane.xtermHost.locator("canvas").count()));
    if (finalA.renderer === "dom") expect(canvasCounts[0]).toBe(0);
    else expect(canvasCounts[0]).toBeGreaterThan(0);
    if (finalB.renderer === "dom") expect(canvasCounts[1]).toBe(0);
    else expect(canvasCounts[1]).toBeGreaterThan(0);
    await expectTerminalNonBlank(page, paneB.xtermHost, {
      testInfo,
      artifactName: "w-04-background-b-final",
    });
    const aInvariant = await expectConnectedTerminalInvariants(page, terminalA.id, { timeout: WAIT_TIMEOUT_MS });
    const bInvariant = await expectTerminalInvariants(page, terminalB.id, { timeout: WAIT_TIMEOUT_MS });
    expect(aInvariant.violations).toEqual([]);
    expect(bInvariant.violations).toEqual([]);
    expect(faultController.events.filter((event) => event.type === "socket-error" || event.type === "malformed-frame")).toHaveLength(0);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error|internal server error)/i);
    const finalAInfo = await readTerminal(page, terminalA.id);
    const finalBInfo = await readTerminal(page, terminalB.id);
    expect(finalAInfo.id).toBe(terminalA.id);
    expect(finalBInfo.id).toBe(terminalB.id);
    expect(finalAInfo.status).toBe("running");
    expect(finalBInfo.status).toBe("running");
    expect(finalAInfo.pid).toBe(initialAInfo.pid);
    expect(finalBInfo.pid).toBe(initialBInfo.pid);
    assertNoUnexpectedSocketMultiplication([initialA, beforeB, baselineB, finalA, finalB]);
    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || entry.kind === "console" && /^error:/i.test(entry.message)
      || entry.kind === "websocket" && entry.message === "error"
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    browserErrors.dispose();
  } finally {
    pauseRule?.dispose();
    delayRule?.dispose();
  }
});
