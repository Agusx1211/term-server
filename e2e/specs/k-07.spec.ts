import { expect, test } from "../fixtures/test.js";
import type { BrowserContext, Page } from "@playwright/test";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 30_000;
const GEOMETRY_A = { width: 1_024, height: 768 };
const GEOMETRY_B = { width: 1_920, height: 1_200 };

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TranscriptEntry = Record<string, unknown>;

type TerminalApiInfo = {
  readonly id: string;
  readonly name: string;
};

function numericField(data: Readonly<Record<string, unknown>>, key: string): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`diagnostic event field ${key} is not a finite number`);
  }
  return value;
}

async function waitForCheckpoint(
  page: Page,
  terminalId: string,
  sequence: number,
  epoch: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, sequence: expectedSequence, epoch: expectedEpoch, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.checkpointResult === "sent"
        && snapshot.checkpointSequence === expectedSequence
        && snapshot.checkpointEpoch === expectedEpoch,
      { timeout },
    );
  }, { id: terminalId, sequence, epoch, timeout: WAIT_TIMEOUT_MS });
}

async function waitForStaleReconnect(
  page: Page,
  terminalId: string,
  generation: number,
  sequence: number,
  epoch: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation: expectedGeneration, sequence: expectedSequence, epoch: expectedEpoch, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => {
        if (
          snapshot.socketGeneration !== expectedGeneration
          || snapshot.socketReadyState !== 0
          || snapshot.socketState !== "connecting"
          || !snapshot.socketUrl
        ) return false;
        try {
          const url = new URL(snapshot.socketUrl);
          return Number(url.searchParams.get("sequence")) === expectedSequence
            && Number(url.searchParams.get("epoch")) === expectedEpoch;
        } catch {
          return false;
        }
      },
      { timeout },
    );
  }, { id: terminalId, generation, sequence, epoch, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRecoveredTerminal(
  page: Page,
  terminalId: string,
  generation: number,
  sequence: number,
  epoch: number,
  viewport: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generation: expectedGeneration, sequence: expectedSequence, epoch: expectedEpoch, viewport: expectedViewport, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.socketGeneration === expectedGeneration
        && snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.gridEpoch === expectedEpoch
        && snapshot.committedSequence === expectedSequence
        && snapshot.receivedSequence === expectedSequence
        && snapshot.syncMode === undefined
        && snapshot.serverViewport?.cols === expectedViewport.cols
        && snapshot.serverViewport?.rows === expectedViewport.rows
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0,
      { timeout },
    );
  }, { id: terminalId, generation, sequence, epoch, viewport, timeout: WAIT_TIMEOUT_MS });
}


async function waitForResizedTerminal(
  page: Page,
  terminalId: string,
  sequence: number,
  previousEpoch: number,
  previousViewport: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, sequence: expectedSequence, previousEpoch: minimumEpoch, previousViewport: oldViewport, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.gridEpoch !== undefined
        && snapshot.gridEpoch > minimumEpoch
        && snapshot.committedSequence === expectedSequence
        && snapshot.receivedSequence === expectedSequence
        && snapshot.serverViewport !== undefined
        && (snapshot.serverViewport.cols !== oldViewport.cols || snapshot.serverViewport.rows !== oldViewport.rows),
      { timeout },
    );
  }, { id: terminalId, sequence, previousEpoch, previousViewport, timeout: WAIT_TIMEOUT_MS });
}

test("K-07 Resize invalidates checkpoint @nightly @p1 @checkpoint @epoch @resize", async ({
  browser,
  baseURL,
  faultController,
  page,
  server,
}, testInfo) => {
  await page.setViewportSize(GEOMETRY_A);
  const initialErrors = installBrowserErrorCollectors(page);
  let peerContext: BrowserContext | undefined;
  let peerPage: Page | undefined;
  let peerErrors: BrowserErrorCollector | undefined;
  let terminateFault: (() => void) | undefined;
  let pauseFault: (() => void) | undefined;

  const markerToken = `W${testInfo.workerIndex}P${testInfo.parallelIndex}R${testInfo.repeatEachIndex}T${testInfo.retry}`;
  const readyId = `K07_READY_${markerToken}`;
  const baselineId = `K07_BASELINE_${markerToken}`;
  const baselineText = `K07-BASELINE-${markerToken}`;
  const echoId = `K07_ECHO_${markerToken}`;
  const echoText = `K07-CONTINUED-${markerToken}`;
  const sizeId = `K07_SIZE_${markerToken}`;
  const baselineMarker = `[E2E:PRINT:${baselineId}:${baselineText}]`;
  const echoMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;

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
    if (!created.id || !created.name) throw new Error("created terminal did not expose an id and name");
    const terminalId = created.id;
    const pane = new TerminalPanePage(page, terminalId, created.name);
    await pane.expectVisible();
    const initial = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    if (initial.gridEpoch === undefined) throw new Error("initial synchronized terminal did not expose a grid epoch");
    if (initial.committedSequence === undefined) throw new Error("initial synchronized terminal did not expose a committed sequence");
    const initialEpoch = initial.gridEpoch;

    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "ready" && entry.id === readyId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );

    const beforeBaselinePixels = await screenshotRegion(page, pane.xtermHost);
    await pane.sendInput(`PRINT ${baselineId} ${baselineText}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === baselineId && entry.text === baselineText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const baselineRendered = await page.evaluate(async ({ id, marker, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(
        id,
        (snapshot) => snapshot.xterm.text.replace(/\s+/g, "").includes(marker.replace(/\s+/g, ""))
          && snapshot.pendingParserWrites === 0
          && snapshot.pendingParserBytes === 0
          && snapshot.renderBacklogBytes === 0
          && snapshot.renderBacklogFrames === 0,
        { timeout },
      );
    }, { id: terminalId, marker: baselineMarker, timeout: WAIT_TIMEOUT_MS });
    const afterBaselinePixels = await screenshotRegion(page, pane.xtermHost);
    await expectTerminalPixelsChanged(beforeBaselinePixels, afterBaselinePixels, { minimumChangedRatio: 0.002 });
    await expectTerminalNonBlank(page, pane.xtermHost);
    expect(baselineRendered.xterm.text).toContain(baselineMarker);
    if (baselineRendered.committedSequence === undefined) throw new Error("baseline marker did not commit an output sequence");
    const checkpointSequence = baselineRendered.committedSequence;
    const checkpointEpoch = baselineRendered.gridEpoch;
    if (checkpointEpoch === undefined) throw new Error("baseline marker did not retain a grid epoch");
    expect(checkpointEpoch).toBe(initialEpoch);

    const checkpointSnapshot = await waitForCheckpoint(page, terminalId, checkpointSequence, checkpointEpoch);
    expect(checkpointSnapshot.checkpointResult).toBe("sent");
    expect(checkpointSnapshot.checkpointSequence).toBe(checkpointSequence);
    expect(checkpointSnapshot.checkpointEpoch).toBe(checkpointEpoch);
    expect(checkpointSnapshot.checkpointSize).toBeGreaterThan(0);
    expect(checkpointSnapshot.checkpointChunks).toBeGreaterThan(0);
    const baselineEvents = await terminalEvents(page, terminalId);
    const baselineCheckpointEvents = baselineEvents.filter((event) => (
      event.type === "checkpoint"
      && event.data.result === "sent"
      && event.data.sequence === checkpointSequence
      && event.data.epoch === checkpointEpoch
    ));
    expect(baselineCheckpointEvents).toHaveLength(1);
    const checkpointFrameCount = checkpointSnapshot.checkpointChunks;
    // The live browser uploads a checkpoint as one `checkpointBinary` JSON
    // announcement followed by binary body frames whose nine-byte header
    // carries kind byte 2 and the announced sequence, which the proxy decodes
    // as `binaryKind` and `sequence`.
    const binaryCheckpointBodyFrames = () => faultController.events.filter((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.direction === "browser-to-server"
      && event.generation === checkpointSnapshot.socketGeneration
      && event.frame?.binaryKind === 2
      && event.frame.sequence === checkpointSequence
    ));
    await faultController.waitFor((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.direction === "browser-to-server"
      && event.generation === checkpointSnapshot.socketGeneration
      && event.frame?.jsonType === "checkpointBinary"
      && event.frame.sequence === checkpointSequence
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await faultController.waitFor((event) => (
      event.type === "frame"
      && event.terminalId === terminalId
      && event.direction === "browser-to-server"
      && event.frame?.binaryKind === 2
      && binaryCheckpointBodyFrames().length >= checkpointFrameCount
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const checkpointBodyFrames = binaryCheckpointBodyFrames();
    expect(checkpointBodyFrames.length).toBeGreaterThanOrEqual(checkpointFrameCount);
    expect(checkpointBodyFrames.at(-1)?.frame?.occurrence).toBeGreaterThanOrEqual(checkpointFrameCount);
    const initialTranscript = await server.readTranscript<TranscriptEntry>(terminalId);
    const initialWriteCount = initialTranscript.filter((entry) => entry.event === "write").length;
    const initialWinchCount = initialTranscript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal").length;
    const initialSocketGeneration = checkpointSnapshot.socketGeneration;
    expect(initialSocketGeneration).toBeGreaterThan(0);

    // Prepare the second real browser client before pausing the first socket;
    // the resize and reconnect boundaries below are explicit proxy barriers.
    peerContext = await browser.newContext({ baseURL, viewport: GEOMETRY_B });
    peerPage = await peerContext.newPage();
    peerErrors = installBrowserErrorCollectors(peerPage);
    await peerPage.goto(baseURL);
    await new LoginPage(peerPage).login();
    const peerWorkbench = new WorkbenchPage(peerPage);
    await peerWorkbench.expectVisible();

    const reconnectGeneration = initialSocketGeneration + 1;
    const pausedFirst = faultController.waitFor((event) => (
      event.type === "paused"
      && event.terminalId === terminalId
      && event.generation === initialSocketGeneration
      && event.direction === "server-to-browser"
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    pauseFault = faultController.pause("server-to-browser", {
      terminalId,
      generation: initialSocketGeneration,
    });
    await pausedFirst;

    const peerPane = await peerWorkbench.openTerminal({ id: terminalId, name: created.name });
    await peerPane.expectVisible();
    const peerSynchronized = await peerPane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    await peerPane.focusSize();
    const peerInteractive = await waitForResizedTerminal(
      peerPage,
      terminalId,
      checkpointSequence,
      checkpointEpoch,
      { cols: initial.cols, rows: initial.rows },
    );
    expect(peerInteractive.gridEpoch).toBeDefined();
    if (peerInteractive.gridEpoch === undefined) throw new Error("resizing browser did not expose a grid epoch");
    const resizedEpoch = peerInteractive.gridEpoch;
    expect(resizedEpoch).toBeGreaterThan(checkpointEpoch);
    expect(peerInteractive.committedSequence).toBe(checkpointSequence);
    expect(peerInteractive.receivedSequence).toBe(checkpointSequence);
    expect(peerInteractive.serverViewport).toBeDefined();
    if (!peerInteractive.serverViewport) throw new Error("resizing browser did not expose a server viewport");
    const resizedViewport = {
      cols: peerInteractive.serverViewport.cols,
      rows: peerInteractive.serverViewport.rows,
      pixelWidth: peerInteractive.serverViewport.pixelWidth,
      pixelHeight: peerInteractive.serverViewport.pixelHeight,
    };
    expect(resizedViewport.cols !== initial.cols || resizedViewport.rows !== initial.rows).toBe(true);
    expect(peerInteractive.cols).toBe(resizedViewport.cols);
    expect(peerInteractive.rows).toBe(resizedViewport.rows);
    expect(peerSynchronized.xterm.text).toContain(baselineMarker);

    const resizedWinch = await server.waitForTranscript<TranscriptEntry>(
      terminalId,
      (entry) => entry.event === "sigwinch"
        && entry.source === "signal"
        && entry.rows === resizedViewport.rows
        && entry.cols === resizedViewport.cols,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(resizedWinch.rows).toBe(resizedViewport.rows);
    expect(resizedWinch.cols).toBe(resizedViewport.cols);
    const resizedTranscript = await server.readTranscript<TranscriptEntry>(terminalId);
    expect(resizedTranscript.filter((entry) => entry.event === "write")).toHaveLength(initialWriteCount);
    expect(resizedTranscript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal")).toHaveLength(initialWinchCount + 1);

    await expectTerminalNonBlank(peerPage, peerPane.xtermHost);
    const peerReport = await expectConnectedTerminalInvariants(peerPage, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(peerReport.snapshot.gridEpoch).toBe(resizedEpoch);
    expect(peerReport.snapshot.committedSequence).toBe(checkpointSequence);
    expect(peerReport.snapshot.receivedSequence).toBe(checkpointSequence);
    expect(peerReport.snapshot.serverViewport?.cols).toBe(resizedViewport.cols);
    expect(peerReport.snapshot.serverViewport?.rows).toBe(resizedViewport.rows);
    expect(peerReport.events.filter((event) => event.type === "error")).toEqual([]);
    await assertMonotonicSequences(peerReport.events);
    const firstClose = faultController.waitFor((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation === initialSocketGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const firstSocketClose = page.evaluate(async ({ id, generation, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent(
        id,
        (event) => event.type === "socket-close" && event.data.generation === generation,
        { timeout },
      );
    }, { id: terminalId, generation: initialSocketGeneration, timeout: WAIT_TIMEOUT_MS });
    terminateFault = faultController.terminate({ terminalId, generation: initialSocketGeneration });
    await Promise.all([firstClose, firstSocketClose]);
    terminateFault();
    terminateFault = undefined;
    pauseFault?.();
    pauseFault = undefined;

    const staleReconnect = waitForStaleReconnect(
      page,
      terminalId,
      reconnectGeneration,
      checkpointSequence,
      checkpointEpoch,
    );
    await staleReconnect;
    // The stale URL was created before this viewport update. Matching the
    // resized client geometry prevents a second PTY resize when it opens.
    await page.setViewportSize(GEOMETRY_B);
    const beforeRecoveryPixels = await screenshotRegion(page, pane.xtermHost);
    const staleProxyOpen = faultController.waitFor((event) => (
      event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation === reconnectGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const recoveredPromise = waitForRecoveredTerminal(
      page,
      terminalId,
      reconnectGeneration,
      checkpointSequence,
      resizedEpoch,
      resizedViewport,
    );
    const [staleOpen, recovered] = await Promise.all([staleProxyOpen, recoveredPromise]);
    expect(staleOpen.generation).toBe(reconnectGeneration);
    expect(recovered.socketGeneration).toBe(reconnectGeneration);

    const recoveryEvents = await terminalEvents(page, terminalId);
    const recoverySyncs = recoveryEvents.filter((event) => event.type === "sync" && event.data.generation === reconnectGeneration);
    expect(recoverySyncs).toHaveLength(1);
    const recoverySync = recoverySyncs[0];
    if (!recoverySync) throw new Error("stale reconnect did not record a sync event");
    expect(recoverySync.data.mode).toBe("snapshot");
    expect(numericField(recoverySync.data, "sequence")).toBe(checkpointSequence);
    expect(numericField(recoverySync.data, "epoch")).toBe(resizedEpoch);
    expect(recoverySync.data.mode).not.toBe("resume");
    expect(recoverySync.data.epoch).not.toBe(checkpointEpoch);
    expect(
      recoveryEvents.filter((event) => (
        event.type === "checkpoint"
        && event.id > recoverySync.id
        && event.data.epoch === checkpointEpoch
      )),
    ).toEqual([]);

    const recoverySynced = recoveryEvents.filter((event) => event.type === "synced" && event.data.generation === reconnectGeneration);
    expect(recoverySynced).toHaveLength(1);
    expect(numericField(recoverySynced[0]!.data, "epoch")).toBe(resizedEpoch);
    expect(recoveryEvents.filter((event) => event.type === "socket-stale")).toEqual([]);
    expect(recoveryEvents.filter((event) => event.type === "error")).toEqual([]);
    await expectTerminalBuffer(page, terminalId, { contains: baselineMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(page, pane.xtermHost);
    const recoveredPixels = await screenshotRegion(page, pane.xtermHost);
    expect(recoveredPixels.width).toBe(beforeRecoveryPixels.width);
    expect(recoveredPixels.height).toBe(beforeRecoveryPixels.height);


    if (!peerContext || !peerPage || !peerErrors) throw new Error("resize browser context was not initialized");
    const peerGeneration = peerInteractive.socketGeneration;
    const peerClose = faultController.waitFor((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation === peerGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await peerContext.close();
    peerContext = undefined;
    peerPage = undefined;
    await peerClose;

    const converged = await expectTerminalConverged(page, terminalId, {
      cols: resizedViewport.cols,
      rows: resizedViewport.rows,
      pixelWidth: resizedViewport.pixelWidth,
      pixelHeight: resizedViewport.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    expect(converged.cols).toBe(resizedViewport.cols);
    expect(converged.rows).toBe(resizedViewport.rows);
    expect(converged.serverViewport?.cols).toBe(resizedViewport.cols);
    expect(converged.serverViewport?.rows).toBe(resizedViewport.rows);
    expect(converged.viewport.cols).toBe(resizedViewport.cols);
    expect(converged.viewport.rows).toBe(resizedViewport.rows);

    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(echoText, true);
    const echoPayload = await server.waitForTranscript<TranscriptEntry>(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(echoPayload.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
    await expectTerminalBuffer(page, terminalId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    await pane.sendInput(`SIZE ${sizeId}`, true);
    const sizeEntry = await server.waitForTranscript<TranscriptEntry>(
      terminalId,
      (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(sizeEntry.rows).toBe(resizedViewport.rows);
    expect(sizeEntry.cols).toBe(resizedViewport.cols);
    expect(sizeEntry.pixel_width).toBe(resizedViewport.pixelWidth);
    expect(sizeEntry.pixel_height).toBe(resizedViewport.pixelHeight);
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:SIZE:${sizeId}:${sizeEntry.rows}:${sizeEntry.cols}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });

    const finalPixels = await screenshotRegion(page, pane.xtermHost);
    expect(finalPixels.width).toBe(recoveredPixels.width);
    expect(finalPixels.height).toBe(recoveredPixels.height);
    await expectTerminalPixelsChanged(recoveredPixels, finalPixels, { minimumChangedRatio: 0.002 });
    await expectTerminalNonBlank(page, pane.xtermHost);

    const final = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(final.socketGeneration).toBe(reconnectGeneration);
    expect(final.socketState).toBe("connected");
    expect(final.activeSocketCount).toBe(1);
    expect(final.acceptingInput).toBe(true);
    expect(final.gridEpoch).toBe(resizedEpoch);
    expect(final.serverViewport?.cols).toBe(resizedViewport.cols);
    expect(final.serverViewport?.rows).toBe(resizedViewport.rows);
    expect(final.xterm.text.replace(/\s+/g, "")).toContain(baselineMarker.replace(/\s+/g, ""));
    expect(final.xterm.text.replace(/\s+/g, "")).toContain(echoMarker.replace(/\s+/g, ""));
    expect(final.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(final.flow.pendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
    expect(final.renderBacklogOldestAgeMs).toBe(0);
    assertNoPendingSynchronization(final);
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const finalReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(finalReport.violations).toEqual([]);
    expect(finalReport.events.filter((event) => event.type === "socket-stale")).toEqual([]);
    expect(finalReport.events.filter((event) => event.type === "error")).toEqual([]);
    await assertMonotonicSequences(finalReport.events);

    const finalTranscript = await server.readTranscript<TranscriptEntry>(terminalId);
    expect(finalTranscript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal" && entry.rows === resizedViewport.rows && entry.cols === resizedViewport.cols)).toHaveLength(1);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
    expect(initialErrors().filter((entry) => entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message))).toEqual([]);
    if (peerErrors) expect(peerErrors().filter((entry) => entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message))).toEqual([]);
  } finally {
    pauseFault?.();
    terminateFault?.();
    initialErrors.dispose();
    peerErrors?.dispose();
    if (peerContext) await peerContext.close();
  }
});
