import { Buffer } from "node:buffer";
import { Terminal as HeadlessTerminal } from "../fixtures/headless-terminal.js"
import { type Page, type TestInfo } from "@playwright/test";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalInteractive,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import type { NetworkFaultController } from "../fixtures/network-faults.js";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { tuiCompatibilityOptions } from "../../src/client/lib/terminal-compatibility.js";

const WAIT_TIMEOUT_MS = 30_000;
const GEOMETRY_A = { cols: 80, rows: 24 } as const;
const BROWSER_GEOMETRY_A = { width: 850, height: 421 } as const;
const SCROLLBACK_LINES = 200_000;

const CLOSE_POINTS = ["before-enter", "in-alternate", "after-exit"] as const;
type ClosePoint = (typeof CLOSE_POINTS)[number];

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type ReadableBuffer = {
  readonly type: "normal" | "alternate";
  readonly cursorX: number;
  readonly cursorY: number;
  readonly viewportY: number;
  readonly length: number;
  getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
};

type DebugRecordingEvent = {
  readonly terminal: string;
  readonly type: string;
  readonly sequence?: number;
  readonly data?: string;
};

type DebugRecordingExport = {
  readonly events: readonly DebugRecordingEvent[];
};

type ScenarioArgs = {
  readonly page: Page;
  readonly server: IsolatedServer;
  readonly faultController: NetworkFaultController;
  readonly closePoint: ClosePoint;
  readonly testInfo: TestInfo;
};

type ScenarioResult = {
  readonly terminalId: string;
  readonly outputBytes: Buffer;
};

function marker(operation: string, id: string, ...fields: string[]): string {
  return `[E2E:${operation}:${[id, ...fields].join(":")}]`;
}

function countOccurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
}

function commandBytes(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function outputBytes(entries: readonly TranscriptEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.event !== "write") continue;
    if (typeof entry.data_base64 !== "string") {
      throw new Error("fixture write transcript entry is missing data_base64");
    }
    chunks.push(Buffer.from(entry.data_base64, "base64"));
  }
  return Buffer.concat(chunks);
}

function bufferText(buffer: ReadableBuffer): string {
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function writeHeadless(terminal: { write(data: string, callback: () => void): void }, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    terminal.write(data, resolve);
  });
}

async function modelFromTranscript(
  snapshot: E2ETerminalSnapshot,
  entries: readonly TranscriptEntry[],
): Promise<HeadlessTerminal> {
  const terminal = new HeadlessTerminal({
    allowProposedApi: true,
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: SCROLLBACK_LINES,
    ...tuiCompatibilityOptions(),
  });
  for (const entry of entries) {
    if (entry.event !== "write") continue;
    if (typeof entry.data_base64 !== "string") {
      terminal.dispose();
      throw new Error("fixture write transcript entry is missing data_base64");
    }
    await writeHeadless(terminal, Buffer.from(entry.data_base64, "base64").toString("utf8"));
  }
  return terminal;
}

async function assertModelParity(
  snapshot: E2ETerminalSnapshot,
  entries: readonly TranscriptEntry[],
  phase: string,
  markers: {
    readonly normal: string;
    readonly alt: string;
    readonly enter: string;
    readonly exit: string;
    readonly altReady: boolean;
    readonly exited: boolean;
  },
): Promise<void> {
  const model = await modelFromTranscript(snapshot, entries);
  try {
    const active = model.buffer.active as unknown as ReadableBuffer;
    const normal = model.buffer.normal as unknown as ReadableBuffer;
    const alternate = model.buffer.alternate as unknown as ReadableBuffer;
    const activeText = bufferText(active);
    const normalText = bufferText(normal);
    const alternateText = bufferText(alternate);

    expect(active.type, `${phase}: independent model buffer`).toBe(snapshot.activeBuffer);
    expect(active.cursorX, `${phase}: independent model cursor x`).toBe(snapshot.xterm.cursorX);
    expect(active.cursorY, `${phase}: independent model cursor y`).toBe(snapshot.xterm.cursorY);
    expect(active.viewportY, `${phase}: independent model viewport`).toBe(snapshot.xterm.viewportY);
    expect(activeText, `${phase}: independent model active text`).toBe(snapshot.xterm.text);
    expect(normalText, `${phase}: normal buffer retained`).toContain(markers.normal);
    expect(countOccurrences(normalText, markers.normal), `${phase}: normal marker count`).toBe(1);

    if (markers.altReady) {
      expect(alternateText, `${phase}: alternate marker retained`).toContain(markers.alt);
      expect(countOccurrences(alternateText, markers.alt), `${phase}: alternate marker count`).toBe(1);
      expect(alternateText, `${phase}: alternate entry marker retained`).toContain(markers.enter);
    } else {
      expect(alternateText, `${phase}: alternate buffer must not be populated`).not.toContain(markers.alt);
    }

    if (markers.exited) {
      expect(normalText, `${phase}: alternate exit marker restored to normal`).toContain(markers.exit);
      expect(countOccurrences(normalText, markers.exit), `${phase}: alternate exit marker count`).toBe(1);
    }

    if (snapshot.activeBuffer === "normal") {
      expect(activeText, `${phase}: stale alternate marker resurrected`).not.toContain(markers.alt);
      expect(activeText, `${phase}: stale alternate-entry marker resurrected`).not.toContain(markers.enter);
    } else {
      expect(activeText, `${phase}: normal history leaked into alternate`).not.toContain(markers.normal);
    }
  } finally {
    model.dispose();
  }
}

async function waitForSettled(
  page: Page,
  terminalId: string,
  minimumGeneration = 0,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimumGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration >= minimumGeneration
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
    ), { timeout });
  }, { id: terminalId, minimumGeneration, timeout: WAIT_TIMEOUT_MS });
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEvent["type"],
  options: { readonly exactGeneration?: number; readonly minimumGeneration?: number } = {},
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, afterEventId, type, exactGeneration, minimumGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.id <= afterEventId || event.type !== type) return false;
      const eventGeneration = typeof event.data.generation === "number"
        ? event.data.generation
        : event.snapshot.socketGeneration;
      if (exactGeneration !== undefined && eventGeneration !== exactGeneration) return false;
      if (minimumGeneration !== undefined && eventGeneration < minimumGeneration) return false;
      return true;
    }, { timeout });
  }, {
    id: terminalId,
    afterEventId,
    type,
    ...options,
    timeout: WAIT_TIMEOUT_MS,
  });
}


async function terminateAndRecover(
  page: Page,
  terminalId: string,
  snapshot: E2ETerminalSnapshot,
  faultController: NetworkFaultController,
): Promise<{ readonly snapshot: E2ETerminalSnapshot; readonly sync: E2ETerminalEvent }> {
  const previousGeneration = snapshot.socketGeneration;
  const beforeEvents = await terminalEvents(page, terminalId);
  const afterEventId = beforeEvents.at(-1)?.id ?? 0;
  const socketClose = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "socket-close", {
    exactGeneration: previousGeneration,
  });
  const sync = waitForDiagnosticEventAfter(page, terminalId, afterEventId, "synced", {
    minimumGeneration: previousGeneration + 1,
  });
  const proxyClose = faultController.waitFor((event) => (
    event.type === "connection-terminated"
    && event.terminalId === terminalId
    && event.generation === previousGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const proxyOpen = faultController.waitFor((event) => (
    event.type === "connection-open"
    && event.terminalId === terminalId
    && event.generation !== undefined
    && event.generation > previousGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const fault = faultController.terminate({ terminalId, generation: previousGeneration });
  try {
    await Promise.all([socketClose, proxyClose, proxyOpen]);
    const synced = await sync;
    const recovered = await waitForSettled(page, terminalId, previousGeneration + 1);
    expect(recovered.socketGeneration).toBeGreaterThan(previousGeneration);
    expect(recovered.syncMode).toBeUndefined();
    expect(recovered.gridEpoch).toEqual(expect.any(Number));
    expect(synced.snapshot.socketGeneration).toBe(recovered.socketGeneration);
    return { snapshot: recovered, sync: synced };
  } finally {
    fault.dispose();
  }
}

async function sendReady(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
): Promise<void> {
  const command = `READY ${id}`;
  const entry = server.waitForTranscript(terminalId, (candidate) => (
    candidate.event === "ready" && candidate.id === id
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(command, true);
  await entry;
  await expectTerminalBuffer(pane.page, terminalId, {
    contains: marker("READY", id),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
}

async function sendPrint(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
  text: string,
): Promise<void> {
  const command = `PRINT ${id} ${text}`;
  const print = server.waitForTranscript(terminalId, (candidate) => (
    candidate.event === "print" && candidate.id === id && candidate.text === text
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(command, true);
  await print;
  await expectTerminalBuffer(pane.page, terminalId, {
    contains: marker("PRINT", id, text),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
}

async function sendAlternateEnter(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
): Promise<void> {
  const entry = server.waitForTranscript(terminalId, (candidate) => (
    candidate.event === "alt_enter" && candidate.id === id
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`ALT_ENTER ${id}`, true);
  await entry;
  await waitForSettled(pane.page, terminalId);
  await expectTerminalBuffer(pane.page, terminalId, {
    contains: marker("ALT_ENTER", id),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const snapshot = await pane.snapshot();
  if (!snapshot) throw new Error("alternate-enter diagnostics snapshot disappeared");
  expect(snapshot.activeBuffer).toBe("alternate");
}

async function sendAlternateExit(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
): Promise<void> {
  const entry = server.waitForTranscript(terminalId, (candidate) => (
    candidate.event === "alt_exit" && candidate.id === id
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`ALT_EXIT ${id}`, true);
  await entry;
  await waitForSettled(pane.page, terminalId);
  await expectTerminalBuffer(pane.page, terminalId, {
    contains: marker("ALT_EXIT", id),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const snapshot = await pane.snapshot();
  if (!snapshot) throw new Error("alternate-exit diagnostics snapshot disappeared");
  expect(snapshot.activeBuffer).toBe("normal");
}

async function assertPhase(
  page: Page,
  terminalId: string,
  snapshot: E2ETerminalSnapshot,
  entries: readonly TranscriptEntry[],
  phase: string,
  markers: {
    readonly normal: string;
    readonly alt: string;
    readonly enter: string;
    readonly exit: string;
    readonly altReady: boolean;
    readonly exited: boolean;
  },
): Promise<void> {
  await assertModelParity(snapshot, entries, phase, markers);
  expect(snapshot.activeBuffer, `${phase}: browser active buffer`).toBe(snapshot.xterm.activeBuffer);
  expect(snapshot.xterm.text, `${phase}: browser model marker`).toContain(
    snapshot.activeBuffer === "alternate" ? markers.alt : markers.normal,
  );
  if (snapshot.activeBuffer === "normal") {
    expect(snapshot.xterm.text, `${phase}: stale alternate footer`).not.toContain(markers.alt);
    expect(snapshot.xterm.text, `${phase}: stale alternate entry`).not.toContain(markers.enter);
  } else {
    expect(snapshot.xterm.text, `${phase}: normal scrollback resurrected in alternate`).not.toContain(markers.normal);
  }
  if (markers.exited) expect(snapshot.xterm.text).toContain(markers.exit);
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
}

async function runScenario({ page, server, faultController, closePoint, testInfo }: ScenarioArgs): Promise<ScenarioResult> {
  const runTag = `O08-${closePoint}-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-e${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-READY`;
  const normalBeforeId = `${runTag}-NORMAL-BEFORE`;
  const enterId = `${runTag}-ENTER`;
  const altId = `${runTag}-ALT`;
  const exitId = `${runTag}-EXIT`;
  const normalAfterId = `${runTag}-NORMAL-AFTER`;
  const echoId = `${runTag}-ECHO`;
  const inputText = `${runTag}-CONTINUED-INPUT`;
  const sizeId = `${runTag}-SIZE`;
  const normalBeforeText = `${runTag}-NORMAL-BEFORE`;
  const altText = `${runTag}-ALT-MARKER`;
  const normalAfterText = `${runTag}-NORMAL-AFTER`;
  const normalMarker = marker("PRINT", normalBeforeId, normalBeforeText);
  const altMarker = marker("PRINT", altId, altText);
  const enterMarker = marker("ALT_ENTER", enterId);
  const exitMarker = marker("ALT_EXIT", exitId);

  const workbench = new WorkbenchPage(page);
  const mount = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount" && event.snapshot.kind === "pane", { timeout });
  }, WAIT_TIMEOUT_MS);
  await workbench.createTerminal();
  const mounted = await mount;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const initial = await waitForSettled(page, terminalId);
  expect(initial.cols).toBe(GEOMETRY_A.cols);
  expect(initial.rows).toBe(GEOMETRY_A.rows);
  expect(initial.serverViewport?.cols).toBe(GEOMETRY_A.cols);
  expect(initial.serverViewport?.rows).toBe(GEOMETRY_A.rows);
  expect(initial.activeBuffer).toBe("normal");

  await sendReady(pane, server, terminalId, readyId);
  const beforeNormalPixels = await screenshotRegion(page, pane.xtermHost);
  await sendPrint(pane, server, terminalId, normalBeforeId, normalBeforeText);
  await expectKnownMarkerChanged(page, pane.xtermHost, beforeNormalPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `${runTag}-normal-marker`,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: `${runTag}-normal-before-terminal`,
  });

  const initialCheckpoint = await waitForSettled(page, terminalId);
  const initialTranscript = await server.readTranscript(terminalId);
  await assertPhase(page, terminalId, initialCheckpoint, initialTranscript, "normal-before-enter", {
    normal: normalMarker,
    alt: altMarker,
    enter: enterMarker,
    exit: exitMarker,
    altReady: false,
    exited: false,
  });

  let checkpoint = initialCheckpoint;
  let checkpointEntries = initialTranscript;
  let phaseAltReady = false;
  let phaseExited = false;

  if (closePoint !== "before-enter") {
    await sendAlternateEnter(pane, server, terminalId, enterId);
    const beforeAltPixels = await screenshotRegion(page, pane.xtermHost);
    await sendPrint(pane, server, terminalId, altId, altText);
    await expectKnownMarkerChanged(page, pane.xtermHost, beforeAltPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: `${runTag}-alternate-marker`,
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: `${runTag}-alternate-terminal`,
    });
    phaseAltReady = true;
    checkpoint = await waitForSettled(page, terminalId);
    checkpointEntries = await server.readTranscript(terminalId);
    await assertPhase(page, terminalId, checkpoint, checkpointEntries, "alternate-before-reconnect", {
      normal: normalMarker,
      alt: altMarker,
      enter: enterMarker,
      exit: exitMarker,
      altReady: true,
      exited: false,
    });
  }

  if (closePoint === "after-exit") {
    await sendAlternateExit(pane, server, terminalId, exitId);
    phaseExited = true;
    checkpoint = await waitForSettled(page, terminalId);
    checkpointEntries = await server.readTranscript(terminalId);
    await assertPhase(page, terminalId, checkpoint, checkpointEntries, "normal-after-exit-before-reconnect", {
      normal: normalMarker,
      alt: altMarker,
      enter: enterMarker,
      exit: exitMarker,
      altReady: true,
      exited: true,
    });
  }

  const recoveredResult = await terminateAndRecover(page, terminalId, checkpoint, faultController);
  checkpoint = recoveredResult.snapshot;
  checkpointEntries = await server.readTranscript(terminalId);
  await assertPhase(page, terminalId, checkpoint, checkpointEntries, `recovered-${closePoint}`, {
    normal: normalMarker,
    alt: altMarker,
    enter: enterMarker,
    exit: exitMarker,
    altReady: phaseAltReady,
    exited: phaseExited,
  });

  if (closePoint === "before-enter") {
    await sendAlternateEnter(pane, server, terminalId, enterId);
    const beforeAltPixels = await screenshotRegion(page, pane.xtermHost);
    await sendPrint(pane, server, terminalId, altId, altText);
    await expectKnownMarkerChanged(page, pane.xtermHost, beforeAltPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: `${runTag}-alternate-marker-after-reconnect`,
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: `${runTag}-alternate-terminal-after-reconnect`,
    });
    phaseAltReady = true;
  }

  if (closePoint === "before-enter" || closePoint === "in-alternate") {
    await sendAlternateExit(pane, server, terminalId, exitId);
    phaseExited = true;
  }

  const beforeFinalPixels: TerminalPixelImage = await screenshotRegion(page, pane.xtermHost);
  await sendPrint(pane, server, terminalId, normalAfterId, normalAfterText);
  await waitForSettled(page, terminalId);
  const afterFinalPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeFinalPixels, afterFinalPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `${runTag}-normal-after-marker`,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: `${runTag}-final-terminal`,
  });

  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(inputText, true);
  const inputBase64 = Buffer.from(inputText, "utf8").toString("base64");
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === inputBase64
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", echoId, inputBase64),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`SIZE ${sizeId}`, true);
  const ptySize = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "size" && entry.id === sizeId && entry.source === "ioctl"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const final = await waitForSettled(page, terminalId);
  expect(ptySize.rows).toBe(final.rows);
  expect(ptySize.cols).toBe(final.cols);
  expect(ptySize.pixel_width).toBe(final.pixelWidth);
  expect(ptySize.pixel_height).toBe(final.pixelHeight);
  expect(final.serverViewport?.rows).toBe(final.rows);
  expect(final.serverViewport?.cols).toBe(final.cols);
  expect(final.activeBuffer).toBe("normal");
  expect(final.xterm.activeBuffer).toBe("normal");
  expect(final.xterm.text).toContain(normalMarker);
  expect(final.xterm.text).toContain(marker("PRINT", normalAfterId, normalAfterText));
  expect(final.xterm.text).toContain(marker("ECHO_INPUT", echoId, inputBase64));
  expect(final.xterm.text).not.toContain(altMarker);
  expect(final.xterm.text).not.toContain(enterMarker);
  expect(final.xterm.text).toContain(exitMarker);
  expect(countOccurrences(final.xterm.text, normalMarker)).toBe(1);
  expect(countOccurrences(final.xterm.text, marker("PRINT", normalAfterId, normalAfterText))).toBe(1);
  expect(countOccurrences(final.xterm.text, marker("ECHO_INPUT", echoId, inputBase64))).toBe(1);
  expect(final.activeSocketCount).toBe(1);
  expect(final.socket.activeCount).toBe(1);
  expect(final.acceptingInput).toBe(true);
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  expect(final.syncMode).toBeUndefined();
  expect(final.syncTarget === undefined || final.committedSequence === undefined || final.committedSequence >= final.syncTarget).toBe(true);

  const finalEntries = await server.readTranscript(terminalId);
  const expectedCommands = [
    `READY ${readyId}`,
    `PRINT ${normalBeforeId} ${normalBeforeText}`,
    ...(closePoint === "before-enter" ? [] : [`ALT_ENTER ${enterId}`, `PRINT ${altId} ${altText}`]),
    ...(closePoint === "after-exit" ? [`ALT_EXIT ${exitId}`] : []),
    ...(closePoint === "before-enter" || closePoint === "in-alternate" ? [`ALT_EXIT ${exitId}`] : []),
    `PRINT ${normalAfterId} ${normalAfterText}`,
    `ECHO_INPUT ${echoId}`,
    inputText,
    `SIZE ${sizeId}`,
  ];
  const commandEntries = finalEntries.filter((entry) => entry.event === "command");
  for (const command of expectedCommands) {
    expect(commandEntries.filter((entry) => entry.command_base64 === commandBytes(command)), `fixture command missing exactly once: ${command}`).toHaveLength(1);
  }
  expect(finalEntries.filter((entry) => entry.event === "print" && entry.id === normalBeforeId)).toHaveLength(1);
  expect(finalEntries.filter((entry) => entry.event === "print" && entry.id === altId)).toHaveLength(1);
  expect(finalEntries.filter((entry) => entry.event === "print" && entry.id === normalAfterId)).toHaveLength(1);
  expect(finalEntries.filter((entry) => entry.event === "alt_enter" && entry.id === enterId)).toHaveLength(1);
  expect(finalEntries.filter((entry) => entry.event === "alt_exit" && entry.id === exitId)).toHaveLength(1);
  expect(finalEntries.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(finalEntries.filter((entry) => entry.event === "error")).toEqual([]);

  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  expect(invariantReport.snapshot.activeBuffer).toBe("normal");
  expect(invariantReport.snapshot.serverViewport?.cols).toBe(GEOMETRY_A.cols);
  expect(invariantReport.snapshot.serverViewport?.rows).toBe(GEOMETRY_A.rows);

  const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
  const connections = networkEvents.filter((event) => event.type === "connection-open");
  expect(connections).toHaveLength(2);
  expect(networkEvents.filter((event) => event.type === "connection-terminated")).toHaveLength(1);
  const outputFrames = networkEvents.filter((event) => (
    event.type === "frame"
      && event.direction === "server-to-browser"
      && event.frame?.binaryKind === 1
  ));
  expect(outputFrames.length).toBeGreaterThan(0);
  let previousFrameSequence = -1;
  for (const frame of outputFrames) {
    if (frame.frame?.sequence === undefined) throw new Error("output frame is missing its sequence");
    expect(frame.frame.sequence).toBeGreaterThanOrEqual(previousFrameSequence);
    previousFrameSequence = frame.frame.sequence;
  }
  expect(final.receivedSequence).toBe(outputBytes(finalEntries).byteLength);
  expect(final.committedSequence).toBe(outputBytes(finalEntries).byteLength);

  await pane.sendInput("EXIT 0", true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "exit" && entry.code === 0, { timeoutMs: WAIT_TIMEOUT_MS });

  return { terminalId, outputBytes: outputBytes(finalEntries) };
}

async function recordingControl(page: Page, action: "start" | "stop" | "clear"): Promise<void> {
  await page.evaluate(async (action) => {
    const response = await fetch("/api/debug/recording", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) throw new Error(`debug recording ${action} failed with HTTP ${response.status}`);
  }, action);
}

async function exportRecording(page: Page): Promise<DebugRecordingExport> {
  return page.evaluate(async () => {
    const response = await fetch("/api/debug/recording/export", { cache: "no-store" });
    if (!response.ok) throw new Error(`debug recording export failed with HTTP ${response.status}`);
    return await response.json() as DebugRecordingExport;
  });
}

function assertDebugRecording(
  recording: DebugRecordingExport,
  terminalId: string,
  expectedBytes: Buffer,
): void {
  const events = recording.events.filter((event) => event.terminal === terminalId);
  const outputEvents = events.filter((event) => event.type === "output");
  expect(outputEvents.length).toBeGreaterThan(0);
  const chunks: Buffer[] = [];
  let sequence = 0;
  for (const event of outputEvents) {
    if (event.sequence === undefined || typeof event.data !== "string") {
      throw new Error("server debug recording output event is missing sequence or data");
    }
    expect(event.sequence).toBe(sequence);
    const bytes = Buffer.from(event.data, "base64");
    chunks.push(bytes);
    sequence += bytes.length;
  }
  expect(Buffer.concat(chunks).equals(expectedBytes)).toBe(true);
  expect(sequence).toBe(expectedBytes.length);
}

for (const closePoint of CLOSE_POINTS) {
  test(`O-08 Alternate-screen recovery (${closePoint}) @p1 @nightly @O-08 @alternate @recovery`, async ({
    page,
    server,
    faultController,
  }, testInfo) => {
    await page.setViewportSize(BROWSER_GEOMETRY_A);
    await page.goto("/");
    await new LoginPage(page).login();
    await recordingControl(page, "clear");
    await recordingControl(page, "start");
    let result: ScenarioResult | undefined;
    try {
      result = await runScenario({ page, server, faultController, closePoint, testInfo });
    } finally {
      await recordingControl(page, "stop");
    }
    if (!result) throw new Error("O-08 scenario did not return a result");
    const recording = await exportRecording(page);
    assertDebugRecording(recording, result.terminalId, result.outputBytes);
  });
}
