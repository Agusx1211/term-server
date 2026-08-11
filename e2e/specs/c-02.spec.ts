import { test, expect } from "../fixtures/test.js";
import type { BrowserContext, Page } from "@playwright/test";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
  assertNoPendingSynchronization,
} from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 30_000;

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly createdAt: number;
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

async function waitForTerminalListing(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  const response = await page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return candidate.request().method() === "GET" && url.pathname === "/api/terminals";
  });
  if (!response.ok()) throw new Error(`terminal listing failed with HTTP ${response.status()}`);
  const terminals = await response.json() as TerminalApiInfo[];
  const terminal = terminals.find((candidate) => candidate.id === terminalId);
  if (!terminal) throw new Error(`terminal ${terminalId} was not found in the server listing`);
  return terminal;
}


test("C-02 Browser page close and reopen @nightly @p1", async ({
  browser,
  baseURL,
  page,
  server,
  faultController,
}, testInfo) => {
  const runId = `W${testInfo.workerIndex}R${testInfo.retry}I${testInfo.repeatEachIndex}`;
  const readyId = `C02_READY_${runId}`;
  const beforeId = `C02_BEFORE_${runId}`;
  const beforeText = `C02_BEFORE_TEXT_${runId}`;
  const gateToken = `C02_GATE_${runId}`;
  const afterId = `C02_AFTER_${runId}`;
  const afterText = `C02_AFTER_TEXT_${runId}`;
  const sameSizeId = `C02_SIZE_SAME_${runId}`;
  const freshSizeId = `C02_SIZE_FRESH_${runId}`;
  const echoId = `C02_ECHO_${runId}`;
  const echoText = `C02_CONTINUED_INPUT_${runId}`;
  const beforeMarker = `[E2E:PRINT:${beforeId}:${beforeText}]`;
  const afterMarker = `[E2E:PRINT:${afterId}:${afterText}]`;
  const echoMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;

  const initialErrors = installBrowserErrorCollectors(page);
  let samePage: Page | undefined;
  let sameErrors: BrowserErrorCollector | undefined;
  let freshContext: BrowserContext | undefined;
  let freshPage: Page | undefined;
  let freshErrors: BrowserErrorCollector | undefined;

  try {
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
    const initialSnapshot = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(initialSnapshot.cols).toBeGreaterThan(0);
    expect(initialSnapshot.rows).toBeGreaterThan(0);
    expect(initialSnapshot.serverViewport).toBeDefined();
    expect(initialSnapshot.serverViewport?.cols).toBe(initialSnapshot.cols);
    expect(initialSnapshot.serverViewport?.rows).toBe(initialSnapshot.rows);
    expect(initialSnapshot.activeSocketCount).toBe(1);
    const initialServerViewport = initialSnapshot.serverViewport;
    if (!initialServerViewport) throw new Error("initial synchronized terminal did not expose a server viewport");
    expect(initialServerViewport.pixelWidth).toBe(initialSnapshot.pixelWidth);
    expect(initialServerViewport.pixelHeight).toBe(initialSnapshot.pixelHeight);
    assertNoPendingSynchronization(initialSnapshot);

    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "ready" && entry.id === readyId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:READY:${readyId}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: "c-02-before-close-terminal",
    });
    const beforePixels = await screenshotRegion(page, pane.xtermHost);

    await pane.sendInput(`HOLD ${gateToken}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "hold" && entry.token === gateToken,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const initialEvents = await terminalEvents(page, terminalId);
    expect(initialEvents.filter((event) => event.type === "error")).toEqual([]);
    await assertMonotonicSequences(initialEvents);

    const initialTerminal = await readTerminal(page, terminalId);
    expect(initialTerminal.id).toBe(terminalId);
    expect(initialTerminal.createdAt).toBe(created.createdAt);
    expect(initialTerminal.status).toBe("running");
    expect(initialTerminal.clients).toBe(1);
    if (initialTerminal.pid === null) throw new Error(`terminal ${terminalId} has no running process identity`);
    const initialPid = initialTerminal.pid;
    const initialViewport = page.viewportSize();
    const initialDevicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
    const initialOpen = await faultController.waitFor(
      (event) => event.type === "connection-open" && event.terminalId === terminalId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    if (initialOpen.generation === undefined) throw new Error("initial terminal proxy connection has no generation");
    const initialGeneration = initialOpen.generation;

    const initialClose = faultController.waitFor(
      (event) => (event.type === "connection-closed" || event.type === "connection-terminated")
        && event.terminalId === terminalId
        && event.generation === initialGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await page.close();
    await initialClose;

    samePage = await page.context().newPage();
    sameErrors = installBrowserErrorCollectors(samePage);
    const sameListing = waitForTerminalListing(samePage, terminalId);
    await samePage.goto(baseURL);
    const sameWorkbench = new WorkbenchPage(samePage);
    await sameWorkbench.expectVisible();
    const detachedTerminal = await sameListing;
    expect(detachedTerminal.id).toBe(initialTerminal.id);
    expect(detachedTerminal.createdAt).toBe(initialTerminal.createdAt);
    expect(detachedTerminal.status).toBe("running");
    expect(detachedTerminal.pid).toBe(initialPid);
    expect(detachedTerminal.clients).toBe(0);

    const samePane = await sameWorkbench.openTerminal({ id: terminalId, name: created.name });
    await samePane.expectVisible();
    const sameSnapshot = await expectTerminalSynchronized(samePage, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(sameSnapshot.socketState).toBe("connected");
    expect(sameSnapshot.activeSocketCount).toBe(1);
    expect(sameSnapshot.lifecycle.acceptingInput).toBe(true);
    const sameConverged = await expectTerminalConverged(samePage, terminalId, {
      cols: initialSnapshot.cols,
      rows: initialSnapshot.rows,
      pixelWidth: initialServerViewport.pixelWidth,
      pixelHeight: initialServerViewport.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    expect(sameConverged.serverViewport).toBeDefined();
    expect(sameConverged.serverViewport?.cols).toBe(initialSnapshot.cols);
    expect(sameConverged.serverViewport?.rows).toBe(initialSnapshot.rows);
    await expectTerminalBuffer(samePage, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(samePage, samePane.xtermHost, {
      testInfo,
      artifactName: "c-02-same-context-restored-terminal",
    });

    const sameOpen = [...faultController.events].reverse().find(
      (event) => event.type === "connection-open" && event.terminalId === terminalId && event.generation !== undefined && event.generation > initialGeneration,
    );
    if (!sameOpen || sameOpen.generation === undefined) throw new Error("same-context reopen did not expose a new proxy generation");
    const sameGeneration = sameOpen.generation;
    expect(sameGeneration).toBeGreaterThan(initialGeneration);
    const sameTerminal = await readTerminal(samePage, terminalId);
    expect(sameTerminal.status).toBe("running");
    expect(sameTerminal.pid).toBe(initialPid);
    expect(sameTerminal.createdAt).toBe(initialTerminal.createdAt);
    expect(sameTerminal.clients).toBe(1);

    await samePane.sendInput(`RELEASE ${gateToken}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "release" && entry.token === gateToken,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await samePane.sendInput(`PRINT ${afterId} ${afterText}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === afterId && entry.text === afterText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(samePage, terminalId, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const samePixels = await expectKnownMarkerChanged(samePage, samePane.xtermHost, beforePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "c-02-same-context-reopen-marker",
    });
    expect(samePixels.after.width).toBe(beforePixels.width);
    expect(samePixels.after.height).toBe(beforePixels.height);
    await expectTerminalNonBlank(samePage, samePane.xtermHost, {
      testInfo,
      artifactName: "c-02-same-context-reopen-terminal",
    });

    await samePane.sendInput(`SIZE ${sameSizeId}`, true);
    const sameSize = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number; pixel_width: number; pixel_height: number; source: string }>(
      terminalId,
      (entry) => entry.event === "size" && entry.id === sameSizeId && entry.source === "ioctl",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(sameSize.cols).toBe(initialSnapshot.cols);
    expect(sameSize.rows).toBe(initialSnapshot.rows);
    expect(sameSize.pixel_width).toBe(initialServerViewport.pixelWidth);
    expect(sameSize.pixel_height).toBe(initialServerViewport.pixelHeight);
    await expectTerminalBuffer(samePage, terminalId, {
      contains: `[E2E:SIZE:${sameSizeId}:${sameSize.rows}:${sameSize.cols}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    const sameEvents = await terminalEvents(samePage, terminalId);
    expect(sameEvents.filter((event) => event.type === "error")).toEqual([]);
    await assertMonotonicSequences(sameEvents);
    const sameInvariantReport = await expectConnectedTerminalInvariants(samePage, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(sameInvariantReport.violations).toEqual([]);
    assertNoPendingSynchronization(sameInvariantReport.snapshot);

    const sameClose = faultController.waitFor(
      (event) => (event.type === "connection-closed" || event.type === "connection-terminated")
        && event.terminalId === terminalId
        && event.generation === sameGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await samePage.close();
    await sameClose;

    freshContext = await browser.newContext({
      baseURL,
      ...(initialViewport ? { viewport: initialViewport } : {}),
      deviceScaleFactor: initialDevicePixelRatio,
    });
    freshPage = await freshContext.newPage();
    freshErrors = installBrowserErrorCollectors(freshPage);
    const freshListing = waitForTerminalListing(freshPage, terminalId);
    await freshPage.goto(baseURL);
    await new LoginPage(freshPage).login();
    const detachedAgain = await freshListing;
    expect(detachedAgain.id).toBe(initialTerminal.id);
    expect(detachedAgain.createdAt).toBe(initialTerminal.createdAt);
    expect(detachedAgain.status).toBe("running");
    expect(detachedAgain.pid).toBe(initialPid);
    expect(detachedAgain.clients).toBe(0);

    const freshWorkbench = new WorkbenchPage(freshPage);
    await freshWorkbench.expectVisible();
    const freshPane = await freshWorkbench.openTerminal({ id: terminalId, name: created.name });
    await freshPane.expectVisible();
    const freshSnapshot = await expectTerminalSynchronized(freshPage, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(freshSnapshot.socketState).toBe("connected");
    expect(freshSnapshot.activeSocketCount).toBe(1);
    expect(freshSnapshot.lifecycle.acceptingInput).toBe(true);
    const freshConverged = await expectTerminalConverged(freshPage, terminalId, {
      cols: initialSnapshot.cols,
      rows: initialSnapshot.rows,
      pixelWidth: initialServerViewport.pixelWidth,
      pixelHeight: initialServerViewport.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    expect(freshConverged.serverViewport).toBeDefined();
    expect(freshConverged.serverViewport?.cols).toBe(initialSnapshot.cols);
    expect(freshConverged.serverViewport?.rows).toBe(initialSnapshot.rows);
    await expectTerminalBuffer(freshPage, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(freshPage, terminalId, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(freshPage, freshPane.xtermHost, {
      testInfo,
      artifactName: "c-02-fresh-context-restored-terminal",
    });
    const freshPixels = await expectKnownMarkerChanged(freshPage, freshPane.xtermHost, beforePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "c-02-fresh-context-reopen-marker",
    });
    expect(freshPixels.after.width).toBe(beforePixels.width);
    expect(freshPixels.after.height).toBe(beforePixels.height);

    const freshOpen = [...faultController.events].reverse().find(
      (event) => event.type === "connection-open" && event.terminalId === terminalId && event.generation !== undefined && event.generation > sameGeneration,
    );
    if (!freshOpen || freshOpen.generation === undefined) throw new Error("fresh-context reopen did not expose a new proxy generation");
    const freshGeneration = freshOpen.generation;
    expect(freshGeneration).toBeGreaterThan(sameGeneration);
    const freshTerminal = await readTerminal(freshPage, terminalId);
    expect(freshTerminal.status).toBe("running");
    expect(freshTerminal.pid).toBe(initialPid);
    expect(freshTerminal.createdAt).toBe(initialTerminal.createdAt);
    expect(freshTerminal.clients).toBe(1);

    await freshPane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await freshPane.sendInput(echoText, true);
    const echoPayload = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(echoPayload.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
    await expectTerminalBuffer(freshPage, terminalId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    await freshPane.sendInput(`SIZE ${freshSizeId}`, true);
    const freshSize = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number; pixel_width: number; pixel_height: number; source: string }>(
      terminalId,
      (entry) => entry.event === "size" && entry.id === freshSizeId && entry.source === "ioctl",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(freshSize.cols).toBe(initialSnapshot.cols);
    expect(freshSize.rows).toBe(initialSnapshot.rows);
    expect(freshSize.pixel_width).toBe(initialServerViewport.pixelWidth);
    expect(freshSize.pixel_height).toBe(initialServerViewport.pixelHeight);
    await expectTerminalBuffer(freshPage, terminalId, {
      contains: `[E2E:SIZE:${freshSizeId}:${freshSize.rows}:${freshSize.cols}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const finalSnapshot = await expectTerminalSynchronized(freshPage, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(finalSnapshot.socketState).toBe("connected");
    expect(finalSnapshot.activeSocketCount).toBe(1);
    expect(finalSnapshot.acceptingInput).toBe(true);
    expect(finalSnapshot.serverViewport).toBeDefined();
    expect(finalSnapshot.serverViewport?.cols).toBe(finalSnapshot.cols);
    expect(finalSnapshot.serverViewport?.rows).toBe(finalSnapshot.rows);
    assertNoPendingSynchronization(finalSnapshot);
    const finalInvariantReport = await expectConnectedTerminalInvariants(freshPage, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(finalInvariantReport.violations).toEqual([]);
    expect(finalInvariantReport.events.filter((event) => event.type === "error")).toEqual([]);
    await assertMonotonicSequences(finalInvariantReport.events);
    assertNoUnexpectedSocketMultiplication([
      initialSnapshot,
      sameSnapshot,
      sameConverged,
      sameInvariantReport.snapshot,
      freshSnapshot,
      freshConverged,
      finalSnapshot,
      finalInvariantReport.snapshot,
    ]);

    const transcript = await server.readTranscript(terminalId);
    const payloadEntries = transcript.filter(
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    );
    expect(payloadEntries).toHaveLength(1);
    const transcriptErrors = transcript.filter((entry) => entry.event === "error");
    expect(transcriptErrors).toEqual([]);
    if (!sameErrors || !freshErrors) throw new Error("reopened browser pages did not install error collectors");
    const diagnosticErrors = [
      ...initialErrors(),
      ...sameErrors(),
      ...freshErrors(),
    ].filter((entry) => entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message));
    expect(diagnosticErrors).toEqual([]);

    const freshClose = faultController.waitFor(
      (event) => (event.type === "connection-closed" || event.type === "connection-terminated")
        && event.terminalId === terminalId
        && event.generation === freshGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    if (!freshContext) throw new Error("fresh browser context was not created");
    await freshContext.close();
    await freshClose;
    freshPage = undefined;
    freshContext = undefined;
  } finally {
    initialErrors.dispose();
    sameErrors?.dispose();
    freshErrors?.dispose();
    if (samePage && !samePage.isClosed()) await samePage.close();
    if (freshContext) await freshContext.close();
  }
});
