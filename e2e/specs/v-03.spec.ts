import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConnected,
  terminalEvents,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { Page } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
const WAIT_TIMEOUT_MS = 30_000;
const UPGRADE_HOLD_MS = 1_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

function commandBytes(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function viewportKey(viewport: E2EViewport): string {
  return `${viewport.cols}x${viewport.rows}@${viewport.pixelWidth}x${viewport.pixelHeight}`;
}

function expectViewportEqual(
  actual: E2EViewport | undefined,
  expected: E2EViewport,
  label: string,
): void {
  expect(actual, `${label} is missing`).toBeDefined();
  if (!actual) return;
  expect(actual.cols, `${label} cols`).toBe(expected.cols);
  expect(actual.rows, `${label} rows`).toBe(expected.rows);
  expect(actual.pixelWidth, `${label} pixel width`).toBe(expected.pixelWidth);
  expect(actual.pixelHeight, `${label} pixel height`).toBe(expected.pixelHeight);
}

async function waitForStableViewport(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewports = [
        snapshot.proposedViewport,
        snapshot.desiredViewport,
        snapshot.urlViewport,
        snapshot.sentViewport,
        snapshot.serverViewport,
      ];
      if (viewports.some((viewport) => (
        !viewport
        || viewport.cols <= 0
        || viewport.rows <= 0
        || viewport.pixelWidth <= 0
        || viewport.pixelHeight <= 0
      ))) return false;
      const first = viewports[0]!;
      return viewports.every((viewport) => (
        viewport!.cols === first.cols
        && viewport!.rows === first.rows
        && viewport!.pixelWidth === first.pixelWidth
        && viewport!.pixelHeight === first.pixelHeight
      ));
    }, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEventType,
  generation?: number,
  socketGeneration?: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, type: eventType, generation, socketGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === eventType
        && (generation === undefined || event.data.generation === generation)
        && (socketGeneration === undefined || event.snapshot.socketGeneration === socketGeneration),
      { timeout },
    );
  }, {
    id: terminalId,
    after: afterEventId,
    type,
    generation,
    socketGeneration,
    timeout: WAIT_TIMEOUT_MS,
  });
}

function browserToServerResizeFrames(events: readonly NetworkFaultEvent[], terminalId: string): readonly NetworkFaultEvent[] {
  return events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "resize"
  ));
}

test("V-03 Reconnect at unchanged geometry @nightly @p1 @resize @reconnect", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const markerPrefix = `V03-w${testInfo.workerIndex}-r${testInfo.retry}`;
  const readyId = `${markerPrefix}-READY`;
  const baselineId = `${markerPrefix}-BASELINE`;
  const baselineText = `${markerPrefix}-BASELINE-TEXT`;
  const sizeId = `${markerPrefix}-SIZE`;
  const inputId = `${markerPrefix}-INPUT`;
  const inputText = `${markerPrefix}-CONTINUED-INPUT`;
  const inputBase64 = Buffer.from(inputText, "utf8").toString("base64");
  const finalId = `${markerPrefix}-FINAL`;
  const finalText = `${markerPrefix}-FINAL-AFTER-RECONNECT`;

  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const region = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(region).toBeVisible();
  const terminalId = await region.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal did not expose a stable terminal ID");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  await pane.focus();

  const readyCommand = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === "READY"
      && entry.command_base64 === commandBytes(`READY ${readyId}`),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const readyEntry = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`READY ${readyId}`, true);
  await readyCommand;
  await readyEntry;
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("READY", readyId),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const beforeBaseline = await screenshotRegion(page, pane.xtermHost);
  const baselineCommand = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === "PRINT"
      && entry.command_base64 === commandBytes(`PRINT ${baselineId} ${baselineText}`),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const baselinePrint = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === baselineId && entry.text === baselineText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`PRINT ${baselineId} ${baselineText}`, true);
  await baselineCommand;
  await baselinePrint;
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("PRINT", baselineId, baselineText),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const afterBaseline = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeBaseline, afterBaseline, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "v-03-baseline-marker",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "v-03-baseline-terminal",
  });

  const initial = await waitForStableViewport(page, terminalId);
  const geometryA = initial.serverViewport;
  if (!geometryA) throw new Error("initial synchronized terminal did not expose a server viewport");
  expectViewportEqual(initial.proposedViewport, geometryA, "initial proposed viewport");
  expectViewportEqual(initial.desiredViewport, geometryA, "initial desired viewport");
  expectViewportEqual(initial.urlViewport, geometryA, "initial URL viewport");
  expectViewportEqual(initial.sentViewport, geometryA, "initial sent viewport");
  expectViewportEqual(initial.serverViewport, geometryA, "initial server viewport");
  expect(initial.socketState).toBe("connected");
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.acceptingInput).toBe(true);
  const initialScreen = await pane.xtermHost.locator(".xterm-screen").boundingBox();
  if (!initialScreen) throw new Error("initial terminal screen has no compositor bounds");

  const initialSignal = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sigwinch" && entry.source === "signal",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(initialSignal.cols).toBe(geometryA.cols);
  expect(initialSignal.rows).toBe(geometryA.rows);

  const sizeCommand = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === "SIZE"
      && entry.command_base64 === commandBytes(`SIZE ${sizeId}`),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const sizeEntryPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size"
      && entry.id === sizeId
      && entry.source === "ioctl",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`SIZE ${sizeId}`, true);
  await sizeCommand;
  const sizeEntry = await sizeEntryPromise;
  expect(sizeEntry.cols).toBe(geometryA.cols);
  expect(sizeEntry.rows).toBe(geometryA.rows);
  expect(sizeEntry.pixel_width).toBe(geometryA.pixelWidth);
  expect(sizeEntry.pixel_height).toBe(geometryA.pixelHeight);
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("SIZE", sizeId, String(geometryA.rows), String(geometryA.cols)),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const baselineTranscript = await server.readTranscript(terminalId);
  const baselineSizeEntries = baselineTranscript.filter((entry) => entry.event === "size" && entry.id === sizeId);
  const baselineWinches = baselineTranscript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal");
  expect(baselineSizeEntries).toHaveLength(1);
  expect(baselineWinches.length).toBeGreaterThan(0);

  const baselineEvents = await pane.events();
  const baselineEventId = baselineEvents.at(-1)?.id ?? 0;
  const baselineNetworkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
  const initialConnections = baselineNetworkEvents.filter((event) => event.type === "connection-open");
  expect(initialConnections).toHaveLength(1);
  const initialConnection = initialConnections[0];
  if (!initialConnection || initialConnection.generation === undefined) {
    throw new Error("initial proxy connection did not expose a generation");
  }
  const initialGeneration = initialConnection.generation;
  const nextGeneration = initialGeneration + 1;
  expect(initial.socketGeneration).toBe(initialGeneration);
  const baselineResizeCount = browserToServerResizeFrames(baselineNetworkEvents, terminalId).length;
  const baselineRenderer = {
    kind: initial.renderer,
    webglLoadCount: initial.webglLoadCount,
    contextLossCount: initial.contextLossCount,
    fallbackCount: initial.fallbackCount,
  };
  const delayUpgrade = faultController.delayUpgrade({
    terminalId,
    generation: nextGeneration,
  }, UPGRADE_HOLD_MS);
  const proxyTerminatedPromise = faultController.waitFor((event) => (
    event.type === "connection-terminated"
    && event.terminalId === terminalId
    && event.generation === initialGeneration
    && event.abrupt === true
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const proxyUpgradeDelayedPromise = faultController.waitFor((event) => (
    event.type === "upgrade-delay"
    && event.terminalId === terminalId
    && event.generation === nextGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const proxyOpenedPromise = faultController.waitFor((event) => (
    event.type === "connection-open"
    && event.terminalId === terminalId
    && event.generation === nextGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const socketClosedPromise = waitForDiagnosticEventAfter(
    page,
    terminalId,
    baselineEventId,
    "socket-close",
    initialGeneration,
  );
  const socketCreatedPromise = waitForDiagnosticEventAfter(
    page,
    terminalId,
    baselineEventId,
    "socket-created",
    nextGeneration,
  );
  const socketOpenedPromise = waitForDiagnosticEventAfter(
    page,
    terminalId,
    baselineEventId,
    "socket-open",
    nextGeneration,
  );
  const serverSizePromise = waitForDiagnosticEventAfter(
    page,
    terminalId,
    baselineEventId,
    "size",
    undefined,
    nextGeneration,
  );
  const synchronizedPromise = waitForDiagnosticEventAfter(
    page,
    terminalId,
    baselineEventId,
    "synced",
    undefined,
    nextGeneration,
  );

  const terminate = faultController.terminate({ terminalId, generation: initialGeneration });
  const [proxyTerminated, socketClosed, socketCreated] = await Promise.all([
    proxyTerminatedPromise,
    socketClosedPromise,
    socketCreatedPromise,
  ]);
  expect(proxyTerminated.abrupt).toBe(true);
  expect(socketClosed.data.generation).toBe(initialGeneration);
  expect(socketCreated.data.generation).toBe(nextGeneration);
  expect(socketCreated.snapshot.socketGeneration).toBe(nextGeneration);
  expect(socketCreated.snapshot.socketState).toBe("connecting");
  expect(socketCreated.snapshot.activeSocketCount).toBe(1);
  expectViewportEqual(socketCreated.snapshot.urlViewport, geometryA, "reconnect URL viewport");
  expectViewportEqual(socketCreated.snapshot.sentViewport, geometryA, "reconnect sent viewport");
  expect(viewportKey(socketCreated.snapshot.urlViewport!)).toBe(viewportKey(geometryA));

  await proxyUpgradeDelayedPromise;
  delayUpgrade.dispose();
  terminate.dispose();
  const [proxyOpened, socketOpened, serverSize] = await Promise.all([
    proxyOpenedPromise,
    socketOpenedPromise,
    serverSizePromise,
  ]);
  expect(proxyOpened.generation).toBe(nextGeneration);
  expect(socketOpened.data.generation).toBe(nextGeneration);
  expect(serverSize.data.cols).toBe(geometryA.cols);
  expect(serverSize.data.rows).toBe(geometryA.rows);
  await synchronizedPromise;

  await waitForTerminalState(page, terminalId, {
    socketGeneration: nextGeneration,
    socketState: "connected",
    activeSocketCount: 1,
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  const recoveredStable = await waitForStableViewport(page, terminalId);
  expect(recoveredStable.socketGeneration).toBe(nextGeneration);
  expect(recoveredStable.socketState).toBe("connected");
  expect(recoveredStable.activeSocketCount).toBe(1);
  expectViewportEqual(recoveredStable.proposedViewport, geometryA, "recovered proposed viewport");
  expectViewportEqual(recoveredStable.desiredViewport, geometryA, "recovered desired viewport");
  expectViewportEqual(recoveredStable.urlViewport, geometryA, "recovered URL viewport");
  expectViewportEqual(recoveredStable.sentViewport, geometryA, "recovered sent viewport");
  expectViewportEqual(recoveredStable.serverViewport, geometryA, "recovered server viewport");
  expect(recoveredStable.cols).toBe(geometryA.cols);
  expect(recoveredStable.rows).toBe(geometryA.rows);
  expect(recoveredStable.pixelWidth).toBe(geometryA.pixelWidth);
  expect(recoveredStable.pixelHeight).toBe(geometryA.pixelHeight);
  expect(recoveredStable.syncMode).toBeUndefined();
  expect(recoveredStable.syncTarget).toBeUndefined();
  expect(recoveredStable.pendingParserWrites).toBe(0);
  expect(recoveredStable.pendingParserBytes).toBe(0);
  expect(recoveredStable.renderBacklogBytes).toBe(0);
  expect(recoveredStable.renderBacklogFrames).toBe(0);
  expect(recoveredStable.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(recoveredStable.acceptingInput).toBe(true);
  expect(recoveredStable.renderer).toBe(baselineRenderer.kind);
  expect(recoveredStable.webglLoadCount).toBe(baselineRenderer.webglLoadCount);
  expect(recoveredStable.contextLossCount).toBe(baselineRenderer.contextLossCount);
  expect(recoveredStable.fallbackCount).toBe(baselineRenderer.fallbackCount);

  const recoveredSocketUrl = recoveredStable.socketUrl;
  if (!recoveredSocketUrl) throw new Error("recovered socket did not expose its URL");
  const recoveredUrl = new URL(recoveredSocketUrl);
  expect(recoveredUrl.searchParams.get("cols")).toBe(String(geometryA.cols));
  expect(recoveredUrl.searchParams.get("rows")).toBe(String(geometryA.rows));
  expect(recoveredUrl.searchParams.get("pixelWidth")).toBe(String(geometryA.pixelWidth));
  expect(recoveredUrl.searchParams.get("pixelHeight")).toBe(String(geometryA.pixelHeight));

  const recoveredScreen = await pane.xtermHost.locator(".xterm-screen").boundingBox();
  if (!recoveredScreen) throw new Error("recovered terminal screen has no compositor bounds");
  expect(Math.abs(recoveredScreen.width - initialScreen.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(recoveredScreen.height - initialScreen.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(recoveredStable.pixelWidth - Math.round(recoveredScreen.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(recoveredStable.pixelHeight - Math.round(recoveredScreen.height))).toBeLessThanOrEqual(1);
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  const canvasSize = await pane.canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
  expect(canvasSize.width).toBeGreaterThan(0);
  expect(canvasSize.height).toBeGreaterThan(0);
  expect(Math.abs(canvasSize.width - Math.round(recoveredScreen.width * devicePixelRatio))).toBeLessThanOrEqual(2);
  expect(Math.abs(canvasSize.height - Math.round(recoveredScreen.height * devicePixelRatio))).toBeLessThanOrEqual(2);

  expect(recoveredStable.xterm.text).toContain(marker("READY", readyId));
  expect(recoveredStable.xterm.text).toContain(marker("PRINT", baselineId, baselineText));
  expect(recoveredStable.xterm.text).toContain(marker("SIZE", sizeId, String(geometryA.rows), String(geometryA.cols)));
  expect(recoveredStable.xterm.text.match(new RegExp(`\\[E2E:PRINT:${baselineId}:${baselineText}\\]`, "g"))).toHaveLength(1);

  const inputArmed = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`ECHO_INPUT ${inputId}`, true);
  await inputArmed;
  const inputPayload = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === inputId
      && entry.phase === "payload"
      && entry.payload_base64 === inputBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(inputText, true);
  const echoedInput = await inputPayload;
  expect(echoedInput.bytes).toBe(inputText.length);
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", inputId, inputBase64),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const beforeFinal = await screenshotRegion(page, pane.xtermHost);
  const finalCommand = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === "PRINT"
      && entry.command_base64 === commandBytes(`PRINT ${finalId} ${finalText}`),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const finalPrint = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
  await finalCommand;
  await finalPrint;
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("PRINT", finalId, finalText),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const afterFinal = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeFinal, afterFinal, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "v-03-reconnect-marker",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "v-03-reconnect-terminal",
  });

  const beforeStaleEvent = await pane.events();
  const staleEventPromise = waitForDiagnosticEventAfter(
    page,
    terminalId,
    beforeStaleEvent.at(-1)?.id ?? 0,
    "socket-stale",
    initialGeneration,
    nextGeneration,
  );
  await page.evaluate(({ id, generation }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.deliverStaleEvent(id, { generation, type: "close" });
  }, { id: terminalId, generation: initialGeneration });
  const staleEvent = await staleEventPromise;
  expect(staleEvent.data.generation).toBe(initialGeneration);
  const afterStale = await waitForTerminalState(page, terminalId, {
    socketGeneration: nextGeneration,
    socketState: "connected",
    activeSocketCount: 1,
    acceptingInput: true,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(afterStale.socketUrl).toBe(recoveredStable.socketUrl);
  expect(afterStale.serverViewport?.cols).toBe(geometryA.cols);
  expect(afterStale.serverViewport?.rows).toBe(geometryA.rows);
  expect(afterStale.xterm.text).toContain(marker("PRINT", finalId, finalText));

  await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(2);
  expect(finalEvents.filter((event) => event.type === "socket-open")).toHaveLength(2);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "sync")).toHaveLength(2);
  expect(finalEvents.filter((event) => event.type === "synced")).toHaveLength(2);

  const finalNetworkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
  expect(finalNetworkEvents.filter((event) => event.type === "connection-open")).toHaveLength(2);
  expect(finalNetworkEvents.filter((event) => event.type === "connection-terminated")).toHaveLength(1);
  expect(browserToServerResizeFrames(finalNetworkEvents, terminalId)).toHaveLength(baselineResizeCount);
  expect(finalNetworkEvents.filter((event) => event.type === "socket-error")).toHaveLength(0);
  expect(finalNetworkEvents.filter((event) => event.type === "malformed-frame")).toHaveLength(0);
  expect(finalNetworkEvents.some((event) => (
    event.type === "frame"
    && event.direction === "browser-to-server"
    && event.generation === nextGeneration
    && event.frame?.opcode === 2
  ))).toBe(true);

  const finalTranscript = await server.readTranscript(terminalId);
  expect(finalTranscript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal")).toHaveLength(baselineWinches.length);
  expect(finalTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(finalTranscript.filter((entry) => entry.event === "exit")).toHaveLength(0);
  expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === baselineId)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === finalId)).toHaveLength(1);
  expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload")).toHaveLength(1);

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
});
