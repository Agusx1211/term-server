import { Buffer } from "node:buffer";
import { Terminal } from "../fixtures/headless-terminal.js"
import type { Page } from "@playwright/test";
import { expect, test, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type {
  NetworkFaultController,
  NetworkFaultDisposer,
} from "../fixtures/network-faults.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalConverged,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

const WAIT_TIMEOUT_MS = 60_000;
const BURST_BYTES = 65_536;
const BURST_LINE_WIDTH = 100;

function transcriptNumber(entry: TranscriptEntry, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function transcriptString(entry: TranscriptEntry, key: string): string | undefined {
  const value = entry[key];
  return typeof value === "string" ? value : undefined;
}

function transcriptSequence(entry: TranscriptEntry): number {
  return transcriptNumber(entry, "sequence") ?? 0;
}

function entriesAfter(entries: readonly TranscriptEntry[], sequence: number): TranscriptEntry[] {
  return entries.filter((entry) => transcriptSequence(entry) > sequence);
}

function writeEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((entry) => entry.event === "write");
}

function writeBytes(entry: TranscriptEntry): Buffer {
  const encoded = transcriptString(entry, "data_base64");
  if (!encoded) throw new Error("fixture write omitted data_base64");
  return Buffer.from(encoded, "base64");
}

function marker(operation: string, ...fields: readonly string[]): Buffer {
  return Buffer.from(`[E2E:${operation}${fields.map((field) => `:${field}`).join("")}]\n`, "utf8");
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

function markerText(operation: string, ...fields: readonly string[]): string {
  return marker(operation, ...fields).toString("utf8").trimEnd();
}

function activeText(terminal: Terminal): string {
  const active = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < active.length; index += 1) {
    lines.push(active.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

async function writeModel(terminal: Terminal, bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve) => {
    terminal.write(new Uint8Array(bytes), resolve);
  });
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
}

function isUnsupportedLifecycleCommand(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unknown command|method not found|wasn't found|not implemented|does not support|unsupported)/i.test(message);
}

function waitForFutureFrame(
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let subscription: NetworkFaultDisposer | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      subscription?.dispose();
      if (error) reject(error);
      else resolve();
    };
    subscription = faultController.onEvent((event) => {
      if (event.type !== "frame") return;
      if (event.terminalId !== terminalId || event.generation !== generation) return;
      if (event.direction !== "browser-to-server") return;
      finish();
    });
    timer = setTimeout(() => finish(new Error(`timed out waiting for queued input frame for ${terminalId}`)), WAIT_TIMEOUT_MS);
  });
}

async function sendCommandThroughPausedSocket(
  pane: TerminalPanePage,
  faultController: NetworkFaultController,
  terminalId: string,
  generation: number,
  command: string,
): Promise<void> {
  const textFrame = waitForFutureFrame(faultController, terminalId, generation);
  await pane.insertText(command);
  await textFrame;
  const enterFrame = waitForFutureFrame(faultController, terminalId, generation);
  await pane.press("Enter");
  await enterFrame;
}

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  markerValue: string | undefined,
  minimumRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, marker: expectedMarker, minimumRender, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.socketReadyState === WebSocket.OPEN
      && snapshot.syncMode === undefined
      && snapshot.syncTarget === undefined
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
      && snapshot.renderCount > minimumRender
      && (expectedMarker === undefined || snapshot.xterm.text.includes(expectedMarker))
    ), { timeout });
  }, {
    id: terminalId,
    marker: markerValue,
    minimumRender: minimumRenderCount,
    timeout: WAIT_TIMEOUT_MS,
    acknowledgementLimit: TERMINAL_ACK_BYTES,
  });
}

test("R-05 Browser lifecycle freeze and resume @p1 @pr @nightly @lifecycle @freeze", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const browser = page.context().browser();
  const browserName = browser?.browserType().name();
  if (browserName !== "chromium") {
    test.skip(true, "R-05 requires Chromium Page.setWebLifecycleState support");
    return;
  }

  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch (error) {
    if (isUnsupportedLifecycleCommand(error)) {
      test.skip(true, "Chromium CDP session is unavailable for R-05");
      return;
    }
    throw error;
  }

  const runTag = `R05-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-READY`;
  const beforeId = `${runTag}-BEFORE`;
  const beforeText = `${runTag}-BEFORE-TEXT`;
  const holdToken = `${runTag}-HOLD`;
  const burstId = `${runTag}-BURST`;
  const frozenId = `${runTag}-FROZEN`;
  const frozenText = `${runTag}-FROZEN-TEXT`;
  const sizeId = `${runTag}-SIZE`;
  const winchId = `${runTag}-WINCH`;
  const echoId = `${runTag}-ECHO`;
  const inputText = `${runTag}-CONTINUED-INPUT`;
  const inputBase64 = Buffer.from(inputText, "utf8").toString("base64");

  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const existingTerminalIds = await page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminals().map((snapshot) => snapshot.terminalId);
  });
  const mountEvent = page.evaluate(async ({ existingIds, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && !existingIds.includes(event.terminalId),
      { timeout },
    );
  }, { existingIds: existingTerminalIds, timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });

  const initial = await waitForSettledTerminal(page, terminalId, undefined, -1);
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);
  const initialConverged = await expectTerminalConverged(page, terminalId, {
    cols: initial.cols,
    rows: initial.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(initialConverged.serverViewport).toBeDefined();
  expect(initialConverged.serverViewport?.cols).toBe(initialConverged.cols);
  expect(initialConverged.serverViewport?.rows).toBe(initialConverged.rows);
  expect(initialConverged.activeSocketCount).toBe(1);
  const initialTranscript = await server.readTranscript(terminalId);
  const transcriptFloor = Math.max(0, ...initialTranscript.map(transcriptSequence));

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const beforeMarker = markerText("PRINT", beforeId, beforeText);
  const beforeSettled = await waitForSettledTerminal(page, terminalId, beforeMarker, initial.renderCount);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "r05-before-freeze-terminal",
  });
  const beforePixels = await screenshotRegion(page, pane.xtermHost);

  const connectionOpen = await faultController.waitFor(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  if (connectionOpen.generation === undefined) throw new Error("initial terminal connection omitted proxy generation");
  const initialGeneration = connectionOpen.generation;
  expect(initial.socketGeneration).toBe(initialGeneration);

  await pane.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "hold" && entry.token === holdToken,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  let pausedInput: NetworkFaultDisposer | undefined = faultController.pause("browser-to-server", {
    terminalId,
    generation: initialGeneration,
  });
  await faultController.waitFor(
    (event) => event.type === "paused"
      && event.terminalId === terminalId
      && event.generation === initialGeneration
      && event.direction === "browser-to-server",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await sendCommandThroughPausedSocket(pane, faultController, terminalId, initialGeneration, `BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`);
  await sendCommandThroughPausedSocket(pane, faultController, terminalId, initialGeneration, `PRINT ${frozenId} ${frozenText}`);
  await sendCommandThroughPausedSocket(pane, faultController, terminalId, initialGeneration, `RELEASE ${holdToken}`);

  let pageFrozen = false;
  try {
    try {
      await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    } catch (error) {
      if (isUnsupportedLifecycleCommand(error)) {
        test.skip(true, "Page.setWebLifecycleState is unavailable in this Chromium");
        return;
      }
      throw error;
    }
    pageFrozen = true;

    const release = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "release" && entry.token === holdToken && transcriptSequence(entry) > transcriptFloor,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const burst = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES && transcriptSequence(entry) > transcriptFloor,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const burstWrite = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "write" && entry.bytes === BURST_BYTES && transcriptSequence(entry) > transcriptFloor,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const frozenPrint = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === frozenId && entry.text === frozenText && transcriptSequence(entry) > transcriptFloor,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const frozenPrintWrite = server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "write"
        && entry.data_base64 === marker("PRINT", frozenId, frozenText).toString("base64")
        && transcriptSequence(entry) > transcriptFloor,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );

    pausedInput.dispose();
    pausedInput = undefined;
    await faultController.waitFor(
      (event) => event.type === "resumed"
        && event.terminalId === terminalId
        && event.generation === initialGeneration
        && event.direction === "browser-to-server",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const [releaseEntry, burstEntry, burstWriteEntry, frozenPrintEntry, frozenPrintWriteEntry] = await Promise.all([
      release,
      burst,
      burstWrite,
      frozenPrint,
      frozenPrintWrite,
    ]);
    expect(releaseEntry.token).toBe(holdToken);
    expect(burstEntry.bytes).toBe(BURST_BYTES);
    expect(burstWriteEntry.bytes).toBe(BURST_BYTES);
    expect(frozenPrintEntry.text).toBe(frozenText);
    expect(writeBytes(frozenPrintWriteEntry)).toEqual(marker("PRINT", frozenId, frozenText));

    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    pageFrozen = false;
  } finally {
    pausedInput?.dispose();
    pausedInput = undefined;
    if (pageFrozen) {
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
      pageFrozen = false;
    }
  }

  const frozenMarker = markerText("PRINT", frozenId, frozenText);
  const recovered = await waitForSettledTerminal(page, terminalId, frozenMarker, beforeSettled.renderCount);
  expect(recovered.renderCount).toBeGreaterThan(beforeSettled.renderCount);
  expect(recovered.activeSocketCount).toBe(1);
  expect(recovered.socketGeneration).toBeLessThanOrEqual(initialGeneration + 1);
  const changed = await expectKnownMarkerChanged(page, pane.xtermHost, beforePixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "r05-frozen-output-pixels",
  });
  expect(changed.changedRatio).toBeGreaterThanOrEqual(0.002);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "r05-resumed-terminal",
  });

  await pane.sendInput(`SIZE ${sizeId}`, true);
  const sizeEntry = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId && transcriptSequence(entry) > transcriptFloor,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`WINCH ${winchId} 1`, true);
  const winchEntry = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sigwinch" && entry.id === winchId && entry.signal_sequence === 1 && transcriptSequence(entry) > transcriptFloor,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed" && transcriptSequence(entry) > transcriptFloor,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(inputText, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === inputBase64
      && transcriptSequence(entry) > transcriptFloor,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const echoMarker = markerText("ECHO_INPUT", echoId, inputBase64);
  const final = await waitForSettledTerminal(page, terminalId, echoMarker, recovered.renderCount);
  expect(final.socketState).toBe("connected");
  expect(final.socketReadyState).toBe(1);
  expect(final.activeSocketCount).toBe(1);
  expect(final.acceptingInput).toBe(true);
  expect(final.lifecycle.mounted).toBe(true);
  expect(final.lifecycle.visible).toBe(true);
  expect(final.lifecycle.cached).toBe(false);
  expect(final.lifecycle.active).toBe(true);
  expect(final.lifecycle.focused).toBe(true);
  expect(final.syncMode).toBeUndefined();
  expect(final.syncTarget).toBeUndefined();
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  expect(final.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(final.receivedSequence).toBe(final.committedSequence);
  expect(final.gridEpoch).toBeDefined();

  const serverViewport = final.serverViewport;
  if (!serverViewport) throw new Error("resumed terminal omitted server-selected viewport");
  expect(serverViewport.cols).toBe(final.cols);
  expect(serverViewport.rows).toBe(final.rows);
  expect(transcriptNumber(sizeEntry, "cols")).toBe(final.cols);
  expect(transcriptNumber(sizeEntry, "rows")).toBe(final.rows);
  expect(transcriptNumber(winchEntry, "cols")).toBe(final.cols);
  expect(transcriptNumber(winchEntry, "rows")).toBe(final.rows);

  const finalTranscript = await server.readTranscript(terminalId);
  const scenarioEntries = entriesAfter(finalTranscript, transcriptFloor);
  const writes = writeEntries(scenarioEntries);
  const expectedWrites = [
    marker("READY", readyId),
    marker("PRINT", beforeId, beforeText),
    marker("HOLD", holdToken),
    marker("RELEASE", holdToken),
    burstBytes(BURST_BYTES, BURST_LINE_WIDTH),
    marker("PRINT", frozenId, frozenText),
    marker("SIZE", sizeId, String(final.rows), String(final.cols)),
    marker("WINCH", winchId, "1", String(final.rows), String(final.cols)),
    marker("ECHO_INPUT", echoId, "READY"),
    marker("ECHO_INPUT", echoId, inputBase64),
  ];
  expect(writes.map(writeBytes)).toEqual(expectedWrites);
  expect(scenarioEntries.filter((entry) => entry.event === "error")).toEqual([]);
  expect(scenarioEntries.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(scenarioEntries.filter((entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText)).toHaveLength(1);
  expect(scenarioEntries.filter((entry) => entry.event === "hold" && entry.token === holdToken)).toHaveLength(1);
  expect(scenarioEntries.filter((entry) => entry.event === "release" && entry.token === holdToken)).toHaveLength(1);
  expect(scenarioEntries.filter((entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES)).toHaveLength(1);
  expect(scenarioEntries.filter((entry) => entry.event === "print" && entry.id === frozenId && entry.text === frozenText)).toHaveLength(1);
  expect(scenarioEntries.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload" && entry.payload_base64 === inputBase64)).toHaveLength(1);

  const model = new Terminal({
    cols: initial.cols,
    rows: initial.rows,
    scrollback: 200_000,
    ...tuiCompatibilityOptions(),
  });
  for (const write of writes) await writeModel(model, writeBytes(write));
  expect(final.xterm.text).toBe(activeText(model));
  expect(final.xterm.activeBuffer).toBe(model.buffer.active.type);
  expect(final.xterm.cursorX).toBe(model.buffer.active.cursorX);
  expect(final.xterm.cursorY).toBe(model.buffer.active.cursorY);
  expect(countOccurrences(final.xterm.text, beforeMarker)).toBe(1);
  expect(countOccurrences(final.xterm.text, frozenMarker)).toBe(1);
  expect(countOccurrences(final.xterm.text, echoMarker)).toBe(1);

  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalConverged(page, terminalId, { cols: final.cols, rows: final.rows }, { timeout: WAIT_TIMEOUT_MS });
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  const socketCreatedEvents = events.filter((event) => event.type === "socket-created");
  expect(socketCreatedEvents.length).toBeGreaterThanOrEqual(1);
  expect(socketCreatedEvents.length).toBeLessThanOrEqual(2);
  const maxGeneration = Math.max(initialGeneration, ...events.map((event) => event.snapshot.socketGeneration));
  expect(maxGeneration).toBeLessThanOrEqual(initialGeneration + 1);
  for (const event of events) expect(event.snapshot.activeSocketCount).toBeLessThanOrEqual(1);

  await pane.expectConnected();
  await workbench.expectConnectedStatus();
  const browserFailures = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
  expect(browserFailures).toEqual([]);
  expect(faultController.events.filter((event) => (
    event.type === "socket-error" || event.type === "malformed-frame"
  ))).toEqual([]);
  expect(server.pid).toBeDefined();
  expect(server.process?.exitCode ?? null).toBeNull();
  expect(server.stderr).not.toMatch(/\b(?:panic|fatal|unhandled)\b/i);
  browserErrors.dispose();
});
