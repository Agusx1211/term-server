import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 30_000;

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
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

test("P0-20 Terminal exit across reconnect boundary @p0", async ({
  browser,
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const runId = `W${testInfo.workerIndex}R${testInfo.retry}I${testInfo.repeatEachIndex}`;
  const beforeId = `P020_BEFORE_${runId}`;
  const beforeText = `P020_BEFORE_OUTPUT_${runId}`;
  const exitCode = 23;
  const postExitInput = `P020_POST_EXIT_INPUT_${runId}`;

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as TerminalApiInfo;
  expect(created.id).not.toBe("");
  const terminalId = created.id;
  const pane = workbench.terminal(terminalId, created.name);
  await pane.expectVisible();
  await waitForTerminalState(
    page,
    terminalId,
    { socketState: "connected", acceptingInput: true, pendingParserWrites: 0 },
    { timeout: WAIT_TIMEOUT_MS },
  );

  await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${beforeId}:${beforeText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const beforeDisconnectPixels = await screenshotRegion(page, pane.xtermHost);

  const initialConnection = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
  );
  if (!initialConnection || initialConnection.generation === undefined) {
    throw new Error("initial terminal connection has no proxy generation");
  }
  const initialGeneration = initialConnection.generation;
  const disconnected = faultController.waitFor(
    (event) => event.type === "connection-terminated"
      && event.terminalId === terminalId
      && event.generation === initialGeneration,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const socketClosed = pane.waitForEvent("socket-close", { timeout: WAIT_TIMEOUT_MS });
  const disconnectRule = faultController.terminate({ terminalId, generation: initialGeneration });
  try {
    await disconnected;
    await socketClosed;
  } finally {
    disconnectRule.dispose();
  }
  const primaryExit = pane.waitForEvent("exit", { timeout: WAIT_TIMEOUT_MS });

  // Keep the first browser disconnected while a second real browser drives the
  // fixture to exit. This makes the PTY exit boundary independent of reconnect
  // timer scheduling in the disconnected pane.
  await page.context().setOffline(true);
  let exitDriverErrors: BrowserErrorCollector | undefined;
  const exitDriverContext = await browser.newContext({ baseURL });
  try {
    const exitDriverPage = await exitDriverContext.newPage();
    exitDriverErrors = installBrowserErrorCollectors(exitDriverPage);
    await exitDriverPage.goto(baseURL);
    await new LoginPage(exitDriverPage).login();
    const exitDriverWorkbench = new WorkbenchPage(exitDriverPage);
    await exitDriverWorkbench.expectVisible();
    const exitDriverPane = await exitDriverWorkbench.openTerminal({ id: terminalId, name: created.name });
    await exitDriverPane.expectVisible();
    await expectTerminalSynchronized(exitDriverPage, terminalId, { timeout: WAIT_TIMEOUT_MS });

    await exitDriverPane.sendInput(`EXIT ${exitCode}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "exit_requested" && entry.code === exitCode,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const exitTranscript = await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "exit" && entry.code === exitCode,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(exitTranscript.code).toBe(exitCode);
    expect(exitDriverErrors().filter(
      (entry) => entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message),
    )).toEqual([]);
  } finally {
    exitDriverErrors?.dispose();
    await exitDriverContext.close();
  }


  const reconnect = faultController.waitFor(
    (event) => event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation !== undefined
      && event.generation > initialGeneration,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await page.context().setOffline(false);
  const reconnectEvent = await reconnect;
  const exitEvent = await primaryExit;
  expect(reconnectEvent.generation).toBeGreaterThan(initialGeneration);
  expect(exitEvent.data.exitCode).toBe(exitCode);

  await pane.expectVisible();
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${beforeId}:${beforeText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:EXIT:${exitCode}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const afterExitPixels = await expectKnownMarkerChanged(page, pane.xtermHost, beforeDisconnectPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-20-retained-exit-output",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "p0-20-retained-exit-terminal",
  });
  expect(afterExitPixels.after.width).toBe(beforeDisconnectPixels.width);
  expect(afterExitPixels.after.height).toBe(beforeDisconnectPixels.height);

  const finalTerminal = await readTerminal(page, terminalId);
  expect(finalTerminal.status).toBe("exited");
  expect(finalTerminal.exitCode).toBe(exitCode);
  expect(finalTerminal.pid).toBeNull();

  const finalSnapshot = await waitForTerminalState(
    page,
    terminalId,
    {
      socketState: "exited",
      exitCode,
      acceptingInput: false,
      pendingParserWrites: 0,
      activeSocketCount: 0,
    },
    { timeout: WAIT_TIMEOUT_MS },
  );
  expect(finalSnapshot.exitCode).toBe(exitCode);
  expect(finalSnapshot.socketState).toBe("exited");
  expect(finalSnapshot.acceptingInput).toBe(false);

  await pane.sendInput(postExitInput, true);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:EXIT:${exitCode}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const transcriptAfterInput = await server.readTranscript(terminalId);
  expect(transcriptAfterInput.filter(
    (entry) => entry.event === "command" && entry.operation === "EXIT",
  )).toHaveLength(1);
  expect(transcriptAfterInput.filter(
    (entry) => entry.event === "exit_requested" && entry.code === exitCode,
  )).toHaveLength(1);
  expect(transcriptAfterInput.some(
    (entry) => entry.event === "echo_input" && entry.id === postExitInput,
  )).toBe(false);
  expect(transcriptAfterInput.filter((entry) => entry.event === "exit" && entry.code === exitCode)).toHaveLength(1);
  expect(transcriptAfterInput.filter((entry) => entry.event === "error")).toHaveLength(0);

  const events = await terminalEvents(page, terminalId);
  expect(events.filter((event) => event.type === "exit")).toHaveLength(1);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  const exitEventIndex = events.findIndex((event) => event.type === "exit");
  expect(exitEventIndex).toBeGreaterThanOrEqual(0);
  expect(events.slice(exitEventIndex + 1).filter((event) => (
    event.type === "socket-created"
      || event.type === "sync"
      || event.type === "synced"
      || event.type === "state" && ["connecting", "recovering", "disconnected"].includes(String(event.data.state))
  ))).toEqual([]);
  expect(events.filter((event) => event.type === "socket-created").length).toBeGreaterThanOrEqual(2);

  const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
});
