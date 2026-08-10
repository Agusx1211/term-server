import { test, expect, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import TerminalPanePage from "../pages/terminal-pane.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import {
  terminalEvents,
  terminalSnapshot,
  expectTerminalBuffer,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import type { Page, TestInfo } from "@playwright/test";

const WAIT_TIMEOUT_MS = 30_000;
const INITIAL_VIEWPORT = { width: 1600, height: 900 } as const;
const RESIZED_VIEWPORT = { width: 1440, height: 820 } as const;

test.setTimeout(180_000);

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

interface FixtureTerminal {
  readonly id: string;
  readonly name: string;
}

interface PaneUnderTest extends FixtureTerminal {
  readonly pane: TerminalPanePage;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ClientConfig {
  readonly maxPanes?: unknown;
}

function marker(operation: string, id: string, value?: string): string {
  return value === undefined
    ? `[E2E:${operation}:${id}]`
    : `[E2E:${operation}:${id}:${value}]`;
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(1, needle.length);
  }
}

function transcriptNumber(entry: TranscriptEntry, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  floor: number,
  type: E2ETerminalEventType,
  source?: string,
): Promise<void> {
  await page.evaluate(async ({ id, floor: eventFloor, eventType, eventSource, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForEvent(
      id,
      (event) => event.id > eventFloor
        && event.type === eventType
        && (eventSource === undefined || event.data.source === eventSource),
      { timeout },
    );
  }, { id: terminalId, floor, eventType: type, eventSource: source, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledPane(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => {
        const proposed = snapshot.proposedViewport;
        const sent = snapshot.sentViewport;
        const server = snapshot.serverViewport;
        const matchesGrid = (viewport: typeof proposed): boolean => Boolean(
          viewport
            && viewport.cols === snapshot.cols
            && viewport.rows === snapshot.rows,
        );
        const synchronized = snapshot.syncTarget === undefined
          || snapshot.committedSequence === undefined
          || snapshot.committedSequence >= snapshot.syncTarget;
        return snapshot.lifecycle.mounted
          && snapshot.lifecycle.visible
          && !snapshot.lifecycle.cached
          && snapshot.socketState === "connected"
          && snapshot.activeSocketCount === 1
          && snapshot.pendingParserWrites === 0
          && snapshot.pendingParserBytes === 0
          && snapshot.renderBacklogBytes === 0
          && snapshot.renderBacklogFrames === 0
          && synchronized
          && matchesGrid(proposed)
          && matchesGrid(sent)
          && matchesGrid(server);
      },
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForPaneQuiescent(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && (snapshot.syncTarget === undefined
          || snapshot.committedSequence === undefined
          || snapshot.committedSequence >= snapshot.syncTarget),
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function readMaxPanes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`config request failed with HTTP ${response.status}`);
    const config = await response.json() as ClientConfig;
    if (typeof config.maxPanes !== "number" || !Number.isInteger(config.maxPanes) || config.maxPanes < 1) {
      throw new Error("server config omitted a positive maxPanes value");
    }
    return config.maxPanes;
  });
}

async function createAndRenameTerminal(
  page: Page,
  workbench: WorkbenchPage,
  name: string,
): Promise<FixtureTerminal> {
  const createResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const response = await createResponse;
  if (!response.ok()) throw new Error(`terminal creation failed with HTTP ${response.status()}`);
  const created = await response.json() as { id?: unknown; name?: unknown };
  if (typeof created.id !== "string" || typeof created.name !== "string") {
    throw new Error("terminal creation response omitted its identity");
  }
  const createdId = created.id;
  const createdName = created.name;

  const renameResponse = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return candidate.request().method() === "PATCH"
      && url.pathname === `/api/terminals/${encodeURIComponent(createdId)}`;
  });
  await workbench.sidebar.renameTerminal({ id: createdId, name: createdName }, name);
  const renamed = await renameResponse;
  if (!renamed.ok()) throw new Error(`terminal rename failed with HTTP ${renamed.status()}`);
  await expect(await workbench.sidebar.terminalRow({ id: createdId, name })).toBeVisible();
  return { id: createdId, name };
}

async function paneEventFloor(page: Page, terminalId: string): Promise<number> {
  const events = await terminalEvents(page, terminalId);
  return events.at(-1)?.id ?? 0;
}

async function waitForActivePane(
  page: Page,
  panes: readonly PaneUnderTest[],
  activeId: string,
): Promise<readonly E2ETerminalSnapshot[]> {
  await Promise.all(panes.map((pane) => waitForTerminalState(
    page,
    pane.id,
    { active: pane.id === activeId, acceptingInput: pane.id === activeId },
    { timeout: WAIT_TIMEOUT_MS },
  )));
  const snapshots = await Promise.all(panes.map(async (pane) => {
    const snapshot = await terminalSnapshot(page, pane.id);
    if (!snapshot) throw new Error(`missing diagnostics snapshot for terminal ${pane.id}`);
    return snapshot;
  }));
  expect(snapshots.filter((snapshot) => snapshot.active)).toHaveLength(1);
  expect(snapshots.filter((snapshot) => snapshot.acceptingInput)).toHaveLength(1);
  expect(snapshots.find((snapshot) => snapshot.active)?.terminalId).toBe(activeId);
  return snapshots;
}

async function assertNonOverlappingBoxes(panes: readonly PaneUnderTest[]): Promise<readonly Box[]> {
  const boxes = await Promise.all(panes.map(async ({ pane, id }) => {
    const box = await pane.xtermHost.boundingBox();
    if (!box) throw new Error(`terminal ${id} has no compositor bounding box`);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    return box;
  }));
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const first = boxes[left]!;
      const second = boxes[right]!;
      const overlapWidth = Math.max(
        0,
        Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
      );
      expect(overlapWidth * overlapHeight).toBe(0);
    }
  }
  return boxes;
}

async function issueSize(
  page: Page,
  server: IsolatedServer,
  pane: PaneUnderTest,
  sizeId: string,
): Promise<TranscriptEntry> {
  await pane.pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(
    pane.id,
    (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const rows = transcriptNumber(size, "rows");
  const cols = transcriptNumber(size, "cols");
  if (rows === undefined || cols === undefined) throw new Error(`SIZE ${sizeId} omitted PTY dimensions`);
  await expectTerminalBuffer(page, pane.id, {
    contains: marker("SIZE", sizeId, `${rows}:${cols}`),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await waitForPaneQuiescent(page, pane.id);
  return size;
}

async function issuePrint(
  page: Page,
  server: IsolatedServer,
  pane: PaneUnderTest,
  printId: string,
  printText: string,
  testInfo: TestInfo,
  artifactPrefix: string,
): Promise<void> {
  const before = await screenshotRegion(page, pane.pane.xtermHost);
  const renderFloor = await paneEventFloor(page, pane.id);
  const renderWait = waitForDiagnosticEventAfter(page, pane.id, renderFloor, "render");
  await pane.pane.sendInput(`PRINT ${printId} ${printText}`, true);
  await server.waitForTranscript(
    pane.id,
    (entry) => entry.event === "print" && entry.id === printId && entry.text === printText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, pane.id, {
    contains: marker("PRINT", printId, printText),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await renderWait;
  await expectKnownMarkerChanged(page, pane.pane.xtermHost, before, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `${artifactPrefix}-changed`,
  });
  await expectTerminalNonBlank(page, pane.pane.xtermHost, {
    testInfo,
    artifactName: `${artifactPrefix}-nonblank`,
  });
  await waitForPaneQuiescent(page, pane.id);
}

async function issueEcho(
  page: Page,
  server: IsolatedServer,
  pane: PaneUnderTest,
  echoId: string,
  inputMarker: string,
): Promise<void> {
  await pane.pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    pane.id,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.pane.sendInput(inputMarker, true);
  const payload = await server.waitForTranscript(
    pane.id,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(payload.payload_base64).toBe(base64(inputMarker));
  await expectTerminalBuffer(page, pane.id, {
    contains: marker("ECHO_INPUT", echoId, base64(inputMarker)),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await waitForPaneQuiescent(page, pane.id);
}

async function issueQuery(
  page: Page,
  server: IsolatedServer,
  pane: PaneUnderTest,
  queryId: string,
): Promise<void> {
  await pane.pane.sendInput(`QUERY ${queryId}`, true);
  const complete = await server.waitForTranscript(
    pane.id,
    (entry) => entry.event === "query_complete" && entry.id === queryId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(complete.replies).toBe(6);
  await expectTerminalBuffer(page, pane.id, {
    contains: marker("QUERY", queryId, "COMPLETE:6"),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await waitForPaneQuiescent(page, pane.id);
}

async function resizeStage(
  page: Page,
  panes: readonly PaneUnderTest[],
  action: () => Promise<void>,
): Promise<readonly E2ETerminalSnapshot[]> {
  const floors = await Promise.all(panes.map((pane) => paneEventFloor(page, pane.id)));
  const viewportWaits = panes.map((pane, index) => waitForDiagnosticEventAfter(
    page,
    pane.id,
    floors[index]!,
    "viewport",
    "sent",
  ));
  await action();
  await Promise.all(viewportWaits);
  return Promise.all(panes.map((pane) => waitForSettledPane(page, pane.id)));
}

async function assertLatestResponder(page: Page, terminalId: string): Promise<void> {
  const events = await terminalEvents(page, terminalId);
  const sizes = events.filter((event) => event.type === "size");
  if (sizes.length === 0) throw new Error(`terminal ${terminalId} emitted no browser size/responder event`);
  expect(sizes.at(-1)?.data.responder).toBe(true);
}


test("@nightly @p1 @chromium-pr @layout W-02 Multiple visible panes", async ({ page, baseURL, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const networkFloor = faultController.events.length;
  try {
    await page.setViewportSize(INITIAL_VIEWPORT);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const maxPanes = await readMaxPanes(page);
    const token = `W02-${testInfo.testId}-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}`
      .replace(/[^A-Za-z0-9_-]+/g, "-");
    const terminals: FixtureTerminal[] = [];
    for (let index = 0; index < maxPanes; index += 1) {
      terminals.push(await createAndRenameTerminal(page, workbench, `${token}-P${index + 1}`));
    }

    const lastTerminal = terminals.at(-1);
    if (!lastTerminal) throw new Error("maximum pane setup created no terminal");
    for (const terminal of terminals.slice(0, -1)) {
      const visibilityFloor = await paneEventFloor(page, terminal.id);
      const visibleWait = waitForDiagnosticEventAfter(page, terminal.id, visibilityFloor, "visibility");
      await workbench.sidebar.splitTerminal({ id: terminal.id, name: terminal.name });
      await visibleWait;
      await waitForSettledPane(page, terminal.id);
    }
    await expect(workbench.editorGrid.locator(".pane-slot:not(.cached)")).toHaveCount(maxPanes);
    expect(await workbench.visiblePaneCount()).toBe(maxPanes);

    const panes: PaneUnderTest[] = terminals.map((terminal) => ({
      ...terminal,
      pane: workbench.terminal(terminal.id, terminal.name),
    }));
    await Promise.all(panes.map((pane) => pane.pane.expectVisible()));
    const paneSnapshots = await Promise.all(panes.map((pane) => waitForSettledPane(page, pane.id)));
    expect(paneSnapshots).toHaveLength(maxPanes);
    await assertNonOverlappingBoxes(panes);

    const initialSizes = new Map<string, TranscriptEntry>();
    const initialCrops = new Map<string, TerminalPixelImage>();
    for (const pane of panes) {
      await pane.pane.focus();
      await waitForActivePane(page, panes, pane.id);
      const sizeId = `${token}-${pane.name}-SIZE-initial`;
      const size = await issueSize(page, server, pane, sizeId);
      const snapshot = await terminalSnapshot(page, pane.id);
      if (!snapshot) throw new Error(`missing initial diagnostics snapshot for terminal ${pane.id}`);
      const rows = transcriptNumber(size, "rows");
      const cols = transcriptNumber(size, "cols");
      const pixelWidth = transcriptNumber(size, "pixel_width");
      const pixelHeight = transcriptNumber(size, "pixel_height");
      expect(rows).toBe(snapshot.rows);
      expect(cols).toBe(snapshot.cols);
      if (pixelWidth !== undefined) expect(pixelWidth).toBe(snapshot.pixelWidth);
      if (pixelHeight !== undefined) expect(pixelHeight).toBe(snapshot.pixelHeight);
      expect(snapshot.serverViewport).toMatchObject({ cols, rows });
      initialSizes.set(pane.id, size);
      initialCrops.set(pane.id, await screenshotRegion(page, pane.pane.xtermHost));
    }

    for (const pane of panes) {
      await pane.pane.focus();
      await waitForActivePane(page, panes, pane.id);
      const printId = `${token}-${pane.name}-PRINT-initial`;
      const printText = `${pane.name}-visible`;
      const before = initialCrops.get(pane.id);
      if (!before) throw new Error(`missing initial crop for terminal ${pane.id}`);
      const renderFloor = await paneEventFloor(page, pane.id);
      const renderWait = waitForDiagnosticEventAfter(page, pane.id, renderFloor, "render");
      await pane.pane.sendInput(`PRINT ${printId} ${printText}`, true);
      await server.waitForTranscript(pane.id, (entry) => entry.event === "print" && entry.id === printId, { timeoutMs: WAIT_TIMEOUT_MS });
      await expectTerminalBuffer(page, pane.id, { contains: marker("PRINT", printId, printText), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
      await renderWait;
      await expectKnownMarkerChanged(page, pane.pane.xtermHost, before, {
        minimumChangedRatio: 0.002,
        testInfo,
        artifactName: `${token}-${pane.name}-initial-print`,
      });
      await expectTerminalNonBlank(page, pane.pane.xtermHost, {
        testInfo,
        artifactName: `${token}-${pane.name}-initial-nonblank`,
      });
      await waitForPaneQuiescent(page, pane.id);
    }

    const afterBrowserResize = await resizeStage(page, panes, async () => {
      await page.setViewportSize(RESIZED_VIEWPORT);
    });
    expect(afterBrowserResize).toHaveLength(maxPanes);

    const sidebarWidthBefore = await workbench.sidebar.sidebarWidth();
    const afterSidebarResize = await resizeStage(page, panes, async () => {
      await workbench.sidebar.resizeWithKeyboard("right");
    });
    const sidebarWidthAfter = await workbench.sidebar.sidebarWidth();
    expect(sidebarWidthAfter).toBeGreaterThan(sidebarWidthBefore);
    expect(afterSidebarResize).toHaveLength(maxPanes);
    await assertNonOverlappingBoxes(panes);

    const finalSizes = new Map<string, TranscriptEntry>();
    for (const pane of panes) {
      const settled = afterSidebarResize.find((snapshot) => snapshot.terminalId === pane.id);
      if (!settled) throw new Error(`missing settled resize snapshot for terminal ${pane.id}`);
      const finalWinch = await server.waitForTranscript(
        pane.id,
        (entry) => entry.event === "sigwinch"
          && entry.source === "signal"
          && entry.rows === settled.rows
          && entry.cols === settled.cols,
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      expect(transcriptNumber(finalWinch, "signal_sequence")).toBeGreaterThan(0);
      await pane.pane.focus();
      await waitForActivePane(page, panes, pane.id);
      const finalSizeId = `${token}-${pane.name}-SIZE-final`;
      const finalSize = await issueSize(page, server, pane, finalSizeId);
      expect(transcriptNumber(finalSize, "rows")).toBe(settled.rows);
      expect(transcriptNumber(finalSize, "cols")).toBe(settled.cols);
      expect(transcriptNumber(finalSize, "pixel_width")).toBe(settled.pixelWidth);
      expect(transcriptNumber(finalSize, "pixel_height")).toBe(settled.pixelHeight);
      finalSizes.set(pane.id, finalSize);
    }

    for (const pane of panes) {
      await pane.pane.focus();
      await waitForActivePane(page, panes, pane.id);
      const finalPrintId = `${token}-${pane.name}-PRINT-resized`;
      const finalPrintText = `${pane.name}-resized-visible`;
      await issuePrint(page, server, pane, finalPrintId, finalPrintText, testInfo, `${token}-${pane.name}-resized-print`);

      const echoId = `${token}-${pane.name}-ECHO`;
      const inputMarker = `${pane.name}-continued-input`;
      await issueEcho(page, server, pane, echoId, inputMarker);
      const focused = await waitForTerminalState(page, pane.id, {
        active: true,
        focused: true,
        acceptingInput: true,
      }, { timeout: WAIT_TIMEOUT_MS });
      expect(focused.active).toBe(true);
      expect(focused.focused).toBe(true);
      expect(focused.acceptingInput).toBe(true);
      await assertLatestResponder(page, pane.id);

      const queryId = `${token}-${pane.name}-QUERY`;
      await issueQuery(page, server, pane, queryId);
      await assertLatestResponder(page, pane.id);
    }

    const finalSnapshots = await Promise.all(panes.map(async (pane) => {
      const snapshot = await waitForPaneQuiescent(page, pane.id);
      await expectConnectedTerminalInvariants(page, pane.id, { timeout: WAIT_TIMEOUT_MS });
      return snapshot;
    }));
    expect(finalSnapshots).toHaveLength(maxPanes);
    for (const snapshot of finalSnapshots) {
      expect(snapshot.lifecycle.mounted).toBe(true);
      expect(snapshot.lifecycle.visible).toBe(true);
      expect(snapshot.lifecycle.cached).toBe(false);
      expect(snapshot.activeSocketCount).toBe(1);
      expect(snapshot.socket.activeCount).toBe(1);
      expect(snapshot.socketGeneration).toBeGreaterThanOrEqual(1);
      expect(snapshot.renderer).toMatch(/^(webgl|canvas|dom)$/);
      expect(snapshot.rendererState.kind).toBe(snapshot.renderer);
      expect(snapshot.renderCount).toBeGreaterThan(0);
      expect(snapshot.webglLoadCount).toBeLessThanOrEqual(1);
      expect(snapshot.contextLossCount).toBe(0);
      expect(snapshot.fallbackCount).toBeLessThanOrEqual(1);
      expect(snapshot.proposedViewport).toMatchObject({ cols: snapshot.cols, rows: snapshot.rows });
      expect(snapshot.sentViewport).toMatchObject({ cols: snapshot.cols, rows: snapshot.rows });
      expect(snapshot.serverViewport).toMatchObject({ cols: snapshot.cols, rows: snapshot.rows });
    }

    for (const pane of panes) {
      const snapshot = finalSnapshots.find((candidate) => candidate.terminalId === pane.id);
      if (!snapshot) throw new Error(`missing final snapshot for terminal ${pane.id}`);
      const text = snapshot.xterm.text;
      const initialPrintId = `${token}-${pane.name}-PRINT-initial`;
      const finalPrintId = `${token}-${pane.name}-PRINT-resized`;
      const echoId = `${token}-${pane.name}-ECHO`;
      const queryId = `${token}-${pane.name}-QUERY`;
      expect(countOccurrences(text, marker("PRINT", initialPrintId, `${pane.name}-visible`))).toBe(1);
      expect(countOccurrences(text, marker("PRINT", finalPrintId, `${pane.name}-resized-visible`))).toBe(1);
      expect(countOccurrences(text, marker("ECHO_INPUT", echoId, base64(`${pane.name}-continued-input`)))).toBe(1);
      expect(countOccurrences(text, marker("QUERY", queryId, "COMPLETE:6"))).toBe(1);
      await expectTerminalNonBlank(page, pane.pane.xtermHost, {
        testInfo,
        artifactName: `${token}-${pane.name}-final-nonblank`,
      });

      const events = await terminalEvents(page, pane.id);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "socket-stale")).toEqual([]);
      const sizeEvents = events.filter((event) => event.type === "size");
      expect(sizeEvents.at(-1)?.data.responder).toBe(true);
      expect(events.some((event) => event.type === "viewport" && event.data.source === "sent")).toBe(true);
      expect(events.some((event) => event.type === "synced")).toBe(true);
      expect(events.some((event) => event.type === "render")).toBe(true);

      const transcript = await server.readTranscript(pane.id);
      const initialSize = initialSizes.get(pane.id);
      const finalSize = finalSizes.get(pane.id);
      if (!initialSize || !finalSize) throw new Error(`missing fixture size records for terminal ${pane.id}`);
      expect(transcript.filter((entry) => entry.event === "print" && entry.id === initialPrintId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "print" && entry.id === finalPrintId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "size" && entry.id === initialSize.id)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "size" && entry.id === finalSize.id)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "query_complete" && entry.id === queryId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "query_incomplete")).toHaveLength(0);
      expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
      const signalWinches = transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal");
      const latestWinch = signalWinches.at(-1);
      if (!latestWinch) throw new Error(`terminal ${pane.id} emitted no signal WINCH transcript`);
      expect(latestWinch.rows).toBe(finalSize.rows);
      expect(latestWinch.cols).toBe(finalSize.cols);
      const signalSequences = signalWinches.map((entry) => transcriptNumber(entry, "signal_sequence"));
      expect(signalSequences.every((sequence, index) => index === 0 || sequence !== undefined && signalSequences[index - 1] !== undefined && sequence > signalSequences[index - 1]!)).toBe(true);

      for (const other of panes) {
        if (other.id === pane.id) continue;
        const otherTranscript = await server.readTranscript(other.id);
        expect(otherTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId)).toHaveLength(0);
        expect(otherTranscript.filter((entry) => entry.event === "query_complete" && entry.id === queryId)).toHaveLength(0);
      }
    }

    const proxyEvents = faultController.events.slice(networkFloor);
    expect(proxyEvents.filter((event) => [
      "malformed-frame",
      "injected",
      "paused",
      "throttled",
      "dropped",
      "socket-error",
      "connection-terminated",
      "terminated",
    ].includes(event.type))).toEqual([]);
    expect(browserErrors().filter((entry) => (
      entry.kind === "pageerror"
        || entry.kind === "requestfailed"
        || (entry.kind === "console" && /^error:/i.test(entry.message))
    ))).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  } finally {
    browserErrors.dispose();
  }
});
