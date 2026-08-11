import { expect, test, type BrowserErrorCollector } from "../fixtures/test.js";
import type { BrowserContext, Page } from "@playwright/test";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConverged,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 45_000;
const INITIAL_VIEWPORT = { width: 1_080, height: 700 } as const;
const WIDE_VIEWPORT = { width: 1_680, height: 920 } as const;
const SECOND_CLIENT_VIEWPORT = { width: 2_200, height: 1_300 } as const;
const CACHED_TERMINAL_LIMIT = 2;
const BURST_BYTES = 128 * 1024;
const BURST_LINE_WIDTH = 80;
const CHECKPOINT_CHUNK_BYTES = 32 * 1024;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_CHECKPOINT_FRAME_BYTES = 64 * 1024;
const MAX_SERIALIZATION_DURATION_MS = 2_500;
const MAX_UPLOAD_DURATION_MS = 250;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

function eventNumber(event: E2ETerminalEvent, key: string): number | undefined {
  const value = event.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


function burstBytes(bytes: number, lineWidth: number): Buffer {
  const output = Buffer.alloc(bytes);
  let offset = 0;
  let column = 0;
  let visible = 0;
  while (offset < bytes) {
    output[offset] = 65 + (visible % 26);
    offset += 1;
    visible += 1;
    column += 1;
    if (column === lineWidth && offset < bytes - 1) {
      output[offset] = 10;
      offset += 1;
      column = 0;
    }
  }
  return output;
}

function printMarker(markerId: string, text: string): Buffer {
  return Buffer.from(`[E2E:PRINT:${markerId}:${text}]\n`, "utf8");
}



async function waitForCheckpointAfter(
  page: Page,
  terminalId: string,
  floor: number,
  minimumSequence: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, floor: eventFloor, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > eventFloor
      && event.type === "checkpoint"
      && event.data.result === "sent"
      && typeof event.data.sequence === "number"
      && event.data.sequence >= minimum
    ), { timeout, afterId: eventFloor });
  }, { id: terminalId, floor, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
}

async function waitForVisibleViewportChange(
  page: Page,
  terminalId: string,
  previous: E2EViewport,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previous, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.serverViewport;
      return snapshot.visible
        && !snapshot.cached
        && viewport !== undefined
        && (
          viewport.cols > previous.cols
          || viewport.rows > previous.rows
          || viewport.pixelWidth > previous.pixelWidth
          || viewport.pixelHeight > previous.pixelHeight
        );
    }, { timeout });
  }, { id: terminalId, previous, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCachedViewport(
  page: Page,
  terminalId: string,
  expected: E2EViewport,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.mounted
      && snapshot.cached
      && !snapshot.visible
      && snapshot.serverViewport !== undefined
      && snapshot.serverViewport.cols === expected.cols
      && snapshot.serverViewport.rows === expected.rows
      && snapshot.serverViewport.pixelWidth === expected.pixelWidth
      && snapshot.serverViewport.pixelHeight === expected.pixelHeight
    ), { timeout });
  }, { id: terminalId, expected, timeout: WAIT_TIMEOUT_MS });
}

async function waitForHiddenOutput(
  page: Page,
  terminalId: string,
  minimumSequence: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimum, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.mounted
      && snapshot.cached
      && !snapshot.visible
      && snapshot.socketState === "connected"
      && !snapshot.acceptingInput
      && snapshot.receivedSequence !== undefined
      && snapshot.receivedSequence >= minimum
      && snapshot.committedSequence !== undefined
      && snapshot.committedSequence >= minimum
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, minimum: minimumSequence, timeout: WAIT_TIMEOUT_MS });
}

function checkpointFrames(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
  baseline: ReadonlySet<NetworkFaultEvent>,
): NetworkFaultEvent[] {
  return events.filter((event) => (
    !baseline.has(event)
    && event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "checkpoint"
  ));
}

function writeBytesSince(
  entries: readonly Record<string, unknown>[],
  writeFloor: number,
): Buffer {
  const writes = entries
    .filter((entry) => entry.event === "write" && typeof entry.write_sequence === "number" && entry.write_sequence > writeFloor)
    .sort((first, second) => Number(first.write_sequence) - Number(second.write_sequence));
  const chunks = writes.map((entry) => {
    if (typeof entry.data_base64 !== "string") throw new Error("fixture write entry has no base64 payload");
    return Buffer.from(entry.data_base64, "base64");
  });
  return Buffer.concat(chunks);
}

test("@p1 @checkpoint @cache @nightly K-04 Hidden cached checkpoint policy", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runId = `K04-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}`;
  let contextB: BrowserContext | undefined;
  let browserErrorsB: BrowserErrorCollector | undefined;

  try {
    await page.setViewportSize(INITIAL_VIEWPORT);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const settings = await workbench.openSettings();
    await settings.setCachedTerminalLimit(CACHED_TERMINAL_LIMIT);
    await expect(settings.root.getByRole("slider", {
      name: "Terminals kept alive off screen",
      exact: true,
    })).toHaveValue(String(CACHED_TERMINAL_LIMIT));
    await workbench.closeSettings();

    const firstMount = page.evaluate(async ({ timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent("mount", { timeout });
    }, { timeout: WAIT_TIMEOUT_MS });
    await workbench.createTerminal();
    const firstMounted = await firstMount;
    const terminalId = firstMounted.terminalId;
    const paneA = workbench.terminal(terminalId);
    await paneA.expectVisible();
    const terminalName = (await paneA.root.getAttribute("aria-label"))?.replace(/^Terminal(?: pane)?\s+/i, "");
    if (!terminalName) throw new Error("K-04 terminal has no accessible name");

    const initial = await paneA.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    const initialViewport = initial.sentViewport ?? initial.serverViewport ?? initial.viewport;
    if (!initialViewport) throw new Error("K-04 initial terminal viewport is unavailable");
    const initialPaneId = initial.paneId;
    const initialSocketGeneration = initial.socketGeneration;
    const initialRenderer = {
      renderer: initial.renderer,
      webglLoadCount: initial.webglLoadCount,
      contextLossCount: initial.contextLossCount,
      fallbackCount: initial.fallbackCount,
    };

    const readyId = `${runId}-READY`;
    await paneA.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });

    const screenA = paneA.xtermHost.locator(".xterm-screen");
    const beforeInitialMarker = await screenshotRegion(page, screenA);
    const initialMarker = `${runId}-INITIAL`;
    const initialText = `${runId}-INITIAL-VISIBLE`;
    await paneA.sendInput(`PRINT ${initialMarker} ${initialText}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === initialMarker, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:PRINT:${initialMarker}:${initialText}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(page, screenA, {
      testInfo,
      artifactName: "k-04-initial-terminal",
    });

    const hiddenPromise = page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent(id, (event) => (
        event.type === "visibility"
        && event.data.visible === false
        && event.snapshot.mounted
        && event.snapshot.cached
        && !event.snapshot.visible
        && event.snapshot.socketState === "connected"
        && !event.snapshot.acceptingInput
      ), { timeout });
    }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
    const secondMount = page.evaluate(async ({ excludedId, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount" && event.terminalId !== excludedId, { timeout });
    }, { excludedId: terminalId, timeout: WAIT_TIMEOUT_MS });
    await workbench.createTerminal();
    const [hiddenEvent, secondMounted] = await Promise.all([hiddenPromise, secondMount]);
    await workbench.expectCached(terminalId);
    await paneA.expectHidden();
    expect(hiddenEvent.snapshot.lifecycle).toMatchObject({
      mounted: true,
      visible: false,
      cached: true,
      active: false,
      focused: false,
      acceptingInput: false,
    });
    expect(hiddenEvent.snapshot.socketState).toBe("connected");
    expect(hiddenEvent.snapshot.activeSocketCount).toBe(1);
    expect(hiddenEvent.snapshot.socketGeneration).toBe(initialSocketGeneration);
    expect(hiddenEvent.snapshot.paneId).toBe(initialPaneId);
    expect(hiddenEvent.snapshot.renderer).toBe(initialRenderer.renderer);

    const terminalBId = secondMounted.terminalId;
    expect(terminalBId).not.toBe(terminalId);
    const paneB = workbench.terminal(terminalBId);
    await paneB.expectVisible();
    const initialB = await paneB.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    const bInitialViewport = initialB.serverViewport ?? initialB.sentViewport ?? initialB.viewport;
    if (!bInitialViewport) throw new Error("K-04 visible terminal viewport is unavailable");

    await page.setViewportSize(WIDE_VIEWPORT);
    const wideB = await waitForVisibleViewportChange(page, terminalBId, bInitialViewport);
    const wideServerViewport = wideB.serverViewport;
    if (!wideServerViewport) throw new Error("K-04 wide visible terminal has no server viewport");
    expect(wideServerViewport.cols).toBeGreaterThan(bInitialViewport.cols);

    const cachedAtWide = await waitForCachedViewport(page, terminalId, initialViewport);
    expect(cachedAtWide.lifecycle).toMatchObject({
      mounted: true,
      visible: false,
      cached: true,
      active: false,
      acceptingInput: false,
    });
    expect(cachedAtWide.serverViewport).toEqual(initialViewport);
    expect(cachedAtWide.sentViewport).toEqual(initialViewport);
    expect(cachedAtWide.socketGeneration).toBe(initialSocketGeneration);
    expect(cachedAtWide.activeSocketCount).toBe(1);
    expect(cachedAtWide.renderer).toBe(initialRenderer.renderer);
    expect(cachedAtWide.webglLoadCount).toBe(initialRenderer.webglLoadCount);
    expect(cachedAtWide.contextLossCount).toBe(initialRenderer.contextLossCount);
    expect(cachedAtWide.fallbackCount).toBe(initialRenderer.fallbackCount);


    const browser = page.context().browser();
    if (!browser) throw new Error("K-04 requires a browser capable of creating a second context");
    const secondContext = await browser.newContext({ baseURL, viewport: SECOND_CLIENT_VIEWPORT });
    contextB = secondContext;
    const secondPage = await secondContext.newPage();
    browserErrorsB = installBrowserErrorCollectors(secondPage);
    await secondPage.goto(baseURL);
    await new LoginPage(secondPage).login();
    const workbenchB = new WorkbenchPage(secondPage);
    await workbenchB.expectVisible();
    const paneAFromSecondClient = await workbenchB.openTerminal({ id: terminalId, name: terminalName });
    await paneAFromSecondClient.expectVisible();
    await paneAFromSecondClient.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    await waitForCachedViewport(page, terminalId, wideServerViewport);
    const beforeOutputSnapshot = await page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, (snapshot) => (
        snapshot.cached
        && !snapshot.visible
        && snapshot.socketState === "connected"
        && !snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.committedSequence !== undefined
        && snapshot.receivedSequence !== undefined
        && snapshot.committedSequence === snapshot.receivedSequence
      ), { timeout });
    }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
    const outputEventFloor = (await paneA.events()).reduce((maximum, event) => Math.max(maximum, event.id), -1);
    const baselineNetworkEvents = new Set(faultController.events);
    const baselineTranscript = await server.readTranscript(terminalId);
    const writeFloor = baselineTranscript.reduce((maximum, entry) => (
      entry.event === "write" && typeof entry.write_sequence === "number"
        ? Math.max(maximum, entry.write_sequence)
        : maximum
    ), 0);
    const baselineCommitted = beforeOutputSnapshot.committedSequence ?? beforeOutputSnapshot.receivedSequence ?? 0;
    const finalMarker = `${runId}-CACHED-FINAL`;
    const finalText = `${runId}-OUTPUT-AFTER-CACHE`;
    const finalMarkerBytes = printMarker(finalMarker, finalText);
    const expectedOutput = Buffer.concat([burstBytes(BURST_BYTES, BURST_LINE_WIDTH), finalMarkerBytes]);
    const expectedCommitted = baselineCommitted + expectedOutput.byteLength;

    const burstId = `${runId}-BURST`;
    await paneAFromSecondClient.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "burst"
      && entry.id === burstId
      && entry.bytes === BURST_BYTES
      && entry.line_width === BURST_LINE_WIDTH
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await paneAFromSecondClient.sendInput(`PRINT ${finalMarker} ${finalText}`, true);
    await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "print"
      && entry.id === finalMarker
      && entry.text === finalText
    ), { timeoutMs: WAIT_TIMEOUT_MS });

    const hiddenOutput = await waitForHiddenOutput(page, terminalId, expectedCommitted);
    expect(hiddenOutput.xterm.text).toContain(finalMarkerBytes.toString("utf8").trimEnd());
    expect(hiddenOutput.xterm.text.split(finalMarkerBytes.toString("utf8").trimEnd()).length - 1).toBe(1);
    expect(hiddenOutput.lifecycle).toMatchObject({
      mounted: true,
      visible: false,
      cached: true,
      active: false,
      focused: false,
      acceptingInput: false,
    });
    expect(hiddenOutput.socketState).toBe("connected");
    expect(hiddenOutput.socketGeneration).toBe(initialSocketGeneration);
    expect(hiddenOutput.activeSocketCount).toBe(1);
    expect(hiddenOutput.sentViewport).toEqual(initialViewport);
    expect(hiddenOutput.serverViewport).toEqual(wideServerViewport);

    const checkpoint = await waitForCheckpointAfter(page, terminalId, outputEventFloor, expectedCommitted);
    const checkpointSequence = eventNumber(checkpoint, "sequence");
    const checkpointEpoch = eventNumber(checkpoint, "epoch");
    const checkpointSize = eventNumber(checkpoint, "size");
    const checkpointChunks = eventNumber(checkpoint, "chunks");
    const serializationDuration = eventNumber(checkpoint, "serializationDurationMs");
    const uploadDuration = eventNumber(checkpoint, "uploadDurationMs");
    expect(checkpoint.data.result).toBe("sent");
    expect(checkpointSequence).toBeGreaterThanOrEqual(expectedCommitted);
    expect(checkpointEpoch).toBe(checkpoint.snapshot.gridEpoch);
    expect(checkpointSequence).toBe(checkpoint.snapshot.committedSequence);
    expect(checkpointSize).toBeGreaterThan(0);
    expect(checkpointSize).toBeLessThanOrEqual(MAX_CHECKPOINT_BYTES);
    expect(checkpointChunks).toBe(Math.ceil((checkpointSize ?? 0) / CHECKPOINT_CHUNK_BYTES));
    expect(serializationDuration).toBeGreaterThanOrEqual(0);
    expect(serializationDuration).toBeLessThanOrEqual(MAX_SERIALIZATION_DURATION_MS);
    expect(uploadDuration).toBeGreaterThanOrEqual(0);
    expect(uploadDuration).toBeLessThanOrEqual(MAX_UPLOAD_DURATION_MS);
    expect(checkpoint.snapshot.lifecycle).toMatchObject({
      mounted: true,
      visible: false,
      cached: true,
      active: false,
      acceptingInput: false,
    });

    const checkpointEvents = (await paneA.events()).filter((event) => (
      event.id > outputEventFloor
      && event.type === "checkpoint"
      && typeof event.data.sequence === "number"
      && event.data.sequence >= expectedCommitted
    ));
    expect(checkpointEvents).toHaveLength(1);
    expect(checkpointEvents.every((event) => event.data.result === "sent")).toBe(true);
    expect(checkpointEvents.every((event) => event.snapshot.lifecycle.cached && !event.snapshot.lifecycle.visible)).toBe(true);
    const frames = checkpointFrames(faultController.events, terminalId, initialSocketGeneration, baselineNetworkEvents);
    if (checkpointChunks === undefined) throw new Error("checkpoint event omitted serialized chunk count");
    expect(frames).toHaveLength(checkpointChunks);
    expect(frames.every((event) => (event.frame?.bytes ?? 0) > 0 && (event.frame?.bytes ?? 0) <= MAX_CHECKPOINT_FRAME_BYTES)).toBe(true);
    expect(frames.reduce((total, event) => total + (event.frame?.bytes ?? 0), 0)).toBeLessThanOrEqual((checkpointChunks ?? 0) * MAX_CHECKPOINT_FRAME_BYTES);

    const outputTranscript = await server.readTranscript(terminalId);
    expect(writeBytesSince(outputTranscript, writeFloor)).toEqual(expectedOutput);
    expect(outputTranscript.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
    expect(outputTranscript.filter((entry) => entry.event === "print" && entry.id === finalMarker)).toHaveLength(1);
    expect(outputTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);

    const hiddenEventsBeforeReveal = await paneA.events();
    expect(hiddenEventsBeforeReveal.filter((event) => event.type === "error")).toHaveLength(0);
    expect(hiddenOutput.renderer).toBe(initialRenderer.renderer);
    expect(hiddenOutput.webglLoadCount).toBe(initialRenderer.webglLoadCount);
    expect(hiddenOutput.contextLossCount).toBe(initialRenderer.contextLossCount);
    expect(hiddenOutput.fallbackCount).toBe(initialRenderer.fallbackCount);
    const hiddenInvariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(hiddenInvariantReport.violations).toEqual([]);
    await assertMonotonicSequences(hiddenInvariantReport.events);

    if (contextB) {
      await contextB.close();
      contextB = undefined;
    }
    await page.setViewportSize(INITIAL_VIEWPORT);
    const visibleBAtInitial = await page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, (snapshot) => (
        snapshot.visible
        && !snapshot.cached
        && snapshot.serverViewport !== undefined
        && snapshot.serverViewport.cols > 0
        && snapshot.serverViewport.rows > 0
      ), { timeout });
    }, { id: terminalBId, timeout: WAIT_TIMEOUT_MS });
    expect(visibleBAtInitial.lifecycle.visible).toBe(true);
    expect(visibleBAtInitial.lifecycle.cached).toBe(false);

    const revealPromise = page.evaluate(async ({ id, generation, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, (snapshot) => (
        snapshot.mounted
        && snapshot.visible
        && !snapshot.cached
        && snapshot.socketState === "connected"
        && snapshot.socketGeneration === generation
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.renderBacklogBytes === 0
      ), { timeout });
    }, { id: terminalId, generation: initialSocketGeneration, timeout: WAIT_TIMEOUT_MS });
    await workbench.openTerminal({ id: terminalId, name: terminalName });
    await paneA.expectVisible();
    const revealed = await revealPromise;
    expect(revealed.socketGeneration).toBe(initialSocketGeneration);
    expect(revealed.activeSocketCount).toBe(1);
    expect(revealed.lifecycle).toMatchObject({
      mounted: true,
      visible: true,
      cached: false,
      active: true,
      acceptingInput: true,
    });
    expect(revealed.xterm.text).toContain(finalMarkerBytes.toString("utf8").trimEnd());
    expect(revealed.xterm.text.split(finalMarkerBytes.toString("utf8").trimEnd()).length - 1).toBe(1);
    await expectTerminalConverged(page, terminalId, {
      cols: revealed.cols,
      rows: revealed.rows,
    }, { timeout: WAIT_TIMEOUT_MS });

    const afterReveal = await screenshotRegion(page, screenA);
    await expectTerminalPixelsChanged(beforeInitialMarker, afterReveal, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "k-04-after-reveal-marker",
    });
    await expectTerminalNonBlank(page, screenA, {
      testInfo,
      artifactName: "k-04-after-reveal-terminal",
    });
    await expectTerminalBuffer(page, terminalId, {
      contains: finalMarkerBytes.toString("utf8").trimEnd(),
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const echoId = `${runId}-ECHO`;
    const echoText = `${runId}-INPUT-AFTER-REVEAL`;
    await paneA.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await paneA.sendInput(echoText, true);
    const echoPayload = await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
    expect(echoPayload.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));

    const finalTranscript = await server.readTranscript(terminalId);
    expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
    expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);
    const finalEvents = await paneA.events();
    expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
    expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
    expect(finalEvents.at(-1)?.snapshot.activeSocketCount).toBe(1);
    const finalInvariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(finalInvariantReport.violations).toEqual([]);
    await assertMonotonicSequences(finalInvariantReport.events);

    const unexpectedBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || entry.kind === "console" && /^error:/i.test(entry.message)
    ));
    expect(unexpectedBrowserErrors).toEqual([]);
    if (browserErrorsB) {
      const secondClientErrors = browserErrorsB().filter((entry) => (
        entry.kind === "pageerror"
        || entry.kind === "requestfailed"
        || entry.kind === "console" && /^error:/i.test(entry.message)
      ));
      expect(secondClientErrors).toEqual([]);
    }
  } finally {
    browserErrors.dispose();
    browserErrorsB?.dispose();
    await contextB?.close();
  }
});
