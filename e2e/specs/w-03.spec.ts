import { test, expect } from "../fixtures/test.js";
import type { IsolatedServer, TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { type Page, type TestInfo } from "@playwright/test";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  expectConnectedTerminalInvariants,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;
const DESKTOP_VIEWPORT = { width: 1_600, height: 900 } as const;
const NARROW_VIEWPORT = { width: 760, height: 720 } as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type CreatedTerminal = {
  readonly id: string;
  readonly name: string;
};

type QueryEntry = TranscriptEntry & {
  readonly event: "query_complete";
  readonly id: string;
  readonly replies: number;
};

type EchoEntry = TranscriptEntry & {
  readonly event: "echo_input";
  readonly id: string;
  readonly phase: "armed" | "payload";
  readonly payload_base64?: string;
};

type SizeEntry = TranscriptEntry & {
  readonly event: "size";
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
  readonly pixel_width: number;
  readonly pixel_height: number;
};

type RouteRecord = {
  readonly terminalId: string;
  readonly queryId: string;
  readonly echoId: string;
  readonly echoPayload: string;
  readonly printId: string;
  readonly printText: string;
};

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function occurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(value, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + value.length;
  }
}

async function readSnapshot(page: Page, terminalId: string): Promise<E2ETerminalSnapshot | undefined> {
  return page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminal(id);
  }, terminalId);
}

async function requiredSnapshot(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  const snapshot = await readSnapshot(page, terminalId);
  if (!snapshot) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  return snapshot;
}

async function createNamedTerminal(
  page: Page,
  workbench: WorkbenchPage,
  name: string,
): Promise<CreatedTerminal> {
  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as { readonly id?: unknown; readonly name?: unknown };
  if (typeof created.id !== "string" || typeof created.name !== "string") {
    throw new Error("terminal creation response did not include an id and name");
  }
  await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => snapshot.mounted, { timeout });
  }, { id: created.id, timeout: WAIT_TIMEOUT_MS });
  await workbench.sidebar.renameTerminal({ id: created.id, name: created.name }, name);
  await expect(await workbench.sidebar.terminalRow({ id: created.id, name })).toBeVisible();
  return { id: created.id, name };
}

async function waitForFocusedPane(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.mounted
      && snapshot.visible
      && snapshot.active
      && snapshot.focused
      && snapshot.acceptingInput
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForInactivePane(
  page: Page,
  terminalId: string,
): Promise<void> {
  const existing = await readSnapshot(page, terminalId);
  if (!existing) return;
  await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => !snapshot.active && !snapshot.focused && !snapshot.acceptingInput, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function assertRouting(
  page: Page,
  terminalIds: readonly string[],
  activeId: string,
  label: string,
): Promise<void> {
  await waitForFocusedPane(page, activeId);
  await Promise.all(terminalIds.filter((id) => id !== activeId).map((id) => waitForInactivePane(page, id)));
  for (const terminalId of terminalIds) {
    const snapshot = await requiredSnapshot(page, terminalId);
    const expectedActive = terminalId === activeId;
    expect(snapshot.active, `${label}: ${terminalId} active flag`).toBe(expectedActive);
    expect(snapshot.focused, `${label}: ${terminalId} focused flag`).toBe(expectedActive);
    expect(snapshot.acceptingInput, `${label}: ${terminalId} responder flag`).toBe(expectedActive);
  }
}

async function sendFocusedLine(page: Page, pane: TerminalPanePage, line: string): Promise<void> {
  await expect(pane.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function printMarker(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  printId: string,
  text: string,
  testInfo: TestInfo,
): Promise<void> {
  const before = await screenshotRegion(page, pane.xtermHost);
  const printPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === printId && entry.text === text,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await sendFocusedLine(page, pane, `PRINT ${printId} ${text}`);
  await printPromise;
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("PRINT", printId, text),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, pane.xtermHost, before, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `w-03-${printId}-changed`,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: `w-03-${printId}-nonblank`,
  });
}

async function queryAndEcho(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  queryId: string,
  echoId: string,
  echoPayload: string,
): Promise<void> {
  const queryCompletePromise = server.waitForTranscript<QueryEntry>(
    terminalId,
    (entry) => entry.event === "query_complete" && entry.id === queryId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await sendFocusedLine(page, pane, `QUERY ${queryId}`);
  const queryComplete = await queryCompletePromise;
  expect(queryComplete.replies).toBe(6);
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("QUERY", queryId, "COMPLETE", String(queryComplete.replies)),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const echoArmedPromise = server.waitForTranscript<EchoEntry>(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await sendFocusedLine(page, pane, `ECHO_INPUT ${echoId}`);
  await echoArmedPromise;
  const payloadBase64 = Buffer.from(echoPayload, "utf8").toString("base64");
  const echoPayloadPromise = server.waitForTranscript<EchoEntry>(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === payloadBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await sendFocusedLine(page, pane, echoPayload);
  const echo = await echoPayloadPromise;
  expect(echo.payload_base64).toBe(payloadBase64);
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", echoId, payloadBase64),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
}

async function sizeAndConverge(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  sizeId: string,
): Promise<{ readonly size: SizeEntry; readonly snapshot: E2ETerminalSnapshot }> {
  const sizePromise = server.waitForTranscript<SizeEntry>(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await sendFocusedLine(page, pane, `SIZE ${sizeId}`);
  const size = await sizePromise;
  expect(size.rows).toBeGreaterThan(0);
  expect(size.cols).toBeGreaterThan(0);
  const snapshot = await expectTerminalConverged(page, terminalId, {
    cols: size.cols,
    rows: size.rows,
    pixelWidth: size.pixel_width,
    pixelHeight: size.pixel_height,
  }, { timeout: WAIT_TIMEOUT_MS });
  return { size, snapshot };
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  eventType: E2ETerminalEventType,
  generation?: { readonly exact?: number; readonly greaterThan?: number },
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, type, exactGeneration, greaterThan, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === type
      && (exactGeneration === undefined || event.snapshot.socketGeneration === exactGeneration)
      && (greaterThan === undefined || event.snapshot.socketGeneration > greaterThan)
    ), { timeout, afterId: after });
  }, {
    id: terminalId,
    after: afterEventId,
    type: eventType,
    exactGeneration: generation?.exact,
    greaterThan: generation?.greaterThan,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function assertTranscriptRouting(
  server: IsolatedServer,
  terminalIds: readonly string[],
  records: readonly RouteRecord[],
): Promise<void> {
  const transcripts = new Map<string, readonly TranscriptEntry[]>();
  for (const terminalId of terminalIds) transcripts.set(terminalId, await server.readTranscript(terminalId));
  for (const record of records) {
    const target = transcripts.get(record.terminalId);
    if (!target) throw new Error(`missing transcript for terminal ${record.terminalId}`);
    const payloadBase64 = Buffer.from(record.echoPayload, "utf8").toString("base64");
    expect(target.filter((entry) => entry.event === "print" && entry.id === record.printId)).toHaveLength(1);
    expect(target.filter((entry) => entry.event === "query_complete" && entry.id === record.queryId)).toHaveLength(1);
    expect(target.filter((entry) => entry.event === "echo_input" && entry.id === record.echoId && entry.phase === "payload")).toHaveLength(1);
    for (const terminalId of terminalIds) {
      if (terminalId === record.terminalId) continue;
      const other = transcripts.get(terminalId);
      if (!other) throw new Error(`missing transcript for terminal ${terminalId}`);
      expect(other.filter((entry) => entry.event === "print" && entry.id === record.printId)).toHaveLength(0);
      expect(other.filter((entry) => entry.event === "query_complete" && entry.id === record.queryId)).toHaveLength(0);
      expect(other.filter((entry) => entry.event === "echo_input" && entry.id === record.echoId && entry.phase === "payload")).toHaveLength(0);
      expect(other.filter((entry) => entry.event === "write" && entry.text === `${marker("ECHO_INPUT", record.echoId, payloadBase64)}\n`)).toHaveLength(0);
    }
  }
}

async function assertSnapshotRouting(
  page: Page,
  terminalIds: readonly string[],
  records: readonly RouteRecord[],
  closedSnapshot: E2ETerminalSnapshot | undefined,
): Promise<void> {
  const snapshots = new Map<string, E2ETerminalSnapshot>();
  for (const terminalId of terminalIds) {
    const snapshot = await readSnapshot(page, terminalId);
    if (snapshot) snapshots.set(terminalId, snapshot);
  }
  for (const record of records) {
    const target = snapshots.get(record.terminalId) ?? (
      record.terminalId === closedSnapshot?.terminalId ? closedSnapshot : undefined
    );
    if (!target) throw new Error(`missing diagnostic snapshot for ${record.terminalId}`);
    const printMarker = marker("PRINT", record.printId, record.printText);
    const queryMarker = marker("QUERY", record.queryId, "COMPLETE", "6");
    const echoMarker = marker("ECHO_INPUT", record.echoId, Buffer.from(record.echoPayload, "utf8").toString("base64"));
    expect(occurrences(target.xterm.text, printMarker), `${record.terminalId} print marker count`).toBe(1);
    expect(occurrences(target.xterm.text, queryMarker), `${record.terminalId} query marker count`).toBe(1);
    expect(occurrences(target.xterm.text, echoMarker), `${record.terminalId} echo marker count`).toBe(1);
    for (const [terminalId, snapshot] of snapshots) {
      if (terminalId === record.terminalId) continue;
      expect(snapshot.xterm.text, `${terminalId} must not render ${record.printId}`).not.toContain(printMarker);
      expect(snapshot.xterm.text, `${terminalId} must not answer ${record.queryId}`).not.toContain(queryMarker);
      expect(snapshot.xterm.text, `${terminalId} must not echo ${record.echoId}`).not.toContain(echoMarker);
    }
  }
}


function expectSettled(snapshot: E2ETerminalSnapshot, label: string): void {
  expect(snapshot.socketState, `${label} socket state`).toBe("connected");
  expect(snapshot.activeSocketCount, `${label} active socket count`).toBe(1);
  expect(snapshot.socket.activeCount, `${label} diagnostic socket count`).toBe(1);
  expect(snapshot.pendingParserWrites, `${label} parser writes`).toBe(0);
  expect(snapshot.pendingParserBytes, `${label} parser bytes`).toBe(0);
  expect(snapshot.renderBacklogBytes, `${label} render backlog bytes`).toBe(0);
  expect(snapshot.renderBacklogFrames, `${label} render backlog frames`).toBe(0);
  expect(snapshot.syncMode, `${label} sync mode`).toBeUndefined();
  expect(snapshot.serverViewport?.cols, `${label} server columns`).toBe(snapshot.cols);
  expect(snapshot.serverViewport?.rows, `${label} server rows`).toBe(snapshot.rows);
  if (snapshot.receivedSequence !== undefined && snapshot.committedSequence !== undefined) {
    expect(snapshot.committedSequence, `${label} committed sequence`).toBeLessThanOrEqual(snapshot.receivedSequence);
  }
}

test("@p1 @chromium-pr @focus @nightly W-03 Focus routing", async ({ page, baseURL, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `W03-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}-${Date.now()}`;
  const terminalNames = ["W03-A", "W03-B", "W03-C"] as const;
  const terminals: CreatedTerminal[] = [];

  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  for (const name of terminalNames) terminals.push(await createNamedTerminal(page, workbench, name));
  const [terminalA, terminalB, terminalC] = terminals;
  if (!terminalA || !terminalB || !terminalC) throw new Error("W-03 did not create all three terminals");
  const paneA = workbench.terminal(terminalA.id, terminalA.name);
  const paneB = workbench.terminal(terminalB.id, terminalB.name);
  const paneC = workbench.terminal(terminalC.id, terminalC.name);
  await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => snapshot.cached && !snapshot.visible && snapshot.activeSocketCount === 0, { timeout });
  }, { id: terminalA.id, timeout: WAIT_TIMEOUT_MS });
  const cachedA = await requiredSnapshot(page, terminalA.id);
  expect(cachedA.cached).toBe(true);
  expect(cachedA.visible).toBe(false);
  expect(cachedA.activeSocketCount).toBe(0);

  await workbench.openTerminal(terminalA);
  await paneA.expectVisible();
  const revealedA = await requiredSnapshot(page, terminalA.id);
  expect(revealedA.cached).toBe(false);
  expect(revealedA.visible).toBe(true);
  await workbench.sidebar.splitTerminal(terminalB);
  await paneB.expectVisible();
  await workbench.sidebar.splitTerminal(terminalC);
  await paneC.expectVisible();
  await expect(workbench.editorGrid.locator(".pane-slot:not(.cached)")).toHaveCount(3);

  const allIds = [terminalA.id, terminalB.id, terminalC.id] as const;
  const routeRecords: RouteRecord[] = [];
  const initialAQuery = `${runTag}-QUERY-A-CLICK`;
  const initialAEcho = `${runTag}-ECHO-A-CLICK`;
  const initialAPayload = `${runTag}-input-A-click`;
  const initialAPrint = `${runTag}-PRINT-A-CLICK`;
  const initialA = {
    terminalId: terminalA.id,
    queryId: initialAQuery,
    echoId: initialAEcho,
    echoPayload: initialAPayload,
    printId: initialAPrint,
    printText: "focus-A-click",
  } as const;
  routeRecords.push(initialA);

  await paneA.focus();
  await assertRouting(page, allIds, terminalA.id, "click focus A");
  await printMarker(page, paneA, server, terminalA.id, initialAPrint, "focus-A-click", testInfo);
  const aSize = await sizeAndConverge(page, paneA, server, terminalA.id, `${runTag}-SIZE-A-CLICK`);
  expect(aSize.size.rows).toBe(aSize.snapshot.rows);
  expect(aSize.size.cols).toBe(aSize.snapshot.cols);
  await queryAndEcho(page, paneA, server, terminalA.id, initialAQuery, initialAEcho, initialAPayload);

  const initialBQuery = `${runTag}-QUERY-B-CLICK`;
  const initialBEcho = `${runTag}-ECHO-B-CLICK`;
  const initialBPayload = `${runTag}-input-B-click`;
  const initialBPrint = `${runTag}-PRINT-B-CLICK`;
  const initialB = {
    terminalId: terminalB.id,
    queryId: initialBQuery,
    echoId: initialBEcho,
    echoPayload: initialBPayload,
    printId: initialBPrint,
    printText: "focus-B-click",
  } as const;
  routeRecords.push(initialB);
  await paneB.focus();
  await assertRouting(page, allIds, terminalB.id, "click focus B");
  await printMarker(page, paneB, server, terminalB.id, initialBPrint, "focus-B-click", testInfo);
  const bSize = await sizeAndConverge(page, paneB, server, terminalB.id, `${runTag}-SIZE-B-CLICK`);
  expect(bSize.size.rows).toBe(bSize.snapshot.rows);
  expect(bSize.size.cols).toBe(bSize.snapshot.cols);
  await queryAndEcho(page, paneB, server, terminalB.id, initialBQuery, initialBEcho, initialBPayload);

  await page.setViewportSize(NARROW_VIEWPORT);
  await assertRouting(page, allIds, terminalB.id, "narrow viewport retains B");
  const nextPane = page.getByRole("button", { name: "Next terminal pane", exact: true });
  await expect(nextPane).toBeVisible();
  await nextPane.focus();
  await expect(nextPane).toBeFocused();
  await page.keyboard.press("Enter");

  const initialCQuery = `${runTag}-QUERY-C-KEYBOARD`;
  const initialCEcho = `${runTag}-ECHO-C-KEYBOARD`;
  const initialCPayload = `${runTag}-input-C-keyboard`;
  const initialCPrint = `${runTag}-PRINT-C-KEYBOARD`;
  const initialC = {
    terminalId: terminalC.id,
    queryId: initialCQuery,
    echoId: initialCEcho,
    echoPayload: initialCPayload,
    printId: initialCPrint,
    printText: "focus-C-keyboard",
  } as const;
  routeRecords.push(initialC);
  await assertRouting(page, allIds, terminalC.id, "keyboard focus C");
  await printMarker(page, paneC, server, terminalC.id, initialCPrint, "focus-C-keyboard", testInfo);
  const cSize = await sizeAndConverge(page, paneC, server, terminalC.id, `${runTag}-SIZE-C-KEYBOARD`);
  expect(cSize.size.rows).toBe(cSize.snapshot.rows);
  expect(cSize.size.cols).toBe(cSize.snapshot.cols);
  await queryAndEcho(page, paneC, server, terminalC.id, initialCQuery, initialCEcho, initialCPayload);
  const cBeforeClose = await requiredSnapshot(page, terminalC.id);
  const cGeneration = cBeforeClose.socketGeneration;
  const cVisibilityBefore = (await terminalEvents(page, terminalC.id)).at(-1)?.id ?? -1;
  const cHiddenPromise = waitForDiagnosticEventAfter(
    page,
    terminalC.id,
    cVisibilityBefore,
    "visibility",
  ).then((event) => {
    expect(event.data.visible).toBe(false);
    return event;
  });
  const cSocketClosedPromise = waitForDiagnosticEventAfter(
    page,
    terminalC.id,
    cVisibilityBefore,
    "socket-close",
    { exact: cGeneration },
  );

  await paneC.closePane();
  await Promise.all([cHiddenPromise, cSocketClosedPromise]);
  await assertRouting(page, [terminalA.id, terminalB.id], terminalB.id, "close active C promotes B");
  const cAfterClose = await readSnapshot(page, terminalC.id);
  if (cAfterClose) {
    expect(cAfterClose.active).toBe(false);
    expect(cAfterClose.focused).toBe(false);
    expect(cAfterClose.acceptingInput).toBe(false);
    expect(cAfterClose.activeSocketCount).toBe(0);
    expect(cAfterClose.socketGeneration).toBeGreaterThanOrEqual(cGeneration);
  }
  expect(await workbench.visiblePaneCount()).toBe(2);

  await workbench.openMobileSidebar();
  await workbench.sidebar.openTerminal(terminalA);
  await paneA.expectVisible();
  await assertRouting(page, [terminalA.id, terminalB.id], terminalA.id, "sidebar reveal A");

  const revealAQuery = `${runTag}-QUERY-A-REVEAL`;
  const revealAEcho = `${runTag}-ECHO-A-REVEAL`;
  const revealAPayload = `${runTag}-input-A-reveal`;
  const revealAPrint = `${runTag}-PRINT-A-REVEAL`;
  const revealA = {
    terminalId: terminalA.id,
    queryId: revealAQuery,
    echoId: revealAEcho,
    echoPayload: revealAPayload,
    printId: revealAPrint,
    printText: "sidebar-reveal-A",
  } as const;
  routeRecords.push(revealA);
  await printMarker(page, paneA, server, terminalA.id, revealAPrint, "sidebar-reveal-A", testInfo);
  const revealASize = await sizeAndConverge(page, paneA, server, terminalA.id, `${runTag}-SIZE-A-REVEAL`);
  expect(revealASize.size.rows).toBe(revealASize.snapshot.rows);
  expect(revealASize.size.cols).toBe(revealASize.snapshot.cols);
  await queryAndEcho(page, paneA, server, terminalA.id, revealAQuery, revealAEcho, revealAPayload);

  const beforeBReconnect = await requiredSnapshot(page, terminalB.id);
  expect(beforeBReconnect.active).toBe(false);
  expect(beforeBReconnect.focused).toBe(false);
  expect(beforeBReconnect.acceptingInput).toBe(false);
  const oldBGeneration = beforeBReconnect.socketGeneration;
  const bEventsBeforeReconnect = await terminalEvents(page, terminalB.id);
  const bEventCursor = bEventsBeforeReconnect.at(-1)?.id ?? -1;
  const proxyGeneration = [...faultController.events].reverse().find((event) => (
    event.type === "connection-open"
    && event.terminalId === terminalB.id
    && event.generation !== undefined
  ))?.generation;
  expect(proxyGeneration).toBe(oldBGeneration);
  const proxyEventFloor = faultController.events.length;
  const proxyClosePromise = faultController.waitFor((event) => (
    faultController.events.indexOf(event) >= proxyEventFloor
    && (event.type === "connection-closed" || event.type === "connection-terminated")
    && event.terminalId === terminalB.id
    && event.generation === oldBGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const proxyOpenPromise = faultController.waitFor((event) => (
    faultController.events.indexOf(event) >= proxyEventFloor
    && event.type === "connection-open"
    && event.terminalId === terminalB.id
    && event.generation !== undefined
    && event.generation > oldBGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const diagnosticClosePromise = waitForDiagnosticEventAfter(page, terminalB.id, bEventCursor, "socket-close", { exact: oldBGeneration });
  const diagnosticOpenPromise = waitForDiagnosticEventAfter(page, terminalB.id, bEventCursor, "socket-open", { greaterThan: oldBGeneration });
  const diagnosticSyncedPromise = waitForDiagnosticEventAfter(page, terminalB.id, bEventCursor, "synced", { greaterThan: oldBGeneration });
  await page.evaluate(({ id, generation }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.close(id, { generation, abrupt: true, reason: "W03 background reconnect" });
  }, { id: terminalB.id, generation: oldBGeneration });
  const [diagnosticClose, proxyClose] = await Promise.all([diagnosticClosePromise, proxyClosePromise]);
  expect(diagnosticClose.snapshot.activeSocketCount).toBe(0);
  expect(diagnosticClose.snapshot.active).toBe(false);
  expect(proxyClose.generation).toBe(oldBGeneration);
  const [diagnosticOpen, diagnosticSynced, proxyOpen] = await Promise.all([
    diagnosticOpenPromise,
    diagnosticSyncedPromise,
    proxyOpenPromise,
  ]);
  expect(diagnosticOpen.snapshot.socketGeneration).toBeGreaterThan(oldBGeneration);
  expect(diagnosticSynced.snapshot.socketGeneration).toBe(diagnosticOpen.snapshot.socketGeneration);
  expect(proxyOpen.generation).toBe(diagnosticOpen.snapshot.socketGeneration);
  await waitForFocusedPane(page, terminalA.id);
  const afterBReconnect = await requiredSnapshot(page, terminalB.id);
  expect(afterBReconnect.active).toBe(false);
  expect(afterBReconnect.focused).toBe(false);
  expect(afterBReconnect.acceptingInput).toBe(false);
  expectSettled(afterBReconnect, "background B after reconnect");
  await expectTerminalBuffer(page, terminalB.id, {
    contains: marker("PRINT", initialBPrint, "focus-B-click"),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const continuedAQuery = `${runTag}-QUERY-A-CONTINUED`;
  const continuedAEcho = `${runTag}-ECHO-A-CONTINUED`;
  const continuedAPayload = `${runTag}-input-A-after-B-reconnect`;
  const continuedAPrint = `${runTag}-PRINT-A-CONTINUED`;
  const continuedA = {
    terminalId: terminalA.id,
    queryId: continuedAQuery,
    echoId: continuedAEcho,
    echoPayload: continuedAPayload,
    printId: continuedAPrint,
    printText: "continued-A-after-B-reconnect",
  } as const;
  routeRecords.push(continuedA);
  await printMarker(page, paneA, server, terminalA.id, continuedAPrint, "continued-A-after-B-reconnect", testInfo);
  const continuedASize = await sizeAndConverge(page, paneA, server, terminalA.id, `${runTag}-SIZE-A-CONTINUED`);
  expect(continuedASize.size.rows).toBe(continuedASize.snapshot.rows);
  expect(continuedASize.size.cols).toBe(continuedASize.snapshot.cols);
  await queryAndEcho(page, paneA, server, terminalA.id, continuedAQuery, continuedAEcho, continuedAPayload);

  await page.setViewportSize(DESKTOP_VIEWPORT);
  await paneA.expectVisible();
  await paneB.expectVisible();
  await expectTerminalNonBlank(page, paneA.xtermHost, {
    testInfo,
    artifactName: "w-03-final-A-nonblank",
  });
  await expectTerminalNonBlank(page, paneB.xtermHost, {
    testInfo,
    artifactName: "w-03-reconnected-B-nonblank",
  });

  await assertTranscriptRouting(server, allIds, routeRecords);
  await assertSnapshotRouting(page, allIds, routeRecords, cBeforeClose);
  const finalA = await requiredSnapshot(page, terminalA.id);
  const finalB = await requiredSnapshot(page, terminalB.id);
  expect(finalA.active).toBe(true);
  expect(finalA.focused).toBe(true);
  expect(finalA.acceptingInput).toBe(true);
  expect(finalB.active).toBe(false);
  expect(finalB.focused).toBe(false);
  expect(finalB.acceptingInput).toBe(false);
  expectSettled(finalA, "final A");
  expectSettled(finalB, "final B");
  expect(finalB.socketGeneration).toBeGreaterThan(oldBGeneration);
  expect(finalB.socketGeneration).toBe(diagnosticOpen.snapshot.socketGeneration);
  await expectNoPendingRecovery(page, terminalA.id, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalB.id, { timeout: WAIT_TIMEOUT_MS });
  const aInvariant = await expectConnectedTerminalInvariants(page, terminalA.id, { timeout: WAIT_TIMEOUT_MS });
  expect(aInvariant.violations).toEqual([]);
  const bInvariant = await expectTerminalInvariants(page, terminalB.id, { timeout: WAIT_TIMEOUT_MS });
  expect(bInvariant.violations).toEqual([]);

  for (const terminalId of allIds) {
    const events = await terminalEvents(page, terminalId);
    await assertMonotonicSequences(events);
    expect(events.filter((event) => event.type === "socket-stale"), `${terminalId} stale socket events`).toHaveLength(0);
    expect(events.filter((event) => event.type === "error"), `${terminalId} diagnostic errors`).toHaveLength(0);
  }
  const finalTranscripts = await Promise.all(allIds.map((terminalId) => server.readTranscript(terminalId)));
  expect(finalTranscripts.flat().filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(faultController.events.filter((event) => event.type === "socket-error" || event.type === "malformed-frame")).toHaveLength(0);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error|internal server error)/i);
  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
    || entry.kind === "websocket" && entry.message === "error"
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
  browserErrors.dispose();
});
