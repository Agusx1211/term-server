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
import {
  expectTerminalNonBlank,
  expectKnownMarkerChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { expectTerminalInvariants as expectInvariants } from "../assertions/invariants.js";
import LoginPage from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
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
const E2E_PASSWORD = "e2e-development";

function marker(testId: string, label: string): string {
  const safeTestId = testId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `E006-${safeTestId}-${label}`;
}

function occurrences(value: string, needle: string): number {
  const comparable = value.replaceAll("\n", "");
  let count = 0;
  let offset = 0;
  while ((offset = comparable.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += Math.max(needle.length, 1);
  }
  return count;
}

function unexpectedBrowserErrors(entries: readonly { kind: string; message: string }[]): readonly unknown[] {
  return entries.filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || (entry.kind === "console" && /^error:/i.test(entry.message))
  ));
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

async function unauthenticatedApiStatuses(page: Page): Promise<{ config: number; terminals: number }> {
  return page.evaluate(async () => {
    const [config, terminals] = await Promise.all([
      fetch("/api/config", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/terminals", { credentials: "same-origin", cache: "no-store" }),
    ]);
    return { config: config.status, terminals: terminals.status };
  });
}

async function waitForRemount(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.terminalId === id,
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
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
    artifactName: "e006-final-terminal",
  });
  return snapshot;
}

test("E-06 Login/logout with active terminal @nightly", async ({ page, baseURL, server, faultController }, testInfo) => {
  const errors = installBrowserErrorCollectors(page);
  await page.goto(baseURL);
  await new LoginPage(page).login(E2E_PASSWORD);

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const mountPromise = page.evaluate(async ({ timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, { timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const mounted = await mountPromise;
  const terminalId = mounted.terminalId;
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
  const beforeText = marker(testInfo.testId, "before-logout");
  const holdToken = marker(testInfo.testId, "active-hold");
  const afterId = marker(testInfo.testId, "after");
  const afterText = marker(testInfo.testId, "after-login");
  const echoId = marker(testInfo.testId, "echo");
  const inputText = marker(testInfo.testId, "continued-input");
  const sizeId = marker(testInfo.testId, "final-size");

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
  const beforeLine = `[E2E:PRINT:${beforeId}:${beforeText}]`;
  await expectTerminalBuffer(page, terminalId, { contains: beforeLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "hold" && entry.token === holdToken,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "e006-before-logout",
  });

  const proxyOpen = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
  );
  if (proxyOpen?.generation === undefined) throw new Error("missing proxy connection generation before logout");
  const oldProxyGeneration = proxyOpen.generation;
  const faultEventCursor = faultController.events.length;
  const unmountPromise = pane.waitForEvent("unmount", { timeout: WAIT_TIMEOUT_MS });
  const proxyClosePromise = faultController.waitFor(
    (event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation === oldProxyGeneration
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const settings = await workbench.openSettings();
  await settings.signOut();
  const unmounted = await unmountPromise;
  const proxyClose = await proxyClosePromise;
  expect(unmounted.type).toBe("unmount");
  expect(unmounted.snapshot.mounted).toBe(false);
  expect(unmounted.snapshot.activeSocketCount).toBe(0);
  expect(unmounted.snapshot.acceptingInput).toBe(false);
  expect(proxyClose.terminalId).toBe(terminalId);
  expect(proxyClose.generation).toBe(oldProxyGeneration);
  expect(proxyClose.abrupt ?? false).toBe(false);
  await new LoginPage(page).expectSignedOut();

  const unauthenticated = await unauthenticatedApiStatuses(page);
  expect(unauthenticated.config).toBe(401);
  expect(unauthenticated.terminals).toBe(401);
  const afterLogoutTranscript = await server.readTranscript(terminalId);
  expect(afterLogoutTranscript.some((entry) => entry.event === "exit")).toBe(false);
  expect(afterLogoutTranscript.filter((entry) => entry.event === "error")).toEqual([]);
  const logoutFaultEvents = faultController.events.slice(faultEventCursor);
  expect(logoutFaultEvents.filter((event) => event.type === "connection-open" && event.terminalId === terminalId)).toEqual([]);

  const remountPromise = waitForRemount(page, terminalId);
  const proxyReconnectPromise = faultController.waitFor(
    (event) => (
      event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation !== undefined
      && event.generation > oldProxyGeneration
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await new LoginPage(page).login(E2E_PASSWORD);
  await workbench.expectVisible();
  const remounted = await remountPromise;
  const proxyReconnected = await proxyReconnectPromise;
  expect(remounted.type).toBe("mount");
  expect(proxyReconnected.generation).toBeGreaterThan(oldProxyGeneration);

  const recoveredPane = new TerminalPanePage(page, terminalId);
  await recoveredPane.expectVisible();
  const recovered = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(recovered.socketGeneration).toBeGreaterThan(0);
  expect(recovered.activeSocketCount).toBe(1);
  expect(recovered.acceptingInput).toBe(true);
  const recoveredInfo = await terminalInfo(page, terminalId);
  expect(recoveredInfo.status).toBe("running");
  expect(recoveredInfo.pid).toBe(pid);

  await expectTerminalBuffer(page, terminalId, { contains: beforeLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await recoveredPane.sendInput(`RELEASE ${holdToken}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "release" && entry.token === holdToken,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await recoveredPane.sendInput(`PRINT ${afterId} ${afterText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === afterId && entry.text === afterText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const afterLine = `[E2E:PRINT:${afterId}:${afterText}]`;
  await expectTerminalBuffer(page, terminalId, { contains: afterLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const beforeAfterPixels = await screenshotRegion(page, recoveredPane.xtermHost);
  await recoveredPane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await recoveredPane.sendInput(inputText, true);
  const echoPayload = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoPayload.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));
  const echoLine = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(inputText, "utf8").toString("base64")}]`;
  const final = await assertTerminalOutput(page, recoveredPane, terminalId, [beforeLine, afterLine, echoLine], testInfo);
  expect(occurrences(final.xterm.text, beforeLine)).toBe(1);
  expect(occurrences(final.xterm.text, afterLine)).toBe(1);
  expect(occurrences(final.xterm.text, echoLine)).toBe(1);
  const { after: afterPixels } = await expectKnownMarkerChanged(page, recoveredPane.xtermHost, beforeAfterPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "e006-after-login-marker",
  });
  expect(afterPixels.width).toBe(beforeAfterPixels.width);
  expect(afterPixels.height).toBe(beforeAfterPixels.height);

  const converged = await expectTerminalConverged(page, terminalId, {
    cols: initial.cols,
    rows: initial.rows,
    pixelWidth: initial.pixelWidth,
    pixelHeight: initial.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(converged.serverViewport?.cols).toBe(initial.cols);
  expect(converged.serverViewport?.rows).toBe(initial.rows);
  await recoveredPane.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(size.rows).toBe(converged.rows);
  expect(size.cols).toBe(converged.cols);
  expect(size.rows).toBe(converged.serverViewport?.rows);
  expect(size.cols).toBe(converged.serverViewport?.cols);

  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toEqual([]);

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.some((entry) => entry.event === "exit")).toBe(false);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  const expectedCommands = [
    `READY ${readyId}`,
    `PRINT ${beforeId} ${beforeText}`,
    `HOLD ${holdToken}`,
    `RELEASE ${holdToken}`,
    `PRINT ${afterId} ${afterText}`,
    `ECHO_INPUT ${echoId}`,
    inputText,
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
