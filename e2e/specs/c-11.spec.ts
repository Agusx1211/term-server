import { Buffer } from "node:buffer";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConnected,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
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

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  id: string;
  pid: number | null;
  status: "running" | "exited";
  clients: number;
};

const WAIT_TIMEOUT_MS = 30_000;
const UPGRADE_HOLD_MS = 5_000;
const E2E_PASSWORD = "e2e-development";

function marker(testId: string, label: string): string {
  const safeTestId = testId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `C011-${safeTestId}-${label}`;
}

function occurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += Math.max(needle.length, 1);
  }
  return count;
}

async function expireSession(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/e2e/auth/expire", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ ok: true });
}

async function sessionStatus(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { authenticated?: boolean };
    return response.ok && body.authenticated === true;
  });
}

async function terminalInfo(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} is absent from the authenticated listing`);
    return terminal;
  }, terminalId);
}

async function waitForSocketEvent(
  page: Page,
  terminalId: string,
  type: Extract<E2ETerminalEventType, "socket-created" | "socket-close">,
  generation: number,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, type, generation, afterEventId, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > afterEventId && event.type === type && event.data.generation === generation,
      { timeout },
    );
  }, { id: terminalId, type, generation, afterEventId, timeout: WAIT_TIMEOUT_MS });
}

function terminalPath(terminalId: string): string {
  return `/api/terminals/${terminalId}/socket`;
}

function unexpectedBrowserErrors(entries: readonly { kind: string; message: string }[]): readonly unknown[] {
  return entries.filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || (entry.kind === "console" && /^error:/i.test(entry.message))
  ));
}

async function assertRunningTerminal(page: Page, terminalId: string, expectedPid: number): Promise<TerminalApiInfo> {
  const info = await terminalInfo(page, terminalId);
  expect(info.status).toBe("running");
  expect(info.pid).toBe(expectedPid);
  expect(info.pid).toBeGreaterThan(0);
  return info;
}

async function assertTerminalOutput(
  page: Page,
  pane: TerminalPanePage,
  terminalId: string,
  lines: readonly string[],
  testInfo: TestInfo,
): Promise<E2ETerminalSnapshot> {
  for (const line of lines) {
    await expectTerminalBuffer(page, terminalId, { contains: line, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  }
  const snapshot = await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(snapshot.xterm.text).not.toBe("");
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "c11-output",
  });
  return snapshot;
}

test("C-11 Authentication session expires @nightly", async ({ page, baseURL, server, faultController }, testInfo) => {
  const errors = installBrowserErrorCollectors(page);
  await page.goto(baseURL);
  await new LoginPage(page).login(E2E_PASSWORD);

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();
  const paneHost = workbench.editorGrid.locator("[data-terminal-id]").first();
  await expect(paneHost).toHaveAttribute("data-terminal-id", /.+/);
  const terminalId = await paneHost.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("new terminal did not expose a stable terminal id");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();

  const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.acceptingInput).toBe(true);
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);
  const initialInfo = await terminalInfo(page, terminalId);
  expect(initialInfo.status).toBe("running");
  expect(initialInfo.pid).toBeGreaterThan(0);
  if (initialInfo.pid === null) throw new Error("running terminal did not expose a PTY pid");
  const pid = initialInfo.pid;

  const readyId = marker(testInfo.testId, "ready");
  const beforeId = marker(testInfo.testId, "before");
  const beforeText = marker(testInfo.testId, "before-expiry");
  const holdA = marker(testInfo.testId, "active-hold");
  const afterActiveId = marker(testInfo.testId, "after-active-reauth");
  const afterActiveText = marker(testInfo.testId, "after-active");
  const inputA = marker(testInfo.testId, "active-input");
  const inputAText = marker(testInfo.testId, "continued-after-active");
  const holdB = marker(testInfo.testId, "reconnect-hold");
  const afterReconnectId = marker(testInfo.testId, "after-reconnect-reauth");
  const afterReconnectText = marker(testInfo.testId, "after-reconnect");
  const inputB = marker(testInfo.testId, "reconnect-input");
  const inputBText = marker(testInfo.testId, "continued-after-reconnect");
  const sizeId = marker(testInfo.testId, "final-size");

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const beforeLine = `[E2E:PRINT:${beforeId}:${beforeText}]`;
  await expectTerminalBuffer(page, terminalId, { contains: beforeLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(`HOLD ${holdA}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdA, { timeoutMs: WAIT_TIMEOUT_MS });
  const beforeExpiryPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "c11-before-expiry",
  });

  const unmountAfterActiveExpiry = pane.waitForEvent("unmount", { timeout: WAIT_TIMEOUT_MS });
  await expireSession(page);
  const unmountedAfterActiveExpiry = await unmountAfterActiveExpiry;
  expect(unmountedAfterActiveExpiry.type).toBe("unmount");
  expect(unmountedAfterActiveExpiry.snapshot.mounted).toBe(false);
  expect(unmountedAfterActiveExpiry.snapshot.activeSocketCount).toBe(0);
  expect(unmountedAfterActiveExpiry.snapshot.acceptingInput).toBe(false);
  await new LoginPage(page).expectVisible();
  expect(await sessionStatus(page)).toBe(false);

  const activeExpiryTranscript = await server.readTranscript(terminalId);
  expect(activeExpiryTranscript.some((entry) => entry.event === "exit")).toBe(false);

  const loginAfterActiveExpiry = new LoginPage(page);
  await loginAfterActiveExpiry.login(E2E_PASSWORD);
  await workbench.expectVisible();
  const paneAfterActiveExpiry = new TerminalPanePage(page, terminalId);
  await paneAfterActiveExpiry.expectVisible();
  await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: beforeLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await assertRunningTerminal(page, terminalId, pid);
  const afterActivePixels = await screenshotRegion(page, paneAfterActiveExpiry.xtermHost);
  await expectTerminalNonBlank(page, paneAfterActiveExpiry.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "c11-after-active-reauth",
  });
  await expectTerminalPixelsChanged(beforeExpiryPixels, afterActivePixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "c11-active-reauth-pixels",
  });

  await paneAfterActiveExpiry.sendInput(`RELEASE ${holdA}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdA, { timeoutMs: WAIT_TIMEOUT_MS });
  await paneAfterActiveExpiry.sendInput(`PRINT ${afterActiveId} ${afterActiveText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === afterActiveId && entry.text === afterActiveText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await paneAfterActiveExpiry.sendInput(`ECHO_INPUT ${inputA}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === inputA && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await paneAfterActiveExpiry.sendInput(inputAText, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === inputA && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const afterActiveLine = `[E2E:PRINT:${afterActiveId}:${afterActiveText}]`;
  const inputALine = `[E2E:ECHO_INPUT:${inputA}:${Buffer.from(inputAText, "utf8").toString("base64")}]`;
  await assertTerminalOutput(page, paneAfterActiveExpiry, terminalId, [beforeLine, afterActiveLine, inputALine], testInfo);
  const activeReauthConverged = await expectTerminalConverged(page, terminalId, {
    cols: initial.cols,
    rows: initial.rows,
    pixelWidth: initial.pixelWidth,
    pixelHeight: initial.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(activeReauthConverged.serverViewport?.cols).toBe(initial.cols);
  expect(activeReauthConverged.serverViewport?.rows).toBe(initial.rows);
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const activeInvariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(activeInvariantReport.violations).toEqual([]);
  const activeEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(activeEvents);
  expect(activeEvents.filter((event) => event.type === "error")).toEqual([]);

  await paneAfterActiveExpiry.sendInput(`HOLD ${holdB}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdB, { timeoutMs: WAIT_TIMEOUT_MS });
  const beforeReconnectPixels = await screenshotRegion(page, paneAfterActiveExpiry.xtermHost);
  const beforeReconnectSnapshot = await paneAfterActiveExpiry.snapshot();
  if (!beforeReconnectSnapshot) throw new Error("missing diagnostics snapshot before reconnect expiry");
  expect(beforeReconnectSnapshot.activeSocketCount).toBe(1);
  const beforeReconnectEvents = await terminalEvents(page, terminalId);
  const eventCursor = beforeReconnectEvents.at(-1)?.id ?? 0;
  const browserGeneration = beforeReconnectSnapshot.socketGeneration;
  const proxyConnection = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
  );
  if (proxyConnection?.generation === undefined) throw new Error("missing proxy generation before reconnect expiry");
  const proxyGeneration = proxyConnection.generation;
  const delayedProxyGeneration = proxyGeneration + 1;
  const delayedBrowserGeneration = browserGeneration + 1;

  const delayedReconnect = faultController.delayUpgrade(
    { terminalId, generation: delayedProxyGeneration },
    UPGRADE_HOLD_MS,
  );
  try {
    const initialProxyTermination = faultController.waitFor(
      (event) => event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.generation === proxyGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const initialSocketClose = waitForSocketEvent(page, terminalId, "socket-close", browserGeneration, eventCursor);
    const heldUpgrade = faultController.waitFor(
      (event) => event.type === "upgrade-delay"
        && event.terminalId === terminalId
        && event.generation === delayedProxyGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const delayedSocketCreated = waitForSocketEvent(page, terminalId, "socket-created", delayedBrowserGeneration, eventCursor);
    const terminateInitial = faultController.terminate({ terminalId, generation: proxyGeneration });
    await Promise.all([initialProxyTermination, initialSocketClose, heldUpgrade, delayedSocketCreated]);
    terminateInitial.dispose();

    const heldSnapshot = await paneAfterActiveExpiry.snapshot();
    expect(heldSnapshot?.socketState).toBe("connecting");
    expect(heldSnapshot?.activeSocketCount).toBe(1);

    const faultEventCursor = faultController.events.length;
    const unmountAfterReconnectExpiry = paneAfterActiveExpiry.waitForEvent("unmount", { timeout: WAIT_TIMEOUT_MS });
    await expireSession(page);
    expect(await sessionStatus(page)).toBe(false);

    const heldProxyTermination = faultController.waitFor(
      (event) => event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.generation === delayedProxyGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const heldSocketClose = waitForSocketEvent(page, terminalId, "socket-close", delayedBrowserGeneration, eventCursor);
    const terminateHeld = faultController.terminate({ terminalId, generation: delayedProxyGeneration });
    await Promise.all([heldProxyTermination, heldSocketClose]);
    terminateHeld.dispose();

    const failedUpgradeRequest = faultController.waitFor(
      (event) => event.type === "upgrade-request"
        && event.terminalId === terminalId
        && event.generation !== undefined
        && event.generation > delayedProxyGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const observedFailedUpgrade = await failedUpgradeRequest;
    expect(observedFailedUpgrade.path).toBe(terminalPath(terminalId));

    const unmountedAfterReconnectExpiry = await unmountAfterReconnectExpiry;
    expect(unmountedAfterReconnectExpiry.type).toBe("unmount");
    expect(unmountedAfterReconnectExpiry.snapshot.mounted).toBe(false);
    expect(unmountedAfterReconnectExpiry.snapshot.activeSocketCount).toBe(0);
    expect(unmountedAfterReconnectExpiry.snapshot.acceptingInput).toBe(false);
    await new LoginPage(page).expectVisible();

    const reconnectFaultEvents = faultController.events.slice(faultEventCursor);
    const reconnectRequests = reconnectFaultEvents.filter(
      (event) => event.type === "upgrade-request" && event.terminalId === terminalId,
    );
    expect(reconnectRequests).toHaveLength(1);
    expect(reconnectFaultEvents.filter(
      (event) => (event.type === "upgrade-open" || event.type === "connection-open") && event.terminalId === terminalId,
    )).toEqual([]);
  } finally {
    delayedReconnect.dispose();
  }

  const loginAfterReconnectExpiry = new LoginPage(page);
  await loginAfterReconnectExpiry.login(E2E_PASSWORD);
  await workbench.expectVisible();
  const paneAfterReconnectExpiry = new TerminalPanePage(page, terminalId);
  await paneAfterReconnectExpiry.expectVisible();
  await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: beforeLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: afterActiveLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await assertRunningTerminal(page, terminalId, pid);

  await paneAfterReconnectExpiry.sendInput(`RELEASE ${holdB}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdB, { timeoutMs: WAIT_TIMEOUT_MS });
  await paneAfterReconnectExpiry.sendInput(`PRINT ${afterReconnectId} ${afterReconnectText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === afterReconnectId && entry.text === afterReconnectText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await paneAfterReconnectExpiry.sendInput(`ECHO_INPUT ${inputB}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === inputB && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await paneAfterReconnectExpiry.sendInput(inputBText, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === inputB && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const afterReconnectLine = `[E2E:PRINT:${afterReconnectId}:${afterReconnectText}]`;
  const inputBLine = `[E2E:ECHO_INPUT:${inputB}:${Buffer.from(inputBText, "utf8").toString("base64")}]`;
  const finalSnapshot = await assertTerminalOutput(
    page,
    paneAfterReconnectExpiry,
    terminalId,
    [beforeLine, afterActiveLine, inputALine, afterReconnectLine, inputBLine],
    testInfo,
  );
  expect(occurrences(finalSnapshot.xterm.text, beforeLine)).toBe(1);
  expect(occurrences(finalSnapshot.xterm.text, afterActiveLine)).toBe(1);
  expect(occurrences(finalSnapshot.xterm.text, inputALine)).toBe(1);
  expect(occurrences(finalSnapshot.xterm.text, afterReconnectLine)).toBe(1);
  expect(occurrences(finalSnapshot.xterm.text, inputBLine)).toBe(1);
  const finalConverged = await expectTerminalConverged(page, terminalId, {
    cols: initial.cols,
    rows: initial.rows,
    pixelWidth: initial.pixelWidth,
    pixelHeight: initial.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(finalConverged.serverViewport?.cols).toBe(initial.cols);
  expect(finalConverged.serverViewport?.rows).toBe(initial.rows);
  await paneAfterReconnectExpiry.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(sizeEntry.rows).toBe(finalConverged.rows);
  expect(sizeEntry.cols).toBe(finalConverged.cols);
  expect(sizeEntry.rows).toBe(finalConverged.serverViewport?.rows);
  expect(sizeEntry.cols).toBe(finalConverged.serverViewport?.cols);

  const finalPixels = await screenshotRegion(page, paneAfterReconnectExpiry.xtermHost);
  await expectTerminalNonBlank(page, paneAfterReconnectExpiry.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "c11-after-reconnect-reauth",
  });
  await expectTerminalPixelsChanged(beforeReconnectPixels, finalPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "c11-reconnect-reauth-pixels",
  });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const finalInvariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(finalInvariantReport.violations).toEqual([]);
  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-close")).toEqual([]);

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.some((entry) => entry.event === "exit")).toBe(false);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  const expectedCommands = [
    `READY ${readyId}`,
    `PRINT ${beforeId} ${beforeText}`,
    `HOLD ${holdA}`,
    `RELEASE ${holdA}`,
    `PRINT ${afterActiveId} ${afterActiveText}`,
    `ECHO_INPUT ${inputA}`,
    inputAText,
    `HOLD ${holdB}`,
    `RELEASE ${holdB}`,
    `PRINT ${afterReconnectId} ${afterReconnectText}`,
    `ECHO_INPUT ${inputB}`,
    inputBText,
    `SIZE ${sizeId}`,
  ];
  const commandEntries = transcript.filter((entry) => entry.event === "command");
  for (const command of expectedCommands) {
    const encoded = Buffer.from(command, "utf8").toString("base64");
    expect(commandEntries.filter((entry) => entry.command_base64 === encoded)).toHaveLength(1);
  }
  expect(unexpectedBrowserErrors(errors())).toEqual([]);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
});
