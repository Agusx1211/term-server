import { test, expect } from "../fixtures/test.js";
import type { BrowserErrorCollector } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { expectTerminalBuffer, expectTerminalConverged, expectTerminalSynchronized, terminalEvents } from "../assertions/terminal-state.js";
import { assertNoPendingSynchronization, expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { expectTerminalNonBlank } from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
  readonly createdAt: number;
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

test("P0-02 Existing terminal opens from a cold browser @p0", async ({ browser, baseURL, page, server }, testInfo) => {
  const runId = `W${testInfo.workerIndex}R${testInfo.retry}I${testInfo.repeatEachIndex}`;
  const readyId = `P002_READY_${runId}`;
  const historyIdOne = `P002_HISTORY_A_${runId}`;
  const historyIdTwo = `P002_HISTORY_B_${runId}`;
  const historyTextOne = `P002_HISTORY_TEXT_A_${runId}`;
  const historyTextTwo = `P002_HISTORY_TEXT_B_${runId}`;
  const liveId = `P002_LIVE_${runId}`;
  const liveText = `P002_LIVE_TEXT_${runId}`;
  const sizeId = `P002_SIZE_${runId}`;
  const echoId = `P002_ECHO_${runId}`;
  const echoText = `P002_CONTINUED_INPUT_${runId}`;

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
  await expectTerminalSynchronized(page, terminalId);

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId);

  await pane.sendInput(`PRINT ${historyIdOne} ${historyTextOne}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === historyIdOne);
  await expectTerminalBuffer(page, terminalId, { contains: historyTextOne, occurrences: 1 });

  await pane.sendInput(`PRINT ${historyIdTwo} ${historyTextTwo}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === historyIdTwo);
  await expectTerminalBuffer(page, terminalId, { contains: historyTextTwo, occurrences: 1 });

  const initialSnapshot = await expectTerminalSynchronized(page, terminalId);
  expect(initialSnapshot.activeBuffer).toBe("normal");
  expect(initialSnapshot.cols).toBeGreaterThan(0);
  expect(initialSnapshot.rows).toBeGreaterThan(0);
  const initialTerminal = await readTerminal(page, terminalId);
  expect(initialTerminal.status).toBe("running");
  if (initialTerminal.pid === null) throw new Error(`terminal ${terminalId} has no running process identity`);
  const initialPid = initialTerminal.pid;
  const initialViewport = page.viewportSize();
  const initialDevicePixelRatio = await page.evaluate(() => window.devicePixelRatio);

  const initialContext = page.context();
  await initialContext.close();

  const freshContext = await browser.newContext({
    baseURL,
    ...(initialViewport ? { viewport: initialViewport } : {}),
    deviceScaleFactor: initialDevicePixelRatio,
  });
  let freshErrors: BrowserErrorCollector | undefined;
  try {
    const freshPage = await freshContext.newPage();
    freshErrors = installBrowserErrorCollectors(freshPage);
    await freshPage.goto(baseURL);
    await new LoginPage(freshPage).login();
    const freshWorkbench = new WorkbenchPage(freshPage);
    await freshWorkbench.expectVisible();

    const freshPane = await freshWorkbench.openTerminal({ id: terminalId, name: created.name });
    await freshPane.expectVisible();
    await expectTerminalSynchronized(freshPage, terminalId);

    const freshTerminal = await readTerminal(freshPage, terminalId);
    expect(freshTerminal.id).toBe(initialTerminal.id);
    expect(freshTerminal.createdAt).toBe(initialTerminal.createdAt);
    expect(freshTerminal.status).toBe("running");
    expect(freshTerminal.pid).toBe(initialPid);

    await expectTerminalBuffer(freshPage, terminalId, { contains: historyTextOne });
    await expectTerminalBuffer(freshPage, terminalId, { contains: historyTextTwo });
    const restored = await expectTerminalSynchronized(freshPage, terminalId);
    const restoredText = restored.xterm.text.replaceAll("\n", "");
    expect(restoredText).toContain(`[E2E:PRINT:${historyIdOne}:${historyTextOne}]`);
    expect(restoredText).toContain(`[E2E:PRINT:${historyIdTwo}:${historyTextTwo}]`);
    expect(restoredText.split(historyTextOne)).toHaveLength(2);
    expect(restoredText.split(historyTextTwo)).toHaveLength(2);
    expect(restored.activeBuffer).toBe("normal");

    await freshPane.sendInput(`PRINT ${liveId} ${liveText}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === liveId);
    await expectTerminalBuffer(freshPage, terminalId, { contains: liveText, occurrences: 1 });

    const converged = await expectTerminalConverged(freshPage, terminalId, {
      cols: initialSnapshot.cols,
      rows: initialSnapshot.rows,
    });
    expect(converged.serverViewport).toBeDefined();
    expect(converged.serverViewport?.cols).toBe(converged.cols);
    expect(converged.serverViewport?.rows).toBe(converged.rows);

    await freshPane.sendInput(`SIZE ${sizeId}`, true);
    const sizeEntry = await server.waitForTranscript<{ event: string; id: string; cols: number; rows: number }>(
      terminalId,
      (entry) => entry.event === "size" && entry.id === sizeId,
    );
    expect(sizeEntry.cols).toBe(converged.cols);
    expect(sizeEntry.rows).toBe(converged.rows);

    await expectTerminalNonBlank(freshPage, freshPane.xtermHost, {
      testInfo,
      artifactName: "p0-02-restored-terminal",
    });

    await expectTerminalSynchronized(freshPage, terminalId);
    await freshPane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed");
    await freshPane.sendInput(echoText, true);
    const echoPayload = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    );
    expect(echoPayload.payload_base64).toBe(Buffer.from(echoText).toString("base64"));
    const payloadEntries = (await server.readTranscript(terminalId)).filter(
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    );
    expect(payloadEntries).toHaveLength(1);
    await expectTerminalBuffer(freshPage, terminalId, { contains: echoPayload.payload_base64, occurrences: 1 });

    const finalSnapshot = await expectTerminalSynchronized(freshPage, terminalId);
    expect(finalSnapshot.acceptingInput).toBe(true);
    expect(finalSnapshot.activeSocketCount).toBe(1);
    assertNoPendingSynchronization(finalSnapshot);
    await expectConnectedTerminalInvariants(freshPage, terminalId);

    const diagnosticErrors = (await terminalEvents(freshPage, terminalId)).filter((event) => event.type === "error");
    expect(diagnosticErrors).toEqual([]);
    const transcriptErrors = (await server.readTranscript(terminalId)).filter((entry) => entry.event === "error");
    expect(transcriptErrors).toEqual([]);
    const browserErrors = freshErrors().filter(
      (entry) => entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message),
    );
    expect(browserErrors).toEqual([]);
  } finally {
    freshErrors?.dispose();
    await freshContext.close();
  }
});
