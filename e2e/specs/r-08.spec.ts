import { Buffer } from "node:buffer";
import { test, expect } from "../fixtures/test.js";
import type { IsolatedServer, TranscriptEntry } from "../fixtures/test.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectNoPendingRecovery,
  expectTerminalSynchronized,
  terminalEvents,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectConnectedTerminalInvariants,
  assertNoUnexpectedSocketMultiplication,
} from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import type { Locator, Page } from "@playwright/test";

const WAIT_TIMEOUT_MS = 45_000;
const INITIAL_VIEWPORT = { width: 1_280, height: 800 };
const RESIZED_VIEWPORT = { width: 920, height: 640 };

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

function marker(operation: string, id: string, value: string): string {
  return `[E2E:${operation}:${id}:${value}]`;
}

function occurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  eventId: number,
  eventType: E2ETerminalEvent["type"],
  options: { readonly generation?: number; readonly states?: readonly string[] } = {},
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, eventId, eventType, generation, states, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > eventId
        && event.type === eventType
        && (generation === undefined || event.data.generation === generation)
        && (states === undefined || states.includes(String(event.data.state))),
      { timeout, afterId: eventId },
    );
  }, {
    id: terminalId,
    eventId,
    eventType,
    generation: options.generation,
    states: options.states,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForRenderedMarker(
  page: Page,
  terminalId: string,
  text: string,
  previousRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, text, previousRenderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > previousRenderCount
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && (snapshot.xterm.text.includes(text)
        || snapshot.xterm.text.replaceAll("\n", "").includes(text))
    ), { timeout });
  }, { id: terminalId, text, previousRenderCount, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSelectionRendered(
  page: Page,
  terminalId: string,
  selectionText: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, selectionText, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.xterm.selectionText === selectionText
    ), { timeout });
  }, { id: terminalId, selectionText, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRecoveredTerminal(
  page: Page,
  terminalId: string,
  previousGeneration: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previousGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration > previousGeneration
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
  }, { id: terminalId, previousGeneration, timeout: WAIT_TIMEOUT_MS });
}

async function selectText(
  pane: TerminalPanePage,
  screen: Locator,
  snapshot: E2ETerminalSnapshot,
  selectedText: string,
): Promise<void> {
  const lines = snapshot.xterm.text.split("\n");
  const compactedText = lines.join("");
  const startOffset = compactedText.indexOf(selectedText);
  if (startOffset < 0) throw new Error(`Unable to locate ${selectedText} in the terminal model`);

  const cellAt = (offset: number): { readonly row: number; readonly column: number } => {
    let remaining = offset;
    for (const [row, line] of lines.entries()) {
      if (remaining < line.length) return { row, column: remaining };
      remaining -= line.length;
    }
    throw new Error(`Unable to map ${selectedText} to terminal cells`);
  };
  const start = cellAt(startOffset);
  const end = cellAt(startOffset + selectedText.length - 1);
  const startVisualRow = start.row - snapshot.viewportY;
  const endVisualRow = end.row - snapshot.viewportY;
  if (
    startVisualRow < 0
    || startVisualRow >= snapshot.rows
    || endVisualRow < 0
    || endVisualRow >= snapshot.rows
  ) {
    throw new Error(`Selection marker ${selectedText} is outside the visible terminal viewport`);
  }
  const box = await screen.boundingBox();
  if (!box || snapshot.cols <= 0 || snapshot.rows <= 0) {
    throw new Error("Terminal screen geometry is unavailable for selection");
  }
  const cellWidth = box.width / snapshot.cols;
  const cellHeight = box.height / snapshot.rows;
  const startX = box.x + (start.column + 0.25) * cellWidth;
  const startY = box.y + (startVisualRow + 0.5) * cellHeight;
  const endX = box.x + (end.column + 0.75) * cellWidth;
  const endY = box.y + (endVisualRow + 0.5) * cellHeight;
  await pane.page.mouse.move(startX, startY);
  await pane.page.mouse.down();
  await pane.page.mouse.move(endX, endY);
  await pane.page.mouse.up();
}

async function sendCommand(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  command: string,
  eventName: string,
  predicate: (entry: TranscriptEntry) => boolean,
  outputMarker?: string,
): Promise<void> {
  const before = await pane.snapshot();
  if (!before) throw new Error(`No diagnostics snapshot before ${command}`);
  const rendered = outputMarker === undefined
    ? undefined
    : waitForRenderedMarker(page, terminalId, outputMarker, before.renderCount);
  await pane.sendInput(command, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === eventName && predicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  if (outputMarker !== undefined) {
    await expectTerminalBuffer(page, terminalId, { contains: outputMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await rendered;
  }
}

async function terminalName(pane: TerminalPanePage): Promise<string> {
  const label = await pane.root.getAttribute("aria-label");
  const name = label?.replace(/^Terminal(?: pane)?\s+/i, "").trim();
  if (!name) throw new Error("Created terminal did not expose an accessible name");
  return name;
}

test("@p1 @pr @nightly @render @interaction @recovery R-08 Selection and search after recovery", async ({
  browser,
  page,
  server,
  faultController,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.setViewportSize(INITIAL_VIEWPORT);
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const existingTerminalIds = await page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminals().map((snapshot) => snapshot.terminalId);
  });
  const mountEvent = page.evaluate(async ({ existingTerminalIds, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount"
        && event.snapshot.kind === "pane"
        && !existingTerminalIds.includes(event.terminalId),
      { timeout },
    );
  }, { existingTerminalIds, timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  const name = await terminalName(pane);
  const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.socketState).toBe("connected");
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.acceptingInput).toBe(true);
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);

  const runTag = `R08-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-READY`;
  const selectId = `${runTag}-SELECT`;
  const selectValue = `${runTag}-SELECT-ME`;
  const otherId = `${runTag}-OTHER`;
  const otherValue = `${runTag}-OTHER-MARKER`;
  const postId = `${runTag}-POST`;
  const postValue = `${runTag}-POST-RECOVERY`;
  const sizeId = `${runTag}-SIZE`;
  const echoId = `${runTag}-ECHO`;
  const echoValue = `${runTag}-CONTINUED-INPUT`;
  const readyMarker = `[E2E:READY:${readyId}]`;
  const selectMarker = marker("PRINT", selectId, selectValue);
  const otherMarker = marker("PRINT", otherId, otherValue);
  const postMarker = marker("PRINT", postId, postValue);
  const echoMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoValue, "utf8").toString("base64")}]`;

  await sendCommand(
    page,
    server,
    pane,
    terminalId,
    `READY ${readyId}`,
    "ready",
    (entry) => entry.id === readyId,
    readyMarker,
  );
  await sendCommand(
    page,
    server,
    pane,
    terminalId,
    `PRINT ${selectId} ${selectValue}`,
    "print",
    (entry) => entry.id === selectId && entry.text === selectValue,
    selectMarker,
  );
  await sendCommand(
    page,
    server,
    pane,
    terminalId,
    `PRINT ${otherId} ${otherValue}`,
    "print",
    (entry) => entry.id === otherId && entry.text === otherValue,
    otherMarker,
  );

  const screen = pane.xtermHost.locator(".xterm-screen");
  await expect(screen).toBeVisible();
  const selectionBefore = await pane.snapshot();
  if (!selectionBefore) throw new Error(`No diagnostics snapshot before selection for ${terminalId}`);
  const beforeSelectionPixels = await screenshotRegion(page, pane.xtermHost);
  const selectionRendered = waitForSelectionRendered(page, terminalId, selectValue);
  await selectText(pane, screen, selectionBefore, selectValue);
  const selected = await selectionRendered;
  expect(selected.xterm.selectionText).toBe(selectValue);
  const afterSelectionPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeSelectionPixels, afterSelectionPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "r-08-selection",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-08-selection-nonblank",
  });

  await pane.openSearch();
  const beforeSearchSnapshot = await pane.snapshot();
  if (!beforeSearchSnapshot) throw new Error(`No diagnostics snapshot before search for ${terminalId}`);
  const beforeSearchPixels = await screenshotRegion(page, pane.xtermHost);
  const searchRendered = waitForRenderedMarker(page, terminalId, selectMarker, beforeSearchSnapshot.renderCount);
  const searchInput = pane.root.getByRole("searchbox", { name: "Search terminal scrollback", exact: true });
  await searchInput.fill(selectValue);
  const searchResults = pane.root.locator(".terminal-search-results");
  await expect(searchResults).toHaveText("1/1");
  await expect(searchInput).toHaveValue(selectValue);
  await searchRendered;
  const afterSearchPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeSearchPixels, afterSearchPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "r-08-search-highlight",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-08-search-nonblank",
  });
  const preRecovery = await pane.snapshot();
  if (!preRecovery) throw new Error(`No diagnostics snapshot before resize for ${terminalId}`);
  expect(preRecovery.xterm.selectionText).toBe(selectValue);
  const preRecoveryText = preRecovery.xterm.text.replaceAll("\n", "");
  expect(preRecoveryText).toContain(selectMarker);
  expect(preRecoveryText).toContain(otherMarker);
  const resizeBefore = preRecovery;
  const resizeEventId = (await terminalEvents(page, terminalId)).at(-1)?.id ?? -1;

  const viewportEvent = waitForEventAfter(
    page,
    terminalId,
    resizeEventId,
    "viewport",
  );
  await page.setViewportSize(RESIZED_VIEWPORT);
  await viewportEvent;
  const resized = await page.evaluate(async ({ id, previous, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && (snapshot.cols !== previous.cols || snapshot.rows !== previous.rows)
      && snapshot.serverViewport !== undefined
      && snapshot.serverViewport.cols === snapshot.cols
      && snapshot.serverViewport.rows === snapshot.rows
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, {
    id: terminalId,
    previous: { cols: resizeBefore.cols, rows: resizeBefore.rows },
    timeout: WAIT_TIMEOUT_MS,
  });
  expect(resized.cols !== resizeBefore.cols || resized.rows !== resizeBefore.rows).toBe(true);

  const initialProxyConnection = [...faultController.events].reverse().find(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
  );
  if (!initialProxyConnection || initialProxyConnection.generation === undefined) {
    throw new Error(`No reverse-proxy generation for terminal ${terminalId}`);
  }
  const initialProxyGeneration = initialProxyConnection.generation;

  const peerContext = await browser.newContext({
    baseURL: server.baseURL,
    viewport: RESIZED_VIEWPORT,
  });
  const peerPage = await peerContext.newPage();
  const peerErrors: string[] = [];
  const peerConsoleErrors: string[] = [];
  peerPage.on("pageerror", (error) => peerErrors.push(error.message));
  peerPage.on("console", (message) => {
    if (message.type() === "error") peerConsoleErrors.push(message.text());
  });
  try {
    await peerPage.goto(server.baseURL);
    await new LoginPage(peerPage).login();
    const peerWorkbench = new WorkbenchPage(peerPage);
    await peerWorkbench.expectVisible();
    const peerPane = await peerWorkbench.openTerminal({ id: terminalId, name });
    await peerPane.expectVisible();
    await peerPane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    const peerInitial = await expectTerminalConverged(
      peerPage,
      terminalId,
      { cols: resized.cols, rows: resized.rows },
      { timeout: WAIT_TIMEOUT_MS },
    );
    expect(peerInitial.socketState).toBe("connected");
    expect(peerInitial.acceptingInput).toBe(true);
    expect(peerInitial.cols).toBe(resized.cols);
    expect(peerInitial.rows).toBe(resized.rows);

    const peerProxyConnection = [...faultController.events].reverse().find(
      (event) => event.type === "connection-open"
        && event.terminalId === terminalId
        && event.generation !== undefined
        && event.generation > initialProxyGeneration,
    );
    if (!peerProxyConnection || peerProxyConnection.generation === undefined) {
      throw new Error(`No reverse-proxy generation for peer terminal ${terminalId}`);
    }
    const peerProxyGeneration = peerProxyConnection.generation;

    const beforeClose = await pane.snapshot();
    if (!beforeClose) throw new Error(`No diagnostics snapshot before reconnect for ${terminalId}`);
    const beforeRecoveryPixels = await screenshotRegion(page, pane.xtermHost);
    const beforeCloseEvents = await terminalEvents(page, terminalId);
    const closeEventId = beforeCloseEvents.at(-1)?.id ?? -1;
    const socketClose = waitForEventAfter(
      page,
      terminalId,
      closeEventId,
      "socket-close",
      { generation: beforeClose.socketGeneration },
    );
    const recovering = waitForEventAfter(
      page,
      terminalId,
      closeEventId,
      "state",
      { states: ["recovering", "disconnected"] },
    );
    const proxyTerminated = faultController.waitFor(
      (event) => event.type === "connection-terminated"
        && event.terminalId === terminalId
        && event.generation === initialProxyGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const delayedUpgrade = faultController.delayUpgrade({ terminalId }, 500);
    const delayedUpgradeSeen = faultController.waitFor(
      (event) => event.type === "upgrade-delay"
        && event.terminalId === terminalId
        && event.generation !== undefined
        && event.generation > peerProxyGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const reconnectOpened = faultController.waitFor(
      (event) => event.type === "connection-open"
        && event.terminalId === terminalId
        && event.generation !== undefined
        && event.generation > peerProxyGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const terminated = faultController.terminate({ terminalId, generation: initialProxyGeneration });
    try {
      await Promise.all([socketClose, recovering, proxyTerminated, delayedUpgradeSeen]);
      const postPrint = server.waitForTranscript(
        terminalId,
        (entry) => entry.event === "print" && entry.id === postId && entry.text === postValue,
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      await peerPane.sendInput(`PRINT ${postId} ${postValue}`, true);
      await postPrint;
      await waitForRecoveredTerminal(page, terminalId, beforeClose.socketGeneration);
      await reconnectOpened;
    } finally {
      delayedUpgrade.dispose();
      terminated.dispose();
    }

    const recovered = await waitForRecoveredTerminal(page, terminalId, beforeClose.socketGeneration);
    expect(recovered.socketGeneration).toBeGreaterThan(beforeClose.socketGeneration);
    expect(recovered.socketState).toBe("connected");
    expect(recovered.activeSocketCount).toBe(1);
    expect(recovered.acceptingInput).toBe(true);
    expect(recovered.serverViewport?.cols).toBe(recovered.cols);
    expect(recovered.serverViewport?.rows).toBe(recovered.rows);
    await expectTerminalBuffer(page, terminalId, { contains: selectMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: otherMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: postMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const recoveredRender = await waitForRenderedMarker(page, terminalId, postMarker, beforeClose.renderCount);
    expect(recoveredRender.renderCount).toBeGreaterThan(beforeClose.renderCount);
    const afterRecoveryPixels = await screenshotRegion(page, pane.xtermHost);
    await expectTerminalPixelsChanged(beforeRecoveryPixels, afterRecoveryPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "r-08-recovery-marker",
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "r-08-recovered-terminal",
    });

    const afterRecoverySnapshot = await pane.snapshot();
    if (!afterRecoverySnapshot) throw new Error(`No diagnostics snapshot after recovery for ${terminalId}`);
    expect(typeof afterRecoverySnapshot.xterm.selectionText).toBe("string");

    const recoveredSearch = pane.root.getByRole("search");
    await expect(recoveredSearch).toBeVisible();
    const recoveredSearchInput = pane.root.getByRole("searchbox", { name: "Search terminal scrollback", exact: true });
    await expect(recoveredSearchInput).toHaveValue(selectValue);
    await expect(searchResults).toHaveText("1/1");
    await pane.closeSearch();
    const sizeBefore = await pane.snapshot();
    if (!sizeBefore) throw new Error(`No diagnostics snapshot before SIZE for ${terminalId}`);
    const sizeMarkerPrefix = `[E2E:SIZE:${sizeId}:`;
    const sizeRendered = waitForRenderedMarker(page, terminalId, sizeMarkerPrefix, sizeBefore.renderCount);
    await pane.sendInput(`SIZE ${sizeId}`, true);
    const size = await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "size" && entry.id === sizeId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const ptyRows = Number(size.rows);
    const ptyCols = Number(size.cols);
    expect(Number.isInteger(ptyRows)).toBe(true);
    expect(Number.isInteger(ptyCols)).toBe(true);
    expect(ptyRows).toBe(recovered.rows);
    expect(ptyCols).toBe(recovered.cols);
    await expectTerminalBuffer(page, terminalId, { contains: sizeMarkerPrefix, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await sizeRendered;

    await pane.focus();
    const echoBefore = await pane.snapshot();
    if (!echoBefore) throw new Error(`No diagnostics snapshot before continued input for ${terminalId}`);
    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const echoRendered = waitForRenderedMarker(page, terminalId, echoMarker, echoBefore.renderCount);
    await pane.sendInput(echoValue, true);
    const echoed = await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input"
        && entry.id === echoId
        && entry.phase === "payload"
        && entry.payload_base64 === Buffer.from(echoValue, "utf8").toString("base64"),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(echoed.payload_base64).toBe(Buffer.from(echoValue, "utf8").toString("base64"));
    await expectTerminalBuffer(page, terminalId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await echoRendered;
  } finally {
    await peerContext.close();
  }

  const finalSnapshot = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    activeSocketCount: 1,
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(finalSnapshot.serverViewport?.cols).toBe(finalSnapshot.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(finalSnapshot.rows);
  const finalText = finalSnapshot.xterm.text.replaceAll("\n", "");
  expect(finalText).toContain(selectMarker);
  expect(finalText).toContain(otherMarker);
  expect(finalText).toContain(postMarker);
  expect(finalText).toContain(echoMarker);
  expect(occurrences(finalText, selectMarker)).toBe(1);
  expect(occurrences(finalText, otherMarker)).toBe(1);
  expect(occurrences(finalText, postMarker)).toBe(1);
  expect(occurrences(finalText, echoMarker)).toBe(1);
  await expectTerminalConverged(page, terminalId, { cols: finalSnapshot.cols, rows: finalSnapshot.rows }, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  assertNoPendingSynchronization(finalSnapshot);
  assertNoUnexpectedSocketMultiplication([initial, preRecovery, resized, finalSnapshot]);

  const finalPixels = await screenshotRegion(page, pane.xtermHost);
  expect(finalPixels.width).toBeGreaterThan(0);
  expect(finalPixels.height).toBeGreaterThan(0);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-08-final-terminal",
  });

  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(2);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(1);
  expect(events.filter((event) => event.type === "sync")).toHaveLength(2);
  expect(events.filter((event) => event.type === "synced")).toHaveLength(2);
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === selectId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === otherId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === postId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(peerErrors).toEqual([]);
  expect(peerConsoleErrors).toEqual([]);
});
