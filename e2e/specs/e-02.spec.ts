import { Buffer } from "node:buffer";
import { request, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import type { NetworkFaultDisposer } from "../fixtures/network-faults.js";
import {
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;
const BURST_BYTES = 1_048_576;
const BURST_LINE_WIDTH = 80;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: "running" | "exited" | string;
  readonly exitCode?: number | null;
  readonly clients?: number;
};

async function createTerminal(page: Page, workbench: WorkbenchPage): Promise<TerminalApiInfo> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const terminal = await response.json() as TerminalApiInfo;
  expect(terminal.id).not.toBe("");
  expect(terminal.name).not.toBe("");
  return terminal;
}

async function readTerminals(page: Page): Promise<TerminalApiInfo[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    return await response.json() as TerminalApiInfo[];
  });
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo | undefined> {
  const terminals = await readTerminals(page);
  return terminals.find((terminal) => terminal.id === terminalId);
}

async function waitForTerminalListing(page: Page): Promise<TerminalApiInfo[]> {
  const response = await page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return candidate.request().method() === "GET"
      && url.pathname === "/api/terminals"
      && candidate.ok();
  });
  return await response.json() as TerminalApiInfo[];
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  eventType: E2ETerminalEvent["type"],
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, type, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after && event.type === type,
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, type: eventType, timeout: WAIT_TIMEOUT_MS });
}

function expectProcessTerminated(pid: number): void {
  let errorCode: string | undefined;
  try {
    process.kill(pid, 0);
  } catch (error) {
    errorCode = (error as NodeJS.ErrnoException).code;
  }
  expect(errorCode).toBe("ESRCH");
}

function unexpectedBrowserErrors(entries: BrowserErrorCollector): readonly unknown[] {
  return entries().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
}

test("E-02 Kill during output @e @lifecycle @nightly", async ({
  browser,
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let freshContext: BrowserContext | undefined;
  let freshPage: Page | undefined;
  let freshErrors: BrowserErrorCollector | undefined;
  let unauthenticatedRequest: APIRequestContext | undefined;
  let hostileRequest: APIRequestContext | undefined;
  let throttleRule: NetworkFaultDisposer | undefined;
  let pauseRule: NetworkFaultDisposer | undefined;

  const runTag = `E02-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const targetReadyId = `${runTag}-target-ready`;
  const siblingReadyId = `${runTag}-sibling-ready`;
  const targetPrintId = `${runTag}-target-marker`;
  const targetPrintText = `${runTag}-target-visible`;
  const burstId = `${runTag}-burst`;
  const siblingPrintId = `${runTag}-sibling-marker`;
  const siblingPrintText = `${runTag}-sibling-visible`;
  const siblingEchoId = `${runTag}-sibling-echo`;
  const siblingInput = `${runTag}-continued-input`;

  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const target = await createTerminal(page, workbench);
    const targetName = `${target.name}-${runTag}-target`;
    const renameResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "PATCH" && url.pathname === `/api/terminals/${target.id}`;
    });
    await workbench.sidebar.renameTerminal({ id: target.id, name: target.name }, targetName);
    const renameResponse = await renameResponsePromise;
    expect(renameResponse.ok()).toBe(true);
    const targetPaneBeforeSibling = new TerminalPanePage(page, target.id, targetName);
    const targetBeforeSibling = await expectTerminalSynchronized(page, target.id, { timeout: WAIT_TIMEOUT_MS });
    expect(targetBeforeSibling.activeSocketCount).toBe(1);
    expect(targetBeforeSibling.acceptingInput).toBe(true);
    const targetInfoBeforeSibling = await readTerminal(page, target.id);
    if (!targetInfoBeforeSibling || targetInfoBeforeSibling.pid === null) {
      throw new Error(`terminal ${target.id} did not expose a running fixture PID`);
    }
    const targetPid = targetInfoBeforeSibling.pid;

    await targetPaneBeforeSibling.sendInput(`READY ${targetReadyId}`, true);
    await server.waitForTranscript(
      target.id,
      (entry) => entry.event === "ready" && entry.id === targetReadyId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, target.id, {
      contains: `[E2E:READY:${targetReadyId}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const sibling = await createTerminal(page, workbench);
    const siblingPaneBeforeTarget = new TerminalPanePage(page, sibling.id, sibling.name);
    await siblingPaneBeforeTarget.expectVisible();
    const siblingInitial = await expectTerminalSynchronized(page, sibling.id, { timeout: WAIT_TIMEOUT_MS });
    expect(siblingInitial.activeSocketCount).toBe(1);
    expect(siblingInitial.acceptingInput).toBe(true);
    const siblingInfoBeforeKill = await readTerminal(page, sibling.id);
    if (!siblingInfoBeforeKill || siblingInfoBeforeKill.pid === null) {
      throw new Error(`terminal ${sibling.id} did not expose a running fixture PID`);
    }
    const siblingPid = siblingInfoBeforeKill.pid;

    await siblingPaneBeforeTarget.sendInput(`READY ${siblingReadyId}`, true);
    await server.waitForTranscript(
      sibling.id,
      (entry) => entry.event === "ready" && entry.id === siblingReadyId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, sibling.id, {
      contains: `[E2E:READY:${siblingReadyId}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const targetPane = await workbench.sidebar.openTerminal({ id: target.id, name: targetName });
    await targetPane.expectVisible();
    const targetInitial = await expectTerminalSynchronized(page, target.id, { timeout: WAIT_TIMEOUT_MS });
    expect(targetInitial.activeSocketCount).toBe(1);
    expect(targetInitial.socket.activeCount).toBe(1);
    expect(targetInitial.acceptingInput).toBe(true);
    expect(targetInitial.socketGeneration).toBeGreaterThanOrEqual(targetBeforeSibling.socketGeneration);
    await expectTerminalBuffer(page, target.id, {
      contains: `[E2E:READY:${targetReadyId}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const targetPixelsBeforeMarker = await screenshotRegion(page, targetPane.xtermHost);
    await targetPane.sendInput(`PRINT ${targetPrintId} ${targetPrintText}`, true);
    await server.waitForTranscript(
      target.id,
      (entry) => entry.event === "print" && entry.id === targetPrintId && entry.text === targetPrintText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const targetMarker = `[E2E:PRINT:${targetPrintId}:${targetPrintText}]`;
    await expectTerminalBuffer(page, target.id, { contains: targetMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectKnownMarkerChanged(page, targetPane.xtermHost, targetPixelsBeforeMarker, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "e-02-target-marker",
    });
    await expectTerminalNonBlank(page, targetPane.xtermHost, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "e-02-target-before-kill",
    });

    unauthenticatedRequest = await request.newContext({ baseURL });
    const unauthenticatedDelete = await unauthenticatedRequest.delete(`/api/terminals/${target.id}`);
    expect([401, 403]).toContain(unauthenticatedDelete.status());
    const targetAfterUnauthenticatedDelete = await readTerminal(page, target.id);
    expect(targetAfterUnauthenticatedDelete?.pid).toBe(targetPid);

    const cookies = await page.context().cookies();
    hostileRequest = await request.newContext({
      baseURL,
      storageState: { cookies, origins: [] },
      extraHTTPHeaders: { Origin: "https://attacker.example" },
    });
    const hostileDelete = await hostileRequest.delete(`/api/terminals/${target.id}`);
    expect(hostileDelete.status()).toBe(403);
    const targetAfterHostileDelete = await readTerminal(page, target.id);
    expect(targetAfterHostileDelete?.pid).toBe(targetPid);

    const targetEventsBeforeBurst = await terminalEvents(page, target.id);
    const diagnosticFloor = targetEventsBeforeBurst.at(-1)?.id ?? 0;
    const targetBeforeBurst = await targetPane.snapshot();
    if (!targetBeforeBurst) throw new Error(`No diagnostics snapshot for terminal ${target.id} before burst`);
    const baselineReceived = targetBeforeBurst.receivedSequence ?? targetBeforeBurst.committedSequence ?? 0;
    const targetGeneration = targetBeforeBurst.socketGeneration;
    const trafficMatcher = { terminalId: target.id, generation: targetGeneration };
    const firstOutputPromise = waitForDiagnosticEventAfter(page, target.id, diagnosticFloor, "output-received");
    const firstParserCommitPromise = waitForDiagnosticEventAfter(page, target.id, diagnosticFloor, "parser-commit");
    const burstTranscriptPromise = server.waitForTranscript(
      target.id,
      (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES && entry.line_width === BURST_LINE_WIDTH,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );

    throttleRule = faultController.throttle("server-to-browser", BURST_BYTES, trafficMatcher);
    const canvasCountBeforeRemoval = await page.locator("canvas").count();
    await targetPane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    const [firstOutput, burstTranscript] = await Promise.all([firstOutputPromise, burstTranscriptPromise]);
    expect(firstOutput.type).toBe("output-received");
    const firstOutputSequence = Number(firstOutput.data.sequence);
    const firstOutputBytes = Number(firstOutput.data.bytes);
    expect(Number.isSafeInteger(firstOutputSequence)).toBe(true);
    expect(Number.isSafeInteger(firstOutputBytes)).toBe(true);
    expect(firstOutputBytes).toBeGreaterThan(0);
    expect(firstOutputSequence).toBe(baselineReceived + firstOutputBytes);
    expect(burstTranscript.event).toBe("burst");
    expect(burstTranscript.bytes).toBe(BURST_BYTES);
    expect(burstTranscript.line_width).toBe(BURST_LINE_WIDTH);

    const pausedPromise = faultController.waitFor(
      (event) => event.type === "paused"
        && event.terminalId === target.id
        && event.generation === targetGeneration
        && event.direction === "server-to-browser",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    pauseRule = faultController.pause("server-to-browser", trafficMatcher);
    const paused = await pausedPromise;
    expect(paused.direction).toBe("server-to-browser");
    const firstParserCommit = await firstParserCommitPromise;
    expect(firstParserCommit.type).toBe("parser-commit");
    expect(Number(firstParserCommit.data.sequence)).toBeGreaterThanOrEqual(firstOutputSequence);

    const boundaryReport = await expectConnectedTerminalInvariants(page, target.id, { timeout: WAIT_TIMEOUT_MS });
    expect(boundaryReport.violations).toEqual([]);
    await assertMonotonicSequences(boundaryReport.events);
    expect(boundaryReport.snapshot.activeSocketCount).toBe(1);
    expect(boundaryReport.snapshot.socketGeneration).toBe(targetGeneration);

    const targetEventFloorBeforeRemoval = (await terminalEvents(page, target.id)).at(-1)?.id ?? diagnosticFloor;
    const targetNetworkFloor = faultController.events.length;
    const unmountPromise = waitForDiagnosticEventAfter(page, target.id, targetEventFloorBeforeRemoval, "unmount");
    const deleteResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "DELETE" && url.pathname === `/api/terminals/${target.id}`;
    });
    await workbench.sidebar.removeTerminal({ id: target.id, name: targetName });
    const [deleteResponse, unmounted] = await Promise.all([deleteResponsePromise, unmountPromise]);
    expect(deleteResponse.status()).toBe(204);
    expect(unmounted.type).toBe("unmount");
    expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
    expect(unmounted.snapshot.lifecycle.visible).toBe(false);
    expect(unmounted.snapshot.lifecycle.cached).toBe(true);
    expect(unmounted.snapshot.lifecycle.active).toBe(false);
    expect(unmounted.snapshot.lifecycle.acceptingInput).toBe(false);
    expect(unmounted.snapshot.activeSocketCount).toBe(0);
    expect(unmounted.snapshot.socket.activeCount).toBe(0);
    expect(unmounted.snapshot.socketGeneration).toBe(targetGeneration);
    expect(unmounted.snapshot.webglLoadCount).toBeLessThanOrEqual(boundaryReport.snapshot.webglLoadCount);
    expect(unmounted.snapshot.contextLossCount).toBeLessThanOrEqual(boundaryReport.snapshot.contextLossCount);
    expect(unmounted.snapshot.fallbackCount).toBeLessThanOrEqual(boundaryReport.snapshot.fallbackCount);
    const targetNetworkAfterUnmountFloor = faultController.events.length;

    expectProcessTerminated(targetPid);
    const targetAfterRemoval = await readTerminal(page, target.id);
    expect(targetAfterRemoval).toBeUndefined();
    expect(await targetPane.root.count()).toBe(0);
    expect(await page.locator(`[data-terminal-id="${target.id.replace(/(["\\])/g, "\\$1")}"]`).count()).toBe(0);
    expect(await targetPane.snapshot()).toBeUndefined();
    expect(await targetPane.events()).toEqual([]);
    const canvasCountAfterRemoval = await page.locator("canvas").count();
    expect(canvasCountAfterRemoval).toBeLessThanOrEqual(canvasCountBeforeRemoval);

    const targetTranscript = await server.readTranscript(target.id);
    expect(targetTranscript.filter((entry) => entry.event === "ready" && entry.id === targetReadyId)).toHaveLength(1);
    expect(targetTranscript.filter((entry) => entry.event === "print" && entry.id === targetPrintId)).toHaveLength(1);
    expect(targetTranscript.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
    expect(targetTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);

    const targetNetworkAfterRemoval = faultController.events.slice(targetNetworkFloor);
    expect(targetNetworkAfterRemoval.filter((event) => (
      event.terminalId === target.id
      && ["upgrade-open", "connection-open"].includes(event.type)
    ))).toHaveLength(0);

    faultController.resume("server-to-browser", trafficMatcher);
    pauseRule.dispose();
    pauseRule = undefined;
    throttleRule.dispose();
    throttleRule = undefined;

    const targetNetworkAfterRestore = faultController.events.slice(targetNetworkAfterUnmountFloor);
    expect(targetNetworkAfterRestore.filter((event) => (
      event.terminalId === target.id
      && ["upgrade-open", "connection-open"].includes(event.type)
    ))).toHaveLength(0);
    expect(await targetPane.snapshot()).toBeUndefined();
    expect(await targetPane.events()).toEqual([]);
    expect((await readTerminals(page)).map((terminal) => terminal.id)).not.toContain(target.id);

    freshContext = await browser.newContext({ baseURL });
    freshPage = await freshContext.newPage();
    freshErrors = installBrowserErrorCollectors(freshPage);
    const freshListingPromise = waitForTerminalListing(freshPage);
    await freshPage.goto(baseURL);
    await new LoginPage(freshPage).login();
    const freshTerminals = await freshListingPromise;
    expect(freshTerminals.map((terminal) => terminal.id)).not.toContain(target.id);
    expect(freshTerminals.some((terminal) => terminal.id === sibling.id)).toBe(true);
    const freshWorkbench = new WorkbenchPage(freshPage);
    await freshWorkbench.expectVisible();
    expect(await freshWorkbench.terminalPaneIds()).not.toContain(target.id);
    const freshTargetSnapshot = await freshPage.evaluate((id) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.terminal(id);
    }, target.id);
    expect(freshTargetSnapshot).toBeUndefined();
    if (freshErrors) expect(unexpectedBrowserErrors(freshErrors)).toEqual([]);
    await freshContext.close();
    freshPage = undefined;
    freshContext = undefined;

    const siblingPane = await workbench.sidebar.openTerminal({ id: sibling.id, name: sibling.name });
    await siblingPane.expectVisible();
    const siblingAfterRemoval = await expectTerminalSynchronized(page, sibling.id, { timeout: WAIT_TIMEOUT_MS });
    expect(siblingAfterRemoval.socketState).toBe("connected");
    expect(siblingAfterRemoval.activeSocketCount).toBe(1);
    expect(siblingAfterRemoval.socket.activeCount).toBe(1);
    expect(siblingAfterRemoval.acceptingInput).toBe(true);
    expect(siblingAfterRemoval.socketGeneration).toBeGreaterThanOrEqual(siblingInitial.socketGeneration);
    const siblingInfoAfterRemoval = await readTerminal(page, sibling.id);
    expect(siblingInfoAfterRemoval?.status).toBe("running");
    expect(siblingInfoAfterRemoval?.pid).toBe(siblingPid);
    expect(siblingInfoAfterRemoval?.clients).toBe(1);
    await expectTerminalBuffer(page, sibling.id, {
      contains: `[E2E:READY:${siblingReadyId}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const siblingPixelsBeforeMarker = await screenshotRegion(page, siblingPane.xtermHost);
    await siblingPane.sendInput(`PRINT ${siblingPrintId} ${siblingPrintText}`, true);
    await server.waitForTranscript(
      sibling.id,
      (entry) => entry.event === "print" && entry.id === siblingPrintId && entry.text === siblingPrintText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const siblingMarker = `[E2E:PRINT:${siblingPrintId}:${siblingPrintText}]`;
    await expectTerminalBuffer(page, sibling.id, { contains: siblingMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectKnownMarkerChanged(page, siblingPane.xtermHost, siblingPixelsBeforeMarker, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "e-02-sibling-marker",
    });
    await expectTerminalNonBlank(page, siblingPane.xtermHost, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "e-02-sibling-after-kill",
    });

    await siblingPane.sendInput(`ECHO_INPUT ${siblingEchoId}`, true);
    await server.waitForTranscript(
      sibling.id,
      (entry) => entry.event === "echo_input" && entry.id === siblingEchoId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await siblingPane.sendInput(siblingInput, true);
    const siblingEcho = await server.waitForTranscript(
      sibling.id,
      (entry) => entry.event === "echo_input"
        && entry.id === siblingEchoId
        && entry.phase === "payload"
        && entry.payload_base64 === Buffer.from(siblingInput, "utf8").toString("base64"),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(siblingEcho.payload_base64).toBe(Buffer.from(siblingInput, "utf8").toString("base64"));
    await expectTerminalBuffer(page, sibling.id, {
      contains: `[E2E:ECHO_INPUT:${siblingEchoId}:${Buffer.from(siblingInput, "utf8").toString("base64")}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const siblingInvariantReport = await expectConnectedTerminalInvariants(page, sibling.id, { timeout: WAIT_TIMEOUT_MS });
    expect(siblingInvariantReport.violations).toEqual([]);
    await assertMonotonicSequences(siblingInvariantReport.events);
    await expectNoPendingRecovery(page, sibling.id, { timeout: WAIT_TIMEOUT_MS });
    assertNoUnexpectedSocketMultiplication([siblingInitial, siblingAfterRemoval, siblingInvariantReport.snapshot]);
    expect(siblingInvariantReport.events.filter((event) => event.type === "error")).toHaveLength(0);

    const siblingTranscript = await server.readTranscript(sibling.id);
    expect(siblingTranscript.filter((entry) => entry.event === "ready" && entry.id === siblingReadyId)).toHaveLength(1);
    expect(siblingTranscript.filter((entry) => entry.event === "print" && entry.id === siblingPrintId)).toHaveLength(1);
    expect(siblingTranscript.filter((entry) => entry.event === "echo_input" && entry.id === siblingEchoId && entry.phase === "payload")).toHaveLength(1);
    expect(siblingTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
    expect((await readTerminals(page)).map((terminal) => terminal.id)).toEqual(expect.arrayContaining([sibling.id]));
    expect((await readTerminals(page)).map((terminal) => terminal.id)).not.toContain(target.id);
    expect(unexpectedBrowserErrors(browserErrors)).toEqual([]);
    expect(faultController.events.slice(targetNetworkAfterUnmountFloor).filter((event) => (
      event.terminalId === target.id
      && ["upgrade-open", "connection-open"].includes(event.type)
    ))).toHaveLength(0);
    expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);
  } finally {
    pauseRule?.dispose();
    throttleRule?.dispose();
    await unauthenticatedRequest?.dispose();
    await hostileRequest?.dispose();
    if (freshPage && !freshPage.isClosed()) await freshPage.close();
    if (freshContext) await freshContext.close();
    browserErrors.dispose();
  }
});
