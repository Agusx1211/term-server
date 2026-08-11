import { test, expect } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultDisposer } from "../fixtures/network-faults.js";
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
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 45_000;
const REPAINT_BYTES = 65_536;
const BASELINE_VIEWPORT = { width: 1_280, height: 800 } as const;
const NARROW_VIEWPORT = { width: 840, height: 560 } as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface SizeTranscriptEntry {
  readonly [key: string]: unknown;
  readonly event: "size";
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
  readonly pixel_width?: number;
  readonly pixel_height?: number;
}

interface WinchTranscriptEntry {
  readonly [key: string]: unknown;
  readonly event: "sigwinch";
  readonly signal_sequence: number;
  readonly rows: number;
  readonly cols: number;
}

const cssAttribute = (value: string): string => value.replace(/(["\\])/g, "\\$1");

async function terminalIdInPane(page: Page, selector: string): Promise<string> {
  const pane = page.locator(selector).first();
  await expect(pane).toHaveAttribute("data-terminal-id", /.+/);
  const terminalId = await pane.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error(`terminal pane did not expose a data-terminal-id for ${selector}`);
  return terminalId;
}

async function waitForCachedTerminal(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.lifecycle.mounted
      && snapshot.lifecycle.cached
      && !snapshot.lifecycle.visible
      && !snapshot.lifecycle.active
      && !snapshot.lifecycle.focused
      && !snapshot.lifecycle.acceptingInput
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForVisibleTerminal(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.lifecycle.mounted
      && snapshot.lifecycle.visible
      && !snapshot.lifecycle.cached
      && snapshot.lifecycle.active
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRenderedOutput(
  page: Page,
  terminalId: string,
  minimumRenderCount: number,
  visible = false,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, count, requireVisible, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > count
      && (!requireVisible || snapshot.lifecycle.visible)
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, count: minimumRenderCount, requireVisible: visible, timeout: WAIT_TIMEOUT_MS });
}

async function waitForViewportBelow(
  page: Page,
  terminalId: string,
  baseline: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, cols, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.serverViewport;
      return snapshot.lifecycle.visible
        && viewport !== undefined
        && (viewport.cols < cols || viewport.rows < rows);
    }, { timeout });
  }, { id: terminalId, cols: baseline.cols, rows: baseline.rows, timeout: WAIT_TIMEOUT_MS });
}

async function waitForViewportAt(
  page: Page,
  terminalId: string,
  expected: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, cols, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.serverViewport;
      return snapshot.lifecycle.visible
        && viewport !== undefined
        && viewport.cols === cols
        && viewport.rows === rows;
    }, { timeout });
  }, { id: terminalId, cols: expected.cols, rows: expected.rows, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCachedViewport(
  page: Page,
  terminalId: string,
  expected: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, cols, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.serverViewport;
      return snapshot.lifecycle.cached
        && !snapshot.lifecycle.visible
        && viewport !== undefined
        && viewport.cols === cols
        && viewport.rows === rows;
    }, { timeout });
  }, { id: terminalId, cols: expected.cols, rows: expected.rows, timeout: WAIT_TIMEOUT_MS });
}

test("R-07 Cached display:none repaint @p1 @rendering @cache @repaint @nightly", async ({ page, baseURL, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let outputPause: NetworkFaultDisposer | undefined;
  const runTag = `W${testInfo.workerIndex}-P${testInfo.parallelIndex}-R${testInfo.retry}-I${testInfo.repeatEachIndex}`;
  const markerPrefix = `R07-${runTag}`;
  const readyId = `${markerPrefix}-READY`;
  const initialPrintId = `${markerPrefix}-INITIAL`;
  const initialText = `${markerPrefix}-BASELINE`;
  const holdToken = `${markerPrefix}-HOLD`;
  const repaintId = `${markerPrefix}-REPAINT`;
  const hiddenPrintId = `${markerPrefix}-HIDDEN`;
  const hiddenText = `${markerPrefix}-HIDDEN-PRINT`;
  const echoId = `${markerPrefix}-ECHO`;
  const echoText = `${markerPrefix}-CONTINUED-INPUT`;
  const sizeId = `${markerPrefix}-SIZE`;
  const readyMarker = `[E2E:READY:${readyId}]`;
  const initialMarker = `[E2E:PRINT:${initialPrintId}:${initialText}]`;
  const holdMarker = `[E2E:HOLD:${holdToken}]`;
  const repaintMarker = `[E2E:REPAINT:${repaintId}:FRAME]`;
  const hiddenPrintMarker = `[E2E:PRINT:${hiddenPrintId}:${hiddenText}]`;
  const echoMarker = `[E2E:ECHO_INPUT:${echoId}:${echoText}]`;

  try {
    await page.setViewportSize(BASELINE_VIEWPORT);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const settings = await workbench.openSettings();
    await settings.setCachedTerminalLimit(1);
    await expect(settings.root.getByRole("slider", {
      name: "Terminals kept alive off screen",
      exact: true,
    })).toHaveValue("1");
    await workbench.closeSettings();

    await workbench.createTerminal();
    const terminalAId = await terminalIdInPane(page, ".editor-grid .pane-slot:not(.cached) section[role=\"region\"][data-terminal-id]");
    const paneA = workbench.terminal(terminalAId);
    await paneA.expectVisible();
    const initialA = await expectTerminalSynchronized(page, terminalAId, { timeout: WAIT_TIMEOUT_MS });
    const initialSentViewport = initialA.sentViewport ?? initialA.urlViewport;
    if (!initialSentViewport) throw new Error("terminal A did not expose its initial sent viewport");
    expect(initialA.activeSocketCount).toBe(1);

    await paneA.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(
      terminalAId,
      (entry) => entry.event === "ready" && entry.id === readyId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, terminalAId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const beforeInitialPrint = await terminalSnapshot(page, terminalAId);
    if (!beforeInitialPrint) throw new Error("terminal A diagnostics disappeared before baseline print");

    await paneA.sendInput(`PRINT ${initialPrintId} ${initialText}`, true);
    await server.waitForTranscript(
      terminalAId,
      (entry) => entry.event === "print" && entry.id === initialPrintId && entry.text === initialText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, terminalAId, { contains: initialMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const baselineRendered = await waitForRenderedOutput(page, terminalAId, beforeInitialPrint.renderCount);
    const beforeHideImage = await screenshotRegion(page, paneA.xtermHost);
    await expectTerminalNonBlank(page, paneA.xtermHost, {
      testInfo,
      artifactName: "r-07-before-cache.png",
    });
    const initialCanvasCount = await paneA.xtermHost.locator("canvas").count();

    await paneA.sendInput(`HOLD ${holdToken}`, true);
    await server.waitForTranscript(
      terminalAId,
      (entry) => entry.event === "hold" && entry.token === holdToken,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, terminalAId, { contains: holdMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const repaintCommand = `REPAINT ${repaintId} ${REPAINT_BYTES}`;
    const hiddenPrintCommand = `PRINT ${hiddenPrintId} ${hiddenText}`;
    await paneA.sendInput(repaintCommand, true);
    await server.waitForTranscript(
      terminalAId,
      (entry) => entry.event === "command"
        && entry.operation === "REPAINT"
        && entry.command_base64 === Buffer.from(repaintCommand, "utf8").toString("base64"),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await paneA.sendInput(hiddenPrintCommand, true);
    await server.waitForTranscript(
      terminalAId,
      (entry) => entry.event === "command"
        && entry.operation === "PRINT"
        && entry.command_base64 === Buffer.from(hiddenPrintCommand, "utf8").toString("base64"),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const queued = await terminalSnapshot(page, terminalAId);
    if (!queued) throw new Error("terminal A diagnostics disappeared before cache transition");
    expect(queued.xterm.text).not.toContain(repaintMarker);
    expect(queued.xterm.text).not.toContain(hiddenPrintMarker);

    outputPause = faultController.pause("server-to-browser", { terminalId: terminalAId });
    await faultController.waitFor(
      (event) => event.type === "paused"
        && event.terminalId === terminalAId
        && event.direction === "server-to-browser"
        && event.ruleId === outputPause?.id,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );

    const releaseCommand = `RELEASE ${holdToken}`;
    const releaseEntryPromise = server.waitForTranscript(
      terminalAId,
      (entry) => entry.event === "release" && entry.token === holdToken,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const repaintEntryPromise = server.waitForTranscript(
      terminalAId,
      (entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === REPAINT_BYTES,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const hiddenPrintEntryPromise = server.waitForTranscript(
      terminalAId,
      (entry) => entry.event === "print" && entry.id === hiddenPrintId && entry.text === hiddenText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await paneA.sendInput(releaseCommand, true);
    await Promise.all([releaseEntryPromise, repaintEntryPromise, hiddenPrintEntryPromise]);

    await workbench.createTerminal();
    const terminalBId = await terminalIdInPane(page, ".editor-grid .pane-slot:not(.cached) section[role=\"region\"][data-terminal-id]");
    expect(terminalBId).not.toBe(terminalAId);
    const paneB = workbench.terminal(terminalBId);
    await paneB.expectVisible();
    await workbench.expectCached(terminalAId);
    await paneA.expectHidden();
    const cachedSlot = page.locator(".editor-grid .pane-slot.cached").filter({
      has: page.locator(`[data-terminal-id="${cssAttribute(terminalAId)}"]`),
    }).first();
    await expect(cachedSlot).toHaveCount(1);
    await expect(cachedSlot).toHaveCSS("display", "none");

    const hiddenBeforeOutput = await waitForCachedTerminal(page, terminalAId);
    expect(hiddenBeforeOutput.socketState).toBe("connected");
    expect(hiddenBeforeOutput.activeSocketCount).toBe(1);
    expect(hiddenBeforeOutput.socketGeneration).toBe(initialA.socketGeneration);
    expect(hiddenBeforeOutput.sentViewport?.cols).toBe(initialSentViewport.cols);
    expect(hiddenBeforeOutput.sentViewport?.rows).toBe(initialSentViewport.rows);
    expect(hiddenBeforeOutput.sentViewport?.pixelWidth).toBe(initialSentViewport.pixelWidth);
    expect(hiddenBeforeOutput.sentViewport?.pixelHeight).toBe(initialSentViewport.pixelHeight);
    const hiddenHasFocus = await page.evaluate((id) => {
      const root = document.querySelector(`section[role="region"][data-terminal-id="${id}"]`);
      return root?.contains(document.activeElement) ?? false;
    }, terminalAId);
    expect(hiddenHasFocus).toBe(false);

    const initialB = await expectTerminalSynchronized(page, terminalBId, { timeout: WAIT_TIMEOUT_MS });
    expect(initialB.lifecycle).toMatchObject({
      mounted: true,
      visible: true,
      cached: false,
      active: true,
      acceptingInput: true,
    });
    const baselineBViewport = initialB.serverViewport;
    if (!baselineBViewport) throw new Error("terminal B did not expose its initial server viewport");

    await workbench.setViewport(NARROW_VIEWPORT.width, NARROW_VIEWPORT.height);
    const narrowB = await waitForViewportBelow(page, terminalBId, baselineBViewport);
    const narrowViewport = narrowB.serverViewport;
    if (!narrowViewport) throw new Error("terminal B did not expose its narrowed server viewport");
    expect(narrowViewport.cols < baselineBViewport.cols || narrowViewport.rows < baselineBViewport.rows).toBe(true);
    const hiddenDuringNarrow = await terminalSnapshot(page, terminalAId);
    if (!hiddenDuringNarrow) throw new Error("terminal A diagnostics disappeared while cached");
    expect(hiddenDuringNarrow.lifecycle).toMatchObject({ mounted: true, visible: false, cached: true, active: false, focused: false, acceptingInput: false });
    expect(hiddenDuringNarrow.sentViewport?.cols).toBe(initialSentViewport.cols);
    expect(hiddenDuringNarrow.sentViewport?.rows).toBe(initialSentViewport.rows);

    await workbench.setViewport(BASELINE_VIEWPORT.width, BASELINE_VIEWPORT.height);
    const restoredB = await waitForViewportAt(page, terminalBId, {
      cols: baselineBViewport.cols,
      rows: baselineBViewport.rows,
    });
    expect(restoredB.serverViewport?.cols).toBe(baselineBViewport.cols);
    expect(restoredB.serverViewport?.rows).toBe(baselineBViewport.rows);

    const activeOutputPause = outputPause;
    if (!activeOutputPause) throw new Error("R-07 output pause was not installed");
    const resumedOutputPromise = faultController.waitFor(
      (event) => event.type === "resumed"
        && event.terminalId === terminalAId
        && event.direction === "server-to-browser",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    activeOutputPause.dispose();
    await resumedOutputPromise;
    outputPause = undefined;
    await expectTerminalBuffer(page, terminalAId, { contains: hiddenPrintMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalAId, { contains: repaintMarker }, { timeout: WAIT_TIMEOUT_MS });
    const hiddenAfterOutput = await waitForCachedViewport(page, terminalAId, {
      cols: baselineBViewport.cols,
      rows: baselineBViewport.rows,
    });
    expect(hiddenAfterOutput.lifecycle).toMatchObject({
      mounted: true,
      visible: false,
      cached: true,
      active: false,
      focused: false,
      acceptingInput: false,
    });
    expect(hiddenAfterOutput.socketState).toBe("connected");
    expect(hiddenAfterOutput.activeSocketCount).toBe(1);
    expect(hiddenAfterOutput.socketGeneration).toBe(initialA.socketGeneration);
    expect(hiddenAfterOutput.xterm.text).toContain(repaintMarker);
    expect(hiddenAfterOutput.xterm.text).toContain(hiddenPrintMarker);
    expect(hiddenAfterOutput.receivedSequence).toBeGreaterThan(hiddenBeforeOutput.receivedSequence ?? -1);
    expect(hiddenAfterOutput.committedSequence).toBeGreaterThan(hiddenBeforeOutput.committedSequence ?? -1);
    expect(hiddenAfterOutput.committedSequence).toBe(hiddenAfterOutput.receivedSequence);
    expect(hiddenAfterOutput.sentViewport?.cols).toBe(initialSentViewport.cols);
    expect(hiddenAfterOutput.sentViewport?.rows).toBe(initialSentViewport.rows);
    expect(hiddenAfterOutput.renderer).toBe(baselineRendered.renderer);
    expect(hiddenAfterOutput.webglLoadCount).toBe(baselineRendered.webglLoadCount);
    expect(hiddenAfterOutput.contextLossCount).toBe(baselineRendered.contextLossCount);
    expect(hiddenAfterOutput.fallbackCount).toBe(baselineRendered.fallbackCount);

    await workbench.openTerminal({ id: terminalAId });
    await workbench.expectVisibleTerminal(terminalAId);
    await paneA.expectVisible();
    const revealed = await waitForVisibleTerminal(page, terminalAId);
    expect(revealed.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true });
    const rendered = await waitForRenderedOutput(page, terminalAId, hiddenAfterOutput.renderCount, true);
    expect(rendered.renderCount).toBeGreaterThan(hiddenAfterOutput.renderCount);
    expect(rendered.lifecycle.visible).toBe(true);
    await expectTerminalBuffer(page, terminalAId, { contains: hiddenPrintMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const converged = await expectTerminalConverged(page, terminalAId, {
      cols: revealed.cols,
      rows: revealed.rows,
      pixelWidth: revealed.pixelWidth,
      pixelHeight: revealed.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    expect(converged.serverViewport?.cols).toBe(revealed.cols);
    expect(converged.serverViewport?.rows).toBe(revealed.rows);
    const afterRevealImage = await screenshotRegion(page, paneA.xtermHost);
    expect(afterRevealImage.width).toBe(beforeHideImage.width);
    expect(afterRevealImage.height).toBe(beforeHideImage.height);
    await expectTerminalPixelsChanged(beforeHideImage, afterRevealImage, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "r-07-after-reveal.png",
    });
    await expectTerminalNonBlank(page, paneA.xtermHost, {
      testInfo,
      artifactName: "r-07-revealed-terminal.png",
    });
    const revealedCanvasCount = await paneA.xtermHost.locator("canvas").count();
    expect(revealedCanvasCount).toBe(initialCanvasCount);

    await paneA.sendInput(`ECHO_INPUT ${echoId} ${echoText}`, true);
    const echoEntry = await server.waitForTranscript<{ readonly [key: string]: unknown; readonly event: "echo_input"; readonly id: string; readonly phase: "payload"; readonly text: string }>(
      terminalAId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(echoEntry.text).toBe(echoText);
    await expectTerminalBuffer(page, terminalAId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const final = await page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, (snapshot) => (
        snapshot.lifecycle.visible
        && snapshot.lifecycle.active
        && snapshot.lifecycle.acceptingInput
        && snapshot.socketState === "connected"
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && (snapshot.syncTarget === undefined || snapshot.committedSequence === undefined || snapshot.committedSequence >= snapshot.syncTarget)
      ), { timeout });
    }, { id: terminalAId, timeout: WAIT_TIMEOUT_MS });
    expect(final.activeSocketCount).toBe(1);
    expect(final.socket.activeCount).toBe(1);
    expect(final.renderBacklogOldestAgeMs).toBe(0);
    expect(final.serverViewport).toBeDefined();
    expect(final.serverViewport?.cols).toBe(final.cols);
    expect(final.serverViewport?.rows).toBe(final.rows);
    expect(final.sentViewport?.cols).toBe(final.serverViewport?.cols);
    expect(final.sentViewport?.rows).toBe(final.serverViewport?.rows);
    expect(final.renderer).toBe(baselineRendered.renderer);
    expect(final.webglLoadCount).toBe(baselineRendered.webglLoadCount);
    expect(final.contextLossCount).toBe(baselineRendered.contextLossCount);
    expect(final.fallbackCount).toBe(baselineRendered.fallbackCount);
    expect(final.lifecycle).toMatchObject({
      mounted: true,
      visible: true,
      cached: false,
      active: true,
      focused: true,
      acceptingInput: true,
    });

    await expectTerminalBuffer(page, terminalAId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await paneA.sendInput(`SIZE ${sizeId}`, true);
    const sizeEntry = await server.waitForTranscript<SizeTranscriptEntry>(
      terminalAId,
      (entry) => entry.event === "size" && entry.id === sizeId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(sizeEntry.rows).toBe(final.rows);
    expect(sizeEntry.cols).toBe(final.cols);
    await expectTerminalBuffer(page, terminalAId, {
      contains: `[E2E:SIZE:${sizeId}:${sizeEntry.rows}:${sizeEntry.cols}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const transcript = await server.readTranscript(terminalAId);
    expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "hold" && entry.token === holdToken)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "repaint" && entry.id === repaintId && entry.bytes === REPAINT_BYTES)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === hiddenPrintId && entry.text === hiddenText)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "release" && entry.token === holdToken)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);

    const finalTranscript = await server.readTranscript<WinchTranscriptEntry>(terminalAId);
    const winches = finalTranscript.filter((entry) => entry.event === "sigwinch");
    expect(winches.length).toBeGreaterThan(0);
    for (const winch of winches) {
      expect(winch.signal_sequence).toBeGreaterThan(0);
      expect(winch.rows).toBeGreaterThan(0);
      expect(winch.cols).toBeGreaterThan(0);
    }
    expect(winches.some((winch) => winch.rows === final.rows && winch.cols === final.cols)).toBe(true);

    const events = await terminalEvents(page, terminalAId);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
    expect(events.filter((event) => event.type === "visibility" && event.data.visible === false)).toHaveLength(1);
    expect(events.filter((event) => event.type === "visibility" && event.data.visible === true).length).toBeGreaterThanOrEqual(1);
    expect(events.some((event) => event.type === "render" && event.snapshot.lifecycle.visible && event.snapshot.renderCount > hiddenAfterOutput.renderCount)).toBe(true);
    expect(events.filter((event) => event.type === "socket-created").length).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.type === "socket-created").length).toBeLessThanOrEqual(2);
    assertNoUnexpectedSocketMultiplication([initialA, hiddenBeforeOutput, hiddenDuringNarrow, hiddenAfterOutput, revealed, rendered, final]);
    await assertMonotonicSequences(events);
    assertNoPendingSynchronization(final);
    await expectNoPendingRecovery(page, terminalAId, { timeout: WAIT_TIMEOUT_MS });
    const invariantReport = await expectConnectedTerminalInvariants(page, terminalAId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);

    const finalB = await terminalSnapshot(page, terminalBId);
    if (!finalB) throw new Error("terminal B diagnostics disappeared after revealing A");
    expect(finalB.activeSocketCount).toBeLessThanOrEqual(1);
    expect((await terminalEvents(page, terminalBId)).filter((event) => event.type === "error")).toHaveLength(0);

    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || entry.kind === "console" && /^error:/i.test(entry.message)
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);
  } finally {
    outputPause?.dispose();
    browserErrors.dispose();
  }
});
