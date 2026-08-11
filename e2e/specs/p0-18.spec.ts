import { test, expect } from "../fixtures/test.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  expectConnectedTerminalInvariants,
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
} from "../assertions/invariants.js";
import {
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
  waitForTerminalBuffer,
} from "../assertions/terminal-state.js";
import type { BrowserContext, Page } from "@playwright/test";
import type { E2ETerminalDiagnosticsApi, E2ETerminalSnapshot } from "../../src/client/lib/e2e-diagnostics.js";
import type { IsolatedServer, TranscriptEntry } from "../fixtures/test.js";
import type { NetworkFaultController } from "../fixtures/network-faults.js";

const WAIT_TIMEOUT_MS = 15_000;
const TARGET_NAME = "p018-election-target";
const READY_MARKER = "P018_READY";
const FINAL_MARKER = "P018_FINAL";
const FINAL_TEXT = "P018_MULTI_CLIENT";
const INPUT_MARKER = "P018_INPUT";
const INPUT_PAYLOAD = "P018_PAYLOAD";
const QUERY_REPLY_NAMES = [
  "cursor",
  "mode",
  "identity",
  "window_size",
  "window_pixels",
  "cell_pixels",
] as const;
type Size = Readonly<{
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}>;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};
function viewportSize(snapshot: E2ETerminalSnapshot | undefined, label: string): Size {
  const viewport = snapshot?.desiredViewport;
  if (!viewport) throw new Error(`missing desired viewport for ${label}`);
  return {
    cols: viewport.cols,
    rows: viewport.rows,
    pixelWidth: viewport.pixelWidth,
    pixelHeight: viewport.pixelHeight,
  };
}
function minimumSize(left: Size, right: Size): Size {
  return {
    cols: Math.min(left.cols, right.cols),
    rows: Math.min(left.rows, right.rows),
    pixelWidth: Math.min(left.pixelWidth, right.pixelWidth),
    pixelHeight: Math.min(left.pixelHeight, right.pixelHeight),
  };
}

async function waitForViewport(
  page: Page,
  terminalId: string,
  expected: Size,
  minimumEpoch = 0,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected, minimumEpoch, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => (
        snapshot.socketState === "connected"
        && snapshot.serverViewport?.cols === expected.cols
        && snapshot.serverViewport?.rows === expected.rows
        && (snapshot.gridEpoch ?? -1) >= minimumEpoch
      ),
      { timeout },
    );
  }, { id: terminalId, expected, minimumEpoch, timeout: WAIT_TIMEOUT_MS });
}

async function waitForLifecycle(
  page: Page,
  terminalId: string,
  visible: boolean,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, visible, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.lifecycle.visible === visible && snapshot.lifecycle.cached === !visible,
      { timeout },
    );
  }, { id: terminalId, visible, timeout: WAIT_TIMEOUT_MS });
}

async function waitForReconnected(
  page: Page,
  terminalId: string,
  previousGeneration: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previousGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => (
        snapshot.socketState === "connected"
        && snapshot.socketGeneration > previousGeneration
        && snapshot.activeSocketCount === 1
      ),
      { timeout },
    );
  }, { id: terminalId, previousGeneration, timeout: WAIT_TIMEOUT_MS });
}

async function waitForPreviewSocket(page: Page, terminalId: string): Promise<E2ETerminalSnapshot | undefined> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const paneId = `preview-${id}`;
    await api.waitForEvent(
      (event) => event.paneId === paneId && event.type === "socket-open",
      { timeout },
    );
    return api.terminal(id, paneId);
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForPreviewUnmount(page: Page, terminalId: string): Promise<void> {
  await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const paneId = `preview-${id}`;
    await api.waitForEvent(
      (event) => event.paneId === paneId && event.type === "unmount",
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function assertBothViewports(
  pageA: Page,
  pageB: Page,
  terminalId: string,
  expected: Size,
  previousEpoch: number,
): Promise<{ readonly a: E2ETerminalSnapshot; readonly b: E2ETerminalSnapshot; readonly epoch: number }> {
  const [a, b] = await Promise.all([
    waitForViewport(pageA, terminalId, expected, previousEpoch),
    waitForViewport(pageB, terminalId, expected, previousEpoch),
  ]);
  expect(a.gridEpoch).toBeDefined();
  expect(a.gridEpoch).toBe(b.gridEpoch);
  expect(a.serverViewport?.cols).toBe(expected.cols);
  expect(a.serverViewport?.rows).toBe(expected.rows);
  expect(b.serverViewport?.cols).toBe(expected.cols);
  expect(b.serverViewport?.rows).toBe(expected.rows);
  expect(a.lifecycle.mounted).toBe(true);
  expect(b.lifecycle.mounted).toBe(true);
  expect(a.activeSocketCount).toBe(1);
  expect(b.activeSocketCount).toBe(1);
  const epoch = a.gridEpoch!;
  expect(epoch).toBeGreaterThanOrEqual(previousEpoch);
  return { a, b, epoch };
}

async function transcriptEntry(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: TranscriptEntry) => boolean,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(terminalId, predicate, { timeoutMs: WAIT_TIMEOUT_MS });
}

async function assertPtySize(
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  expected: Size,
  marker: string,
): Promise<void> {
  await pane.sendInput(`SIZE ${marker}`, true);
  const entry = await transcriptEntry(server, terminalId, (candidate) => (
    candidate.event === "size" && candidate.id === marker
  ));
  expect(entry.cols).toBe(expected.cols);
  expect(entry.rows).toBe(expected.rows);
  expect(entry.pixel_width).toBe(expected.pixelWidth);
  expect(entry.pixel_height).toBe(expected.pixelHeight);
  await waitForTerminalBuffer(pane.page, terminalId, {
    contains: `[E2E:SIZE:${marker}:${expected.rows}:${expected.cols}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
}

async function assertQueryResponses(
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  expected: Size,
  marker: string,
): Promise<void> {
  const before = await pane.snapshot();
  if (!before) throw new Error(`missing diagnostics before query ${marker}`);
  await pane.sendInput(`QUERY ${marker}`, true);
  const complete = await transcriptEntry(server, terminalId, (candidate) => (
    candidate.event === "query_complete"
      && candidate.id === marker
      && candidate.replies === QUERY_REPLY_NAMES.length
  ));
  expect(complete.replies).toBe(QUERY_REPLY_NAMES.length);
  const entries = await server.readTranscript(terminalId);
  const replies = entries.filter((candidate) => candidate.event === "query_reply" && candidate.id === marker);
  expect(replies).toHaveLength(QUERY_REPLY_NAMES.length);
  expect(replies.map((entry) => entry.name)).toEqual([...QUERY_REPLY_NAMES]);
  expect(replies.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5]);
  const expectedPayloads = [
    `\x1b[${before.cursorY + 1};${before.cursorX + 1}R`,
    "\x1b[?25;1$y",
    "\x1b[?1;2c",
    `\x1b[8;${expected.rows};${expected.cols}t`,
    `\x1b[4;${expected.pixelHeight};${expected.pixelWidth}t`,
    `\x1b[6;${Math.floor(expected.pixelHeight / expected.rows)};${Math.floor(expected.pixelWidth / expected.cols)}t`,
  ];
  expect(replies.map((entry) => {
    if (typeof entry.raw_base64 !== "string") throw new Error(`query reply ${marker} omitted raw payload`);
    return Buffer.from(entry.raw_base64, "base64").toString("utf8");
  })).toEqual(expectedPayloads);
}

async function assertSizeRole(
  pane: TerminalPanePage,
  role: "controller" | "focused" | "smallest",
): Promise<void> {
  const sizeButton = pane.root.locator(".desktop-pane-actions").getByRole("button").first();
  const expectedLabel = role === "controller"
    ? "Return to the smallest connected terminal size"
    : role === "focused"
      ? "Use this device's size instead"
      : "Focus this terminal at this device's size";
  await expect(sizeButton).toHaveAttribute("aria-label", expectedLabel);
  await expect(sizeButton).toHaveAttribute("aria-pressed", String(role === "controller"));
}

async function cacheTarget(workbench: WorkbenchPage, terminalId: string): Promise<void> {
  await workbench.createTerminal();
  await workbench.expectCached(terminalId);
}

function latestProxyGeneration(
  faultController: NetworkFaultController,
  terminalId: string,
  jsonType: string,
): number {
  const event = [...faultController.events].reverse().find((candidate) => (
    candidate.type === "frame"
    && candidate.terminalId === terminalId
    && candidate.direction === "browser-to-server"
    && candidate.frame?.jsonType === jsonType
  ));
  if (typeof event?.generation !== "number") {
    throw new Error(`missing proxy generation for ${jsonType} frame from terminal ${terminalId}`);
  }
  return event.generation;
}

async function disconnectGeneration(
  page: Page,
  pane: TerminalPanePage,
  terminalId: string,
  proxyGeneration: number,
  expected: Size,
  pageA: Page,
  pageB: Page,
  previousEpoch: number,
  faultController: NetworkFaultController,
): Promise<{ readonly a: E2ETerminalSnapshot; readonly b: E2ETerminalSnapshot; readonly epoch: number }> {
  const before = await pane.snapshot();
  if (!before) throw new Error(`missing diagnostics before disconnect for ${terminalId}`);
  const fault = faultController.terminate({ terminalId, generation: proxyGeneration });
  try {
    await faultController.waitFor(
      (event) => event.type === "connection-terminated" && event.terminalId === terminalId && event.generation === proxyGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const reconnected = await waitForReconnected(page, terminalId, before.socketGeneration);
    expect(reconnected.socketGeneration).toBeGreaterThan(before.socketGeneration);
    return await assertBothViewports(pageA, pageB, terminalId, expected, previousEpoch);
  } finally {
    fault.dispose();
  }
}

test("P0-18 Multi-client viewport election @p0 @smoke", async ({
  page,
  browser,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  await page.setViewportSize({ width: 1_400, height: 800 });
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbenchA = new WorkbenchPage(page);
  await workbenchA.expectVisible();

  const mounted = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent("mount", { timeout });
  }, WAIT_TIMEOUT_MS);
  await workbenchA.createTerminal();
  const mountedEvent = await mounted;
  const terminalId = mountedEvent.terminalId;
  const paneA = new TerminalPanePage(page, terminalId);
  await paneA.expectVisible();
  await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await paneA.sendInput(`READY ${READY_MARKER}`, true);
  await transcriptEntry(server, terminalId, (entry) => entry.event === "ready" && entry.id === READY_MARKER);

  const generatedName = (await paneA.root.getAttribute("aria-label"))?.replace(/^Terminal\s+/, "");
  if (!generatedName) throw new Error("terminal did not expose an accessible name");
  await workbenchA.sidebar.renameTerminal(generatedName, TARGET_NAME);
  await expect(paneA.root).toHaveAttribute("aria-label", `Terminal ${TARGET_NAME}`);

  const resizeFrames: unknown[] = [];
  const releaseFrames: unknown[] = [];
  const frameListener = faultController.on((event) => {
    if (event.terminalId !== terminalId || event.type !== "frame" || event.direction !== "browser-to-server") return;
    if (event.frame?.jsonType === "resize") resizeFrames.push(event);
    if (event.frame?.jsonType === "release") releaseFrames.push(event);
  });

  let contextB: BrowserContext | undefined;
  try {
    contextB = await browser.newContext({ viewport: { width: 900, height: 640 } });
    const pageB = await contextB.newPage();
    await pageB.goto(baseURL);
    await new LoginPage(pageB).login();
    const workbenchB = new WorkbenchPage(pageB);
    await workbenchB.expectVisible();
    const paneB = await workbenchB.openTerminal({ id: terminalId, name: TARGET_NAME });
    await paneB.expectVisible();
    await expectTerminalSynchronized(pageB, terminalId, { timeout: WAIT_TIMEOUT_MS });

    const initialA = await paneA.snapshot();
    const initialB = await paneB.snapshot();
    const sizeA = viewportSize(initialA, "client A");
    const sizeB = viewportSize(initialB, "client B");
    expect(sizeA.cols !== sizeB.cols || sizeA.rows !== sizeB.rows).toBe(true);
    const smallest = minimumSize(sizeA, sizeB);
    let epoch = -1;

    let stage = await assertBothViewports(page, pageB, terminalId, smallest, epoch);
    epoch = stage.epoch;
    await assertSizeRole(paneA, "smallest");
    await assertSizeRole(paneB, "smallest");
    await assertPtySize(server, paneB, terminalId, smallest, "P018_SIZE_MIN_INITIAL");
    await assertQueryResponses(server, paneB, terminalId, smallest, "P018_QUERY_B");

    await paneA.focusSize();
    stage = await assertBothViewports(page, pageB, terminalId, sizeA, epoch);
    epoch = stage.epoch;
    await assertSizeRole(paneA, "controller");
    await assertSizeRole(paneB, "focused");
    const pageAProxyGeneration = latestProxyGeneration(faultController, terminalId, "focus");
    await assertPtySize(server, paneA, terminalId, sizeA, "P018_SIZE_FOCUS_A");

    await paneB.focusSize();
    stage = await assertBothViewports(page, pageB, terminalId, sizeB, epoch);
    epoch = stage.epoch;
    await assertSizeRole(paneA, "focused");
    await assertSizeRole(paneB, "controller");
    await assertPtySize(server, paneB, terminalId, sizeB, "P018_SIZE_FOCUS_B");
    const pageBProxyGeneration = latestProxyGeneration(faultController, terminalId, "focus");

    await paneB.focusSize();
    stage = await assertBothViewports(page, pageB, terminalId, smallest, epoch);
    epoch = stage.epoch;
    await assertSizeRole(paneA, "smallest");
    await assertSizeRole(paneB, "smallest");
    await assertPtySize(server, paneB, terminalId, smallest, "P018_SIZE_NO_FOCUS");

    const previewOpen = waitForPreviewSocket(pageB, terminalId);
    await workbenchB.sidebar.openPreview(TARGET_NAME);
    const preview = await previewOpen;
    expect(preview?.kind).toBe("preview");
    expect(preview?.socketState).toBe("open");
    stage = await assertBothViewports(page, pageB, terminalId, smallest, epoch);
    epoch = stage.epoch;
    const previewUnmount = waitForPreviewUnmount(pageB, terminalId);
    await workbenchB.sidebar.closePreview();
    await previewUnmount;

    await cacheTarget(workbenchA, terminalId);
    await waitForLifecycle(page, terminalId, false);
    await faultController.waitFor(
      (event) => event.type === "frame"
        && event.terminalId === terminalId
        && event.generation === pageAProxyGeneration
        && event.direction === "browser-to-server"
        && event.frame?.jsonType === "release",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await paneB.expectVisible();
    stage = await assertBothViewports(page, pageB, terminalId, sizeB, epoch);
    epoch = stage.epoch;
    await assertPtySize(server, paneB, terminalId, sizeB, "P018_SIZE_CACHE_A");

    await workbenchA.sidebar.openTerminal(TARGET_NAME);
    await paneA.expectVisible();
    await waitForLifecycle(page, terminalId, true);
    stage = await assertBothViewports(page, pageB, terminalId, sizeB, epoch);
    epoch = stage.epoch;

    await cacheTarget(workbenchB, terminalId);
    await waitForLifecycle(pageB, terminalId, false);
    await faultController.waitFor(
      (event) => event.type === "frame"
        && event.terminalId === terminalId
        && event.generation === pageBProxyGeneration
        && event.direction === "browser-to-server"
        && event.frame?.jsonType === "release",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await paneA.expectVisible();
    stage = await assertBothViewports(page, pageB, terminalId, sizeA, epoch);
    epoch = stage.epoch;
    await assertPtySize(server, paneA, terminalId, sizeA, "P018_SIZE_CACHE_B");
    await assertQueryResponses(server, paneA, terminalId, sizeA, "P018_QUERY_A_RELEASE");

    await workbenchB.sidebar.openTerminal(TARGET_NAME);
    await paneB.expectVisible();
    await waitForLifecycle(pageB, terminalId, true);
    stage = await assertBothViewports(page, pageB, terminalId, smallest, epoch);
    epoch = stage.epoch;

    stage = await disconnectGeneration(
      page,
      paneA,
      terminalId,
      pageAProxyGeneration,
      smallest,
      page,
      pageB,
      epoch,
      faultController,
    );
    epoch = stage.epoch;
    expect((await paneA.snapshot())?.socketGeneration).toBe(2);
    await assertPtySize(server, paneA, terminalId, smallest, "P018_SIZE_RECONNECT_A");

    stage = await disconnectGeneration(
      pageB,
      paneB,
      terminalId,
      pageBProxyGeneration,
      smallest,
      page,
      pageB,
      epoch,
      faultController,
    );
    epoch = stage.epoch;
    expect((await paneB.snapshot())?.socketGeneration).toBe(2);
    await assertPtySize(server, paneB, terminalId, smallest, "P018_SIZE_RECONNECT_B");

    const beforeA = await screenshotRegion(page, paneA.xtermHost);
    const beforeB = await screenshotRegion(pageB, paneB.xtermHost);
    await paneA.sendInput(`PRINT ${FINAL_MARKER} ${FINAL_TEXT}`, true);
    await transcriptEntry(server, terminalId, (entry) => entry.event === "print" && entry.id === FINAL_MARKER);
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:PRINT:${FINAL_MARKER}:${FINAL_TEXT}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(pageB, terminalId, {
      contains: `[E2E:PRINT:${FINAL_MARKER}:${FINAL_TEXT}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    await expectKnownMarkerChanged(page, paneA.xtermHost, beforeA, {
      minimumChangedRatio: 0.001,
      testInfo,
      artifactName: "p018-client-a-final-marker.png",
    });
    await expectKnownMarkerChanged(pageB, paneB.xtermHost, beforeB, {
      minimumChangedRatio: 0.001,
      testInfo,
      artifactName: "p018-client-b-final-marker.png",
    });

    await paneA.sendInput(`ECHO_INPUT ${INPUT_MARKER}`, true);
    await transcriptEntry(server, terminalId, (entry) => (
      entry.event === "echo_input" && entry.id === INPUT_MARKER && entry.phase === "armed"
    ));
    await paneA.sendInput(INPUT_PAYLOAD, true);
    await transcriptEntry(server, terminalId, (entry) => (
      entry.event === "echo_input" && entry.id === INPUT_MARKER && entry.phase === "payload"
    ));

    const [finalA, finalB] = await Promise.all([
      expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS }),
      expectConnectedTerminalInvariants(pageB, terminalId, { timeout: WAIT_TIMEOUT_MS }),
    ]);
    assertNoPendingSynchronization(finalA.snapshot);
    assertNoPendingSynchronization(finalB.snapshot);
    assertNoUnexpectedSocketMultiplication([finalA.snapshot, finalB.snapshot]);
    await expectTerminalNonBlank(page, paneA.xtermHost, {
      testInfo,
      artifactName: "p018-client-a-final.png",
      minimumNonBackgroundRatio: 0.002,
    });
    await expectTerminalNonBlank(pageB, paneB.xtermHost, {
      testInfo,
      artifactName: "p018-client-b-final.png",
      minimumNonBackgroundRatio: 0.002,
    });

    expect(releaseFrames).toHaveLength(2);
    expect(resizeFrames.length).toBeLessThanOrEqual(32);
    expect((await terminalEvents(page, terminalId)).filter((event) => event.type === "socket-created")).toHaveLength(2);
    expect((await terminalEvents(pageB, terminalId)).filter((event) => event.type === "socket-created")).toHaveLength(2);

    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === FINAL_MARKER)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === INPUT_MARKER && entry.phase === "payload")).toHaveLength(1);
  } finally {
    frameListener.dispose();
    await contextB?.close();
  }
});
