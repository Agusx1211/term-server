import { Buffer } from "node:buffer";
import type { Browser, Page, TestInfo } from "@playwright/test";
import { expect, test, type IsolatedServer } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { E2ETerminalDiagnosticsApi, E2ETerminalEvent, E2ETerminalSnapshot } from "../../src/client/lib/e2e-diagnostics.js";
import type { NetworkFaultController, NetworkFaultDisposer, NetworkFaultEvent } from "../fixtures/network-faults.js";

const WAIT_TIMEOUT_MS = 45_000;
const REPAINT_BYTES = 700_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
  readonly exitCode: number | null;
  readonly clients: number;
  readonly broker?: { readonly version: string; readonly commit: string };
};

type FixtureTerminal = {
  readonly terminalId: string;
  readonly name: string;
  pane: TerminalPanePage;
  readonly pid: number;
  readonly initial: E2ETerminalSnapshot;
  readonly beforePixels: TerminalPixelImage;
  readonly readyId: string;
  readonly beforeId: string;
  readonly beforeText: string;
  readonly repaintId: string;
  readonly sizeId: string;
};

type TriggerResult = {
  readonly networkEvent?: Promise<NetworkFaultEvent>;
  readonly disposer?: NetworkFaultDisposer;
};

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEvent["type"],
  field?: string,
  expected?: string | number,
  timeout = WAIT_TIMEOUT_MS,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, fieldName, expectedValue, waitTimeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => {
        if (event.id <= after || event.type !== eventType) return false;
        if (fieldName === undefined) return true;
        return event.data[fieldName] === expectedValue;
      },
      { timeout: waitTimeout },
    );
  }, {
    id: terminalId,
    after: afterEventId,
    eventType: type,
    fieldName: field,
    expectedValue: expected,
    waitTimeout: timeout,
  });
}

async function waitForTerminalQuiescent(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0,
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo | undefined> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    return terminals.find((terminal) => terminal.id === id);
  }, terminalId);
}

async function readClientConfig(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`config request failed with HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  });
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

function upgradeHeaders(): Record<string, string> {
  return {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
}

function websocketUrl(baseURL: string, terminalId: string, stream: number): string {
  const url = new URL(`/api/terminals/${terminalId}/socket`, baseURL);
  url.searchParams.set("stream", String(stream));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function observeRejectedWebSocket(page: Page, url: string): Promise<{ readonly code: number; readonly reason: string }> {
  return page.evaluate((target) => new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
    const socket = new WebSocket(target);
    socket.addEventListener("error", () => undefined);
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
  }), url);
}

async function probeHandshake(
  browser: Browser,
  baseURL: string,
  terminalId: string,
  mode: "protocol" | "auth",
): Promise<void> {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto(baseURL);
    if (mode === "protocol") await new LoginPage(page).login();
    const headers = upgradeHeaders();
    const cookies = await context.cookies(baseURL);
    if (cookies.length > 0) headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const request = await context.request.get(
      websocketUrl(baseURL, terminalId, mode === "protocol" ? 2 : 3).replace(/^ws/, "http"),
      { headers, maxRedirects: 0 },
    );
    const body = await request.text();
    expect(request.status()).toBe(mode === "protocol" ? 426 : 401);
    if (mode === "protocol") expect(body).toContain("terminal client is out of date; reload the page");
    const rejected = await observeRejectedWebSocket(
      page,
      websocketUrl(baseURL, terminalId, mode === "protocol" ? 2 : 3),
    );
    expect(rejected.code).toBe(1006);
  } finally {
    await context.close();
  }
}

async function createFixtureTerminal(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  testInfo: TestInfo,
  caseTag: string,
): Promise<FixtureTerminal> {
  const runTag = `C06-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}-${caseTag}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-ready`;
  const beforeId = `${runTag}-before`;
  const repaintId = `${runTag}-repaint`;
  const sizeId = `${runTag}-size`;
  const beforeText = `${runTag}-before-fault`;

  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const created = await response.json() as TerminalApiInfo;
  expect(created.name).not.toBe("");
  if (created.pid === null) throw new Error(`terminal ${created.id} did not expose a running fixture PID`);

  const pane = new TerminalPanePage(page, created.id, created.name);
  await pane.expectVisible();
  const initial = await expectTerminalInteractive(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalConverged(page, created.id, { cols: initial.cols, rows: initial.rows }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: `[E2E:READY:${readyId}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: `[E2E:PRINT:${beforeId}:${beforeText}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`REPAINT ${repaintId} ${REPAINT_BYTES}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === REPAINT_BYTES, { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(created.id, (entry) => entry.event === "write" && entry.bytes === REPAINT_BYTES, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, created.id, { contains: `[E2E:REPAINT:${repaintId}:FRAME]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(created.id, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
  expect(size.rows).toBe(initial.rows);
  expect(size.cols).toBe(initial.cols);
  await waitForTerminalQuiescent(page, created.id);

  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: `c-06-${caseTag}-before-fault`,
  });

  return {
    terminalId: created.id,
    name: created.name,
    pane,
    pid: created.pid,
    initial,
    beforePixels,
    readyId,
    beforeId,
    beforeText,
    repaintId,
    sizeId,
  };
}


async function finishRecoveredTerminal(
  page: Page,
  server: IsolatedServer,
  testInfo: TestInfo,
  fixture: FixtureTerminal,
  afterId: string,
  afterText: string,
  inputId: string,
  inputText: string,
  artifactTag: string,
): Promise<E2ETerminalSnapshot> {
  const { pane, terminalId } = fixture;
  await pane.sendInput(`PRINT ${afterId} ${afterText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === afterId && entry.text === afterText, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:PRINT:${afterId}:${afterText}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`ECHO_INPUT ${inputId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.insertText(inputText);
  await pane.press("Enter");
  const echoed = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === inputId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(inputText, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoed.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${inputId}:${Buffer.from(inputText, "utf8").toString("base64")}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const final = await waitForTerminalQuiescent(page, terminalId);
  await expectTerminalConverged(page, terminalId, { cols: fixture.initial.cols, rows: fixture.initial.rows }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:PRINT:${fixture.beforeId}:${fixture.beforeText}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:REPAINT:${fixture.repaintId}:FRAME]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:PRINT:${afterId}:${afterText}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const afterPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: `c-06-${artifactTag}-after-recovery`,
  });
  await expectTerminalPixelsChanged(fixture.beforePixels, afterPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `c-06-${artifactTag}-recovery-pixels`,
  });

  expect(final.socketState).toBe("connected");
  expect(final.activeSocketCount).toBe(1);
  expect(final.socket.activeCount).toBe(1);
  expect(final.acceptingInput).toBe(true);
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  await expect(pane.root.locator(".pane-stream-status")).toHaveCount(0);
  await expect(pane.root.locator(".pane-banner")).toHaveCount(0);
  assertNoPendingSynchronization(final);
  assertNoUnexpectedSocketMultiplication([fixture.initial, final]);

  const terminal = await readTerminal(page, terminalId);
  expect(terminal?.status).toBe("running");
  expect(terminal?.pid).toBe(fixture.pid);
  expect(terminal?.clients).toBe(1);
  const transcript = await server.readTranscript(terminalId);

  expect(countEntries(transcript, (entry) => entry.event === "ready" && entry.id === fixture.readyId)).toBe(1);
  expect(countEntries(transcript, (entry) => entry.event === "print" && entry.id === fixture.beforeId)).toBe(1);
  expect(countEntries(transcript, (entry) => entry.event === "repaint" && entry.id === fixture.repaintId)).toBe(1);
  expect(countEntries(transcript, (entry) => entry.event === "print" && entry.id === afterId)).toBe(1);
  expect(countEntries(transcript, (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload")).toBe(1);
  expect(countEntries(transcript, (entry) => entry.event === "error")).toBe(0);
  expect(final.receivedSequence).toBe(outputByteCount(transcript));
  expect(final.committedSequence).toBe(outputByteCount(transcript));

  const events = await terminalEvents(page, terminalId);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  await assertMonotonicSequences(events);
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  return final;
}

async function recoverAfterFault(
  page: Page,
  server: IsolatedServer,
  testInfo: TestInfo,
  fixture: FixtureTerminal,
  trigger: (baseline: E2ETerminalEvent, networkGeneration: number) => Promise<TriggerResult>,
  afterId: string,
  afterText: string,
  inputId: string,
  inputText: string,
  artifactTag: string,
): Promise<E2ETerminalSnapshot> {
  const baselineEvents = await terminalEvents(page, fixture.terminalId);
  const baseline = baselineEvents.at(-1);
  if (!baseline) throw new Error(`terminal ${fixture.terminalId} has no baseline diagnostics event`);
  const baselineGeneration = fixture.initial.socketGeneration;
  const socketClosePromise = waitForDiagnosticEventAfter(page, fixture.terminalId, baseline.id, "socket-close");
  const disconnectedPromise = waitForDiagnosticEventAfter(page, fixture.terminalId, baseline.id, "state", "state", "disconnected");
  const reconnectPromise = waitForDiagnosticEventAfter(page, fixture.terminalId, baseline.id, "socket-created");
  const syncedPromise = waitForDiagnosticEventAfter(page, fixture.terminalId, baseline.id, "synced");
  const triggerResult = await trigger(baseline, baselineGeneration);
  const networkEvent = triggerResult.networkEvent ? await triggerResult.networkEvent : undefined;
  triggerResult.disposer?.dispose();
  const [socketClose, disconnected, reconnect, synced] = await Promise.all([
    socketClosePromise,
    disconnectedPromise,
    reconnectPromise,
    syncedPromise,
  ]);

  expect(socketClose.data.generation).toBe(baselineGeneration);
  expect(disconnected.snapshot.socketState).toBe("disconnected");
  expect(disconnected.snapshot.activeSocketCount).toBe(0);
  expect(disconnected.snapshot.acceptingInput).toBe(false);
  const reconnectGeneration = reconnect.data.generation;
  expect(typeof reconnectGeneration).toBe("number");
  expect(reconnectGeneration).toBe(baselineGeneration + 1);
  expect(synced.snapshot.socketState).toBe("connected");
  expect(synced.snapshot.activeSocketCount).toBe(1);
  if (networkEvent) {
    expect(networkEvent.terminalId).toBe(fixture.terminalId);
    expect(networkEvent.generation).toBeGreaterThanOrEqual(1);
  }

  const final = await finishRecoveredTerminal(
    page,
    server,
    testInfo,
    fixture,
    afterId,
    afterText,
    inputId,
    inputText,
    artifactTag,
  );
  const events = await terminalEvents(page, fixture.terminalId);
  const recoverySockets = events.filter((event) => event.type === "socket-created" && event.id > baseline.id);
  const recoverySyncs = events.filter((event) => event.type === "synced" && event.id > baseline.id);
  expect(recoverySockets).toHaveLength(1);
  expect(recoverySyncs).toHaveLength(1);
  return final;
}

async function removeTerminal(page: Page, fixture: FixtureTerminal): Promise<void> {
  const unmountPromise = waitForDiagnosticEventAfter(
    page,
    fixture.terminalId,
    (await terminalEvents(page, fixture.terminalId)).at(-1)?.id ?? 0,
    "unmount",
  );
  const removeResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "DELETE" && url.pathname === `/api/terminals/${fixture.terminalId}`;
  });
  await fixture.pane.kill();
  const [removeResponse, unmounted] = await Promise.all([removeResponsePromise, unmountPromise]);
  expect(removeResponse.status()).toBe(204);
  expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
  expect(unmounted.snapshot.lifecycle.visible).toBe(false);
  expect(unmounted.snapshot.activeSocketCount).toBe(0);
  expect(unmounted.snapshot.socket.activeCount).toBe(0);
  expect(unmounted.snapshot.socketState).not.toBe("connected");
  await expect(fixture.pane.root).toHaveCount(0);
  expect(await readTerminal(page, fixture.terminalId)).toBeUndefined();
}

async function clientCloseTrigger(
  page: Page,
  faultController: NetworkFaultController,
  terminalId: string,
  code: number,
  reason: string,
  networkGeneration: number,
): Promise<TriggerResult> {
  const networkEvent = faultController.waitFor(
    (event) => (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation === networkGeneration
      && event.code === code,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await page.evaluate(({ id, closeCode, closeReason }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.close(id, { code: closeCode, reason: closeReason });
  }, { id: terminalId, closeCode: code, closeReason: reason });
  return { networkEvent };
}

async function proxyCloseTrigger(
  faultController: NetworkFaultController,
  terminalId: string,
  code: number,
  reason: string,
  networkGeneration: number,
): Promise<TriggerResult> {
  const networkEvent = faultController.waitFor(
    (event) => event.type === "connection-closed"
      && event.terminalId === terminalId
      && event.generation === networkGeneration
      && event.code === code,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const closeSent = faultController.waitFor(
    (event) => event.type === "close-sent"
      && event.terminalId === terminalId
      && event.generation === networkGeneration
      && event.code === code
      && event.direction === "server-to-browser",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const disposer = faultController.close({
    direction: "server-to-browser",
    matcher: { terminalId, generation: networkGeneration },
    code,
    reason,
  });
  await closeSent;
  return { networkEvent, disposer };
}

async function abruptCloseTrigger(
  faultController: NetworkFaultController,
  terminalId: string,
  networkGeneration: number,
): Promise<TriggerResult> {
  const networkEvent = faultController.waitFor(
    (event) => event.type === "connection-terminated"
      && event.terminalId === terminalId
      && event.generation === networkGeneration
      && event.code === 1006
      && event.abrupt === true,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const disposer = faultController.terminate({ terminalId, generation: networkGeneration });
  return { networkEvent, disposer };
}


async function expireAuthentication(page: Page): Promise<void> {
  const response = await page.evaluate(async () => {
    const result = await fetch("/api/e2e/auth/expire", { method: "POST" });
    return { status: result.status, body: await result.json() as Record<string, unknown> };
  });
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(true);
}

test("C-06 Server close codes @p1 @nightly", async ({ browser, page, server, faultController, baseURL }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const workbench = new WorkbenchPage(page);
  await page.goto(baseURL);
  await new LoginPage(page).login();
  await workbench.expectVisible();

  const protocolAuthFixture = await createFixtureTerminal(page, workbench, server, testInfo, "handshake");
  await probeHandshake(browser, baseURL, protocolAuthFixture.terminalId, "protocol");
  await probeHandshake(browser, baseURL, protocolAuthFixture.terminalId, "auth");
  const handshakeTerminal = await readTerminal(page, protocolAuthFixture.terminalId);
  expect(handshakeTerminal?.pid).toBe(protocolAuthFixture.pid);
  expect(handshakeTerminal?.clients).toBe(1);
  const handshakeEvents = await terminalEvents(page, protocolAuthFixture.terminalId);
  expect(handshakeEvents.filter((event) => event.type === "error")).toHaveLength(0);
  await expectTerminalInteractive(page, protocolAuthFixture.terminalId, { timeout: WAIT_TIMEOUT_MS });
  await removeTerminal(page, protocolAuthFixture);

  const clean = await createFixtureTerminal(page, workbench, server, testInfo, "clean");
  await recoverAfterFault(
    page,
    server,
    testInfo,
    clean,
    (_baseline, generation) => proxyCloseTrigger(faultController, clean.terminalId, 1000, "C06 clean pane close", generation),
    `${clean.terminalId}-after-clean`,
    "C06 clean-close recovered output",
    `${clean.terminalId}-clean-input-id`,
    "C06 clean-close continued input",
    "clean-close",
  );
  const cleanNetworkEvents = faultController.events.filter((event) => event.terminalId === clean.terminalId);
  expect(cleanNetworkEvents.some((event) => event.type === "connection-closed" && event.code === 1000)).toBe(true);
  expect(cleanNetworkEvents.filter((event) => event.type === "connection-open")).toHaveLength(2);
  await removeTerminal(page, clean);

  const timeout = await createFixtureTerminal(page, workbench, server, testInfo, "timeout");
  await recoverAfterFault(
    page,
    server,
    testInfo,
    timeout,
    (_baseline, generation) => clientCloseTrigger(page, faultController, timeout.terminalId, 4001, "Terminal connection timed out", generation),
    `${timeout.terminalId}-after-timeout`,
    "C06 timeout recovered output",
    `${timeout.terminalId}-timeout-input-id`,
    "C06 timeout continued input",
    "client-4001-timeout",
  );
  const timeoutNetwork = faultController.events.filter((event) => event.terminalId === timeout.terminalId);
  expect(timeoutNetwork.some((event) => (event.type === "connection-closed" || event.type === "connection-terminated") && event.code === 4001)).toBe(true);
  await removeTerminal(page, timeout);

  const protocolError = await createFixtureTerminal(page, workbench, server, testInfo, "protocol-error");
  await recoverAfterFault(
    page,
    server,
    testInfo,
    protocolError,
    (_baseline, generation) => clientCloseTrigger(page, faultController, protocolError.terminalId, 4002, "Invalid terminal stream", generation),
    `${protocolError.terminalId}-after-protocol-error`,
    "C06 protocol-error recovered output",
    `${protocolError.terminalId}-protocol-error-input-id`,
    "C06 protocol-error continued input",
    "client-4002-protocol-error",
  );
  const protocolNetwork = faultController.events.filter((event) => event.terminalId === protocolError.terminalId);
  expect(protocolNetwork.some((event) => (event.type === "connection-closed" || event.type === "connection-terminated") && event.code === 4002)).toBe(true);
  await removeTerminal(page, protocolError);

  const backlog = await createFixtureTerminal(page, workbench, server, testInfo, "backlog");
  await recoverAfterFault(
    page,
    server,
    testInfo,
    backlog,
    (_baseline, generation) => clientCloseTrigger(page, faultController, backlog.terminalId, 4003, "Terminal renderer fell behind", generation),
    `${backlog.terminalId}-after-backlog`,
    "C06 backlog recovered output",
    `${backlog.terminalId}-backlog-input-id`,
    "C06 backlog continued input",
    "client-4003-backlog",
  );
  const backlogNetwork = faultController.events.filter((event) => event.terminalId === backlog.terminalId);
  expect(backlogNetwork.some((event) => (event.type === "connection-closed" || event.type === "connection-terminated") && event.code === 4003)).toBe(true);
  await removeTerminal(page, backlog);

  const abnormal = await createFixtureTerminal(page, workbench, server, testInfo, "abnormal");
  await recoverAfterFault(
    page,
    server,
    testInfo,
    abnormal,
    (_baseline, generation) => abruptCloseTrigger(faultController, abnormal.terminalId, generation),
    `${abnormal.terminalId}-after-abnormal`,
    "C06 abnormal recovered output",
    `${abnormal.terminalId}-abnormal-input-id`,
    "C06 abnormal continued input",
    "abnormal-close",
  );
  const abnormalNetwork = faultController.events.filter((event) => event.terminalId === abnormal.terminalId);
  expect(abnormalNetwork.some((event) => event.type === "connection-terminated" && event.code === 1006 && event.abrupt === true)).toBe(true);
  await removeTerminal(page, abnormal);

  const auth = await createFixtureTerminal(page, workbench, server, testInfo, "auth-expiry");
  const authEvents = await terminalEvents(page, auth.terminalId);
  const authBaseline = authEvents.at(-1)?.id ?? 0;
  expect(authEvents.filter((event) => event.type === "error")).toHaveLength(0);
  const authUnmountPromise = waitForDiagnosticEventAfter(page, auth.terminalId, authBaseline, "unmount");
  await expireAuthentication(page);
  await new LoginPage(page).expectVisible();
  const authUnmount = await authUnmountPromise;
  expect(authUnmount.snapshot.lifecycle.mounted).toBe(false);
  expect(authUnmount.snapshot.activeSocketCount).toBe(0);
  expect(authUnmount.snapshot.socket.activeCount).toBe(0);
  expect(authUnmount.snapshot.socketState).not.toBe("connected");

  await new LoginPage(page).login();
  await workbench.expectVisible();
  const openPanes = await workbench.terminalPaneIds();
  const reauthenticatedPane = openPanes.includes(auth.terminalId)
    ? workbench.terminal(auth.terminalId, auth.name)
    : await workbench.openTerminal({ id: auth.terminalId, name: auth.name });
  auth.pane = reauthenticatedPane;
  await auth.pane.expectVisible();
  await expectTerminalInteractive(page, auth.terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, auth.terminalId, { contains: `[E2E:PRINT:${auth.beforeId}:${auth.beforeText}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const authAfter = await finishRecoveredTerminal(
    page,
    server,
    testInfo,
    auth,
    `${auth.terminalId}-after-auth`,
    "C06 after-authentication recovery",
    `${auth.terminalId}-auth-input-id`,
    "C06 authentication continued input",
    "authentication-expiry",
  );
  expect(authAfter.socketState).toBe("connected");
  const authTerminal = await readTerminal(page, auth.terminalId);
  expect(authTerminal?.pid).toBe(auth.pid);
  await removeTerminal(page, auth);

  const broker = await createFixtureTerminal(page, workbench, server, testInfo, "broker-shutdown");
  const brokerBeforeEvents = await terminalEvents(page, broker.terminalId);
  const brokerBaseline = brokerBeforeEvents.at(-1);
  if (!brokerBaseline) throw new Error(`terminal ${broker.terminalId} has no broker baseline event`);
  const brokerConfigBefore = await readClientConfig(page);
  const brokerBefore = brokerConfigBefore.broker as { readonly generations?: readonly Record<string, unknown>[] } | undefined;
  expect(brokerBefore?.generations).toEqual(expect.any(Array));
  const conflict = await page.evaluate(async () => {
    const response = await fetch("/api/broker/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ closeTerminals: false }),
    });
    return { status: response.status, body: await response.text() };
  });
  expect(conflict.status).toBe(409);
  expect(conflict.body).toContain("current build");
  await expectTerminalInteractive(page, broker.terminalId, { timeout: WAIT_TIMEOUT_MS });

  const brokerReconnect = waitForDiagnosticEventAfter(page, broker.terminalId, brokerBaseline.id, "socket-created");
  const brokerSync = waitForDiagnosticEventAfter(page, broker.terminalId, brokerBaseline.id, "synced");
  const brokerClose = waitForDiagnosticEventAfter(page, broker.terminalId, brokerBaseline.id, "socket-close");
  const restartResponse = await page.evaluate(async () => {
    const response = await fetch("/api/e2e/server/restart", { method: "POST" });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  });
  expect(restartResponse.status).toBe(200);
  expect(restartResponse.body.ok).toBe(true);
  const [brokerSocketClose, brokerSocketCreated, brokerSynced] = await Promise.all([brokerClose, brokerReconnect, brokerSync]);
  expect(brokerSocketClose.data.generation).toBe(broker.initial.socketGeneration);
  expect(brokerSocketCreated.data.generation).toBe(broker.initial.socketGeneration + 1);
  expect(brokerSynced.snapshot.socketState).toBe("connected");
  await finishRecoveredTerminal(
    page,
    server,
    testInfo,
    broker,
    `${broker.terminalId}-after-broker`,
    "C06 after-broker-shutdown recovery",
    `${broker.terminalId}-broker-input-id`,
    "C06 broker continued input",
    "broker-shutdown",
  );
  const brokerAfter = await readTerminal(page, broker.terminalId);
  expect(brokerAfter?.status).toBe("running");
  expect(brokerAfter?.pid).toBe(broker.pid);
  expect(brokerAfter?.clients).toBe(1);
  expect(brokerAfter?.broker).toBeDefined();
  const brokerConfigAfter = await readClientConfig(page);
  const brokerAfterInfo = brokerConfigAfter.broker as { readonly generations?: readonly Record<string, unknown>[] } | undefined;
  expect(brokerAfterInfo?.generations).toEqual(expect.any(Array));
  expect(brokerAfterInfo?.generations?.some((generation) => generation.current === true)).toBe(true);
  await removeTerminal(page, broker);

  const allEvents = faultController.events.filter((event) => event.terminalId);
  expect(allEvents.filter((event) => event.type === "socket-error")).toHaveLength(0);
  expect(server.process?.exitCode ?? null).toBeNull();
  const browserFailures = browserErrors().filter((entry) => entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message));
  expect(browserFailures).toEqual([]);
  browserErrors.dispose();
});
