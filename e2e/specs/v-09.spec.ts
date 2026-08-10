import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  expectSingleTerminalSocket,
  terminalEvents,
  assertMonotonicSequences,
  expectNoPendingRecovery,
} from "../assertions/terminal-state.js";
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
import LoginPage from "../pages/login-page.js";
import SidebarPage from "../pages/sidebar-page.js";
import TerminalPanePage from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 20_000;
const DESKTOP_VIEWPORT = { width: 1_440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type ViewportNumbers = {
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
};

type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type CreatedTerminal = {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
};

function commandBytes(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function marker(kind: string, id: string, value?: string): string {
  return value === undefined ? `[E2E:${kind}:${id}]` : `[E2E:${kind}:${id}:${value}]`;
}

function numberData(event: E2ETerminalEvent, key: keyof ViewportNumbers): number {
  const value = event.data[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`diagnostic viewport event has no positive ${key}`);
  }
  return value;
}

function viewportFromEvent(event: E2ETerminalEvent): ViewportNumbers {
  return {
    cols: numberData(event, "cols"),
    rows: numberData(event, "rows"),
    pixelWidth: numberData(event, "pixelWidth"),
    pixelHeight: numberData(event, "pixelHeight"),
  };
}

function lastEventId(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((largest, event) => Math.max(largest, event.id), -1);
}

function sentViewportEventsAfter(
  events: readonly E2ETerminalEvent[],
  afterEventId: number,
): E2ETerminalEvent[] {
  return events.filter((event) => (
    event.id > afterEventId
    && event.type === "viewport"
    && event.data.source === "sent"
  ));
}

async function waitForSentViewport(
  page: Page,
  terminalId: string,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === "viewport"
        && event.data.source === "sent"
        && ["cols", "rows", "pixelWidth", "pixelHeight"].every((key) => {
          const value = event.data[key];
          return typeof value === "number" && Number.isFinite(value) && value > 0;
        }),
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledViewport(
  page: Page,
  terminalId: string,
  expected: ViewportNumbers,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected: dimensions, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      const sent = snapshot.sentViewport;
      const server = snapshot.serverViewport;
      const matches = (viewport: typeof desired): boolean => {
        if (!viewport) return false;
        return viewport.cols === dimensions.cols
          && viewport.rows === dimensions.rows
          && viewport.pixelWidth === dimensions.pixelWidth
          && viewport.pixelHeight === dimensions.pixelHeight;
      };
      return snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.cols === dimensions.cols
        && snapshot.rows === dimensions.rows
        && matches(desired)
        && matches(sent)
        && matches(server)
        && (snapshot.syncTarget === undefined
          || snapshot.committedSequence === undefined
          || snapshot.committedSequence >= snapshot.syncTarget);
    }, { timeout });
  }, { id: terminalId, expected, timeout: WAIT_TIMEOUT_MS });
}
async function waitForCurrentViewport(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      const sent = snapshot.sentViewport;
      const server = snapshot.serverViewport;
      if (!desired || !sent || !server) return false;
      return snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.renderBacklogBytes === 0
        && desired.cols === sent.cols
        && desired.rows === sent.rows
        && desired.pixelWidth === sent.pixelWidth
        && desired.pixelHeight === sent.pixelHeight
        && sent.cols === server.cols
        && sent.rows === server.rows
        && sent.pixelWidth === server.pixelWidth
        && sent.pixelHeight === server.pixelHeight;
    }, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForResizeAction(
  page: Page,
  terminalId: string,
  afterEventId: number,
): Promise<{ readonly event: E2ETerminalEvent; readonly viewport: ViewportNumbers; readonly snapshot: E2ETerminalSnapshot }> {
  const event = await waitForSentViewport(page, terminalId, afterEventId);
  const viewport = viewportFromEvent(event);
  const snapshot = await waitForSettledViewport(page, terminalId, viewport);
  return { event, viewport, snapshot };
}

async function terminalSnapshot(
  page: Page,
  terminalId: string,
  paneId?: string,
): Promise<E2ETerminalSnapshot | undefined> {
  return page.evaluate(({ id, pane }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminal(id, pane);
  }, { id: terminalId, pane: paneId });
}


async function hostBox(pane: TerminalPanePage): Promise<Box> {
  const box = await pane.xtermHost.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error("terminal host has no measurable layout box");
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

async function nextFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function waitForCommand(
  pane: TerminalPanePage,
  server: { waitForTranscript<T extends TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean): Promise<T> },
  terminalId: string,
  command: string,
  operation: string,
): Promise<void> {
  const commandPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === operation
    && entry.command_base64 === commandBytes(command)
  ));
  await pane.sendInput(command, true);
  await commandPromise;
}

async function fixtureReady(
  pane: TerminalPanePage,
  server: { waitForTranscript<T extends TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean): Promise<T> },
  terminalId: string,
  id: string,
): Promise<void> {
  const readyPromise = server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === id);
  await waitForCommand(pane, server, terminalId, `READY ${id}`, "READY");
  await readyPromise;
  await expectTerminalBuffer(pane.page, terminalId, { contains: marker("READY", id), occurrences: 1 });
}

async function fixtureSize(
  pane: TerminalPanePage,
  server: { waitForTranscript<T extends TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean): Promise<T> },
  terminalId: string,
  id: string,
  expected: E2ETerminalSnapshot,
): Promise<void> {
  const sizePromise = server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === id);
  await waitForCommand(pane, server, terminalId, `SIZE ${id}`, "SIZE");
  const size = await sizePromise;
  const serverViewport = expected.serverViewport ?? expected.viewport;
  expect(size.rows).toBe(serverViewport.rows);
  expect(size.cols).toBe(serverViewport.cols);
}

async function fixtureQuery(
  pane: TerminalPanePage,
  server: { waitForTranscript<T extends TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean): Promise<T> },
  terminalId: string,
  id: string,
): Promise<void> {
  const completePromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "query_complete" && entry.id === id
  ));
  await waitForCommand(pane, server, terminalId, `QUERY ${id}`, "QUERY");
  const complete = await completePromise;
  expect(complete.replies).toBe(4);
}

async function fixturePrint(
  pane: TerminalPanePage,
  server: { waitForTranscript<T extends TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean): Promise<T> },
  terminalId: string,
  id: string,
  text: string,
  testInfo: TestInfo,
): Promise<void> {
  const before = await screenshotRegion(pane.page, pane.xtermHost);
  const printCommand = `PRINT ${id} ${text}`;
  const printPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "print" && entry.id === id && entry.text === text
  ));
  await waitForCommand(pane, server, terminalId, printCommand, "PRINT");
  await printPromise;
  await expectTerminalBuffer(pane.page, terminalId, { contains: marker("PRINT", id, text), occurrences: 1 });
  await expectKnownMarkerChanged(pane.page, pane.xtermHost, before, {
    minimumChangedRatio: 0.001,
    testInfo,
    artifactName: `v09-${id.toLowerCase()}-crop`,
  });
  await expectTerminalNonBlank(pane.page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.001,
    testInfo,
    artifactName: `v09-${id.toLowerCase()}-nonblank`,
  });
}

async function checkpoint(
  pane: TerminalPanePage,
  server: { waitForTranscript<T extends TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean): Promise<T> },
  terminalId: string,
  prefix: string,
  testInfo: TestInfo,
): Promise<E2ETerminalSnapshot> {
  const before = await terminalSnapshot(pane.page, terminalId);
  if (!before) throw new Error(`no diagnostics snapshot for ${terminalId}`);
  await fixtureSize(pane, server, terminalId, `${prefix}_SIZE`, before);
  await fixtureQuery(pane, server, terminalId, `${prefix}_QUERY`);
  const text = `${prefix}_VISIBLE`;
  await fixturePrint(pane, server, terminalId, `${prefix}_PRINT`, text, testInfo);
  const after = await terminalSnapshot(pane.page, terminalId);
  if (!after) throw new Error(`diagnostics snapshot disappeared for ${terminalId}`);
  await expectTerminalInteractive(pane.page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  return after;
}

async function createTerminalInCwd(page: Page, cwd: string): Promise<CreatedTerminal> {
  return page.evaluate(async (workingDirectory) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: workingDirectory }),
    });
    if (!response.ok) throw new Error(`terminal creation failed (${response.status})`);
    const terminal = await response.json() as Partial<CreatedTerminal>;
    if (typeof terminal.id !== "string" || typeof terminal.name !== "string" || typeof terminal.cwd !== "string") {
      throw new Error("terminal creation response is missing identity");
    }
    return { id: terminal.id, name: terminal.name, cwd: terminal.cwd };
  }, cwd);
}

async function assertNoResizeAfter(
  page: Page,
  pane: TerminalPanePage,
  afterEventId: number,
  before: Box,
): Promise<void> {
  await nextFrames(page);
  const events = await terminalEvents(page, pane.terminalId);
  expect(sentViewportEventsAfter(events, afterEventId)).toHaveLength(0);
  expect(await hostBox(pane)).toEqual(before);
}


test("V-09 Sidebar, status bar, artifact panel, and preview layout changes @nightly @p1 @resize @layout", async ({ page, server }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto("/");
  await new LoginPage(page).login();

  const workspaceDirectory = join(server.dataDir, "v09-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const fileName = `v09-file-${testInfo.workerIndex}-${testInfo.retry}.txt`;
  await writeFile(join(workspaceDirectory, fileName), `V-09 real workspace file ${testInfo.workerIndex}-${testInfo.retry}\n`, "utf8");
  const created = await createTerminalInCwd(page, workspaceDirectory);
  await page.reload();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const sidebar = new SidebarPage(page);
  const pane = await sidebar.openTerminal(created.name);
  await pane.expectVisible();
  await pane.expectConnected();
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });

  const prefix = `V09_${testInfo.workerIndex}_${testInfo.retry}`;
  await fixtureReady(pane, server, created.id, `${prefix}_READY`);
  await waitForCommand(pane, server, created.id, `BURST ${prefix}_BURST 1024 72`, "BURST");
  await server.waitForTranscript(created.id, (entry) => entry.event === "burst" && entry.id === `${prefix}_BURST`);
  const baselinePrint = `${prefix}_BASELINE_PRINT`;
  const baselineText = `${prefix}_BASELINE_VISIBLE`;
  const baselineBefore = await screenshotRegion(page, pane.xtermHost);
  const baselinePrintPromise = server.waitForTranscript(created.id, (entry) => entry.event === "print" && entry.id === baselinePrint);
  await waitForCommand(pane, server, created.id, `PRINT ${baselinePrint} ${baselineText}`, "PRINT");
  await baselinePrintPromise;
  await expectTerminalBuffer(page, created.id, { contains: marker("PRINT", baselinePrint, baselineText), occurrences: 1 });
  await waitForCurrentViewport(page, created.id);
  await expectKnownMarkerChanged(page, pane.xtermHost, baselineBefore, { minimumChangedRatio: 0.001, testInfo, artifactName: "v09-baseline-crop" });
  await expectTerminalNonBlank(page, pane.xtermHost, { minimumNonBackgroundRatio: 0.001, testInfo, artifactName: "v09-baseline-nonblank" });

  const initialBox = await hostBox(pane);
  const statusbar = workbench.statusbar;
  await expect(statusbar).toBeVisible();
  const desktopStatusbarBox = await statusbar.boundingBox();
  expect(desktopStatusbarBox?.height ?? 0).toBeGreaterThan(0);

  await checkpoint(pane, server, created.id, `${prefix}_START`, testInfo);

  const sidebarInitialWidth = await sidebar.sidebarWidth();
  const sidebarMinEvents = lastEventId(await terminalEvents(page, created.id));
  await sidebar.resizeWithKeyboard("min");
  await expect(sidebar.root.getByRole("separator", { name: "Resize workspace sidebar", exact: true })).not.toHaveAttribute("aria-valuenow", String(sidebarInitialWidth));
  const sidebarMinResize = await waitForResizeAction(page, created.id, sidebarMinEvents);
  const sidebarMinBox = await hostBox(pane);
  expect(sidebarMinBox.width).toBeLessThan(initialBox.width);
  expect(sidebarMinBox.height).toBe(initialBox.height);
  expect(sentViewportEventsAfter(await terminalEvents(page, created.id), sidebarMinEvents)).toHaveLength(1);
  await expectTerminalConverged(page, created.id, sidebarMinResize.viewport, { timeout: WAIT_TIMEOUT_MS });
  await fixtureSize(pane, server, created.id, `${prefix}_SIDEBAR_MIN_SIZE`, sidebarMinResize.snapshot);
  await fixtureQuery(pane, server, created.id, `${prefix}_SIDEBAR_MIN_QUERY`);
  await fixturePrint(pane, server, created.id, `${prefix}_SIDEBAR_MIN_PRINT`, `${prefix}_SIDEBAR_MIN_VISIBLE`, testInfo);

  const sidebarMaxEvents = lastEventId(await terminalEvents(page, created.id));
  await sidebar.resizeWithKeyboard("max");
  const sidebarMaxResize = await waitForResizeAction(page, created.id, sidebarMaxEvents);
  const sidebarMaxBox = await hostBox(pane);
  expect(sidebarMaxBox.width).toBeGreaterThan(sidebarMinBox.width);
  expect(sidebarMaxBox.height).toBe(sidebarMinBox.height);
  expect(sentViewportEventsAfter(await terminalEvents(page, created.id), sidebarMaxEvents)).toHaveLength(1);
  await expectTerminalConverged(page, created.id, sidebarMaxResize.viewport, { timeout: WAIT_TIMEOUT_MS });
  await fixtureSize(pane, server, created.id, `${prefix}_SIDEBAR_MAX_SIZE`, sidebarMaxResize.snapshot);
  await fixtureQuery(pane, server, created.id, `${prefix}_SIDEBAR_MAX_QUERY`);
  await fixturePrint(pane, server, created.id, `${prefix}_SIDEBAR_MAX_PRINT`, `${prefix}_SIDEBAR_MAX_VISIBLE`, testInfo);

  const statusBefore = await hostBox(pane);
  const statusEventId = lastEventId(await terminalEvents(page, created.id));
  const statusModules = page.locator(".status-module");
  const statusModuleCount = await statusModules.count();
  if (statusModuleCount > 0) {
    const statusModule = statusModules.first();
    await expect(statusModule).toBeVisible();
    await statusModule.click();
    const popover = page.locator(".status-module-popover");
    await expect(popover).toBeVisible();
    await assertNoResizeAfter(page, pane, statusEventId, statusBefore);
    await statusModule.click();
    await expect(popover).toBeHidden();
    await assertNoResizeAfter(page, pane, statusEventId, statusBefore);
  } else {
    await expect(page.locator(".statusbar-modules")).toHaveCount(0);
  }
  await checkpoint(pane, server, created.id, `${prefix}_STATUS`, testInfo);

  const artifactId = `${prefix}_ARTIFACT`;
  const artifactName = `v09-artifact-${testInfo.workerIndex}-${testInfo.retry}.md`;
  const artifactText = `V-09 artifact content ${prefix}`;
  const artifactCommand = `ARTIFACT ${artifactId} ${artifactName} ${artifactText}`;
  const artifactEventPromise = server.waitForTranscript(created.id, (entry) => (
    entry.event === "artifact"
    && entry.id === artifactId
    && entry.filename === artifactName
    && typeof entry.path === "string"
  ));
  await waitForCommand(pane, server, created.id, artifactCommand, "ARTIFACT");
  const artifactEvent = await artifactEventPromise;
  expect(artifactEvent.path).toContain(artifactName);
  await expectTerminalBuffer(page, created.id, { contains: marker("ARTIFACT", artifactId, "COMPLETE"), occurrences: 1 });
  const artifactButton = pane.root.locator(".pane-artifacts");
  await expect(artifactButton).toBeVisible();
  const artifactDrawer = pane.root.locator(".artifact-drawer");
  await expect(artifactDrawer).toBeVisible();
  await expect(artifactDrawer.getByRole("option", { name: new RegExp(artifactName) })).toBeVisible();
  await expect(artifactDrawer.getByText(artifactText, { exact: true })).toBeVisible();
  await waitForCurrentViewport(page, created.id);

  const artifactOpenBox = await hostBox(pane);
  const closeArtifactEvents = lastEventId(await terminalEvents(page, created.id));
  await artifactDrawer.getByRole("button", { name: "Close artifact sidebar", exact: true }).click();
  await expect(artifactDrawer).toBeHidden();
  const artifactClosedResize = await waitForResizeAction(page, created.id, closeArtifactEvents);
  const artifactClosedBox = await hostBox(pane);
  expect(artifactClosedBox.width).toBeGreaterThan(artifactOpenBox.width);
  expect(sentViewportEventsAfter(await terminalEvents(page, created.id), closeArtifactEvents)).toHaveLength(1);
  await expectTerminalConverged(page, created.id, artifactClosedResize.viewport, { timeout: WAIT_TIMEOUT_MS });
  await fixtureSize(pane, server, created.id, `${prefix}_ARTIFACT_CLOSED_SIZE`, artifactClosedResize.snapshot);
  await fixtureQuery(pane, server, created.id, `${prefix}_ARTIFACT_CLOSED_QUERY`);
  await fixturePrint(pane, server, created.id, `${prefix}_ARTIFACT_CLOSED_PRINT`, `${prefix}_ARTIFACT_CLOSED_VISIBLE`, testInfo);

  const openArtifactEvents = lastEventId(await terminalEvents(page, created.id));
  await pane.openArtifacts();
  await expect(artifactDrawer).toBeVisible();
  const artifactOpenResize = await waitForResizeAction(page, created.id, openArtifactEvents);
  const artifactReopenedBox = await hostBox(pane);
  expect(artifactReopenedBox.width).toBeLessThan(artifactClosedBox.width);
  expect(artifactReopenedBox.width).toBeLessThanOrEqual(artifactClosedBox.width - 300);
  expect(sentViewportEventsAfter(await terminalEvents(page, created.id), openArtifactEvents)).toHaveLength(1);
  await expectTerminalConverged(page, created.id, artifactOpenResize.viewport, { timeout: WAIT_TIMEOUT_MS });
  await fixtureSize(pane, server, created.id, `${prefix}_ARTIFACT_OPEN_SIZE`, artifactOpenResize.snapshot);
  await fixtureQuery(pane, server, created.id, `${prefix}_ARTIFACT_OPEN_QUERY`);
  await fixturePrint(pane, server, created.id, `${prefix}_ARTIFACT_OPEN_PRINT`, `${prefix}_ARTIFACT_OPEN_VISIBLE`, testInfo);

  const previewSourceBefore = await pane.snapshot();
  if (!previewSourceBefore) throw new Error("missing source snapshot before preview");
  const previewHostBefore = await hostBox(pane);
  const previewEventsBefore = lastEventId(await terminalEvents(page, created.id));
  const transcriptBeforePreview = await server.readTranscript(created.id);
  const preview = await sidebar.openPreview(created.name);
  await expect(preview.locator(".terminal-preview-status.connected")).toBeVisible();
  const previewSnapshot = await terminalSnapshot(page, created.id, `preview-${created.id}`);
  if (!previewSnapshot) throw new Error("preview diagnostics did not mount");
  expect(previewSnapshot.kind).toBe("preview");
  expect(previewSnapshot.urlViewport).toBeUndefined();
  expect(previewSnapshot.sentViewport).toBeUndefined();
  await expectTerminalNonBlank(page, preview.locator(".terminal-preview-xterm"), { minimumNonBackgroundRatio: 0.001, testInfo, artifactName: "v09-preview-nonblank" });
  await expectTerminalBuffer(page, created.id, { contains: marker("PRINT", `${prefix}_ARTIFACT_OPEN_PRINT`, `${prefix}_ARTIFACT_OPEN_VISIBLE`), occurrences: 1 });
  expect(await hostBox(pane)).toEqual(previewHostBefore);
  const sourceAfterPreview = await pane.snapshot();
  if (!sourceAfterPreview) throw new Error("source diagnostics disappeared while preview was open");
  expect(sourceAfterPreview.cols).toBe(previewSourceBefore.cols);
  expect(sourceAfterPreview.rows).toBe(previewSourceBefore.rows);
  expect(sourceAfterPreview.sentViewport).toEqual(previewSourceBefore.sentViewport);
  expect(sourceAfterPreview.serverViewport).toEqual(previewSourceBefore.serverViewport);
  expect(sentViewportEventsAfter(await terminalEvents(page, created.id), previewEventsBefore)).toHaveLength(0);
  await sidebar.closePreview();
  await expect(preview).toBeHidden();
  await nextFrames(page);
  expect(await terminalSnapshot(page, created.id, `preview-${created.id}`)).toBeUndefined();
  expect(await server.readTranscript(created.id)).toEqual(transcriptBeforePreview);
  await checkpoint(pane, server, created.id, `${prefix}_PREVIEW`, testInfo);

  const explorerBefore = await hostBox(pane);
  const explorerEvents = lastEventId(await terminalEvents(page, created.id));
  await sidebar.openFileExplorer();
  const explorer = page.locator(".file-explorer");
  await expect(explorer).toBeVisible();
  await expect(explorer.locator("button.file-result").filter({ hasText: fileName })).toBeVisible();
  await sidebar.showTerminalWorkspaces();
  await expect(explorer).toBeHidden();
  await assertNoResizeAfter(page, pane, explorerEvents, explorerBefore);
  await sidebar.openFileExplorer();
  await expect(explorer).toBeVisible();
  const desktopFileResult = explorer.locator("button.file-result").filter({ hasText: fileName });
  await expect(desktopFileResult).toBeVisible();
  const desktopFileHostBefore = await hostBox(pane);
  const desktopFileEvents = lastEventId(await terminalEvents(page, created.id));
  await desktopFileResult.click();
  const resourceArea = workbench.workspaceArea;
  const editorGrid = workbench.editorGrid;
  const resourceTabbar = page.locator(".resource-tabbar");
  await expect(resourceArea).toHaveClass(/with-resource-tabs/);
  await expect(editorGrid).toHaveClass(/resource-hidden/);
  await expect(resourceTabbar).toBeVisible();
  const desktopTabbarBox = await resourceTabbar.boundingBox();
  expect(Math.round(desktopTabbarBox?.height ?? 0)).toBe(32);
  const desktopFileResize = await waitForResizeAction(page, created.id, desktopFileEvents);
  const desktopFileHost = await hostBox(pane);
  expect(desktopFileHost.height).toBeLessThan(desktopFileHostBefore.height);
  expect(sentViewportEventsAfter(await terminalEvents(page, created.id), desktopFileEvents)).toHaveLength(1);
  await expectTerminalConverged(page, created.id, desktopFileResize.viewport, { timeout: WAIT_TIMEOUT_MS });

  const desktopTerminalTabEvents = lastEventId(await terminalEvents(page, created.id));
  await resourceTabbar.getByRole("button", { name: "Terminals", exact: true }).click();
  await expect(editorGrid).not.toHaveClass(/resource-hidden/);
  await expect(pane.xtermHost).toBeVisible();
  await assertNoResizeAfter(page, pane, desktopTerminalTabEvents, desktopFileHost);

  const desktopCloseTabEvents = lastEventId(await terminalEvents(page, created.id));
  await resourceTabbar.getByRole("button", { name: `Close ${fileName}`, exact: true }).click();
  await expect(resourceTabbar).toBeHidden();
  const desktopCloseTabResize = await waitForResizeAction(page, created.id, desktopCloseTabEvents);
  const desktopRestoredHost = await hostBox(pane);
  expect(desktopRestoredHost).toEqual(explorerBefore);
  expect(desktopRestoredHost.height).toBeGreaterThan(desktopFileHost.height);
  expect(sentViewportEventsAfter(await terminalEvents(page, created.id), desktopCloseTabEvents)).toHaveLength(1);
  await expectTerminalConverged(page, created.id, desktopCloseTabResize.viewport, { timeout: WAIT_TIMEOUT_MS });
  await checkpoint(pane, server, created.id, `${prefix}_FILE_DESKTOP`, testInfo);
  const mobileViewportEvents = lastEventId(await terminalEvents(page, created.id));
  await page.setViewportSize(MOBILE_VIEWPORT);
  await waitForResizeAction(page, created.id, mobileViewportEvents);
  const mobileStatusbarBox = await statusbar.boundingBox();
  if (mobileStatusbarBox) expect(mobileStatusbarBox.height).toBeGreaterThan(0);
  else await expect(statusbar).toBeHidden();

  await workbench.openMobileSidebar();
  const mobileSidebar = page.getByRole("dialog", { name: "Workspaces and files", exact: true });
  await expect(mobileSidebar).toBeVisible();
  await mobileSidebar.getByRole("button", { name: "Open file explorer", exact: true }).click();
  const mobileExplorer = mobileSidebar.locator(".file-explorer");
  await expect(mobileExplorer).toBeVisible();
  const mobileFileResult = mobileExplorer.locator("button.file-result").filter({ hasText: fileName });
  await expect(mobileFileResult).toBeVisible();
  const mobileFileHostBefore = await hostBox(pane);
  const mobileFileEvents = lastEventId(await terminalEvents(page, created.id));
  await mobileFileResult.click();
  await expect(resourceArea).toHaveClass(/with-resource-tabs/);
  await expect(editorGrid).toHaveClass(/resource-hidden/);
  await expect(resourceTabbar).toBeVisible();
  const mobileTabbarBox = await resourceTabbar.boundingBox();
  expect(Math.round(mobileTabbarBox?.height ?? 0)).toBe(44);
  const mobileFileResize = await waitForResizeAction(page, created.id, mobileFileEvents);
  const mobileFileHost = await hostBox(pane);
  expect(mobileFileHost.height).toBeLessThan(mobileFileHostBefore.height);
  expect(sentViewportEventsAfter(await terminalEvents(page, created.id), mobileFileEvents)).toHaveLength(1);
  await expectTerminalConverged(page, created.id, mobileFileResize.viewport, { timeout: WAIT_TIMEOUT_MS });

  const mobileTerminalTabEvents = lastEventId(await terminalEvents(page, created.id));
  await resourceTabbar.getByRole("button", { name: "Terminals", exact: true }).click();
  await expect(editorGrid).not.toHaveClass(/resource-hidden/);
  await expect(pane.xtermHost).toBeVisible();
  await assertNoResizeAfter(page, pane, mobileTerminalTabEvents, mobileFileHost);

  const mobileCloseTabEvents = lastEventId(await terminalEvents(page, created.id));
  await resourceTabbar.getByRole("button", { name: `Close ${fileName}`, exact: true }).click();
  await expect(resourceTabbar).toBeHidden();
  const mobileCloseTabResize = await waitForResizeAction(page, created.id, mobileCloseTabEvents);
  const mobileRestoredHost = await hostBox(pane);
  expect(mobileRestoredHost).toEqual(mobileFileHostBefore);
  expect(mobileRestoredHost.height).toBeGreaterThan(mobileFileHost.height);
  expect(sentViewportEventsAfter(await terminalEvents(page, created.id), mobileCloseTabEvents)).toHaveLength(1);
  await expectTerminalConverged(page, created.id, mobileCloseTabResize.viewport, { timeout: WAIT_TIMEOUT_MS });
  const desktopRestoreEvents = lastEventId(await terminalEvents(page, created.id));
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await waitForResizeAction(page, created.id, desktopRestoreEvents);
  await pane.expectVisible();
  await checkpoint(pane, server, created.id, `${prefix}_FINAL`, testInfo);
  await expectTerminalNonBlank(page, pane.xtermHost, { minimumNonBackgroundRatio: 0.001, testInfo, artifactName: "v09-final-nonblank" });
  const continuedInput = `${prefix}_CONTINUED_PAYLOAD`;
  const finalBeforeEcho = await screenshotRegion(page, pane.xtermHost);
  const echoCommand = `ECHO_INPUT ${prefix}_CONTINUED`;
  const echoArmed = server.waitForTranscript(created.id, (entry) => entry.event === "echo_input" && entry.id === `${prefix}_CONTINUED` && entry.phase === "armed");
  await waitForCommand(pane, server, created.id, echoCommand, "ECHO_INPUT");
  await echoArmed;
  const echoComplete = server.waitForTranscript(created.id, (entry) => entry.event === "echo_input" && entry.id === `${prefix}_CONTINUED` && entry.phase === "payload");
  await pane.sendInput(continuedInput, true);
  const echo = await echoComplete;
  expect(echo.text).toBeUndefined();
  expect(echo.bytes).toBe(Buffer.byteLength(continuedInput));
  expect(echo.payload_base64).toBe(Buffer.from(continuedInput).toString("base64"));
  await expectTerminalBuffer(page, created.id, {
    contains: marker("ECHO_INPUT", `${prefix}_CONTINUED`, Buffer.from(continuedInput).toString("base64")),
    occurrences: 1,
  });

  await expectConnectedTerminalInvariants(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  await assertMonotonicSequences(await terminalEvents(page, created.id));
  const transcript = await server.readTranscript(created.id);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  const afterEcho = await expectKnownMarkerChanged(page, pane.xtermHost, finalBeforeEcho, {
    minimumChangedRatio: 0.001,
    testInfo,
    artifactName: "v09-continued-input-crop",
  });
  expect(afterEcho.changedRatio).toBeGreaterThanOrEqual(0.001);
  expect(browserErrors(), "unexpected browser errors").toEqual([]);
});
