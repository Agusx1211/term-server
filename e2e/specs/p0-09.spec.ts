import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalSnapshot,
  waitForTerminalBuffer,
  waitForFontSettledViewport,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import type { E2ETerminalDiagnosticsApi } from "../../src/client/lib/e2e-diagnostics.js";

const INITIAL_VIEWPORT = { width: 960, height: 640 } as const;
const WIDE_VIEWPORT = { width: 1600, height: 900 } as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};


async function terminalIdInPane(page: Page, selector: string): Promise<string> {
  const id = await page.locator(selector).getAttribute("data-terminal-id");
  if (!id) throw new Error(`terminal pane did not expose a data-terminal-id for ${selector}`);
  return id;
}

async function waitForDistinctTerminalIdInPane(page: Page, selector: string, excludedId: string): Promise<string> {
  const panes = page.locator(selector);
  const findDistinctId = async (): Promise<string> => {
    const ids = await panes.evaluateAll((nodes) => nodes
      .map((node) => node.getAttribute("data-terminal-id"))
      .filter((id): id is string => Boolean(id)));
    return ids.find((id) => id !== excludedId) ?? "";
  };
  await expect.poll(findDistinctId, { timeout: 10_000 }).not.toBe("");
  const id = await findDistinctId();
  if (!id) throw new Error(`terminal pane did not expose a terminal distinct from ${excludedId}`);
  return id;
}

async function waitForWideVisibleViewport(
  page: Page,
  terminalId: string,
  previousCols: number,
  previousRows: number,
) {
  return page.evaluate(async ({ id, cols, rows }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => {
        const viewport = snapshot.serverViewport;
        return snapshot.visible
          && viewport !== undefined
          && viewport.cols > cols
          && viewport.rows > rows;
      },
      { timeout: 10_000 },
    );
  }, { id: terminalId, cols: previousCols, rows: previousRows });
}

async function waitForVisibleViewportAtMost(
  page: Page,
  terminalId: string,
  previousCols: number,
  previousRows: number,
) {
  return page.evaluate(async ({ id, cols, rows }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => {
        const viewport = snapshot.serverViewport;
        return snapshot.visible
          && viewport !== undefined
          && viewport.cols <= cols
          && viewport.rows <= rows;
      },
      { timeout: 10_000 },
    );
  }, { id: terminalId, cols: previousCols, rows: previousRows });
}

async function waitForRenderAfter(
  page: Page,
  terminalId: string,
  previousRenderCount: number,
) {
  return page.evaluate(async ({ id, count }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.renderCount > count,
      { timeout: 10_000 },
    );
  }, { id: terminalId, count: previousRenderCount });
}

test("P0-09 Cached pane remains live and restores visibly @p0 @smoke", async ({ page, browser, baseURL, server }, testInfo) => {
  const runId = `${testInfo.workerIndex}-${testInfo.testId.replace(/[^A-Za-z0-9]/g, "").slice(-12)}`;
  const login = new LoginPage(page);
  const workbench = new WorkbenchPage(page);

  await page.setViewportSize(INITIAL_VIEWPORT);
  await page.addInitScript(() => {
    localStorage.setItem("term-server:tile-new-terminals", "false");
  });
  await page.goto(baseURL);
  await login.login();
  await workbench.expectVisible();

  await workbench.createTerminal();
  const paneASelector = ".editor-grid .pane-slot:not(.cached) section[role=\"region\"][data-terminal-id]";
  const terminalAId = await terminalIdInPane(page, paneASelector);
  const paneA = workbench.terminal(terminalAId);
  await paneA.expectVisible();
  const terminalAName = (await paneA.root.getAttribute("aria-label"))?.replace(/^Terminal(?: pane)?\s+/i, "");
  if (!terminalAName) throw new Error("terminal A did not expose an accessible name");

  await waitForFontSettledViewport(page, terminalAId, { timeout: 15_000 });
  const initialA = await expectTerminalSynchronized(page, terminalAId);
  const initialSentViewport = initialA.sentViewport ?? initialA.urlViewport;
  if (!initialSentViewport) throw new Error("initial terminal A viewport was not reported");
  const initialRenderCount = initialA.renderCount;

  const readyId = `${runId}-READY`;
  await paneA.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalAId, (entry) => entry.event === "ready" && entry.id === readyId);

  const populateId = `${runId}-POPULATE`;
  await paneA.sendInput(`BURST ${populateId} 4096 80`, true);
  await server.waitForTranscript(terminalAId, (entry) => entry.event === "burst" && entry.id === populateId);

  const initialPrintId = `${runId}-INITIAL`;
  const initialText = `${runId}-INITIAL-LIVE`;
  await paneA.sendInput(`PRINT ${initialPrintId} ${initialText}`, true);
  await server.waitForTranscript(
    terminalAId,
    (entry) => entry.event === "print" && entry.id === initialPrintId && entry.text === initialText,
  );
  await expectTerminalBuffer(page, terminalAId, { contains: initialText, occurrences: 1 });
  await waitForRenderAfter(page, terminalAId, initialRenderCount);
  const beforeHiddenImage = await screenshotRegion(page, paneA.xtermHost);
  await expectTerminalNonBlank(page, paneA.xtermHost, {
    testInfo,
    artifactName: "p0-09-before-cache.png",
  });

  await workbench.createTerminal();
  const paneBSelector = ".editor-grid .pane-slot:not(.cached) section[role=\"region\"][data-terminal-id]";
  const terminalBId = await waitForDistinctTerminalIdInPane(page, paneBSelector, terminalAId);
  expect(terminalBId).not.toBe(terminalAId);
  const paneB = workbench.terminal(terminalBId);

  await workbench.expectCached(terminalAId);
  await paneA.expectHidden();
  const hiddenA = await waitForTerminalState(page, terminalAId, { visible: false, cached: true });
  expect(hiddenA.lifecycle).toMatchObject({
    mounted: true,
    visible: false,
    cached: true,
    active: false,
    focused: false,
    acceptingInput: false,
  });
  expect(hiddenA.socketState).toBe("connected");
  expect(hiddenA.activeSocketCount).toBe(1);
  expect(hiddenA.socketGeneration).toBe(initialA.socketGeneration);
  const hiddenFocus = await page.evaluate((id) => {
    const root = document.querySelector(`section[role="region"][data-terminal-id="${id}"]`);
    return root?.contains(document.activeElement) ?? false;
  }, terminalAId);
  expect(hiddenFocus).toBe(false);

  const initialB = await expectTerminalSynchronized(page, terminalBId);
  expect(initialB.lifecycle.visible).toBe(true);
  expect(initialB.lifecycle.acceptingInput).toBe(true);

  await workbench.setViewport(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
  const wideB = await waitForWideVisibleViewport(
    page,
    terminalBId,
    initialSentViewport.cols,
    initialSentViewport.rows,
  );
  expect(wideB.lifecycle.visible).toBe(true);
  expect(wideB.serverViewport).toBeDefined();
  const wideServerViewport = wideB.serverViewport;
  if (!wideServerViewport) throw new Error("visible terminal B did not expose its selected viewport");
  expect(wideServerViewport.cols).toBeGreaterThan(initialSentViewport.cols);
  expect(wideServerViewport.rows).toBeGreaterThan(initialSentViewport.rows);
  const controlPage = await browser.newPage();
  await controlPage.setViewportSize(WIDE_VIEWPORT);
  await controlPage.goto(baseURL);
  await new LoginPage(controlPage).login();
  const controlWorkbench = new WorkbenchPage(controlPage);
  await controlWorkbench.expectVisible();
  await controlWorkbench.openTerminal({ id: terminalAId, name: terminalAName });
  const controlPaneA = controlWorkbench.terminal(terminalAId);
  await controlPaneA.expectVisible();
  const controlA = await expectTerminalSynchronized(controlPage, terminalAId);
  expect(controlA.serverViewport?.cols).toBe(wideServerViewport.cols);
  expect(controlA.serverViewport?.rows).toBe(wideServerViewport.rows);


  const cachedAtWide = await page.evaluate(async ({ id, cols, rows }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => !snapshot.visible
        && snapshot.cached
        && snapshot.serverViewport?.cols === cols
        && snapshot.serverViewport?.rows === rows,
      { timeout: 10_000 },
    );
  }, { id: terminalAId, cols: wideServerViewport.cols, rows: wideServerViewport.rows });
  expect(cachedAtWide.socketState).toBe("connected");
  expect(cachedAtWide.activeSocketCount).toBe(1);
  expect(cachedAtWide.socketGeneration).toBe(initialA.socketGeneration);
  expect(cachedAtWide.sentViewport?.cols).toBe(initialSentViewport.cols);
  expect(cachedAtWide.sentViewport?.rows).toBe(initialSentViewport.rows);
  expect(cachedAtWide.serverViewport?.cols).toBe(wideServerViewport.cols);
  expect(cachedAtWide.serverViewport?.rows).toBe(wideServerViewport.rows);

  const sizeId = `${runId}-SIZE-WIDE`;
  await controlPaneA.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await server.waitForTranscript(
    terminalAId,
    (entry) => entry.event === "size" && entry.id === sizeId,
  );
  expect(Number(sizeEntry.cols)).toBe(wideServerViewport.cols);
  expect(Number(sizeEntry.rows)).toBe(wideServerViewport.rows);

  const hiddenBeforeOutput = await terminalSnapshot(page, terminalAId);
  if (!hiddenBeforeOutput) throw new Error("cached terminal A diagnostics disappeared");
  const hiddenReceivedSequence = hiddenBeforeOutput.receivedSequence ?? -1;
  const hiddenCommittedSequence = hiddenBeforeOutput.committedSequence ?? -1;

  const cachedBurstId = `${runId}-BURST`;
  await controlPaneA.sendInput(`BURST ${cachedBurstId} 4096 80`, true);
  await server.waitForTranscript(terminalAId, (entry) => entry.event === "burst" && entry.id === cachedBurstId);

  const cachedPrintId = `${runId}-CACHED-ONE`;
  const cachedText = `${runId}-CACHED-ONE`;
  await controlPaneA.sendInput(`PRINT ${cachedPrintId} ${cachedText}`, true);
  await server.waitForTranscript(
    terminalAId,
    (entry) => entry.event === "print" && entry.id === cachedPrintId && entry.text === cachedText,
  );

  const latestPrintId = `${runId}-CACHED-LATEST`;
  const latestText = `${runId}-CACHED-LATEST-VISIBLE-MARKER`;
  await controlPaneA.sendInput(`PRINT ${latestPrintId} ${latestText}`, true);
  await server.waitForTranscript(
    terminalAId,
    (entry) => entry.event === "print" && entry.id === latestPrintId && entry.text === latestText,
  );

  const hiddenAfterOutput = await waitForTerminalBuffer(page, terminalAId, { contains: latestText, occurrences: 1 });
  expect(hiddenAfterOutput.xterm.text).toContain(cachedText);
  expect(hiddenAfterOutput.receivedSequence).toBeGreaterThan(hiddenReceivedSequence);
  expect(hiddenAfterOutput.committedSequence).toBeGreaterThan(hiddenCommittedSequence);
  expect(hiddenAfterOutput.lifecycle).toMatchObject({ mounted: true, visible: false, cached: true, focused: false, acceptingInput: false });
  expect(hiddenAfterOutput.socketState).toBe("connected");
  expect(hiddenAfterOutput.socketGeneration).toBe(initialA.socketGeneration);
  await controlPage.close();

  await workbench.setViewport(INITIAL_VIEWPORT.width, INITIAL_VIEWPORT.height);
  await waitForVisibleViewportAtMost(page, terminalBId, initialSentViewport.cols, initialSentViewport.rows);

  await workbench.openTerminal({ id: terminalAId, name: terminalAName });
  await workbench.expectVisibleTerminal(terminalAId);
  await paneA.expectVisible();
  const revealed = await waitForTerminalState(page, terminalAId, { visible: true, cached: false });
  expect(revealed.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false });
  expect(revealed.socketGeneration).toBe(initialA.socketGeneration);
  expect(revealed.socketState).toBe("connected");
  expect(revealed.activeSocketCount).toBe(1);
  await waitForRenderAfter(page, terminalAId, hiddenAfterOutput.renderCount);
  await expectTerminalBuffer(page, terminalAId, { contains: latestText, occurrences: 1 });
  const afterRevealImage = await screenshotRegion(page, paneA.xtermHost);
  expect(afterRevealImage.width).toBe(beforeHiddenImage.width);
  expect(afterRevealImage.height).toBe(beforeHiddenImage.height);
  await expectTerminalPixelsChanged(beforeHiddenImage, afterRevealImage, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-09-after-reveal.png",
  });
  await expectTerminalNonBlank(page, paneA.xtermHost, {
    testInfo,
    artifactName: "p0-09-revealed-terminal.png",
  });

  const echoId = `${runId}-ECHO`;
  const echoText = `${runId}-INPUT-AFTER-REVEAL`;
  await paneA.sendInput(`ECHO_INPUT ${echoId} ${echoText}`, true);
  await server.waitForTranscript(
    terminalAId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.text === echoText,
  );
  const transcript = await server.readTranscript(terminalAId);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId)).toHaveLength(1);

  const finalA = await expectConnectedTerminalInvariants(page, terminalAId);
  assertNoPendingSynchronization(finalA.snapshot);
  assertMonotonicSequences(finalA.events);
  expect(finalA.events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalA.snapshot.lifecycle).toMatchObject({
    mounted: true,
    visible: true,
    cached: false,
    active: true,
    acceptingInput: true,
  });

  const finalB = await terminalSnapshot(page, terminalBId);
  if (!finalB) throw new Error("cached terminal B diagnostics disappeared after revealing A");
  assertNoUnexpectedSocketMultiplication([finalA.snapshot, finalB]);
});
