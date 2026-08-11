import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import type { Page, TestInfo } from "@playwright/test";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 30_000;
const BURST_BYTES = 32 * 1024;
const BURST_LINE_WIDTH = 80;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

function printLine(id: string, text: string): string {
  return `[E2E:PRINT:${id}:${text}]\n`;
}

function latestEventId(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((latest, event) => Math.max(latest, event.id), -1);
}

function bytesWrittenSince(entries: readonly Record<string, unknown>[], writeFloor: number): number {
  return entries
    .filter((entry) => entry.event === "write" && typeof entry.write_sequence === "number" && entry.write_sequence > writeFloor)
    .reduce((total, entry) => total + (typeof entry.bytes === "number" ? entry.bytes : 0), 0);
}

function lastWriteSequence(entries: readonly Record<string, unknown>[]): number {
  return entries.reduce((latest, entry) => (
    entry.event === "write" && typeof entry.write_sequence === "number"
      ? Math.max(latest, entry.write_sequence)
      : latest
  ), 0);
}

async function waitForPageVisibility(page: Page, state: "hidden" | "visible"): Promise<number> {
  return page.evaluate(async ({ expected, timeout }) => {
    if (document.visibilityState === expected) return Date.now();
    return await new Promise<number>((resolve, reject) => {
      let timer: number | undefined;
      const cleanup = () => {
        document.removeEventListener("visibilitychange", changed);
        if (timer !== undefined) window.clearTimeout(timer);
      };
      const changed = () => {
        if (document.visibilityState !== expected) return;
        cleanup();
        resolve(Date.now());
      };
      document.addEventListener("visibilitychange", changed);
      timer = window.setTimeout(() => {
        cleanup();
        reject(new Error(`document visibility did not become ${expected}`));
      }, timeout);
    });
  }, { expected: state, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  acceptingInput = false,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, accepting, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && (!accepting || snapshot.acceptingInput)
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
      && (snapshot.syncTarget === undefined || snapshot.committedSequence >= snapshot.syncTarget)
    ), { timeout });
  }, { id: terminalId, accepting: acceptingInput, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForHiddenOutput(
  page: Page,
  terminalId: string,
  marker: string,
  sequenceFloor: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expectedMarker, floor, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.xterm.text.includes(expectedMarker)
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence !== undefined
      && snapshot.receivedSequence > floor
      && snapshot.committedSequence === snapshot.receivedSequence
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
    ), { timeout });
  }, { id: terminalId, expectedMarker: marker, floor: sequenceFloor, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForRenderAfterVisibility(
  page: Page,
  terminalId: string,
  eventFloor: number,
  visibleAt: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, floor, timestamp, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > floor && event.type === "render" && event.timestamp >= timestamp,
      { timeout, afterId: floor },
    );
  }, { id: terminalId, floor: eventFloor, timestamp: visibleAt, timeout: WAIT_TIMEOUT_MS });
}

function unexpectedBrowserErrors(errors: readonly { kind: string; message: string }[]): readonly unknown[] {
  return errors.filter((entry) => (
    entry.kind === "pageerror"
    || (entry.kind === "console" && /^(?:error|warning):/i.test(entry.message))
    || /unhandled(?:promise)?|uncaught/i.test(entry.message)
  ));
}

function assertSocketLifecycle(events: readonly E2ETerminalEvent[], final: E2ETerminalSnapshot): void {
  const created = events.filter((event) => event.type === "socket-created");
  const closed = events.filter((event) => event.type === "socket-close");
  expect(created.length).toBeGreaterThanOrEqual(1);
  expect(created.length).toBeLessThanOrEqual(2);
  expect(closed.length).toBe(created.length - 1);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  const generations = created
    .map((event) => event.data.generation)
    .filter((generation): generation is number => typeof generation === "number");
  expect(generations.length).toBe(created.length);
  expect(generations).toEqual([...generations].sort((left, right) => left - right));
  expect(final.socketGeneration).toBe(generations.at(-1));
  expect(final.activeSocketCount).toBe(1);
  expect(final.socket.activeCount).toBe(1);
}

function assertFixtureGeometry(
  snapshot: E2ETerminalSnapshot,
  size: { readonly rows: number; readonly cols: number; readonly pixel_width?: number; readonly pixel_height?: number },
  transcript: readonly Record<string, unknown>[],
): void {
  expect(size.rows).toBe(snapshot.rows);
  expect(size.cols).toBe(snapshot.cols);
  const serverViewport = snapshot.serverViewport;
  if (!serverViewport) throw new Error("R-04 final snapshot has no server-selected viewport");
  expect(serverViewport.rows).toBe(snapshot.rows);
  expect(serverViewport.cols).toBe(snapshot.cols);
  if (size.pixel_width !== undefined) expect(size.pixel_width).toBe(snapshot.pixelWidth);
  if (size.pixel_height !== undefined) expect(size.pixel_height).toBe(snapshot.pixelHeight);
  expect(serverViewport.pixelWidth).toBe(snapshot.pixelWidth);
  expect(serverViewport.pixelHeight).toBe(snapshot.pixelHeight);

  const winches = transcript.filter((entry) => entry.event === "sigwinch");
  expect(winches.length).toBeGreaterThan(0);
  let previousSequence = 0;
  for (const winch of winches) {
    expect(typeof winch.signal_sequence).toBe("number");
    expect(Number(winch.signal_sequence)).toBeGreaterThan(previousSequence);
    expect(Number(winch.rows)).toBeGreaterThan(0);
    expect(Number(winch.cols)).toBeGreaterThan(0);
    previousSequence = Number(winch.signal_sequence);
  }
  expect(winches.some((entry) => entry.rows === snapshot.rows && entry.cols === snapshot.cols)).toBe(true);
}

test("R-04 Page visibility hidden and visible @p1 @pr @nightly @lifecycle @visibility", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo: TestInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let pageB: Page | undefined;
  let browserErrorsB: BrowserErrorCollector | undefined;
  let secondaryBrowserErrors: readonly unknown[] = [];

  const runTag = `${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}`;
  const readyId = `R04-${runTag}-READY`;
  const beforeId = `R04-${runTag}-BEFORE`;
  const beforeText = `R04-${runTag}-VISIBLE`;
  const holdToken = `R04-${runTag}-HOLD`;
  const burstId = `R04-${runTag}-BURST`;
  const hiddenId = `R04-${runTag}-HIDDEN`;
  const hiddenText = `R04-${runTag}-OUTPUT`;
  const echoId = `R04-${runTag}-ECHO`;
  const echoText = `R04-${runTag}-CONTINUED-INPUT`;
  const sizeId = `R04-${runTag}-SIZE`;
  const readyMarker = `[E2E:READY:${readyId}]`;
  const beforeMarker = printLine(beforeId, beforeText).trimEnd();
  const holdMarker = `[E2E:HOLD:${holdToken}]`;
  const hiddenMarker = printLine(hiddenId, hiddenText).trimEnd();
  const releaseMarker = `[E2E:RELEASE:${holdToken}]`;
  const echoMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;

  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const mountPromise = page.evaluate(async ({ timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent("mount", { timeout });
    }, { timeout: WAIT_TIMEOUT_MS });
    await workbench.createTerminal();
    const mounted = await mountPromise;
    const terminalId = mounted.terminalId;
    const pane = workbench.terminal(terminalId);
    await pane.expectVisible();
    const terminalName = (await pane.root.getAttribute("aria-label"))?.replace(/^Terminal(?: pane)?\s+/i, "");
    if (!terminalName) throw new Error("R-04 terminal has no accessible name");

    const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(initial.cols).toBeGreaterThan(0);
    expect(initial.rows).toBeGreaterThan(0);
    expect(initial.serverViewport).toBeDefined();
    expect(initial.serverViewport?.cols).toBe(initial.cols);
    expect(initial.serverViewport?.rows).toBe(initial.rows);
    expect(initial.activeSocketCount).toBe(1);
    const initialReceived = initial.receivedSequence;
    if (initialReceived === undefined) throw new Error("R-04 initial synchronized snapshot has no received sequence");

    const initialProxyConnection = await faultController.waitFor(
      (event) => event.type === "connection-open" && event.terminalId === terminalId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(initialProxyConnection.generation).toBeDefined();

    const readyTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "ready" && entry.id === readyId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(`READY ${readyId}`, true);
    await readyTranscript;
    await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const beforeTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
    await beforeTranscript;
    await expectTerminalBuffer(page, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: "r-04-before-hidden",
    });

    const holdTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "hold" && entry.token === holdToken,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const holdWriteTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "write" && entry.text === `${holdMarker}\n`,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(`HOLD ${holdToken}`, true);
    await Promise.all([holdTranscript, holdWriteTranscript]);
    await expectTerminalBuffer(page, terminalId, { contains: holdMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const beforeHidden = await waitForSettledTerminal(page, terminalId);
    const beforePixels = await screenshotRegion(page, pane.xtermHost);
    const beforeEvents = await terminalEvents(page, terminalId);
    const beforeEventFloor = latestEventId(beforeEvents);
    const baselineTranscript = await server.readTranscript(terminalId);
    const writeFloor = lastWriteSequence(baselineTranscript);
    const baselineReceived = beforeHidden.receivedSequence;
    if (baselineReceived === undefined) throw new Error("R-04 baseline snapshot has no received sequence");

    pageB = await page.context().newPage();
    browserErrorsB = installBrowserErrorCollectors(pageB);
    const viewport = page.viewportSize();
    if (viewport) await pageB.setViewportSize(viewport);
    await pageB.goto(baseURL);
    const workbenchB = new WorkbenchPage(pageB);
    if (await pageB.locator(".workbench").isVisible()) await workbenchB.expectVisible();
    else await new LoginPage(pageB).login();
    await workbenchB.expectVisible();
    const paneB = await workbenchB.openTerminal({ id: terminalId, name: terminalName });
    await paneB.expectVisible();
    const secondary = await expectTerminalSynchronized(pageB, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(secondary.socketState).toBe("connected");
    expect(secondary.activeSocketCount).toBe(1);

    await page.bringToFront();
    await waitForPageVisibility(page, "visible");
    const hiddenVisibility = waitForPageVisibility(page, "hidden");
    await pageB.bringToFront();
    try {
      await hiddenVisibility;
    } catch (error) {
      const state = await page.evaluate(() => document.visibilityState);
      if (state !== "hidden") {
        testInfo.annotations.push({ type: "visibility-capability", description: "browser did not expose a hidden document state for a background tab" });
        test.skip(true, "Page visibility hidden is unavailable in this browser configuration");
        return;
      }
      throw error;
    }
    expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");

    const burstTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES && entry.line_width === BURST_LINE_WIDTH,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const burstWriteTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "write" && entry.bytes === BURST_BYTES,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const hiddenTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === hiddenId && entry.text === hiddenText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const hiddenWriteTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "write" && entry.text === `${hiddenMarker}\n`,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const releaseTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "release" && entry.token === holdToken,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const releaseWriteTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "write" && entry.text === `${releaseMarker}\n`,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await paneB.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    await paneB.sendInput(`PRINT ${hiddenId} ${hiddenText}`, true);
    await paneB.sendInput(`RELEASE ${holdToken}`, true);
    await Promise.all([
      burstTranscript,
      burstWriteTranscript,
      hiddenTranscript,
      hiddenWriteTranscript,
      releaseTranscript,
      releaseWriteTranscript,
    ]);

    const afterHiddenTranscript = await server.readTranscript(terminalId);
    expect(afterHiddenTranscript.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
    expect(afterHiddenTranscript.filter((entry) => entry.event === "print" && entry.id === hiddenId)).toHaveLength(1);
    expect(afterHiddenTranscript.filter((entry) => entry.event === "release" && entry.token === holdToken)).toHaveLength(1);
    const hiddenWrites = afterHiddenTranscript.filter((entry) => (
      entry.event === "write"
      && typeof entry.write_sequence === "number"
      && entry.write_sequence > writeFloor
    ));
    expect(hiddenWrites).toHaveLength(3);
    const hiddenOutputBytes = bytesWrittenSince(afterHiddenTranscript, writeFloor);
    const expectedHiddenBytes = BURST_BYTES + Buffer.byteLength(printLine(hiddenId, hiddenText), "utf8") + Buffer.byteLength(`${releaseMarker}\n`, "utf8");
    expect(hiddenOutputBytes).toBe(expectedHiddenBytes);

    const hiddenSnapshot = await waitForHiddenOutput(page, terminalId, hiddenMarker, baselineReceived);
    expect(hiddenSnapshot.receivedSequence).toBe(baselineReceived + hiddenOutputBytes);
    expect(hiddenSnapshot.committedSequence).toBe(hiddenSnapshot.receivedSequence);
    expect(hiddenSnapshot.lifecycle.mounted).toBe(true);
    expect(hiddenSnapshot.lifecycle.visible).toBe(true);
    expect(hiddenSnapshot.lifecycle.cached).toBe(false);
    await expectTerminalBuffer(page, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: hiddenMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: releaseMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const hiddenEvents = await terminalEvents(page, terminalId);
    expect(hiddenEvents.some((event) => event.id > beforeEventFloor && event.type === "output-received")).toBe(true);
    expect(hiddenEvents.some((event) => event.id > beforeEventFloor && event.type === "parser-commit")).toBe(true);
    expect(hiddenEvents.filter((event) => event.type === "error")).toHaveLength(0);
    expect(hiddenEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);

    const revealEventFloor = latestEventId(hiddenEvents);
    const hiddenRenderCount = hiddenSnapshot.renderCount;
    const visibleWait = waitForPageVisibility(page, "visible");
    await page.bringToFront();
    const visibleAt = await visibleWait;
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
    const revealRender = await waitForRenderAfterVisibility(page, terminalId, revealEventFloor, visibleAt);
    expect(revealRender.snapshot.renderCount).toBeGreaterThan(hiddenRenderCount);
    expect(revealRender.snapshot.xterm.text).toContain(hiddenMarker);
    const revealed = await waitForSettledTerminal(page, terminalId);
    expect(revealed.socketState).toBe("connected");
    expect(revealed.pendingParserWrites).toBe(0);
    expect(revealed.renderBacklogBytes).toBe(0);
    expect(revealed.renderBacklogFrames).toBe(0);
    expect(revealed.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);

    const revealedPixels = await expectKnownMarkerChanged(page, pane.xtermHost, beforePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "r-04-after-visible-marker",
    });
    expect(revealedPixels.after.width).toBe(beforePixels.width);
    expect(revealedPixels.after.height).toBe(beforePixels.height);
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: "r-04-after-visible-nonblank",
    });

    secondaryBrowserErrors = browserErrorsB ? unexpectedBrowserErrors(browserErrorsB()) : [];
    expect(secondaryBrowserErrors).toEqual([]);
    browserErrorsB?.dispose();
    await pageB.close();
    pageB = undefined;
    browserErrorsB = undefined;
    await pane.expectVisible();
    await pane.focus();

    const echoArmTranscript = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await echoArmTranscript;
    const echoPayloadTranscript = server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64?: string }>(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(echoText, true);
    const echoPayload = await echoPayloadTranscript;
    expect(echoPayload.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
    await expectTerminalBuffer(page, terminalId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const sizeTranscript = server.waitForTranscript<{ event: string; id: string; rows: number; cols: number; pixel_width?: number; pixel_height?: number }>(
      terminalId,
      (entry) => entry.event === "size" && entry.id === sizeId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(`SIZE ${sizeId}`, true);
    const size = await sizeTranscript;
    const final = await waitForSettledTerminal(page, terminalId, true);
    const sizeMarker = `[E2E:SIZE:${sizeId}:${size.rows}:${size.cols}]`;
    await expectTerminalBuffer(page, terminalId, { contains: sizeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    assertFixtureGeometry(final, size, await server.readTranscript(terminalId));

    const finalTranscript = await server.readTranscript(terminalId);
    expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed")).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
    expect(finalTranscript.filter((entry) => entry.event === "exit")).toHaveLength(0);
    expect(server.stderr).not.toMatch(/\b(?:panic|internal server error|fatal error)\b/i);

    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
    await assertMonotonicSequences(invariantReport.events);
    assertSocketLifecycle(invariantReport.events, final);
    expect(final.receivedSequence).toBe(final.committedSequence);
    expect(final.syncTarget === undefined || final.committedSequence === undefined || final.committedSequence >= final.syncTarget).toBe(true);
    expect(final.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(final.renderBacklogBytes).toBe(0);
    expect(final.renderBacklogFrames).toBe(0);

    const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
    expect(networkEvents.filter((event) => ["socket-error", "malformed-frame", "terminated", "dropped", "injected"].includes(event.type))).toHaveLength(0);
    expect(networkEvents.filter((event) => event.type === "connection-open").length).toBeGreaterThanOrEqual(2);
    expect(networkEvents.some((event) => (
      event.type === "frame"
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "resize"
    ))).toBe(true);

    const errorsA = unexpectedBrowserErrors(browserErrors());
    expect(errorsA).toEqual([]);
    expect(secondaryBrowserErrors).toEqual([]);
  } finally {
    browserErrorsB?.dispose();
    if (pageB && !pageB.isClosed()) await pageB.close();
  }
});
